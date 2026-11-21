# Installing the Family Dashboard

Two machines are involved:

| Machine | Role |
| ------- | ---- |
| **Proxmox LXC** | Runs the dashboard server (Node.js). Fetches calendars and weather, stores the to-do list. |
| **Raspberry Pi 3B** | Only shows `http://<lxc-ip>:8080/` full-screen in Chromium. |

Commands below assume **Debian 12 or Ubuntu 22.04/24.04** in the LXC and
**Raspberry Pi OS** on the Pi. Replace `192.168.1.50` with your LXC's address
everywhere.

> **Keep it on your home network.** Never forward port 8080 on your router.
> Remote access comes later, through Tailscale.

---

## Part 1: The LXC

### 1.1 Create the container (Proxmox)

- Template: Debian 12 (or Ubuntu 24.04)
- Resources: 1 CPU core, 4 GB disk, and **1 GB RAM during install** (the
  SQLite module may need compiling, which is memory-hungry). The running app
  is happy with 512 MB, so you can lower it afterwards.
- Network: give it a **fixed address**, either a static IP on the container
  or a DHCP reservation in your router. The Pi and phones need an address that
  never changes.
- Time zone isn't critical (the app uses `America/New_York` from its config),
  but correct time is: make sure the container's clock is synced (Proxmox
  containers use the host's clock).

Open the container's console (or SSH in) and run everything below as root.
(Proxmox's Debian templates log you in as root and don't include `sudo`; step
1.2 installs it, because later steps use `sudo -u familydash` to run commands
as the app's user.)

### 1.2 Install Node.js 22 LTS and git

Debian's own Node.js is too old, so use the NodeSource packages:

```bash
apt update && apt install -y curl ca-certificates git sudo python3 make g++
```
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
```
```bash
apt install -y nodejs
```
```bash
node -v
```

`node -v` should print `v22.x`. Also run `which node`: the service file
expects `/usr/bin/node`. If yours differs, edit `ExecStart` in step 1.6.

### 1.3 Create a user and download the app

The app runs as its own user with no login and no special rights:

```bash
useradd --system --create-home --home-dir /var/lib/familydash --shell /usr/sbin/nologin familydash
```
```bash
git clone https://github.com/benelli-cyber/calendarboard.git /opt/family-dashboard
```
```bash
chown -R familydash:familydash /opt/family-dashboard
```

If the GitHub repo is **private**, `git clone` asks for a username and
password. Use your GitHub username and a **fine-grained personal access
token** (GitHub → Settings → Developer settings → Fine-grained tokens) with
read-only *Contents* access to just this repo, as the password.

### 1.4 Install the app's dependencies

```bash
cd /opt/family-dashboard && sudo -u familydash npm ci --omit=dev
```

This installs the app's libraries. The SQLite module is either downloaded
prebuilt or compiled on the spot (that's what `python3 make g++` from step 1.2
are for); compiling takes a few minutes. It should end with
`added 72 packages`. If it stops with `Killed`, give the container more memory
(Proxmox → container → Resources → Memory, 1024 MB) and run it again.

### 1.5 Create the config file

```bash
sudo -u familydash cp /opt/family-dashboard/config.example.json /opt/family-dashboard/config.json
```
```bash
chmod 600 /opt/family-dashboard/config.json
```

`chmod 600` matters: this file holds your secret calendar addresses, so only the
app's user may read it.

You can fill in the details now with `nano /opt/family-dashboard/config.json`,
or leave the placeholders and use the **settings page** after step 1.6
(easier). Either way, you'll need:

- **Calendars:** for each Google Calendar: on a computer, Google Calendar →
  ⚙ Settings → click the calendar → *Integrate calendar* → copy
  **Secret address in iCal format**.
- **Weather location:** right-click your house in Google Maps and copy the
  coordinates.
- **Weather contact:** `family-dashboard (your-email)`. The National
  Weather Service asks apps to identify themselves.

Do a quick test run (stop it with Ctrl+C):

```bash
cd /opt/family-dashboard && sudo -u familydash node server/index.js
```

Then open `http://192.168.1.50:8080/` from a computer on your network. You
should see the dashboard. A placeholder calendar address just shows "Last
updated: Family (never loaded)" until you set a real one.

### 1.6 Run it as a service

This starts the dashboard at boot and restarts it if it ever crashes:

```bash
cp /opt/family-dashboard/deploy/family-dashboard.service /etc/systemd/system/
```
```bash
systemctl daemon-reload && systemctl enable --now family-dashboard
```
```bash
systemctl status family-dashboard
```

`status` should say **active (running)**. Useful commands:

| What | Command |
| ---- | ------- |
| Live log | `journalctl -u family-dashboard -f` |
| Restart | `systemctl restart family-dashboard` |
| Stop | `systemctl stop family-dashboard` |

### 1.7 Finish setup in the browser

Open `http://192.168.1.50:8080/settings` on your phone or computer and set:
calendars, weather location and contact, view, theme, text size. Save. The
dashboard picks up changes within about 15 seconds.

### 1.8 Firewall (optional)

If you use a firewall in the LXC, allow port 8080 from your home network only
(adjust the range to match your network):

```bash
apt install -y ufw && ufw allow from 192.168.1.0/24 to any port 8080 proto tcp && ufw allow OpenSSH && ufw enable
```

---

## Part 2: The Raspberry Pi

The Pi only needs to open the new address instead of DAKboard. The screen
rotation you already set up stays as it is.

### 2.1 Copy the kiosk launcher

Get `deploy/pi-kiosk.sh` onto the Pi as `~/pi-kiosk.sh`. The simplest way is
to paste it:

1. On the Pi's browser or your computer, open `deploy/pi-kiosk.sh` on GitHub
   (signed in, if the repo is private) and click the **copy** button (two
   overlapping squares, top right of the file).
2. On the Pi (terminal, or SSH from your computer as your normal Pi user):
   `nano ~/pi-kiosk.sh`, paste (right-click, or Ctrl+Shift+V), then save with
   Ctrl+O, Enter, Ctrl+X.

(`scp root@<lxc-ip>:...` usually fails with "Permission denied": Debian's SSH
doesn't allow password logins for root, which is a good default to keep.)

Then make it executable:

```bash
chmod +x ~/pi-kiosk.sh
```

Test it once from the Pi's desktop terminal. Chromium should open the dashboard
full-screen (press Alt+F4 to close it):

```bash
~/pi-kiosk.sh http://192.168.1.50:8080/
```

The launcher waits until the server answers before opening Chromium, so after a
power cut the Pi never gets stuck on an error page if it boots before the LXC.

### 2.2 Start it automatically (replace DAKboard)

First, **turn off whatever opens DAKboard now**: look in the same autostart
file as below for a line with your DAKboard URL (or a `chromium` line) and
delete it or put `#` in front of it. If no autostart file mentions it, DAKboard
is probably started by a service: see option D.

Which file to edit depends on your Raspberry Pi OS desktop. Check with:

```bash
echo $XDG_SESSION_TYPE; ls ~/.config/labwc ~/.config/wayfire.ini ~/.config/lxsession 2>/dev/null
```

**A) labwc** (current Raspberry Pi OS; there is a `~/.config/labwc` folder).
Add this line to `~/.config/labwc/autostart` (create the file if needed):

```
/home/pi/pi-kiosk.sh http://192.168.1.50:8080/ &
```

**B) Wayfire** (Raspberry Pi OS Bookworm before late 2024; there is a
`~/.config/wayfire.ini`). Add to the `[autostart]` section of
`~/.config/wayfire.ini` (create the section if it's missing):

```
dashboard = /home/pi/pi-kiosk.sh http://192.168.1.50:8080/
```

**C) X11 / LXDE** (Raspberry Pi OS Bullseye or older, or X11 selected in
raspi-config). Add to `~/.config/lxsession/LXDE-pi/autostart`:

```
@/home/pi/pi-kiosk.sh http://192.168.1.50:8080/
```

If that file doesn't exist yet, copy the system one first, because a personal
file *replaces* it entirely:
`mkdir -p ~/.config/lxsession/LXDE-pi && cp /etc/xdg/lxsession/LXDE-pi/autostart ~/.config/lxsession/LXDE-pi/`

**D) A systemd user service** (how DAKboard's Pi setup starts Chromium).
Check with `systemctl --user list-unit-files --state=enabled`: if you see
`dakboard.service` (or another kiosk service), don't use A–C. Instead,
create `~/.config/systemd/user/family-dashboard-kiosk.service`:

```
[Unit]
Description=Family Dashboard kiosk (Chromium)
After=network.target

[Service]
ExecStart=/home/pi/pi-kiosk.sh http://192.168.1.50:8080/
Restart=always
RestartSec=5
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/1000

[Install]
WantedBy=default.target
```

(`1000` is your user's id; check with `id -u`.) Then switch over:

```bash
systemctl --user daemon-reload && systemctl --user disable --now dakboard.service && pkill -f /usr/lib/chromium/chromium; systemctl --user enable --now family-dashboard-kiosk.service
```

**Also check for a DAKboard restart timer.** Some DAKboard setups add a timer
that restarts DAKboard every few minutes, which brings it back even when its
service is off. List timers with `systemctl --user list-timers --all`; if
`dakboard-restart.timer` (or similar) shows up, turn it off:

```bash
systemctl --user disable --now dakboard-restart.timer
```

To go back to DAKboard, and to return to the dashboard (`pkill` closes the
running Chromium window, which keeps running outside the service):

```bash
systemctl --user disable --now family-dashboard-kiosk.service && pkill -f /usr/lib/chromium/chromium; systemctl --user enable --now dakboard.service dakboard-restart.timer
```
```bash
systemctl --user disable --now dakboard.service dakboard-restart.timer && pkill -f /usr/lib/chromium/chromium; systemctl --user enable --now family-dashboard-kiosk.service
```

(Leave out `dakboard-restart.timer` if your Pi doesn't have one.)

Whichever one you switch to last is the one that starts after a reboot.

Replace `/home/pi` if your username isn't `pi`.

### 2.3 Keep the screen on

```bash
sudo raspi-config
```

*Display Options → Screen Blanking → No*. Then reboot:

```bash
sudo reboot
```

**Hiding the mouse pointer:** on X11 (option C), `sudo apt install unclutter`
and add `@unclutter -idle 1 -root` to the same autostart file. On labwc or
Wayfire there's no single reliable switch; unplugging the mouse, or leaving the
pointer at a screen edge, works.

### 2.4 Automatic reloads (nothing to set up)

The dashboard page reloads itself:
- **once a night around 3 AM**, to clear Chromium's memory growth on the Pi,
  and
- **within ~15 seconds of the server restarting**, e.g. after an update, so
  the Pi always runs the current version.

Both wait until the server answers, so the screen never lands on an error page.

---

## Updating to a new version

On the LXC:

```bash
cd /opt/family-dashboard && sudo -u familydash git pull && sudo -u familydash npm ci --omit=dev
```
```bash
systemctl restart family-dashboard
```

The Pi reloads the new version by itself within about 15 seconds.

## Backups

Everything worth keeping is in two places on the LXC:

- `/opt/family-dashboard/config.json`: settings and secret calendar addresses
- `/opt/family-dashboard/data/todos.db`: the to-do list

A Proxmox backup of the container covers both. To copy them by hand, stop the
service first so the database is in a clean state:

```bash
systemctl stop family-dashboard && tar czf /root/family-dashboard-backup.tgz -C /opt/family-dashboard config.json data/todos.db && systemctl start family-dashboard
```

(`data/` also holds calendar and weather caches; they rebuild themselves.)

## Troubleshooting

| Symptom | What to check |
| ------- | ------------- |
| `systemctl status` shows *failed* | `journalctl -u family-dashboard -n 50`. Common causes: wrong `node` path in the service file (`which node`), `config.json` missing or not valid JSON, or the files not owned by `familydash` (`chown -R familydash:familydash /opt/family-dashboard`). |
| Page doesn't load from other devices | Is the service running? Is the address right (`ip -4 addr` in the LXC)? Is a firewall blocking port 8080? |
| "Last updated: <calendar> (never loaded)" | That calendar's address is wrong or not the *secret* iCal address. Replace it on the settings page. The log shows the error (but never the address). |
| Weather says "Set weather.lat / weather.lon" | Set your location on the settings page. |
| Weather shows "via Open-Meteo" | The National Weather Service didn't answer; this is the automatic fallback and usually clears up by itself. |
| Pi shows a Chromium error page | Make sure autostart runs `pi-kiosk.sh` (not Chromium directly), so it waits for the server. |
| Settings won't save ("Could not save settings") | The `familydash` user must own `config.json` and the folder: `chown -R familydash:familydash /opt/family-dashboard`. |
