'use strict';
/**
 * Where the sun is, for the dashboard's sky background.
 *
 * skyPhase() → 'night' | 'dawn' | 'day' | 'dusk', from the sun's height above
 * the horizon at the configured location:
 *   day   – sun more than 6° up
 *   dawn  – sun within 6° of the horizon and rising
 *   dusk  – sun within 6° of the horizon and setting
 *   night – sun more than 6° below the horizon
 * (6° below the horizon is "civil twilight": the sky is still lit.)
 *
 * Uses the standard low-precision solar position formulas (accurate to well
 * under a degree, which is plenty for picking a background).
 */

const RAD = Math.PI / 180;

/** Sun elevation in degrees above the horizon (negative = below). */
function sunElevation(date, lat, lon) {
  const d = date.getTime() / 86_400_000 - 10957.5; // days since 2000-01-01 12:00 UTC
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude (degrees)
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * RAD; // tilt of Earth's axis
  const dec = Math.asin(Math.sin(e) * Math.sin(L)); // declination
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)); // right ascension
  const gmstHours = (18.697374558 + 24.06570982441908 * d) % 24; // sidereal time at Greenwich
  const hourAngle = (gmstHours * 15 + lon) * RAD - ra;
  const elev = Math.asin(
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hourAngle),
  );
  return elev / RAD;
}

/** 'night' | 'dawn' | 'day' | 'dusk' for this moment and place. */
function skyPhase(date, lat, lon) {
  const now = sunElevation(date, lat, lon);
  if (now > 6) return 'day';
  if (now < -6) return 'night';
  const later = sunElevation(new Date(date.getTime() + 10 * 60 * 1000), lat, lon);
  return later > now ? 'dawn' : 'dusk';
}

module.exports = { sunElevation, skyPhase };
