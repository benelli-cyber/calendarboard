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
// Load / render / save
// ---------------------------------------------------------------------------

function render(s) {
  $('calendars').replaceChildren(...s.calendars.map(calendarCard));
  document.querySelector(`input[name=calendarView][value=${s.display.calendarView}]`).checked = true;
  document.querySelector(`input[name=theme][value=${s.display.theme}]`).checked = true;
  $('fontScale').value = s.display.fontScale;
  showFontScale();
  $('coords').value = formatCoords(s.weather.lat, s.weather.lon);
  $('userAgent').value = s.weather.userAgent || '';
}

function showFontScale() {
  $('fontScale-value').textContent = `${Math.round($('fontScale').value * 100)}%`;
}

/** Show what the dashboard's weather looks like right now (confirms the location works). */
async function showWeatherStatus() {
  const box = $('weather-status');
  try {
    const w = await (await fetch('/api/weather', { cache: 'no-store' })).json();
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
  const m = /^calendars\.(\d+)\.(\w+)$/.exec(field);
  if (m) {
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
    display: {
      calendarView: document.querySelector('input[name=calendarView]:checked').value,
      theme: document.querySelector('input[name=theme]:checked').value,
      fontScale: Number($('fontScale').value),
    },
    weather: { ...coords, userAgent: $('userAgent').value },
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
  } catch {
    setMessage("Can't load settings. Are you on the home network?", 'error');
  }
}

$('add-calendar').addEventListener('click', () => {
  const card = calendarCard({});
  $('calendars').append(card);
  card.querySelector('.cal-name').focus();
});
$('fontScale').addEventListener('input', showFontScale);
$('settings-form').addEventListener('submit', save);
document.addEventListener('input', () => { if ($('message').className === 'ok') setMessage(''); });

load();
