'use strict';
// Run with: npm test
const test = require('node:test');
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
