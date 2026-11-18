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
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');

const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  timezone: 'America/New_York',
  calendars: [],
  weather: { lat: 0, lon: 0, userAgent: 'family-dashboard', units: 'imperial' },
  // Optional per-event Google colors: a service account key file (deploy/GOOGLE-COLORS.md).
  // Relative paths are inside the project folder. Feature is off while the file doesn't exist.
  google: { serviceAccountFile: 'google-service-account.json' },
  display: {
    theme: 'dark', fontScale: 1.0, calendarView: 'month',
    // Night dimming (off by default): a dark layer over the dashboard between these times.
    dimEnabled: false, dimStart: '23:00', dimEnd: '06:00', dimLevel: 0.6,
  },
};

const CALENDAR_VIEWS = ['month', 'week'];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Fill in defaults and fix up obviously bad values so the app keeps running. */
function normalize(raw) {
  const cfg = {
    ...DEFAULTS,
    ...raw,
    weather: { ...DEFAULTS.weather, ...(raw.weather || {}) },
    display: { ...DEFAULTS.display, ...(raw.display || {}) },
    google: { ...DEFAULTS.google, ...(raw.google || {}) },
  };

  cfg.port = Number(cfg.port) || DEFAULTS.port;

  // Validate the timezone by asking Intl to use it; throws RangeError if unknown.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    console.warn(`[config] Unknown timezone "${cfg.timezone}", using ${DEFAULTS.timezone}`);
    cfg.timezone = DEFAULTS.timezone;
  }

  const scale = Number(cfg.display.fontScale);
  cfg.display.fontScale = Number.isFinite(scale) ? Math.min(Math.max(scale, 0.5), 2) : 1;
  if (!['dark', 'light'].includes(cfg.display.theme)) cfg.display.theme = 'dark';
  if (!CALENDAR_VIEWS.includes(cfg.display.calendarView)) cfg.display.calendarView = 'month';
  cfg.display.dimEnabled = cfg.display.dimEnabled === true;
  const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!HH_MM.test(cfg.display.dimStart)) cfg.display.dimStart = DEFAULTS.display.dimStart;
  if (!HH_MM.test(cfg.display.dimEnd)) cfg.display.dimEnd = DEFAULTS.display.dimEnd;
  const level = Number(cfg.display.dimLevel);
  cfg.display.dimLevel = Number.isFinite(level) ? Math.min(Math.max(level, 0.2), 0.9) : DEFAULTS.display.dimLevel;

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
 * Change config.json on disk and return the new normalized config.
 *
 * `mutate(raw)` edits the raw JSON object in place. We re-read the file first so
 * nothing else in it (calendar URLs, unknown fields) is lost,
 * and write to a temp file then rename, so a crash can never leave half a file.
 * The new file gets the SAME permissions as the old one (e.g. 600), because
 * config.json holds the secret calendar URLs.
 */
function updateConfig(mutate) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  mutate(raw);
  const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode); // exact mode, regardless of the process umask
  fs.renameSync(tmp, CONFIG_PATH);
  return normalize(raw);
}

/**
 * The subset of config that is safe to send to the browser.
 * Calendar URLs are deliberately left out.
 */
function publicConfig(cfg) {
  return {
    // Changes whenever anything in config.json changes (one-way hash, reveals nothing),
    // so the dashboard knows to reload calendar + weather after a settings save.
    revision: crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 12),
    timezone: cfg.timezone,
    display: cfg.display,
    calendars: cfg.calendars.map(({ name, color, enabled }) => ({ name, color, enabled })),
  };
}

module.exports = { loadConfig, updateConfig, normalize, publicConfig, CALENDAR_VIEWS, CONFIG_PATH, ROOT };
