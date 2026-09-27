import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BVHShaderGLSL,
  CENTER,
  SAH,
  MeshBVH,
  MeshBVHUniformStruct,
} from "three-mesh-bvh";

/**
 * Exact sun visibility by GPU ray tracing.
 * ----------------------------------------
 * Every earlier build used a shadow map. A shadow map samples the occluder on
 * a texel grid and compares depths, so a 0.2 u thin plate with 0.3 u letter
 * strokes turns into acne, light leaks and stripes, and the result depends on
 * how the shadow frustum is fitted. None of that is optics.
 *
 * Here every shaded pixel casts a real ray toward the sun and tests it against
 * a BVH built from the actual triangles. There is no resolution limit on the
 * occluder, no depth bias and no frustum. The 0.53 deg solar disc is sampled
 * one direction per frame (Halton, per-pixel Cranley-Patterson rotation) and
 * the progressive accumulator averages the frames, which converges to the
 * exact penumbra. Sky light is a separate pass (uMode 1): one cosine-weighted
 * occlusion ray per frame, accumulated in its own channel (accumulator.js).
 *
 * Two BVHs: the copper screen, and the context (platform, rocks, tree). The
 * context can be switched off as a caster without touching the screen.
 * Both are built in modelRoot-local space; the shader moves rays into that
 * space, so a model-yaw change does not rebuild anything.
 */

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;

#define BVH_STACK_DEPTH 64
// The library default (1e-5 barycentric) expands long plate triangles enough
// to close narrow light paths. Keep an approximately float-precision edge
// allowance: a 100-unit edge grows by 0.00001 units, not 0.001.
#define TRI_INTERSECT_EPSILON 1e-7
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}

uniform BVH bvhCopper;
uniform BVH bvhContext;
uniform bool uContextCasts;
uniform mat4 uWorldToModel;

uniform vec3 uSunDir;          // unit vector to the sun centre
uniform float uSunTanRadius;   // tan(angular radius); 0 = point sun
uniform vec2 uSeq;             // this frame's low-discrepancy pair
uniform vec3 uSunIrr;          // direct normal irradiance (linear RGB)
uniform bool uSkyOcclusion;
uniform int uMode;             // 0 direct sun, 1 sky visibility, 2 albedo

uniform vec3 uAlbedo;
uniform float uTexture;        // 0 = flat albedo, >0 = procedural variation
uniform int uKind;             // 0 plain, 1 courtyard (paving, lawn beyond), 2 patinated copper, 3 granite paving + pool
uniform float uWaterY;         // world height below which kind 3 is pool water
uniform bool uSunRotate;       // per-pixel rotation of the sun-disc sample
uniform bool uMaskOn;          // courtyard plane: cut away over the pool basin
uniform sampler2D uMask;
uniform vec2 uMaskMin;
uniform vec2 uMaskSize;
uniform float uSpecular;       // 0 = pure Lambert
uniform float uShininess;
uniform bool uIsOrtho;
uniform vec3 uViewDir;         // ortho camera forward

varying vec3 vWorldPos;

const float PI = 3.141592653589793;

// Shadow ray: stop at the first hit. Same traversal as three-mesh-bvh's
// first-hit query, minus the closest-hit bookkeeping.
bool anyHit(
  sampler2D bvh_position, usampler2D bvh_index,
  sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,
  vec3 ro, vec3 rd
) {
  int pointer = 0;
  uint stack[BVH_STACK_DEPTH];
  stack[0] = 0u;
  vec3 bary, nrm;
  float dist, side;
  while (pointer > -1 && pointer < BVH_STACK_DEPTH) {
    uint node = stack[pointer];
    pointer--;
    float boundsDist;
    if (!intersectsBVHNodeBounds(ro, rd, bvh_bvhBounds, node, boundsDist)) continue;
    uvec2 info = uTexelFetch1D(bvh_bvhContents, node).xy;
    if (bool(info.x & 0xffff0000u)) {
      uint count = info.x & 0x0000ffffu;
      uint offset = info.y;
      for (uint i = offset, l = offset + count; i < l; i++) {
        uvec3 f = uTexelFetch1D(bvh_index, i).xyz;
        vec3 a = texelFetch1D(bvh_position, f.x).rgb;
        vec3 b = texelFetch1D(bvh_position, f.y).rgb;
        vec3 c = texelFetch1D(bvh_position, f.z).rgb;
        if (intersectsTriangle(ro, rd, a, b, c, bary, nrm, dist, side) && dist > 0.0) {
          return true;
        }
      }
    } else {
      uint axis = info.x & 0x0000ffffu;
      uint left = node + 1u;
      uint right = node + info.y;
      bool ltr = rd[axis] >= 0.0;
      pointer++;
      stack[pointer] = ltr ? right : left;
      pointer++;
      stack[pointer] = ltr ? left : right;
    }
  }
  return false;
}

#define ANY_HIT(bvh, ro, rd) anyHit(bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents, ro, rd)

bool occluded(vec3 worldOrigin, vec3 worldDir) {
  vec3 ro = (uWorldToModel * vec4(worldOrigin, 1.0)).xyz;
  vec3 rd = normalize((uWorldToModel * vec4(worldDir, 0.0)).xyz);
  if (ANY_HIT(bvhCopper, ro, rd)) return true;
  if (uContextCasts && ANY_HIT(bvhContext, ro, rd)) return true;
  return false;
}

// Integer hash -> [0,1)^2, per pixel. Rotates the shared sequence so pixels
// decorrelate (Cranley-Patterson) while each still converges to the exact mean.
vec2 pixelRotation(vec2 p) {
  uvec2 q = uvec2(ivec2(p));
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  uint h2 = h * 1103515245u + 12345u;
  return vec2(float(h >> 8u), float(h2 >> 8u)) / 16777216.0;
}

void basis(vec3 n, out vec3 t1, out vec3 t2) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float b = n.x * n.y * a;
  t1 = vec3(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  t2 = vec3(b, s + n.y * n.y * a, -n.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // Geometric (flat) normal from screen derivatives, turned toward the viewer.
  // Robust on the thin plate, where interpolated normals can point wrongly.
  vec3 ng = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 toEye = uIsOrtho ? -uViewDir : normalize(cameraPosition - vWorldPos);
  if (dot(ng, toEye) < 0.0) ng = -ng;

  // Offset scaled to the coordinate magnitude so float precision never lets
  // a ray start inside the surface it leaves.
  float eps = 2e-3 + 2e-5 * length(vWorldPos);
  vec3 origin = vWorldPos + ng * eps;

  // Textures live in MODEL space, projected along the dominant axis of the
  // surface normal, so they stick to the geometry under model yaw and do not
  // smear into streaks on vertical faces.
  vec3 pm = (uWorldToModel * vec4(vWorldPos, 1.0)).xyz;
  // The courtyard plane sits at paving level; over the pool basin (which is
  // below it) it must not exist, or it would pave over the water.
  if (uMaskOn) {
    vec2 mq = (pm.xz - uMaskMin) / uMaskSize;
    if (all(greaterThan(mq, vec2(0.0))) && all(lessThan(mq, vec2(1.0))) && texture2D(uMask, mq).r > 0.5) discard;
  }
  vec3 nm = normalize(mat3(uWorldToModel) * ng);
  vec3 an = abs(nm);
  vec2 tp = an.y >= max(an.x, an.z) ? pm.xz : (an.x >= an.z ? pm.zy : pm.xy);
  // Pool water: up-facing platform surfaces below the waterline only (the
  // plinth's outer walls are also below it but are stone).
  bool water = uKind == 3 && vWorldPos.y < uWaterY && ng.y > 0.7;

  vec3 albedo = uAlbedo;
  // Salt-and-pepper granite (dark, pale, pink grains; low contrast: at
  // viewing distance high-contrast grains read as sensor noise). Shared by the
  // platform and the courtyard around it, so the paving reads as one surface
  // and the printable model's island outline does not show.
  vec2 gp = uKind == 1 ? vWorldPos.xz : tp;
  float grain = valueNoise(gp * 9.0);
  float grain2 = valueNoise(gp * 23.0 + 3.1);
  float grain3 = valueNoise(gp * 17.0 + 7.7);
  float mottle = valueNoise(gp * 0.25);
  vec3 granite = vec3(0.33, 0.33, 0.34) * (0.97 + 0.06 * mottle); // flamed granite is even
  granite = mix(granite, vec3(0.16, 0.16, 0.17), smoothstep(0.62, 0.85, grain) * 0.45);
  granite = mix(granite, vec3(0.46, 0.45, 0.44), smoothstep(0.7, 0.9, grain2) * 0.35);
  granite = mix(granite, vec3(0.42, 0.33, 0.34), smoothstep(0.75, 0.92, grain3) * 0.3);

  if (uKind == 1) {
    // Courtyard at paving level: the same granite out to ~12 m (photos:
    // paving flush around the sculpture), lawn beyond.
    vec2 p = vWorldPos.xz;
    float r = length(p) + (valueNoise(p * 0.01) - 0.5) * 60.0;
    float n1 = valueNoise(p * 0.35);
    float n2 = valueNoise(p * 2.7);
    vec3 lawn = mix(vec3(0.075, 0.15, 0.045), vec3(0.13, 0.19, 0.07), n1 * 0.7 + n2 * 0.3);
    albedo = mix(granite, lawn, smoothstep(380.0, 420.0, r));
  } else if (uKind == 2) {
    // Copper as photographed on the sculpture (Highsmith, Gillogly): dark,
    // matte blue-green verdigris, irregular paler runs from the top edge.
    vec2 q = tp + 3.0 * vec2(valueNoise(tp * 0.07), valueNoise(tp * 0.07 + 5.0));
    float run = valueNoise(vec2(q.x * 0.45, q.y * 0.03));
    float topw = smoothstep(40.0, 140.0, pm.y); // runs start at the top edge
    float blot = valueNoise(q * 0.35);
    float fine = valueNoise(q * 4.0);
    vec3 dark = mix(vec3(0.03, 0.05, 0.055), vec3(0.055, 0.085, 0.09), fine);
    float g = smoothstep(0.45, 0.95, run * (0.55 + 0.45 * topw) + blot * 0.35);
    albedo = mix(dark, vec3(0.13, 0.2, 0.21), g * 0.8);
  } else if (uKind == 3) {
    albedo = water ? vec3(0.035, 0.05, 0.055) : granite; // pool water is dark
  } else if (uTexture > 0.0) {
    float n = valueNoise(tp * 0.08) * 0.6 + valueNoise(tp * 0.5) * 0.4;
    albedo *= 1.0 + uTexture * (n - 0.5);
  }
  vec3 lambert = albedo / PI;

  if (uMode == 2) {
    // Alpha carries view distance: the display pass uses albedo + depth to
    // guide its early-frame sky denoiser.
    float depth = uIsOrtho ? dot(vWorldPos - cameraPosition, uViewDir) : length(cameraPosition - vWorldPos);
    gl_FragColor = vec4(lambert, depth);
    return;
  }

  // Sky rays: per-pixel rotated sequence (noise, filtered early at display).
  // Sun rays: for the first frames ONE shared disc direction for every pixel,
  // so the image starts as a clean hard shadow and the penumbra builds up
  // without grain; after that per-pixel rotation, so wide penumbrae do not
  // keep the stepped "ghost copies" of a shared point set. Both converge to
  // the same disc average.
  vec2 u = (uMode == 1 || uSunRotate) ? fract(uSeq + pixelRotation(gl_FragCoord.xy)) : uSeq;

  if (uMode == 1) {
    // Diffuse sky: one cosine-weighted direction about the normal. The
    // cosine-weighted mean of [ray escapes to the sky] times E_sky is the
    // irradiance from a uniform dome; the display pass applies E_sky and
    // gives the blocked fraction the ground-bounce irradiance instead.
    vec3 b1, b2;
    basis(ng, b1, b2);
    float sr = sqrt(u.x);
    float sp = 2.0 * PI * u.y;
    vec3 S = normalize(sr * cos(sp) * b1 + sr * sin(sp) * b2 + sqrt(max(0.0, 1.0 - u.x)) * ng);
    bool below = S.y <= 0.0;
    bool sky = !below && !(uSkyOcclusion && occluded(origin, S));
    // alpha: this direction looks below the horizon (sees the courtyard);
    // the display pass lights it with the ground bounce. Directions blocked
    // above the horizon see an occluder and get the dimmer occluder term.
    gl_FragColor = vec4(sky ? lambert : vec3(0.0), below ? 1.0 : 0.0);
    return;
  }

  // Direct sun: one direction uniformly inside the solar disc.
  vec3 t1, t2;
  basis(uSunDir, t1, t2);
  float r = sqrt(u.x) * uSunTanRadius;
  float phi = 2.0 * PI * u.y;
  vec3 L = normalize(uSunDir + r * (cos(phi) * t1 + sin(phi) * t2));

  float cosI = dot(ng, L);
  vec3 radiance = vec3(0.0);
  float spec = uSpecular;
  float shin = uShininess;
  vec3 ns = ng; // shading normal
  if (water) {
    // Water: the printable model's basin is a faceted whirlpool mesh; shade
    // it as a level surface so each facet does not glint on its own.
    ns = vec3(0.0, 1.0, 0.0);
    cosI = L.y;
    spec = 0.35;
    shin = 250.0;
  }
  if (cosI > 0.0 && L.y > 0.0 && !occluded(origin, L)) {
    vec3 direct = uSunIrr * cosI;
    radiance = lambert * direct;
    if (spec > 0.0) {
      vec3 h = normalize(L + toEye);
      float nh = max(dot(ns, h), 0.0);
      radiance += direct * spec * (shin + 8.0) / (8.0 * PI) * pow(nh, shin);
    }
  }
  gl_FragColor = vec4(radiance, 1.0);
}
`;

/** Shared uniforms: every traced material references the same objects. */
export function createTraceUniforms() {
  return {
    bvhCopper: { value: new MeshBVHUniformStruct() },
    bvhContext: { value: new MeshBVHUniformStruct() },
    uContextCasts: { value: true },
    uWorldToModel: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunTanRadius: { value: 0 },
    uSeq: { value: new THREE.Vector2() },
    uSunIrr: { value: new THREE.Color(1, 1, 1) },
    uSkyOcclusion: { value: true },
    uMode: { value: 0 },
    uWaterY: { value: 11.0 },
    uSunRotate: { value: false },
    // pool mask, shared by the courtyard materials (set by the lab on load)
    uMask: { value: null },
    uMaskMin: { value: new THREE.Vector2() },
    uMaskSize: { value: new THREE.Vector2(1, 1) },
    uIsOrtho: { value: false },
    uViewDir: { value: new THREE.Vector3(0, -1, 0) },
  };
}

/**
 * @param {object} shared uniforms from createTraceUniforms()
 * @param {{albedo:THREE.Color, texture?:number, specular?:number, shininess?:number}} surface
 */
export function createTracedMaterial(shared, surface) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    uniforms: {
      ...shared,
      uAlbedo: { value: surface.albedo.clone() },
      uTexture: { value: surface.texture ?? 0 },
      uKind: { value: surface.kind ?? 0 },
      uMaskOn: { value: false },
      uSpecular: { value: surface.specular ?? 0 },
      uShininess: { value: surface.shininess ?? 32 },
    },
  });
}

/**
 * Merge meshes into one position-only indexed geometry in `root`-local space.
 * Returns null when there is nothing to merge.
 */
function mergeInRootSpace(meshes, root) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const parts = [];
  for (const mesh of meshes) {
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", src.attributes.position.clone());
    if (src.index) {
      g.setIndex(src.index.clone());
    } else {
      const n = src.attributes.position.count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld));
    parts.push(g);
  }
  if (!parts.length) return null;
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  for (const p of parts) if (p !== merged) p.dispose();
  return merged;
}

/** A single triangle far below the scene: stands in for an empty caster set. */
function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, -1e5, 0, 1, -1e5, 0, 0, -1e5, 1]), 3),
  );
  g.setIndex([0, 1, 2]);
  return g;
}

const _q = new URLSearchParams(globalThis.location?.search ?? "");
const bvhOptions = {
  strategy: _q.get("bvh") === "center" ? CENTER : SAH,
  targetLeafSize: Number(_q.get("leaf") ?? 8),
};

/**
 * Build the GPU BVHs and upload them into the shared uniforms:
 *   bvhCopper  = screen + platform (always cast)
 *   bvhContext = tree + rocks      (optional casters)
 * Also returns CPU BVHs of the screen, the platform and the context for probe
 * rays.
 * They must be separate: MeshBVH reorders triangles when it builds, so a
 * face index in a merged BVH cannot tell which part was hit.
 */
export function buildCasterBVHs(shared, parts, root) {
  const t0 = performance.now();
  const fixedGeom = mergeInRootSpace([...parts.copper, ...parts.platform], root) ?? emptyGeometry();
  const contextGeom = mergeInRootSpace(parts.context, root) ?? emptyGeometry();
  const fixed = new MeshBVH(fixedGeom, bvhOptions);
  const context = new MeshBVH(contextGeom, bvhOptions);
  shared.bvhCopper.value.updateFrom(fixed);
  shared.bvhContext.value.updateFrom(context);
  const screen = new MeshBVH(mergeInRootSpace(parts.copper, root) ?? emptyGeometry(), bvhOptions);
  const platform = new MeshBVH(mergeInRootSpace(parts.platform, root) ?? emptyGeometry(), bvhOptions);
  return {
    screen,
    platform,
    context, // tree + rocks (CPU copy, for probe rays)
    triangles: {
      fixed: fixedGeom.index.count / 3,
      context: contextGeom.index.count / 3,
    },
    buildMs: performance.now() - t0,
  };
}
