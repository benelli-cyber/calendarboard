'use strict';
// Run with: npm test
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { GoogleColors, calendarIdFromUrl, signJwt, EVENT_COLORS } = require('../server/google-colors');
const { CalendarService } = require('../server/calendar');

const NOW = new Date('2026-11-14T12:00:00-05:00');
const CAL_ID = 'family@group.calendar.google.com';
const CAL_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CAL_ID)}/private-SECRET123/basic.ics`;
const CAL_COLOR = '#4FC3F7';
const ICS = fs.readFileSync(path.join(__dirname, 'fixtures', 'recurring.ics'), 'utf8');

// A real RSA key pair, like the one in a downloaded service account key file.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account',
  client_email: 'dashboard-robot@my-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};

function writeKeyFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-gkey-')), 'google-service-account.json');
  fs.writeFileSync(file, JSON.stringify(KEY));
  return file;
}

/** Verify an RS256 JWT with the public key and return its claims. */
function verifyJwt(jwt) {
  const [h, c, sig] = jwt.split('.');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
  assert.ok(ok, 'JWT signature must verify with the service account public key');
  return JSON.parse(Buffer.from(c, 'base64url').toString());
}

// Google's answer for the fixture calendar: colors for some occurrences only.
const API_ITEMS_PAGE1 = [
  { iCalUID: 'soccer-weekly@test', colorId: '11', start: { dateTime: '2026-11-14T09:00:00-05:00' } }, // Tomato, this Saturday only
  { iCalUID: 'soccer-weekly@test', start: { dateTime: '2026-11-21T09:00:00-05:00' } },               // no color → calendar color
];
const API_ITEMS_PAGE2 = [
  { iCalUID: 'piano-weekly@test', colorId: '7', start: { dateTime: '2026-11-19T18:00:00-05:00' } },  // the moved lesson: Peacock
  { iCalUID: 'grandma-bday@test', colorId: '5', start: { date: '2026-11-18' } },                     // all-day: Banana
];

/** Fake fetch for the iCal feed, Google sign-in, and the Calendar API. */
function fakeGoogle({ shared = true, signInOk = true, apiEnabled = true } = {}) {
  const calls = { token: 0, events: 0 };
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fn = async (url, opts = {}) => {
    if (url === CAL_URL) return { ok: true, status: 200, text: async () => ICS };
    if (url === KEY.token_uri) {
      calls.token++;
      const form = new URLSearchParams(opts.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const claims = verifyJwt(form.get('assertion'));
      assert.equal(claims.iss, KEY.client_email);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar.readonly');
      if (!signInOk) return json(401, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      return json(200, { access_token: 'tok-123', expires_in: 3600 });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/')) {
      calls.events++;
      assert.equal(opts.headers.Authorization, 'Bearer tok-123');
      assert.ok(url.includes(`/calendars/${encodeURIComponent(CAL_ID)}/events?`), 'calendar id taken from the iCal URL');
      if (!apiEnabled) {
        return json(403, { error: { message: 'Google Calendar API has not been used in project 123 before or it is disabled.' } });
      }
      if (!shared) return json(404, { error: { message: 'Not Found' } });
      const u = new URL(url);
      assert.equal(u.searchParams.get('singleEvents'), 'true');
      return u.searchParams.get('pageToken') === 'p2'
        ? json(200, { items: API_ITEMS_PAGE2 })
        : json(200, { items: API_ITEMS_PAGE1, nextPageToken: 'p2' });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function setup({ keyFile = writeKeyFile(), ...fake } = {}) {
  const fetchImpl = fakeGoogle(fake);
  const eventColors = new GoogleColors({ getKeyFile: () => keyFile, fetchImpl });
  const cfg = { timezone: 'America/New_York', calendars: [{ name: 'Family', url: CAL_URL, color: CAL_COLOR, enabled: true }] };
  const svc = new CalendarService({
    getConfig: () => cfg, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-gc-')), fetchImpl, eventColors,
  });
  /** color of the first event with this title on this date */
  const colorOf = (date, title) => {
    const day = svc.getPayload('4weeks', NOW).days.find((d) => d.date === date);
    return day.events.find((e) => e.title.startsWith(title))?.color;
  };
  return { svc, eventColors, fetchImpl, colorOf };
}

test('calendar id comes from the secret iCal address', () => {
  assert.equal(calendarIdFromUrl(CAL_URL), CAL_ID);
  assert.equal(calendarIdFromUrl('https://calendar.google.com/calendar/ical/me%40gmail.com/private-x/basic.ics'), 'me@gmail.com');
  assert.equal(calendarIdFromUrl('https://example.com/cal.ics'), null);
  assert.equal(calendarIdFromUrl('file:test/fixtures/recurring.ics'), null);
});

test('sign-in request is a valid RS256 JWT for read-only calendar access', () => {
  const claims = verifyJwt(signJwt(KEY, NOW));
  assert.equal(claims.aud, KEY.token_uri);
  assert.equal(claims.exp - claims.iat, 3600);
});

test('events get their own Google colors; others keep the calendar color', async () => {
  const { svc, colorOf } = setup();
  await svc.refreshAll();
  assert.equal(colorOf('2026-11-14', 'Soccer'), EVENT_COLORS[11], 'this Saturday: Tomato');
  assert.equal(colorOf('2026-11-21', 'Soccer'), CAL_COLOR, 'next Saturday: no color in Google');
  assert.equal(colorOf('2026-11-19', 'Piano lesson (moved)'), EVENT_COLORS[7], 'moved occurrence: Peacock');
  assert.equal(colorOf('2026-11-18', "Grandma's"), EVENT_COLORS[5], 'all-day: Banana');
  // Events with their own Google color are marked, so they keep it over the all-day color.
  const day = svc.getPayload('4weeks', NOW).days.find((d) => d.date === '2026-11-18');
  assert.equal(day.events.find((e) => e.title.startsWith("Grandma's")).ownColor, true);
  const sat = svc.getPayload('4weeks', NOW).days.find((d) => d.date === '2026-11-21');
  assert.equal(sat.events.find((e) => e.title === 'Soccer practice').ownColor, false);
  assert.equal(colorOf('2026-11-09', 'Book club'), CAL_COLOR, 'not in Google response');
});

test('second refresh reuses the sign-in token; both result pages are read', async () => {
  const { svc, fetchImpl, eventColors } = setup();
  await svc.refreshAll();
  await svc.refreshAll();
  assert.equal(fetchImpl.calls.token, 1);
  assert.equal(fetchImpl.calls.events, 4); // 2 pages × 2 refreshes
  assert.equal(eventColors.status().ok, true);
});

test('calendar not shared with the robot account: clear message, calendar still works', async () => {
  const { svc, eventColors, colorOf } = setup({ shared: false });
  await svc.refreshAll();
  assert.equal(colorOf('2026-11-14', 'Soccer'), CAL_COLOR);
  const st = eventColors.status();
  assert.equal(st.ok, false);
  assert.match(st.calendarErrors.Family, /not shared with dashboard-robot@my-project\.iam\.gserviceaccount\.com/);
});

test('Calendar API not enabled: Google\'s own message is shown (not "not shared")', async () => {
  const { svc, eventColors } = setup({ apiEnabled: false });
  await svc.refreshAll();
  assert.match(eventColors.status().calendarErrors.Family, /Google Calendar API has not been used/);
});

test('sign-in failure keeps the colors from the last good refresh', async () => {
  const { svc, eventColors, colorOf } = setup();
  await svc.refreshAll();
  eventColors.token = null;          // force a new sign-in…
  eventColors.fetchImpl = fakeGoogle({ signInOk: false }); // …which now fails
  await svc.refreshAll();
  assert.match(eventColors.status().error, /Google sign-in failed: Invalid JWT Signature/);
  assert.equal(colorOf('2026-11-14', 'Soccer'), EVENT_COLORS[11]);
});

test('no key file: feature off, Google never contacted', async () => {
  const { svc, eventColors, fetchImpl, colorOf } = setup({ keyFile: '/nonexistent/google-service-account.json' });
  await svc.refreshAll();
  assert.equal(fetchImpl.calls.token + fetchImpl.calls.events, 0);
  assert.equal(eventColors.status().configured, false);
  assert.equal(colorOf('2026-11-14', 'Soccer'), CAL_COLOR);
});

test('status and calendar payload never contain the key or the iCal secret', async () => {
  const { svc, eventColors } = setup();
  await svc.refreshAll();
  const out = JSON.stringify([eventColors.status(), svc.getPayload('4weeks', NOW)]);
  assert.ok(!out.includes('PRIVATE KEY'));
  assert.ok(!out.includes('tok-123'));
  assert.ok(!out.includes('SECRET123'));
});
