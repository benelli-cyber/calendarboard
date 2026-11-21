'use strict';
// Run with: npm test
// Day boundaries depend on process-local time, exactly as on the server.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildDays, viewRange, parseIcs, CalendarService, scrub } = require('../server/calendar');

const TZ = 'America/New_York';
const NOW = new Date('2026-11-14T12:00:00-05:00'); // Saturday; DST ended Nov 1
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.ics`), 'utf8');

function agendaFor(...names) {
  const sources = names.map((n) => ({ name: n, color: '#ffffff', parsed: parseIcs(fixture(n)) }));
  return buildDays(sources, { now: NOW, dayCount: 7, timezone: TZ }); // today + 6 days
}
/** Map of "YYYY-MM-DD" → ["time | title", ...] for compact assertions. */
function summary(days) {
  return Object.fromEntries(days.map((d) => [d.date, d.events.map((e) => `${e.time} | ${e.title}`)]));
}

test('window is today + 6 days with labels', () => {
  const days = agendaFor('cancelled');
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2026-11-14');
  assert.equal(days[0].relative, 'Today');
  assert.equal(days[1].relative, 'Tomorrow');
  assert.equal(days[2].weekday, 'Monday');
  assert.equal(days[6].date, '2026-11-20');
});

test('recurring: weekly series keeps local time across DST change', () => {
  const s = summary(agendaFor('recurring'));
  assert.ok(s['2026-11-14'].includes('9:00 AM | Soccer practice'));
});

test('recurring: EXDATE removes an instance, RECURRENCE-ID moves one', () => {
  const s = summary(agendaFor('recurring'));
  assert.ok(!s['2026-11-17'].some((e) => e.includes('Piano')), 'Tue Nov 17 excluded');
  assert.deepEqual(s['2026-11-19'].filter((e) => e.includes('Piano')), ['6:00 PM | Piano lesson (moved)']);
});

test('recurring: cancelled override removes just that instance', () => {
  const s = summary(agendaFor('recurring'));
  assert.ok(!s['2026-11-16'].some((e) => e.includes('Book club')));
});

test('recurring: COUNT limit and yearly all-day', () => {
  const s = summary(agendaFor('recurring'));
  assert.ok(s['2026-11-14'].includes('8:00 AM | Take vitamins'));
  assert.ok(s['2026-11-15'].includes('8:00 AM | Take vitamins'));
  assert.ok(!s['2026-11-16'].some((e) => e.includes('vitamins')), 'COUNT=3 ends on the 15th');
  assert.deepEqual(s['2026-11-18'], ["All day | Grandma's birthday"]);
});

test('all-day: single day appears on that day only', () => {
  const s = summary(agendaFor('allday-multiday'));
  assert.deepEqual(s['2026-11-16'], ['All day | Teacher workday - no school']);
  assert.ok(!s['2026-11-17'].some((e) => e.includes('Teacher')), 'DTEND is exclusive');
});

test('multi-day: all-day event shows on each day with "Day N of M"', () => {
  const days = agendaFor('allday-multiday');
  const notes = (date, title) => days.find((d) => d.date === date).events.find((e) => e.title === title)?.note;
  assert.equal(notes('2026-11-14', 'Family visit'), 'Day 3 of 4'); // started before today
  assert.equal(notes('2026-11-15', 'Family visit'), 'Day 4 of 4');
  assert.equal(notes('2026-11-16', 'Family visit'), undefined);
  assert.equal(notes('2026-11-19', 'Beach trip'), 'Day 1 of 3');
  assert.equal(notes('2026-11-20', 'Beach trip'), 'Day 2 of 3');
});

test('multi-day: timed event crossing midnight shows start and "Until"', () => {
  const s = summary(agendaFor('allday-multiday'));
  assert.ok(s['2026-11-17'].includes('10:00 PM | Red-eye flight'));
  assert.ok(s['2026-11-18'].includes('Until 6:30 AM | Red-eye flight'));
});

test('past events are not shown', () => {
  const all = agendaFor('allday-multiday').flatMap((d) => d.events.map((e) => e.title));
  assert.ok(!all.includes('Already happened'));
});

test('cancelled single event is hidden, confirmed one is shown', () => {
  const s = summary(agendaFor('cancelled'));
  assert.deepEqual(s['2026-11-15'], ['11:00 AM | Haircut']);
});

test('timezones: UTC and Pacific converted to Eastern, late events stay on local day', () => {
  const s = summary(agendaFor('timezones'));
  assert.ok(s['2026-11-15'].includes('12:00 PM | Call with Grandpa'));
  assert.ok(s['2026-11-16'].includes('12:00 PM | Webinar'));
  assert.ok(s['2026-11-14'].includes('11:30 PM | Late movie'), 'not pushed to Sunday by UTC');
});

test('all-day events sort before timed events', () => {
  const today = agendaFor('allday-multiday', 'recurring')[0].events;
  assert.equal(today[0].time, 'All day');
});

test('month view: whole Sun–Sat weeks covering the month', () => {
  // Nov 2026: the 1st is a Sunday, the 30th a Monday → Nov 1 – Dec 5 (5 weeks)
  let r = viewRange('month', NOW, TZ);
  assert.equal(r.title, 'November 2026');
  assert.equal(r.start.toDateString(), 'Sun Nov 01 2026');
  assert.equal(r.dayCount, 35);
  // Aug 2026: the 1st is a Saturday → Jul 26 – Sep 5 (6 weeks)
  r = viewRange('month', new Date('2026-08-15T12:00:00-04:00'), TZ);
  assert.equal(r.start.toDateString(), 'Sun Jul 26 2026');
  assert.equal(r.dayCount, 42);
  // Feb 2026: starts Sunday, 28 days → exactly 4 weeks
  assert.equal(viewRange('month', new Date('2026-02-10T12:00:00-05:00'), TZ).dayCount, 28);
});

test('week view: rolling 7 days starting today', () => {
  const r = viewRange('week', NOW, TZ);
  assert.equal(r.start.toDateString(), 'Sat Nov 14 2026');
  assert.equal(r.dayCount, 7);
  assert.equal(r.title, 'Nov 14 – 20, 2026');
  const cross = viewRange('week', new Date('2026-11-27T12:00:00-05:00'), TZ);
  assert.equal(cross.title, 'Nov 27 – Dec 3, 2026');
});

test('3-week view: this Sun–Sat week plus the next two', () => {
  const r = viewRange('3weeks', NOW, TZ); // NOW is Sat Nov 14
  assert.equal(r.start.toDateString(), 'Sun Nov 08 2026');
  assert.equal(r.dayCount, 21);
  assert.equal(r.title, 'Nov 8 – 28, 2026');
  const cross = viewRange('3weeks', new Date('2026-11-27T12:00:00-05:00'), TZ);
  assert.equal(cross.start.toDateString(), 'Sun Nov 22 2026');
  assert.equal(cross.title, 'Nov 22 – Dec 12, 2026');
  // Sunday is the first day of its own week
  assert.equal(viewRange('3weeks', new Date('2026-11-15T08:00:00-05:00'), TZ).start.toDateString(), 'Sun Nov 15 2026');
});

test('3-week payload: 21 days, next month not dimmed, events placed', async () => {
  const cfg = { timezone: TZ, calendars: [{ name: 'Fam', url: 'file:fixtures/recurring.ics', color: '#123456', enabled: true }] };
  const svc = new CalendarService({ getConfig: () => cfg, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-3w-')), rootDir: __dirname });
  await svc.refreshAll();
  const p = svc.getPayload('3weeks', new Date('2026-11-27T12:00:00-05:00'));
  assert.equal(p.view, '3weeks');
  assert.equal(p.days.length, 21);
  assert.ok(p.days.every((d) => d.inMonth), 'December days are not dimmed in the 3-week view');
  assert.ok(p.days.find((d) => d.date === '2026-12-05').events.some((e) => e.title === 'Soccer practice'));
});

test('month grid: flags for today, past days, and days outside the month', () => {
  const r = viewRange('month', NOW, TZ);
  const sources = ['recurring', 'allday-multiday'].map((n) => ({ name: n, color: '#fff', parsed: parseIcs(fixture(n)) }));
  const days = buildDays(sources, { now: NOW, start: r.start, dayCount: r.dayCount, focusMonthOf: NOW, timezone: TZ });
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  assert.equal(byDate['2026-11-14'].isToday, true);
  assert.equal(byDate['2026-11-13'].isPast, true);
  assert.equal(byDate['2026-11-15'].isPast, false);
  assert.equal(byDate['2026-12-01'].inMonth, false);
  // Past days of the month still show their events (e.g. the event on Nov 10).
  assert.ok(byDate['2026-11-10'].events.some((e) => e.title === 'Already happened'));
  // Recurring weekly event appears every Saturday in the grid, including past ones.
  assert.ok(['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05']
    .every((d) => byDate[d].events.some((e) => e.title === 'Soccer practice')));
  // Compact time labels for month cells.
  const piano = byDate['2026-11-19'].events.find((e) => e.title.startsWith('Piano'));
  assert.equal(piano.shortTime, '6p');
  assert.equal(byDate['2026-11-18'].events.find((e) => e.title === 'Red-eye flight').shortTime, '→6:30a');
});

test('scrub() removes URLs from error messages', () => {
  assert.equal(scrub('fail https://calendar.google.com/x/private-abc/basic.ics now'), 'fail [url] now');
});

test('resilience: failed fetch keeps last good data; URLs never leak', async (t) => {
  let fail = false;
  const server = http.createServer((req, res) => {
    if (fail) { res.writeHead(500); return res.end('oops'); }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(fixture('cancelled'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const url = `http://127.0.0.1:${server.address().port}/private-SECRET/basic.ics`;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cal-'));
  const cfg = { timezone: TZ, calendarDaysAhead: 7, calendars: [{ name: 'Fam', url, color: '#ff0000', enabled: true }] };
  const svc = new CalendarService({ getConfig: () => cfg, cacheDir, rootDir: __dirname });

  await svc.refreshAll();
  let payload = svc.getPayload('month', NOW);
  assert.ok(JSON.stringify(payload).includes('Haircut'));

  // Now the server fails (e.g. Google down / network out).
  fail = true;
  await svc.refreshAll();
  payload = svc.getPayload('month', NOW);
  assert.ok(JSON.stringify(payload).includes('Haircut'), 'still has last good data');
  assert.equal(payload.calendars[0].error, 'HTTP 500');

  // A garbage (non-iCal) 200 response must not blank the calendar either.
  server.removeAllListeners('request');
  server.on('request', (req, res) => { res.writeHead(200); res.end('<html>error</html>'); });
  await svc.refreshAll();
  assert.ok(JSON.stringify(svc.getPayload('month', NOW)).includes('Haircut'));

  // After a restart, the disk snapshot restores the data before any fetch.
  const svc2 = new CalendarService({ getConfig: () => cfg, cacheDir, rootDir: __dirname });
  svc2.loadSnapshots();
  assert.ok(JSON.stringify(svc2.getPayload('month', NOW)).includes('Haircut'));

  // Stale flag: 31 minutes after last success.
  const later = new Date(Date.now() + 31 * 60 * 1000);
  assert.equal(svc.getPayload('month', later).stale, true);

  // The secret URL must never appear in the API payload.
  assert.ok(!JSON.stringify(svc.getPayload('month', NOW)).includes('SECRET'));
});

test('unreachable host is handled without throwing', async () => {
  const cfg = {
    timezone: TZ, calendarDaysAhead: 7,
    calendars: [{ name: 'Bad', url: 'http://127.0.0.1:1/nope.ics', color: '#ff0000', enabled: true }],
  };
  const svc = new CalendarService({ getConfig: () => cfg, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cal-')) });
  await svc.refreshAll();
  const p = svc.getPayload('month', NOW);
  assert.equal(p.days.length, 35); // still renders a full (empty) month grid
  assert.equal(p.updatedAt, null);
  assert.equal(p.stale, true);
  assert.ok(p.calendars[0].error);
});
