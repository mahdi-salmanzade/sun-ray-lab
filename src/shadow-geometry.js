import * as THREE from "three";

const HORIZON_EPSILON = 1e-6;

const finitePoint = (point) =>
  point != null && [point.x, point.y, point.z].every(Number.isFinite);

const finiteXZ = (point) =>
  point != null && Number.isFinite(point.x) && Number.isFinite(point.z);

/**
 * Project a point along incoming sunlight onto a horizontal receiver plane.
 * sunDirection points FROM the sculpture TOWARD the sun; shadows therefore
 * travel in its opposite direction. All coordinates must share one space.
 * Returns null at/below the horizon or when no finite projection is possible.
 */
export function projectToGround(point, sunDirection, groundY, out = new THREE.Vector3()) {
  if (
    !finitePoint(point) ||
    !finitePoint(sunDirection) ||
    !Number.isFinite(groundY) ||
    sunDirection.y <= HORIZON_EPSILON
  ) return null;

  const distance = (point.y - groundY) / sunDirection.y;
  const x = point.x - sunDirection.x * distance;
  const z = point.z - sunDirection.z * distance;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return out.set(x, groundY, z);
}

/** Preserve the user's pan offset while following a moving shadow anchor. */
export function followShadowCenter(center, previousAnchor, nextAnchor) {
  if (!finiteXZ(center) || !finiteXZ(previousAnchor) || !finiteXZ(nextAnchor)) return center;
  const x = center.x + nextAnchor.x - previousAnchor.x;
  const z = center.z + nextAnchor.z - previousAnchor.z;
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : center;
}

/**
 * Find the visible non-copper surface below a probe. The ray, MeshBVHs, and
 * courtyard height are all model-local. Callers normally supply a vertical
 * downward ray from above the scene. The nearest forward hit wins, including
 * the courtyard when it hides a buried part of the platform. A masked basin
 * has no courtyard receiver, so its actual geometry remains visible.
 *
 * The input ray is not modified. Returned points and normals are independent
 * vectors; normals face the ray origin even for double-sided geometry.
 */
export function resolveReceiver({
  ray,
  platform,
  context,
  groundY,
  groundOpen = () => true,
  includeContext = false,
}) {
  if (!finitePoint(ray?.origin) || !finitePoint(ray?.direction)) return null;
  const direction = ray.direction.clone();
  const length = direction.length();
  if (!Number.isFinite(length) || length === 0) return null;
  direction.divideScalar(length);
  if (direction.y >= -HORIZON_EPSILON) return null;
  const query = new THREE.Ray(ray.origin.clone(), direction);
  let nearest = null;
  let nearestDistance = Infinity;

  function considerBVH(bvh, kind) {
    if (!bvh) return;
    const hit = bvh.raycastFirst(query, THREE.DoubleSide);
    if (!hit || !Number.isFinite(hit.distance) || hit.distance < 0 || hit.distance >= nearestDistance) return;
    const point = finitePoint(hit.point) ? hit.point.clone() : query.at(hit.distance, new THREE.Vector3());
    if (!finitePoint(point)) return;
    const normal = finitePoint(hit.face?.normal) ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
    const normalLength = normal.length();
    if (!Number.isFinite(normalLength) || normalLength === 0) normal.set(0, 1, 0);
    else normal.divideScalar(normalLength);
    if (normal.dot(direction) > 0) normal.negate();
    nearest = { point, normal, kind };
    nearestDistance = hit.distance;
  }

  considerBVH(platform, "platform");
  if (includeContext) considerBVH(context, "context");

  if (Number.isFinite(groundY)) {
    const distance = (groundY - query.origin.y) / direction.y;
    if (distance >= 0 && distance < nearestDistance) {
      const point = query.at(distance, new THREE.Vector3());
      point.y = groundY;
      if (finitePoint(point) && groundOpen(point.x, point.z)) {
        nearest = { point, normal: new THREE.Vector3(0, 1, 0), kind: "ground" };
      }
    }
  }

  return nearest;
}
