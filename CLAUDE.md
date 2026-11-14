# Family Dashboard — DAKboard Replacement

## Project Overview
A self-hosted family dashboard replacing DAKboard. Displays time, date, Google Calendar events, accurate local weather, and a shared family to-do list. The backend runs in a Proxmox LXC; a Raspberry Pi 3B only displays the page in Chromium kiosk mode.

Family members keep adding events to the shared Google Calendar from their phones as they do today. The dashboard is **read-only** for calendars and needs no Google OAuth.

## Hardware & Display Constraints
- **Display device:** Raspberry Pi 3B (1 GB RAM, weak GPU), Chromium full-screen kiosk
- **Monitor:** 27", **PORTRAIT orientation, 1080×1920**. Rotation is already configured on the Pi; do not change it.
- **Viewing distance:** across a room. Text must be large, high-contrast, and readable from 10+ feet.
- The Pi needs no changes except pointing the kiosk URL at this app.

## Tech Stack (decided — do not substitute without asking)
- **Backend:** Node.js (LTS) + Express
- **iCal parsing:** `node-ical` (must correctly expand recurring events, handle EXDATE, all-day, multi-day, and timezones)
- **Storage:** SQLite via `better-sqlite3` (to-do list only)
- **Front end:** vanilla HTML/CSS/JS. **No frameworks, no build step, no bundler.**
- **Process management:** systemd service on the LXC
- **Timezone:** America/New_York
- **Units:** °F, mph, 12-hour clock

## Front-End Performance Rules (Pi 3B)
- No heavy animations, transitions, blur, shadows, or large background videos
- Minimal DOM updates: update only changed elements, never re-render the whole page every tick
- Clock updates once per second; data panels refresh on their own intervals
- No external CDNs or web fonts at runtime; serve everything locally (the display must work if the internet is down)
- Auto-reload the full page once daily at ~3:00 AM to clear Chromium memory growth
- Keep total JS small; no polyfills needed (modern Chromium)

## Architecture
```
Google Calendar (iCal secret URLs) ─┐
NWS api.weather.gov ────────────────┼──> LXC backend (Express)
Open-Meteo (fallback) ──────────────┘      ├─ caches calendar + weather in memory (+ disk snapshot)
                                           ├─ SQLite: to-dos
                                           ├─ GET /            → dashboard (portrait)
                                           ├─ GET /todo        → mobile to-do page
                                           ├─ GET /settings    → settings page
                                           └─ /api/*           → JSON
Pi 3B Chromium kiosk ──> http://<lxc-ip>:<port>/
Family phones ──> http://<lxc-ip>:<port>/todo  (LAN now, Tailscale later)
```

## Features

### 1. Time & Date
- Large clock (12-hour, no seconds or small seconds) and full date (e.g., "Saturday, November 14")
- Top of screen

### 2. Calendar
- Sources: multiple Google Calendar **secret iCal URLs** from `config.json`, each with a display name and color
- Fetch every **5 minutes** server-side; front end polls `/api/calendar`
- **Month view** (default): full Sun–Sat weeks covering the current month (4–6 rows), today's cell highlighted, past days and days outside the month dimmed
- **Week view**: the current week (Sun–Sat) as 7 tall columns with larger text
- Switch views via `display.calendarView` (`"month"` | `"week"`) in config, or the small **Month | Week** button at the bottom-right of the dashboard. The button saves the choice on the server (`POST /api/display`), so clicking it from any phone/computer on the LAN also switches the Pi within ~15 s
- Days whose events don't fit in a cell show "+N more"
- Correctly handle: recurring events, all-day events, multi-day events (show on each day spanned), cancelled instances, timezone conversion
- Each event: calendar color, time (or solid colored bar for all-day), title
- **Resilience:** if a fetch fails, keep serving the last good data. Never show a blank calendar. Show a small, subtle "last updated" indicator if data is stale (>30 min).

### 3. Weather
- **Primary:** National Weather Service API (`api.weather.gov`) using exact lat/lon from config
  - Resolve `/points/{lat},{lon}` once, cache the gridpoint/forecast URLs
  - Current conditions from the nearest observation station
  - Hourly + 7-day forecast
  - **Active alerts** for the location (`/alerts/active?point=lat,lon`). Display prominently in a colored banner when present.
  - Must send a descriptive `User-Agent` header (from config)
- **Fallback:** Open-Meteo (no key) if NWS fails or times out
- Refresh every **15 minutes**; cache last good result
- Display: current temp, feels-like, conditions icon, today's high/low, precip chance, and a compact 5-day forecast
- Icons: local SVGs (no external icon CDN)
- **Optional dev tool:** a script that logs NWS vs Open-Meteo current temps hourly to a CSV for comparison

### 4. Shared To-Do List
- Stored in SQLite: `id, text, done, created_at, done_at, added_by (optional)`
- **Dashboard:** shows open items; checked items show struck-through, then disappear after 24 h
- **`/todo` page:** mobile-first, large tap targets. Add item, check/uncheck, delete. Works as an "Add to Home Screen" web app (include a `manifest.json` and icon).
- No authentication (access is controlled at the network layer: LAN now, Tailscale later)
- Dashboard picks up changes within ~30 seconds

### 5. Settings Page (`/settings`)
- Simple form, phone/desktop friendly
- Edit: calendar names/colors/enabled, calendar view (month/week), weather location, theme (dark/light), font scale
- Saves to `config.json` (secret iCal URLs can be added but are masked when displayed)
- Dashboard applies changes on next poll without a manual reload

## Portrait Layout (1080×1920)
Top to bottom:
1. **Header:** clock + date (left), current weather (right)
2. **Weather alert banner** (only when an alert is active)
3. **Calendar:** month grid or Sun–Sat week view (fills the remaining space)
4. **5-day forecast strip**
5. **To-Do list** (bottom section)
- Small **Month | Week** toggle button in the bottom-right corner (inside the page margin)

- Default **dark theme** (better on a 24/7 display); optional light theme
- Base font size large (e.g., clock ~160px; month cells ~20px, week columns ~25px event titles); scale via config
- Optional: dim mode on a schedule (e.g., 11 PM–6 AM) to reduce glare/burn-in

## Configuration (`config.json`, never committed)
```json
{
  "port": 8080,
  "timezone": "America/New_York",
  "calendars": [
    { "name": "Family", "url": "https://calendar.google.com/calendar/ical/.../basic.ics", "color": "#4FC3F7", "enabled": true }
  ],
  "weather": {
    "lat": 0.0,
    "lon": 0.0,
    "userAgent": "family-dashboard (contact@example.com)",
    "units": "imperial"
  },
  "display": {
    "theme": "dark",
    "fontScale": 1.0,
    "calendarView": "month",
    "dimStart": "23:00",
    "dimEnd": "06:00"
  }
}
```
- Provide `config.example.json` (committed) with placeholders, and `config.demo.json` (committed) that reads the test fixtures
- `config.json` and `*.db` go in `.gitignore`

## Security
- Secret iCal URLs grant read access to calendars: **never commit, never log, never send to the front end**
- App is **LAN-only**. Never suggest port forwarding.
- Remote access (Phase 4) is via **Tailscale** only
- Sanitize to-do input (escape HTML on render)

## Project Structure
```
family-dashboard/
├── CLAUDE.md
├── README.md
├── package.json
├── config.example.json
├── .gitignore
├── server/
│   ├── index.js          # Express app, routes
│   ├── calendar.js       # iCal fetch, parse, expand, cache
│   ├── weather.js        # NWS primary, Open-Meteo fallback, cache
│   ├── todos.js          # SQLite CRUD
│   └── config.js         # load/save/validate config
├── public/
│   ├── index.html        # dashboard
│   ├── dashboard.css
│   ├── dashboard.js
│   ├── todo.html         # mobile to-do page
│   ├── todo.js
│   ├── settings.html
│   ├── settings.js
│   ├── manifest.json
│   └── icons/            # local weather + app icons (SVG)
├── scripts/
│   └── compare-weather.js
└── deploy/
    └── family-dashboard.service   # systemd unit
```

## Build Phases (do one at a time; confirm each works before moving on)
1. **Core:** Express server, config loading, clock/date, calendar from iCal with correct recurring-event handling, month/week calendar views, portrait layout. Viewable in a desktop browser at 1080×1920.
2. **Weather:** NWS + alerts + Open-Meteo fallback, caching, forecast strip
3. **To-Do:** SQLite, `/todo` mobile page, dashboard section, PWA manifest
4. **Settings page** + live config reload
5. **Deploy:** systemd unit, install instructions for the LXC, Pi kiosk URL change, daily reload
6. **Remote access:** Tailscale instructions for LXC and family phones
7. **Polish:** dim schedule, stale-data indicators, compare-weather script

## Testing & Verification
- After each phase, give the exact command to run locally and the URL to open
- Test the layout in a desktop browser with the viewport set to **1080×1920**
- Include a small set of test `.ics` fixtures covering recurring, all-day, multi-day, and cancelled events; verify parsing against them
- Simulate network failure (bad URL) to confirm last-good-data behavior
- Keep the code readable and commented; I will maintain this myself

## Working Style
- Explain briefly what you're about to change before large edits
- Prefer small, reviewable commits with clear messages
- Ask before adding any new dependency beyond those listed above
- Don't change the tech stack or layout direction without asking
