# Remote access with Tailscale (notes for later)

> **Status: not set up yet. This is Phase 6, postponed.** These are notes on
> the process so it's ready when you want it. They haven't been tested against
> this install, and Tailscale's apps and admin pages change over time, so check
> each step against Tailscale's own docs when you do it.

## What it gives you

- Family phones can open the to-do list (and settings) **away from home**, at
  an address like `http://family-dashboard:8080/todo`.
- Optionally **HTTPS** (`https://family-dashboard.<your-tailnet>.ts.net/todo`),
  which lets Android install the to-do page as a full-screen app.
- **No ports opened on your router.** Only devices signed in to your Tailscale
  network (your "tailnet") can reach the dashboard. Everyone else on the
  internet still sees nothing.

Nothing in the app needs to change; it already listens on all network
interfaces, including Tailscale's.

## Rules to keep

- **Never port-forward 8080** on the router.
- **Never use `tailscale funnel`.** Funnel publishes a service to the *whole
  internet*. `tailscale serve` (below) is the private, tailnet-only one.
- The dashboard has no password by design. Anyone you let into the tailnet can
  open the to-do list **and the settings page**, so only add people you'd also
  let onto your home Wi-Fi.

## Steps

### 1. Create a Tailscale account

Sign up at tailscale.com (a free personal plan is enough for a family; check
the current plan limits for users and devices).

### 2. Let the LXC use Tailscale (Proxmox)

Tailscale needs the `/dev/net/tun` device. Unprivileged LXCs don't have it by
default. On the **Proxmox host**, with the container stopped, add these two
lines to `/etc/pve/lxc/<container-id>.conf`:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Then start the container again.

(The alternative, without touching the host, is Tailscale's "userspace
networking" mode. It works, but is slower and fiddlier; prefer the two lines
above.)

### 3. Install Tailscale in the LXC

Inside the container:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```
```bash
tailscale up --hostname=family-dashboard
```

`tailscale up` prints a login link. Open it and approve the device. Then, in
the Tailscale admin console:

- Turn **off key expiry** for this machine, so it doesn't drop off the tailnet
  every few months.
- Make sure **MagicDNS** is on, so phones can use the name `family-dashboard`
  instead of a `100.x.y.z` address.

Check from the LXC:

```bash
tailscale status
```

### 4. Add the family's phones

On each phone:

1. Install the **Tailscale** app (App Store / Play Store).
2. Sign in. Either everyone uses the same account, or you invite family
   members to your tailnet from the admin console (each with their own login).
3. Leave Tailscale switched on. It only routes traffic for tailnet devices, so
   normal browsing isn't affected.

Then open `http://family-dashboard:8080/todo` and use *Add to Home Screen* as
before. That address works at home **and** away (as long as Tailscale is on).

### 5. Optional: HTTPS (full-screen app on Android)

In the admin console, enable **HTTPS certificates** for the tailnet. Then, in
the LXC:

```bash
tailscale serve --bg 8080
```

The dashboard is then also available at
`https://family-dashboard.<your-tailnet>.ts.net/` (the exact name shows in
`tailscale serve status`), to tailnet devices only. Use
`https://family-dashboard.<your-tailnet>.ts.net/todo` for *Add to Home Screen*;
on Android, Chrome then offers **Install app**.

The Pi can keep using the plain LAN address (`http://<lxc-ip>:8080/`); it
doesn't need Tailscale.

### 6. Optional: limit what family devices can reach

By default every device in a tailnet can reach every other one. If you also
use Tailscale for other machines, add a rule in the admin console's
**Access controls** so family members can only reach the dashboard (port 8080,
and 443 if you set up HTTPS) on `family-dashboard`. Tailscale's rules work
per machine and port, not per page, so they can't allow `/todo` while
blocking `/settings`.

## Undoing it

```bash
tailscale serve reset
```
```bash
tailscale down
```

Remove the machine in the admin console, and the two lines from the Proxmox
container config if you added them.
