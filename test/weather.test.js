'use strict';
// Run with: npm test
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeNws, normalizeOpenMeteo, parseAlerts, iconFromNws, wmoInfo, feelsLikeF, WeatherService,
} = require('../server/weather');

const TZ = 'America/New_York';
// The NWS fixtures were captured on Sat Nov 14, 2026 around 4:30 PM Eastern.
const NOW = new Date('2026-11-14T16:40:00-05:00');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'weather', `${name}.json`), 'utf8'));

test('NWS icon URLs map to local icons', () => {
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/day/skc?size=medium'), 'clear-day');
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/night/sct?size=medium'), 'partly-night');
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/day/rain_showers,40?size=small'), 'rain');
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/night/rain_showers/snow?size=medium'), 'rain');
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/day/tsra_hi,20?size=medium'), 'thunder');
  assert.equal(iconFromNws('https://api.weather.gov/icons/land/day/fzra?size=medium'), 'sleet');
  assert.equal(iconFromNws(undefined), 'cloudy');
});

test('WMO codes map to icons and text', () => {
  assert.deepEqual(wmoInfo(0), ['clear', 'Clear']);
  assert.deepEqual(wmoInfo(63), ['rain', 'Rain']);
  assert.deepEqual(wmoInfo(66), ['sleet', 'Freezing Rain']);
  assert.deepEqual(wmoInfo(75), ['snow', 'Snow']);
  assert.deepEqual(wmoInfo(96), ['thunder', 'Thunderstorms']);
});

test('NWS "station" setting: current conditions from the station observation (°C → °F)', () => {
  const w = normalizeNws(
    { forecast: fx('nws-forecast'), hourly: fx('nws-hourly'), observation: fx('nws-observation') },
    { now: NOW, timezone: TZ, currentSource: 'station' },
  );
  assert.equal(w.source, 'nws');
  assert.equal(w.current.temp, 48);      // 9 °C
  assert.equal(w.current.feelsLike, 43); // wind chill 5.9 °C
  assert.equal(w.current.condition, 'Cloudy');
  assert.equal(w.current.icon, 'cloudy');
  assert.equal(w.current.windMph, 14);   // 22.2 km/h
  assert.equal(w.current.humidity, 50);
  assert.ok(w.current.observedAt);
});

test('NWS default: current conditions from the forecast for the exact location', () => {
  const w = normalizeNws(
    { forecast: fx('nws-forecast'), hourly: fx('nws-hourly'), observation: fx('nws-observation') },
    { now: NOW, timezone: TZ },
  );
  assert.equal(w.current.temp, 50);       // hourly forecast for 4–5 PM
  assert.equal(w.current.feelsLike, 45);  // NWS wind chill at 50 °F, 14 mph
  assert.equal(w.current.windMph, 14);
  assert.equal(w.current.observedAt, null);
  // The station reading is still reported separately (for the comparison script).
  assert.equal(w.stationReading.temp, 48);
});

test('feels-like: NWS wind chill and heat index', () => {
  assert.equal(Math.round(feelsLikeF(30, 10)), 21);      // NWS wind chill chart: 30 °F, 10 mph → 21
  assert.equal(Math.round(feelsLikeF(50, 2)), 50);       // too little wind: no wind chill
  assert.equal(Math.round(feelsLikeF(65, 20)), 65);      // mild: unchanged
  assert.equal(Math.round(feelsLikeF(90, 5, 60)), 100);  // NWS heat index chart: 90 °F, 60% → 100
});

test('NWS: today high/low and the next 5 days', () => {
  const w = normalizeNws(
    { forecast: fx('nws-forecast'), hourly: fx('nws-hourly'), observation: fx('nws-observation') },
    { now: NOW, timezone: TZ },
  );
  assert.deepEqual(w.today, { high: 52, low: 39, precipChance: 4 });
  assert.equal(w.daily.length, 5);
  assert.deepEqual(w.daily[0], {
    date: '2026-11-15', weekday: 'Sun', high: 54, low: 36, precipChance: 3, icon: 'snow',
    condition: 'Scattered Rain And Snow Showers',
  });
  assert.deepEqual(w.daily.map((d) => d.weekday), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
  assert.equal(w.daily[1].icon, 'clear-day');
  assert.ok(w.hourly.length > 0 && w.hourly.length <= 12);
});

test('NWS: stale or missing observation falls back to the hourly forecast', () => {
  const old = fx('nws-observation');
  old.properties.timestamp = '2026-11-14T08:00:00-05:00'; // 8+ hours old
  const w = normalizeNws({ forecast: fx('nws-forecast'), hourly: fx('nws-hourly'), observation: old }, { now: NOW, timezone: TZ });
  assert.equal(w.current.observedAt, null);
  assert.equal(typeof w.current.temp, 'number');

  const none = normalizeNws({ forecast: fx('nws-forecast'), hourly: null, observation: null }, { now: NOW, timezone: TZ });
  assert.equal(none.current.temp, 52); // first forecast period
});

test('NWS: after the daytime period ends, today high comes from hourly + current', () => {
  const forecast = fx('nws-forecast');
  forecast.properties.periods = forecast.properties.periods.slice(1); // starts with "Tonight"
  const w = normalizeNws({ forecast, hourly: fx('nws-hourly'), observation: fx('nws-observation') }, { now: NOW, timezone: TZ });
  assert.equal(w.today.low, 39);
  assert.equal(typeof w.today.high, 'number');
});

test('NWS: a forecast with no periods is an error (so we fall back)', () => {
  assert.throws(() => normalizeNws({ forecast: { properties: { periods: [] } } }, { now: NOW, timezone: TZ }));
});

// open-meteo.json is hand-written from Open-Meteo's documented response format
// (the live API was rate-limited from the sandbox where these tests were written).
test('Open-Meteo: normalized into the same shape', () => {
  const w = normalizeOpenMeteo(fx('open-meteo'), { now: NOW, timezone: TZ });
  assert.equal(w.source, 'open-meteo');
  assert.deepEqual(w.current, {
    temp: 50, feelsLike: 43, condition: 'Cloudy', icon: 'cloudy', windMph: 13, humidity: 51, observedAt: null,
  });
  assert.deepEqual(w.today, { high: 53, low: 39, precipChance: 35 });
  assert.equal(w.daily.length, 5);
  assert.deepEqual(w.daily[0], {
    date: '2026-11-15', weekday: 'Sun', high: 54, low: 36, precipChance: 20, icon: 'snow', condition: 'Snow',
  });
  assert.equal(w.daily[2].icon, 'clear-day');
  assert.equal(w.daily[4].icon, 'thunder');
});

test('alerts: only real, unexpired alerts, most severe first', () => {
  const alerts = parseAlerts(fx('nws-alerts'), NOW);
  assert.deepEqual(alerts.map((a) => a.event), ['Wind Advisory', 'Winter Weather Advisory']);
  assert.equal(alerts[0].severity, 'Severe');
  // At 8 PM the wind advisory (ends 7 PM) is gone.
  const later = parseAlerts(fx('nws-alerts'), new Date('2026-11-14T20:00:00-05:00'));
  assert.deepEqual(later.map((a) => a.event), ['Winter Weather Advisory']);
});

// ---------------------------------------------------------------------------
// Service with a fake fetch: routes URLs to fixtures, can fail on demand.
// ---------------------------------------------------------------------------

function fakeFetch(behavior) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ua: opts?.headers?.['User-Agent'] });
    const route = [
      ['open-meteo.com', 'open-meteo'], // first: its URL also contains "/forecast"
      ['/points/', 'nws-points'], ['/stations?', 'nws-stations'], ['/observations/latest', 'nws-observation'],
      ['/forecast/hourly', 'nws-hourly'], ['/forecast', 'nws-forecast'], ['/alerts/active', 'nws-alerts'],
    ].find(([frag]) => url.includes(frag));
    const name = route?.[1];
    if (!name || behavior.fail?.(url)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => fx(name) };
  };
  fn.calls = calls;
  return fn;
}

function makeService(fetchImpl, lat = 38.8894, lon = -77.0352, currentSource = 'station') {
  const cfg = { timezone: TZ, weather: { lat, lon, userAgent: 'test-agent (test)', currentSource } };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-wx-'));
  return { svc: new WeatherService({ getConfig: () => cfg, cacheDir, fetchImpl }), cfg, cacheDir };
}

test('service: NWS success, sends User-Agent, caches the /points lookup', async () => {
  const f = fakeFetch({});
  const { svc } = makeService(f);
  await svc.refreshWeather(NOW);
  await svc.refreshAlerts(NOW);
  const p = svc.getPayload(NOW);
  assert.equal(p.source, 'nws');
  assert.equal(p.current.temp, 48);
  assert.equal(p.alerts.length, 2);
  assert.equal(p.stale, false);
  assert.ok(f.calls.filter((c) => c.url.includes('weather.gov')).every((c) => c.ua === 'test-agent (test)'));

  await svc.refreshWeather(NOW);
  assert.equal(f.calls.filter((c) => c.url.includes('/points/')).length, 1, '/points resolved only once');
});

test('service: forecast setting is used, and the nearest station is named', async () => {
  const { svc } = makeService(fakeFetch({}), 38.8894, -77.0352, 'forecast');
  await svc.refreshWeather(NOW);
  const p = svc.getPayload(NOW);
  assert.equal(p.current.temp, 50);
  assert.deepEqual(p.station, { id: 'KDCA', name: fx('nws-stations').features[0].properties.name });
});

test('service: switching forecast ↔ station on the settings page refetches', async () => {
  const f = fakeFetch({});
  const { svc, cfg } = makeService(f, 38.8894, -77.0352, 'forecast');
  await svc.refreshWeather(NOW);
  svc.timers = [1]; // pretend the refresh timers are running
  cfg.weather.currentSource = 'station';
  const before = f.calls.length;
  svc.onConfigChange();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(f.calls.length > before, 'weather fetched again');
  assert.equal(svc.weather.currentSource, 'station');
});

test('service: a saved lookup without a station name is refreshed once', async () => {
  const f = fakeFetch({});
  const { svc } = makeService(f);
  svc.points = { locationKey: svc.locationKey(), forecast: 'x', forecastHourly: 'y', stations: ['KDCA'] }; // old snapshot
  await svc.refreshWeather(NOW);
  assert.equal(f.calls.filter((c) => c.url.includes('/points/')).length, 1);
  assert.ok(svc.getPayload(NOW).station.name);
});

test('service: NWS down → Open-Meteo fallback', async () => {
  const { svc } = makeService(fakeFetch({ fail: (u) => u.includes('weather.gov') }));
  await svc.refreshWeather(NOW);
  const p = svc.getPayload(NOW);
  assert.equal(p.source, 'open-meteo');
  assert.equal(p.current.temp, 50);
});

test('service: both down → keeps last good data, marks stale later', async () => {
  let down = false;
  const { svc, cacheDir } = makeService(fakeFetch({ fail: () => down }));
  await svc.refreshWeather(NOW);
  down = true;
  await svc.refreshWeather(new Date(NOW.getTime() + 15 * 60 * 1000));
  let p = svc.getPayload(NOW);
  assert.equal(p.source, 'nws');
  assert.equal(p.current.temp, 48);
  assert.ok(p.error);

  p = svc.getPayload(new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.equal(p.stale, true);
  assert.equal(p.current.temp, 48, 'still shows last good data');

  // A restart restores the snapshot from disk.
  const svc2 = new WeatherService({
    getConfig: () => ({ timezone: TZ, weather: { lat: 38.8894, lon: -77.0352 } }), cacheDir, fetchImpl: fakeFetch({ fail: () => true }),
  });
  svc2.loadSnapshots();
  assert.equal(svc2.getPayload(NOW).current.temp, 48);
});

test('service: alerts fetch failure keeps the last list but drops expired alerts', async () => {
  let down = false;
  const { svc } = makeService(fakeFetch({ fail: (u) => down && u.includes('/alerts') }));
  await svc.refreshAlerts(NOW);
  down = true;
  await svc.refreshAlerts(NOW);
  assert.equal(svc.getPayload(NOW).alerts.length, 2);
  assert.equal(svc.getPayload(new Date('2026-11-14T20:00:00-05:00')).alerts.length, 1);
});

test('service: location not set → configured:false, no requests', async () => {
  const f = fakeFetch({});
  const { svc } = makeService(f, 0, 0);
  await svc.refreshWeather(NOW);
  assert.deepEqual(svc.getPayload(NOW), { configured: false });
  assert.equal(f.calls.length, 0);
});

test('service: data cached for another location is ignored', async () => {
  const { svc, cfg } = makeService(fakeFetch({}));
  await svc.refreshWeather(NOW);
  cfg.weather.lat = 40.7128; cfg.weather.lon = -74.006; // moved
  const p = svc.getPayload(NOW);
  assert.equal(p.current, null);
  assert.equal(p.stale, true);
});
