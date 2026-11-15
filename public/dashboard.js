/*
 * Family Dashboard front end.
 *
 * Performance rules for the Pi 3B:
 *  - The clock ticks once per second but only touches the DOM when the text changes.
 *  - Data panels poll the server on their own intervals and re-render only when
 *    the JSON actually changed.
 *  - All user/calendar text is inserted with textContent (never innerHTML).
 */
'use strict';

const CONFIG_POLL_MS = 15 * 1000;   // also how fast the Pi follows the Month/Week button
const CALENDAR_POLL_MS = 60 * 1000; // server refreshes from Google every 5 min
const WEATHER_POLL_MS = 2 * 60 * 1000; // server refreshes weather every 15 min, alerts every 5
const TODO_POLL_MS = 20 * 1000;        // phone edits show up within ~20 s
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);

const state = {
  timezone: 'America/New_York',
  view: 'month',          // 'month' | 'week'
  configJson: '',
  configView: null,       // calendarView in the last config we applied
  viewClickedAt: 0,       // ignore stale config polls right after a button click
  calendarJson: '',
  weatherJson: '',
  todoJson: '',
  appVersion: null,       // server start id; a change means "reload for new code"
  display: null,          // latest display settings (theme, dimming…)
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an element with optional class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Only write to the DOM when the value differs (avoids needless repaints). */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Black or white text, whichever reads better on a calendar color like "#4FC3F7". */
function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#000000' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Clock & date (always in the configured timezone, regardless of the Pi's)
// ---------------------------------------------------------------------------

let timeFmt, dateFmt, hourFmt, hhmmFmt;
function makeClockFormatters() {
  hhmmFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, hour: 'numeric', hourCycle: 'h23' });
  timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, hour: 'numeric', minute: '2-digit', hour12: true });
  dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, weekday: 'long', month: 'long', day: 'numeric' });
}

function tickClock() {
  const now = new Date();
  const parts = timeFmt.formatToParts(now);
  const hm = parts.filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
    .map((p) => p.value).join('').trim();
  const ampm = (parts.find((p) => p.type === 'dayPeriod') || {}).value || '';
  if ($('clock-time').textContent !== hm) { // once a minute
    checkDailyReload(now);
    applyDim(now);
  }
  setText($('clock-time'), hm);
  setText($('clock-ampm'), ampm);
  setText($('clock-date'), dateFmt.format(now));
}

// ---------------------------------------------------------------------------
// Night dimming (display.dimEnabled / dimStart / dimEnd / dimLevel)
// ---------------------------------------------------------------------------

/** Is "HH:MM" `t` inside [start, end)? Handles windows that cross midnight (23:00–06:00). */
function inTimeWindow(t, start, end) {
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

function applyDim(now = new Date()) {
  const d = state.display;
  const overlay = $('dim-overlay');
  const on = Boolean(d && d.dimEnabled && inTimeWindow(hhmmFmt.format(now), d.dimStart, d.dimEnd));
  if (on) overlay.style.setProperty('--dim', String(d.dimLevel));
  if (overlay.hidden === on) overlay.hidden = !on; // only touch the DOM when it changes
}

// ---------------------------------------------------------------------------
// Page reloads: daily at 3 AM (clears Chromium memory growth on the Pi), and
// after the server is updated/restarted (to pick up new code).
// ---------------------------------------------------------------------------

const PAGE_LOADED_AT = Date.now();
let reloading = false;

/** Reload only if the server answers, so the kiosk never lands on an error page. */
async function safeReload(reason) {
  if (reloading) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return; // try again on the next check
  } catch {
    return; // server unreachable: keep showing the current page
  }
  reloading = true;
  console.log(`Reloading page: ${reason}`);
  location.reload();
}

function checkDailyReload(now) {
  // Any minute during the 3 AM hour, but not if the page was loaded less than
  // an hour ago (so it reloads once, and keeps retrying if the server is down).
  if (Date.now() - PAGE_LOADED_AT < 60 * 60 * 1000) return;
  if (Number(hourFmt.format(now)) === 3) safeReload('daily 3 AM reload');
}

// ---------------------------------------------------------------------------
// Config (theme, font scale, timezone, calendar view) – polled so changes apply live
// ---------------------------------------------------------------------------

function applyConfig(cfg) {
  const json = JSON.stringify(cfg);
  if (json === state.configJson) return;
  const firstLoad = !state.configJson;
  state.configJson = json;

  // The server restarted (usually an update): reload to get the new code.
  if (state.appVersion && cfg.appVersion && cfg.appVersion !== state.appVersion) {
    safeReload('server was updated');
    return;
  }
  state.appVersion = cfg.appVersion;

  // Settings were saved (calendars, colors, weather location…): fetch fresh data now
  // instead of waiting for the next poll. Weather gets a second look a bit later,
  // because a new location takes the server a few seconds to download.
  if (!firstLoad) {
    state.calendarJson = '';
    loadCalendar();
    loadWeather();
    setTimeout(loadWeather, 10 * 1000);
  }

  document.body.className = cfg.display.theme === 'light' ? 'theme-light' : 'theme-dark';
  state.display = cfg.display;
  applyDim();
  document.documentElement.style.setProperty('--s', String(cfg.display.fontScale || 1));
  if (cfg.timezone && cfg.timezone !== state.timezone) {
    state.timezone = cfg.timezone;
    makeClockFormatters();
    tickClock();
  }

  // Follow the saved month/week setting when it changes (e.g. clicked on another device).
  const view = cfg.display.calendarView;
  if (view !== state.configView) {
    state.configView = view;
    if (view !== state.view) {
      setView(view);
      return; // setView reloads the calendar
    }
  }
  // Sizes may have changed, so re-fit the calendar.
  if (state.calendarJson) renderCalendar(JSON.parse(state.calendarJson));
}

async function loadConfig() {
  try {
    const sentAt = Date.now();
    const cfg = await getJson('/api/config');
    // A poll that started before a button click may carry the old view – skip it.
    if (sentAt < state.viewClickedAt) return;
    applyConfig(cfg);
  } catch (err) {
    console.warn('config:', err.message); // keep current settings
  }
}

// ---------------------------------------------------------------------------
// Month/week toggle
// ---------------------------------------------------------------------------

const toggleButtons = document.querySelectorAll('.view-toggle button');

function setView(view) {
  state.view = view;
  for (const b of toggleButtons) b.classList.toggle('active', b.dataset.view === view);
  state.calendarJson = ''; // force a re-render for the new view
  loadCalendar();
}

for (const button of toggleButtons) {
  button.addEventListener('click', async () => {
    const view = button.dataset.view;
    if (view === state.view) return;
    state.viewClickedAt = Date.now();
    setView(view); // switch this screen immediately
    try {
      // Save on the server so the Pi (and any other open dashboard) follows.
      const res = await fetch('/api/display', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarView: view }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.configView = view;
      applyConfig(await res.json());
    } catch (err) {
      console.warn('saving view:', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function eventItem(ev) {
  const li = el('li', ev.allDay ? 'cev all-day' : 'cev');
  li.style.setProperty('--ev-color', ev.color);
  if (ev.allDay) {
    // Solid colored bar; title only (multi-day events repeat on each day).
    li.style.background = ev.color;
    li.style.color = textColorFor(ev.color);
    li.append(el('span', 'cev-title', ev.title));
  } else if (state.view === 'month') {
    const dot = el('span', 'cev-dot');
    dot.style.background = ev.color;
    // The ' ' text node lets the line wrap between the time and the title.
    li.append(dot, el('span', 'cev-time', ev.shortTime), ' ', el('span', 'cev-title', ev.title));
  } else {
    li.append(el('span', 'cev-time', ev.time), el('span', 'cev-title', ev.title));
  }
  return li;
}

/**
 * If a day's events don't fit in its cell, hide them from the end and add "+N more".
 * Only runs after a render (at most every few minutes), never per clock tick.
 */
function fitCell(list) {
  if (list.scrollHeight <= list.clientHeight) return;
  const items = [...list.children];
  const more = el('li', 'more');
  list.append(more);
  let hidden = 0;
  while (items.length && list.scrollHeight > list.clientHeight) {
    items.pop().hidden = true;
    hidden++;
    more.textContent = `+${hidden} more`;
  }
}

/** Weekday labels above the grid. Month view always starts on Sunday; the
 *  rolling week starts on today, so its labels come from the days themselves. */
function renderWeekdayHeader(data) {
  const labels = data.view === 'week'
    ? data.days.slice(0, 7).map((d) => d.weekday.slice(0, 3))
    : WEEKDAYS;
  const row = $('cal-weekdays');
  if (row.textContent === labels.join('')) return; // unchanged
  row.replaceChildren(...labels.map((name) => el('div', null, name)));
}

function renderGrid(data) {
  const grid = $('cal-grid');
  grid.className = `cal-grid view-${data.view}`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(data.days.length / 7)}, minmax(0, 1fr))`;

  const lists = [];
  const cells = data.days.map((day) => {
    let cls = 'cell';
    if (day.isToday) cls += ' today';
    else if (day.isPast) cls += ' past';
    if (!day.inMonth) cls += ' other-month';
    const cell = el('div', cls);
    // Label the 1st of a month ("Dec 1") so month boundaries are obvious.
    const label = day.dayOfMonth === 1 ? day.monthDay : String(day.dayOfMonth);
    const list = el('ul', 'cell-events');
    list.append(...day.events.map(eventItem));
    cell.append(el('div', 'cell-date', label), list);
    lists.push(list);
    return cell;
  });
  grid.replaceChildren(...cells);
  // Measure after everything is in the DOM (one layout pass, then fixes).
  for (const list of lists) fitCell(list);
}

/** Small, subtle hint naming any calendar whose data is older than 30 minutes. */
function renderStale(data) {
  const node = $('calendar-stale');
  const stale = (data.calendars || []).filter((c) => c.stale);
  if (!stale.length) {
    node.hidden = true;
    return;
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: state.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit',
  });
  const parts = stale.map((c) =>
    `${c.name} (${c.lastSuccess ? fmt.format(new Date(c.lastSuccess)) : 'never loaded'})`);
  setText(node, `Last updated: ${parts.join(', ')}`);
  node.hidden = false;
}

function renderCalendar(data) {
  renderWeekdayHeader(data);
  setText($('cal-title'), data.title);
  renderGrid(data);
  renderStale(data);
}

async function loadCalendar() {
  const view = state.view;
  try {
    const data = await getJson(`/api/calendar?view=${view}`);
    if (view !== state.view) return; // view changed while this request was in flight
    const json = JSON.stringify(data);
    if (json === state.calendarJson) return; // nothing changed → no DOM work
    state.calendarJson = json;
    renderCalendar(data);
  } catch (err) {
    // Server unreachable: keep showing what we have. Never blank the calendar.
    console.warn('calendar:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/** Icon names come from the server (e.g. "rain"); only allow simple names. */
function iconSrc(name) {
  return `icons/${/^[a-z-]+$/.test(name || '') ? name : 'cloudy'}.svg`;
}

/** Set an <img> src only when it changes (avoids re-decoding the SVG). */
function setIcon(img, name) {
  const src = iconSrc(name);
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
}

const deg = (v) => (v == null ? '--' : `${v}°`);

/** "until 7:00 PM" today, or "until Sun 10:00 AM" on another day. */
function untilText(iso) {
  if (!iso) return '';
  const end = new Date(iso);
  const day = (d) => new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, dateStyle: 'short' }).format(d);
  const sameDay = day(end) === day(new Date());
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: state.timezone, hour: 'numeric', minute: '2-digit', ...(sameDay ? {} : { weekday: 'short' }),
  });
  return `until ${fmt.format(end)}`;
}

function renderCurrentWeather(w) {
  const box = $('current-weather');
  const msg = $('weather-message');
  if (!w.configured || !w.current) {
    box.hidden = true;
    msg.hidden = false;
    setText(msg, w.configured ? 'Weather unavailable' : 'Set weather.lat / weather.lon in config.json');
    return;
  }
  msg.hidden = true;
  box.hidden = false;
  const { current, today } = w;
  setIcon($('cw-icon'), current.icon);
  setText($('cw-temp'), deg(current.temp));
  setText($('cw-line1'), `Feels ${deg(current.feelsLike)}  ·  H ${deg(today?.high)}  L ${deg(today?.low)}`);
  setText($('cw-condition'), current.condition);
  const precip = $('cw-precip');
  const chance = today?.precipChance;
  precip.hidden = !(chance >= 10);
  if (!precip.hidden) setText(precip.lastElementChild, `${chance}%`);
}

/** Banner under the header, colored by the most severe alert. Returns true if its visibility changed. */
function renderAlerts(alerts) {
  const banner = $('alert-banner');
  const wasHidden = banner.hidden;
  if (!alerts.length) {
    banner.hidden = true;
    return !wasHidden;
  }
  banner.className = `alert-banner sev-${(alerts[0].severity || 'unknown').toLowerCase()}`;
  const lines = alerts.slice(0, 2).map((a) => {
    const line = el('div', 'alert-line');
    line.append(el('span', 'alert-event', a.event), ` ${untilText(a.ends)}`);
    return line;
  });
  if (alerts.length > 2) lines.push(el('div', 'alert-line', `+${alerts.length - 2} more alert(s)`));
  banner.replaceChildren(...lines);
  banner.hidden = false;
  return wasHidden;
}

function renderForecast(w) {
  const wrap = $('forecast-days');
  const cells = (w.daily || []).slice(0, 5).map((d) => {
    const cell = el('div', 'fc');
    const icon = el('img', 'fc-icon');
    icon.src = iconSrc(d.icon);
    icon.alt = d.condition || '';
    const temps = el('div', 'fc-temps');
    temps.append(el('span', 'fc-high', deg(d.high)), el('span', 'fc-low', deg(d.low)));
    const precip = el('div', 'fc-precip');
    if (d.precipChance >= 10) {
      const drop = el('img');
      drop.src = 'icons/drop.svg';
      drop.alt = '';
      precip.append(drop, `${d.precipChance}%`);
    }
    cell.append(el('div', 'fc-day', d.weekday), icon, temps, precip);
    return cell;
  });
  if (!cells.length) cells.push(el('div', 'placeholder', w.configured ? 'Forecast unavailable' : ''));
  wrap.replaceChildren(...cells);

  // Small note when the data is old, or when the fallback service is in use.
  const note = $('weather-stale');
  let text = '';
  if (w.configured && w.stale && w.updatedAt) {
    const t = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    text = `Weather updated ${t.format(new Date(w.updatedAt))}`;
  } else if (w.source === 'open-meteo') {
    text = 'via Open-Meteo';
  }
  note.hidden = !text;
  setText(note, text);
}

async function loadWeather() {
  try {
    const w = await getJson('/api/weather');
    const json = JSON.stringify(w);
    if (json === state.weatherJson) return; // nothing changed → no DOM work
    state.weatherJson = json;
    renderCurrentWeather(w);
    renderForecast(w);
    // The banner changes the calendar's height, so re-fit the calendar cells.
    if (renderAlerts(w.alerts || []) && state.calendarJson) renderCalendar(JSON.parse(state.calendarJson));
  } catch (err) {
    console.warn('weather:', err.message); // keep showing the last weather we had
  }
}

// ---------------------------------------------------------------------------
// To-do list (read-only here; edited on phones at /todo)
// ---------------------------------------------------------------------------

function renderTodos(items) {
  const list = $('todo-list');
  if (!items.length) {
    list.replaceChildren(el('li', 'empty', `Nothing to do. Add items at ${location.host}/todo`));
    return;
  }
  // Server order: open items (newest first), then items checked in the last 24 h.
  list.replaceChildren(...items.map((item) => {
    const li = el('li', item.done ? 'todo-item done' : 'todo-item');
    li.append(el('span', 'todo-box'), el('span', 'todo-text', item.text));
    return li;
  }));
  fitCell(list); // "+N more" when there are more items than fit
}

async function loadTodos() {
  try {
    const { items } = await getJson('/api/todos');
    const json = JSON.stringify(items);
    if (json === state.todoJson) return; // nothing changed → no DOM work
    state.todoJson = json;
    renderTodos(items);
  } catch (err) {
    console.warn('todos:', err.message); // keep showing the last list
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

makeClockFormatters();
tickClock();
setInterval(tickClock, 1000);

// Apply the saved settings first, then draw the calendar in the saved view
// (falls back to the default view if the server couldn't be reached).
loadConfig().then(() => setView(state.view));
setInterval(loadConfig, CONFIG_POLL_MS);
setInterval(loadCalendar, CALENDAR_POLL_MS);

loadWeather();
setInterval(loadWeather, WEATHER_POLL_MS);

loadTodos();
setInterval(loadTodos, TODO_POLL_MS);
