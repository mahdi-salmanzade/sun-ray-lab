import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { followShadowCenter, projectToGround, resolveReceiver } from "../src/shadow-geometry.js";

function assertVector(actual, expected, tolerance = 1e-9) {
  assert.ok(actual, "expected a finite point");
  assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} != ${expected.toArray()}`);
}

function boxBVH({ x = 0, y = 0, z = 0, width = 20, height = 2, depth = 20 } = {}) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return new MeshBVH(geometry);
}

function downwardRay(x = 0, z = 0, y = 100) {
  return new THREE.Ray(new THREE.Vector3(x, y, z), new THREE.Vector3(0, -1, 0));
}

test("sunward directions project shadows onto the opposite cardinal side", () => {
  const point = new THREE.Vector3(3, 24, 7);
  for (const [sun, expected] of [
    [[1, 1, 0], [-7, 14, 7]],
    [[-1, 1, 0], [13, 14, 7]],
    [[0, 1, 1], [3, 14, -3]],
    [[0, 1, -1], [3, 14, 17]],
    [[0, 1, 0], [3, 14, 7]],
  ]) {
    assertVector(projectToGround(point, new THREE.Vector3(...sun).normalize(), 14), new THREE.Vector3(...expected));
  }
});

test("projection rejects horizon, nighttime, invalid inputs, and overflow without changing output", () => {
  const point = new THREE.Vector3(2, 20, 3);
  const out = new THREE.Vector3(11, 12, 13);
  for (const direction of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(1, -0.1, 0),
    new THREE.Vector3(1, 1e-8, 0),
    new THREE.Vector3(NaN, 1, 0),
    new THREE.Vector3(Infinity, 1, 0),
  ]) assert.equal(projectToGround(point, direction, 14, out), null);
  assert.equal(projectToGround(point, new THREE.Vector3(0, 1, 0), NaN, out), null);
  assert.equal(projectToGround(new THREE.Vector3(0, Number.MAX_VALUE, 0), new THREE.Vector3(2, 1, 0), 0, out), null);
  assertVector(out, new THREE.Vector3(11, 12, 13));
});

test("projection supports an output buffer, including the input point itself", () => {
  const point = new THREE.Vector3(3, 24, 7);
  assert.equal(projectToGround(point, new THREE.Vector3(1, 1, 0), 14, point), point);
  assertVector(point, new THREE.Vector3(-7, 14, 7));
});

test("projection covaries with model yaw when both point and sun are transformed", () => {
  const point = new THREE.Vector3(12, 40, -7);
  const sun = new THREE.Vector3(0.6, 0.4, -0.3).normalize();
  const ground = projectToGround(point, sun, 14);
  for (const yaw of [-Math.PI, -1.2, 0.25, Math.PI / 2, 2.8]) {
    const rotation = new THREE.Matrix4().makeRotationY(yaw);
    const rotatedProjection = projectToGround(point.clone().applyMatrix4(rotation), sun.clone().transformDirection(rotation), 14);
    assertVector(rotatedProjection, ground.clone().applyMatrix4(rotation));
  }
});

test("a sunward ray from the projected receiver returns to the original sculpture point", () => {
  const point = new THREE.Vector3(-12, 70, 22);
  const sun = new THREE.Vector3(0.25, 0.65, -0.3).normalize();
  const ground = projectToGround(point, sun, 14);
  const ray = new THREE.Ray(ground, sun);
  assertVector(ray.at((point.y - ground.y) / sun.y, new THREE.Vector3()), point);
});

test("following an anchor preserves the pan offset without mutating inputs", () => {
  const center = { x: 13, z: -5 };
  const previous = { x: 10, z: -10 };
  const next = { x: -20, z: 30 };
  assert.deepEqual(followShadowCenter(center, previous, next), { x: -17, z: 35 });
  assert.deepEqual(center, { x: 13, z: -5 });
  assert.deepEqual(previous, { x: 10, z: -10 });
  assert.deepEqual(next, { x: -20, z: 30 });
  for (const invalid of [null, undefined, { x: NaN, z: 0 }, { x: 0, z: Infinity }]) {
    assert.equal(followShadowCenter(center, invalid, next), center);
    assert.equal(followShadowCenter(center, previous, invalid), center);
  }
});

test("the visible courtyard wins over buried platform geometry", () => {
  const result = resolveReceiver({ ray: downwardRay(), platform: boxBVH({ y: 8 }), groundY: 14 });
  assert.equal(result.kind, "ground");
  assertVector(result.point, new THREE.Vector3(0, 14, 0));
  assertVector(result.normal, new THREE.Vector3(0, 1, 0));
});

test("the basin mask exposes its real floor and leaves the surrounding courtyard intact", () => {
  const platform = boxBVH({ y: 8 });
  const groundOpen = (x, z) => Math.abs(x) >= 3 || Math.abs(z) >= 3;
  const basin = resolveReceiver({ ray: downwardRay(1, 1), platform, groundY: 14, groundOpen });
  assert.equal(basin.kind, "platform");
  assertVector(basin.point, new THREE.Vector3(1, 9, 1));
  const courtyard = resolveReceiver({ ray: downwardRay(4, 1), platform, groundY: 14, groundOpen });
  assert.equal(courtyard.kind, "ground");
  assertVector(courtyard.point, new THREE.Vector3(4, 14, 1));
  assert.equal(resolveReceiver({ ray: downwardRay(), groundY: 14, groundOpen }), null);
});

test("a platform above the courtyard remains the nearest receiver", () => {
  const result = resolveReceiver({ ray: downwardRay(), platform: boxBVH({ y: 14 }), groundY: 14 });
  assert.equal(result.kind, "platform");
  assertVector(result.point, new THREE.Vector3(0, 15, 0));
  assertVector(result.normal, new THREE.Vector3(0, 1, 0));
});

test("context geometry receives shadows only when included and nearer than other surfaces", () => {
  const platform = boxBVH({ y: 14 });
  const context = boxBVH({ y: 20, width: 4, depth: 4 });
  const options = { ray: downwardRay(), platform, context, groundY: 14 };
  assert.equal(resolveReceiver(options).kind, "platform");
  const rock = resolveReceiver({ ...options, includeContext: true });
  assert.equal(rock.kind, "context");
  assertVector(rock.point, new THREE.Vector3(0, 21, 0));
  assert.equal(resolveReceiver({ ...options, context: boxBVH({ y: 5 }), includeContext: true }).kind, "platform");
  assert.equal(resolveReceiver({ ...options, ray: downwardRay(8, 8), includeContext: true }).kind, "platform");
});

test("receiver queries preserve the ray, handle non-unit directions, and ignore surfaces behind it", () => {
  const ray = downwardRay();
  ray.direction.set(0, -5, 0);
  const result = resolveReceiver({ ray, platform: boxBVH({ y: 8 }), groundY: 14 });
  assertVector(result.point, new THREE.Vector3(0, 14, 0));
  assertVector(ray.origin, new THREE.Vector3(0, 100, 0));
  assertVector(ray.direction, new THREE.Vector3(0, -5, 0));
  assert.equal(resolveReceiver({ ray: downwardRay(0, 0, 10), groundY: 14 }), null);
  for (const direction of [new THREE.Vector3(), new THREE.Vector3(0, 1, 0), new THREE.Vector3(NaN, -1, 0)]) {
    assert.equal(resolveReceiver({ ray: new THREE.Ray(new THREE.Vector3(0, 100, 0), direction), groundY: 14 }), null);
  }
});
