'use strict';
/**
 * Small date helpers shared by the calendar and weather modules.
 *
 * All of these use the process's LOCAL time, which the server sets to
 * config.timezone at startup (process.env.TZ in server/index.js).
 */

/** Local midnight of the given date, plus `days` days. DST-safe (uses calendar math). */
function startOfDay(date, days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** "2026-11-14" in local time. */
function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Whole calendar days between two dates' local midnights (DST-safe via rounding). */
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

module.exports = { startOfDay, dayKey, daysBetween };
