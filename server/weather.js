'use strict';
/**
 * Weather: National Weather Service (primary) with Open-Meteo as a fallback.
 *
 * Two layers, like calendar.js:
 *   normalizeNws() / normalizeOpenMeteo() / parseAlerts()
 *       Pure functions that turn API responses into ONE common shape, so the
 *       front end doesn't care where the data came from. Tested with fixtures.
 *   WeatherService
 *       Fetches every 15 min (alerts every 5 min), falls back to Open-Meteo
 *       when NWS fails or times out, and always keeps the last good result
 *       (in memory + data/weather.json) so the display never goes blank.
 *
 * Common shape returned by GET /api/weather:
 *   {
 *     configured, source: 'nws' | 'open-meteo', updatedAt, stale,
 *     current: { temp, feelsLike, condition, icon, windMph, humidity, observedAt },
 *     today:   { high, low, precipChance },
 *     daily:   [ { date, weekday, high, low, precipChance, icon, condition } ]  // next 5 days
 *     hourly:  [ { time, temp, precipChance, icon } ]                          // next 12 h (NWS only)
 *     alerts:  [ { id, event, severity, headline, description, ends } ]
 *   }
 * Temperatures are °F, wind is mph, all rounded to whole numbers.
 * `icon` is the name of an SVG in public/icons/ (e.g. "rain" → icons/rain.svg).
 */
const fs = require('fs');
const path = require('path');
const { startOfDay, dayKey } = require('./dates');

const NWS_BASE = 'https://api.weather.gov';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 10_000;          // NWS can hang; give up and fall back after 10 s
const WEATHER_INTERVAL_MS = 15 * 60 * 1000;
const ALERTS_INTERVAL_MS = 5 * 60 * 1000;   // alerts are time-critical, so check more often
const STALE_AFTER_MS = 45 * 60 * 1000;      // three missed refreshes
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;
const FORECAST_DAYS = 5;
const HOURLY_HOURS = 12;

// ---------------------------------------------------------------------------
// Icons and conditions
// ---------------------------------------------------------------------------

/**
 * NWS icon URLs look like  https://api.weather.gov/icons/land/night/rain_showers,40/snow?size=medium
 * The first code after day/night ("rain_showers") is the main condition.
 * Local icon names: clear, partly, cloudy, rain, thunder, snow, sleet, fog, wind
 * (clear/partly get a -day or -night suffix).
 */
const NWS_ICON_MAP = {
  skc: 'clear', few: 'clear', hot: 'clear', cold: 'clear',
  sct: 'partly', bkn: 'partly',
  ovc: 'cloudy',
  wind_skc: 'wind', wind_few: 'wind', wind_sct: 'wind', wind_bkn: 'wind', wind_ovc: 'wind',
  rain: 'rain', rain_showers: 'rain', rain_showers_hi: 'rain',
  tsra: 'thunder', tsra_sct: 'thunder', tsra_hi: 'thunder', tornado: 'thunder',
  hurricane: 'thunder', tropical_storm: 'thunder',
  snow: 'snow', blizzard: 'snow',
  rain_snow: 'sleet', rain_sleet: 'sleet', snow_sleet: 'sleet', sleet: 'sleet',
  fzra: 'sleet', rain_fzra: 'sleet', snow_fzra: 'sleet',
  fog: 'fog', haze: 'fog', smoke: 'fog', dust: 'fog',
};

/** Add -day/-night to icons that differ by time of day. */
function withDayNight(icon, isDay) {
  return icon === 'clear' || icon === 'partly' ? `${icon}-${isDay ? 'day' : 'night'}` : icon;
}

function iconFromNws(url) {
  const m = /\/icons\/land\/(day|night)\/([^/?,]+)/.exec(url || '');
  if (!m) return 'cloudy';
  return withDayNight(NWS_ICON_MAP[m[2]] || 'cloudy', m[1] === 'day');
}

function isDayFromNws(url) {
  return !/\/icons\/land\/night\//.test(url || '');
}

/** WMO weather codes used by Open-Meteo → [local icon, description]. */
function wmoInfo(code) {
  if (code === 0) return ['clear', 'Clear'];
  if (code === 1) return ['clear', 'Mostly Clear'];
  if (code === 2) return ['partly', 'Partly Cloudy'];
  if (code === 3) return ['cloudy', 'Cloudy'];
  if (code === 45 || code === 48) return ['fog', 'Fog'];
  if (code === 56 || code === 57 || code === 66 || code === 67) return ['sleet', 'Freezing Rain'];
  if (code >= 51 && code <= 55) return ['rain', 'Drizzle'];
  if (code >= 61 && code <= 65) return ['rain', 'Rain'];
  if (code >= 71 && code <= 77) return ['snow', 'Snow'];
  if (code >= 80 && code <= 82) return ['rain', 'Rain Showers'];
  if (code === 85 || code === 86) return ['snow', 'Snow Showers'];
  if (code >= 95) return ['thunder', 'Thunderstorms'];
  return ['cloudy', 'Cloudy'];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const cToF = (c) => (c == null ? null : (c * 9) / 5 + 32);
const kmhToMph = (k) => (k == null ? null : k / 1.609344);
/** NWS wraps numbers as { value, unitCode }; value may be null. */
const qv = (x) => (x && typeof x.value === 'number' ? x.value : null);
const maxOf = (nums) => {
  const v = nums.filter((n) => typeof n === 'number');
  return v.length ? Math.max(...v) : null;
};
const minOf = (nums) => {
  const v = nums.filter((n) => typeof n === 'number');
  return v.length ? Math.min(...v) : null;
};

function weekdayShort(date, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
}

// ---------------------------------------------------------------------------
// Normalizers (pure)
// ---------------------------------------------------------------------------

/**
 * @param {{forecast:object, hourly?:object, observation?:object}} raw  NWS JSON responses
 * @param {{now?:Date, timezone:string}} opts
 */
function normalizeNws({ forecast, hourly, observation }, { now = new Date(), timezone }) {
  const periods = forecast?.properties?.periods || [];
  if (!periods.length) throw new Error('NWS forecast had no periods');
  const hours = (hourly?.properties?.periods || []).filter((h) => new Date(h.endTime || h.startTime) > now);

  // Group the 12-hour forecast periods by local date: { day, night }.
  const byDay = new Map();
  for (const p of periods) {
    const key = dayKey(new Date(p.startTime));
    if (!byDay.has(key)) byDay.set(key, { day: null, night: null });
    byDay.get(key)[p.isDaytime ? 'day' : 'night'] = p;
  }
  const pop = (p) => qv(p?.probabilityOfPrecipitation);

  // --- Current conditions: a recent station observation, else the current hourly forecast.
  const obs = observation?.properties;
  const obsTempC = qv(obs?.temperature);
  const obsFresh = obs && obsTempC != null && now - new Date(obs.timestamp) < MAX_OBSERVATION_AGE_MS;
  const hourNow = hours[0];
  let current;
  if (obsFresh) {
    const feelsC = qv(obs.heatIndex) ?? qv(obs.windChill) ?? obsTempC;
    current = {
      temp: round(cToF(obsTempC)),
      feelsLike: round(cToF(feelsC)),
      condition: obs.textDescription || hourNow?.shortForecast || '',
      icon: obs.icon ? iconFromNws(obs.icon) : iconFromNws(hourNow?.icon),
      windMph: round(kmhToMph(qv(obs.windSpeed))),
      humidity: round(qv(obs.relativeHumidity)),
      observedAt: obs.timestamp,
    };
  } else if (hourNow) {
    current = {
      temp: round(hourNow.temperature),
      feelsLike: round(hourNow.temperature),
      condition: hourNow.shortForecast || '',
      icon: iconFromNws(hourNow.icon),
      windMph: round(parseFloat(hourNow.windSpeed)),
      humidity: round(qv(hourNow.relativeHumidity)),
      observedAt: null, // forecast, not an observation
    };
  } else {
    const p = periods[0];
    current = {
      temp: round(p.temperature), feelsLike: round(p.temperature), condition: p.shortForecast || '',
      icon: iconFromNws(p.icon), windMph: round(parseFloat(p.windSpeed)), humidity: null, observedAt: null,
    };
  }

  // --- Today: the daytime period's high and tonight's low. Late in the day the
  // daytime period is gone, so fall back to the hourly temps for the rest of today.
  const todayKey = dayKey(now);
  const today = byDay.get(todayKey) || {};
  const todayHours = hours.filter((h) => dayKey(new Date(h.startTime)) === todayKey).map((h) => h.temperature);
  const todayInfo = {
    high: round(today.day?.temperature ?? maxOf([...todayHours, current.temp])),
    low: round(today.night?.temperature ?? minOf(todayHours)),
    precipChance: round(maxOf([pop(today.day), pop(today.night)]) ?? maxOf(hours.slice(0, 12).map(pop))),
  };

  // --- Next 5 days, starting tomorrow.
  const daily = [];
  for (let i = 1; i <= FORECAST_DAYS; i++) {
    const date = startOfDay(now, i);
    const d = byDay.get(dayKey(date));
    if (!d) continue;
    const main = d.day || d.night;
    daily.push({
      date: dayKey(date),
      weekday: weekdayShort(date, timezone),
      high: round(d.day?.temperature),
      low: round(d.night?.temperature),
      precipChance: round(maxOf([pop(d.day), pop(d.night)])),
      icon: iconFromNws(main.icon),
      condition: main.shortForecast || '',
    });
  }

  const hourlyOut = hours.slice(0, HOURLY_HOURS).map((h) => ({
    time: h.startTime,
    temp: round(h.temperature),
    precipChance: round(pop(h)),
    icon: iconFromNws(h.icon),
  }));

  return { source: 'nws', current, today: todayInfo, daily, hourly: hourlyOut };
}

/**
 * @param {object} json  Open-Meteo /v1/forecast response (requested in °F / mph)
 * @param {{now?:Date, timezone:string}} opts
 */
function normalizeOpenMeteo(json, { now = new Date(), timezone }) {
  const c = json?.current;
  const d = json?.daily;
  if (!c || !d || !Array.isArray(d.time)) throw new Error('Open-Meteo response missing current/daily data');

  const [icon, condition] = wmoInfo(c.weather_code);
  const current = {
    temp: round(c.temperature_2m),
    feelsLike: round(c.apparent_temperature ?? c.temperature_2m),
    condition,
    icon: withDayNight(icon, c.is_day !== 0),
    windMph: round(c.wind_speed_10m),
    humidity: round(c.relative_humidity_2m),
    observedAt: null, // model data, not a station observation
  };

  let t = d.time.indexOf(dayKey(now));
  if (t < 0) t = 0;
  const today = {
    high: round(d.temperature_2m_max?.[t]),
    low: round(d.temperature_2m_min?.[t]),
    precipChance: round(d.precipitation_probability_max?.[t]),
  };

  const daily = [];
  for (let i = t + 1; i <= t + FORECAST_DAYS && i < d.time.length; i++) {
    const [y, m, day] = d.time[i].split('-').map(Number);
    const date = new Date(y, m - 1, day);
    const [dIcon, dCond] = wmoInfo(d.weather_code?.[i]);
    daily.push({
      date: d.time[i],
      weekday: weekdayShort(date, timezone),
      high: round(d.temperature_2m_max?.[i]),
      low: round(d.temperature_2m_min?.[i]),
      precipChance: round(d.precipitation_probability_max?.[i]),
      icon: withDayNight(dIcon, true),
      condition: dCond,
    });
  }

  return { source: 'open-meteo', current, today, daily, hourly: [] };
}

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

/** Real (not test), not-yet-ended alerts, most severe first. */
function parseAlerts(json, now = new Date()) {
  return (json?.features || [])
    .map((f) => f.properties || {})
    .filter((p) => p.status === 'Actual' && p.messageType !== 'Cancel')
    .map((p) => ({
      id: p.id || p.headline,
      event: p.event || 'Weather Alert',
      severity: p.severity || 'Unknown',
      headline: p.headline || '',
      description: String(p.description || '').slice(0, 400),
      ends: p.ends || p.expires || null,
    }))
    .filter((a) => !a.ends || new Date(a.ends) > now)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
}

// ---------------------------------------------------------------------------
// Service: fetching, fallback, caching
// ---------------------------------------------------------------------------

class WeatherService {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig
   * @param {string} opts.cacheDir       where weather.json / weather-points.json snapshots go
   * @param {Function} [opts.fetchImpl]  injectable fetch (tests)
   */
  constructor({ getConfig, cacheDir, fetchImpl }) {
    this.getConfig = getConfig;
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl || fetch;
    this.points = null;   // cached NWS /points lookup for the configured location
    this.weather = null;  // { locationKey, data, updatedAt: Date }
    this.weatherError = null;
    this.alerts = null;   // { locationKey, list, updatedAt: Date }
    this.timers = [];
  }

  /** "38.8894,-77.0352" – NWS wants at most 4 decimals. null if not set up yet. */
  locationKey() {
    const { lat, lon } = this.getConfig().weather || {};
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
    return `${la.toFixed(4).replace(/\.?0+$/, '')},${lo.toFixed(4).replace(/\.?0+$/, '')}`;
  }

  async getJson(url, { nws = false } = {}) {
    const headers = { Accept: nws ? 'application/geo+json' : 'application/json' };
    // NWS requires a descriptive User-Agent identifying the app.
    if (nws) headers['User-Agent'] = this.getConfig().weather.userAgent || 'family-dashboard';
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  // ----- snapshots (so a restart shows weather immediately) -----

  snapshotPath(name) {
    return path.join(this.cacheDir, name);
  }

  readSnapshot(name) {
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  writeSnapshot(name, obj) {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = this.snapshotPath(`${name}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.snapshotPath(name));
    } catch (err) {
      console.warn(`[weather] Could not write ${name}: ${err.message}`);
    }
  }

  loadSnapshots() {
    const key = this.locationKey();
    const w = this.readSnapshot('weather.json');
    if (w && w.locationKey === key) this.weather = { ...w, updatedAt: new Date(w.updatedAt) };
    const p = this.readSnapshot('weather-points.json');
    if (p && p.locationKey === key) this.points = p;
  }

  // ----- NWS -----

  /** Look up the forecast URLs and nearby stations for our lat/lon (cached until the location changes). */
  async resolvePoints() {
    const key = this.locationKey();
    if (this.points?.locationKey === key) return this.points;
    const p = (await this.getJson(`${NWS_BASE}/points/${key}`, { nws: true })).properties;
    let stations = [];
    try {
      const st = await this.getJson(`${p.observationStations}?limit=5`, { nws: true });
      stations = (st.features || []).map((f) => f.properties.stationIdentifier).filter(Boolean);
    } catch (err) {
      console.warn(`[weather] Could not list NWS stations: ${err.message}`);
    }
    this.points = { locationKey: key, forecast: p.forecast, forecastHourly: p.forecastHourly, stations };
    this.writeSnapshot('weather-points.json', this.points);
    return this.points;
  }

  /** Latest observation from the nearest station that has a recent temperature. */
  async fetchObservation(stations, now) {
    for (const id of stations.slice(0, 3)) {
      try {
        const obs = await this.getJson(`${NWS_BASE}/stations/${id}/observations/latest`, { nws: true });
        const p = obs.properties;
        if (qv(p?.temperature) != null && now - new Date(p.timestamp) < MAX_OBSERVATION_AGE_MS) return obs;
      } catch {
        /* try the next station */
      }
    }
    return null; // normalizeNws falls back to the hourly forecast
  }

  async fetchNws(now) {
    const pts = await this.resolvePoints();
    try {
      const [forecast, hourly, observation] = await Promise.all([
        this.getJson(pts.forecast, { nws: true }),
        this.getJson(pts.forecastHourly, { nws: true }).catch(() => null),
        this.fetchObservation(pts.stations, now),
      ]);
      return normalizeNws({ forecast, hourly, observation }, { now, timezone: this.getConfig().timezone });
    } catch (err) {
      this.points = null; // grid may have changed; look it up again next time
      throw err;
    }
  }

  // ----- Open-Meteo -----

  async fetchOpenMeteo(now) {
    const [lat, lon] = this.locationKey().split(',');
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      timezone: this.getConfig().timezone,
      forecast_days: '7',
    });
    const json = await this.getJson(`${OPEN_METEO_URL}?${params}`);
    return normalizeOpenMeteo(json, { now, timezone: this.getConfig().timezone });
  }

  // ----- refresh loops -----

  async refreshWeather(now = new Date()) {
    const key = this.locationKey();
    if (!key) return;
    let data;
    try {
      data = await this.fetchNws(now);
    } catch (nwsErr) {
      console.warn(`[weather] NWS failed (${nwsErr.message}); trying Open-Meteo`);
      try {
        data = await this.fetchOpenMeteo(now);
      } catch (omErr) {
        this.weatherError = `NWS: ${nwsErr.message}; Open-Meteo: ${omErr.message}`;
        console.warn(`[weather] Open-Meteo failed too (${omErr.message}); keeping last good data`);
        return;
      }
    }
    this.weather = { locationKey: key, data, updatedAt: now };
    this.weatherError = null;
    this.writeSnapshot('weather.json', this.weather);
  }

  async refreshAlerts(now = new Date()) {
    const key = this.locationKey();
    if (!key) return;
    try {
      const json = await this.getJson(`${NWS_BASE}/alerts/active?point=${key}`, { nws: true });
      this.alerts = { locationKey: key, list: parseAlerts(json, now), updatedAt: now };
    } catch (err) {
      // Keep the previous list; expired alerts are still filtered out in getPayload().
      console.warn(`[weather] Alerts fetch failed (keeping last list): ${err.message}`);
    }
  }

  start() {
    this.loadSnapshots();
    this.refreshWeather();
    this.refreshAlerts();
    this.timers.push(setInterval(() => this.refreshWeather(), WEATHER_INTERVAL_MS));
    this.timers.push(setInterval(() => this.refreshAlerts(), ALERTS_INTERVAL_MS));
    this.timers.forEach((t) => t.unref?.());
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  /** JSON for GET /api/weather. */
  getPayload(now = new Date()) {
    const key = this.locationKey();
    if (!key) return { configured: false };

    // Ignore data cached for a different location (e.g. after changing lat/lon).
    const w = this.weather?.locationKey === key ? this.weather : null;
    const alerts = this.alerts?.locationKey === key ? this.alerts.list : [];
    return {
      configured: true,
      source: w?.data.source || null,
      updatedAt: w ? w.updatedAt.toISOString() : null,
      stale: !w || now - w.updatedAt > STALE_AFTER_MS,
      error: this.weatherError ? 'Weather services unavailable' : null,
      current: w?.data.current || null,
      today: w?.data.today || null,
      daily: w?.data.daily || [],
      hourly: (w?.data.hourly || []).filter((h) => new Date(h.time) > now - 60 * 60 * 1000),
      alerts: alerts.filter((a) => !a.ends || new Date(a.ends) > now),
    };
  }
}

module.exports = {
  normalizeNws, normalizeOpenMeteo, parseAlerts, iconFromNws, wmoInfo, WeatherService, STALE_AFTER_MS,
};
