'use strict';
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point config.js at a temporary file BEFORE loading anything that uses it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-settings-'));
process.env.CONFIG_PATH = path.join(dir, 'config.json');

const { normalize } = require('../server/config');
const { toSettings, applySettings, maskUrl } = require('../server/settings');
const { calendarId } = require('../server/calendar');
const { createApp } = require('../server/index');

const FAMILY = 'https://calendar.google.com/calendar/ical/fam%40group/private-SECRET111/basic.ics';
const KIDS = 'https://calendar.google.com/calendar/ical/kids%40group/private-SECRET222/basic.ics';
const NEW = 'https://calendar.google.com/calendar/ical/new%40group/private-SECRET333/basic.ics';

function baseRaw() {
  return {
    port: 8080,
    timezone: 'America/New_York',
    calendars: [
      { name: 'Family', url: FAMILY, color: '#4FC3F7', enabled: true },
      { name: 'Kids', url: KIDS, color: '#FFB74D', enabled: true, note: 'extra field kept' },
    ],
    weather: { lat: 0, lon: 0, userAgent: 'family-dashboard (a@b.c)', units: 'imperial' },
    display: { theme: 'dark', fontScale: 1, calendarView: 'month', dimStart: '23:00', dimEnd: '06:00' },
  };
}

test('maskUrl hides the secret part', () => {
  assert.equal(maskUrl(FAMILY), 'calendar.google.com/…/basic.ics');
  assert.equal(maskUrl('webcal://example.com/x/secret/cal.ics'), 'example.com/…/cal.ics');
  assert.equal(maskUrl('file:test/fixtures/recurring.ics'), 'file:…/recurring.ics');
  assert.equal(maskUrl('not a url'), '(hidden)');
});

test('toSettings never contains a calendar URL', () => {
  const s = toSettings(normalize(baseRaw()));
  const json = JSON.stringify(s);
  assert.ok(!json.includes('SECRET'));
  assert.ok(!json.includes('private-'));
  assert.equal(s.calendars[0].id, calendarId(FAMILY));
  assert.equal(s.calendars[0].urlMasked, 'calendar.google.com/…/basic.ics');
});

test('rename, recolor, disable, reorder, keep URLs and extra fields', () => {
  const raw = baseRaw();
  const s = toSettings(normalize(raw));
  applySettings(raw, {
    calendars: [
      { ...s.calendars[1], name: 'School', color: '#ff0000', enabled: false },
      { ...s.calendars[0] },
    ],
  });
  assert.deepEqual(raw.calendars.map((c) => c.name), ['School', 'Family']);
  assert.equal(raw.calendars[0].url, KIDS, 'secret URL kept without being sent');
  assert.equal(raw.calendars[0].color, '#FF0000');
  assert.equal(raw.calendars[0].enabled, false);
  assert.equal(raw.calendars[0].note, 'extra field kept');
  assert.equal(raw.port, 8080, 'unmanaged fields untouched');
});

test('add, remove, and replace a calendar URL', () => {
  const raw = baseRaw();
  const s = toSettings(normalize(raw));
  applySettings(raw, {
    calendars: [
      { ...s.calendars[0], url: NEW },                               // replace Family's URL
      { name: 'Sports', color: '#00ff00', enabled: true, url: NEW.replace('333', '444') }, // add
      // Kids omitted → removed
    ],
  });
  assert.equal(raw.calendars.length, 2);
  assert.equal(raw.calendars[0].url, NEW);
  assert.equal(raw.calendars[1].name, 'Sports');
});

test('calendar validation errors name the field', () => {
  const s = toSettings(normalize(baseRaw()));
  const bad = (cals) => () => applySettings(baseRaw(), { calendars: cals });
  assert.throws(bad([{ ...s.calendars[0], name: '  ' }]), { field: 'calendars.0.name' });
  assert.throws(bad([{ ...s.calendars[0], color: 'red' }]), { field: 'calendars.0.color' });
  assert.throws(bad([{ name: 'New', color: '#000000' }]), { field: 'calendars.0.url' });
  assert.throws(bad([{ name: 'New', color: '#000000', url: 'file:/etc/passwd' }]), { field: 'calendars.0.url' });
  assert.throws(bad([{ name: 'New', color: '#000000', url: 'javascript:alert(1)' }]), { field: 'calendars.0.url' });
  assert.throws(bad([{ ...s.calendars[0], id: 'deadbeefdeadbeef' }]), { field: 'calendars.0.id' });
  assert.throws(bad([s.calendars[0], { name: 'Dup', color: '#000000', url: FAMILY }]), { field: 'calendars.1.url' });
});

test('display and weather settings', () => {
  const raw = baseRaw();
  applySettings(raw, {
    display: { theme: 'light', fontScale: '1.234', calendarView: 'week' },
    weather: { lat: '38.8894', lon: -77.0352, userAgent: 'family-dashboard (me@example.com)' },
  });
  assert.equal(raw.display.theme, 'light');
  assert.equal(raw.display.fontScale, 1.23);
  assert.equal(raw.display.calendarView, 'week');
  assert.equal(raw.display.dimStart, '23:00', 'untouched fields kept');
  assert.equal(raw.weather.lat, 38.8894);
  assert.equal(raw.weather.lon, -77.0352);
  assert.equal(raw.weather.units, 'imperial');

  applySettings(raw, { display: { dimEnabled: true, dimStart: '22:30', dimEnd: '06:15', dimLevel: 0.75 } });
  assert.equal(raw.display.dimEnabled, true);
  assert.equal(raw.display.dimStart, '22:30');
  assert.equal(raw.display.dimEnd, '06:15');
  assert.equal(raw.display.dimLevel, 0.75);
  assert.throws(() => applySettings(baseRaw(), { display: { dimStart: '25:00' } }), { field: 'display.dimStart' });
  assert.throws(() => applySettings(baseRaw(), { display: { dimLevel: 1 } }), { field: 'display.dimLevel' });
  assert.throws(() => applySettings(baseRaw(), { display: { dimEnabled: 'yes' } }), { field: 'display.dimEnabled' });

  assert.throws(() => applySettings(baseRaw(), { display: { theme: 'neon' } }), { field: 'display.theme' });
  assert.throws(() => applySettings(baseRaw(), { display: { fontScale: 5 } }), { field: 'display.fontScale' });
  assert.throws(() => applySettings(baseRaw(), { weather: { lat: 95 } }), { field: 'weather.lat' });
  assert.throws(() => applySettings(baseRaw(), { weather: { lon: 'abc' } }), { field: 'weather.lon' });
  assert.throws(() => applySettings(baseRaw(), { weather: { userAgent: ' ' } }), { field: 'weather.userAgent' });
  applySettings(raw, { weather: { currentSource: 'station' } });
  assert.equal(raw.weather.currentSource, 'station');
  assert.throws(() => applySettings(baseRaw(), { weather: { currentSource: 'guess' } }), { field: 'weather.currentSource' });
});

// ---------------------------------------------------------------------------
// HTTP API with a real config file
// ---------------------------------------------------------------------------

async function startApi(t) {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(baseRaw(), null, 2));
  let config = normalize(baseRaw());
  const calls = { refresh: 0, weather: 0 };
  const app = createApp({
    getConfig: () => config,
    setConfig: (c) => { config = c; },
    calendar: { refreshAll: () => { calls.refresh++; } },
    weather: { onConfigChange: () => { calls.weather++; } },
    todos: {},
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, calls, getConfig: () => config };
}

test('API: save settings, apply live, never leak URLs', async (t) => {
  const { call, calls, getConfig } = await startApi(t);
  const got = await call('GET', '/api/settings');
  assert.equal(got.status, 200);
  assert.ok(!JSON.stringify(got.body).includes('SECRET'));

  const body = { ...got.body, display: { ...got.body.display, theme: 'light' }, weather: { ...got.body.weather, lat: 38.8894, lon: -77.0352 } };
  const saved = await call('PUT', '/api/settings', body);
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes('SECRET'));

  // Applied live (in memory) and written to disk with the secret URLs intact.
  assert.equal(getConfig().display.theme, 'light');
  const onDisk = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'));
  assert.equal(onDisk.weather.lat, 38.8894);
  assert.equal(onDisk.calendars[0].url, FAMILY);
  assert.deepEqual(calls, { refresh: 1, weather: 1 });
});

test('API: invalid settings → 400 with field, file unchanged', async (t) => {
  const { call, calls } = await startApi(t);
  const before = fs.readFileSync(process.env.CONFIG_PATH, 'utf8');
  const r = await call('PUT', '/api/settings', { weather: { lat: 500 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'weather.lat');
  assert.equal(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'), before);
  assert.deepEqual(calls, { refresh: 0, weather: 0 });
});
