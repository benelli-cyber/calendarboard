/*
 * Illustrated sky scene behind the dashboard (Settings → Display → Background → Sky scene).
 *
 *   The whole screen is the sky, with the horizon at the hills along the
 *   bottom. The sun and moon sit at their real positions (moon with its real
 *   phase) BEHIND THE CALENDAR, showing through its see-through cells, so
 *   they never cover the clock or weather text. Stars at night.
 *   Top band (behind the clock + weather): clouds, rain or snow by the weather.
 *   Bottom band (behind forecast + to-do): layered hills with pine trees,
 *   colored by time of day, white when it snows.
 *
 * Pi 3B friendly: one static SVG. The shapes are built once (and again only
 * if the layout changes); after that, every few minutes, only a handful of
 * attributes change (sun/moon position, colors, what's shown). No animation.
 *
 * Data: /api/scene (sun/moon from the server, which knows the location) and
 * the weather icon passed in by dashboard.js (Scene.setWeather).
 */
'use strict';

window.Scene = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 5 * 60 * 1000;

  const state = { data: null, icon: null, enabled: true, layoutKey: '', els: null };

  // ---------------------------------------------------------------------------
  // Colors
  // ---------------------------------------------------------------------------

  // Hills back → front, per time of day; snowy versions when it snows.
  const HILLS = {
    night: ['#14224a', '#0e1938', '#09112a'],
    dawn: ['#5a3a5c', '#432a46', '#2c1c30'],
    dusk: ['#5c3446', '#432536', '#2b1824'],
    day: ['#3b6e58', '#2c5a45', '#1f4433'],
  };
  const SNOWY_HILLS = {
    night: ['#4a5670', '#3c475e', '#2f394c'],
    dawn: ['#9d92ab', '#b0a6bc', '#c4bccf'],
    dusk: ['#998aa0', '#ac9eb3', '#bfb3c6'],
    day: ['#a9b6c6', '#c1ccd8', '#d9e1ea'],
  };
  const PINES = { night: '#060c1c', dawn: '#1d1424', dusk: '#1c1019', day: '#14301f' };
  // Muted on purpose: clouds sit behind white header text.
  const CLOUD = {
    night: { fill: '#4a5468', opacity: 0.5 },
    dawn: { fill: '#a8838c', opacity: 0.5 },
    dusk: { fill: '#a8766f', opacity: 0.5 },
    day: { fill: '#aeb9c6', opacity: 0.5 },
    storm: { fill: '#30363f', opacity: 0.8 },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function svg(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.append(node);
    return node;
  }

  /** Repeatable pseudo-random numbers, so stars and clouds don't jump around. */
  function random(seed) {
    let s = seed % 2147483647;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  /** Simplified weather from the icon name. */
  function weatherKind(icon) {
    if (!icon) return 'clear';
    if (icon.startsWith('clear')) return 'clear';
    if (icon.startsWith('partly')) return 'partly';
    if (icon === 'rain' || icon === 'sleet' || icon === 'snow' || icon === 'thunder') return icon;
    return 'cloudy'; // cloudy, fog, wind
  }

  /** Where the bands are: the calendar's top, and the bottom row's top. */
  function bands() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cal = document.querySelector('.calendar');
    const bottom = document.querySelector('.bottom-row');
    const top = cal ? Math.round(cal.getBoundingClientRect().top) : Math.round(H * 0.12);
    const low = bottom ? Math.round(bottom.getBoundingClientRect().top) : Math.round(H * 0.85);
    return { W, H, top, low };
  }

  // ---------------------------------------------------------------------------
  // Building the shapes (once per layout)
  // ---------------------------------------------------------------------------

  /** A rolling ridge line from x=0 to x=W around baseline y, closed to the bottom. */
  function hillPath(W, H, y, amp, seed) {
    const r = random(seed);
    const f1 = 1.5 + r() * 1.5;
    const f2 = 3 + r() * 3;
    const p1 = r() * Math.PI * 2;
    const p2 = r() * Math.PI * 2;
    let d = `M0 ${H}`;
    const points = [];
    for (let x = 0; x <= W; x += 20) {
      const t = x / W;
      const yy = y - amp * (0.6 * Math.sin(t * Math.PI * f1 + p1) + 0.4 * Math.sin(t * Math.PI * f2 + p2));
      points.push([x, yy]);
      d += ` L${x} ${yy.toFixed(1)}`;
    }
    d += ` L${W} ${H} Z`;
    return { d, points };
  }

  function cloudShape(parent, cx, cy, scale) {
    const g = svg('g', { transform: `translate(${cx} ${cy}) scale(${scale})` }, parent);
    svg('ellipse', { cx: 0, cy: 10, rx: 70, ry: 22 }, g);
    svg('circle', { cx: -30, cy: 0, r: 26 }, g);
    svg('circle', { cx: 8, cy: -14, r: 34 }, g);
    svg('circle', { cx: 42, cy: 2, r: 24 }, g);
    return g;
  }

  function build() {
    const { W, H, top, low } = bands();
    const key = `${W}x${H}:${top}:${low}`;
    if (key === state.layoutKey && state.els) return;
    state.layoutKey = key;

    document.getElementById('scene')?.remove();
    const root = svg('svg', { id: 'scene', width: W, height: H, 'aria-hidden': 'true' });
    document.body.prepend(root);

    const defs = svg('defs', {}, root);
    const sunGlow = svg('radialGradient', { id: 'sun-glow' }, defs);
    svg('stop', { offset: '0%', 'stop-color': '#ffe2a8', 'stop-opacity': '0.75' }, sunGlow);
    svg('stop', { offset: '100%', 'stop-color': '#ffcf7a', 'stop-opacity': '0' }, sunGlow);
    const moonGlow = svg('radialGradient', { id: 'moon-glow' }, defs);
    svg('stop', { offset: '0%', 'stop-color': '#dfe7ff', 'stop-opacity': '0.35' }, moonGlow);
    svg('stop', { offset: '100%', 'stop-color': '#dfe7ff', 'stop-opacity': '0' }, moonGlow);

    // Stars: across the whole sky (faint behind the calendar cells).
    const stars = svg('g', { fill: '#ffffff' }, root);
    const rs = random(7);
    for (let i = 0; i < 160; i++) {
      const y = rs() * (low - 40);
      svg('circle', { cx: (rs() * W).toFixed(1), cy: y.toFixed(1), r: (0.8 + rs() * 1.7).toFixed(2), opacity: (0.45 + rs() * 0.55).toFixed(2) }, stars);
    }

    // Moon (glow, faint dark disc, lit part) and sun (glow + disc).
    const moon = svg('g', {}, root);
    svg('circle', { r: 170, fill: 'url(#moon-glow)' }, moon);
    svg('circle', { r: 52, fill: '#9aa6bf', opacity: '0.2' }, moon);
    const moonLit = svg('path', { fill: '#f2f5fc' }, moon);
    const sun = svg('g', {}, root);
    svg('circle', { r: 260, fill: 'url(#sun-glow)' }, sun);
    const sunDisc = svg('circle', { r: 60, fill: '#ffd97a' }, sun);

    // Clouds across the top band (how many are shown depends on the weather).
    const clouds = svg('g', {}, root);
    const rc = random(11);
    const cloudList = [];
    for (let i = 0; i < 6; i++) {
      const cx = ((i + 0.5) / 6) * W + (rc() - 0.5) * 120;
      const cy = 30 + rc() * Math.max(20, top - 90);
      cloudList.push(cloudShape(clouds, cx, cy, 0.8 + rc() * 0.7));
    }

    // Rain streaks and snowflakes (top band + above the hills).
    const rain = svg('g', { stroke: '#a9c7e8', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: '0.5' }, root);
    const snow = svg('g', { fill: '#ffffff', opacity: '0.8' }, root);
    const rp = random(23);
    for (let i = 0; i < 80; i++) {
      const x = rp() * W;
      const y = i < 60 ? rp() * top : low - 80 + rp() * 70;
      svg('line', { x1: x.toFixed(1), y1: y.toFixed(1), x2: (x - 8).toFixed(1), y2: (y + 22).toFixed(1) }, rain);
      svg('circle', { cx: (rp() * W).toFixed(1), cy: (i < 60 ? rp() * top : low - 80 + rp() * 70).toFixed(1), r: (1.5 + rp() * 2).toFixed(2) }, snow);
    }

    // Hills (back → front) and pine trees on the front ridge.
    const hills = [];
    const ridges = [
      hillPath(W, H, low - 30, 28, 3),
      hillPath(W, H, low + 50, 34, 5),
      hillPath(W, H, low + 140, 30, 9),
    ];
    for (const r of ridges) hills.push(svg('path', { d: r.d }, root));
    const pines = svg('g', {}, root);
    const rt = random(31);
    const mid = ridges[1].points;
    for (let i = 0; i < 26; i++) {
      const [x, y] = mid[Math.floor(rt() * mid.length)];
      const h = 40 + rt() * 50;
      const w = h * 0.45;
      // Three stacked triangles make a simple pine.
      let d = '';
      for (let k = 0; k < 3; k++) {
        const ty = y - h + k * h * 0.28;
        const tw = w * (0.55 + k * 0.25);
        d += `M${x.toFixed(1)} ${ty.toFixed(1)} L${(x - tw / 2).toFixed(1)} ${(ty + h * 0.45).toFixed(1)} L${(x + tw / 2).toFixed(1)} ${(ty + h * 0.45).toFixed(1)} Z `;
      }
      d += `M${(x - 3).toFixed(1)} ${(y - h * 0.25).toFixed(1)} h6 v${(h * 0.3).toFixed(1)} h-6 Z`;
      svg('path', { d }, pines);
    }

    state.els = { root, stars, moon, moonLit, sun, sunDisc, clouds, cloudList, rain, snow, hills, pines, W, top, low };
  }

  // ---------------------------------------------------------------------------
  // Drawing (cheap: positions, colors, visibility)
  // ---------------------------------------------------------------------------

  /**
   * Compass bearing → x (east on the left, west on the right).
   * Altitude → y behind the calendar: 0° sits on the hills, 70° near the
   * calendar's top (never up in the header, behind the clock or weather).
   */
  function skyPoint(az, alt) {
    const { W, top, low } = state.els;
    const x = Math.min(Math.max((az - 70) / 220, 0.06), 0.94) * W; // 70° (ENE) … 290° (WNW)
    const horizon = low - 40;
    const highest = top + 90;
    const y = horizon - (Math.min(Math.max(alt, -8), 70) / 70) * (horizon - highest);
    return [x, y];
  }

  /** Lit part of the moon for phase p (0 new, 0.5 full), radius r, as an SVG path. */
  function moonPath(p, r) {
    const waxing = p < 0.5;
    const k = Math.cos(p * 2 * Math.PI); // 1 new, 0 quarter, -1 full
    const rx = Math.abs(k) * r;
    const outerSweep = waxing ? 1 : 0;
    // Crescent: terminator bulges toward the lit side; gibbous: away from it.
    const crescent = k > 0;
    const innerSweep = waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0);
    return `M0 ${-r} A${r} ${r} 0 0 ${outerSweep} 0 ${r} A${rx.toFixed(2)} ${r} 0 0 ${innerSweep} 0 ${-r} Z`;
  }

  const show = (node, on) => node.setAttribute('display', on ? 'inline' : 'none');

  function draw() {
    if (!state.enabled || !state.data || !state.data.configured) {
      if (state.els) show(state.els.root, false);
      return;
    }
    build();
    const e = state.els;
    show(e.root, true);
    const { phase, sun, moon } = state.data;
    const kind = weatherKind(state.icon);
    const overcast = ['cloudy', 'rain', 'sleet', 'snow', 'thunder'].includes(kind);

    // Stars: full at night, faint at dawn/dusk, hidden by day or under clouds.
    e.stars.setAttribute('opacity', phase === 'night' ? (overcast ? 0.15 : 1) : phase === 'day' ? 0 : 0.35);

    // Sun: shown when up (or just below the horizon at dawn/dusk, as a glow).
    const sunUp = sun.alt > -4 && !(overcast && kind !== 'cloudy');
    show(e.sun, sunUp);
    if (sunUp) {
      const [x, y] = skyPoint(sun.az, sun.alt);
      e.sun.setAttribute('transform', `translate(${x.toFixed(0)} ${y.toFixed(0)})`);
      e.sun.setAttribute('opacity', overcast ? 0.35 : 1);
      e.sunDisc.setAttribute('fill', sun.alt < 8 ? '#ffb36b' : '#ffd97a'); // redder near the horizon
    }

    // Moon: shown when up and at least a sliver is lit.
    const moonUp = moon.alt > -1 && moon.fraction > 0.03;
    show(e.moon, moonUp);
    if (moonUp) {
      const [x, y] = skyPoint(moon.az, moon.alt);
      e.moon.setAttribute('transform', `translate(${x.toFixed(0)} ${y.toFixed(0)})`);
      e.moon.setAttribute('opacity', phase === 'day' ? 0.45 : overcast ? 0.4 : 1);
      e.moonLit.setAttribute('d', moonPath(moon.phase, 52));
    }

    // Clouds: none when clear, two when partly cloudy, all when overcast.
    const count = kind === 'clear' ? 0 : kind === 'partly' ? 2 : 6;
    const look = kind === 'thunder' ? CLOUD.storm : CLOUD[phase];
    e.cloudList.forEach((c, i) => {
      show(c, i < count);
      c.setAttribute('fill', look.fill);
      c.setAttribute('opacity', look.opacity);
    });

    show(e.rain, kind === 'rain' || kind === 'thunder' || kind === 'sleet');
    show(e.snow, kind === 'snow' || kind === 'sleet');

    const palette = (kind === 'snow' ? SNOWY_HILLS : HILLS)[phase];
    e.hills.forEach((h, i) => h.setAttribute('fill', palette[i]));
    e.pines.setAttribute('fill', PINES[phase]);
  }

  async function load() {
    try {
      const res = await fetch('/api/scene', { cache: 'no-store' });
      if (res.ok) {
        state.data = await res.json();
        draw();
      }
    } catch {
      /* keep the current picture */
    }
  }

  // Layout can change (alert banner, font size): rebuild when it does.
  window.addEventListener('resize', () => { state.layoutKey = ''; draw(); });

  load();
  setInterval(load, POLL_MS);

  return {
    /** Current weather icon name (from /api/weather). */
    setWeather(icon) {
      if (icon === state.icon) return;
      state.icon = icon;
      draw();
    },
    /** Background setting: 'sky' shows the scene, 'plain' hides it. */
    setEnabled(on) {
      if (on === state.enabled) return;
      state.enabled = on;
      draw();
    },
    /** Call after something moved the calendar or bottom row (e.g. alert banner). */
    relayout() {
      if (!state.els) return;
      const { W, H, top, low } = bands();
      if (`${W}x${H}:${top}:${low}` !== state.layoutKey) draw();
    },
  };
})();
