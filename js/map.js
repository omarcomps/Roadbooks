// Everything that draws on the Leaflet map: the basemap itself, the faint
// road-network backdrop, the always-on waypoint dots, and a calculated
// route with its connectors and stop markers. Also owns "add waypoint"
// click handling on the map, which hands off to waypoint-edit.js once a
// spot has been picked.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { el, escapeHtml, svgIcon, formatCoords, getDepartureStartMinutes, formatClockTime, showToast } from './util.js';
import { snapLatLngToRoute } from './graph.js';
import { openAddWaypointForm, openEditWaypointForm } from './waypoint-edit.js';
import { updateLegend } from './legend.js';

export function initMap() {
  App.map = L.map('map', { center: [35.0, 38.2], zoom: 7, preferCanvas: true });
  switchBasemap(CONFIG.defaultBasemap);
  App.baseWaypointsLayerGroup = L.layerGroup().addTo(App.map);
  App.routeLayerGroup = L.layerGroup().addTo(App.map);
  App.map.on('click', onMapClick);
  if (App.waypoints.length > 0) renderBaseWaypointsLayer();
  if (App.routesReady) renderNetworkBaseLayer();
}

export function switchBasemap(key) {
  const def = CONFIG.basemaps[key];
  if (!def) return;
  if (App.baseTileLayer) App.map.removeLayer(App.baseTileLayer);
  App.baseTileLayer = L.tileLayer(def.urlTemplate, { attribution: def.attribution, maxZoom: def.maxZoom }).addTo(App.map);
}

// Parses "lat, lng" from the sidebar search box, pans/zooms the map there,
// and drops a marker so a known coordinate (e.g. a GPS reading) can be
// located and cross-checked against nearby waypoints.
export function goToLatLng() {
  const hint = el('latlng-hint');
  const raw = el('latlng-input').value.trim();
  hint.textContent = '';
  hint.classList.remove('warn');
  if (!raw) return;

  const parts = raw.split(',');
  const lat = parts.length === 2 ? parseFloat(parts[0]) : NaN;
  const lng = parts.length === 2 ? parseFloat(parts[1]) : NaN;
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    hint.textContent = 'Enter as "lat, lng" -- latitude -90 to 90, longitude -180 to 180.';
    hint.classList.add('warn');
    return;
  }

  if (App.latLngSearchMarker) App.map.removeLayer(App.latLngSearchMarker);
  App.latLngSearchMarker = L.marker([lat, lng], { icon: leafletIcon('search') })
    .bindTooltip(formatCoords(lat, lng), { permanent: true, direction: 'top', offset: [0, -10] })
    .addTo(App.map);
  App.map.setView([lat, lng], Math.max(App.map.getZoom(), 14));
}

// Whole route network, drawn once as a single light-weight multi-segment
// polyline (all corridor segments already flattened in
// App.routeCoordSegments during graph construction). Full opacity while
// data editing is unlocked, so the network is easy to see while placing or
// dragging waypoints; dimmed to the faint default once locked; dropped to
// near-invisible whenever a route is calculated (in either lock state) so
// the highlighted red route stands out.
const NETWORK_LINE_OPACITY_UNLOCKED = 1;
const NETWORK_LINE_OPACITY_DEFAULT = 0.45;
const NETWORK_LINE_OPACITY_DIMMED = 0.1;

function networkLineOpacity(routeCalculated) {
  if (routeCalculated) return NETWORK_LINE_OPACITY_DIMMED;
  return App.editingLocked ? NETWORK_LINE_OPACITY_DEFAULT : NETWORK_LINE_OPACITY_UNLOCKED;
}

export function renderNetworkBaseLayer() {
  if (!App.map || !App.routeCoordSegments.length) return;
  if (App.networkBaseLine) App.map.removeLayer(App.networkBaseLine);
  const paths = App.routeCoordSegments.map((seg) => [[seg[0][1], seg[0][0]], [seg[1][1], seg[1][0]]]);
  App.networkBaseLine = L.polyline(paths, {
    color: '#94a3b8', weight: 1.5,
    opacity: networkLineOpacity(!!App.lastCalculatedRoute),
    interactive: false
  }).addTo(App.map);
  App.networkBaseLine.bringToBack();
  updateLegend();
}

export function setNetworkLineDimmed(dimmed) {
  if (!App.networkBaseLine) return;
  App.networkBaseLine.setStyle({ opacity: networkLineOpacity(dimmed) });
}

export function leafletIcon(kind, opts) {
  opts = opts || {};
  if (kind === 'num') return L.divIcon({ className: '', html: '<div class="pin-num" style="background:' + opts.color + '">' + opts.label + '</div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  if (kind === 'kiss') return L.divIcon({ className: '', html: '<div class="pin-kiss">' + svgIcon('swap', 7, '#fff') + '</div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  if (kind === 'req') return L.divIcon({ className: '', html: '<div class="pin-req">' + svgIcon('star', 9, '#fff') + '</div>', iconSize: [17, 17], iconAnchor: [8, 8] });
  if (kind === 'endpoint') return L.divIcon({ className: '', html: '<div class="pin-endpoint" style="background:' + opts.color + '"><span>' + opts.label + '</span></div>', iconSize: [18, 18], iconAnchor: [9, 16] });
  if (kind === 'new') return L.divIcon({ className: '', html: '<div class="pin-new"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  if (kind === 'edit') return L.divIcon({ className: '', html: '<div class="pin-edit"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  if (kind === 'search') return L.divIcon({ className: '', html: '<div class="pin-search"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  return L.divIcon({ className: '', html: '<div class="pin-num" style="background:#94a3b8">?</div>', iconSize: [14, 14], iconAnchor: [7, 7] });
}

// Plain-dot vs. icon-based markers expose different APIs (Path.setStyle vs.
// Marker.setOpacity) -- these let dimming/hiding code work on either kind
// without caring which one a given waypoint uses.
export function dimBaseMarker(marker, dimmed) {
  if (marker.setStyle) marker.setStyle({ opacity: dimmed ? .25 : 1, fillOpacity: dimmed ? .2 : .75 });
  else if (marker.setOpacity) marker.setOpacity(dimmed ? .25 : 1);
}

export function hideBaseMarker(marker) {
  if (marker.setStyle) marker.setStyle({ opacity: 0, fillOpacity: 0 });
  else if (marker.setOpacity) marker.setOpacity(0);
}

// Colors for the always-on base waypoints layer, by type. Anything whose
// type isn't one of these three falls back to a light neutral dot rather
// than being hidden -- every waypoint is visible by default, and the whole
// layer (dots + labels) is hidden outright once a route is calculated
// instead, so only the route's own markers remain on screen. Exported
// because legend.js draws matching swatches for whatever's currently shown.
export const BASE_WAYPOINT_TYPE_COLORS = { coordination: '#7c3aed', base: '#dc2626', site: '#f97316' };
export const BASE_WAYPOINT_FALLBACK_COLOR = '#94a3b8';
const BASE_WAYPOINT_RADIUS = 6;
const BASE_WAYPOINT_RADIUS_ROAD_WAYPOINT = BASE_WAYPOINT_RADIUS / 4; // type="Waypoint" -- 3x smaller
const BASE_WAYPOINT_RADIUS_OTHER = BASE_WAYPOINT_RADIUS * 2; // anything else uncategorized -- 25% smaller

export function renderBaseWaypointsLayer() {
  if (!App.map) return;
  App.baseWaypointsLayerGroup.clearLayers();

  App.waypoints.forEach((wp) => {
    if (wp.lng == null || wp.lat == null) return;
    let marker;
    if (wp.isKissPoint) {
      marker = L.marker([wp.lat, wp.lng], { icon: leafletIcon('kiss') });
      // Kisspoint labels are always on, same as Coordination/Base/Site --
      // full detail (coordinates, coverage) is still one click away in the
      // edit popup.
      marker.bindTooltip('<strong>' + escapeHtml(wp.name) + '</strong>', { permanent: true, direction: 'top', offset: [0, -7] });
    } else {
      const typeLower = String(wp.type || '').toLowerCase();
      const recognizedColor = BASE_WAYPOINT_TYPE_COLORS[typeLower];
      const color = recognizedColor || BASE_WAYPOINT_FALLBACK_COLOR;
      const radius = recognizedColor ? BASE_WAYPOINT_RADIUS
        : typeLower === 'waypoint' ? BASE_WAYPOINT_RADIUS_ROAD_WAYPOINT
        : BASE_WAYPOINT_RADIUS_OTHER;
      // A white halo (rather than a same-color stroke) keeps the dot
      // legible against any basemap, including photographic satellite
      // imagery -- matches the legend's swatches and every icon-based
      // marker's own white border. Scaled to the radius so the halo
      // doesn't swallow the smallest (road-waypoint) dots.
      const haloWeight = Math.max(1, Math.min(2, radius * 0.35));
      marker = L.circleMarker([wp.lat, wp.lng], { radius, color: '#ffffff', weight: haloWeight, fillColor: color, fillOpacity: .95 });
      // Coordination/Base/Site labels are always on. Anything else (the
      // fallback-colored "other" dots) is too numerous/uncategorized to
      // label permanently without cluttering the map -- hover only.
      marker.bindTooltip('<strong>' + escapeHtml(wp.name) + '</strong>', { permanent: !!recognizedColor, direction: 'top', offset: [0, -9] });
    }
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (App.editingLocked) { showToast('Data editing is locked.', false); return; }
      openEditWaypointForm(wp, marker);
    });
    marker.addTo(App.baseWaypointsLayerGroup);
  });

  if (!App.lastCalculatedRoute) {
    const pts = App.waypoints.filter((w) => w.lat != null && w.lng != null).map((w) => [w.lat, w.lng]);
    if (pts.length > 0) {
      const b = L.latLngBounds(pts);
      if (b.isValid()) App.map.fitBounds(b, { padding: [30, 30], maxZoom: 10 });
    }
  }
  updateLegend();
}

// Dimming leaves the dots faint but their permanent name labels fully
// visible (setStyle doesn't touch a bound tooltip), so a calculated route
// would still look cluttered with every waypoint's label. Hiding the whole
// layer group removes both together, leaving only the route's own markers
// on screen.
export function setBaseWaypointsVisible(visible) {
  if (!App.map || !App.baseWaypointsLayerGroup) return;
  const onMap = App.map.hasLayer(App.baseWaypointsLayerGroup);
  if (visible && !onMap) App.baseWaypointsLayerGroup.addTo(App.map);
  else if (!visible && onMap) App.map.removeLayer(App.baseWaypointsLayerGroup);
}

export function renderRouteOnMap(res) {
  if (!App.map) return;
  App.routeLayerGroup.clearLayers();
  setBaseWaypointsVisible(false);
  setNetworkLineDimmed(true);

  const stops = res.orderedStopWaypoints;
  const connectorStyle = { color: '#d97706', weight: 3, dashArray: '5,5', opacity: .9 };

  // Lookup by waypoint id -> its sequence-data entry, so tooltips can show
  // cumulative distance and arrival time alongside the name.
  const seqById = {};
  res.sequenceData.forEach((item) => { if (item.id != null) seqById[item.id] = item; });
  const startMinutes = getDepartureStartMinutes();
  function tooltipDetail(wpId) {
    const item = seqById[wpId];
    if (!item) return '';
    return '<br/><span style="font-weight:600;color:#475569;">' + item.outboundCum.toFixed(1) + ' km &middot; ETA ' +
      formatClockTime(startMinutes, item.outboundTimeHrs) + '</span>';
  }

  stops.forEach((node) => {
    const linePts = node.connectorCoords
      ? node.connectorCoords.map((c) => [c[1], c[0]])
      : [[node.wp.lat, node.wp.lng], [node.snapped.coordinates[1], node.snapped.coordinates[0]]];
    L.polyline(linePts, connectorStyle).addTo(App.routeLayerGroup);
  });

  // Dashed when the route came from the OSRM fallback rather than the
  // validated internal network, so it reads as visually distinct on the
  // map itself, not just in the summary card banner.
  const mainLineStyle = { color: '#d02327', weight: 5, opacity: .9, lineCap: 'round' };
  if (res.viaOsrm) mainLineStyle.dashArray = '10,6';
  L.polyline(res.routeCoords.map((c) => [c[1], c[0]]), mainLineStyle).addTo(App.routeLayerGroup);

  // Matches the base layer's labeling rule: Kisspoint and recognized types
  // (Coordination/Base/Site) always show their label; anything else is
  // hover-only to avoid cluttering a route with many pass-through
  // waypoints. Any info the popup used to carry (Kisspoint status) is
  // folded into the hover tooltip text.
  res.detectedWaypoints.forEach((item) => {
    const isKiss = item.wp.isKissPoint;
    const recognizedColor = BASE_WAYPOINT_TYPE_COLORS[String(item.wp.type || '').toLowerCase()];
    const marker = L.marker([item.wp.lat, item.wp.lng], { icon: isKiss ? leafletIcon('kiss') : leafletIcon('num', { color: '#94a3b8', label: '•' }) }).addTo(App.routeLayerGroup);
    const kissLine = isKiss ? ('<br/><span style="color:#d97706;font-weight:bold;display:inline-flex;align-items:center;gap:4px;">' + svgIcon('swap', 10, '#d97706') + ' Kisspoint</span>') : '';
    const tooltipHtml = '<strong>' + escapeHtml(item.wp.name) + '</strong>' + kissLine + tooltipDetail(item.wp.id);
    marker.bindTooltip(tooltipHtml, { permanent: isKiss || !!recognizedColor, direction: 'top', offset: [0, -12] });
  });

  // Departure/arrival/required stops are always the significant points of a
  // calculated route -- always labeled, not hover-only.
  stops.forEach((node, i) => {
    const isFirst = i === 0, isLast = i === stops.length - 1;
    let icon;
    if (isFirst) icon = leafletIcon('endpoint', { color: '#d02327', label: 'A' });
    else if (isLast) icon = leafletIcon('endpoint', { color: '#1e3a5f', label: 'B' });
    else icon = leafletIcon('req');
    const marker = L.marker([node.wp.lat, node.wp.lng], { icon }).addTo(App.routeLayerGroup);
    const label = isFirst ? ('A: ' + node.wp.name) : isLast ? ('B: ' + node.wp.name) : node.wp.name;
    const tooltipHtml = '<strong>' + escapeHtml(label) + '</strong>' + tooltipDetail(node.wp.id);
    marker.bindTooltip(tooltipHtml, { permanent: true, direction: 'top', offset: [0, -20] });
  });

  const bounds = L.latLngBounds(res.routeCoords.map((c) => [c[1], c[0]]));
  stops.forEach((node) => bounds.extend([node.wp.lat, node.wp.lng]));
  App.map.fitBounds(bounds, { padding: [30, 30] });
  updateLegend();
}

export function onMapClick(e) {
  if (!App.isAddingWaypoint || App.editingLocked) return;
  if (App.pendingMarker) { App.map.removeLayer(App.pendingMarker); App.pendingMarker = null; }
  openAddWaypointForm(e.latlng);
}

export function setAddingMode(active) {
  App.isAddingWaypoint = active;
  const btn = el('add-wp-btn');
  btn.classList.toggle('active', active);
  btn.textContent = active ? 'Cancel Adding Waypoint' : '✚ Add Waypoint on Map';
  const hint = el('map-hint');
  hint.style.display = active ? 'block' : 'none';
  hint.textContent = 'Click the map to place a new waypoint';
  if (App.map) App.map.getContainer().style.cursor = active ? 'crosshair' : '';
  if (!active && App.pendingMarker) { App.map.removeLayer(App.pendingMarker); App.pendingMarker = null; }
}
