'use strict';
/**
 * Calendar: fetch Google Calendar secret iCal URLs, parse them with node-ical,
 * expand recurring events, and bucket everything into days for the dashboard.
 *
 * Two layers:
 *   buildDays()      – pure function: parsed calendars + a date range → per-day event lists.
 *                      Easy to test with fixtures (see test/calendar.test.js).
 *   CalendarService  – fetches every few minutes, keeps the LAST GOOD copy of each
 *                      calendar in memory and on disk, never blanks the display.
 *
 * Views:
 *   "month" – full weeks (Sun–Sat) covering the current month: 4–6 rows of 7 days
 *   "week"  – rolling: today + the next 6 days
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
const { startOfDay, dayKey, daysBetween } = require('./dates');

const FETCH_TIMEOUT_MS = 20_000;
const STALE_AFTER_MS = 30 * 60 * 1000; // show "last updated" hint after 30 min
const WEEK_STARTS_ON = 0; // 0 = Sunday, 1 = Monday
const VIEWS = ['month', 'week'];

// ---------------------------------------------------------------------------
// Small date helpers (all in process-local time = config timezone)
// ---------------------------------------------------------------------------

/** Local midnight of the first day of the week containing `date`. */
function startOfWeek(date) {
  return startOfDay(date, -((date.getDay() - WEEK_STARTS_ON + 7) % 7));
}

const NARROW_NBSP = new RegExp(String.fromCharCode(0x202f), 'g');

function makeFormatters(timezone) {
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts });
  const time = fmt({ hour: 'numeric', minute: '2-digit' });
  const weekday = fmt({ weekday: 'long' });
  const monthDay = fmt({ month: 'short', day: 'numeric' });
  const monthYear = fmt({ month: 'long', year: 'numeric' });
  // Intl puts a narrow no-break space before AM/PM; normalize to a plain space.
  const t = (d) => time.format(d).replace(NARROW_NBSP, ' ');
  return {
    time: t,
    /** Compact time for month cells: "9a", "4:30p", "12p". */
    shortTime: (d) => t(d).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p'),
    weekday: (d) => weekday.format(d),
    monthDay: (d) => monthDay.format(d),
    monthYear: (d) => monthYear.format(d),
  };
}

/**
 * The date range for a view.
 * @returns {{start: Date, dayCount: number, title: string}}
 */
function viewRange(view, now, timezone) {
  const f = makeFormatters(timezone);
  if (view === 'week') {
    const start = startOfDay(now); // rolling week: today is always the first column
    const end = startOfDay(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    // "Nov 14 – 20, 2026" or "Nov 29 – Dec 5, 2026"
    const title = `${f.monthDay(start)} – ${sameMonth ? end.getDate() : f.monthDay(end)}, ${end.getFullYear()}`;
    return { start, dayCount: 7, title };
  }
  // Month: from the start of the week containing the 1st to the end of the week containing the last day.
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const dayCount = daysBetween(start, startOfDay(startOfWeek(last), 7));
  return { start, dayCount, title: f.monthYear(first) };
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
        uid: inst.event?.uid || ev.uid, // used to look up the event's own Google color
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
 * Build per-day event lists for a date range.
 *
 * @param {Array<{name:string,color:string,parsed:object,eventColor?:Function}>} sources
 *   eventColor(ev) may return an event's own color (Google event colors), or null.
 * @param {object} opts
 * @param {Date}   [opts.now]       current time (for "today"/"past" flags)
 * @param {Date}   [opts.start]     first day shown (defaults to today)
 * @param {number} [opts.dayCount]  number of days (default 7)
 * @param {Date}   [opts.focusMonthOf] days outside this date's month get inMonth=false
 * @param {string} opts.timezone
 * @returns {Array<object>} one entry per day
 */
function buildDays(sources, { now = new Date(), start, dayCount = 7, focusMonthOf, timezone }) {
  const f = makeFormatters(timezone);
  const first = startOfDay(start || now);
  const windowEnd = startOfDay(first, dayCount);
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(startOfDay(now, 1));
  const today = startOfDay(now);

  const days = [];
  for (let i = 0; i < dayCount; i++) {
    const dStart = startOfDay(first, i);
    const key = dayKey(dStart);
    days.push({
      start: dStart,
      end: startOfDay(first, i + 1),
      info: {
        date: key,
        dayOfMonth: dStart.getDate(),
        weekday: f.weekday(dStart),
        monthDay: f.monthDay(dStart),
        relative: key === todayKey ? 'Today' : key === tomorrowKey ? 'Tomorrow' : null,
        isToday: key === todayKey,
        isPast: dStart < today,
        inMonth: focusMonthOf ? dStart.getMonth() === focusMonthOf.getMonth() : true,
        events: [],
      },
    });
  }

  for (const src of sources) {
    for (const ev of expandCalendar(src.parsed, first, windowEnd)) {
      const multiDay = ev.allDay && daysBetween(ev.start, ev.end) > 1;
      const totalDays = ev.allDay ? daysBetween(ev.start, ev.end) : null;

      for (const day of days) {
        if (!overlapsDay(ev.start, ev.end, day.start, day.end)) continue;

        // Decide what to show in the "time" column for this particular day.
        let time;
        let shortTime = null; // compact label for month cells; null = all day
        let note = null;
        let allDayToday = ev.allDay;
        if (ev.allDay) {
          time = 'All day';
          if (multiDay) note = `Day ${daysBetween(ev.start, day.start) + 1} of ${totalDays}`;
        } else if (ev.start >= day.start) {
          time = f.time(ev.start); // starts today
          shortTime = f.shortTime(ev.start);
        } else if (ev.end <= day.end) {
          time = `Until ${f.time(ev.end)}`; // started earlier, ends today
          shortTime = `→${f.shortTime(ev.end)}`;
        } else {
          time = 'All day'; // started earlier, ends later
          allDayToday = true;
        }

        day.info.events.push({
          title: ev.title,
          calendar: src.name,
          color: (src.eventColor && src.eventColor(ev)) || src.color,
          allDay: allDayToday,
          time,
          shortTime,
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
   * @param {object} [opts.eventColors]     optional GoogleColors (per-event colors)
   */
  constructor({ getConfig, cacheDir, rootDir, intervalMs = 5 * 60 * 1000, fetchImpl, eventColors = null }) {
    this.eventColors = eventColors;
    this.getConfig = getConfig;
    this.cacheDir = cacheDir;
    this.rootDir = rootDir;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl || fetch;
    /** id → { parsed, lastSuccess: Date|null, lastAttempt: Date|null, error: string|null } */
    this.state = new Map();
    this.version = 0; // bumps whenever data or status changes, used to memoize
    this.memo = new Map(); // view → { key, value }
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

  /** Refresh all enabled calendars (and event colors) in parallel. Overlapping calls share one run. */
  refreshAll() {
    if (!this.refreshing) {
      const cals = this.enabledCalendars();
      this.refreshing = Promise.all([
        ...cals.map((c) => this.refreshOne(c)),
        this.refreshColors(cals),
      ]).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** Per-event Google colors (optional). Failures only mean events keep calendar colors. */
  async refreshColors(cals) {
    if (!this.eventColors) return;
    try {
      await this.eventColors.refresh(cals);
    } catch (err) {
      console.warn(`[colors] ${scrub(err.message)}`);
    }
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

  /** Days + per-calendar status for a view. Memoized per view; contains no URLs. */
  getView(view, now = new Date()) {
    const cfg = this.getConfig();
    const cals = this.enabledCalendars();
    // Recompute only when data, config, view, or the day changes.
    const memoKey = `${this.version}|${this.eventColors?.version || 0}|${dayKey(now)}|` +
      cals.map((c) => `${calendarId(c.url)}${c.name}${c.color}`).join(',');
    const cached = this.memo.get(view);
    if (cached?.key === memoKey) return cached.value;

    const sources = [];
    const status = [];
    for (const cal of cals) {
      const s = this.state.get(calendarId(cal.url));
      if (s?.parsed) {
        sources.push({
          name: cal.name,
          color: cal.color,
          parsed: s.parsed,
          eventColor: this.eventColors
            ? (ev) => this.eventColors.colorFor(cal.url, ev.uid, ev.start, ev.allDay)
            : null,
        });
      }
      status.push({
        name: cal.name,
        color: cal.color,
        lastSuccess: s?.lastSuccess ? s.lastSuccess.toISOString() : null,
        error: s?.error || null,
      });
    }

    const range = viewRange(view, now, cfg.timezone);
    const days = buildDays(sources, {
      now,
      start: range.start,
      dayCount: range.dayCount,
      focusMonthOf: view === 'month' ? now : null,
      timezone: cfg.timezone,
    });

    // "updatedAt" = the OLDEST successful fetch among calendars, so staleness of any one shows.
    const successes = status.map((s) => s.lastSuccess);
    const updatedAt = successes.includes(null) ? null : successes.sort()[0] || null;

    const value = { view, title: range.title, updatedAt, days, calendars: status };
    this.memo.set(view, { key: memoKey, value });
    return value;
  }

  /** The JSON payload for GET /api/calendar. Staleness is computed per request. */
  getPayload(view = 'month', now = new Date()) {
    if (!VIEWS.includes(view)) view = 'month';
    const data = this.getView(view, now);
    const isStale = (iso) => !iso || now - new Date(iso) > STALE_AFTER_MS;
    return {
      ...data,
      stale: data.calendars.length > 0 && isStale(data.updatedAt),
      calendars: data.calendars.map((c) => ({ ...c, stale: isStale(c.lastSuccess) })),
    };
  }
}

module.exports = {
  buildDays, viewRange, CalendarService, parseIcs, fetchIcs, calendarId, scrub, STALE_AFTER_MS, VIEWS,
};
