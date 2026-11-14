#!/usr/bin/env bash
# Family Dashboard kiosk launcher for the Raspberry Pi.
#
# Opens the dashboard full-screen in Chromium, but only once the dashboard
# server answers. After a power cut the Pi often boots faster than the LXC;
# without this wait, Chromium would show an error page until someone reloads it.
#
# Usage:   ~/pi-kiosk.sh http://192.168.1.50:8080/
# Run it from your desktop's autostart (see deploy/INSTALL.md, "Raspberry Pi").

set -u

URL="${1:?Usage: pi-kiosk.sh http://<lxc-ip>:8080/}"
HEALTH="${URL%/}/api/health"

# 1) Wait for the server (checks every 5 s, forever; usually only a few seconds).
until curl -fs -o /dev/null --max-time 3 "$HEALTH"; do
  echo "Waiting for the dashboard at $HEALTH ..."
  sleep 5
done

# 2) Don't show "Chromium didn't shut down correctly" after a power cut.
PREFS="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' "$PREFS"
fi

# 3) Chromium is "chromium-browser" on older Raspberry Pi OS, "chromium" on newer.
BROWSER="$(command -v chromium-browser || command -v chromium)"
if [ -z "$BROWSER" ]; then
  echo "Chromium not found. Install it with: sudo apt install chromium-browser" >&2
  exit 1
fi

exec "$BROWSER" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --no-first-run \
  "$URL"
