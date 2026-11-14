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

const CONFIG_POLL_MS = 60 * 1000;
const CALENDAR_POLL_MS = 60 * 1000; // server refreshes from Google every 5 min

const $ = (id) => document.getElementById(id);

const state = {
  timezone: 'America/New_York',
  configJson: '',
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
// Config (theme, font scale, timezone) – polled so later settings changes apply live
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const cfg = await getJson('/api/config');
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
    // Sizes may have changed, so re-fit the calendar lists.
    if (state.calendarJson) renderCalendar(JSON.parse(state.calendarJson));
  } catch (err) {
    console.warn('config:', err.message); // keep current settings
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function eventItem(ev) {
  const li = el('li', 'event');
  const bar = el('span', 'event-bar');
  bar.style.background = ev.color;
  li.append(bar, el('span', 'event-time', ev.time), el('span', 'event-title', ev.title));
  if (ev.note) li.append(el('span', 'event-note', ev.note));
  return li;
}

/**
 * Hide list items that don't fit inside `container` and add a "+N more" line.
 * `items` must be in display order. Runs only after a render, not every tick.
 */
function fitItems(container, items, moreParent) {
  if (!items.length) return;
  const bottom = container.getBoundingClientRect().bottom -
    parseFloat(getComputedStyle(container).paddingBottom);
  // Hide day groups (upcoming) whose events are all hidden, so their headings take no space.
  const hideEmptyDays = () => {
    for (const day of container.querySelectorAll('.day')) {
      day.hidden = !day.querySelector('.event:not([hidden])');
    }
  };

  let hidden = 0;
  for (const item of items) {
    if (hidden || item.getBoundingClientRect().bottom > bottom) {
      item.hidden = true;
      hidden++;
    }
  }
  if (!hidden) return;
  hideEmptyDays();

  // Add "+N more", then hide more events from the end until that line fits too.
  const more = el('div', 'more', `+${hidden} more`);
  (moreParent || container).append(more);
  const visible = items.filter((i) => !i.hidden);
  while (visible.length && more.getBoundingClientRect().bottom > bottom) {
    visible.pop().hidden = true;
    hidden++;
    hideEmptyDays();
    more.textContent = `+${hidden} more`;
  }
}

function renderToday(day) {
  const list = $('today-events');
  list.replaceChildren();
  if (!day || !day.events.length) {
    list.append(el('li', 'empty', 'Nothing scheduled today'));
    return;
  }
  const items = day.events.map(eventItem);
  list.append(...items);
  fitItems(list.parentElement, items, list);
}

function renderUpcoming(days) {
  const wrap = $('upcoming-days');
  wrap.replaceChildren();
  const withEvents = days.filter((d) => d.events.length);
  if (!withEvents.length) {
    wrap.append(el('div', 'empty', `Nothing scheduled in the next ${days.length} days`));
    return;
  }
  const items = [];
  for (const day of withEvents) {
    const group = el('div', 'day');
    const heading = el('h3', 'day-heading', day.relative || day.weekday);
    heading.append(el('span', 'day-date', day.monthDay));
    const list = el('ul', 'events');
    for (const ev of day.events) {
      const li = eventItem(ev);
      list.append(li);
      items.push(li);
    }
    group.append(heading, list);
    wrap.append(group);
  }
  fitItems(wrap, items);
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
  renderToday(data.days[0]);
  renderUpcoming(data.days.slice(1));
  renderStale(data);
}

async function loadCalendar() {
  try {
    const data = await getJson('/api/calendar');
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

loadConfig().then(loadCalendar);
setInterval(loadConfig, CONFIG_POLL_MS);
setInterval(loadCalendar, CALENDAR_POLL_MS);
