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
- Resources: 1 CPU core, 512 MB RAM, 4 GB disk is plenty
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
apt update && apt install -y curl ca-certificates git sudo
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

This downloads a prebuilt SQLite module for your system. If it complains about
a missing compiler, install one and re-run the command:
`apt install -y python3 make g++`.

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

Get `deploy/pi-kiosk.sh` onto the Pi as `~/pi-kiosk.sh`, using either option:

- **Copy it from the LXC** (if you can SSH into the LXC), on the Pi:
  ```bash
  scp root@192.168.1.50:/opt/family-dashboard/deploy/pi-kiosk.sh ~/
  ```
- **Or paste it:** open the file on GitHub (`deploy/pi-kiosk.sh`), copy its
  contents, then on the Pi run `nano ~/pi-kiosk.sh`, paste, and save
  (Ctrl+O, Enter, Ctrl+X).

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
delete it or put `#` in front of it.

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
