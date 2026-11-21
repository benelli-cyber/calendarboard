#!/usr/bin/env node
'use strict';
/**
 * Compare weather sources for your location and log them to a CSV, hourly.
 * Helps decide whether the NWS or Open-Meteo numbers match your house better.
 *
 * Each row records:
 *   nws_station_f   the nearest NWS weather station's latest reading (a real
 *                   thermometer, but possibly miles away)
 *   nws_forecast_f  the NWS hourly forecast for your exact location
 *   open_meteo_f    Open-Meteo's current value for your exact location
 *
 * Usage (from the project folder):
 *   node scripts/compare-weather.js             keep running, one row per hour (at :05)
 *   node scripts/compare-weather.js --once      one row, then exit (e.g. from cron)
 *   node scripts/compare-weather.js --summary   print averages from the CSV so far
 *   Add --out <file> to use another CSV (default: data/weather-compare.csv).
 *
 * Reads lat/lon, the weather.gov contact, and the timezone from config.json
 * (or the file in CONFIG_PATH). It does not touch the running dashboard.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const COLUMNS = ['time', 'nws_station_f', 'nws_station_observed', 'nws_forecast_f', 'open_meteo_f', 'notes'];

/** "2026-11-15 15:05" in the process's local time (set to the config timezone). */
function localStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Fetch both sources once and return one CSV row (as an object). */
async function collectRow(weather, now = new Date()) {
  const row = { time: localStamp(now), nws_station_f: '', nws_station_observed: '', nws_forecast_f: '', open_meteo_f: '', notes: '' };
  const notes = [];

  try {
    const nws = await weather.fetchNws(now);
    if (nws.stationReading) {
      row.nws_station_f = nws.stationReading.temp;
      row.nws_station_observed = localStamp(new Date(nws.stationReading.observedAt));
    } else {
      notes.push('no recent NWS station reading');
    }
    if (nws.hourly[0]) row.nws_forecast_f = nws.hourly[0].temp;
  } catch (err) {
    notes.push(`NWS failed: ${err.message}`);
  }

  try {
    const om = await weather.fetchOpenMeteo(now);
    row.open_meteo_f = om.current.temp;
  } catch (err) {
    notes.push(`Open-Meteo failed: ${err.message}`);
  }

  row.notes = notes.join('; ');
  return row;
}

/** One CSV line. Only the notes column can contain commas or quotes. */
function toCsvLine(row) {
  return COLUMNS.map((c) => {
    const v = row[c] == null ? '' : String(row[c]);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, COLUMNS.join(',') + '\n');
  fs.appendFileSync(file, toCsvLine(row) + '\n');
}

/** Averages from the CSV text: how far each source is from the station reading. */
function summarize(csvText) {
  const lines = csvText.trim().split('\n').slice(1).filter(Boolean);
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const pairs = { om: [], fc: [], omFc: [] };
  for (const line of lines) {
    const [, station, , forecast, openMeteo] = line.split(',').map(num);
    if (station != null && openMeteo != null) pairs.om.push(openMeteo - station);
    if (station != null && forecast != null) pairs.fc.push(forecast - station);
    if (forecast != null && openMeteo != null) pairs.omFc.push(openMeteo - forecast);
  }
  const stats = (diffs) => diffs.length ? {
    count: diffs.length,
    avgDiff: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10,
    avgAbsDiff: Math.round((diffs.reduce((a, b) => a + Math.abs(b), 0) / diffs.length) * 10) / 10,
  } : null;
  return {
    rows: lines.length,
    openMeteoVsStation: stats(pairs.om),
    nwsForecastVsStation: stats(pairs.fc),
    openMeteoVsNwsForecast: stats(pairs.omFc),
  };
}

function printSummary(s) {
  const line = (label, st) => {
    if (!st) return `  ${label}: not enough data yet`;
    const dir = st.avgDiff > 0 ? 'warmer' : st.avgDiff < 0 ? 'cooler' : 'the same';
    const by = st.avgDiff === 0 ? '' : ` by ${Math.abs(st.avgDiff)}°F`;
    return `  ${label}: on average ${dir}${by}, typically ${st.avgAbsDiff}°F apart (${st.count} hours)`;
  };
  console.log(`${s.rows} rows logged.`);
  console.log(line('Open-Meteo vs NWS station', s.openMeteoVsStation));
  console.log(line('NWS forecast vs NWS station', s.nwsForecastVsStation));
  console.log(line('Open-Meteo vs NWS forecast', s.openMeteoVsNwsForecast));
}

/** Milliseconds until the next HH:05 (NWS stations usually report just before the hour). */
function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setMinutes(5, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next - now;
}

async function main() {
  const args = process.argv.slice(2);
  const { loadConfig, ROOT } = require('../server/config');
  const config = loadConfig();
  process.env.TZ = config.timezone; // timestamps in the family's timezone

  const outIdx = args.indexOf('--out');
  const file = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'data', 'weather-compare.csv');

  if (args.includes('--summary')) {
    if (!fs.existsSync(file)) {
      console.log(`No data yet (${file} doesn't exist).`);
      return;
    }
    printSummary(summarize(fs.readFileSync(file, 'utf8')));
    return;
  }

  const { WeatherService } = require('../server/weather');
  // Own cache folder so this never interferes with the dashboard's data/ files.
  const weather = new WeatherService({ getConfig: () => config, cacheDir: path.join(os.tmpdir(), 'family-dashboard-compare') });
  if (!weather.locationKey()) {
    console.error('Set weather.lat / weather.lon first (settings page or config.json).');
    process.exit(1);
  }

  const runOnce = async () => {
    const row = await collectRow(weather);
    appendRow(file, row);
    console.log(toCsvLine(row));
  };

  console.log(`Logging to ${file}`);
  await runOnce();
  if (args.includes('--once')) return;

  const scheduleNext = () => setTimeout(async () => {
    await runOnce().catch((err) => console.error(err.message));
    scheduleNext();
  }, msUntilNextRun());
  scheduleNext();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { collectRow, toCsvLine, summarize, msUntilNextRun, COLUMNS };
