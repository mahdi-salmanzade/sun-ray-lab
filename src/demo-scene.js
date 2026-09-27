import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * An original, procedurally authored teaching scene. No downloaded meshes,
 * sculpture measurements, photographs, or font files are used here.
 *
 * A 1 is an aperture, not an ink pixel. Adjacent cells are joined into one
 * outline before extrusion, so there are no copper seams inside a stroke.
 * These deliberately simple stencils have no detached enclosed counters.
 */
export const DEMO_STENCILS = Object.freeze({
  S: ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "11111"],
  N: ["10001", "11001", "11101", "10111", "10011", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  G: ["11111", "10000", "10000", "10111", "10001", "10001", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
});

export const DEMO_DIMENSIONS = Object.freeze({
  width: 190,
  height: 100,
  bottom: 15.5,
  thickness: 0.216,
  cap: 3.09,
  rows: 20,
  rowPitch: 4.3,
  columnPitch: 3.45,
  groundTop: 14.1,
});

/** Trace the exterior edges of a union of square aperture cells. */
function stencilContours(rows) {
  const edges = new Map();
  const key = (x, y) => `${x},${y}`;
  const has = (x, y) => rows[6 - y]?.[x] === "1";
  const add = (x0, y0, x1, y1) => edges.set(key(x0, y0), [x1, y1]);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      if (!has(x, y)) continue;
      if (!has(x, y - 1)) add(x, y, x + 1, y);
      if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!has(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const contours = [];
  while (edges.size) {
    const start = edges.keys().next().value;
    let current = start;
    const points = [];
    do {
      points.push(current.split(",").map(Number));
      const next = edges.get(current);
      if (!next) throw new Error("The demo stencil has an open contour.");
      edges.delete(current);
      current = key(...next);
    } while (current !== start);
    // Collinear grid vertices are unnecessary for a straight stroke edge.
    contours.push(points.filter((p, i) => {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[(i + 1) % points.length];
      return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
    }));
  }
  return contours;
}

function makeCurve() {
  const s = [0];
  const xy = [];
  for (let i = 0; i <= 512; i++) {
    const x = -DEMO_DIMENSIONS.width / 2 + DEMO_DIMENSIONS.width * i / 512;
    // This sine profile is an independent design, not a sculpture tracing.
    const z = 18 * Math.sin(x / 50);
    xy.push([x, -z]); // WordFinder's Blender-coordinate convention.
    if (i) s.push(s[i - 1] + Math.hypot(x - xy[i - 1][0], -z - xy[i - 1][1]));
  }
  return { s, xy };
}

/** Map unrolled arc length to the same piecewise curve used by WordFinder. */
function curveAt(curve, arc) {
  let lo = 0;
  let hi = curve.s.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (curve.s[mid] <= arc) lo = mid;
    else hi = mid;
  }
  const a = curve.xy[lo];
  const b = curve.xy[hi];
  const length = curve.s[hi] - curve.s[lo];
  const f = (arc - curve.s[lo]) / length;
  return {
    x: a[0] + (b[0] - a[0]) * f,
    z: -a[1] - (b[1] - a[1]) * f,
    tx: (b[0] - a[0]) / length,
    tz: -(b[1] - a[1]) / length,
  };
}

function bendGeometry(geometry, curve) {
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const p = curveAt(curve, position.getX(i));
    const depth = position.getZ(i) - DEMO_DIMENSIONS.thickness / 2;
    position.setXYZ(i, p.x - p.tz * depth, position.getY(i), p.z + p.tx * depth);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a curved copper teaching screen with genuine, finite-depth apertures.
 * The layout describes this generated geometry and is directly consumable by
 * WordFinder. Dimensions use the lab's arbitrary model units.
 */
export function createDemoScene() {
  const D = DEMO_DIMENSIONS;
  const curve = makeCurve();
  const length = curve.s.at(-1);
  const line = "SUNLIGHT ".repeat(6).trim();
  const margin = (length - line.length * D.columnPitch) / 2;
  const cell = D.cap / 7;
  const glyphWidth = cell * 5;
  const textHeight = (D.rows - 1) * D.rowPitch + D.cap;
  const textBottom = D.bottom + (D.height - textHeight) / 2;
  const contours = Object.fromEntries(Object.entries(DEMO_STENCILS).map(([c, bitmap]) => [c, stencilContours(bitmap)]));
  const glyphs = [];
  const strips = [];

  // Narrow strips keep triangulated faces close to the intended curve. Their
  // shared edges meet exactly; each aperture remains wholly inside one strip.
  const boundaries = [0, margin];
  for (let i = 1; i <= line.length; i++) boundaries.push(margin + i * D.columnPitch);
  boundaries.push(length);
  for (let strip = 0; strip < boundaries.length - 1; strip++) {
    const left = boundaries[strip];
    const right = boundaries[strip + 1];
    const column = strip - 1;
    const c = line[column];
    const shape = new THREE.Shape([
      new THREE.Vector2(left, D.bottom),
      new THREE.Vector2(right, D.bottom),
      new THREE.Vector2(right, D.bottom + D.height),
      new THREE.Vector2(left, D.bottom + D.height),
    ]);
    if (contours[c]) {
      const s0 = left + (D.columnPitch - glyphWidth) / 2;
      for (let row = 0; row < D.rows; row++) {
        const z0 = textBottom + (D.rows - 1 - row) * D.rowPitch;
        glyphs.push({ s0, s1: s0 + glyphWidth, z0, z1: z0 + D.cap, c, field: "ciphertext", row, i: column, dir: 1 });
        for (const points of contours[c]) {
          shape.holes.push(new THREE.Path(points.map(([x, y]) => new THREE.Vector2(s0 + x * cell, z0 + y * cell))));
        }
      }
    }
    strips.push(bendGeometry(new THREE.ExtrudeGeometry(shape, {
      depth: D.thickness,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    }), curve));
  }

  const scene = new THREE.Group();
  scene.name = "OriginalSunlightDemo";
  const geometry = mergeGeometries(strips, false);
  for (const strip of strips) strip.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const copper = new THREE.MeshStandardMaterial({ color: 0x6b9a81, roughness: 0.84, metalness: 0.36, side: THREE.DoubleSide });
  const sheet = new THREE.Mesh(geometry, copper);
  sheet.name = "CopperSheet";
  sheet.castShadow = true;
  sheet.receiveShadow = true;
  scene.add(sheet);

  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(320, D.groundTop, 260),
    new THREE.MeshStandardMaterial({ color: 0xb1b4ac, roughness: 0.96 }),
  );
  platform.name = "Platform";
  platform.position.y = D.groundTop / 2;
  platform.receiveShadow = true;
  scene.add(platform);

  // Two independently authored, simple supports, outside the letter field.
  for (const arc of [2.3, length - 2.3]) {
    const p = curveAt(curve, arc);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, D.height + 2, 12), copper);
    post.name = "CopperPosts";
    post.position.set(p.x, D.bottom + D.height / 2 - 1, p.z);
    post.castShadow = true;
    scene.add(post);
  }
  scene.updateMatrixWorld(true);

  glyphs.sort((a, b) => a.row - b.row || a.i - b.i);
  return {
    scene,
    layout: {
      description: "Original Sun-Ray Lab SUNLIGHT stencil demonstration; procedurally generated, not a reconstruction of Kryptos.",
      curve,
      cap: D.cap,
      thickness: D.thickness,
      z_bottom: D.bottom,
      height: D.height,
      glyphs,
    },
  };
}
