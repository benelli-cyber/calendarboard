'use strict';
/**
 * Shared family to-do list, stored in SQLite (better-sqlite3).
 *
 * Table: todos(id, text, done, created_at, done_at, added_by, due_date)
 *   - Timestamps are ISO-8601 strings in UTC.
 *   - due_date is optional, a plain calendar date "YYYY-MM-DD" (no time).
 *   - Open items are listed by due date (earliest/overdue first), then items
 *     without a date (newest first), then checked items.
 *   - Checked items stay visible (struck through) for 24 hours after being
 *     checked, then drop out of list(). Rows older than 30 days are deleted.
 *
 * Text is stored exactly as typed (minus control characters). It is never
 * turned into HTML: the front end always inserts it with textContent.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MAX_TEXT = 200;
const MAX_NAME = 30;
const DONE_VISIBLE_MS = 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Error with an HTTP status, so routes can return 400/404 without guessing. */
class TodoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Trim, collapse whitespace, drop control characters. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "" / null → null; otherwise must be a real date "YYYY-MM-DD". */
function cleanDueDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) return value;
  }
  throw new TodoError(400, 'Due date must be a date like 2026-12-03');
}

/** DB row → API object. */
function toItem(row) {
  return {
    id: row.id,
    text: row.text,
    done: row.done === 1,
    createdAt: row.created_at,
    doneAt: row.done_at,
    addedBy: row.added_by,
    dueDate: row.due_date || null,
  };
}

class TodoStore {
  /** @param {string} dbPath  file path, or ':memory:' for tests */
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // safe, fast concurrent reads
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        text       TEXT    NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL,
        done_at    TEXT,
        added_by   TEXT
      )
    `);
    // Databases from before due dates existed get the new column (existing items keep no date).
    const columns = this.db.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
    if (!columns.includes('due_date')) this.db.exec('ALTER TABLE todos ADD COLUMN due_date TEXT');

    this.stmt = {
      // Open items: dated ones first (earliest/overdue first), then undated (newest first);
      // then checked items (most recently checked first).
      list: this.db.prepare(`
        SELECT * FROM todos
        WHERE done = 0 OR done_at > ?
        ORDER BY done ASC,
                 CASE WHEN done = 0 AND due_date IS NOT NULL THEN 0 ELSE 1 END,
                 CASE WHEN done = 0 THEN due_date END ASC,
                 CASE WHEN done = 0 THEN created_at ELSE done_at END DESC,
                 id DESC
      `),
      get: this.db.prepare('SELECT * FROM todos WHERE id = ?'),
      add: this.db.prepare('INSERT INTO todos (text, created_at, added_by, due_date) VALUES (?, ?, ?, ?)'),
      setDue: this.db.prepare('UPDATE todos SET due_date = ? WHERE id = ?'),
      setDone: this.db.prepare('UPDATE todos SET done = ?, done_at = ? WHERE id = ?'),
      remove: this.db.prepare('DELETE FROM todos WHERE id = ?'),
      purge: this.db.prepare('DELETE FROM todos WHERE done = 1 AND done_at < ?'),
    };
  }

  /** Open items plus items checked within the last 24 hours. */
  list(now = new Date()) {
    const cutoff = new Date(now.getTime() - DONE_VISIBLE_MS).toISOString();
    return this.stmt.list.all(cutoff).map(toItem);
  }

  add(text, addedBy, now = new Date(), dueDate = null) {
    const clean = cleanText(text, MAX_TEXT);
    if (!clean) throw new TodoError(400, 'Text is required');
    const due = cleanDueDate(dueDate);
    const name = cleanText(addedBy, MAX_NAME) || null;
    const { lastInsertRowid } = this.stmt.add.run(clean, now.toISOString(), name, due);
    return toItem(this.stmt.get.get(lastInsertRowid));
  }

  setDone(id, done, now = new Date()) {
    if (typeof done !== 'boolean') throw new TodoError(400, '"done" must be true or false');
    const row = this.stmt.get.get(id);
    if (!row) throw new TodoError(404, 'Item not found');
    // Re-checking an already-checked item keeps its original done_at.
    const doneAt = done ? row.done_at || now.toISOString() : null;
    this.stmt.setDone.run(done ? 1 : 0, doneAt, id);
    return toItem(this.stmt.get.get(id));
  }

  /** Change the due date ("YYYY-MM-DD", or null/"" to clear it). */
  setDue(id, dueDate) {
    const due = cleanDueDate(dueDate);
    if (!this.stmt.get.get(id)) throw new TodoError(404, 'Item not found');
    this.stmt.setDue.run(due, id);
    return toItem(this.stmt.get.get(id));
  }

  /** PATCH body: { done?, dueDate? } (at least one). */
  update(id, changes = {}) {
    const hasDone = changes.done !== undefined;
    const hasDue = changes.dueDate !== undefined;
    if (!hasDone && !hasDue) throw new TodoError(400, 'Nothing to change (send "done" and/or "dueDate")');
    let item;
    if (hasDue) item = this.setDue(id, changes.dueDate);
    if (hasDone) item = this.setDone(id, changes.done);
    return item;
  }

  remove(id) {
    if (this.stmt.remove.run(id).changes === 0) throw new TodoError(404, 'Item not found');
  }

  /** Delete checked items older than 30 days so the database stays small. */
  purge(now = new Date()) {
    return this.stmt.purge.run(new Date(now.getTime() - PURGE_AFTER_MS).toISOString()).changes;
  }

  close() {
    this.db.close();
  }
}

module.exports = { TodoStore, TodoError, MAX_TEXT, MAX_NAME };
