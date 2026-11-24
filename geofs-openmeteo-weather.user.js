// ==UserScript==
// @name         GeoFS Open-Meteo Weather Override
// @namespace    https://open-meteo.com/
// @version      2.4.1
// @description  Replaces GeoFS's built-in weather (wind incl. real winds aloft / jet stream, gusts, turbulence, visibility, pressure, temperature, precipitation, thunderstorms) with live Open-Meteo data. Clouds and time of day are left to GeoFS.
// @match        https://*.geo-fs.com/*
// @match        https://geo-fs.com/*
// @match        https://*.geofs.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // ignore iframes
  console.log('[Open-Meteo] userscript v2.4.1 loaded on', location.href);

  /* ------------------------------ config ------------------------------ */
  const CFG = {
    refreshMs: 30 * 60 * 1000, // refetch Open-Meteo at most this often (Open-Meteo itself only updates ~hourly aloft)
    moveThresholdKm: 500,      // ...or when you've flown this far from the last fetch point (500 km = ~270 NM)
    deadbandKt: 3,             // a refetch only changes the sim's wind if some layer moved by more than this...
    deadbandDeg: 10,           // ...or turned by more than this (stops tiny model changes from jolting the wind)
    tickMs: 1000,              // how often values are re-asserted
    model: '',                 // '' = Open-Meteo best match. Others: 'icon_seamless', 'gfs_seamless', 'ecmwf_ifs025'
    surfaceWind: 'metar',      // 'metar' = keep GeoFS's own (airport METAR) surface wind, blend Open-Meteo in above it
                               // 'openmeteo' = use Open-Meteo's model surface wind too
    windDirOffset: 0,          // degrees added to every wind direction (use 180 if GeoFS turns out to be inverted)
    layerStepM: 500,           // thickness of the interpolated wind layers aloft
    levelsHPa: [1000, 950, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150],
    inject: {                  // what to override. Clouds and time are NEVER touched.
      wind: true,              // surface direction, speed, gusts
      windsAloft: true,        // real winds at altitude (jet stream) as GeoFS wind layers
      turbulence: true,        // derived from gust spread
      visibility: true,
      pressure: true,          // sea-level pressure
      temperature: true,       // sea-level temperature (from 2 m temp + elevation)
      precipitation: true,     // rain / snow amount
      thunderstorm: true,
    },
    logEveryMs: 20000,         // flight recorder: sample position / wind this often (see the Log button)
    logMax: 600,               // keep the last N samples (600 x 20 s = ~3.3 h)
    debug: true,               // log GeoFS weather internals to the console once
    storeKey: 'geofs_openmeteo_cfg',
  };

  // Never write keys matching this, whatever happens (clouds + time/season).
  const PROTECTED = /cloud|cover|timestamp|time|season|date/i;

  const API = 'https://api.open-meteo.com/v1/forecast';
  const CURRENT_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation',
    'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m',
    'wind_direction_10m', 'wind_gusts_10m', 'visibility',
  ].join(',');

  const WMO = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers',
    81: 'Rain showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail',
  };
  const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

  const KT_TO_MS = 0.514444;
  const MS_TO_KT = 1.943844;

  /* ------------------------------ state ------------------------------- */
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG.storeKey)) || {}; } catch (e) { saved = {}; }

  const state = {
    apply: saved.apply !== false,
    collapsed: !!saved.collapsed,
    data: null,        // raw Open-Meteo "current" (+ elevation + pressure levels)
    target: null,      // surface values we push into GeoFS's definition
    profile: null,     // wind layers (floor/ceiling/fromDeg/kt) built from the pressure levels
    stamp: 0,          // identifies the profile version we installed
    lastPos: null,
    lastFetch: 0,
    fetching: false,
    error: null,
    debugged: false,
    native: null,      // GeoFS's own surface wind {fromDeg, kt}, captured from the layer GeoFS builds
    log: [],           // flight recorder samples
    lastSample: 0,
    surfUsed: null,    // the surface wind the installed layers were built from
    lastSig: '',
  };
  const persist = () => {
    try { localStorage.setItem(CFG.storeKey, JSON.stringify({ apply: state.apply, collapsed: state.collapsed })); }
    catch (e) { /* storage may be unavailable */ }
  };

  /* ------------------------------ helpers ----------------------------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const norm360 = (d) => ((Math.round(d) % 360) + 360) % 360;

  // GeoFS globals may not hang off window, so look them up as bare globals too.
  function G() {
    try { return typeof geofs !== 'undefined' ? geofs : window.geofs; } catch (e) { return undefined; }
  }
  function W() {
    try { return typeof weather !== 'undefined' ? weather : window.weather; } catch (e) { return undefined; }
  }

  function distKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function getPosition() {
    try {
      const lla = G().aircraft.instance.llaLocation; // [lat, lon, alt(m)]
      if (Array.isArray(lla) && isFinite(lla[0]) && isFinite(lla[1])) return { lat: lla[0], lon: lla[1] };
    } catch (e) { /* not ready */ }
    return null;
  }
  function getAltitudeM() {
    try { const a = G().aircraft.instance.llaLocation[2]; return isFinite(a) ? a : null; } catch (e) { return null; }
  }

  // GeoFS exposes weather.definitionBounds; use it when it has a usable shape.
  function getBounds(w, key) {
    try {
      const b = w.definitionBounds && w.definitionBounds[key];
      let lo, hi;
      if (Array.isArray(b)) { lo = b[0]; hi = b[1]; }
      else if (b && typeof b === 'object') { lo = b.min; hi = b.max; }
      if (isFinite(lo) && isFinite(hi)) return { lo, hi };
    } catch (e) { /* ignore */ }
    return null;
  }
  function bounded(w, key, val) {
    if (typeof val !== 'number' || !w) return val;
    const b = getBounds(w, key);
    return b ? clamp(val, b.lo, b.hi) : val;
  }
  // map a 0..1 fraction onto GeoFS's own range for that key (falls back to 0..1)
  function scaleToBounds(w, key, frac) {
    const b = w && getBounds(w, key);
    return b ? b.lo + clamp(frac, 0, 1) * (b.hi - b.lo) : clamp(frac, 0, 1);
  }

  /* ------------------------------ fetching ---------------------------- */
  function levelVars() {
    const out = [];
    CFG.levelsHPa.forEach((p) => {
      out.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`);
    });
    return out.join(',');
  }

  async function fetchWeather(pos) {
    let url = `${API}?latitude=${pos.lat.toFixed(4)}&longitude=${pos.lon.toFixed(4)}` +
      `&current=${CURRENT_VARS}&wind_speed_unit=kn&timezone=auto`;
    if (CFG.inject.windsAloft) url += `&hourly=${levelVars()}&forecast_days=1`;
    if (CFG.model) url += `&models=${encodeURIComponent(CFG.model)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = await res.json();
    if (!json.current) throw new Error('No "current" block in response');

    const out = Object.assign({}, json.current, { elevation: json.elevation, levels: [] });

    // pick the hourly row at/just before the current time
    const hr = json.hourly;
    if (hr && Array.isArray(hr.time)) {
      let idx = 0;
      for (let i = 0; i < hr.time.length; i++) { if (hr.time[i] <= json.current.time) idx = i; }
      CFG.levelsHPa.forEach((p) => {
        const kt = hr[`wind_speed_${p}hPa`] && hr[`wind_speed_${p}hPa`][idx];
        const dir = hr[`wind_direction_${p}hPa`] && hr[`wind_direction_${p}hPa`][idx];
        const h = hr[`geopotential_height_${p}hPa`] && hr[`geopotential_height_${p}hPa`][idx];
        if ([kt, dir, h].every((v) => v != null && isFinite(v))) out.levels.push({ hPa: p, kt, dir, h });
      });
    }
    return out;
  }

  async function refresh(force) {
    const pos = getPosition();
    if (!pos || state.fetching) return;

    const moved = state.lastPos ? distKm(state.lastPos, pos) : Infinity;
    const stale = Date.now() - state.lastFetch > CFG.refreshMs;
    if (!force && !stale && moved < CFG.moveThresholdKm) return;

    state.fetching = true;
    try {
      state.data = await fetchWeather(pos);
      state.lastPos = pos;
      state.lastFetch = Date.now();
      state.error = null;
      // Only touch the sim when the weather changed meaningfully (or you pressed Refresh).
      const nat0 = nativeFromLayers(W());
      if (nat0) state.native = nat0;
      const newTarget = computeTarget(state.data);
      const newProfile = buildProfile(state.data);
      if (force || !state.profile || !profilesSimilar(state.profile, newProfile)) {
        state.target = newTarget;
        state.profile = newProfile;
        state.stamp = state.lastFetch;
        applyNow();
        if (state.apply) installLayers();
        console.log('[Open-Meteo] weather updated in sim');
      } else {
        console.log('[Open-Meteo] refetched; change within deadband, sim wind left untouched');
      }
    } catch (e) {
      state.error = e.message || String(e);
      console.warn('[Open-Meteo]', e);
    } finally {
      state.fetching = false;
      render();
    }
  }

  /* --------------------- surface values for GeoFS ---------------------- */
  // GeoFS definition units: windDirection deg (from), windSpeedMS / windGustMS m/s,
  // visibility m, airPressureSL Pa, airTemperatureSL degC.
  function computeTarget(c) {
    const w = W();
    const I = CFG.inject;
    const t = {};
    const kn = c.wind_speed_10m || 0;
    const gk = Math.max(c.wind_gusts_10m || 0, kn);

    if (I.wind && CFG.surfaceWind === 'openmeteo') {
      t.windDirection = norm360(c.wind_direction_10m + CFG.windDirOffset);
      t.windSpeedMS = +(kn * KT_TO_MS).toFixed(2);
      t.windGustMS = +(gk * KT_TO_MS).toFixed(2);
    }
    if (I.turbulence) t.turbulences = +scaleToBounds(w, 'turbulences', (gk - kn) / 25).toFixed(2);
    if (I.visibility && c.visibility != null) t.visibility = c.visibility;
    if (I.pressure && c.pressure_msl != null) t.airPressureSL = Math.round(c.pressure_msl * 100);
    if (I.temperature && c.temperature_2m != null) {
      // 2 m temperature at ground elevation -> sea-level equivalent (standard lapse rate)
      t.airTemperatureSL = +(c.temperature_2m + 0.0065 * (c.elevation || 0)).toFixed(1);
    }
    if (I.precipitation) {
      t.precipitationType = SNOW_CODES.has(c.weather_code) ? 'snow' : 'rain';
      t.precipitationAmount = +scaleToBounds(w, 'precipitationAmount', (c.precipitation || 0) / 8).toFixed(2);
    }
    if (I.thunderstorm) t.thunderstorm = scaleToBounds(w, 'thunderstorm', c.weather_code >= 95 ? 1 : 0);

    for (const k of Object.keys(t)) t[k] = bounded(w, k, t[k]);
    return t;
  }

  // Write our values into a definition object. Only touches keys that already exist on it.
  function overlay(def) {
    if (!state.apply || !state.target || !def || typeof def !== 'object') return;
    if (!('windSpeedMS' in def) && !('windDirection' in def)) return; // not a weather definition
    for (const k of Object.keys(state.target)) {
      if (PROTECTED.test(k) || !(k in def)) continue;
      const v = state.target[k];
      if (def[k] !== v) { try { def[k] = v; } catch (e) { /* read-only */ } }
    }
  }

  function applyNow() {
    const w = W();
    if (w && w.definition) overlay(w.definition);
  }

  /* -------------------- winds aloft -> GeoFS wind layers -------------------- */
  // Wind as (u, v) motion components in knots; blending components avoids
  // direction wrap-around problems when interpolating between altitudes.
  function windUV(fromDeg, kt) {
    const r = fromDeg * Math.PI / 180;
    return { u: -kt * Math.sin(r), v: -kt * Math.cos(r) };
  }
  function uvToFrom(u, v) {
    return { kt: Math.hypot(u, v), fromDeg: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
  }

  // GeoFS's own (METAR) surface wind. weather.definition does NOT reliably hold it, so we read it
  // from the single wind layer GeoFS builds in initWind, before we replace that layer with ours.
  function nativeFromLayers(w) {
    if (!w || !Array.isArray(w.windLayers) || w.windLayers.__om !== undefined) return null; // missing, or already ours
    const L = w.windLayers[0];
    if (!L || !isFinite(L.speedMs) || !isFinite(L.mainDirection)) return null;
    return { fromDeg: norm360(L.mainDirection + 180), kt: L.speedMs * MS_TO_KT }; // mainDirection = direction wind blows TOWARD
  }
  function nativeSurface() { return state.native; }
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  // Returns [{floor, ceiling, fromDeg, kt}] sorted by floor (metres), or null.
  function buildProfile(c) {
    if (!CFG.inject.wind) return null;
    const elev = c.elevation || 0;
    let surfKt = c.wind_speed_10m || 0;
    let surfFrom = norm360(c.wind_direction_10m + CFG.windDirOffset);
    if (CFG.surfaceWind === 'metar') {
      const nat = nativeSurface();            // GeoFS's own (METAR) surface wind
      if (nat) { surfKt = nat.kt; surfFrom = nat.fromDeg; }
    }
    state.surfUsed = { fromDeg: surfFrom, kt: surfKt };
    const surf = Object.assign({ z: elev + 10 }, windUV(surfFrom, surfKt));

    const pts = [surf];
    if (CFG.inject.windsAloft && Array.isArray(c.levels)) {
      c.levels
        .filter((l) => l.h > elev + 150)                 // skip levels at/below the ground
        .sort((a, b) => a.h - b.h)
        .forEach((l) => {
          if (l.h > pts[pts.length - 1].z + 50) {
            pts.push(Object.assign({ z: l.h }, windUV(l.dir + CFG.windDirOffset, l.kt)));
          }
        });
    }

    const at = (z) => {
      if (z <= pts[0].z) return uvToFrom(pts[0].u, pts[0].v);
      for (let i = 1; i < pts.length; i++) {
        if (z <= pts[i].z) {
          const f = (z - pts[i - 1].z) / (pts[i].z - pts[i - 1].z);
          return uvToFrom(
            pts[i - 1].u + (pts[i].u - pts[i - 1].u) * f,
            pts[i - 1].v + (pts[i].v - pts[i - 1].v) * f,
          );
        }
      }
      const p = pts[pts.length - 1];
      return uvToFrom(p.u, p.v);
    };

    const TOP = 30000;
    const surfTop = elev + 150;
    // layer 0 = exact surface wind, from the ground (alt 0) up to ~150 m above the field
    const out = [{ floor: 0, ceiling: pts.length > 1 ? surfTop : TOP, fromDeg: surfFrom, kt: surfKt }];
    if (pts.length > 1) {
      const top = pts[pts.length - 1].z;
      const step = Math.max(100, CFG.layerStepM);
      for (let z = surfTop; z < top; z += step) {
        const mid = Math.min(z + step / 2, top);
        out.push(Object.assign({ floor: z, ceiling: Math.min(z + step, top) }, at(mid)));
      }
      out.push(Object.assign({ floor: top, ceiling: TOP }, at(top))); // hold the top wind above the highest level
    }
    return out;
  }

  // true if every layer is within the deadband of the layer we already installed
  function profilesSimilar(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].floor - b[i].floor) > 100) return false;
      if (Math.abs(a[i].kt - b[i].kt) > CFG.deadbandKt) return false;
      const dd = Math.abs(((a[i].fromDeg - b[i].fromDeg + 540) % 360) - 180);
      if (dd > CFG.deadbandDeg && Math.max(a[i].kt, b[i].kt) > 5) return false;
    }
    return true;
  }

  // Replace GeoFS's (single-layer) wind with our altitude-dependent layers.
  // GeoFS's update() picks the layer by aircraft altitude vs each layer's floor.
  function installLayers() {
    const w = W();
    if (!state.apply || !state.profile || !w || typeof w.Wind !== 'function') return false;
    try {
      // Wind(direction it blows TOWARD, speed m/s, floor, ceiling)
      const layers = state.profile.map((L) =>
        new w.Wind((L.fromDeg + 180) % 360, L.kt * KT_TO_MS, L.floor, L.ceiling));
      if (!layers.length) return false;
      layers.__om = state.stamp;
      w.windLayers = layers;
      try { layers[0].computeAndSet(); } catch (e) { /* needs camera; update() does it per frame */ }
      if (w.windActive === false && layers[0].speedMs > 0) w.windActive = true;
      return true;
    } catch (e) {
      console.warn('[Open-Meteo] installing wind layers failed', e);
      return false;
    }
  }

  function ensureLayers() {
    const w = W();
    if (!state.apply || !state.profile || !w) return;
    if (typeof w.Wind !== 'function') return;
    // GeoFS refreshed its METAR wind -> rebuild our profile around the new surface wind
    if (CFG.surfaceWind === 'metar' && state.data && state.surfUsed) {
      const nat = nativeSurface(), u = state.surfUsed;
      if (nat && (Math.abs(nat.kt - u.kt) > 1 ||
          (Math.max(nat.kt, u.kt) > 3 && angDiff(nat.fromDeg, u.fromDeg) > 10))) {
        state.profile = buildProfile(state.data);
        state.stamp = Date.now();
      }
    }
    if (!w.windLayers || w.windLayers.__om !== state.stamp) installLayers();
  }

  /* ------------- hook GeoFS's own weather pipeline (real-time + manual) ------------- */
  // Wrapping means every definition / wind GeoFS builds from METAR (or the manual panel)
  // gets our values swapped in BEFORE the sim uses it, so GeoFS can't overwrite us.
  function hookWeather() {
    const w = W();
    if (!w) return false;

    ['generateDefinition', 'sanitizedDefinition'].forEach((name) => {
      const orig = w[name];
      if (typeof orig !== 'function' || orig.__om) return;
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        try {
          if (r && typeof r === 'object') overlay(r);
          else overlay(w.definition);
        } catch (e) { console.warn('[Open-Meteo] hook error', name, e); }
        return r;
      };
      wrapped.__om = true;
      w[name] = wrapped;
      console.log('[Open-Meteo] hooked weather.' + name);
    });

    const origSet = w.set;
    if (typeof origSet === 'function' && !origSet.__om) {
      const wrappedSet = function () {
        const args = Array.prototype.slice.call(arguments);
        try {
          if (args[0] && typeof args[0] === 'object') {
            args[0] = Object.assign({}, args[0]); // don't mutate GeoFS's stored manual definition
            overlay(args[0]);
          }
        } catch (e) { console.warn('[Open-Meteo] hook error set', e); }
        const r = origSet.apply(this, args);
        try { overlay(w.definition); } catch (e) { /* ignore */ }
        return r;
      };
      wrappedSet.__om = true;
      w.set = wrappedSet;
      console.log('[Open-Meteo] hooked weather.set');
    }

    // initWind rebuilds weather.windLayers (always as one layer); re-install ours right after.
    const origInit = w.initWind;
    if (typeof origInit === 'function' && !origInit.__om) {
      const wrappedInit = function () {
        const r = origInit.apply(this, arguments);
        try {
          const nat = nativeFromLayers(w);          // GeoFS just built its own layer: remember its wind
          if (nat) state.native = nat;
          if (state.apply && state.profile) installLayers();
        } catch (e) { /* ignore */ }
        return r;
      };
      wrappedInit.__om = true;
      w.initWind = wrappedInit;
      console.log('[Open-Meteo] hooked weather.initWind');
    }

    if (CFG.debug && !state.debugged && w.definition) {
      state.debugged = true;
      try { console.log('[Open-Meteo] weather.definition:', JSON.parse(JSON.stringify(w.definition))); } catch (e) { /* ignore */ }
      console.log('[Open-Meteo] weather.definitionBounds:', w.definitionBounds);
    }
    return true;
  }

  // ---- flight recorder: lets us see exactly what the wind did when something felt wrong ----
  const LOG_HEAD = 'utc,lat,lon,altFt,hdg,gsKt,kias,windFrom,windKt,headwindKt,layer,fetchAgeMin,kmFromFetch';
  function sample() {
    const w = W(), g = G();
    if (!w || !g || !Array.isArray(w.windLayers) || !w.windLayers.length) return;
    const pos = getPosition(), alt = getAltitudeM();
    if (!pos || alt == null) return;
    const L = w.windLayers[w.activeWindLayer] || w.windLayers[0];
    if (!L || !isFinite(L.speedMs)) return;
    let v = {};
    try { v = g.animation.values || {}; } catch (e) { /* ignore */ }
    const from = (L.mainDirection + 180 + 360) % 360;
    const kt = L.speedMs * MS_TO_KT;
    const hdg = v.heading360;
    const hw = isFinite(hdg) ? kt * Math.cos((from - hdg) * Math.PI / 180) : NaN;
    const r = (x, n) => (isFinite(x) ? +x.toFixed(n || 0) : '');
    state.log.push([
      new Date().toISOString().slice(11, 19), r(pos.lat, 3), r(pos.lon, 3), r(alt / 0.3048), r(hdg),
      r(v.groundSpeedKnt), r(v.kias), r(from), r(kt), r(hw), w.activeWindLayer,
      r((Date.now() - state.lastFetch) / 60000, 1), state.lastPos ? r(distKm(state.lastPos, pos)) : '',
    ].join(','));
    if (state.log.length > CFG.logMax) state.log.shift();
    window.omLog = state.log;
  }
  function copyLog() {
    const text = [LOG_HEAD].concat(state.log).join('\n');
    console.log('[Open-Meteo] flight log (' + state.log.length + ' samples)\n' + text);
    try { navigator.clipboard.writeText(text); } catch (e) { /* fall back to the console copy above */ }
  }

  function dump() {
    const w = W() || {};
    const out = {
      target: state.target,
      openMeteo: state.data,
      profile: state.profile,
      native: state.native,
      surfUsed: state.surfUsed,
      def: w.definition && JSON.parse(JSON.stringify(w.definition)),
      layersInstalled: !!(w.windLayers && w.windLayers.__om === state.stamp),
      layerCount: w.windLayers && w.windLayers.length,
      activeLayer: w.activeWindLayer,
      altitudeM: getAltitudeM(),
      hooks: ['generateDefinition', 'sanitizedDefinition', 'set', 'initWind'].map((n) => n + ':' + !!(w[n] && w[n].__om)),
    };
    console.log('[Open-Meteo] dump', JSON.stringify(out, null, 1));
    return out;
  }

  /* ------------------------------ overlay UI -------------------------- */
  let box, body, toggleBtn;

  function buildUI() {
    box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', left: '10px', bottom: '60px', zIndex: 2147483647,
      minWidth: '240px', maxWidth: '290px', font: '12px/1.4 system-ui, sans-serif',
      color: '#e8f1ff', background: 'rgba(12,20,34,0.82)', borderRadius: '8px',
      border: '1px solid rgba(120,170,255,0.35)', boxShadow: '0 2px 10px rgba(0,0,0,.4)',
      userSelect: 'none',
    });

    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 8px', cursor: 'pointer', fontWeight: '600',
    });
    const title = document.createElement('span');
    title.textContent = '\u2601 Open-Meteo Override';
    toggleBtn = document.createElement('span');
    head.append(title, toggleBtn);
    head.addEventListener('click', () => { state.collapsed = !state.collapsed; state.lastSig = ''; persist(); render(); });

    body = document.createElement('div');
    body.style.padding = '0 8px 8px';

    box.append(head, body);
    document.body.appendChild(box);
  }

  function row(label, value) {
    const r = document.createElement('div');
    Object.assign(r.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' });
    const a = document.createElement('span'); a.textContent = label; a.style.opacity = '0.7';
    const b = document.createElement('span'); b.textContent = value;
    r.append(a, b);
    return r;
  }

  function button(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      flex: '1', padding: '3px 6px', font: 'inherit', color: 'inherit', cursor: 'pointer',
      background: 'rgba(120,170,255,0.18)', border: '1px solid rgba(120,170,255,0.4)',
      borderRadius: '5px',
    });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  const pad3 = (d) => String(Math.round(d || 0) % 360).padStart(3, '0');
  const flOf = (m) => `FL${String(Math.max(0, Math.round(m / 0.3048 / 1000) * 10)).padStart(3, '0')}`;

  // what the sim is actually applying at your current altitude (from the active wind layer)
  function simWindText() {
    const w = W();
    if (!w || !Array.isArray(w.windLayers) || !w.windLayers.length) return '';
    const L = w.windLayers[w.activeWindLayer] || w.windLayers[0];
    if (!L || !isFinite(L.speedMs)) return '';
    const from = (L.mainDirection + 180 + 360) % 360; // GeoFS stores the direction wind blows TOWARD
    const alt = getAltitudeM();
    return `${alt != null ? flOf(alt) + ' \u00B7 ' : ''}${pad3(from)}\u00B0 / ${Math.round(L.speedMs * MS_TO_KT)} kt`;
  }

  function aloftText() {
    const p = state.profile;
    if (!p || p.length < 2) return 'surface only';
    let best = p[0];
    p.forEach((L) => { if (L.kt > best.kt) best = L; });
    return `max ${Math.round(best.kt)} kt @ ${flOf(best.floor + CFG.layerStepM / 2)}`;
  }

  function render() {
    if (!box) return;
    toggleBtn.textContent = state.collapsed ? '\u25B8' : '\u25BE';
    body.style.display = state.collapsed ? 'none' : 'block';
    if (state.collapsed) return;

    const c = state.data;
    const w = W();
    const simTxt = simWindText();
    const installed = !!(w && w.windLayers && w.windLayers.__om === state.stamp);
    const layersTxt = !state.apply ? 'injection off'
      : (installed ? `${w.windLayers.length} layers installed` : (state.profile ? 'not installed yet\u2026' : '\u2014'));

    // only rebuild the DOM when something visible changed (keeps button clicks reliable)
    const sig = JSON.stringify([c, state.error, state.apply, simTxt, layersTxt, !!G(), state.lastFetch, state.surfUsed]);
    if (sig === state.lastSig) return;
    state.lastSig = sig;

    body.replaceChildren();

    if (!c) {
      const msg = document.createElement('div');
      msg.textContent = state.error
        ? `Error: ${state.error}`
        : (G() ? 'Waiting for aircraft position\u2026' : 'GeoFS not detected yet\u2026');
      body.appendChild(msg);
    } else {
      const cond = document.createElement('div');
      cond.textContent = WMO[c.weather_code] || `Code ${c.weather_code}`;
      Object.assign(cond.style, { fontWeight: '600', marginBottom: '3px' });
      body.appendChild(cond);

      const gust = c.wind_gusts_10m > c.wind_speed_10m + 1 ? ` G${Math.round(c.wind_gusts_10m)}` : '';
      body.append(
        row(CFG.surfaceWind === 'metar' ? 'Surface (METAR)' : 'Surface (model)',
          state.surfUsed ? `${pad3(state.surfUsed.fromDeg)}\u00B0 / ${Math.round(state.surfUsed.kt)} kt` : '\u2014'),
        row('Model 10 m wind', `${pad3(c.wind_direction_10m)}\u00B0 / ${Math.round(c.wind_speed_10m)}${gust} kt`),
        row('Sim wind here', simTxt || 'n/a'),
        row('Winds aloft', aloftText()),
        row('Wind layers', layersTxt),
        row('Temp / Dew', `${Math.round(c.temperature_2m)}\u00B0 / ${Math.round(c.dew_point_2m)}\u00B0C`),
        row('QNH', `${Math.round(c.pressure_msl)} hPa (${(c.pressure_msl * 0.02953).toFixed(2)} inHg)`),
        row('Visibility', c.visibility != null ? `${(c.visibility / 1000).toFixed(1)} km` : 'n/a'),
        row('Precip', `${c.precipitation} mm`),
        row('Clouds / time', 'GeoFS (untouched)'),
      );
      const t = document.createElement('div');
      t.textContent = `Updated ${new Date(state.lastFetch).toLocaleTimeString()}`;
      Object.assign(t.style, { opacity: '0.55', marginTop: '3px', fontSize: '11px' });
      body.appendChild(t);
      if (state.error) {
        const e = document.createElement('div');
        e.textContent = `Last refresh failed: ${state.error}`;
        e.style.color = '#ffb4a8';
        body.appendChild(e);
      }
    }

    const btns = document.createElement('div');
    Object.assign(btns.style, { display: 'flex', gap: '6px', marginTop: '6px' });
    btns.append(
      button(state.apply ? 'Inject: ON' : 'Inject: OFF', () => {
        state.apply = !state.apply; persist();
        if (state.apply) { applyNow(); installLayers(); }
        // either way, ask GeoFS to rebuild its weather (restores its own when OFF)
        try { const w2 = W(); if (w2 && typeof w2.refresh === 'function') w2.refresh(); } catch (e) { /* ignore */ }
        state.lastSig = ''; render();
      }),
      button('Refresh', () => refresh(true)),
      button('Dump', dump),
      button('Log', copyLog),
    );
    body.appendChild(btns);
  }

  /* ------------------------------ boot -------------------------------- */
  function tick() {
    try {
      hookWeather();   // (re)hooks if GeoFS replaced its functions
      applyNow();
      const natT = nativeFromLayers(W());
      if (natT) state.native = natT;
      ensureLayers();
      if (Date.now() - state.lastSample >= CFG.logEveryMs) { state.lastSample = Date.now(); sample(); }
      render();
      refresh(false);
    } catch (e) {
      console.warn('[Open-Meteo] tick error', e);
    }
  }

  function start() {
    buildUI();   // show the overlay immediately so you can tell the script is running
    render();
    refresh(true);
    setInterval(tick, CFG.tickMs);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
