import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { createDemoScene, DEMO_DIMENSIONS, DEMO_STENCILS } from "../src/demo-scene.js";
import { WordFinder, sunVector } from "../src/words.js";
import { projectToGround } from "../src/shadow-geometry.js";

const { scene, layout } = createDemoScene();
const sheet = scene.getObjectByName("CopperSheet");
const bvh = new MeshBVH(sheet.geometry);

function at(arc, y) {
  const cs = layout.curve.s;
  const xy = layout.curve.xy;
  const hi = cs.findIndex((s) => s > arc);
  const lo = Math.max(0, hi - 1);
  const f = (arc - cs[lo]) / (cs[lo + 1] - cs[lo]);
  const x = xy[lo][0] + f * (xy[lo + 1][0] - xy[lo][0]);
  const z = -(xy[lo][1] + f * (xy[lo + 1][1] - xy[lo][1]));
  const normal = new THREE.Vector3(xy[lo + 1][1] - xy[lo][1], 0, xy[lo + 1][0] - xy[lo][0]).normalize();
  return { point: new THREE.Vector3(x, y, z), normal };
}

function normalHit(arc, y) {
  const { point, normal } = at(arc, y);
  const ray = new THREE.Ray(point.clone().addScaledVector(normal, 2), normal.negate());
  return bvh.raycastFirst(ray, THREE.DoubleSide, 0, 4);
}

test("the original demo contains finite real geometry and normalized normals", () => {
  assert.ok(scene.isGroup);
  assert.equal(layout.glyphs.length, 960);
  assert.ok(sheet.geometry.getAttribute("position").count > 10000);
  for (const name of ["position", "normal"]) {
    const attribute = sheet.geometry.getAttribute(name);
    for (const value of attribute.array) assert.ok(Number.isFinite(value));
    if (name === "normal") {
      const v = new THREE.Vector3();
      for (let i = 0; i < attribute.count; i++) {
        v.fromBufferAttribute(attribute, i);
        assert.ok(Math.abs(v.length() - 1) < 1e-5);
      }
    }
  }
  const platform = scene.getObjectByName("Platform");
  const bounds = new THREE.Box3().setFromObject(platform);
  assert.ok(Math.abs(bounds.max.y - DEMO_DIMENSIONS.groundTop) < 1e-5);
  assert.ok(Math.abs(new THREE.Box3().setFromObject(scene).min.y) < 1e-5, "the full scene is grounded at zero before the loader normalizes it");
  assert.equal(sheet.material.transparent, false);
  assert.equal(sheet.material.alphaMap, null);
});

test("every stencil cell matches the actual curved mesh's transmission", () => {
  const cell = layout.cap / 7;
  let apertures = 0;
  let opaqueCells = 0;
  for (const glyph of layout.glyphs) {
    const bitmap = DEMO_STENCILS[glyph.c];
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        const hit = normalHit(glyph.s0 + (column + 0.5) * cell, glyph.z1 - (row + 0.5) * cell);
        if (bitmap[row][column] === "1") {
          assert.equal(hit, null, `${glyph.c} row ${glyph.row}, cell ${column},${row} must transmit`);
          apertures++;
        } else {
          assert.ok(hit, `${glyph.c} row ${glyph.row}, cell ${column},${row} must block`);
          opaqueCells++;
        }
      }
    }
    assert.ok(normalHit(glyph.s0 - 0.2, (glyph.z0 + glyph.z1) / 2), "the copper between letters blocks light");
  }
  assert.ok(apertures > 15000);
  assert.ok(opaqueCells > 10000);
});

test("WordFinder's letter positions coincide with the generated curve and height", () => {
  const finder = new WordFinder(layout, new THREE.Vector3());
  for (let i = 0; i < finder.n; i++) {
    const glyph = layout.glyphs[i];
    const expected = at((glyph.s0 + glyph.s1) / 2, (glyph.z0 + glyph.z1) / 2).point;
    const actual = new THREE.Vector3(finder.px[i], finder.py[i], finder.pz[i]);
    assert.ok(actual.distanceTo(expected) < 1e-5);
  }
});

test("sun rays pass through finite-depth apertures and form light on the receiver", () => {
  const sun = sunVector(218, 33);
  const candidates = layout.glyphs.filter((g) => g.c === "I" && g.row === 19);
  for (const glyph of candidates) {
    const aperture = at((glyph.s0 + glyph.s1) / 2, (glyph.z0 + glyph.z1) / 2).point;
    const ground = projectToGround(aperture, sun, DEMO_DIMENSIONS.groundTop);
    const ray = new THREE.Ray(ground.clone().addScaledVector(sun, 0.001), sun);
    assert.equal(bvh.raycastFirst(ray, THREE.DoubleSide), null, "the I stem transmits sunlight to the paving");
    const copper = at(glyph.s0 - 0.25, (glyph.z0 + glyph.z1) / 2).point;
    const darkGround = projectToGround(copper, sun, DEMO_DIMENSIONS.groundTop);
    assert.ok(bvh.raycastFirst(new THREE.Ray(darkGround, sun), THREE.DoubleSide), "neighboring copper casts a shadow");
  }
  assert.equal(candidates.length, 6);
});
