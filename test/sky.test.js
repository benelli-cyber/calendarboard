'use strict';
// Run with: npm test
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sunElevation, skyPhase, moonIllumination, scene } = require('../server/sky');
const { createApp } = require('../server/index');
const { normalize } = require('../server/config');
const { applySettings } = require('../server/settings');

// Washington, DC on Nov 21, 2026: sunrise ~6:56 AM, sunset ~4:49 PM,
// civil twilight ~6:27 AM–7:20 AM-ish / ~4:49–5:18 PM.
const LAT = 38.8894;
const LON = -77.0352;
const at = (hhmm) => new Date(`2026-11-21T${hhmm}:00-05:00`);

test('sun elevation matches known values', () => {
  assert.ok(Math.abs(sunElevation(at('06:56'), LAT, LON) - -0.8) < 1, 'about -0.8° at sunrise');
  assert.ok(Math.abs(sunElevation(at('16:49'), LAT, LON) - -0.8) < 1, 'about -0.8° at sunset');
  // Noon height in late November ≈ 90 − latitude − 20.3° (sun's declination)
  assert.ok(Math.abs(sunElevation(at('12:00'), LAT, LON) - (90 - LAT - 20.3)) < 1.5);
});

test('sky phases through a day', () => {
  const phases = ['03:00', '06:40', '07:10', '12:00', '16:40', '17:10', '22:00'].map((t) => skyPhase(at(t), LAT, LON));
  assert.deepEqual(phases, ['night', 'dawn', 'dawn', 'day', 'dusk', 'dusk', 'night']);
});

test('works in the southern hemisphere too (Sydney, midsummer noon is day)', () => {
  assert.equal(skyPhase(new Date('2026-12-21T02:00:00Z'), -33.87, 151.21), 'day'); // 1 PM local
  assert.equal(skyPhase(new Date('2026-12-21T14:00:00Z'), -33.87, 151.21), 'night'); // 1 AM local
});

test('background setting: sky by default, plain allowed, others rejected', () => {
  assert.equal(normalize({}).display.background, 'sky');
  assert.equal(normalize({ display: { background: 'plain' } }).display.background, 'plain');
  assert.equal(normalize({ display: { background: 'disco' } }).display.background, 'sky');
  const raw = {};
  applySettings(raw, { display: { background: 'plain' } });
  assert.equal(raw.display.background, 'plain');
  assert.throws(() => applySettings({}, { display: { background: 'disco' } }), { field: 'display.background' });
});

test('moon phase matches known new, first-quarter, and full moons (Jan 2024)', () => {
  const full = moonIllumination(new Date('2024-01-25T17:54:00Z'));
  const nw = moonIllumination(new Date('2024-01-11T11:57:00Z'));
  const fq = moonIllumination(new Date('2024-01-18T03:52:00Z'));
  assert.ok(full.fraction > 0.98 && Math.abs(full.phase - 0.5) < 0.03, 'full');
  assert.ok(nw.fraction < 0.02 && (nw.phase < 0.03 || nw.phase > 0.97), 'new');
  assert.ok(Math.abs(fq.fraction - 0.5) < 0.03 && Math.abs(fq.phase - 0.25) < 0.03, 'first quarter');
});

test('scene: sun due south and highest around noon; rounded for drawing', () => {
  const sc = scene(at('12:00'), LAT, LON);
  assert.equal(sc.phase, 'day');
  assert.ok(Math.abs(sc.sun.az - 180) < 5, `sun azimuth ${sc.sun.az}`);
  assert.ok(sc.sun.alt > 28 && sc.sun.alt < 33);
  assert.equal(String(sc.sun.alt).split('.')[1]?.length || 0, 1, 'one decimal');
  assert.ok(sc.moon.fraction >= 0 && sc.moon.fraction <= 1);
});

test('/api/scene: needs a location; returns sun and moon when set', async (t) => {
  let cfg = { weather: { lat: 0, lon: 0 } };
  const app = createApp({ getConfig: () => cfg, setConfig: () => {}, calendar: {}, weather: {}, todos: {} });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/scene`;
  assert.deepEqual(await (await fetch(url)).json(), { configured: false });
  cfg = { weather: { lat: LAT, lon: LON } };
  const body = await (await fetch(url)).json();
  assert.equal(body.configured, true);
  assert.ok(['night', 'dawn', 'day', 'dusk'].includes(body.phase));
  assert.ok('alt' in body.sun && 'phase' in body.moon);
});
