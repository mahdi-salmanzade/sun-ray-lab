/**
 * Real solar position — NOAA solar calculator algorithm.
 *
 * Replaces hand-typed azimuth/elevation presets with an actual ephemeris, so
 * "21 Jun 2:15pm at the CIA courtyard" is computed rather than asserted.
 *
 * Accuracy: better than 0.1 deg for years 1900-2100, which is far below the
 * 0.53 deg angular diameter of the sun itself — i.e. below the resolution
 * limit that actually governs this experiment.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Angular diameter of the solar disc, radians. This is the number that
 *  decides whether letter cutouts can project readable shapes. */
export const SUN_ANGULAR_DIAMETER = 0.533 * RAD; // 9.30 mrad
export const SUN_ANGULAR_RADIUS = SUN_ANGULAR_DIAMETER / 2;

/** Kryptos stands in the courtyard of the CIA New Headquarters Building. */
export const SITE = {
  name: "CIA New HQ courtyard, Langley VA",
  latitude: 38.9521,
  longitude: -77.1466,
  /** Standard time offset from UTC in hours (EST). DST handled separately. */
  standardOffset: -5,
};

/** Julian Day for a civil date at 00:00 local, plus fractional day. */
function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5
  );
}

/**
 * @param {{year:number, month:number, day:number, minutes:number,
 *          latitude:number, longitude:number, utcOffset:number}} opts
 *   minutes = minutes past local midnight; utcOffset in hours (e.g. -4 for EDT)
 * @returns {{azimuth:number, elevation:number, elevationApparent:number,
 *            declination:number, equationOfTime:number, hourAngle:number}}
 */
export function solarPosition({
  year,
  month,
  day,
  minutes,
  latitude,
  longitude,
  utcOffset,
}) {
  // Julian century referenced to the instant in UT.
  const jd = julianDay(year, month, day) + (minutes - utcOffset * 60) / 1440;
  const t = (jd - 2451545) / 36525;

  const meanLong = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const center =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289;

  const trueLong = meanLong + center;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliq =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const declination =
    Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) * DEG;

  // Equation of time (minutes).
  const y = Math.tan((obliqCorr / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 *
        eccent *
        y *
        Math.sin(meanAnom * RAD) *
        Math.cos(2 * meanLong * RAD) -
      0.5 * y * y * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD));

  // True solar time -> hour angle.
  const trueSolarTime = mod(
    minutes + eqTime + 4 * longitude - 60 * utcOffset,
    1440,
  );
  const hourAngle =
    trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const latRad = latitude * RAD;
  const decRad = declination * RAD;
  const cosZenith =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngle * RAD);
  const zenith = Math.acos(clamp(cosZenith, -1, 1)) * DEG;
  const elevation = 90 - zenith;

  // Azimuth measured clockwise from true north.
  let azimuth;
  const denom = Math.cos(latRad) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    const c = clamp(
      (Math.sin(latRad) * Math.cos(zenith * RAD) - Math.sin(decRad)) / denom,
      -1,
      1,
    );
    azimuth =
      hourAngle > 0
        ? mod360(Math.acos(c) * DEG + 180)
        : mod360(540 - Math.acos(c) * DEG);
  } else {
    azimuth = latitude > 0 ? 180 : 0;
  }

  return {
    azimuth,
    elevation,
    elevationApparent: elevation + refraction(elevation),
    declination,
    equationOfTime: eqTime,
    hourAngle,
  };
}

/** Atmospheric refraction in degrees (NOAA approximation). */
function refraction(elevationDeg) {
  if (elevationDeg > 85) return 0;
  const te = Math.tan(elevationDeg * RAD);
  let r;
  if (elevationDeg > 5) {
    r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (elevationDeg > -0.575) {
    r =
      1735 +
      elevationDeg *
        (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  } else {
    r = -20.772 / te;
  }
  return r / 3600;
}

/** US DST rule (2007-): 2nd Sunday March -> 1st Sunday November. */
export function isUsDst(year, month, day, hour = 12) {
  const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let start = 8;
  while (dow(year, 3, start) !== 0) start += 1; // 2nd Sunday = first Sunday >= 8
  let end = 1;
  while (dow(year, 11, end) !== 0) end += 1;
  const after = (m, d, h, sm, sd, sh) =>
    m > sm || (m === sm && (d > sd || (d === sd && h >= sh)));
  return (
    after(month, day, hour, 3, start, 2) && !after(month, day, hour, 11, end, 2)
  );
}

/**
 * Uniformly sample a direction inside the solar disc around `dir`.
 * Used for progressive penumbra accumulation: averaging many hard shadows
 * from across the disc converges to the true soft shadow.
 *
 * @param {{x:number,y:number,z:number}} dir unit vector to the sun centre
 * @param {number} u1 uniform [0,1)
 * @param {number} u2 uniform [0,1)
 * @param {number} radius angular radius in radians
 * @param {{x:number,y:number,z:number}} out
 */
export function sampleSunDisc(dir, u1, u2, radius, out) {
  // Concentric disc sample -> small-angle offset in the tangent plane.
  const r = Math.sqrt(u1) * Math.tan(radius);
  const phi = 2 * Math.PI * u2;

  // Build an orthonormal basis around dir (Duff et al., branchless).
  const sign = dir.z >= 0 ? 1 : -1;
  const a = -1 / (sign + dir.z);
  const b = dir.x * dir.y * a;
  const t1x = 1 + sign * dir.x * dir.x * a;
  const t1y = sign * b;
  const t1z = -sign * dir.x;
  const t2x = b;
  const t2y = sign + dir.y * dir.y * a;
  const t2z = -dir.y;

  const ox = r * Math.cos(phi);
  const oy = r * Math.sin(phi);

  let x = dir.x + ox * t1x + oy * t2x;
  let y = dir.y + ox * t1y + oy * t2y;
  let z = dir.z + ox * t1z + oy * t2z;
  const len = Math.hypot(x, y, z) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

function mod(v, m) {
  return ((v % m) + m) % m;
}
function mod360(v) {
  return mod(v, 360);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
