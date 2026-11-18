# Showing each event's own Google color

Google's secret iCal addresses don't include the color you pick for a single
event in Google Calendar. To show those colors (like DAKboard did), the
dashboard asks Google's Calendar API for them, using a **service account**: a
free "robot" Google account that you share your calendars with, read-only.

- Events still come from your iCal addresses; only **colors** come from Google.
- Events without their own color keep their calendar's color (set on the
  settings page).
- If anything goes wrong, events just keep their calendar color. The calendar
  never goes blank because of this.
- Optional: without the key file the feature stays off.

One-time setup, about 15 minutes. Do steps 1–4 on a computer.

## 1. Create a Google Cloud project

1. Go to **console.cloud.google.com** and sign in with your Google account.
   (Any account works; it doesn't have to own the calendars.)
2. Accept the terms if asked. No billing or credit card is needed for this.
3. At the top, click the project picker → **New project** → name it
   `family-dashboard` → **Create**. Make sure it's selected afterwards.

## 2. Turn on the Google Calendar API

**APIs & Services → Library** → search **Google Calendar API** → open it →
**Enable**.

## 3. Create the robot account and its key

1. **IAM & Admin → Service accounts → + Create service account**.
2. Name: `dashboard-colors` → **Create and continue**. Skip the optional
   "roles" and "users" steps → **Done**.
3. Click the new account. Note its email address; it looks like
   `dashboard-colors@family-dashboard-123456.iam.gserviceaccount.com`.
4. **Keys** tab → **Add key → Create new key → JSON → Create**. A `.json`
   file downloads.

Treat that file like a password: it's the robot's login. If you ever lose
control of it, delete the key on this same page and create a new one.

(If Google says key creation is disabled by an organization policy, you're
signed in with a work/school account. Use a personal Google account instead.)

## 4. Share your calendars with the robot

In **Google Calendar** (calendar.google.com) on a computer, for **each**
calendar on the dashboard:

1. ⚙ **Settings** → click the calendar on the left.
2. **Share with specific people or groups → + Add people and groups**.
3. Paste the robot's email address, and set permission to
   **See all event details**. (*See only free/busy* is not enough.)
4. **Send**. Google may warn that the address is outside your organization;
   that's fine.

## 5. Put the key on the LXC

From your computer, copy the downloaded file to the LXC (replace the file name
and IP). Windows PowerShell, macOS and Linux all have `scp`:

```bash
scp ~/Downloads/family-dashboard-123456-abcdef.json admin@192.168.1.231:/tmp/key.json
```

Then, on the LXC, move it into place so only the app can read it, and delete
the temporary copy:

```bash
sudo install -o familydash -g familydash -m 600 /tmp/key.json /opt/family-dashboard/google-service-account.json && rm /tmp/key.json
```

You can delete the downloaded file from your computer afterwards (or keep it
somewhere safe).

## 6. Check it

The dashboard notices the key file by itself within 5 minutes; to check right
away, restart it: `sudo systemctl restart family-dashboard`.

Open **Settings** (`http://<lxc-ip>:8080/settings`). Under the calendars it
says:

| Message | Meaning |
| ------- | ------- |
| **Event colors from Google: on ✓** | Working. Colors appear on the dashboard within a minute. |
| **\<calendar\>: not shared with … yet** | Do step 4 for that calendar (sharing can take a few minutes to take effect). |
| **Google Calendar API has not been used in project …** | Do step 2 (and wait a few minutes). |
| **Google sign-in failed** | The key file is wrong, or that key was deleted in Google Cloud. Redo step 3.4 and step 5. |
| **off** | No key file at `/opt/family-dashboard/google-service-account.json`. Redo step 5. |

## Turning it off

Delete the key file on the LXC
(`sudo rm /opt/family-dashboard/google-service-account.json`). Optionally
also delete the key in Google Cloud and remove the robot from each calendar's
sharing list.
