'use strict';
/**
 * Sun and moon positions for the dashboard's illustrated sky scene.
 *
 *   skyPhase(date, lat, lon)  → 'night' | 'dawn' | 'day' | 'dusk'
 *       day   – sun more than 6° up
 *       dawn  – sun within 6° of the horizon and rising
 *       dusk  – sun within 6° of the horizon and setting
 *       night – sun more than 6° below the horizon (past civil twilight)
 *   scene(date, lat, lon)     → { phase, sun: {alt, az}, moon: {alt, az, phase, fraction} }
 *       alt = degrees above the horizon, az = compass bearing (0 N, 90 E, 180 S, 270 W)
 *       moon.phase: 0 new → 0.25 first quarter → 0.5 full → 0.75 last quarter
 *       moon.fraction: how much of the disc is lit (0–1)
 *
 * Standard low-precision formulas (the same ones used by the popular
 * "suncalc" approach): accurate to well under a degree, plenty for drawing.
 */

const RAD = Math.PI / 180;
const E = RAD * 23.4397; // tilt of Earth's axis

/** Days since 2000-01-01 12:00 UTC. */
const toDays = (date) => date.getTime() / 86_400_000 - 10957.5;

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d); // mean anomaly
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI; // ecliptic longitude
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d); // mean longitude
  const M = RAD * (134.963 + 13.064993 * d); // mean anomaly
  const F = RAD * (93.272 + 13.22935 * d); // mean distance from its ascending node
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Altitude and compass azimuth (degrees) of something at (ra, dec), seen from lat/lon. */
function horizontal(date, lat, lon, { ra, dec }) {
  const d = toDays(date);
  const phi = RAD * lat;
  const H = siderealTime(d, RAD * -lon) - ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azFromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { alt: alt / RAD, az: (azFromSouth / RAD + 180 + 360) % 360 };
}

/** Sun elevation in degrees above the horizon (negative = below). */
function sunElevation(date, lat, lon) {
  return horizontal(date, lat, lon, sunCoords(toDays(date))).alt;
}

/** 'night' | 'dawn' | 'day' | 'dusk' for this moment and place. */
function skyPhase(date, lat, lon) {
  const now = sunElevation(date, lat, lon);
  if (now > 6) return 'day';
  if (now < -6) return 'night';
  const later = sunElevation(new Date(date.getTime() + 10 * 60 * 1000), lat, lon);
  return later > now ? 'dawn' : 'dusk';
}

/** How much of the moon is lit, and where it is in its monthly cycle. */
function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sunDist = 149598000; // km
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sunDist * Math.sin(phi), m.dist - sunDist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/** Everything the dashboard needs to draw the sky (rounded: it's for drawing). */
function scene(date, lat, lon) {
  const d = toDays(date);
  const sun = horizontal(date, lat, lon, sunCoords(d));
  const moon = horizontal(date, lat, lon, moonCoords(d));
  const illum = moonIllumination(date);
  return {
    phase: skyPhase(date, lat, lon),
    sun: { alt: r1(sun.alt), az: r1(sun.az) },
    moon: { alt: r1(moon.alt), az: r1(moon.az), phase: r2(illum.phase), fraction: r2(illum.fraction) },
  };
}

module.exports = { sunElevation, skyPhase, moonIllumination, scene };
