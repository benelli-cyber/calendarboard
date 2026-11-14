'use strict';
/**
 * Config loading and validation.
 *
 * config.json lives in the project root (override with CONFIG_PATH env var).
 * It contains the secret iCal URLs, so it is git-ignored and must NEVER be
 * sent to the browser as-is. Use publicConfig() for anything client-facing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');

const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  timezone: 'America/New_York',
  calendars: [],
  calendarDaysAhead: 7,
  weather: { lat: 0, lon: 0, userAgent: 'family-dashboard', units: 'imperial' },
  display: { theme: 'dark', fontScale: 1.0, dimStart: '23:00', dimEnd: '06:00' },
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Fill in defaults and fix up obviously bad values so the app keeps running. */
function normalize(raw) {
  const cfg = {
    ...DEFAULTS,
    ...raw,
    weather: { ...DEFAULTS.weather, ...(raw.weather || {}) },
    display: { ...DEFAULTS.display, ...(raw.display || {}) },
  };

  cfg.port = Number(cfg.port) || DEFAULTS.port;

  // Validate the timezone by asking Intl to use it; throws RangeError if unknown.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    console.warn(`[config] Unknown timezone "${cfg.timezone}", using ${DEFAULTS.timezone}`);
    cfg.timezone = DEFAULTS.timezone;
  }

  const days = Math.round(Number(cfg.calendarDaysAhead));
  cfg.calendarDaysAhead = Number.isFinite(days) ? Math.min(Math.max(days, 1), 14) : 7;

  const scale = Number(cfg.display.fontScale);
  cfg.display.fontScale = Number.isFinite(scale) ? Math.min(Math.max(scale, 0.5), 2) : 1;
  if (!['dark', 'light'].includes(cfg.display.theme)) cfg.display.theme = 'dark';

  cfg.calendars = (Array.isArray(cfg.calendars) ? cfg.calendars : [])
    .filter((c) => c && typeof c.url === 'string' && c.url.trim())
    .map((c, i) => ({
      name: String(c.name || `Calendar ${i + 1}`),
      url: c.url.trim(),
      color: HEX_COLOR.test(c.color) ? c.color : '#4FC3F7',
      enabled: c.enabled !== false,
    }));

  return cfg;
}

/** Read and validate config.json. Exits with a helpful message if it is missing. */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `[config] ${CONFIG_PATH} not found.\n` +
      '         Copy config.example.json to config.json and fill in your calendar URLs.'
    );
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`[config] Could not parse ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
  return normalize(raw);
}

/**
 * The subset of config that is safe to send to the browser.
 * Calendar URLs are deliberately left out.
 */
function publicConfig(cfg) {
  return {
    timezone: cfg.timezone,
    calendarDaysAhead: cfg.calendarDaysAhead,
    display: cfg.display,
    calendars: cfg.calendars.map(({ name, color, enabled }) => ({ name, color, enabled })),
  };
}

module.exports = { loadConfig, normalize, publicConfig, CONFIG_PATH, ROOT };
