import * as THREE from "three";

const LUMINANCE = [0.2126, 0.7152, 0.0722];

function component(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function halton(index, base) {
  let value = 0;
  let scale = 1;
  while (index > 0) {
    scale /= base;
    value += scale * (index % base);
    index = Math.floor(index / base);
  }
  return value;
}

/**
 * Compare the GPU's direct channel with independent CPU visibility rays.
 *
 * Call with a converged point sun in Read mode: every horizontal receiver is
 * Lambertian grey (albedo 0.7), so its expected radiance is known exactly.
 * `readDirect` returns un-tonemapped RGBA floats in WebGL's bottom-up order.
 * `probe(x, z)` returns the visible receiver's world-space `groundY`, `normal`
 * and boolean `open` (unobstructed toward the sun, including active casters).
 * This function does not move the camera or change any rendering settings.
 *
 * Only flat receivers are compared (courtyard and platform may differ in
 * height). Every checked pixel is independently traced at the SAME Halton
 * camera jitter positions as the GPU, so narrow apertures inside a pixel are
 * compared as fractional visibility instead of incorrectly requiring a binary
 * result. Samples crossing receiver-height boundaries are excluded. CSS
 * mirroring does not affect the raw framebuffer and is irrelevant here.
 */
export function verifyShadow({
  readDirect,
  camera,
  sunDir,
  dni,
  probe,
  receiverY,
  columns = 35,
  rows = 25,
  samples = 64,
  tolerance = 0.03,
}) {
  if (!camera?.isOrthographicCamera) {
    throw new Error("Shadow verification requires the orthographic Read view.");
  }
  if (!Number.isFinite(receiverY) || !(tolerance > 0 && tolerance < 1)) {
    throw new Error("Shadow verification needs a finite receiver height and tolerance in (0, 1).");
  }
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error("Shadow verification needs the positive integer count of accumulated direct samples.");
  }

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  if (direction.y > -0.999999) {
    throw new Error("Shadow verification requires a top-down camera.");
  }
  const sun = new THREE.Vector3(
    component(sunDir, "x", 0),
    component(sunDir, "y", 1),
    component(sunDir, "z", 2),
  ).normalize();
  const irradiance = LUMINANCE.reduce(
    (sum, weight, i) => sum + weight * component(dni, ["r", "g", "b"][i], i),
    0,
  );
  const expectedLit = (0.7 / Math.PI) * irradiance * sun.y;
  if (!Number.isFinite(expectedLit) || expectedLit <= 1e-8) {
    throw new Error("Shadow verification requires a sun above the horizon with positive irradiance.");
  }

  const { width, height, data } = readDirect();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || data?.length !== width * height * 4) {
    throw new Error("readDirect must return a valid linear RGBA framebuffer.");
  }
  const nx = Math.min(width - 2, Math.max(1, Math.floor(columns)));
  const ny = Math.min(height - 2, Math.max(1, Math.floor(rows)));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    throw new Error("Shadow verification requires finite grid dimensions.");
  }

  const report = {
    pass: false,
    checked: 0,
    lit: 0,
    shadow: 0,
    fractional: 0,
    cpuRays: 0,
    samples,
    mismatch: 0,
    maxError: 0,
    meanError: 0,
    tolerance,
    expectedLitRadiance: expectedLit,
    grid: [nx, ny],
    framebuffer: [width, height],
    skipped: { receiver: 0, boundary: 0 },
    sampleErrors: [],
  };
  const world = new THREE.Vector3();
  // setViewOffset uses an upper-left origin; framebuffer rows start at the
  // bottom, hence the opposite sign on the vertical jitter.
  const jitter = Array.from({ length: samples }, (_, i) => [
    halton(i + 1, 5) - 0.5,
    -(halton(i + 1, 7) - 0.5),
  ]);
  let errorSum = 0;

  function sample(px, py) {
    world.set((px / width) * 2 - 1, (py / height) * 2 - 1, 0).unproject(camera);
    world.addScaledVector(direction, (receiverY - world.y) / direction.y);
    report.cpuRays++;
    const hit = probe(world.x, world.z);
    const normalY = component(hit?.normal, "y", 1);
    if (!hit || typeof hit.open !== "boolean" || !Number.isFinite(normalY) || !Number.isFinite(hit.groundY)
      || normalY < 0.99999) {
      return null;
    }
    return { open: hit.open, x: world.x, z: world.z, y: hit.groundY, blocker: hit.blocker ?? null };
  }

  for (let gy = 0; gy < ny; gy++) {
    const py = 1 + Math.floor(((gy + 0.5) * (height - 2)) / ny);
    for (let gx = 0; gx < nx; gx++) {
      const px = 1 + Math.floor(((gx + 0.5) * (width - 2)) / nx);
      let first = null;
      let openSamples = 0;
      let skipReason = null;
      for (const [dx, dy] of jitter) {
        const hit = sample(px + 0.5 + dx, py + 0.5 + dy);
        if (!hit) {
          skipReason = "receiver";
          break;
        }
        if (first && Math.abs(hit.y - first.y) > 0.01) {
          skipReason = "boundary";
          break;
        }
        first ??= hit;
        if (hit.open) openSamples++;
      }
      if (skipReason) {
        report.skipped[skipReason]++;
        continue;
      }
      const cpuFraction = openSamples / samples;

      const offset = (py * width + px) * 4;
      const actual = LUMINANCE.reduce((sum, weight, i) => sum + data[offset + i] * weight, 0);
      const ratio = actual / expectedLit;
      const error = Number.isFinite(ratio) ? Math.abs(ratio - cpuFraction) : Infinity;
      report.checked++;
      report[openSamples === 0 ? "shadow" : openSamples === samples ? "lit" : "fractional"]++;
      report.maxError = Math.max(report.maxError, error);
      errorSum += error;
      if (error > tolerance) {
        report.mismatch++;
        if (report.sampleErrors.length < 12) {
          report.sampleErrors.push({
            pixel: [px, py],
            world: [first.x, first.y, first.z],
            cpuFraction,
            blocker: first.blocker,
            gpuRatio: Number.isFinite(ratio) ? ratio : null,
            error: Number.isFinite(error) ? error : null,
          });
        }
      }
    }
  }
  report.meanError = report.checked ? errorSum / report.checked : null;
  // A frame with no shadow (or no light) cannot demonstrate transmission.
  report.pass = report.checked >= 25 && report.lit > 0 && report.shadow > 0 && report.mismatch === 0;
  report.reason = report.checked < 25 ? "Too few flat receiver samples."
    : report.lit === 0 || report.shadow === 0 ? "Frame must contain both lit and shaded paving."
      : report.mismatch ? "GPU direct light disagrees with the CPU average at matching camera samples."
        : "GPU direct light matches independent CPU visibility rays, including subpixel apertures.";
  return report;
}
