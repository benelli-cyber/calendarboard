'use strict';
/**
 * Settings page support: turn config.json into something safe to show in a
 * browser, and apply edits from the settings form back onto config.json.
 *
 * SECRET URLS: calendar URLs never leave the server. The settings page sees
 * a masked version ("calendar.google.com/…/basic.ics") and a stable id (a
 * one-way hash of the URL). When saving, an existing calendar is matched by
 * that id and keeps its URL unless a new one is typed in.
 */
const { calendarId } = require('./calendar');
const { CALENDAR_VIEWS } = require('./config');

/** A bad field in the settings form → HTTP 400 with a message for that field. */
class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.status = 400;
    this.field = field;
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" → "calendar.google.com/…/basic.ics" */
function maskUrl(url) {
  try {
    if (url.startsWith('file:')) return `file:…/${url.split('/').pop()}`;
    const u = new URL(url.replace(/^webcal:/i, 'https:'));
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.host}/…/${last}`;
  } catch {
    return '(hidden)';
  }
}

/** What GET /api/settings returns. Contains no calendar URLs. */
function toSettings(cfg) {
  return {
    timezone: cfg.timezone,
    calendars: cfg.calendars.map((c) => ({
      id: calendarId(c.url),
      name: c.name,
      color: c.color,
      enabled: c.enabled,
      urlMasked: maskUrl(c.url),
    })),
    display: {
      theme: cfg.display.theme,
      fontScale: cfg.display.fontScale,
      calendarView: cfg.display.calendarView,
      dimEnabled: cfg.display.dimEnabled,
      dimStart: cfg.display.dimStart,
      dimEnd: cfg.display.dimEnd,
      dimLevel: cfg.display.dimLevel,
    },
    weather: {
      lat: cfg.weather.lat,
      lon: cfg.weather.lon,
      userAgent: cfg.weather.userAgent,
    },
  };
}

function checkUrl(url, field) {
  if (typeof url !== 'string' || !url.trim()) throw new SettingsError(field, 'Paste the calendar\'s secret iCal address');
  const u = url.trim();
  // New URLs must be web addresses (file: paths are only for the demo config).
  if (!/^(https|webcal):\/\/[^\s]+$/i.test(u)) {
    throw new SettingsError(field, 'The address should start with https:// (copy "Secret address in iCal format")');
  }
  return u;
}

function checkNumber(value, min, max, field, label) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new SettingsError(field, `${label} must be a number between ${min} and ${max}`);
  }
  return n;
}

/**
 * Apply the settings form onto the raw config.json object (in place).
 * Throws SettingsError on the first invalid field; in that case nothing is saved.
 *
 * @param {object} raw    config.json contents (keeps fields we don't manage, e.g. port)
 * @param {object} input  body of PUT /api/settings (same shape as toSettings(),
 *                        plus `url` on new calendars or to replace one)
 */
function applySettings(raw, input) {
  if (!input || typeof input !== 'object') throw new SettingsError(null, 'Nothing to save');

  // ----- Calendars -----
  if (input.calendars !== undefined) {
    if (!Array.isArray(input.calendars)) throw new SettingsError('calendars', 'Calendars must be a list');
    const existing = new Map((raw.calendars || []).map((c) => [calendarId(c.url), c]));
    const seen = new Set();

    raw.calendars = input.calendars.map((c, i) => {
      const f = (name) => `calendars.${i}.${name}`;
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 40) : '';
      if (!name) throw new SettingsError(f('name'), 'Each calendar needs a name');
      if (!HEX_COLOR.test(c.color)) throw new SettingsError(f('color'), 'Pick a color');

      let base = {};
      let url;
      if (c.id) {
        base = existing.get(c.id);
        if (!base) throw new SettingsError(f('id'), 'This calendar no longer exists. Reload the page.');
        url = c.url ? checkUrl(c.url, f('url')) : base.url; // keep the secret URL unless replaced
      } else {
        url = checkUrl(c.url, f('url'));
      }
      const id = calendarId(url);
      if (seen.has(id)) throw new SettingsError(f('url'), 'This calendar is listed twice');
      seen.add(id);

      return { ...base, name, url, color: c.color.toUpperCase(), enabled: c.enabled !== false };
    });
  }

  // ----- Display -----
  if (input.display !== undefined) {
    const d = input.display || {};
    raw.display = { ...(raw.display || {}) };
    if (d.theme !== undefined) {
      if (!['dark', 'light'].includes(d.theme)) throw new SettingsError('display.theme', 'Theme must be dark or light');
      raw.display.theme = d.theme;
    }
    if (d.fontScale !== undefined) {
      raw.display.fontScale = Math.round(checkNumber(d.fontScale, 0.5, 2, 'display.fontScale', 'Font size') * 100) / 100;
    }
    if (d.calendarView !== undefined) {
      if (!CALENDAR_VIEWS.includes(d.calendarView)) throw new SettingsError('display.calendarView', 'View must be month, 3weeks, or week');
      raw.display.calendarView = d.calendarView;
    }
    if (d.dimEnabled !== undefined) {
      if (typeof d.dimEnabled !== 'boolean') throw new SettingsError('display.dimEnabled', 'Night dimming must be on or off');
      raw.display.dimEnabled = d.dimEnabled;
    }
    if (d.dimLevel !== undefined) {
      raw.display.dimLevel = Math.round(checkNumber(d.dimLevel, 0.2, 0.9, 'display.dimLevel', 'Dimming') * 100) / 100;
    }
    for (const key of ['dimStart', 'dimEnd']) {
      if (d[key] !== undefined) {
        if (!HH_MM.test(d[key])) throw new SettingsError(`display.${key}`, 'Use a time like 23:00');
        raw.display[key] = d[key];
      }
    }
  }

  // ----- Weather -----
  if (input.weather !== undefined) {
    const w = input.weather || {};
    raw.weather = { ...(raw.weather || {}) };
    if (w.lat !== undefined) raw.weather.lat = checkNumber(w.lat, -90, 90, 'weather.lat', 'Latitude');
    if (w.lon !== undefined) raw.weather.lon = checkNumber(w.lon, -180, 180, 'weather.lon', 'Longitude');
    if (w.userAgent !== undefined) {
      const ua = typeof w.userAgent === 'string' ? w.userAgent.trim() : '';
      if (!ua || ua.length > 200) throw new SettingsError('weather.userAgent', 'Enter an app name and contact, e.g. family-dashboard (you@example.com)');
      raw.weather.userAgent = ua;
    }
  }

  return raw;
}

module.exports = { toSettings, applySettings, maskUrl, SettingsError };
