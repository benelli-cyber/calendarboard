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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);

const state = {
  timezone: 'America/New_York',
  view: 'month',          // 'month' | 'week'
  configJson: '',
  configView: null,       // calendarView in the last config we applied
  viewClickedAt: 0,       // ignore stale config polls right after a button click
  calendarJson: '',
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

let timeFmt, dateFmt;
function makeClockFormatters() {
  timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, hour: 'numeric', minute: '2-digit', hour12: true });
  dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, weekday: 'long', month: 'long', day: 'numeric' });
}

function tickClock() {
  const now = new Date();
  const parts = timeFmt.formatToParts(now);
  const hm = parts.filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
    .map((p) => p.value).join('').trim();
  const ampm = (parts.find((p) => p.type === 'dayPeriod') || {}).value || '';
  setText($('clock-time'), hm);
  setText($('clock-ampm'), ampm);
  setText($('clock-date'), dateFmt.format(now));
}

// ---------------------------------------------------------------------------
// Config (theme, font scale, timezone, calendar view) – polled so changes apply live
// ---------------------------------------------------------------------------

function applyConfig(cfg) {
  const json = JSON.stringify(cfg);
  if (json === state.configJson) return;
  state.configJson = json;

  document.body.className = cfg.display.theme === 'light' ? 'theme-light' : 'theme-dark';
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

function renderWeekdayHeader() {
  const row = $('cal-weekdays');
  if (row.childElementCount) return; // static; build once
  for (const name of WEEKDAYS) row.append(el('div', null, name));
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
  renderWeekdayHeader();
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
