'use strict';
/**
 * Family Dashboard – Express server.
 *
 *   GET /               dashboard (public/index.html, portrait 1080×1920)
 *   GET /api/config     display settings (no secrets)
 *   GET /api/calendar   calendar days; ?view=month|week (default: config setting)
 *   POST /api/display   { calendarView: "month"|"week" } – the on-screen toggle button
 *   GET /api/health     simple status check
 */
const path = require('path');
const express = require('express');
const { loadConfig, updateConfig, publicConfig, CALENDAR_VIEWS, ROOT } = require('./config');

// Load config FIRST and set the process timezone before any date work happens,
// so "today", midnight, and all-day events are computed in the family's timezone.
let config = loadConfig();
process.env.TZ = config.timezone;

const { CalendarService } = require('./calendar');

const calendar = new CalendarService({
  getConfig: () => config,
  cacheDir: path.join(ROOT, 'data', 'calendar-cache'),
  rootDir: ROOT,
});

const app = express();
app.disable('x-powered-by');

// API responses must always be fresh.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/config', (req, res) => res.json(publicConfig(config)));
app.get('/api/calendar', (req, res) => {
  const view = CALENDAR_VIEWS.includes(req.query.view) ? req.query.view : config.display.calendarView;
  res.json(calendar.getPayload(view));
});

// Saves the month/week choice to config.json so every screen (including the Pi
// kiosk) switches on its next config poll. Only this one field can be changed here.
app.post('/api/display', express.json({ limit: '1kb' }), (req, res) => {
  const view = req.body?.calendarView;
  if (!CALENDAR_VIEWS.includes(view)) {
    return res.status(400).json({ error: `calendarView must be one of: ${CALENDAR_VIEWS.join(', ')}` });
  }
  try {
    config = updateConfig((raw) => {
      raw.display = { ...(raw.display || {}), calendarView: view };
    });
    console.log(`[server] Calendar view set to "${view}"`);
    res.json(publicConfig(config));
  } catch (err) {
    console.error(`[server] Could not save config: ${err.message}`);
    res.status(500).json({ error: 'Could not save setting' });
  }
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// No long-lived caching: ETags make reloads cheap, and updates show up immediately.
app.use(express.static(path.join(ROOT, 'public')));

app.listen(config.port, config.host, () => {
  console.log(`[server] Family dashboard on http://${config.host}:${config.port}/ (TZ ${config.timezone})`);
  console.log(`[server] ${config.calendars.filter((c) => c.enabled).length} calendar(s) enabled`);
  calendar.start();
});
