'use strict';
/**
 * Optional: each event's own color from Google Calendar.
 *
 * Google's secret iCal feeds don't include per-event colors (the color you
 * pick for a single event in Google Calendar). This module asks Google's
 * Calendar API for them, using a "service account": a free robot Google
 * account that you share your calendars with (read-only). Setup steps:
 * deploy/GOOGLE-COLORS.md.
 *
 * Events still come from the iCal feeds. Only colors come from here, matched
 * to iCal events by their unique id (UID) and start time. If anything goes
 * wrong, events simply keep their calendar's color; the calendar never breaks.
 *
 * SECURITY: the key file is a secret (like the iCal URLs). It stays on the
 * server, is git-ignored, and is never logged or sent to the browser. Only
 * the robot account's email address is shown on the settings page, because
 * you need it to share your calendars.
 *
 * No extra npm packages: the sign-in token (a signed "JWT") is made with
 * Node's built-in crypto module.
 */
const fs = require('fs');
const crypto = require('crypto');
const { startOfDay, dayKey } = require('./dates');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 15_000;

/** Google Calendar's event colors (colorId → the color shown in Google Calendar). */
const EVENT_COLORS = {
  1: '#7986CB', // Lavender
  2: '#33B679', // Sage
  3: '#8E24AA', // Grape
  4: '#E67C73', // Flamingo
  5: '#F6BF26', // Banana
  6: '#F4511E', // Tangerine
  7: '#039BE5', // Peacock
  8: '#616161', // Graphite
  9: '#3F51B5', // Blueberry
  10: '#0B8043', // Basil
  11: '#D50000', // Tomato
};

/**
 * The Google calendar id is part of the secret iCal address:
 * https://calendar.google.com/calendar/ical/<calendar id>/private-…/basic.ics
 */
function calendarIdFromUrl(url) {
  const m = /^(?:https|webcal):\/\/calendar\.google\.com\/calendar\/ical\/([^/]+)\//i.exec(url || '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const base64url = (input) => Buffer.from(input).toString('base64url');

/** A signed sign-in request for the service account (RS256 JWT). */
function signJwt(key, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri || DEFAULT_TOKEN_URI,
    iat,
    exp: iat + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Key for one event occurrence: its UID plus its start (date for all-day, exact time otherwise). */
function instanceKey(uid, start, allDay) {
  return allDay ? `${uid}|${dayKey(start)}` : `${uid}|${start.getTime()}`;
}

class GoogleColors {
  /**
   * @param {object} opts
   * @param {() => string} opts.getKeyFile  path of the service account key (JSON)
   * @param {Function} [opts.fetchImpl]     injectable fetch (tests)
   */
  constructor({ getKeyFile, fetchImpl }) {
    this.getKeyFile = getKeyFile;
    this.fetchImpl = fetchImpl || fetch;
    this.token = null;        // { value, expiresAt }
    this.tokenFor = null;     // client_email the token belongs to
    this.maps = new Map();    // calendar id → { instances: Map, series: Map }
    this.errors = new Map();  // calendar name → message
    this.error = null;        // problem with the key or sign-in
    this.email = null;
    this.updatedAt = null;
    this.version = 0;         // bumps when colors change, so the calendar re-renders
  }

  /** Read the key file. Re-read on every refresh, so adding/replacing it needs no restart. */
  readKey() {
    const file = this.getKeyFile();
    if (!file || !fs.existsSync(file)) return null;
    let key;
    try {
      key = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('The service account key file is not valid JSON');
    }
    if (!key.client_email || !key.private_key) {
      throw new Error('The key file is missing client_email/private_key. Download a JSON key for the service account.');
    }
    return key;
  }

  isConfigured() {
    const file = this.getKeyFile();
    return Boolean(file && fs.existsSync(file));
  }

  async request(url, options = {}) {
    const res = await this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error_description || body.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** Sign in as the service account (cached until shortly before it expires). */
  async accessToken(key, now) {
    if (this.token && this.tokenFor === key.client_email && this.token.expiresAt - 60_000 > now.getTime()) {
      return this.token.value;
    }
    const body = await this.request(key.token_uri || DEFAULT_TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(key, now),
      }).toString(),
    });
    this.token = { value: body.access_token, expiresAt: now.getTime() + (body.expires_in || 3600) * 1000 };
    this.tokenFor = key.client_email;
    return this.token.value;
  }

  /** All event occurrences in [timeMin, timeMax) for one calendar, following page links. */
  async listEvents(calendarId, token, timeMin, timeMax) {
    const items = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: 'true', // one entry per occurrence of a recurring event
        maxResults: '2500',
        fields: 'items(iCalUID,colorId,start),nextPageToken',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = await this.request(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      items.push(...(body.items || []));
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return items;
  }

  /**
   * Refresh colors for the given calendars ({ name, url }).
   * Covers the month grid (from a week before the 1st) to 45 days ahead.
   */
  async refresh(calendars, now = new Date()) {
    let key;
    try {
      key = this.readKey();
    } catch (err) {
      this.error = err.message;
      return;
    }
    if (!key) {
      this.error = null;
      this.email = null;
      return;
    }
    this.email = key.client_email;

    let token;
    try {
      token = await this.accessToken(key, now);
      this.error = null;
    } catch (err) {
      this.error = `Google sign-in failed: ${err.message}`;
      console.warn(`[colors] ${this.error}`);
      return; // keep the colors we already have
    }

    const timeMin = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1), -7);
    const timeMax = startOfDay(now, 45);
    let changed = false;

    await Promise.all(calendars.map(async (cal) => {
      const calendarId = calendarIdFromUrl(cal.url);
      if (!calendarId) return; // not a Google Calendar address
      try {
        const items = await this.listEvents(calendarId, token, timeMin, timeMax);
        const instances = new Map();
        const series = new Map();
        for (const item of items) {
          if (!item.iCalUID || !item.start) continue;
          const color = EVENT_COLORS[item.colorId] || null; // null = uses the calendar's color
          const allDay = Boolean(item.start.date);
          const start = allDay ? new Date(`${item.start.date}T00:00:00`) : new Date(item.start.dateTime);
          instances.set(instanceKey(item.iCalUID, start, allDay), color);
          if (!series.has(item.iCalUID)) series.set(item.iCalUID, color);
        }
        const before = JSON.stringify([...(this.maps.get(calendarId)?.instances || [])]);
        this.maps.set(calendarId, { instances, series });
        if (before !== JSON.stringify([...instances])) changed = true;
        this.errors.delete(cal.name);
      } catch (err) {
        // 404/403 usually mean "calendar not shared with the robot account"; but a
        // 403 can also mean the Calendar API isn't enabled, so show Google's words then.
        const apiOff = /disabled|has not been used|not enabled/i.test(err.message);
        const msg = (err.status === 404 || err.status === 403) && !apiOff
          ? `not shared with ${key.client_email} yet`
          : err.message.slice(0, 200);
        this.errors.set(cal.name, msg);
        console.warn(`[colors] "${cal.name}": ${msg}`); // keep its previous colors
      }
    }));

    this.updatedAt = now;
    if (changed) this.version++;
  }

  /**
   * Color for one event occurrence, or null to use the calendar's color.
   * @param {string} calUrl  the calendar's iCal URL (to find its Google id)
   */
  colorFor(calUrl, uid, start, allDay) {
    if (!uid) return null;
    const map = this.maps.get(calendarIdFromUrl(calUrl));
    if (!map) return null;
    const key = instanceKey(uid, start, allDay);
    if (map.instances.has(key)) return map.instances.get(key);
    return map.series.get(uid) || null; // e.g. an occurrence just outside the window
  }

  /** For the settings page. Never includes the key itself. */
  status() {
    return {
      configured: this.isConfigured(),
      serviceAccount: this.email,
      ok: this.isConfigured() && !this.error && this.errors.size === 0 && this.updatedAt !== null,
      error: this.error,
      calendarErrors: Object.fromEntries(this.errors),
      updatedAt: this.updatedAt ? this.updatedAt.toISOString() : null,
    };
  }
}

module.exports = { GoogleColors, calendarIdFromUrl, signJwt, instanceKey, EVENT_COLORS };
