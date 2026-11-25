'use strict';
// Run with: npm test
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { TodoStore, MAX_TEXT } = require('../server/todos');
const { createApp } = require('../server/index');

const T0 = new Date('2026-11-14T12:00:00Z');
const hours = (h) => new Date(T0.getTime() + h * 3600e3);

test('add, list newest-first, check, uncheck, delete', () => {
  const s = new TodoStore(':memory:');
  const milk = s.add('Milk', 'Mom', hours(0));
  const eggs = s.add('Eggs', null, hours(1));
  assert.deepEqual(s.list(hours(2)).map((i) => i.text), ['Eggs', 'Milk']);
  assert.equal(milk.addedBy, 'Mom');
  assert.equal(eggs.addedBy, null);

  const done = s.setDone(milk.id, true, hours(2));
  assert.equal(done.done, true);
  assert.equal(done.doneAt, hours(2).toISOString());
  // Checked items go after open ones.
  assert.deepEqual(s.list(hours(3)).map((i) => `${i.text}:${i.done}`), ['Eggs:false', 'Milk:true']);

  const undone = s.setDone(milk.id, false, hours(3));
  assert.equal(undone.done, false);
  assert.equal(undone.doneAt, null);

  s.remove(eggs.id);
  assert.deepEqual(s.list(hours(4)).map((i) => i.text), ['Milk']);
});

test('checked items disappear 24 h after being checked', () => {
  const s = new TodoStore(':memory:');
  const a = s.add('Return library books', null, hours(0));
  s.setDone(a.id, true, hours(1));
  assert.equal(s.list(hours(24)).length, 1, 'still visible at 23 h');
  assert.equal(s.list(hours(25.5)).length, 0, 'gone after 24 h');
});

test('re-checking keeps the original check time', () => {
  const s = new TodoStore(':memory:');
  const a = s.add('Bread', null, hours(0));
  s.setDone(a.id, true, hours(1));
  assert.equal(s.setDone(a.id, true, hours(5)).doneAt, hours(1).toISOString());
});

test('purge removes items checked more than 30 days ago', () => {
  const s = new TodoStore(':memory:');
  const a = s.add('Old', null, hours(0));
  s.add('Open item', null, hours(0));
  s.setDone(a.id, true, hours(0));
  assert.equal(s.purge(hours(24 * 31)), 1);
  assert.equal(s.purge(hours(24 * 31)), 0);
});

test('input is cleaned and validated', () => {
  const s = new TodoStore(':memory:');
  assert.equal(s.add('  Pick   up\n\tdry cleaning  ').text, 'Pick up dry cleaning');
  assert.equal(s.add('x'.repeat(500)).text.length, MAX_TEXT);
  // HTML is stored as plain text (the front end renders it with textContent).
  assert.equal(s.add('<img src=x onerror=alert(1)>').text, '<img src=x onerror=alert(1)>');
  assert.throws(() => s.add('   '), { status: 400 });
  assert.throws(() => s.add(42), { status: 400 });
  assert.throws(() => s.setDone(999, true), { status: 404 });
  assert.throws(() => s.setDone(1, 'yes'), { status: 400 });
  assert.throws(() => s.remove(999), { status: 404 });
});

test('due dates: earliest first, then undated (newest first), then checked', () => {
  const s = new TodoStore(':memory:');
  s.add('No date, older', null, hours(0));
  s.add('Due Dec 3', null, hours(1), '2026-12-03');
  s.add('No date, newer', null, hours(2));
  s.add('Overdue Nov 20', null, hours(3), '2026-11-20');
  const done = s.add('Checked', null, hours(4), '2026-11-01');
  s.setDone(done.id, true, hours(5));
  assert.deepEqual(s.list(hours(6)).map((i) => i.text),
    ['Overdue Nov 20', 'Due Dec 3', 'No date, newer', 'No date, older', 'Checked']);
  assert.equal(s.list(hours(6))[0].dueDate, '2026-11-20');
});

test('due dates: set, change, clear, and validate', () => {
  const s = new TodoStore(':memory:');
  const a = s.add('Permission slip');
  assert.equal(a.dueDate, null);
  assert.equal(s.update(a.id, { dueDate: '2026-12-01' }).dueDate, '2026-12-01');
  assert.equal(s.update(a.id, { dueDate: '' }).dueDate, null, 'empty string clears it');
  assert.equal(s.update(a.id, { dueDate: '2026-12-02', done: true }).done, true);
  for (const bad of ['2026-02-30', '12/03/2026', '2026-1-5', 20261203]) {
    assert.throws(() => s.add('x', null, new Date(), bad), { status: 400 }, String(bad));
  }
  assert.throws(() => s.update(a.id, {}), { status: 400 });
  assert.throws(() => s.update(999, { dueDate: '2026-12-01' }), { status: 404 });
});

test('a to-do database from before due dates is upgraded in place', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-todo-')), 'todos.db');
  const Database = require('better-sqlite3');
  const old = new Database(file);
  old.exec(`CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, done_at TEXT, added_by TEXT)`);
  old.prepare('INSERT INTO todos (text, created_at) VALUES (?, ?)').run('Old item', T0.toISOString());
  old.close();
  const s = new TodoStore(file);
  assert.deepEqual(s.list(hours(1)).map((i) => [i.text, i.dueDate]), [['Old item', null]]);
  const b = s.add('New item', null, hours(1), '2026-12-24');
  assert.equal(b.dueDate, '2026-12-24');
  s.close();
});

// ---------------------------------------------------------------------------
// HTTP API (real Express app on a random port, in-memory database)
// ---------------------------------------------------------------------------

async function startApi(t) {
  const todos = new TodoStore(':memory:');
  const app = createApp({
    getConfig: () => ({}), setConfig: () => {}, calendar: {}, weather: {}, todos,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { call, base };
}

test('API: full add / check / delete cycle', async (t) => {
  const { call } = await startApi(t);
  let r = await call('POST', '/api/todos', { text: 'Buy milk', addedBy: 'Dad' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.text, 'Buy milk');

  r = await call('GET', '/api/todos');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body.items.map((i) => i.text), ['Buy milk']);

  r = await call('PATCH', `/api/todos/${id}`, { done: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.done, true);

  r = await call('DELETE', `/api/todos/${id}`);
  assert.equal(r.status, 204);
  r = await call('GET', '/api/todos');
  assert.deepEqual(r.body.items, []);
});

test('API: add with a due date, change it, clear it', async (t) => {
  const { call } = await startApi(t);
  let r = await call('POST', '/api/todos', { text: 'Dentist forms', dueDate: '2026-12-03' });
  assert.equal(r.status, 201);
  assert.equal(r.body.dueDate, '2026-12-03');
  r = await call('PATCH', `/api/todos/${r.body.id}`, { dueDate: null });
  assert.equal(r.body.dueDate, null);
  assert.equal((await call('POST', '/api/todos', { text: 'x', dueDate: 'soon' })).status, 400);
  assert.equal((await call('PATCH', `/api/todos/${r.body.id}`, {})).status, 400);
});

test('API: bad input gets 400/404, not 500', async (t) => {
  const { call } = await startApi(t);
  assert.equal((await call('POST', '/api/todos', { text: '' })).status, 400);
  assert.equal((await call('POST', '/api/todos', {})).status, 400);
  assert.equal((await call('POST', '/api/todos', '{not json')).status, 400);
  assert.equal((await call('PATCH', '/api/todos/abc', { done: true })).status, 400);
  assert.equal((await call('PATCH', '/api/todos/77', { done: true })).status, 404);
  assert.equal((await call('DELETE', '/api/todos/77')).status, 404);
});

test('API: form-encoded (cross-site style) posts are rejected', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'text=spam',
  });
  assert.equal(res.status, 400);
});
