'use strict';
/**
 * Calendar: fetch Google Calendar secret iCal URLs, parse them with node-ical,
 * expand recurring events, and bucket everything into days for the dashboard.
 *
 * Two layers:
 *   buildAgenda()    – pure function: parsed calendars + "now" → per-day event lists.
 *                      Easy to test with fixtures (see test/calendar.test.js).
 *   CalendarService  – fetches every few minutes, keeps the LAST GOOD copy of each
 *                      calendar in memory and on disk, never blanks the display.
 *
 * TIMEZONE NOTE: day boundaries use the process's local time, so the server
 * sets process.env.TZ to config.timezone at startup (see server/index.js).
 *
 * SECURITY NOTE: calendar URLs are secrets. They are never logged and never
 * included in anything this module returns. Calendars are identified by a hash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ical = require('node-ical');

const FETCH_TIMEOUT_MS = 20_000;
const STALE_AFTER_MS = 30 * 60 * 1000; // show "last updated" hint after 30 min

// ---------------------------------------------------------------------------
// Small date helpers (all in process-local time = config timezone)
// ---------------------------------------------------------------------------

/** Local midnight of the given date, plus `days` days. DST-safe (uses calendar math). */
function startOfDay(date, days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** "2026-11-14" in local time. */
function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Whole calendar days between two local midnights (DST-safe via rounding). */
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

function makeFormatters(timezone) {
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts });
  const time = fmt({ hour: 'numeric', minute: '2-digit' });
  const weekday = fmt({ weekday: 'long' });
  const monthDay = fmt({ month: 'short', day: 'numeric' });
  // Intl uses a narrow no-break space before AM/PM; normalize to a plain space.
  return {
    time: (d) => time.format(d).replace(/ /g, ' '),
    weekday: (d) => weekday.format(d),
    monthDay: (d) => monthDay.format(d),
  };
}

// ---------------------------------------------------------------------------
// Expansion + bucketing
// ---------------------------------------------------------------------------

function isCancelled(ev) {
  return String(ev?.status || '').toUpperCase() === 'CANCELLED';
}

/**
 * Expand one calendar's parsed data into concrete instances within [from, to).
 * node-ical's expandRecurringEvent handles RRULE, EXDATE, RECURRENCE-ID
 * overrides and DST. We additionally drop cancelled events/instances.
 */
function expandCalendar(parsed, from, to) {
  const out = [];
  for (const ev of Object.values(parsed || {})) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (isCancelled(ev)) continue;

    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, {
        from,
        to,
        expandOngoing: true, // include multi-day events that started before `from`
      });
    } catch (err) {
      // One malformed event must not take down the whole calendar.
      console.warn(`[calendar] Skipping event "${ev.summary || '?'}": ${err.message}`);
      continue;
    }

    for (const inst of instances) {
      if (isCancelled(inst.event)) continue; // cancelled single instance (override)
      let end = inst.end && inst.end > inst.start ? inst.end : inst.start;
      if (inst.isFullDay && end <= inst.start) end = startOfDay(inst.start, 1);
      if (inst.start >= to || end < from) continue;
      if (end.getTime() === from.getTime() && end > inst.start) continue; // ended exactly at window start
      out.push({
        title: String(inst.summary || ev.summary || '(No title)').trim(),
        start: inst.start,
        end,
        allDay: Boolean(inst.isFullDay),
      });
    }
  }
  return out;
}

/** Does [start, end) touch the day [dayStart, dayEnd)? Zero-length events count on their start day. */
function overlapsDay(start, end, dayStart, dayEnd) {
  if (end.getTime() === start.getTime()) return start >= dayStart && start < dayEnd;
  return start < dayEnd && end > dayStart;
}

/**
 * Build the dashboard's agenda.
 *
 * @param {Array<{name:string,color:string,parsed:object}>} sources
 * @param {{now?:Date, daysAhead?:number, timezone:string}} opts
 * @returns {Array<{date, weekday, monthDay, relative, events:[]}>} one entry per day
 */
function buildAgenda(sources, { now = new Date(), daysAhead = 7, timezone }) {
  const f = makeFormatters(timezone);
  const windowStart = startOfDay(now);
  const windowEnd = startOfDay(now, daysAhead);

  const days = [];
  for (let i = 0; i < daysAhead; i++) {
    const start = startOfDay(now, i);
    days.push({
      start,
      end: startOfDay(now, i + 1),
      info: {
        date: dayKey(start),
        weekday: f.weekday(start),
        monthDay: f.monthDay(start),
        relative: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : null,
        events: [],
      },
    });
  }

  for (const src of sources) {
    for (const ev of expandCalendar(src.parsed, windowStart, windowEnd)) {
      const multiDay = ev.allDay
        ? daysBetween(ev.start, ev.end) > 1
        : dayKey(ev.start) !== dayKey(new Date(ev.end - 1));
      const totalDays = ev.allDay ? daysBetween(ev.start, ev.end) : null;

      for (const day of days) {
        if (!overlapsDay(ev.start, ev.end, day.start, day.end)) continue;

        // Decide what to show in the "time" column for this particular day.
        let time;
        let note = null;
        let allDayToday = ev.allDay;
        if (ev.allDay) {
          time = 'All day';
          if (multiDay) note = `Day ${daysBetween(ev.start, day.start) + 1} of ${totalDays}`;
        } else if (ev.start >= day.start) {
          time = f.time(ev.start); // starts today
        } else if (ev.end <= day.end) {
          time = `Until ${f.time(ev.end)}`; // started earlier, ends today
        } else {
          time = 'All day'; // started earlier, ends later
          allDayToday = true;
        }

        day.info.events.push({
          title: ev.title,
          calendar: src.name,
          color: src.color,
          allDay: allDayToday,
          time,
          note,
          start: ev.start.toISOString(),
          end: ev.end.toISOString(),
          // sort key: all-day/continuing events first, then by start time on this day
          _sort: allDayToday ? -1 : Math.max(ev.start, day.start),
        });
      }
    }
  }

  for (const day of days) {
    day.info.events.sort((a, b) => a._sort - b._sort || a.title.localeCompare(b.title));
    day.info.events.forEach((e) => delete e._sort);
  }
  return days.map((d) => d.info);
}

// ---------------------------------------------------------------------------
// Fetching + caching
// ---------------------------------------------------------------------------

/** Stable, non-secret id for a calendar URL (used for cache filenames). */
function calendarId(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** Remove anything that looks like a URL from an error message before logging. */
function scrub(message) {
  return String(message).replace(/\b(?:https?|webcal|file):\S+/gi, '[url]');
}

/**
 * Download one calendar's .ics text.
 * Supports https://, webcal:// (rewritten to https), and file: paths
 * (relative to the project root) for local testing with fixtures.
 */
async function fetchIcs(url, { rootDir, fetchImpl = fetch } = {}) {
  if (url.startsWith('file:')) {
    const p = url.replace(/^file:(\/\/)?/, '');
    return fs.promises.readFile(path.resolve(rootDir || '.', p), 'utf8');
  }
  const res = await fetchImpl(url.replace(/^webcal:/i, 'https:'), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'text/calendar, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Parse .ics text; throws if it doesn't look like a calendar (e.g. an HTML error page). */
function parseIcs(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('Response is not an iCalendar file');
  return ical.sync.parseICS(text);
}

class CalendarService {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig  returns the current (normalized) config
   * @param {string} opts.cacheDir         where last-good .ics snapshots are kept
   * @param {string} opts.rootDir          base for file: URLs
   * @param {number} [opts.intervalMs]     refresh interval (default 5 min)
   * @param {Function} [opts.fetchImpl]    injectable fetch (tests)
   */
  constructor({ getConfig, cacheDir, rootDir, intervalMs = 5 * 60 * 1000, fetchImpl }) {
    this.getConfig = getConfig;
    this.cacheDir = cacheDir;
    this.rootDir = rootDir;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl || fetch;
    /** id → { parsed, lastSuccess: Date|null, lastAttempt: Date|null, error: string|null } */
    this.state = new Map();
    this.version = 0; // bumps whenever data changes, used to memoize the agenda
    this.memo = null;
    this.refreshing = null;
    this.timer = null;
  }

  enabledCalendars() {
    return this.getConfig().calendars.filter((c) => c.enabled);
  }

  /** Load last-good snapshots from disk so the dashboard has data instantly after a restart. */
  loadSnapshots() {
    for (const cal of this.enabledCalendars()) {
      const id = calendarId(cal.url);
      const file = path.join(this.cacheDir, `${id}.ics`);
      try {
        const text = fs.readFileSync(file, 'utf8');
        this.state.set(id, {
          parsed: parseIcs(text),
          lastSuccess: fs.statSync(file).mtime,
          lastAttempt: null,
          error: null,
        });
        this.version++;
      } catch {
        /* no snapshot yet – fine */
      }
    }
  }

  async refreshOne(cal) {
    const id = calendarId(cal.url);
    const prev = this.state.get(id) || { parsed: null, lastSuccess: null };
    const now = new Date();
    try {
      const text = await fetchIcs(cal.url, { rootDir: this.rootDir, fetchImpl: this.fetchImpl });
      const parsed = parseIcs(text);
      this.state.set(id, { parsed, lastSuccess: now, lastAttempt: now, error: null });
      this.version++;
      // Snapshot to disk (best effort). Write-then-rename so a crash can't leave half a file.
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        const tmp = path.join(this.cacheDir, `${id}.ics.tmp`);
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, path.join(this.cacheDir, `${id}.ics`));
      } catch (err) {
        console.warn(`[calendar] Could not write snapshot for "${cal.name}": ${scrub(err.message)}`);
      }
    } catch (err) {
      // Keep serving the previous good data; just record the failure.
      const reason = scrub(err.cause?.code || err.message);
      console.warn(`[calendar] Fetch failed for "${cal.name}" (keeping last good data): ${reason}`);
      this.state.set(id, { ...prev, lastAttempt: now, error: reason });
      this.version++; // status changed, so the memoized payload must be rebuilt
    }
  }

  /** Refresh all enabled calendars in parallel. Overlapping calls share one run. */
  refreshAll() {
    if (!this.refreshing) {
      this.refreshing = Promise.all(this.enabledCalendars().map((c) => this.refreshOne(c)))
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  start() {
    this.loadSnapshots();
    this.refreshAll();
    this.timer = setInterval(() => this.refreshAll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The JSON payload for GET /api/calendar. Contains no URLs. */
  getAgenda(now = new Date()) {
    const cfg = this.getConfig();
    const cals = this.enabledCalendars();
    // Recompute only when data, config, or the day changes.
    const memoKey = `${this.version}|${dayKey(now)}|${cfg.calendarDaysAhead}|` +
      cals.map((c) => `${c.name}${c.color}`).join(',');
    if (this.memo?.key === memoKey) return this.memo.value;

    const sources = [];
    const status = [];
    for (const cal of cals) {
      const s = this.state.get(calendarId(cal.url));
      if (s?.parsed) sources.push({ name: cal.name, color: cal.color, parsed: s.parsed });
      status.push({
        name: cal.name,
        color: cal.color,
        lastSuccess: s?.lastSuccess ? s.lastSuccess.toISOString() : null,
        error: s?.error || null,
      });
    }

    const days = buildAgenda(sources, { now, daysAhead: cfg.calendarDaysAhead, timezone: cfg.timezone });

    // "updatedAt" = the OLDEST successful fetch among calendars, so staleness of any one shows.
    const successes = status.map((s) => s.lastSuccess);
    const updatedAt = successes.includes(null) ? null : successes.sort()[0] || null;

    const value = { updatedAt, days, calendars: status };
    this.memo = { key: memoKey, value };
    return value;
  }

  /** Staleness is computed per request, so it isn't frozen inside the memo. */
  getPayload(now = new Date()) {
    const agenda = this.getAgenda(now);
    const isStale = (iso) => !iso || now - new Date(iso) > STALE_AFTER_MS;
    return {
      ...agenda,
      stale: agenda.calendars.length > 0 && isStale(agenda.updatedAt),
      calendars: agenda.calendars.map((c) => ({ ...c, stale: isStale(c.lastSuccess) })),
    };
  }
}

module.exports = { buildAgenda, CalendarService, parseIcs, fetchIcs, calendarId, scrub, STALE_AFTER_MS };
