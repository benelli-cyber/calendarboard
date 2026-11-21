# Family Dashboard

A self-hosted replacement for DAKboard. The server runs on the Proxmox LXC; the
Raspberry Pi 3B just shows `http://<lxc-ip>:8080/` in Chromium kiosk mode
(portrait, 1080×1920). See `CLAUDE.md` for the full spec and build phases.

**Status:** All phases done except remote access (Tailscale), which is postponed; notes in [`deploy/REMOTE-ACCESS.md`](deploy/REMOTE-ACCESS.md).

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

Use the small **4 Weeks | 3 Weeks | Week** button in the bottom-right corner to switch
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

## Color rules
Color events by words in their title: **Settings → Color rules**. Each rule
has a color and a list of words; the first matching rule wins (reorder with
↑ ↓). Matching is by whole word, any capitalization, plurals included
("dinner" matches "Dinners", "Lily" matches "Lily's" but not "family").
Starter rules color appointments pink and food yellow. By default rules skip
Saturday/Sunday events (tick "Also color Saturday & Sunday events" to change
that), and all-day events keep the all-day color.

## Google event colors (optional)
Google's iCal addresses don't include the color you give a single event. To
show those colors, follow [`deploy/GOOGLE-COLORS.md`](deploy/GOOGLE-COLORS.md):
about 15 minutes to create a free read-only Google "robot" account, share
your calendars with it, and put its key file on the LXC. The settings page
shows whether it's working. Without it, events use their calendar's color.

## Night dimming
Turn it on in **Settings → Display → Night dimming**: pick the hours (they can
cross midnight, e.g. 11 PM to 6 AM) and how dark. A black layer covers the
dashboard during those hours, so it's less bright in a dark room. It's off by
default. The Pi's screen itself stays on; this only darkens the picture.

## "Can't reach the server" note
If the dashboard can't reach the server for 5 minutes (LXC down, network
problem), a small amber note appears in the bottom-left corner: *Can't reach
the dashboard server since 3:05 PM*. Everything else stays on screen, but it
may be out of date. It clears as soon as the server answers again.

## Comparing weather sources (optional)
`scripts/compare-weather.js` logs, every hour, the nearest NWS station's
reading, the NWS hourly forecast for your exact spot, and Open-Meteo's value,
to `data/weather-compare.csv`. After a few days, `--summary` tells you how
they compare.

```bash
node scripts/compare-weather.js --once
```
```bash
node scripts/compare-weather.js --summary
```

For hourly logging on the LXC, run it from the `familydash` user's crontab
(`sudo crontab -u familydash -e`), adding this line:

```
5 * * * * cd /opt/family-dashboard && /usr/bin/node scripts/compare-weather.js --once >/dev/null 2>&1
```

(Or run it without `--once` in a terminal; it keeps going and logs at 5 past
each hour.) Remove the line again when you've seen enough. It doesn't affect
the dashboard.

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
- **Views:** `display.calendarView` is `"4weeks"` (this week plus the next
  three: always 4 Sun–Sat rows, even across months), `"3weeks"` (this week
  plus the next two, with taller days), or `"week"` (today + the next 6 days
  as 7 tall columns). Change it in
  `config.json` or with the on-screen button.
- The server fetches every enabled calendar every **5 minutes**
  (`server/calendar.js`). The dashboard polls `/api/calendar` every minute.
- Recurring events are expanded with `node-ical`, which handles RRULE,
  EXDATE, moved instances (RECURRENCE-ID), and DST. Cancelled events and
  instances are removed.
- Multi-day events appear on every day they cover. All-day events are solid
  orange bars (one shared color so they stand out; change it, or switch back
  to calendar colors, under Settings → Display → All-day events). Timed events
  are written in their calendar's color; ones that cross midnight show
  "→6:30a" on the next day.
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
  lat/lon (US only). The **current temperature** comes from NWS's hourly
  forecast for your exact location (feels-like from NWS's wind chill / heat
  index formulas). The nearest NWS *station* can be miles away; e.g. an
  airport that runs several degrees colder on clear mornings. You can switch
  to the station on the settings page ("Current temperature from"); then a
  missing or 2+ hour-old reading falls back to the forecast.
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
