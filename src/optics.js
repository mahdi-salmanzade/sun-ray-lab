/**
 * Optical resolvability of the Kryptos letter cutouts.
 *
 * The renderer (tracer.js) is the measurement: it ray-traces the real mesh
 * against a 0.53 deg solar disc. This module gives the closed-form numbers
 * that explain what the render shows.
 *
 * CORRECTION 2026-09-27. The previous version compared the penumbra d*delta
 * with the letter height directly. That ignores obliquity. The letters are
 * cut in a VERTICAL plate, and the sun ray meets that plate at incidence
 * angle i (cos i = cos(el) * cos(dAz) for a plate facing azimuth dAz away
 * from the sun). Mapped back into the plate -- the letter's own frame -- the
 * blur disc of diameter d*delta is stretched to d*delta / cos(i) along the
 * direction of the ray's in-plane component. For a sun square-on to the plate
 * that direction is vertical, i.e. along the letter height. So at 69 deg sun
 * a letter 62 u up the screen has 1.7 u of blur on a 2.6 u letter: not
 * "soft", as the old table said, but illegible. The old "94 % of the screen
 * legible at the solstice" figure is withdrawn. For the current 3.09 u
 * rebuilt letters, the blur-only limit is ~60% at 45 deg, square-on;
 * plate walls and other occluders further restrict actual transmission.
 *
 * The ratio blur/letter is dimensionless, so none of this depends on how many
 * metres a model unit represents. Only the millimetre figures do.
 */

import { SUN_ANGULAR_DIAMETER } from "./solar.js";

/**
 * Letter geometry. Rebuilt screen: see SCREENS (cap 3.09 u); printable model
 * aperture mask: 2.6 u. Stroke width is the
 * distance-transform median from blur_ladder.py.
 */
export const LETTER = {
  height: 2.6,
  strokeWidth: 0.341,
  /** Legible while blur (major axis, letter frame) < ratio * height.
   *  Calibrated visually on blur_ladder.py with an isotropic disc; applying
   *  it to the major axis of an elliptical blur is the conservative reading. */
  legibilityRatio: 0.45,
};

/** Copper screen extent in model units (GLB bounds). */
export const SCREEN_HEIGHT_U = 124.6;

/** The three selectable screens. Thickness from the build scripts. */
// barHeight: typical horizontal stroke (the first thing the plate walls
// close off as the sun rises). Rebuilt: measured on the Superclarendon glyphs
// at cap 3.09 u (bars/serifs 0.26-0.36 u, stems 0.63 u). Printable: the
// aperture statistic of measure_apertures.py.
export const SCREENS = {
  demo: { label: "Open demo ¼″ plate", thickness: 0.216, letterHeight: 3.09, barHeight: 0.44 },
  rebuilt: { label: "Rebuilt ¼″ plate", thickness: 0.216, letterHeight: 3.09, barHeight: 0.3 },
  thin: { label: "Printable, re-cut to ¼″", thickness: 0.216, letterHeight: 2.6, barHeight: 0.34 },
  original: { label: "Printable original (59 mm)", thickness: 1.999, letterHeight: 2.6, barHeight: 0.34 },
};

/** Real S-screen: "11-12 ft" (Wikipedia), "12' H" (Sanborn's plaza text);
 *  plate .25 in (David Sheldon, who cut the letters, via Spyscape). Only
 *  used to print millimetres; every verdict is a dimensionless ratio. */
export const METRES_PER_UNIT = 3.66 / SCREEN_HEIGHT_U;
export function mm(units) {
  return units * METRES_PER_UNIT * 1000;
}

const RAD = Math.PI / 180;

/** Throw distance along the sun ray from a point h above the receiver. */
export function throwDistance(h, elevationDeg) {
  return h / Math.max(Math.sin(Math.max(elevationDeg, 0.5) * RAD), 1e-3);
}

/**
 * Blur of one aperture point at throw distance d.
 *  - letterMinor / letterMajor: blur mapped back into the plate (letter frame)
 *  - groundAcross / groundAlong: blur footprint on a horizontal receiver
 * @param {number} d throw distance
 * @param {number} cosIncidence |cos| of the angle between ray and plate normal
 * @param {number} elevationDeg sun elevation
 */
export function blur(d, cosIncidence, elevationDeg) {
  const p = d * SUN_ANGULAR_DIAMETER;
  const s = Math.max(Math.sin(Math.max(elevationDeg, 0.5) * RAD), 1e-3);
  return {
    penumbra: p,
    letterMinor: p,
    letterMajor: p / Math.max(Math.abs(cosIncidence), 1e-3),
    groundAcross: p,
    groundAlong: p / s,
  };
}

export function verdictFor(ratio) {
  if (ratio <= 0.12) return "CRISP";
  if (ratio <= 0.3) return "SOFT";
  if (ratio <= LETTER.legibilityRatio) return "MARGINAL";
  return "ILLEGIBLE";
}

/**
 * Tallest point on the screen whose letters still read on the receiver,
 * best case (sun square-on, dAz = 0):
 *   d*delta/cos(el) = r*L  with  d = h/sin(el)  =>  h = r*L*sin(el)*cos(el)/delta
 */
export function maxLegibleHeight(elevationDeg, letterHeight, cosAzOffset = 1) {
  const e = Math.max(elevationDeg, 0.5) * RAD;
  return (
    (LETTER.legibilityRatio * letterHeight * Math.sin(e) * Math.cos(e) * cosAzOffset) /
    SUN_ANGULAR_DIAMETER
  );
}

/**
 * Best-case table at the bottom / middle / top of the screen.
 */
export function screenReport(elevationDeg, letterHeight, screenHeight = SCREEN_HEIGHT_U) {
  const cosI = Math.cos(Math.max(elevationDeg, 0.5) * RAD);
  const rows = [
    ["bottom", screenHeight * 0.1],
    ["middle", screenHeight * 0.5],
    ["top", screenHeight * 0.95],
  ].map(([label, h]) => {
    const d = throwDistance(h, elevationDeg);
    const b = blur(d, cosI, elevationDeg);
    const ratio = b.letterMajor / letterHeight;
    return {
      label,
      height: h,
      distance: d,
      ...b,
      ratio,
      verdict: verdictFor(ratio),
      strokesSurvive: b.letterMajor <= LETTER.strokeWidth,
    };
  });
  const hMax = maxLegibleHeight(elevationDeg, letterHeight);
  return {
    rows,
    maxLegibleHeight: hMax,
    legibleFraction: Math.max(0, Math.min(1, hMax / screenHeight)),
  };
}

/**
 * A plate of thickness t with letter strokes/openings of width w only passes
 * rays within atan(w/t) of its normal (a louvre). The ray tracer handles this
 * exactly from the geometry; this is only the rule of thumb for the readout.
 */
export function louvreCutoffDeg(thickness, openingWidth = 0.415) {
  return Math.atan(openingWidth / thickness) / RAD;
}

/** Fresnel number: F >> 1 means geometric optics, diffraction negligible. */
export function fresnelNumber(apertureWidth, distance, wavelengthM = 550e-9) {
  const w = apertureWidth * METRES_PER_UNIT;
  const d = Math.max(distance * METRES_PER_UNIT, 1e-6);
  return (w * w) / (wavelengthM * d);
}
