'use strict';
// Run with: npm test
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WeatherService } = require('../server/weather');
const { collectRow, toCsvLine, summarize, msUntilNextRun, COLUMNS } = require('../scripts/compare-weather');

const NOW = new Date('2026-11-14T16:40:00-05:00'); // when the NWS fixtures were captured
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'weather', `${name}.json`), 'utf8'));

/** WeatherService whose fetch serves the fixtures; `failing` makes matching URLs fail. */
function service(failing = () => false) {
  const routes = [
    ['open-meteo.com', 'open-meteo'], ['/points/', 'nws-points'], ['/stations?', 'nws-stations'],
    ['/observations/latest', 'nws-observation'], ['/forecast/hourly', 'nws-hourly'], ['/forecast', 'nws-forecast'],
  ];
  const fetchImpl = async (url) => {
    const name = routes.find(([frag]) => url.includes(frag))?.[1];
    if (!name || failing(url)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => fx(name) };
  };
  const cfg = { timezone: 'America/New_York', weather: { lat: 38.8894, lon: -77.0352, userAgent: 'test' } };
  return new WeatherService({ getConfig: () => cfg, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cmp-')), fetchImpl });
}

test('collectRow records station, NWS forecast, and Open-Meteo temps', async () => {
  const row = await collectRow(service(), NOW);
  assert.equal(row.time, '2026-11-14 16:40');
  assert.equal(row.nws_station_f, 48);
  assert.equal(row.nws_station_observed, '2026-11-14 16:30');
  assert.equal(typeof row.nws_forecast_f, 'number');
  assert.equal(row.open_meteo_f, 50);
  assert.equal(row.notes, '');
});

test('collectRow notes a failed source and keeps the other', async () => {
  const row = await collectRow(service((u) => u.includes('open-meteo')), NOW);
  assert.equal(row.nws_station_f, 48);
  assert.equal(row.open_meteo_f, '');
  assert.match(row.notes, /Open-Meteo failed: HTTP 503/);
});

test('CSV lines quote notes that contain commas', () => {
  const line = toCsvLine({ time: '2026-11-14 16:40', nws_station_f: 48, open_meteo_f: 50, notes: 'a, "b"' });
  assert.equal(line, '2026-11-14 16:40,48,,,50,"a, ""b"""');
  assert.equal(COLUMNS.length, 6);
});

test('summarize averages the differences', () => {
  const csv = [
    COLUMNS.join(','),
    '2026-11-14 13:05,50,2026-11-14 12:52,51,52,',
    '2026-11-14 14:05,52,2026-11-14 13:52,52,51,',
    '2026-11-14 15:05,,,53,55,no recent NWS station reading',
  ].join('\n');
  const s = summarize(csv);
  assert.equal(s.rows, 3);
  assert.deepEqual(s.openMeteoVsStation, { count: 2, avgDiff: 0.5, avgAbsDiff: 1.5 });
  assert.deepEqual(s.nwsForecastVsStation, { count: 2, avgDiff: 0.5, avgAbsDiff: 0.5 });
  assert.deepEqual(s.openMeteoVsNwsForecast, { count: 3, avgDiff: 0.7, avgAbsDiff: 1.3 });
  assert.equal(summarize(COLUMNS.join(',')).openMeteoVsStation, null);
});

test('runs are scheduled at 5 past the hour', () => {
  assert.equal(msUntilNextRun(new Date('2026-11-14T16:40:00-05:00')), 25 * 60 * 1000);
  assert.equal(msUntilNextRun(new Date('2026-11-14T16:03:00-05:00')), 2 * 60 * 1000);
  assert.equal(msUntilNextRun(new Date('2026-11-14T16:05:00-05:00')), 60 * 60 * 1000);
});
