# Family Dashboard

A self-hosted replacement for DAKboard. The server runs on the Proxmox LXC; the
Raspberry Pi 3B just shows `http://<lxc-ip>:8080/` in Chromium kiosk mode
(portrait, 1080×1920). See `CLAUDE.md` for the full spec and build phases.

**Status:** Phase 5 done (all features + deployment files). Remote access (Tailscale) is postponed; notes in [`deploy/REMOTE-ACCESS.md`](deploy/REMOTE-ACCESS.md). Next: polish (dim schedule, compare-weather script).

**Installing on the LXC and Pi:** see [`deploy/INSTALL.md`](deploy/INSTALL.md).

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
3. Set your weather location: in Google Maps, right-click your house and click
   the coordinates to copy them, then put them in `weather.lat` / `weather.lon`
   (e.g. `38.8894` and `-77.0352`). Set `weather.userAgent` to something like
   `"family-dashboard (you@example.com)"`. The National Weather Service asks
   apps to identify themselves with a contact address.
4. `npm start`, then open `http://localhost:8080/`.

`config.json` holds the secret URLs. It is git-ignored, is never sent to the
browser, and the URLs are never written to logs.

## Automatic page reloads
The dashboard reloads itself once a night around 3 AM (clears Chromium's memory
growth on the Pi), and within ~15 seconds after the server restarts (so an
update reaches the Pi without touching it). Both first check that the server
answers, so the screen never lands on an error page.

## Commands

| Command        | What it does                                     |
| -------------- | ------------------------------------------------ |
| `npm start`    | Run the server                                   |
| `npm run dev`  | Run and restart automatically on server changes |
| `npm test`     | Run the calendar tests against the .ics fixtures |

## How the calendar works
- **Views:** `display.calendarView` is `"month"` (full Sun–Sat weeks covering
  the month) or `"week"` (today + the next 6 days as 7 tall columns). Change it in
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

## Settings page
Open `http://<lxc-ip>:8080/settings` on a phone or computer on the home network.
- **Calendars:** rename, recolor, show/hide, remove, add a new one (paste its
  secret iCal address), or replace an address. Saved addresses stay on the
  server; the page only ever shows a shortened version
  (`calendar.google.com/…/basic.ics`).
- **Display:** month or week view, dark or light theme, text size.
- **Weather:** paste your coordinates straight from Google Maps
  (`38.8894, -77.0352` or `38.8894° N, 77.0352° W`) and a contact for
  weather.gov. The page shows the current weather so you can confirm it works.
- Saving writes `config.json` (other settings, like the port, are kept) and
  the dashboard picks up the change within ~15 seconds, with no reload. Invalid
  entries are highlighted and nothing is saved.
- Like the to-do list, the settings page has no password: anyone on your home
  network (or, later, your Tailscale network) can open it.
- Editing `config.json` by hand still works, but needs a restart to apply.

## Shared to-do list
- On any phone on the home network, open `http://<lxc-ip>:8080/todo`. Add
  items, tap the box to check one off, tap ✕ to delete (asks first).
  Optionally type your name at the bottom; your phone remembers it and shows it
  under the items you add.
- The dashboard shows open items (newest first), then checked items, struck
  through, for 24 hours. It picks up changes within ~20 seconds; open phone
  pages re-sync every 15 seconds.
- Stored in SQLite at `data/todos.db` (git-ignored). Checked items older than
  30 days are deleted automatically. Override the location with `TODO_DB=...`.
- **Add to Home Screen:**
  - **iPhone (Safari):** Share → *Add to Home Screen*. It opens full-screen
    like an app, with its own icon.
  - **Android (Chrome):** ⋮ → *Add to Home screen*. Over plain `http://` on
    the LAN, Chrome adds a shortcut that opens in a browser tab; the
    full-screen "install as app" mode needs HTTPS, which the Tailscale phase
    can provide.

## How the weather works
- **Primary:** National Weather Service (`api.weather.gov`) for your exact
  lat/lon (US only). Current conditions come from the nearest weather
  station's latest observation. If that is missing or more than 2 hours old,
  the current hour's forecast is used instead.
- **Fallback:** if NWS fails or takes longer than 10 seconds, Open-Meteo is
  used (no API key). The forecast panel then shows a small "via Open-Meteo".
- Refreshes every **15 minutes**. **Alerts** (watches, warnings, advisories)
  are checked every **5 minutes** and shown in a colored banner under the
  clock: red for severe/extreme, orange for moderate, yellow for minor. An
  alert disappears when it ends, even if the internet is down.
- The last good result is kept in memory and in `data/weather.json`. If both
  services fail, the dashboard keeps showing the last data. After 45 minutes
  it adds a small "Weather updated …" note.
- Icons are local SVGs in `public/icons/` (no internet needed to show them).

## API
| Route               | Returns                                     |
| ------------------- | ------------------------------------------- |
| `GET /api/config`   | Display settings (no calendar URLs)         |
| `GET /api/calendar` | Days for `?view=month` or `?view=week`, per-calendar status |
| `POST /api/display` | `{"calendarView":"week"}`: saves the view (used by the button) |
| `GET /api/weather`  | Current conditions, today, 5-day forecast, alerts |
| `GET /api/todos`    | Open items + items checked in the last 24 h |
| `POST /api/todos`   | `{"text":"Milk","addedBy":"Mom"}` → new item |
| `PATCH /api/todos/:id` | `{"done":true}` or `{"done":false}`      |
| `DELETE /api/todos/:id` | Delete an item                          |
| `GET /api/settings` | Editable settings (calendar URLs masked)    |
| `PUT /api/settings` | Save settings (used by the settings page)   |
| `GET /api/health`   | `{ ok: true }`                              |
