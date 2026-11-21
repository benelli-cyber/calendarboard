'use strict';
/**
 * Family Dashboard – Express server.
 *
 *   GET  /                 dashboard (public/index.html, portrait 1080×1920)
 *   GET  /todo             mobile to-do page (public/todo.html)
 *   GET  /api/config       display settings (no secrets)
 *   GET  /api/calendar     calendar days; ?view=4weeks|3weeks|week (default: config setting)
 *   POST /api/display      { calendarView: "4weeks"|"3weeks"|"week" } – the on-screen toggle button
 *   GET  /api/weather      current conditions, today, 5-day forecast, active alerts
 *   GET  /api/todos        open items + items checked in the last 24 h
 *   POST /api/todos        { text, addedBy? } → new item
 *   PATCH /api/todos/:id   { done: true|false }
 *   DELETE /api/todos/:id
 *   GET  /api/settings     editable settings (calendar URLs masked)
 *   PUT  /api/settings     save settings to config.json; applied live
 *   GET  /settings         settings page (public/settings.html)
 *   GET  /api/event-colors Google per-event colors status (settings page)
 *   GET  /api/health       simple status check
 *
 * Run directly (`node server/index.js`) to start the server. Tests import
 * createApp() and pass in their own services instead.
 */
const path = require('path');
const express = require('express');
const { loadConfig, updateConfig, publicConfig, CALENDAR_VIEWS, ROOT } = require('./config');
const { toSettings, applySettings } = require('./settings');
const pkg = require('../package.json');

// Changes every time the server starts (e.g. after an update + restart).
// Open dashboards see the new value and reload themselves to get the new code.
const APP_VERSION = `${pkg.version}-${Date.now().toString(36)}`;

/**
 * Build the Express app.
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {(cfg: object) => void} deps.setConfig
 * @param {object} deps.calendar  CalendarService
 * @param {object} deps.weather   WeatherService
 * @param {object} deps.todos     TodoStore
 */
function createApp({ getConfig, setConfig, calendar, weather, todos }) {
  const app = express();
  app.disable('x-powered-by');

  // API responses must always be fresh.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // JSON bodies only. Browsers won't send JSON cross-site without permission,
  // so a random website can't add or delete to-dos on your LAN.
  const json = express.json({ limit: '4kb' });

  app.get('/api/config', (req, res) => res.json({ ...publicConfig(getConfig()), appVersion: APP_VERSION }));

  app.get('/api/calendar', (req, res) => {
    const view = CALENDAR_VIEWS.includes(req.query.view) ? req.query.view : getConfig().display.calendarView;
    res.json(calendar.getPayload(view));
  });

  // Saves the month/week choice to config.json so every screen (including the Pi
  // kiosk) switches on its next config poll. Only this one field can be changed here.
  app.post('/api/display', json, (req, res) => {
    const view = req.body?.calendarView;
    if (!CALENDAR_VIEWS.includes(view)) {
      return res.status(400).json({ error: `calendarView must be one of: ${CALENDAR_VIEWS.join(', ')}` });
    }
    try {
      setConfig(updateConfig((raw) => {
        raw.display = { ...(raw.display || {}), calendarView: view };
      }));
      console.log(`[server] Calendar view set to "${view}"`);
      res.json(publicConfig(getConfig()));
    } catch (err) {
      console.error(`[server] Could not save config: ${err.message}`);
      res.status(500).json({ error: 'Could not save setting' });
    }
  });

  app.get('/api/weather', (req, res) => res.json(weather.getPayload()));

  // ----- To-dos -----

  /** Run a TodoStore call and turn its errors into proper HTTP responses. */
  const todoRoute = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(`[todos] ${err.message}`);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Bad id'), { status: 400 });
    return id;
  };

  app.get('/api/todos', todoRoute((req, res) => res.json({ items: todos.list() })));
  app.post('/api/todos', json, todoRoute((req, res) => {
    res.status(201).json(todos.add(req.body?.text, req.body?.addedBy));
  }));
  app.patch('/api/todos/:id', json, todoRoute((req, res) => {
    res.json(todos.setDone(idParam(req), req.body?.done));
  }));
  app.delete('/api/todos/:id', todoRoute((req, res) => {
    todos.remove(idParam(req));
    res.status(204).end();
  }));

  // ----- Settings -----

  app.get('/api/settings', (req, res) => res.json(toSettings(getConfig())));

  // Status of the optional Google per-event colors (never includes the key).
  app.get('/api/event-colors', (req, res) => {
    res.json(calendar.eventColors ? calendar.eventColors.status() : { configured: false });
  });

  app.put('/api/settings', json, (req, res) => {
    let saved;
    try {
      // Validation happens inside updateConfig's callback: if anything is
      // invalid it throws before the file is written, so nothing changes.
      saved = updateConfig((raw) => applySettings(raw, req.body));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message, field: err.field });
      console.error(`[settings] Could not save: ${err.message}`);
      return res.status(500).json({ error: 'Could not save settings' });
    }
    setConfig(saved);
    console.log('[settings] Saved');
    // Apply right away: fetch any new/changed calendars, refresh weather if the location moved.
    calendar.refreshAll?.();
    weather.onConfigChange?.();
    res.json(toSettings(saved));
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Pages
  app.get('/todo', (req, res) => res.sendFile(path.join(ROOT, 'public', 'todo.html')));
  app.get('/settings', (req, res) => res.sendFile(path.join(ROOT, 'public', 'settings.html')));

  // No long-lived caching: ETags make reloads cheap, and updates show up immediately.
  app.use(express.static(path.join(ROOT, 'public')));

  // Errors thrown before a route runs (e.g. malformed JSON) → JSON, not an HTML page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`[server] ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : 'Bad request' });
  });

  return app;
}

function main() {
  // Load config FIRST and set the process timezone before any date work happens,
  // so "today", midnight, and all-day events are computed in the family's timezone.
  let config = loadConfig();
  process.env.TZ = config.timezone;

  const { CalendarService } = require('./calendar');
  const { WeatherService } = require('./weather');
  const { TodoStore } = require('./todos');
  const { GoogleColors } = require('./google-colors');

  const getConfig = () => config;
  // Optional per-event Google colors; off until the key file exists (deploy/GOOGLE-COLORS.md).
  const eventColors = new GoogleColors({
    getKeyFile: () => path.resolve(ROOT, config.google.serviceAccountFile),
  });
  const calendar = new CalendarService({
    getConfig, cacheDir: path.join(ROOT, 'data', 'calendar-cache'), rootDir: ROOT, eventColors,
  });
  const weather = new WeatherService({ getConfig, cacheDir: path.join(ROOT, 'data') });
  const todos = new TodoStore(process.env.TODO_DB || path.join(ROOT, 'data', 'todos.db'));

  // Clean out long-finished to-dos at startup and once a day.
  todos.purge();
  setInterval(() => todos.purge(), 24 * 60 * 60 * 1000).unref();

  const app = createApp({ getConfig, setConfig: (c) => { config = c; }, calendar, weather, todos });

  app.listen(config.port, config.host, () => {
    console.log(`[server] Family dashboard on http://${config.host}:${config.port}/ (TZ ${config.timezone})`);
    console.log(`[server] ${config.calendars.filter((c) => c.enabled).length} calendar(s) enabled`);
    calendar.start();
    if (weather.locationKey()) {
      weather.start();
    } else {
      console.log('[server] Weather disabled: set weather.lat / weather.lon in config.json');
    }
  });
}

if (require.main === module) main();

module.exports = { createApp };
