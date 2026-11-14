# Family Dashboard

A self-hosted replacement for DAKboard. The server runs on the Proxmox LXC; the
Raspberry Pi 3B just shows `http://<lxc-ip>:8080/` in Chromium kiosk mode
(portrait, 1080×1920). See `CLAUDE.md` for the full spec and build phases.

**Status:** Phase 1 (core: clock, date, month/week calendar, portrait layout).

## Requirements
- Node.js 20+ (LTS)

## Quick start (demo data, no Google account needed)

```bash
npm install
CONFIG_PATH=config.demo.json npm start
```

Open <http://localhost:8080/> and set the browser viewport to **1080×1920**
(Chrome DevTools → device toolbar → "Responsive", 1080 × 1920).

Use the small **Month | Week** button in the bottom-right corner to switch
views. The choice is saved to the config file, so it also switches any other
screen showing the dashboard (like the Pi) within ~15 seconds.

The demo config reads the test fixtures in `test/fixtures/`, which are dated
in **November 2026**. In other months the calendar will look empty. One
demo calendar ("Broken") points at an invalid host on purpose, so you can
see the "Last updated" hint for a calendar that keeps failing.

## Real setup

1. Copy the example config: `cp config.example.json config.json`
2. For each Google Calendar: open Google Calendar on the web → ⚙ Settings →
   pick the calendar → **Integrate calendar** → copy **"Secret address in iCal
   format"** and paste it as that calendar's `url`.
3. `npm start`, then open `http://localhost:8080/`.

`config.json` holds the secret URLs. It is git-ignored, is never sent to the
browser, and the URLs are never written to logs.

## Commands

| Command        | What it does                                     |
| -------------- | ------------------------------------------------ |
| `npm start`    | Run the server                                   |
| `npm run dev`  | Run and restart automatically on server changes |
| `npm test`     | Run the calendar tests against the .ics fixtures |

## How the calendar works
- **Views:** `display.calendarView` is `"month"` (full Sun–Sat weeks covering
  the month) or `"week"` (this Sun–Sat week as 7 tall columns). Change it in
  `config.json` or with the on-screen button.
- The server fetches every enabled calendar every **5 minutes**
  (`server/calendar.js`). The dashboard polls `/api/calendar` every minute.
- Recurring events are expanded with `node-ical`, which handles RRULE,
  EXDATE, moved instances (RECURRENCE-ID), and DST. Cancelled events and
  instances are removed.
- Multi-day events appear on every day they cover. All-day events are solid
  colored bars; timed events that cross midnight show "→6:30a" on the next day.
- **Resilience:** if a fetch fails, or returns something that isn't a calendar,
  the last good copy is kept. Snapshots are saved in `data/calendar-cache/`,
  so a restart shows data right away. A calendar that hasn't updated in
  30 minutes gets a small "Last updated" note.
- If a day's events don't fit in its cell, the extra ones collapse into "+N more".

## API
| Route               | Returns                                     |
| ------------------- | ------------------------------------------- |
| `GET /api/config`   | Display settings (no calendar URLs)         |
| `GET /api/calendar` | Days for `?view=month` or `?view=week`, per-calendar status |
| `POST /api/display` | `{"calendarView":"week"}`: saves the view (used by the button) |
| `GET /api/health`   | `{ ok: true }`                              |
