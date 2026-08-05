// Free, no-API-key routing over OSM road data (router.project-osrm.org's
// public demo server). Used two ways: patching in the odd leg or connector
// that the internal ArcGIS road network can't reach (see calculate.js), and
// as a last-resort whole-trip fallback when the network can't connect the
// selected waypoints at all.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { nearestPointOnLineCoords, showLoading, hideLoading, showToast } from './util.js';
import { applyTimingToSequenceData } from './calculate.js';
import { renderCalculatedRoute, showSummaryError, clearRouteDisplay } from './render.js';

export function fetchOsrmTrip(coordsLngLat) {
  const coordStr = coordsLngLat.map((c) => c[0] + ',' + c[1]).join(';');
  const url = CONFIG.osrmBaseUrl + '/trip/v1/driving/' + coordStr +
    '?source=first&destination=last&roundtrip=false&overview=full&geometries=geojson';
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error('OSRM request failed (HTTP ' + r.status + ')');
    return r.json();
  }).then((data) => {
    if (data.code !== 'Ok' || !data.trips || !data.trips.length) throw new Error(data.message || ('OSRM: ' + data.code));
    return data;
  });
}

// Routes exactly one A->B leg (no reordering, unlike /trip above). Used to
// patch in just the specific legs of a multi-stop route that the internal
// network can't connect, rather than falling the whole trip back to OSRM.
// Resolves to null (never rejects) on any failure, so Promise.all over
// several legs can tell which ones actually failed instead of the whole
// batch aborting on the first error.
export function fetchOsrmRoute(coordA, coordB) {
  const url = CONFIG.osrmBaseUrl + '/route/v1/driving/' +
    coordA[0] + ',' + coordA[1] + ';' + coordB[0] + ',' + coordB[1] +
    '?overview=full&geometries=geojson';
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error('OSRM request failed (HTTP ' + r.status + ')');
    return r.json();
  }).then((data) => {
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error(data.message || ('OSRM: ' + data.code));
    return data;
  }).catch((err) => {
    console.error('OSRM leg routing failed', err);
    return null;
  });
}

// waypointsInOrder are the plain selected waypoints (dep, required stops,
// arr) in the order the user picked them -- OSRM's own "trip" waypoints
// array is aligned to that same input order, each carrying where OSRM
// actually visits it (waypoint_index) and how far it had to snap.
function buildOsrmResult(waypointsInOrder, osrmData, toleranceKm, avgSpeedKmh, kissStopMinutes) {
  const trip = osrmData.trips[0];
  const routeCoords = trip.geometry.coordinates; // GeoJSON: already [lng, lat]
  const totalDist = trip.distance / 1000; // meters -> km

  const orderedStopWaypoints = osrmData.waypoints.map((ow, inputIdx) => ({
    wp: waypointsInOrder[inputIdx],
    snapped: { coordinates: ow.location },
    connectorDist: (ow.distance || 0) / 1000,
    tripOrder: ow.waypoint_index
  })).sort((a, b) => a.tripOrder - b.tripOrder);

  const excludeIds = waypointsInOrder.map((wp) => wp.id);
  const detectedWaypoints = [];
  App.waypoints.forEach((wp) => {
    if (excludeIds.indexOf(wp.id) !== -1 || wp.lng == null) return;
    const snapped = nearestPointOnLineCoords(routeCoords, [wp.lng, wp.lat]);
    if (snapped && snapped.distKm <= toleranceKm) detectedWaypoints.push({ wp, locationWithinLeg: snapped.location, distFromRouteKm: snapped.distKm });
  });
  detectedWaypoints.sort((x, y) => x.locationWithinLeg - y.locationWithinLeg);

  const res = {
    nodeList: orderedStopWaypoints, order: null, orderedStopWaypoints,
    routeCoords, detectedWaypoints,
    totalDist, avgSpeedKmh, kissStopMinutes,
    routeAlternatives: null, viaOsrm: true
  };
  res.sequenceData = buildOsrmSequenceData(res);
  return res;
}

// Simpler than calculate.js's buildRouteSequenceData: OSRM already returns
// one continuous road-following line through every stop in order, so each
// item's position is just its distance-along-that-line (via
// nearestPointOnLineCoords) rather than needing per-leg connector
// bookkeeping. Return-leg math and kisspoint stop timing are identical to
// the internal-network path, so both are reused as-is.
function buildOsrmSequenceData(res) {
  const coords = res.routeCoords;
  const items = [];

  res.orderedStopWaypoints.forEach((node, i) => {
    const isFirst = i === 0, isLast = i === res.orderedStopWaypoints.length - 1;
    const type = isFirst ? 'Start' : (isLast ? 'Finish' : 'Required Waypoint');
    const loc = nearestPointOnLineCoords(coords, [node.wp.lng, node.wp.lat]);
    items.push({
      type, id: node.wp.id,
      desc: (isFirst ? 'Departure (A): ' : isLast ? 'Arrival (B): ' : 'Required Waypoint: ') + node.wp.name + ' [ID: ' + node.wp.id + ']',
      shortName: node.wp.name, isKissPoint: node.wp.isKissPoint,
      lat: node.wp.lat, lng: node.wp.lng,
      outboundCum: loc ? loc.location : (isFirst ? 0 : res.totalDist)
    });
  });

  res.detectedWaypoints.forEach((dw) => {
    items.push({
      type: dw.wp.isKissPoint ? 'Kisspoint' : 'Pass-Through Waypoint', id: dw.wp.id,
      desc: 'Waypoint: ' + dw.wp.name + ' [ID: ' + dw.wp.id + ']',
      shortName: dw.wp.name, isKissPoint: dw.wp.isKissPoint,
      lat: dw.wp.lat, lng: dw.wp.lng,
      outboundCum: dw.locationWithinLeg
    });
  });

  items.sort((a, b) => a.outboundCum - b.outboundCum);
  items.forEach((item, i) => { item.seq = i + 1; });
  if (items.length) { items[0].outboundCum = 0; items[items.length - 1].outboundCum = res.totalDist; }
  for (let i = 0; i < items.length; i++) items[i].outboundLeg = i === 0 ? 0 : (items[i].outboundCum - items[i - 1].outboundCum);

  const totalRouteDist = res.totalDist;
  items.forEach((item) => { item.returnCum = totalRouteDist - item.outboundCum; });
  for (let j = 0; j < items.length; j++) {
    let leg = 0;
    if (j < items.length - 1) leg = items[j + 1].returnCum - items[j].returnCum;
    items[j].returnLeg = Math.abs(leg);
  }

  applyTimingToSequenceData(items, res.avgSpeedKmh, res.kissStopMinutes);
  return items;
}

export function attemptOsrmFallback(waypointsInOrder, toleranceKm, avgSpeedKmh, kissStopMinutes, failTitle, failMsg) {
  const coords = waypointsInOrder.map((wp) => [wp.lng, wp.lat]);
  showLoading('Internal network route unreachable — trying OSM-based routing…');
  fetchOsrmTrip(coords).then((osrmData) => {
    const res = buildOsrmResult(waypointsInOrder, osrmData, toleranceKm, avgSpeedKmh, kissStopMinutes);
    App.lastCalculatedRoute = res;
    renderCalculatedRoute(res);
    showToast('Route calculated using OSM roads (fallback) — not the internal road network.', false);
  }).catch((err) => {
    console.error('OSRM fallback failed', err);
    showSummaryError(failTitle, failMsg + ' OSM-based fallback routing also failed: ' + (err.message || err));
    clearRouteDisplay();
  }).finally(() => {
    hideLoading();
  });
}
