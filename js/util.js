// Small, self-contained helpers used all over the app: geo math, string/
// number formatting, DOM shortcuts, inline SVG icons, and a priority queue
// for Dijkstra. Nothing here touches the map, the portal, or any layer.

import { App } from './state.js';

export function el(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------- GEOMETRY
const EARTH_RADIUS_KM = 6371.0088;

function toRad(deg) {
  return deg * Math.PI / 180;
}

export function haversineKm(lng1, lat1, lng2, lat2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function projectPointOnSegment(a, b, p) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const apx = p[0] - a[0], apy = p[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { point: [a[0] + abx * t, a[1] + aby * t], t };
}

export function nearestPointOnLineCoords(coords, p) {
  let best = null, travelled = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const segLenKm = haversineKm(a[0], a[1], b[0], b[1]);
    const proj = projectPointOnSegment(a, b, p);
    const distKm = haversineKm(p[0], p[1], proj.point[0], proj.point[1]);
    const locationKm = travelled + segLenKm * proj.t;
    if (!best || distKm < best.distKm) best = { coordinates: proj.point, distKm, location: locationKm };
    travelled += segLenKm;
  }
  return best;
}

// Leaflet's LatLng carries full floating-point precision (15+ digits),
// which the layer's latitude/longitude fields reject with "must be decimal
// number". Rounding to 6 decimals (~0.11m) satisfies that and is already
// far more precision than this app needs.
export function roundCoord(n) {
  return Number(n.toFixed(6));
}

export function edgeId(a, b) {
  return a < b ? (a + '|' + b) : (b + '|' + a);
}

// ----------------------------------------------------------------- TIME
export function formatDuration(hours) {
  if (!isFinite(hours) || hours < 0) return '-';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
  return h === 0 ? (m + 'm') : (h + 'h ' + m + 'm');
}

// Departure minutes (from the "Departure Time" input) + elapsed hours ->
// clock time, wrapping past midnight with a "+Nd" suffix for routes that
// span more than a day.
export function formatClockTime(startMinutes, elapsedHours) {
  if (!isFinite(elapsedHours) || elapsedHours < 0) return '-';
  const totalMinutes = startMinutes + Math.round(elapsedHours * 60);
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minsInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = Math.floor(minsInDay / 60), mm = minsInDay % 60;
  const str = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  return dayOffset > 0 ? (str + ' (+' + dayOffset + 'd)') : str;
}

export function formatCoords(lat, lng) {
  return (typeof lat === 'number' && typeof lng === 'number') ? (lat.toFixed(5) + ', ' + lng.toFixed(5)) : '-';
}

// "HH:MM" -> minutes since midnight.
export function getDepartureStartMinutes() {
  const val = el('departure-time-input') && el('departure-time-input').value;
  if (!val) return 0;
  const parts = val.split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

export function readKissStopMinutes() {
  const val = parseFloat(el('kiss-stop-input').value);
  return isFinite(val) && val >= 0 ? val : 0;
}

// ----------------------------------------------------------------- TEXT
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// applyEdits' result.error only ever surfaced .description, silently
// dropping .details -- an array ArcGIS often fills with the actual
// per-field validation message when a custom Attribute Rule rejects an
// edit. Logging the raw error too means the next failure shows up fully in
// the console instead of just a generic line.
export function describeApplyEditsError(result, fallback) {
  console.error('RouteEngine: applyEdits rejected', result);
  const err = result && result.error;
  if (!err) return fallback;
  const parts = [err.description || fallback];
  if (err.details && err.details.length) parts.push(err.details.join('; '));
  return parts.join(' — ');
}

// ------------------------------------------------------------------ ICONS
// Inline SVG rather than a unicode glyph, so these stay crisp at any size
// or DPI instead of depending on the system emoji/symbol font.
export function svgIcon(name, size, color) {
  size = size || 12;
  color = color || '#fff';
  if (name === 'swap') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h14"/><path d="M13 4l4 4-4 4"/><path d="M21 16H7"/><path d="M11 20l-4-4 4-4"/></svg>';
  }
  if (name === 'star') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + color + '"><path d="M12 2.5l2.95 6.62 7.05.66-5.35 4.9 1.6 7.32-6.25-3.82-6.25 3.82 1.6-7.32-5.35-4.9 7.05-.66z"/></svg>';
  }
  return '';
}

// -------------------------------------------------------------- UI FEEDBACK
export function showLoading(msg) {
  el('loading-text').textContent = msg || 'Working…';
  el('loading-overlay').classList.add('active');
}

export function hideLoading() {
  el('loading-overlay').classList.remove('active');
}

export function showToast(msg, isError) {
  if (App.toastTimer) clearTimeout(App.toastTimer);
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast ' + (isError ? 'error' : 'ok');
  t.style.display = 'block';
  App.toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

// ------------------------------------------------------------------- HEAP
// Binary min-heap keyed by distance, used by Dijkstra in graph.js.
export class MinHeap {
  constructor() {
    this.items = [];
  }

  size() {
    return this.items.length;
  }

  push(dist, key) {
    this.items.push([dist, key]);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p][0] <= this.items[i][0]) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this.items[l][0] < this.items[smallest][0]) smallest = l;
        if (r < n && this.items[r][0] < this.items[smallest][0]) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
