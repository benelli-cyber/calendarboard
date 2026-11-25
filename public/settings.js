/*
 * Settings page. Loads /api/settings, lets you edit, saves with PUT.
 *
 * The form (DOM) is the source of truth: on save we read every input back.
 * Existing calendars are sent with their id and NO url, so the server keeps
 * the secret address it already has. A url is only sent for new calendars,
 * or when you tap "Replace address".
 */
'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setMessage(text, kind) {
  const m = $('message');
  m.textContent = text || '';
  m.className = kind || '';
}

// ---------------------------------------------------------------------------
// Coordinates: accept "38.8894, -77.0352", "38.8894 -77.0352",
// or "38.8894° N, 77.0352° W" (as copied from some map apps).
// ---------------------------------------------------------------------------

function parseCoords(text) {
  const t = text.trim();
  if (!t) return { lat: 0, lon: 0 }; // empty = weather off
  const parts = [...t.matchAll(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?/gi)].slice(0, 2);
  if (parts.length < 2) return null;
  const [lat, lon] = parts.map(([, num, dir]) => {
    const n = Number(num);
    return dir && /[SW]/i.test(dir) ? -Math.abs(n) : n;
  });
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function formatCoords(lat, lon) {
  return lat === 0 && lon === 0 ? '' : `${lat}, ${lon}`;
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/** One card per calendar. `cal` is from the server, or {} for a new one. */
function calendarCard(cal = {}) {
  const isNew = !cal.id;
  const card = el('div', cal.enabled === false ? 'cal off' : 'cal');
  if (cal.id) card.dataset.id = cal.id;

  const row = el('div', 'cal-row');
  const color = el('input', 'cal-color');
  color.type = 'color';
  color.value = cal.color || '#4fc3f7';
  color.setAttribute('aria-label', 'Calendar color');

  const name = el('input', 'cal-name');
  name.type = 'text';
  name.value = cal.name || '';
  name.placeholder = 'Name (e.g. Family)';
  name.maxLength = 40;
  name.setAttribute('aria-label', 'Calendar name');

  const toggle = el('label', 'toggle');
  const enabled = el('input', 'cal-enabled');
  enabled.type = 'checkbox';
  enabled.checked = cal.enabled !== false;
  enabled.addEventListener('change', () => card.classList.toggle('off', !enabled.checked));
  toggle.append(enabled, 'Show');

  const remove = el('button', 'remove', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove calendar');
  remove.addEventListener('click', () => {
    const label = name.value.trim() || 'this calendar';
    if (isNew || confirm(`Remove ${label} from the dashboard? (Nothing is deleted in Google Calendar.)`)) card.remove();
  });

  row.append(color, name, toggle, remove);

  const urlBox = el('div', 'cal-url');
  const url = el('input', 'cal-url-input');
  url.type = 'url';
  url.placeholder = 'https://calendar.google.com/calendar/ical/…/basic.ics';
  url.autocomplete = 'off';
  url.setAttribute('aria-label', 'Secret iCal address');
  if (isNew) {
    urlBox.append(url);
  } else {
    url.hidden = true;
    const replace = el('button', 'link-btn', 'Replace address');
    replace.type = 'button';
    replace.addEventListener('click', () => {
      url.hidden = false;
      replace.hidden = true;
      url.focus();
    });
    urlBox.append(el('span', null, `${cal.urlMasked}  `), replace, url);
  }

  card.append(row, urlBox);
  return card;
}

function readCalendars() {
  return [...document.querySelectorAll('.cal')].map((card) => {
    const cal = {
      name: card.querySelector('.cal-name').value,
      color: card.querySelector('.cal-color').value,
      enabled: card.querySelector('.cal-enabled').checked,
    };
    if (card.dataset.id) cal.id = card.dataset.id;
    const url = card.querySelector('.cal-url-input').value.trim();
    if (url) cal.url = url; // only for new calendars or "Replace address"
    return cal;
  });
}

// ---------------------------------------------------------------------------
// Keyword color rules
// ---------------------------------------------------------------------------

function ruleButton(text, label, onClick) {
  const b = el('button', 'rule-btn', text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/** Disable ↑ on the first rule and ↓ on the last. */
function updateRuleButtons() {
  const cards = [...document.querySelectorAll('.rule')];
  cards.forEach((card, i) => {
    card.querySelector('.up').disabled = i === 0;
    card.querySelector('.down').disabled = i === cards.length - 1;
  });
}

function ruleCard(rule = {}) {
  const card = el('div', 'rule');
  const row = el('div', 'rule-row');

  const color = el('input', 'cal-color rule-color');
  color.type = 'color';
  color.value = (rule.color || '#e91e63').toLowerCase();
  color.setAttribute('aria-label', 'Rule color');

  const name = el('input', 'rule-name');
  name.type = 'text';
  name.maxLength = 40;
  name.placeholder = 'Name (e.g. Food)';
  name.value = rule.name || '';
  name.setAttribute('aria-label', 'Rule name');

  const up = ruleButton('↑', 'Move rule up', () => {
    if (card.previousElementSibling) card.parentNode.insertBefore(card, card.previousElementSibling);
    updateRuleButtons();
  });
  up.classList.add('up');
  const down = ruleButton('↓', 'Move rule down', () => {
    if (card.nextElementSibling) card.parentNode.insertBefore(card.nextElementSibling, card);
    updateRuleButtons();
  });
  down.classList.add('down');
  const remove = ruleButton('✕', 'Delete rule', () => {
    if (confirm(`Delete the rule "${name.value.trim() || 'unnamed'}"?`)) {
      card.remove();
      updateRuleButtons();
    }
  });

  row.append(color, name, up, down, remove);

  const words = el('textarea', 'rule-words');
  words.placeholder = 'Words, separated by commas: lunch, dinner, pizza, ice cream';
  words.value = (rule.keywords || []).join(', ');
  words.setAttribute('aria-label', 'Words for this rule');

  card.append(row, words);
  return card;
}

function readRules() {
  return {
    weekends: $('rulesWeekends').checked,
    rules: [...document.querySelectorAll('.rule')].map((card) => ({
      name: card.querySelector('.rule-name').value,
      color: card.querySelector('.rule-color').value,
      keywords: card.querySelector('.rule-words').value, // the server splits on commas
    })),
  };
}

// ---------------------------------------------------------------------------
// Load / render / save
// ---------------------------------------------------------------------------

function render(s) {
  $('calendars').replaceChildren(...s.calendars.map(calendarCard));
  $('color-rules').replaceChildren(...(s.colorRules?.rules || []).map(ruleCard));
  $('rulesWeekends').checked = Boolean(s.colorRules?.weekends);
  updateRuleButtons();
  document.querySelector(`input[name=calendarView][value="${s.display.calendarView}"]`).checked = true;
  document.querySelector(`input[name=theme][value=${s.display.theme}]`).checked = true;
  $('fontScale').value = s.display.fontScale;
  showFontScale();
  document.querySelector(`input[name=background][value="${s.display.background || 'sky'}"]`).checked = true;
  $('allDaySame').checked = Boolean(s.display.allDayColor);
  $('allDayColor').value = s.display.allDayColor || '#f4511e';
  $('allDayColor').disabled = !s.display.allDayColor;
  $('dimEnabled').checked = s.display.dimEnabled;
  $('dimStart').value = s.display.dimStart;
  $('dimEnd').value = s.display.dimEnd;
  $('dimLevel').value = s.display.dimLevel;
  showDim();
  $('coords').value = formatCoords(s.weather.lat, s.weather.lon);
  $('userAgent').value = s.weather.userAgent || '';
  document.querySelector(`input[name=currentSource][value="${s.weather.currentSource || 'forecast'}"]`).checked = true;
}

function showFontScale() {
  $('fontScale-value').textContent = `${Math.round($('fontScale').value * 100)}%`;
}

function showDim() {
  $('dim-options').hidden = !$('dimEnabled').checked;
  $('dimLevel-value').textContent = `${Math.round($('dimLevel').value * 100)}%`;
}

/** Google per-event colors: on/off, the robot account to share calendars with, problems. */
async function showEventColors() {
  const box = $('event-colors');
  let st;
  try {
    st = await (await fetch('/api/event-colors', { cache: 'no-store' })).json();
  } catch {
    return;
  }
  const lines = [];
  if (!st.configured) {
    lines.push(el('div', null,
      "Event colors from Google: off. Events use their calendar's color. To show each event's own " +
      'Google color, follow deploy/GOOGLE-COLORS.md in the project.'));
  } else {
    const head = el('div');
    if (st.error) head.append(el('span', 'warn', `Event colors from Google: ${st.error}`));
    else if (!st.updatedAt) head.append('Event colors from Google: checking…');
    else if (st.ok) head.append(el('span', 'ok', 'Event colors from Google: on ✓'));
    else head.append(el('span', 'warn', 'Event colors from Google: some calendars need attention'));
    lines.push(head);
    if (st.serviceAccount) {
      const share = el('div', null, 'Share each calendar (See all event details) with: ');
      share.append(el('span', 'robot', st.serviceAccount));
      lines.push(share);
    }
    for (const [name, msg] of Object.entries(st.calendarErrors || {})) {
      lines.push(el('div', 'warn', `${name}: ${msg}`));
    }
  }
  box.replaceChildren(...lines);
}

/** Show what the dashboard's weather looks like right now (confirms the location works). */
async function showWeatherStatus() {
  const box = $('weather-status');
  try {
    const w = await (await fetch('/api/weather', { cache: 'no-store' })).json();
    // Name the station in the "nearest weather station" option, e.g. "(Montgomery, Orange County Airport)".
    if (w.station) {
      $('station-label').textContent = `Nearest weather station (${w.station.name || w.station.id})`;
    }
    if (!w.configured) box.textContent = 'Weather is off until a location is set.';
    else if (!w.current) box.textContent = 'Checking the weather for this location…';
    else {
      const src = w.source === 'nws' ? 'National Weather Service' : 'Open-Meteo';
      box.textContent = `Now: ${w.current.temp}°, ${w.current.condition} (from ${src})`;
    }
  } catch {
    box.textContent = '';
  }
}

function clearInvalid() {
  document.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
}

/** Highlight the input for a server field like "calendars.2.url" or "weather.lat". */
function markInvalid(field) {
  if (!field) return;
  let input = null;
  const r = /^colorRules\.(\d+)\.(\w+)$/.exec(field);
  const m = /^calendars\.(\d+)\.(\w+)$/.exec(field);
  if (r) {
    const card = document.querySelectorAll('.rule')[Number(r[1])];
    input = card ? card.querySelector(r[2] === 'color' ? '.rule-color' : '.rule-words') : null;
  } else if (m) {
    const card = document.querySelectorAll('.cal')[Number(m[1])];
    const cls = { name: 'cal-name', color: 'cal-color', url: 'cal-url-input' }[m[2]];
    input = card && cls ? card.querySelector(`.${cls}`) : null;
    if (input) input.hidden = false;
  } else if (field === 'weather.lat' || field === 'weather.lon') {
    input = $('coords');
  } else {
    input = document.querySelector(`[data-field="${field}"]`);
  }
  if (input) {
    input.classList.add('invalid');
    input.scrollIntoView({ block: 'center' });
  }
}

async function save(event) {
  event.preventDefault();
  clearInvalid();
  const coords = parseCoords($('coords').value);
  if (!coords) {
    markInvalid('weather.lat');
    setMessage('Location should look like: 38.8894, -77.0352', 'error');
    return;
  }

  const body = {
    calendars: readCalendars(),
    colorRules: readRules(),
    display: {
      calendarView: document.querySelector('input[name=calendarView]:checked').value,
      theme: document.querySelector('input[name=theme]:checked').value,
      fontScale: Number($('fontScale').value),
      allDayColor: $('allDaySame').checked ? $('allDayColor').value : '',
      background: document.querySelector('input[name=background]:checked').value,
      dimEnabled: $('dimEnabled').checked,
      dimStart: $('dimStart').value,
      dimEnd: $('dimEnd').value,
      dimLevel: Number($('dimLevel').value),
    },
    weather: {
      ...coords,
      userAgent: $('userAgent').value,
      currentSource: document.querySelector('input[name=currentSource]:checked').value,
    },
  };

  const button = $('save');
  button.disabled = true;
  setMessage('Saving…');
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      markInvalid(data.field);
      setMessage(data.error || `Could not save (${res.status})`, 'error');
      return;
    }
    render(data); // new calendars now have ids; "Replace address" boxes close
    setMessage('Saved. The dashboard updates within about 15 seconds.', 'ok');
    setTimeout(showWeatherStatus, 4000); // give a new location a moment to load
  } catch {
    setMessage("Can't reach the dashboard. Are you on the home network?", 'error');
  } finally {
    button.disabled = false;
  }
}

async function load() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    render(await res.json());
    showWeatherStatus();
    showEventColors();
  } catch {
    setMessage("Can't load settings. Are you on the home network?", 'error');
  }
}

$('add-rule').addEventListener('click', () => {
  const card = ruleCard({});
  $('color-rules').append(card);
  updateRuleButtons();
  card.querySelector('.rule-name').focus();
});
$('add-calendar').addEventListener('click', () => {
  const card = calendarCard({});
  $('calendars').append(card);
  card.querySelector('.cal-name').focus();
});
$('fontScale').addEventListener('input', showFontScale);
$('dimEnabled').addEventListener('change', showDim);
$('allDaySame').addEventListener('change', () => { $('allDayColor').disabled = !$('allDaySame').checked; });
$('dimLevel').addEventListener('input', showDim);
$('settings-form').addEventListener('submit', save);
document.addEventListener('input', () => { if ($('message').className === 'ok') setMessage(''); });

load();
