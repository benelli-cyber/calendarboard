'use strict';
/**
 * Family Dashboard – Express server.
 *
 *   GET /               dashboard (public/index.html, portrait 1080×1920)
 *   GET /api/config     display settings (no secrets)
 *   GET /api/calendar   agenda for today + next N days
 *   GET /api/health     simple status check
 */
const path = require('path');
const express = require('express');
const { loadConfig, publicConfig, ROOT } = require('./config');

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
app.get('/api/calendar', (req, res) => res.json(calendar.getPayload()));
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// No long-lived caching: ETags make reloads cheap, and updates show up immediately.
app.use(express.static(path.join(ROOT, 'public')));

app.listen(config.port, config.host, () => {
  console.log(`[server] Family dashboard on http://${config.host}:${config.port}/ (TZ ${config.timezone})`);
  console.log(`[server] ${config.calendars.filter((c) => c.enabled).length} calendar(s) enabled`);
  calendar.start();
});
