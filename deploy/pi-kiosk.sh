#!/usr/bin/env bash
# Family Dashboard kiosk launcher for the Raspberry Pi.
#
# Opens the dashboard full-screen in Chromium, but only once
#   - the desktop is ready (display up, window manager running, screen
#     rotation applied). Started too early at boot, Chromium shows a blank
#     white screen until it's restarted; and
#   - the dashboard server answers. After a power cut the Pi often boots
#     faster than the LXC; without this wait, Chromium shows an error page.
#
# Usage:   ~/pi-kiosk.sh http://192.168.1.50:8080/
# Run it from your desktop's autostart (see deploy/INSTALL.md, "Raspberry Pi").

set -u

URL="${1:?Usage: pi-kiosk.sh http://<lxc-ip>:8080/}"
HEALTH="${URL%/}/api/health"

# 1) Wait for the desktop. Checks once a second, gives up waiting after 2 minutes
#    (then starts anyway, so a missing tool can never keep the screen empty).
export DISPLAY="${DISPLAY:-:0}"
last_size=""
stable=0
for _ in $(seq 1 120); do
  # Display up?
  if xset q >/dev/null 2>&1; then
    # Window manager running? (skip this check if xprop isn't installed)
    if ! command -v xprop >/dev/null || xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
      # Screen size unchanged for 5 seconds in a row = rotation is done.
      size="$(xrandr --current 2>/dev/null | grep -oE 'current [0-9]+ x [0-9]+')"
      if [ -n "$size" ] && [ "$size" = "$last_size" ]; then
        stable=$((stable + 1))
      else
        stable=0
      fi
      last_size="$size"
      [ "$stable" -ge 5 ] && break
    fi
  fi
  echo "Waiting for the desktop to be ready ..."
  sleep 1
done
echo "Desktop ready (${last_size:-size unknown})"

# 2) Wait for the server (checks every 5 s, forever; usually only a few seconds).
until curl -fs -o /dev/null --max-time 3 "$HEALTH"; do
  echo "Waiting for the dashboard at $HEALTH ..."
  sleep 5
done

# 3) Don't show "Chromium didn't shut down correctly" after a power cut.
PREFS="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' "$PREFS"
fi

# 4) Chromium is "chromium-browser" on older Raspberry Pi OS, "chromium" on newer.
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
