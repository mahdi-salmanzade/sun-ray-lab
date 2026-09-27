import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SITE, SUN_ANGULAR_DIAMETER, SUN_ANGULAR_RADIUS, isUsDst, solarPosition } from "./solar.js";
import {
  LETTER,
  SCREENS,
  SCREEN_HEIGHT_U,
  blur,
  fresnelNumber,
  louvreCutoffDeg,
  mm,
  screenReport,
  verdictFor,
} from "./optics.js";
import { ProgressiveAccumulator } from "./accumulator.js";
import { buildCasterBVHs, createTraceUniforms, createTracedMaterial } from "./tracer.js";
import { WordFinder, sunVector } from "./words.js";
import { projectToGround, followShadowCenter, resolveReceiver } from "./shadow-geometry.js";
import { verifyShadow } from "./verify-shadow.js";
import "./styles.css";

/**
 * Kryptos Sun-Ray Lab
 * -------------------
 * Does sunlight through the cut copper letters form a readable pattern on the
 * ground? Rebuilt 2026-09-27 on exact GPU ray tracing (tracer.js):
 *
 *  - every pixel casts a real ray at the sun against a BVH of the actual
 *    triangles: no shadow map, no bias, no frustum fitting, no light leaks;
 *  - the sun is a 0.53 deg disc, sampled progressively -> exact penumbra;
 *  - diffuse sky light is occlusion-traced too, so umbra contrast is honest;
 *  - the whole scene casts (tree, rocks, platform); "isolate" drops tree and
 *    rocks as casters without touching the screen.
 *
 * Compass convention (fixed 2026-09-27): north = -Z, east = +X, up = +Y. This
 * is the glTF image of Blender's +Y north / +X east, so the lab and
 * tools/ground_truth_cycles.py agree. Earlier builds used north = +Z, which
 * mirrored the sun's path (it ran counter-clockwise seen from above).
 */

const $ = (sel) => document.querySelector(sel);

// Shown in the header so a stale browser tab is obvious at a glance.
const BUILD = "1.0.0 · open source";
const ASSET_BASE = import.meta.env.BASE_URL;
const asset = (name) => `${ASSET_BASE}${name}`;
const localAssets = await fetch(asset("local-assets.json")).then(r => r.ok ? r.json() : {}).catch(() => ({}));
const availableScreens = new Set(["demo", ...(localAssets.screens ?? [])]);
$("#build-stamp").textContent = `· build ${BUILD}`;
console.info(`[sun-ray-lab] build ${BUILD}`);
const viewport = $("#viewport");
const loading = $("#loading");
const loadingPercent = $("#loading-percent");

const MAX_SAMPLES_TRUE_SUN = 256;
const MAX_SAMPLES_POINT_SUN = 64; // still accumulates: anti-aliasing
// The sky pass has an edge-aware denoiser, so 32 sky samples match 128+ to
// within 0.3/255 (renderer audit, 2026-09-27) and converge ~20% sooner.
const MAX_SAMPLES_SKY = 32;
// Sun samples 1..SHARED_SUN_FRAMES use one disc direction for every pixel (a
// clean hard shadow first), later ones per-pixel rotated (no stepped penumbra).
const SHARED_SUN_FRAMES = 32;
const MAX_SAMPLES_ALBEDO = 32;
// Traced meshes live on layer 0. Guides and the sky dome live on LAYER_GUIDES
// and are drawn only into the direct channel (see accumulator.js).
const LAYER_GUIDES = 1;
const PROBE_MAX_DIST = 5000;

const state = {
  azimuth: 218,
  elevation: 33,
  yaw: 0,
  view: "perspective", // perspective | top | readable
  trueSun: true,
  screen: availableScreens.has("rebuilt") ? "rebuilt" : "demo",
  skyFill: 0.15,
  bounce: true, // light reflected up from the courtyard
  isolate: true,
  window: 80, // ortho view width in model units
  center: null, // ortho view centre {x, z}; null = auto-frame
  orthoUp: { x: 0, z: -1 }, // ortho screen-up direction on the ground (north)
  flip: false, // mirror the ortho view (reading aid for mirror-image light)
  sunMode: "manual",
  followShadow: true,
  date: "2025-06-21",
  time: "14:15",
  latitude: SITE.latitude,
  longitude: SITE.longitude,
  dst: true,
};

// ---------------------------------------------------------------------------
// Direction conventions
// ---------------------------------------------------------------------------

/** Unit vector toward the sun. Azimuth clockwise from north (-Z) via east (+X). */
function sunDirection(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  );
}

/** Horizontal unit vector for a compass bearing. */
function bearingVector(bearingDeg) {
  const a = THREE.MathUtils.degToRad(bearingDeg);
  return new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
}

function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Light: direct beam + diffuse sky, in linear irradiance units
// ---------------------------------------------------------------------------

/**
 * Direct normal irradiance after atmospheric extinction (Kasten-Young air
 * mass, wavelength-dependent optical depth so a low sun reddens), and the
 * diffuse sky sized so it is `skyFill` of global horizontal irradiance.
 * Scaled by pi so a white Lambert surface facing a zenith sun has radiance ~1.
 */
function solarLight(elevationDeg, skyFill, bounce = true) {
  const el = Math.max(elevationDeg, 0);
  const zen = 90 - el;
  const am =
    el <= 0 ? 40 : 1 / (Math.cos(THREE.MathUtils.degToRad(zen)) + 0.50572 * (96.07995 - zen) ** -1.6364);
  const tau = [0.1, 0.14, 0.24];
  const dni = new THREE.Color(
    Math.exp(-tau[0] * am),
    Math.exp(-tau[1] * am),
    Math.exp(-tau[2] * am),
  ).multiplyScalar(Math.PI / Math.exp(-tau[1]));
  if (el <= 0) dni.setRGB(0, 0, 0);
  const sinEl = Math.sin(THREE.MathUtils.degToRad(el));
  const directHorizontal = ((dni.r + dni.g + dni.b) / 3) * sinEl;
  const f = THREE.MathUtils.clamp(skyFill, 0, 0.95);
  const skyMag = el <= 0 ? 0.02 : (f / (1 - f)) * directHorizontal;
  // Clear-sky diffuse is blue: shade on digital photos of the site has B/R ~2.
  const sky = new THREE.Color(0.62, 0.85, 1.25).multiplyScalar(skyMag);
  const groundAlbedo = bounce ? 0.22 : 0;
  const ground = new THREE.Color(0.9, 0.85, 0.75).multiplyScalar(
    groundAlbedo * (directHorizontal + skyMag),
  );
  // Light sent back by an occluder that blocks a sky direction (shaded copper,
  // sunlit rock and tree, the lit far side of the screen). Not derived: 0.3 of
  // the sunlit-ground term was checked against the Highsmith photograph, where
  // dash/shade contrast is 19-32; the lab gives 24-35 (review 2026-09-27).
  const occluder = ground.clone().multiplyScalar(0.3);
  return { dni, sky, ground, occluder, directHorizontal, skyMag };
}

// ---------------------------------------------------------------------------
// Renderer, cameras, scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
const query = new URLSearchParams(location.search);
renderer.setPixelRatio(Number(query.get("dpr") ?? Math.min(window.devicePixelRatio, 2)));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // the accumulator tone-maps the mean
viewport.appendChild(renderer.domElement);

const accumulator = new ProgressiveAccumulator(renderer, MAX_SAMPLES_SKY);

const scene = new THREE.Scene();

const perspectiveCamera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
perspectiveCamera.position.set(-85, 76, 5);
perspectiveCamera.layers.enable(LAYER_GUIDES);

const orthoCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 3000);
orthoCamera.up.set(0, 0, -1); // north up on screen
orthoCamera.layers.enable(LAYER_GUIDES);

let activeCamera = perspectiveCamera;

const controls = new OrbitControls(perspectiveCamera, renderer.domElement);
// No damping: a progressive renderer restarts on every camera change, and a
// damped camera keeps drifting for seconds after the mouse is released.
controls.enableDamping = false;
controls.target.set(-35, 14, 50);
controls.minDistance = 20;
controls.maxDistance = 4000;
controls.maxPolarAngle = Math.PI / 2 - 0.01;
controls.update();

const traceUniforms = createTraceUniforms();

// Sky dome (not traced; it is the light source for the diffuse term).
const skyUniforms = {
  uSunDir: traceUniforms.uSunDir,
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSunColor: { value: new THREE.Color() },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(9000, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uZenith, uHorizon, uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(uHorizon, uZenith, pow(h, 0.45));
        float s = max(dot(d, uSunDir), 0.0);
        c += uSunColor * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.08);
        // Schematic courtyard skyline (NOT surveyed, casts no light or shadow):
        // pale concrete facades with ribbon windows to the N and W, a soft tree
        // line elsewhere, so the view through the letters is not bare sky.
        float az = degrees(atan(d.x, -d.z));
        if (az < 0.0) az += 360.0;
        float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
        float lum = dot(uHorizon, vec3(0.2126, 0.7152, 0.0722));
        bool facade = az > 240.0 || az < 30.0;
        float wave = sin(radians(az) * 7.0) * 0.5 + sin(radians(az) * 23.0 + 1.3) * 0.3;
        float bh = 13.0 + 2.0 * step(0.0, sin(radians(az) * 5.0));
        float th = 6.5 + 2.5 * wave;
        vec3 ground = uHorizon * 0.55;
        if (facade && el < bh) {
          float ribbon = step(0.62, fract(el / 2.1));
          float mull = step(0.93, fract(az / 1.4));
          vec3 concrete = vec3(0.9, 0.88, 0.84) * lum * 1.05;
          vec3 glass = vec3(0.42, 0.48, 0.54) * lum * 0.75;
          c = mix(concrete, glass, ribbon * (1.0 - 0.6 * mull));
        } else if (el < th) {
          float leaf = 0.8 + 0.4 * fract(sin(dot(floor(vec2(az * 3.0, el * 3.0)), vec2(12.9898, 78.233))) * 43758.5453);
          c = vec3(0.16, 0.22, 0.12) * lum * 1.6 * leaf;
        }
        if (d.y < 0.0) c = ground;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }),
);
sky.frustumCulled = false;
sky.layers.set(LAYER_GUIDES);
scene.add(sky);

// Courtyard ground at PAVING level (just under the platform top, 14.1): the
// real paving runs flush around the sculpture. At y = 0 the printable
// model's 0.4 m plinth stood up like a tabletop island. Receives, never
// occludes.
const groundMaterial = createTracedMaterial(traceUniforms, {
  // (uMaskOn set below: the plane is cut away over the pool basin)
  albedo: new THREE.Color(0.36, 0.35, 0.34),
  kind: 1, // paving near the sculpture, lawn beyond
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 14.0;
scene.add(ground);

// Surface appearance per part. Albedos are plausible, not measured.
const SURFACES = {
  // Matte: the photographed patina shows no glints. A glossy specular (0.3)
  // made the up-facing cut floors flash white and read as "salt noise".
  copper: { albedo: new THREE.Color(0.06, 0.09, 0.085), kind: 2, specular: 0.03, shininess: 10 },
  // Grey granite flags (photos), with the pool basin drawn as dark water.
  platform: { albedo: new THREE.Color(0.26, 0.26, 0.27), kind: 3 },
  // Colours from photographs of the site: pale blue-green-white quartz, deep
  // red sandstone slab, rust-brown petrified wood.
  marble: { albedo: new THREE.Color(0.55, 0.62, 0.62) },
  sandstone: { albedo: new THREE.Color(0.32, 0.11, 0.08) },
  tree: { albedo: new THREE.Color(0.3, 0.17, 0.1), texture: 0.35 },
  // Read mode paints every receiver the same neutral grey, so what you see
  // is irradiance, not material.
  receiver: { albedo: new THREE.Color(0.7, 0.7, 0.7) },
};

function surfaceFor(name) {
  const n = name.toLowerCase();
  if (n.includes("copper")) return "copper";
  if (n.includes("platform")) return "platform";
  if (n.includes("marble")) return "marble";
  if (n.includes("sandstone")) return "sandstone";
  if (n.includes("tree")) return "tree";
  return "platform";
}

const materials = {};
for (const [key, spec] of Object.entries(SURFACES)) {
  materials[key] = createTracedMaterial(traceUniforms, spec);
}
// Read mode paints the courtyard plane neutral too -- with the pool cut out.
const groundReceiverMaterial = createTracedMaterial(traceUniforms, SURFACES.receiver);
groundMaterial.uniforms.uMaskOn.value = true;
groundReceiverMaterial.uniforms.uMaskOn.value = true;

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

const guides = new THREE.Group();
scene.add(guides);

function makeLabel(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 34px Georgia";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f0c890";
  ctx.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(22, 11, 1);
  return sprite;
}

const compass = new THREE.Group();
guides.add(compass);
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(170, 171.2, 128),
    new THREE.MeshBasicMaterial({
      color: 0xc08050,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = ground.position.y + 0.15;
  compass.add(ring);
  for (const [label, bearing] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const s = makeLabel(label);
    s.position.copy(bearingVector(bearing).multiplyScalar(188)).setY(ground.position.y + 4);
    compass.add(s);
  }
}

const sunMarker = new THREE.Mesh(
  new THREE.SphereGeometry(9, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
guides.add(sunMarker);

const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.35 });
const rays = new THREE.LineSegments(new THREE.BufferGeometry(), rayMaterial);
guides.add(rays);

const shadowArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 110, 0xd08050, 12, 7);
guides.add(shadowArrow);

const windowOutline = new THREE.LineLoop(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xe5af67, depthTest: false, transparent: true }),
);
windowOutline.renderOrder = 10;
windowOutline.visible = false;
scene.add(windowOutline);
guides.traverse((o) => o.layers.set(LAYER_GUIDES));
windowOutline.layers.set(LAYER_GUIDES);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const modelRoot = new THREE.Group();
scene.add(modelRoot);

const parts = { copper: [], platform: [], context: [] };
let casters = null; // { copper, context, triangles, buildMs } from buildCasterBVHs
let copperBox = new THREE.Box3();
let receiverY = 14.1; // platform top; set from the copper base on load
let currentModel = null;
let shadowTrack = null;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(asset("draco/"));
dracoLoader.setDecoderConfig({ type: "wasm" });
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

const SCREEN_GLB = {
  demo: "demo",
  rebuilt: asset("kryptos_screen.glb"),
  thin: asset("kryptos_thin.glb"),
  original: asset("kryptos.glb"),
};
let demoLayout = null;

function disposeModel() {
  shadowTrack = null;
  modelRoot.traverse((obj) => obj.isMesh && obj.geometry.dispose());
  modelRoot.clear();
  parts.copper.length = 0;
  parts.platform.length = 0;
  parts.context.length = 0;
  casters = null;
}

let loadToken = 0;
let modelLoading = false;
function loadModel(url) {
  const token = ++loadToken;
  modelLoading = true;
  loading.classList.remove("hidden");
  loading.querySelector("p").textContent = "Loading cut-letter geometry…";
  loadingPercent.textContent = "0%";
  const acceptModel = (gltf) => {
      if (token !== loadToken) return; // a newer load superseded this one
      disposeModel();
      const model = gltf.scene;
      modelRoot.rotation.set(0, 0, 0);
      modelRoot.add(model);
      currentModel = model;
      const box = new THREE.Box3().setFromObject(model);
      const c = box.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -box.min.y, -c.z);
      modelRoot.updateMatrixWorld(true);

      model.traverse((obj) => {
        if (!obj.isMesh) return;
        // Name lives on the mesh or on its parent node depending on exporter.
        const key = surfaceFor(`${obj.name} ${obj.parent?.name ?? ""}`);
        obj.material = materials[key];
        obj.userData.surface = key;
        if (key === "copper") parts.copper.push(obj);
        else if (key === "platform") parts.platform.push(obj);
        else parts.context.push(obj);
      });
      if (!parts.copper.length) {
        loading.querySelector("p").textContent = "No copper screen in this GLB.";
        return;
      }

      copperBox = screenBox();
      receiverY = copperBox.min.y - 0.3; // refined from the platform once the BVHs exist

      loading.querySelector("p").textContent = "Building ray-tracing BVH…";
      loadingPercent.textContent = "";
      // Let the message paint before the synchronous build.
      setTimeout(() => {
        if (token !== loadToken) return;
        // Copper + platform always cast; tree + rocks are the optional set.
        casters = buildCasterBVHs(traceUniforms, parts, modelRoot);
        receiverY = pavingHeight() ?? receiverY;
        buildPoolMask();
        modelLoading = false;
        initWords(url, token);
        console.info(
          `[sun-ray-lab] ${url} BVHs built in ${casters.buildMs.toFixed(0)} ms: ` +
            `screen+platform ${casters.triangles.fixed} tris, tree+rocks ${casters.triangles.context} tris`,
        );
        modelRoot.rotation.y = THREE.MathUtils.degToRad(state.yaw);
        state.center = null;
        applyView();
        loading.classList.add("hidden");
      }, 30);
    };
  const onError = (err) => {
    console.error(err);
    modelLoading = false;
    loading.querySelector("p").textContent = "Model failed to load. Select the open demo to continue.";
    loadingPercent.textContent = "";
  };
  if (url === SCREEN_GLB.demo) {
    import("./demo-scene.js").then(({ createDemoScene }) => {
      const result = createDemoScene();
      demoLayout = result.layout;
      acceptModel(result);
    }).catch(onError);
    return;
  }
  loader.load(url, acceptModel,
    (ev) => {
      if (ev.total) loadingPercent.textContent = `${Math.round((ev.loaded / ev.total) * 100)}%`;
    },
    onError,
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const isPost = (m) => `${m.name} ${m.parent?.name ?? ""}`.includes("Posts");

/** Bounds of the copper plate itself (the support posts excluded). */
function screenBox() {
  modelRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of parts.copper) if (!isPost(m)) box.expandByObject(m);
  return box;
}

/**
 * Where the courtyard plane (y = 14.0) must be cut away: over the platform's
 * pool basin, whose surface lies below it. Ray-cast the platform on a grid
 * (modelRoot-local), mark basin cells, dilate by two cells (the platform top
 * around the basin is above the plane, so over-cutting there is invisible).
 */
const POOL_MASK_N = 256;
let poolMask = null;
function buildPoolMask() {
  const geo = casters.platform.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const N = POOL_MASK_N;
  const minX = bb.min.x;
  const minZ = bb.min.z;
  const sx = (bb.max.x - bb.min.x) / N;
  const sz = (bb.max.z - bb.min.z) / N;
  // low = no platform top here (basin, or outside the platform, or its
  // outer cliff); flood-fill the low cells reachable from the border: those
  // are OUTSIDE, where the plane must stay (it hides the plinth's cliff).
  const low = new Uint8Array(N * N);
  _ray.direction.set(0, -1, 0);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      _ray.origin.set(minX + (i + 0.5) * sx, 1000, minZ + (j + 0.5) * sz);
      const hit = casters.platform.raycastFirst(_ray, THREE.DoubleSide);
      if (!hit || 1000 - hit.distance < 13.95) low[j * N + i] = 1;
    }
  const outside = new Uint8Array(N * N);
  const stack = [];
  for (let i = 0; i < N; i++) stack.push(i, (N - 1) * N + i, i * N, i * N + N - 1);
  while (stack.length) {
    const c = stack.pop();
    if (outside[c] || !low[c]) continue;
    outside[c] = 1;
    const i = c % N;
    const j = (c - i) / N;
    if (i > 0) stack.push(c - 1);
    if (i < N - 1) stack.push(c + 1);
    if (j > 0) stack.push(c - N);
    if (j < N - 1) stack.push(c + N);
  }
  const basin = new Uint8Array(N * N);
  for (let c = 0; c < N * N; c++) basin[c] = low[c] && !outside[c] ? 1 : 0;
  const data = new Uint8Array(N * N * 4);
  const open = new Uint8Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      let v = 0;
      // dilate into the platform top only, never into the outside
      if (!outside[j * N + i])
        for (let dj = -2; dj <= 2 && !v; dj++)
          for (let di = -2; di <= 2 && !v; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii >= 0 && jj >= 0 && ii < N && jj < N && basin[jj * N + ii]) v = 1;
          }
      data[4 * (j * N + i)] = v * 255;
      data[4 * (j * N + i) + 3] = 255;
      open[j * N + i] = v ? 0 : 1;
    }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  traceUniforms.uMask.value?.dispose?.();
  traceUniforms.uMask.value = tex;
  traceUniforms.uMaskMin.value.set(minX, minZ);
  traceUniforms.uMaskSize.value.set(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  poolMask = { open, N, minX, minZ, sx, sz };
}

/** Is the courtyard plane present at modelRoot-local (x, z)? */
function groundOpen(x, z) {
  if (!poolMask) return true;
  const i = Math.floor((x - poolMask.minX) / poolMask.sx);
  const j = Math.floor((z - poolMask.minZ) / poolMask.sz);
  if (i < 0 || j < 0 || i >= poolMask.N || j >= poolMask.N) return true;
  return poolMask.open[j * poolMask.N + i] === 1;
}

/**
 * Paving height around the screen: the median platform height under a grid
 * over the screen's footprint, ignoring the pool basin. The plate now stands
 * on posts above the paving, so its own bottom is no longer the receiver.
 */
function pavingHeight() {
  if (!casters || copperBox.isEmpty()) return null;
  modelRoot.updateMatrixWorld(true);
  _inv.copy(modelRoot.matrixWorld).invert();
  const hs = [];
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 8; j++) {
      const x = THREE.MathUtils.lerp(copperBox.min.x, copperBox.max.x, i / 8);
      const z = THREE.MathUtils.lerp(copperBox.min.z, copperBox.max.z, j / 8);
      _ray.origin.set(x, 1000, z).applyMatrix4(_inv);
      _ray.direction.set(0, -1, 0).transformDirection(_inv);
      const hit = casters.platform.raycastFirst(_ray, THREE.DoubleSide);
      if (hit && 1000 - hit.distance > 12) hs.push(1000 - hit.distance);
    }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

/** Where the copper's bounding box lands on the receiver plane along the beam. */
function projectedFootprint(dir) {
  if (!parts.copper.length || dir.y <= 1e-4) return null;
  modelRoot.updateMatrixWorld(true);
  const box = screenBox();
  const min = new THREE.Vector2(Infinity, Infinity);
  const max = new THREE.Vector2(-Infinity, -Infinity);
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const t = (y - receiverY) / dir.y;
        const px = x - dir.x * t;
        const pz = z - dir.z * t;
        min.x = Math.min(min.x, px);
        min.y = Math.min(min.y, pz);
        max.x = Math.max(max.x, px);
        max.y = Math.max(max.y, pz);
      }
  return { min, max };
}

const _ray = new THREE.Ray();
const _inv = new THREE.Matrix4();

/**
 * The plate's own normal at a probe hit. The first triangle a ray meets can
 * be the wall of a letter cut (often horizontal), which says nothing about
 * the plate. The screen is a vertical extrusion, so cast short horizontal
 * rays at the plate from just outside it and keep the first near-vertical
 * face; stepping up and down skips any letter hole.
 */
function plateNormal(hit, dir) {
  const p = hit.point; // model space
  const dInv = dir.clone().transformDirection(_inv);
  const h = new THREE.Vector3(dInv.x, 0, dInv.z);
  if (h.lengthSq() < 1e-8) return hit.face.normal.clone().transformDirection(modelRoot.matrixWorld);
  h.normalize();
  for (const dy of [0, 0.35, -0.35, 0.7, -0.7, 1.2, -1.2]) {
    _ray.origin.set(p.x + h.x * 3, p.y + dy, p.z + h.z * 3);
    _ray.direction.copy(h).negate();
    const hh = casters.screen.raycastFirst(_ray, THREE.DoubleSide, 0, 6);
    if (hh && Math.abs(hh.face.normal.y) < 0.3) {
      return hh.face.normal.clone().transformDirection(modelRoot.matrixWorld);
    }
  }
  return hit.face.normal.clone().transformDirection(modelRoot.matrixWorld);
}

/**
 * Cast the central sun ray up from a receiver point and report where it
 * crosses the screen: throw distance, incidence on the plate, and blur.
 * Uses the same BVH the GPU traces.
 */
function probe(x, z, dir, visibilityOnly = false) {
  if (!casters || dir.y <= 0) return null;
  modelRoot.updateMatrixWorld(true);
  _inv.copy(modelRoot.matrixWorld).invert();
  // Find the receiver surface height below (x, z): cast down.
  _ray.origin.set(x, 1000, z).applyMatrix4(_inv);
  _ray.direction.set(0, -1, 0).transformDirection(_inv);
  // Match the visible receiver, including the raised courtyard, its pool
  // cutout and (unless isolated) the rocks. Starting below the courtyard
  // incorrectly reported open rays as blocked by the buried plinth.
  const floor = resolveReceiver({
    ray: _ray, platform: casters.platform, context: casters.context,
    groundY: ground.position.y, groundOpen,
    includeContext: traceUniforms.uContextCasts.value,
  });
  if (!floor) return null;
  const worldPoint = floor.point.clone().applyMatrix4(modelRoot.matrixWorld);
  const normal = floor.normal.clone().transformDirection(modelRoot.matrixWorld);
  const groundY = worldPoint.y;
  const origin = worldPoint.clone().addScaledVector(normal, 0.002 + 0.00002 * worldPoint.length());
  _ray.origin.copy(origin).applyMatrix4(_inv);
  _ray.direction.copy(dir).transformDirection(_inv);
  const upScreen = casters.screen.raycastFirst(_ray, THREE.DoubleSide, 0, PROBE_MAX_DIST);
  const upPlatform = casters.platform.raycastFirst(_ray, THREE.DoubleSide, 0, PROBE_MAX_DIST);
  const upContext = traceUniforms.uContextCasts.value
    ? casters.context.raycastFirst(_ray, THREE.DoubleSide, 0, PROBE_MAX_DIST) : null;
  const up = [upScreen, upPlatform, upContext].filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
  const receiver = { groundY, normal: normal.toArray(), receiver: floor.kind };
  if (!up) return { ...receiver, open: true };
  const hitScreen = up === upScreen;
  const blocker = hitScreen ? "screen" : up === upContext ? "tree or rock" : "platform";
  if (visibilityOnly) return { ...receiver, open: false, hitScreen, blocker };
  const n = hitScreen ? plateNormal(up, dir) : up.face.normal.clone().transformDirection(modelRoot.matrixWorld);
  const cosInc = Math.abs(n.dot(dir));
  return {
    ...receiver,
    open: false,
    blocker,
    hitScreen,
    distance: up.distance,
    height: up.point.clone().applyMatrix4(modelRoot.matrixWorld).y - groundY,
    cosInc,
    incidenceDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, cosInc))),
    blur: blur(up.distance, cosInc, state.elevation),
  };
}

// ---------------------------------------------------------------------------
// Sun and lighting update
// ---------------------------------------------------------------------------

function utcOffset() {
  return state.dst ? SITE.standardOffset + 1 : SITE.standardOffset;
}

function applyEphemeris() {
  const [y, mo, d] = state.date.split("-").map(Number);
  const [hh, mi] = state.time.split(":").map(Number);
  if ([y, mo, d, hh, mi].some((v) => !Number.isFinite(v))) return;
  const pos = solarPosition({
    year: y,
    month: mo,
    day: d,
    minutes: hh * 60 + mi,
    latitude: state.latitude,
    longitude: state.longitude,
    utcOffset: utcOffset(),
  });
  state.azimuth = pos.azimuth;
  state.elevation = pos.elevation;
  $("#ephemeris-note").textContent =
    pos.elevation <= 0
      ? `Sun below the horizon (${pos.elevation.toFixed(2)}°): no direct beam.`
      : `NOAA · dec ${pos.declination.toFixed(2)}° · EoT ${pos.equationOfTime.toFixed(1)} min · refracted alt ${pos.elevationApparent.toFixed(2)}°`;
}

let sunDir = sunDirection(state.azimuth, state.elevation);
let currentLight = solarLight(state.elevation, state.skyFill, state.bounce);

function updateSun() {
  if (state.sunMode === "ephemeris") applyEphemeris();
  sunDir = sunDirection(state.azimuth, state.elevation);
  const light = solarLight(state.elevation, state.skyFill, state.bounce);
  currentLight = light;

  traceUniforms.uSunDir.value.copy(sunDir);
  traceUniforms.uSunTanRadius.value = state.trueSun ? Math.tan(SUN_ANGULAR_RADIUS) : 0;
  traceUniforms.uSunIrr.value.copy(light.dni);

  // Sky dome radiance consistent with the diffuse irradiance it supplies.
  const zen = light.sky.clone().multiplyScalar(2.2 / Math.PI).multiply(new THREE.Color(0.7, 0.85, 1.25));
  const warm = THREE.MathUtils.clamp((25 - state.elevation) / 25, 0, 1);
  const hor = light.sky
    .clone()
    .multiplyScalar(3.0 / Math.PI)
    .lerp(new THREE.Color(1.0, 0.62, 0.35).multiplyScalar(light.skyMag * 0.5), warm);
  skyUniforms.uZenith.value.copy(zen);
  skyUniforms.uHorizon.value.copy(hor);
  skyUniforms.uSunColor.value.copy(light.dni).multiplyScalar(0.4);

  // Guides
  const centre = copperBox.isEmpty() ? new THREE.Vector3(0, 60, 0) : copperBox.getCenter(new THREE.Vector3());
  sunMarker.position.copy(sunDir).multiplyScalar(420).add(centre);
  sunMarker.material.color.copy(light.dni).multiplyScalar(0.6);
  const side = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  const lateral = new THREE.Vector3().crossVectors(side, sunDir).normalize();
  const pts = [];
  for (const a of [-50, 0, 50])
    for (const b of [-30, 30]) {
      const o = sunDir.clone().multiplyScalar(400).add(centre).addScaledVector(side, a).addScaledVector(lateral, b);
      pts.push(o, o.clone().addScaledVector(sunDir, -520));
    }
  rays.geometry.dispose();
  rays.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  const shadowBearing = (state.azimuth + 180) % 360;
  shadowArrow.position.set(0, ground.position.y + 0.2, 0);
  shadowArrow.setDirection(bearingVector(shadowBearing));

  $("#readout-azimuth").textContent = `${state.azimuth.toFixed(2)}°`;
  $("#readout-elevation").textContent = `${state.elevation.toFixed(2)}°`;
  $("#readout-shadow").textContent = `${shadowBearing.toFixed(2)}°`;
  $("#azimuth-number").value = state.azimuth.toFixed(2);
  $("#elevation-number").value = state.elevation.toFixed(2);
  $("#azimuth").value = state.azimuth;
  $("#elevation").value = state.elevation;

  followShadow();
  updateOrthoFrame();
  updatePhysicsReadout();
  // Sky visibility and albedo do not depend on the sun: keep them.
  accumulator.reset(["direct"]);
  scheduleWords();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Track a real point on the plate; moving the sun moves its projection. */
function anchorShadow(indices = null) {
  shadowTrack = null;
  if (!state.followShadow || !casters || sunDir.y <= 0.02) return;
  modelRoot.updateMatrixWorld(true);
  const target = state.view === "perspective" ? controls.target : state.center;
  if (!target) return;
  let point = null;
  if (finder && indices?.length) {
    point = new THREE.Vector3();
    for (const k of indices) point.add(new THREE.Vector3(finder.px[k], finder.py[k], finder.pz[k]));
    point.multiplyScalar(1 / indices.length);
  } else if (finder) {
    // Choose the letter whose ground projection is closest to the view's
    // focus. This preserves the inspected patch rather than jumping to a
    // different "best" word at every angle.
    let best = Infinity;
    for (let k = 0; k < finder.n; k++) {
      const local = new THREE.Vector3(finder.px[k], finder.py[k], finder.pz[k]);
      const p = projectToGround(local.clone().applyMatrix4(modelRoot.matrixWorld), sunDir, receiverY);
      if (!p) continue;
      const d = (p.x - target.x) ** 2 + (p.z - target.z) ** 2;
      if (d < best) { best = d; point = local; }
    }
  } else {
    // Comparison models have no glyph layout. Follow a low point on the
    // same plate so their shadow remains inspectable too.
    const box = screenBox();
    point = box.getCenter(new THREE.Vector3());
    point.y = box.min.y + (box.max.y - box.min.y) * 0.15;
    point.applyMatrix4(new THREE.Matrix4().copy(modelRoot.matrixWorld).invert());
  }
  if (point) shadowTrack = {
    point,
    projected: projectToGround(point.clone().applyMatrix4(modelRoot.matrixWorld), sunDir, receiverY),
  };
}

function followShadow() {
  if (!state.followShadow || sunDir.y <= 0.02) return;
  if (!shadowTrack) { anchorShadow(); return; }
  modelRoot.updateMatrixWorld(true);
  const next = sunDir.y > 0.02
    ? projectToGround(shadowTrack.point.clone().applyMatrix4(modelRoot.matrixWorld), sunDir, receiverY) : null;
  const center = state.view === "perspective" ? controls.target : state.center;
  if (center) {
    const moved = followShadowCenter(center, shadowTrack.projected, next);
    if (state.view === "perspective") {
      perspectiveCamera.position.x += moved.x - controls.target.x;
      perspectiveCamera.position.z += moved.z - controls.target.z;
      controls.target.x = moved.x;
      controls.target.z = moved.z;
      controls.update();
    } else state.center = moved;
  }
  shadowTrack.projected = next;
}

function autoCenter() {
  const fp = projectedFootprint(sunDir);
  if (!fp) return { x: 0, z: 0 };
  return { x: (fp.min.x + fp.max.x) / 2, z: (fp.min.y + fp.max.y) / 2 };
}

function updateOrthoFrame() {
  if (state.view === "perspective") {
    $(".north-key").style.transform = "";
    return;
  }
  if (!state.center) {
    state.center = autoCenter();
    if (state.view === "top") state.center = { x: 0, z: 0 };
  }
  const { x, z } = state.center;
  const aspect = viewport.clientWidth / Math.max(viewport.clientHeight, 1);
  const halfW = state.window / 2;
  const halfH = halfW / aspect;
  orthoCamera.left = -halfW;
  orthoCamera.right = halfW;
  orthoCamera.top = halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.position.set(x, 1200, z);
  orthoCamera.up.set(state.orthoUp.x, 0, state.orthoUp.z);
  orthoCamera.lookAt(x, 0, z);
  orthoCamera.near = 1;
  orthoCamera.far = 2400;
  orthoCamera.updateProjectionMatrix();
  orthoCamera.updateMatrixWorld(true);
  traceUniforms.uViewDir.value.set(0, -1, 0);
  const northUp = Math.abs(state.orthoUp.x) < 1e-6 && state.orthoUp.z < 0;
  $("#hud-orient").textContent = `${northUp ? "North up" : "Text up"}${state.flip ? " · mirrored view" : ""}`;
  // The N key shows where north is on screen: screen-up bearing b puts north
  // at -b (counter-clockwise); a mirrored view mirrors the key too.
  const b = THREE.MathUtils.radToDeg(Math.atan2(state.orthoUp.x, -state.orthoUp.z));
  $(".north-key").style.transform = `rotate(${-b}deg)${state.flip ? " scaleX(-1)" : ""}`;
  $("#readout-window").textContent = `${state.window.toFixed(state.window < 20 ? 1 : 0)} u`;
  $("#letter-window-number").value = state.window.toFixed(state.window < 20 ? 1 : 0);
  $("#letter-window").value = state.window;
  updateProbeReadout();
}

function applyView() {
  const readable = state.view === "readable";
  const ortho = state.view !== "perspective";
  activeCamera = ortho ? orthoCamera : perspectiveCamera;
  controls.enabled = !ortho;
  traceUniforms.uIsOrtho.value = ortho;

  // Read mode: copper hidden from the CAMERA only (it is in the BVH, so it
  // still casts); receivers painted neutral; tree/rocks per the isolate box.
  for (const m of parts.copper) m.visible = !readable;
  for (const m of parts.platform) m.material = readable ? materials.receiver : materials.platform;
  for (const m of parts.context) {
    m.visible = !(readable && state.isolate);
    // Read mode paints every visible receiver the same grey, rocks included,
    // so brightness is irradiance everywhere.
    m.material = readable ? materials.receiver : materials[m.userData.surface];
  }
  ground.material = readable ? groundReceiverMaterial : groundMaterial;
  traceUniforms.uContextCasts.value = !(readable && state.isolate);

  sky.visible = !ortho;
  compass.visible = !readable && $("#show-compass").checked;
  shadowArrow.visible = compass.visible;
  const showRays = !ortho && $("#show-rays").checked;
  rays.visible = showRays;
  sunMarker.visible = showRays;
  windowOutline.visible = false;

  $("#letter-controls").classList.toggle("hidden", !ortho);
  $("#mode-chip").classList.toggle("hidden", !readable);
  $("#crosshair").classList.toggle("hidden", !readable);
  $("#view-perspective").classList.toggle("active", state.view === "perspective");
  $("#view-top").classList.toggle("active", state.view === "top");
  $("#view-readable").classList.toggle("active", readable);
  $("#hud-orbit").classList.toggle("hidden", ortho);
  $("#hud-ortho").classList.toggle("hidden", !ortho);

  updateSun();
  accumulator.reset(); // materials / casters / visibility changed
}

function setView(mode) {
  if (mode === state.view) return;
  shadowTrack = null;
  state.view = mode;
  state.center = null;
  state.orthoUp = { x: 0, z: -1 };
  setFlip(false);
  $("#words-chip").classList.add("hidden");
  if (mode === "readable") state.window = 60;
  if (mode === "top") state.window = 420;
  applyView();
  anchorShadow();
}

// ---------------------------------------------------------------------------
// Physics readout
// ---------------------------------------------------------------------------

const VERDICT_CLASS = { CRISP: "ok", SOFT: "ok", MARGINAL: "warn", ILLEGIBLE: "bad" };

function updatePhysicsReadout() {
  const scr = SCREENS[state.screen];
  const L = scr.letterHeight;
  const height = copperBox.isEmpty() ? SCREEN_HEIGHT_U : copperBox.max.y - copperBox.min.y;
  const rep = screenReport(state.elevation, L, height);
  const rows = rep.rows
    .map(
      (r) => `<tr>
        <td>${r.label}</td>
        <td>${r.distance.toFixed(0)}</td>
        <td>${r.letterMajor.toFixed(2)}</td>
        <td>${r.ratio.toFixed(2)}</td>
        <td class="v-${VERDICT_CLASS[r.verdict]}">${r.verdict}</td>
      </tr>`,
    )
    .join("");
  // A ray crossing a vertical plate of thickness t drops t*tan(el): once that
  // exceeds a horizontal stroke's height, the stroke's hole is closed off.
  const drop = scr.thickness * Math.tan(THREE.MathUtils.degToRad(Math.max(state.elevation, 0)));
  const barCut = louvreCutoffDeg(scr.thickness, scr.barHeight);
  const stemCut = louvreCutoffDeg(scr.thickness, scr.letterHeight);
  const barsPass = drop < scr.barHeight;
  $("#physics-body").innerHTML = state.elevation <= 0
    ? `<p class="verdict v-bad">Sun below the horizon — no direct beam.</p>`
    : `
    <p class="physics-sub">Penumbra, best case (sun square-on to the plate)</p>
    <table class="physics-table">
      <thead><tr><th>height</th><th>throw</th><th>blur</th><th>÷L</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="physics-note">
      Blur is measured in the letter's own frame: the ${(SUN_ANGULAR_DIAMETER * 1000).toFixed(2)} mrad disc
      × throw, stretched by 1/cos(incidence) because the plate is vertical.
      Letters read up to <b>${rep.maxLegibleHeight.toFixed(0)} u</b> of ${height.toFixed(0)} u
      (<b>${(rep.legibleFraction * 100).toFixed(0)}%</b> of the screen) at this elevation, and less
      where the panel turns away from the sun. Letter ${L.toFixed(1)} u; legible while blur ≤
      ${LETTER.legibilityRatio} × letter.
    </p>
    <p class="physics-sub">What the letter light looks like now</p>
    <p class="verdict v-${barsPass ? "ok" : "warn"}">
      ${
        barsPass
          ? `Sun ${state.elevation.toFixed(0)}°: whole letters pass the ${scr.label.toLowerCase()} — expect
             mirrored letter shapes near the foot of the screen, blurring with height.`
          : `Sun ${state.elevation.toFixed(0)}°: a ray drops ${drop.toFixed(2)} u crossing the
             ${mm(scr.thickness).toFixed(0)} mm plate, more than a horizontal stroke
             (${scr.barHeight.toFixed(2)} u). Only the vertical stems pass, so the shadow is rows of
             short dashes that soften into dots — the pattern in real photographs of the site at high
             sun. Horizontal strokes pass below ~${barCut.toFixed(0)}°.`
      }
      Stems pass up to ~${stemCut.toFixed(0)}°.
    </p>`;
  updateProbeReadout();
}

function updateProbeReadout() {
  const el = $("#probe-body");
  if (!el) return;
  if (state.view !== "readable" || !state.center) {
    el.innerHTML = `<span class="muted">Open <b>Read shadows</b> to probe the ray through the view centre.</span>`;
    return;
  }
  const p = probe(state.center.x, state.center.z, sunDir);
  if (!p) {
    el.innerHTML = `<span class="muted">No direct beam.</span>`;
  } else if (p.open) {
    el.innerHTML = `<span class="muted">Centre ray reaches the sun without touching the screen (open sky).</span>`;
  } else if (!p.hitScreen) {
    el.innerHTML = `<span class="muted">Centre ray blocked by the ${p.blocker}.</span>`;
  } else {
    const L = SCREENS[state.screen].letterHeight;
    const ratio = p.blur.letterMajor / L;
    const v = verdictFor(ratio);
    el.innerHTML = `
      <p class="verdict v-${VERDICT_CLASS[v]}">Centre crosses the screen <b>${p.height.toFixed(1)} u</b> up:
        <b>${v}</b> (blur ${(ratio * 100).toFixed(0)}% of letter)</p>
      <table class="physics-table compact"><tbody>
        <tr><td>throw</td><td>${p.distance.toFixed(1)} u (${(mm(p.distance) / 1000).toFixed(2)} m)</td></tr>
        <tr><td>incidence on plate</td><td>${p.incidenceDeg.toFixed(1)}°</td></tr>
        <tr><td>blur, letter frame</td><td>${p.blur.letterMinor.toFixed(2)} × ${p.blur.letterMajor.toFixed(2)} u</td></tr>
        <tr><td>blur, on ground</td><td>${p.blur.groundAcross.toFixed(2)} × ${p.blur.groundAlong.toFixed(2)} u</td></tr>
        <tr><td>Fresnel number</td><td>${fresnelNumber(LETTER.strokeWidth, p.distance).toFixed(0)} (≫1: geometric)</td></tr>
      </tbody></table>`;
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function setActivePreset(btn = null) {
  document
    .querySelectorAll(".preset:not(.camera-preset)")
    .forEach((b) => b.classList.toggle("active", b === btn));
  // The eyewitness quote and the photo belong to their presets only.
  $("#eyewitness").classList.toggle("hidden", btn?.dataset.date !== "2002-10-18");
  if (btn?.dataset.photo !== "1") showPhoto(false);
}

function setSunMode(mode) {
  state.sunMode = mode;
  $("#sunmode-ephemeris").classList.toggle("active", mode === "ephemeris");
  $("#sunmode-manual").classList.toggle("active", mode === "manual");
  $("#ephemeris-controls").classList.toggle("hidden", mode !== "ephemeris");
  $("#manual-controls").classList.toggle("hidden", mode !== "manual");
  updateSun();
}

$("#sunmode-ephemeris").addEventListener("click", () => setSunMode("ephemeris"));
$("#sunmode-manual").addEventListener("click", () => setSunMode("manual"));

for (const key of ["date", "time"]) {
  $(`#${key}`).addEventListener("input", (e) => {
    state[key] = e.target.value;
    if (key === "date") {
      const [y, mo, d] = state.date.split("-").map(Number);
      if (Number.isFinite(y)) {
        state.dst = isUsDst(y, mo, d);
        $("#dst").checked = state.dst;
      }
    }
    setActivePreset();
    updateSun();
  });
}
$("#dst").addEventListener("change", (e) => {
  state.dst = e.target.checked;
  setActivePreset();
  updateSun();
});
for (const key of ["latitude", "longitude"]) {
  $(`#${key}`).addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) state[key] = v;
    setActivePreset();
    updateSun();
  });
}

function bindSlider(rangeSel, numberSel, key, onChange, clearsSunPreset = true) {
  const range = $(rangeSel);
  const number = $(numberSel);
  range.addEventListener("input", () => {
    state[key] = Number(range.value);
    if (clearsSunPreset) setActivePreset();
    onChange();
  });
  number.addEventListener("change", () => {
    const v = THREE.MathUtils.clamp(Number(number.value), Number(number.min), Number(number.max));
    if (Number.isFinite(v)) state[key] = v;
    range.value = state[key];
    if (clearsSunPreset) setActivePreset();
    onChange();
  });
}
bindSlider("#azimuth", "#azimuth-number", "azimuth", updateSun);
bindSlider("#elevation", "#elevation-number", "elevation", updateSun);
bindSlider("#model-yaw", "#yaw-number", "yaw", () => {
  modelRoot.rotation.y = THREE.MathUtils.degToRad(state.yaw);
  $("#yaw-number").value = state.yaw.toFixed(2);
  modelRoot.updateMatrixWorld(true);
  copperBox = screenBox();
  updateSun();
  accumulator.reset(); // geometry moved: sky visibility changes too
  $("#words-times").innerHTML = ""; // best times depend on the yaw
}, false); // yaw leaves the sun (and its preset) alone

// Camera positions at a visitor's eye height (1.7 m ~ 58 u above the paving
// at 14.1 u). "pocket" matches the Library of Congress photo (photos lens,
// 2026-09-27: camera [-58,74,62] -> [-16,16,30]).
const CAMERA_PRESETS = {
  demo: { position: [150, 105, -170], target: [0, 30, -35] },
  front: { position: [120, 72, 150], target: [-5, 58, -5] },
  pocket: { position: [-58, 74, 62], target: [-16, 16, 30] },
  // Approximately where Carol Highsmith stood: level, beside the tableau
  // lobe's convex face, looking into the pocket (realism review 2026-09-27).
  highsmith: { position: [-58, 72, -40], target: [-18, 28, 38] },
  // Where the "letters in light" of Elonka Dunin's visit land (paving inside
  // the south lobe), seen from a visitor's eye height.
  "pocket-oct": { position: [-85, 76, 5], target: [-35, 14, 50] },
  overview: { position: [170, 95, 215], target: [0, 55, 0] },
};

// Orbiting away from a documented view retires its quote.
controls.addEventListener("start", () => {
  $("#eyewitness").classList.add("hidden");
  $("#words-chip").classList.add("hidden");
});
controls.addEventListener("end", () => anchorShadow());

function applyCameraPreset(name) {
  shadowTrack = null;
  if (name === "top") {
    setView("top");
    anchorShadow();
    return;
  }
  const cam = CAMERA_PRESETS[name];
  if (!cam) return;
  if (state.view !== "perspective") setView("perspective");
  perspectiveCamera.position.fromArray(cam.position);
  controls.target.fromArray(cam.target);
  controls.update();
  anchorShadow();
  accumulator.reset();
}

function showLetterDemo() {
  state.azimuth = 218;
  state.elevation = 33;
  state.yaw = 0;
  modelRoot.rotation.y = 0;
  copperBox = screenBox();
  state.trueSun = true;
  state.skyFill = 0.15;
  state.bounce = true;
  $("#true-sun").checked = true;
  $("#sky-fill").value = "0.15";
  $("#sky-fill-readout").textContent = "15%";
  $("#model-yaw").value = "0";
  $("#yaw-number").value = "0";
  state.followShadow = true;
  $("#follow-shadow").checked = true;
  shadowTrack = null;
  const preferred = availableScreens.has("rebuilt") ? "rebuilt" : "demo";
  if (state.screen !== preferred) {
    state.screen = preferred;
    $("#screen-select").value = state.screen;
    loadModel(SCREEN_GLB[preferred]);
  }
  setActivePreset();
  setSunMode("manual");
  applyCameraPreset(state.screen === "demo" ? "demo" : "pocket-oct");
  $("#words-times").innerHTML = "";
  accumulator.reset();
}
$("#letter-demo").addEventListener("click", showLetterDemo);
$("#follow-shadow").addEventListener("change", (e) => {
  state.followShadow = e.target.checked;
  anchorShadow();
});

function showPhoto(on) {
  on = on && Boolean(localAssets.referencePhoto);
  $("#show-photo").checked = on;
  $("#photo-inset").classList.toggle("hidden", !on);
}
$("#show-photo").addEventListener("change", (e) => showPhoto(e.target.checked));

document.querySelectorAll(".camera-preset").forEach((button) => {
  button.addEventListener("click", () => applyCameraPreset(button.dataset.camera));
});

document.querySelectorAll(".preset:not(.camera-preset)").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.date) {
      state.date = button.dataset.date;
      state.time = button.dataset.time;
      const [y, mo, d] = state.date.split("-").map(Number);
      state.dst = isUsDst(y, mo, d);
      $("#date").value = state.date;
      $("#time").value = state.time;
      $("#dst").checked = state.dst;
      setSunMode("ephemeris");
    } else {
      state.azimuth = Number(button.dataset.azimuth);
      state.elevation = Number(button.dataset.elevation);
      setSunMode("manual");
    }
    setActivePreset(button);
    if (button.dataset.camera) applyCameraPreset(button.dataset.camera);
    showPhoto(button.dataset.photo === "1");
  });
});

$("#screen-select").addEventListener("change", (e) => {
  state.screen = e.target.value;
  loadModel(SCREEN_GLB[state.screen]);
});
$("#true-sun").addEventListener("change", (e) => {
  state.trueSun = e.target.checked;
  updateSun();
});
$("#sky-fill").addEventListener("input", (e) => {
  state.skyFill = Number(e.target.value);
  $("#sky-fill-readout").textContent = `${(state.skyFill * 100).toFixed(0)}%`;
  // The lighting is display-only (the composite applies E_sky / E_ground), but
  // the sky dome's colour lives in the direct channel: refresh it.
  updateSun();
});
$("#isolate-screen").addEventListener("change", (e) => {
  state.isolate = e.target.checked;
  applyView();
});
$("#show-rays").addEventListener("change", () => applyView());
$("#show-compass").addEventListener("change", () => applyView());

$("#view-perspective").addEventListener("click", () => setView("perspective"));
$("#view-top").addEventListener("click", () => setView("top"));
$("#view-readable").addEventListener("click", () => setView("readable"));

$("#letter-window").addEventListener("input", (e) => {
  state.window = Number(e.target.value);
  updateOrthoFrame();
  accumulator.reset();
});
$("#letter-window-number").addEventListener("change", (e) => {
  state.window = THREE.MathUtils.clamp(Number(e.target.value), 4, 600);
  updateOrthoFrame();
  accumulator.reset();
});
$("#recenter").addEventListener("click", () => {
  state.center = null;
  updateOrthoFrame();
  accumulator.reset();
  anchorShadow();
});

// Ortho views: wheel zooms about the cursor, drag pans.
renderer.domElement.addEventListener(
  "wheel",
  (event) => {
    if (state.view === "perspective" || !state.center) return;
    event.preventDefault();
    const rect = renderer.domElement.getBoundingClientRect();
    let fx = (event.clientX - rect.left) / rect.width - 0.5;
    const fy = (event.clientY - rect.top) / rect.height - 0.5;
    if (state.flip) fx = -fx;
    const unitsPerPx = state.window / rect.width;
    // screen right R = (-up.z, up.x); screen down = -up
    const U = state.orthoUp;
    const a = fx * rect.width * unitsPerPx;
    const b = fy * rect.height * unitsPerPx;
    const wx = state.center.x - U.z * a - U.x * b;
    const wz = state.center.z + U.x * a - U.z * b;
    const factor = Math.exp(event.deltaY * 0.0015);
    const next = THREE.MathUtils.clamp(state.window * factor, 4, 600);
    const k = next / state.window;
    state.center = { x: wx - (wx - state.center.x) * k, z: wz - (wz - state.center.z) * k };
    state.window = next;
    updateOrthoFrame();
    accumulator.reset();
    anchorShadow();
  },
  { passive: false },
);

let drag = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (state.view === "perspective" || e.button !== 0 || !state.center) return;
  drag = { x: e.clientX, y: e.clientY, cx: state.center.x, cz: state.center.z };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const unitsPerPx = state.window / renderer.domElement.clientWidth;
  // Screen right R = (-up.z, up.x); dragging moves the ground with the cursor.
  const U = state.orthoUp;
  const dx = (e.clientX - drag.x) * unitsPerPx * (state.flip ? -1 : 1);
  const dy = (e.clientY - drag.y) * unitsPerPx;
  state.center = {
    x: drag.cx + U.z * dx + U.x * dy,
    z: drag.cz - U.x * dx + U.z * dy,
  };
  updateOrthoFrame();
  accumulator.reset();
});
function endDrag(e) {
  if (!drag) return;
  drag = null;
  anchorShadow();
  try {
    renderer.domElement.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
}
renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  perspectiveCamera.aspect = w / Math.max(h, 1);
  perspectiveCamera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  const dpr = renderer.getPixelRatio();
  accumulator.setSize(w * dpr, h * dpr);
  updateOrthoFrame();
  accumulator.reset();
}
new ResizeObserver(resize).observe(viewport);

// ---------------------------------------------------------------------------
// Progressive render loop
// ---------------------------------------------------------------------------

const _prevView = new THREE.Matrix4();
const _prevProj = new THREE.Matrix4();
const convergenceEl = $("#convergence");

/**
 * OrbitControls damping shrinks the motion by a fixed factor per frame but
 * never reaches zero, so an exact matrix comparison reset the accumulation on
 * every frame after an orbit and the view stayed at one noisy sample. Treat
 * changes far below a pixel as no change (the total residual drift is
 * ~1e-4 u).
 */
const CAMERA_EPS = 1e-5;
function matricesDiffer(a, b) {
  for (let k = 0; k < 16; k++) {
    if (Math.abs(a.elements[k] - b.elements[k]) > CAMERA_EPS) return true;
  }
  return false;
}

function cameraChanged() {
  const changed =
    matricesDiffer(_prevView, activeCamera.matrixWorld) ||
    matricesDiffer(_prevProj, activeCamera.projectionMatrix);
  if (!changed) return false;
  _prevView.copy(activeCamera.matrixWorld);
  _prevProj.copy(activeCamera.projectionMatrix);
  return changed;
}

/**
 * Display exposure. Read mode keeps a FIXED exposure so brightness means
 * irradiance. Every other view meters like a camera: the log-average
 * luminance of the geometry is mapped to mid-grey. A fixed 0.75 left every
 * eye-level view 3-3.5 EV darker than photographs of the site (copper black,
 * shade crushed); review 2026-09-27.
 */
let autoExposure = 0.75;
let meterFrame = 0;
function exposure() {
  return state.view === "readable" ? 0.6 : autoExposure;
}
function updateAutoExposure() {
  if (state.view === "readable" || meterFrame++ % 6 !== 0) return;
  const m = accumulator.meter(currentLight.sky, currentLight.ground, currentLight.occluder);
  if (!m) return;
  // Aim the log-average luminance of the geometry at 0.2 (display linear,
  // sRGB ~124), but -- like a photographer -- never so bright that the
  // sunlit highlights (98th percentile) pass 0.8. In a mostly shaded view
  // this keeps the shade dark and the sun dashes bright, as in the
  // Highsmith photograph; in a sunlit view the log-average rule governs.
  const target = THREE.MathUtils.clamp(Math.min(0.2 / m.logAvg, 0.8 / m.p98), 0.2, 10);
  autoExposure = Math.exp(THREE.MathUtils.lerp(Math.log(autoExposure), Math.log(target), 0.4));
}

const _savedProj = new THREE.Matrix4();

/** Render one sample of a channel with sub-pixel camera jitter. */
function renderChannel(name, mode, index) {
  traceUniforms.uMode.value = mode;
  traceUniforms.uSunRotate.value = mode === 0 && index > SHARED_SUN_FRAMES;
  traceUniforms.uSeq.value.set(halton(index, 2), halton(index, 3));
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  _savedProj.copy(activeCamera.projectionMatrix);
  activeCamera.setViewOffset(w, h, halton(index, 5) - 0.5, halton(index, 7) - 0.5, w, h);
  if (mode !== 0) activeCamera.layers.disable(LAYER_GUIDES);
  accumulator.addSample(name, () => renderer.render(scene, activeCamera));
  activeCamera.layers.enable(LAYER_GUIDES);
  activeCamera.clearViewOffset();
  _prevProj.copy(activeCamera.projectionMatrix);
}

function directTarget() {
  return state.trueSun ? MAX_SAMPLES_TRUE_SUN : MAX_SAMPLES_POINT_SUN;
}

function isConverged() {
  return (
    casters !== null &&
    accumulator.samples("direct") >= directTarget() &&
    accumulator.samples("sky") >= MAX_SAMPLES_SKY &&
    accumulator.samples("albedo") >= MAX_SAMPLES_ALBEDO
  );
}

function animate() {
  if (controls.enabled) controls.update();
  activeCamera.updateMatrixWorld();
  if (cameraChanged()) accumulator.reset();

  modelRoot.updateMatrixWorld(true);
  traceUniforms.uWorldToModel.value.copy(modelRoot.matrixWorld).invert();

  if (!casters) {
    accumulator.present(currentLight.sky, currentLight.ground, exposure(), currentLight.occluder);
    convergenceEl.textContent = "loading";
    return;
  }

  const nD = accumulator.samples("direct");
  const nS = accumulator.samples("sky");
  const nA = accumulator.samples("albedo");
  const target = directTarget();
  if (nD < target) renderChannel("direct", 0, nD + 1);
  // Sky rays cost about twice a sun ray: while the sun is still converging,
  // trace sky on every other frame after the first few.
  if (nS < MAX_SAMPLES_SKY && (nD >= target || nS < 4 || nD % 2 === 0)) {
    renderChannel("sky", 1, nS + 1);
  }
  if (nA < MAX_SAMPLES_ALBEDO) renderChannel("albedo", 2, nA + 1);
  updateAutoExposure();
  accumulator.present(currentLight.sky, currentLight.ground, exposure(), currentLight.occluder);

  const d = Math.min(accumulator.samples("direct"), target);
  const label = state.trueSun ? "true sun" : "point sun";
  if (isConverged()) {
    convergenceEl.textContent = `${label} · converged ${d}`;
    convergenceEl.className = state.trueSun ? "convergence ok" : "convergence warn";
  } else {
    convergenceEl.textContent = `${label} · ${d}/${target}`;
    convergenceEl.className = state.trueSun ? "convergence" : "convergence warn";
  }
}

// ---------------------------------------------------------------------------
// Words on the ground (words.js): when and where the letter light reads
// ---------------------------------------------------------------------------

let finder = null;
let wordsResult = null;
let wordsTimer = 0;
const _yawInv = new THREE.Matrix4();

function sunLocal(az, el, out = new THREE.Vector3()) {
  sunVector(az, el, out);
  modelRoot.updateMatrixWorld(true);
  _yawInv.copy(modelRoot.matrixWorld).invert();
  return out.transformDirection(_yawInv);
}

function casterBVHs() {
  return { screen: casters.screen, platform: casters.platform, context: casters.context };
}

function setWordsEnabled(on) {
  $("#words-show").disabled = !on;
  $("#words-scan").disabled = !on;
}

let framed = null; // the run "Show me" framed: {text, mirrored}

function clearFraming() {
  framed = null;
  $("#words-chip").classList.add("hidden");
  setFlip(false);
}

async function initWords(url, token) {
  finder = null;
  wordsResult = null;
  setWordsEnabled(false);
  $("#words-times").innerHTML = "";
  clearFraming();
  if (url !== SCREEN_GLB.rebuilt && url !== SCREEN_GLB.demo) {
    $("#words-now").innerHTML =
      `<span class="muted">Word finding works on the rebuilt screen, which records where every letter is.</span>`;
    anchorShadow();
    return;
  }
  try {
    const layout = url === SCREEN_GLB.demo ? demoLayout
      : await fetch(asset("kryptos_screen_layout.json"), { cache: "no-cache" }).then(r => {
        if (!r.ok) throw new Error("Local screen layout unavailable");
        return r.json();
      });
    if (token !== loadToken) return;
    finder = new WordFinder(layout, currentModel.position);
    const sb = screenBox(); // plate extent (y is unchanged by yaw)
    finder.setPlateY(sb.min.y, sb.max.y);
    setWordsEnabled(true);
    updateWords();
    anchorShadow();
  } catch (err) {
    console.error(err);
    $("#words-now").innerHTML =
      `<span class="muted">Letter layout missing. Import the matching local layout with npm run assets:import.</span>`;
  }
}

function scheduleWords(delay = 250) {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(updateWords, delay);
}

function rowLabel(info) {
  if (state.screen === "demo") return `demo row ${info.row + 1}`;
  if (info.field === "ciphertext") return `ciphertext row ${info.row + 1}`;
  if (info.row === 0) return "tableau header";
  if (info.row === 27) return "tableau footer";
  return `tableau row ${String.fromCharCode(64 + info.row)}`;
}

function updateWords() {
  if (!finder || !casters || modelLoading) return;
  const L = sunLocal(state.azimuth, state.elevation);
  wordsResult = finder.evaluateVerified(L, receiverY, casterBVHs(), groundOpen);
  wordsResult.L = L;
  // A framed word that is no longer the sun's clearest (or no longer there)
  // must not keep its mirror flip and label.
  if (framed) {
    const top = wordsResult.runs[0];
    const info = top && finder.describe(top, L, modelRoot.matrixWorld);
    if (!info || info.text !== framed.text || info.mirrored !== framed.mirrored) clearFraming();
  }
  const el = $("#words-now");
  if (state.elevation <= 0) {
    el.innerHTML = `<p class="verdict v-bad">The sun is below the horizon.</p>`;
    $("#words-show").disabled = true;
    return;
  }
  if (!wordsResult.count) {
    el.innerHTML = `<p class="verdict v-warn">No readable words at this sun — ${finder.mainReason()}.
      Try <b>Find the best times</b>.</p>`;
    $("#words-show").disabled = true;
    return;
  }
  const info = finder.describe(wordsResult.runs[0], L, modelRoot.matrixWorld);
  el.innerHTML = `<p class="verdict v-ok"><b>${wordsResult.count}</b> letters land on the paving as
    readable words (${wordsResult.runs.length} runs). Clearest: <b>“${info.text}”</b>,
    ${rowLabel(info)}${info.mirrored ? ", mirror-image on the ground" : ""}.</p>`;
  $("#words-show").disabled = false;
}

function setFlip(on) {
  state.flip = on && state.view !== "perspective";
  renderer.domElement.style.transform = state.flip ? "scaleX(-1)" : "";
  $("#words-mirror").checked = state.flip;
  updateOrthoFrame();
}

/** Frame the clearest words from above, text upright (mirrored to read if needed). */
function showWords() {
  updateWords();
  if (!wordsResult?.runs.length) return;
  const info = finder.describe(wordsResult.runs[0], wordsResult.L, modelRoot.matrixWorld);
  if (state.view !== "top") setView("top");
  state.orthoUp = { x: info.up.x, z: info.up.z };
  state.center = { x: info.center.x, z: info.center.z };
  const aspect = viewport.clientWidth / Math.max(viewport.clientHeight, 1);
  state.window = THREE.MathUtils.clamp(Math.max(info.width * 1.5, info.depth * 6 * aspect, 22), 16, 200);
  setFlip(info.mirrored);
  framed = { text: info.text, mirrored: info.mirrored };
  updateOrthoFrame();
  accumulator.reset();
  anchorShadow(wordsResult.runs[0].idx);
  const chip = $("#words-chip");
  chip.textContent = `“${info.text}” · ${rowLabel(info)} · ${
    info.mirrored ? "the light is mirror-image here — view mirrored to read it" : "reads as it falls"
  }`;
  chip.classList.remove("hidden");
}

function timeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function scanWordTimes() {
  if (!finder) return;
  const btn = $("#words-scan");
  btn.disabled = true;
  const year = Number(state.date.slice(0, 4)) || 2025;
  const f = finder;
  const tok = loadToken;
  const yaw = state.yaw;
  const stale = () => finder !== f || tok !== loadToken || state.yaw !== yaw;
  const times = await finder.scanYear({
    year,
    latitude: state.latitude,
    longitude: state.longitude,
    standardOffset: SITE.standardOffset,
    toLocal: (az, el, out) => sunLocal(az, el, out),
    groundY: receiverY,
    bvhs: casterBVHs(),
    groundOpen,
    cancelled: stale,
    onProgress: (p) => (btn.textContent = `Scanning the year… ${Math.round(p * 100)}%`),
  });
  btn.textContent = "Find the best times this year";
  if (!times || stale()) {
    btn.disabled = !finder; // the model or yaw changed mid-scan: discard
    return;
  }
  btn.disabled = false;
  const list = $("#words-times");
  list.innerHTML = times.length
    ? ""
    : `<span class="muted">No time in ${year} gives readable words at this model yaw.</span>`;
  for (const c of times) {
    const b = document.createElement("button");
    b.className = "preset words-time";
    b.innerHTML = `<b>${c.d} ${MONTHS[c.m - 1]} · ${timeLabel(c.minutes)}</b>
      <span>${c.count} letters · sun ${c.el.toFixed(0)}° · “${c.best}”</span>`;
    b.addEventListener("click", () => {
      state.date = `${year}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
      state.time = `${String(Math.floor(c.minutes / 60)).padStart(2, "0")}:${String(c.minutes % 60).padStart(2, "0")}`;
      state.dst = c.dst;
      $("#date").value = state.date;
      $("#time").value = state.time;
      $("#dst").checked = state.dst;
      setActivePreset();
      setSunMode("ephemeris");
      showWords();
    });
    list.appendChild(b);
  }
  updateWords(); // the scan left the finder on its last candidate
}

$("#words-show").addEventListener("click", showWords);
$("#words-scan").addEventListener("click", scanWordTimes);
$("#words-mirror").addEventListener("change", (e) => setFlip(e.target.checked));

// ---------------------------------------------------------------------------
// Scripting API (tools/verify_*.mjs drive the lab through this)
// ---------------------------------------------------------------------------

window.sunLab = {
  state,
  ready: () => casters !== null && !modelLoading,
  converged: () => !modelLoading && isConverged(),
  exposure: () => exposure(),
  samples: () => accumulator.samples("direct"),
  camera: () => ({ position: activeCamera.position.toArray(), target: controls.target.toArray(),
    anchor: shadowTrack?.projected?.toArray() ?? null }),
  /** Independent CPU visibility versus the GPU's un-tonemapped direct pass. */
  verifyShadow: () => {
    if (state.view !== "readable" || state.trueSun || !isConverged() || modelLoading) {
      return { pass: false, reason: "Use converged Read shadows with True solar disc off." };
    }
    return verifyShadow({
      camera: orthoCamera, sunDir, dni: currentLight.dni, receiverY,
      probe: (x, z) => probe(x, z, sunDir, true),
      readDirect: () => {
        const ch = accumulator.channels.direct;
        const rt = ch.targets[ch.read];
        const data = new Float32Array(rt.width * rt.height * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, data);
        return { width: rt.width, height: rt.height, data };
      },
    });
  },
  /** gltf-scene offset applied on load: lab world = gltf + offset (yaw 0). */
  modelOffset: () => currentModel?.position.toArray(),
  receiverY: () => receiverY,
  set(opts) {
    if ("azimuth" in opts || "elevation" in opts) {
      state.sunMode = "manual";
      $("#sunmode-manual").click();
    }
    // Scripted captures specify their own frame; opt in to tracking only
    // when explicitly requested, so a previous interactive anchor cannot
    // move a verification window.
    state.followShadow = opts.followShadow ?? false;
    $("#follow-shadow").checked = state.followShadow;
    if (!state.followShadow) shadowTrack = null;
    for (const k of ["azimuth", "elevation", "trueSun", "skyFill", "bounce", "isolate", "window", "yaw"]) {
      if (k in opts) state[k] = opts[k];
    }
    if ("yaw" in opts) modelRoot.rotation.y = THREE.MathUtils.degToRad(state.yaw);
    $("#model-yaw").value = state.yaw;
    $("#yaw-number").value = state.yaw.toFixed(2);
    $("#true-sun").checked = state.trueSun;
    $("#isolate-screen").checked = state.isolate;
    $("#sky-fill").value = state.skyFill;
    $("#sky-fill-readout").textContent = `${Math.round(state.skyFill * 100)}%`;
    if ("skyOcclusion" in opts) traceUniforms.uSkyOcclusion.value = opts.skyOcclusion;
    if ("center" in opts) state.center = opts.center;
    if (opts.view && opts.view !== state.view) {
      const keep = state.center;
      setView(opts.view); // resets orientation, mirror and framing
      if ("center" in opts) state.center = opts.center ?? keep;
      if ("window" in opts) state.window = opts.window;
    }
    applyView();
    if (opts.camera) {
      perspectiveCamera.position.fromArray(opts.camera.position);
      controls.target.fromArray(opts.camera.target);
      controls.update();
    }
    if (state.followShadow) anchorShadow();
  },
  readLinear: () => accumulator.readLinear(currentLight.sky, currentLight.ground, currentLight.occluder),
  probe: (x, z) => probe(x, z, sunDir),
  words: () => {
    updateWords();
    if (!wordsResult) return null;
    const runs = wordsResult.runs.map((r) => {
      const info = finder.describe(r, wordsResult.L, modelRoot.matrixWorld);
      return { text: info.text, field: info.field, row: info.row, mirrored: info.mirrored,
        center: [info.center.x, info.center.z], len: r.len, quality: r.quality };
    });
    return { count: wordsResult.count, runs, reason: wordsResult.count ? null : finder.mainReason() };
  },
  showWords: () => showWords(),
  scanWords: () => scanWordTimes(),
};

for (const option of $("#screen-select").options) {
  option.disabled = !availableScreens.has(option.value);
}
$("#screen-select").value = state.screen;
$("#show-photo").disabled = !localAssets.referencePhoto;
if (localAssets.referencePhoto) $("#photo-inset img").src = asset("reference/highsmith_kryptos_loc2011631531.jpg");
if (state.screen === "demo") {
  perspectiveCamera.position.fromArray(CAMERA_PRESETS.demo.position);
  controls.target.fromArray(CAMERA_PRESETS.demo.target);
  controls.update();
}
resize();
setSunMode(state.sunMode);
loadModel(SCREEN_GLB[state.screen]);
renderer.setAnimationLoop(animate);
if (query.has("verify")) {
  import("../tools/browser-validation.js").then(({ installValidation }) => installValidation(window.sunLab));
}
