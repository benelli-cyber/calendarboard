'use strict';
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point config.js at a temporary file BEFORE loading it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cfg-'));
process.env.CONFIG_PATH = path.join(dir, 'config.json');
const { updateConfig, normalize, publicConfig } = require('../server/config');

test('updateConfig changes one field and keeps everything else (incl. secret URLs)', () => {
  const original = {
    port: 9090,
    calendars: [{ name: 'Fam', url: 'https://example.com/private-SECRET/basic.ics', color: '#123456' }],
    weather: { lat: 1, lon: 2 },
    display: { theme: 'light', calendarView: 'month' },
    somethingCustom: { keep: true },
  };
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(original));

  const cfg = updateConfig((raw) => { raw.display.calendarView = 'week'; });
  assert.equal(cfg.display.calendarView, 'week');

  const saved = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'));
  assert.equal(saved.display.calendarView, 'week');
  assert.equal(saved.display.theme, 'light');
  assert.equal(saved.calendars[0].url, original.calendars[0].url);
  assert.deepEqual(saved.somethingCustom, { keep: true });
  assert.equal(saved.port, 9090);
  assert.ok(!fs.existsSync(`${process.env.CONFIG_PATH}.tmp`), 'temp file cleaned up');
});

test('normalize falls back to month for an unknown view', () => {
  assert.equal(normalize({ display: { calendarView: 'year' } }).display.calendarView, 'month');
  assert.equal(normalize({}).display.calendarView, 'month');
});

test('publicConfig never includes calendar URLs', () => {
  const cfg = normalize({ calendars: [{ name: 'A', url: 'https://x/private-SECRET/basic.ics' }] });
  assert.ok(!JSON.stringify(publicConfig(cfg)).includes('SECRET'));
});
