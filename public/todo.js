/*
 * Family to-do page (phones). Talks to /api/todos.
 *
 * - Item text is always inserted with textContent (never innerHTML).
 * - Re-syncs every 15 s while the page is visible, so changes made on one
 *   phone show up on the others.
 * - "Your name" is remembered on this phone only (localStorage) and is shown
 *   under the items you add.
 */
'use strict';

const POLL_MS = 15 * 1000;
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "YYYY-MM-DD" for a local date, plus `days`. */
function isoDay(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Label + style for a due date: Today / Tomorrow / Wed / Dec 3, overdue in red. */
function dueInfo(dueDate) {
  if (!dueDate) return { text: 'Add date', cls: '' };
  const [y, m, d] = dueDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (dueDate < isoDay(0)) return { text: `Overdue · ${MONTH_DAY.format(date)}`, cls: 'set overdue' };
  if (dueDate === isoDay(0)) return { text: 'Today', cls: 'set today' };
  if (dueDate === isoDay(1)) return { text: 'Tomorrow', cls: 'set' };
  if (dueDate <= isoDay(6)) return { text: WEEKDAY.format(date), cls: 'set' };
  return { text: MONTH_DAY.format(date), cls: 'set' };
}
const $ = (id) => document.getElementById(id);
let items = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showError(message) {
  const box = $('error');
  box.textContent = message || '';
  box.hidden = !message;
}

/** fetch wrapper: JSON in/out, throws a friendly error on failure. */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the dashboard. Are you on the home network?");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Something went wrong (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function itemRow(item) {
  const li = el('li', item.done ? 'item done' : 'item');

  const check = el('button', 'check');
  check.type = 'button';
  check.setAttribute('aria-label', `${item.done ? 'Uncheck' : 'Check off'} ${item.text}`);
  check.addEventListener('click', () => toggle(item));

  const text = el('span', 'text', item.text);
  if (item.addedBy) text.append(el('span', 'by', item.addedBy));

  // Due date chip. The real date input sits invisibly on top of it, so a tap
  // opens the phone's own calendar picker (with its Clear/Reset button).
  const info = dueInfo(item.dueDate);
  const due = el('label', `due ${info.cls}`, info.text);
  const picker = el('input');
  picker.type = 'date';
  picker.value = item.dueDate || '';
  picker.setAttribute('aria-label', `Due date for ${item.text}`);
  picker.addEventListener('change', () => setDue(item, picker.value || null));
  due.append(picker);

  const del = el('button', 'del', '✕');
  del.type = 'button';
  del.setAttribute('aria-label', `Delete ${item.text}`);
  del.addEventListener('click', () => remove(item));

  li.append(check, text, due, del);
  return li;
}

function render() {
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  $('open-list').replaceChildren(...open.map(itemRow));
  $('done-list').replaceChildren(...done.map(itemRow));
  $('empty').hidden = open.length > 0;
  $('done-heading').hidden = done.length === 0;
  $('count').textContent = open.length ? `${open.length} to do` : '';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function load() {
  try {
    items = (await api('GET', '/api/todos')).items;
    render();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function setDue(item, dueDate) {
  try {
    await api('PATCH', `/api/todos/${item.id}`, { dueDate });
  } catch (err) {
    showError(err.message);
  }
  load(); // re-sorts the list by date
}

function showClearDue() {
  $('clear-due').hidden = !$('add-due').value;
}

async function add(event) {
  event.preventDefault();
  const input = $('add-text');
  const text = input.value.trim();
  if (!text) return;
  const button = event.submitter || document.querySelector('.add-btn');
  button.disabled = true; // no double adds from a double tap
  try {
    await api('POST', '/api/todos', {
      text,
      addedBy: $('name').value.trim() || undefined,
      dueDate: $('add-due').value || undefined,
    });
    input.value = '';
    $('add-due').value = '';
    showClearDue();
    await load();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function toggle(item) {
  // Update the screen right away; the server confirms in the background.
  item.done = !item.done;
  render();
  try {
    await api('PATCH', `/api/todos/${item.id}`, { done: item.done });
  } catch (err) {
    showError(err.message);
  }
  load();
}

async function remove(item) {
  if (!confirm(`Delete "${item.text}"?`)) return;
  try {
    await api('DELETE', `/api/todos/${item.id}`);
  } catch (err) {
    showError(err.message);
  }
  load();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const nameInput = $('name');
nameInput.value = localStorage.getItem('todo-name') || '';
nameInput.addEventListener('change', () => localStorage.setItem('todo-name', nameInput.value.trim()));

$('add-form').addEventListener('submit', add);
$('add-due').addEventListener('change', showClearDue);
$('clear-due').addEventListener('click', (e) => {
  e.preventDefault();
  $('add-due').value = '';
  showClearDue();
});

load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
// Refresh right away when the app is reopened from the home screen.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
