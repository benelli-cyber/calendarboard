'use strict';
// Run with: npm test
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileRules, ruleColor } = require('../server/color-rules');
const { normalize } = require('../server/config');
const { applySettings } = require('../server/settings');
const { CalendarService } = require('../server/calendar');

const PINK = '#E91E63';
const YELLOW = '#F6BF26';
const RED = '#D50000';
const RULES = {
  weekends: false,
  rules: [
    { name: 'Kids', color: PINK, keywords: ['luciana', 'liliana', 'lily', 'lucy'] },
    { name: 'Food', color: YELLOW, keywords: ['lunch', 'dinner', 'ice cream'] },
    { name: 'Off', color: RED, keywords: ['off'] },
  ],
};
const WED = new Date(2026, 10, 18); // Wednesday
const SAT = new Date(2026, 10, 21); // Saturday

test('whole words, any capitalization, plurals and possessives', () => {
  const c = compileRules(RULES);
  assert.equal(ruleColor(c, 'Liliana Therapy', WED), PINK);
  assert.equal(ruleColor(c, "LILY'S recital", WED), PINK);
  assert.equal(ruleColor(c, 'Lily’s recital', WED), PINK);          // curly apostrophe
  assert.equal(ruleColor(c, 'Team dinners', WED), YELLOW);
  assert.equal(ruleColor(c, 'Ice   cream social', WED), YELLOW);     // phrase, any spacing
  assert.equal(ruleColor(c, 'Paul OFF', WED), RED);
  assert.equal(ruleColor(c, 'Family meeting', WED), null, '"lily" must not match inside "family"');
  assert.equal(ruleColor(c, 'Office party', WED), null, '"off" must not match inside "office"');
  assert.equal(ruleColor(c, 'Lunchbox shopping', WED), null, 'no partial words');
});

test('first matching rule wins (order matters)', () => {
  const c = compileRules(RULES);
  assert.equal(ruleColor(c, 'Lily lunch with grandma', WED), PINK);
  const swapped = compileRules({ ...RULES, rules: [RULES.rules[1], RULES.rules[0]] });
  assert.equal(ruleColor(swapped, 'Lily lunch with grandma', WED), YELLOW);
});

test('weekend events are left alone unless weekends is on', () => {
  assert.equal(ruleColor(compileRules(RULES), 'Liliana birthday party', SAT), null);
  assert.equal(ruleColor(compileRules({ ...RULES, weekends: true }), 'Liliana birthday party', SAT), PINK);
});

test('regex characters in keywords are treated literally', () => {
  const c = compileRules({ rules: [{ color: RED, keywords: ['c++ club', 'q&a', '(test)'] }] });
  assert.equal(ruleColor(c, 'C++ club meeting', WED), RED);
  assert.equal(ruleColor(c, 'Parent Q&A night', WED), RED);
  assert.equal(ruleColor(c, 'cxx club', WED), null);
});

test('config: starter rules until the user saves their own; empty list respected', () => {
  const d = normalize({}).colorRules;
  assert.equal(d.weekends, false);
  assert.deepEqual(d.rules.map((r) => r.name), ['Appointments', 'Food']);
  assert.ok(d.rules[1].keywords.includes('dinner'));
  assert.deepEqual(normalize({ colorRules: { rules: [] } }).colorRules.rules, []);
  // Broken entries are dropped, not fatal.
  const cleaned = normalize({ colorRules: { rules: [{ color: 'pink', keywords: ['x'] }, { color: '#00ff00', keywords: [' ', 'golf '] }] } });
  assert.deepEqual(cleaned.colorRules.rules, [{ name: '', color: '#00FF00', keywords: ['golf'] }]);
});

test('settings: rules saved in order; keywords from a comma list; bad input named', () => {
  const raw = {};
  applySettings(raw, {
    colorRules: {
      weekends: true,
      rules: [{ name: 'Kids', color: '#e91e63', keywords: 'luciana, liliana,  lily , lucy' }, { name: 'Food', color: YELLOW, keywords: ['lunch'] }],
    },
  });
  assert.equal(raw.colorRules.weekends, true);
  assert.deepEqual(raw.colorRules.rules[0], { name: 'Kids', color: PINK, keywords: ['luciana', 'liliana', 'lily', 'lucy'] });
  assert.throws(() => applySettings({}, { colorRules: { rules: [{ color: 'pink', keywords: 'x' }] } }), { field: 'colorRules.0.color' });
  assert.throws(() => applySettings({}, { colorRules: { rules: [{ color: PINK, keywords: ' , ' }] } }), { field: 'colorRules.0.keywords' });
});

test('calendar: rules color timed events on weekdays; Google colors still win', async () => {
  const cfg = {
    timezone: 'America/New_York',
    calendars: [{ name: 'Fam', url: 'file:fixtures/recurring.ics', color: '#123456', enabled: true }],
    colorRules: { weekends: false, rules: [{ name: 'Music', color: PINK, keywords: ['piano'] }, { name: 'Sports', color: RED, keywords: ['soccer'] }] },
  };
  const eventColors = { version: 0, refresh: async () => {}, colorFor: (url, uid) => (uid === 'bookclub-weekly@test' ? '#0B8043' : null) };
  const svc = new CalendarService({ getConfig: () => cfg, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cr-')), rootDir: __dirname, eventColors });
  await svc.refreshAll();
  const NOW = new Date('2026-11-14T12:00:00-05:00');
  const ev = (date, title) => svc.getPayload('4weeks', NOW).days.find((d) => d.date === date).events.find((e) => e.title.startsWith(title));
  assert.equal(ev('2026-11-19', 'Piano lesson').color, PINK, 'Thursday piano → rule');
  assert.equal(ev('2026-11-14', 'Soccer practice').color, '#123456', 'Saturday soccer → weekends skipped');
  assert.equal(ev('2026-11-23', 'Book club').color, '#0B8043', 'own Google color beats rules');

  // Changing rules on the settings page shows up without waiting for a fetch.
  cfg.colorRules = { weekends: true, rules: cfg.colorRules.rules };
  assert.equal(ev('2026-11-14', 'Soccer practice').color, RED);
});
