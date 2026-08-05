// Turns a calculated route (the result shape produced by calculate.js or
// osrm.js) into the sidebar's summary card, route-options list, road
// diagram, and manifest table. Nothing in here does any pathfinding --
// it only reads res.sequenceData and friends and writes HTML.

import { App } from './state.js';
import { el, escapeHtml, svgIcon, formatDuration, formatClockTime, getDepartureStartMinutes } from './util.js';
import { setBaseWaypointsVisible, setNetworkLineDimmed, renderRouteOnMap } from './map.js';
import { updateLegend } from './legend.js';

export function showSummaryError(title, msg) {
  el('summary-card').style.display = 'block';
  el('summary-card').innerHTML = '<div class="alert error"><strong>' + escapeHtml(title) + '</strong><br/>' + escapeHtml(msg) + '</div>';
  el('options-card').style.display = 'none';
}

export function resetTable() {
  el('table-body').innerHTML = '<tr><td colspan="9" class="empty-row">Calculate a route to view the manifest.</td></tr>';
  el('export-btn').disabled = true;
}

export function clearRouteDisplay() {
  // Keep App.lastCalculatedRoute in sync with what's actually drawn --
  // otherwise the legend (and anything else keyed off "is there a route on
  // screen") would keep describing a route that was just wiped.
  App.lastCalculatedRoute = null;
  if (App.routeLayerGroup) App.routeLayerGroup.clearLayers();
  setBaseWaypointsVisible(true);
  setNetworkLineDimmed(false);
  el('options-card').style.display = 'none';
  el('schematic-card').style.display = 'none';
  el('schematic-placeholder').style.display = 'block';
  el('schematic').innerHTML = '';
  resetTable();
  updateLegend();
}

export function renderSummaryCard(res) {
  const swapCount = res.detectedWaypoints.filter((w) => w.wp.isKissPoint).length;
  const multiStop = res.orderedStopWaypoints.length > 2;
  const startMinutes = getDepartureStartMinutes();
  const totalHrs = res.totalDist / res.avgSpeedKmh;
  const kissStopHrs = (res.kissStopMinutes || 0) / 60;
  const stopTimeHrs = swapCount * kissStopHrs;
  // Est. Travel Time stays pure driving duration (it's explicitly labeled
  // with the km/h used); the two clock-time estimates below fold in the
  // kisspoint stops since those are meant to be realistic wall-clock
  // predictions, not just distance/speed.
  const etaHrs = totalHrs + stopTimeHrs;
  const returningHrs = totalHrs * 2 + stopTimeHrs * 2;

  let html = '';
  if (res.viaOsrm) {
    html += '<div class="alert" style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;margin-bottom:10px;">' +
      '<strong>OSM fallback route</strong><br/>' + (res.osrmNote ||
      'This trip could not be routed on the validated internal road network, so it was calculated over public OpenStreetMap roads instead.') +
      '</div>';
  }
  html += '<div class="metric-grid">' +
    '<div class="metric"><div class="metric-val">' + res.totalDist.toFixed(1) + ' km</div><div class="metric-lbl">Total Distance</div></div>' +
    '<div class="metric"><div class="metric-val">' + res.detectedWaypoints.length + '</div><div class="metric-lbl">En-route Waypoints</div></div>' +
    '<div class="metric"><div class="metric-val">' + formatDuration(totalHrs) + '</div><div class="metric-lbl">Est. Travel Time (' + res.avgSpeedKmh + ' km/h)</div></div>' +
    '<div class="metric"><div class="metric-val">' + formatClockTime(startMinutes, etaHrs) + '</div><div class="metric-lbl">Est. Arrival Time</div></div>' +
    '<div class="metric"><div class="metric-val">' + formatClockTime(startMinutes, returningHrs) + '</div><div class="metric-lbl">Est. Returning Time</div></div>' +
    '</div>';

  const notes = [];
  if (multiStop) notes.push('<div class="swap-note" style="color:#7c3aed;">' + svgIcon('star', 11, '#7c3aed') + ' ' + (res.orderedStopWaypoints.length - 2) + ' required waypoint(s), auto-ordered</div>');
  if (swapCount > 0) notes.push('<div class="swap-note">' + svgIcon('swap', 11, '#b45309') + ' ' + swapCount + ' Kisspoint(s) Included (+' + Math.round(stopTimeHrs * 60) + ' min stop, each way)</div>');
  if (notes.length) html += '<div class="swap-note-row">' + notes.join('') + '</div>';

  el('summary-card').style.display = 'block';
  el('summary-card').innerHTML = html;
}

export function renderRouteOptionsUI(res) {
  const alternatives = res.routeAlternatives;
  const card = el('options-card');
  if (!alternatives || alternatives.length < 2) { card.style.display = 'none'; card.innerHTML = ''; return; }

  const shortestDist = alternatives[0].totalDist;
  let html = '<div class="card-title">Route Options</div><div class="options-list">';
  alternatives.forEach((alt, idx) => {
    const isSelected = idx === res.selectedAlternativeIndex;
    const diff = alt.totalDist - shortestDist;
    html += '<div class="option' + (isSelected ? ' selected' : '') + '" data-idx="' + idx + '">' +
      '<div class="option-label">Option ' + (idx + 1) + (idx === 0 ? ' · Shortest' : '') + '</div>' +
      '<div class="option-meta"><span>' + alt.totalDist.toFixed(1) + ' km</span><span>' + alt.detectedWaypoints.length + ' waypoints</span>' +
      (idx > 0 ? '<span class="option-diff">+' + diff.toFixed(1) + ' km</span>' : '') + '</div></div>';
  });
  html += '</div>';
  card.style.display = 'block';
  card.innerHTML = html;
  card.querySelectorAll('.option').forEach((optEl) => {
    optEl.addEventListener('click', () => selectRouteAlternative(alternatives, parseInt(optEl.getAttribute('data-idx'), 10)));
  });
}

export function renderSchematicDiagram(res) {
  const items = res.sequenceData;
  let html = '';
  items.forEach((item, idx) => {
    const isStart = item.type === 'Start', isFinish = item.type === 'Finish', isReq = item.type === 'Required Waypoint', isKiss = item.isKissPoint;
    let cls = 'schem-symbol', icon = idx;
    if (isStart) { cls += ' dep'; icon = 'A'; }
    else if (isFinish) { cls += ' arr'; icon = 'B'; }
    else if (isKiss) { cls += ' kiss'; icon = svgIcon('swap', 11, '#fff'); }
    else if (isReq) { cls += ' req'; icon = svgIcon('star', 11, '#fff'); }
    else { cls += ' wp'; }
    html += '<div class="schem-node"><div class="' + cls + '">' + icon + '</div>' +
      '<div class="schem-label" title="' + escapeHtml(item.shortName) + '">' + escapeHtml(item.shortName) + '</div>' +
      '<div class="schem-dist">' + item.outboundCum.toFixed(1) + ' km &middot; ' + formatDuration(item.outboundTimeHrs) + '</div></div>';
  });
  el('schematic-card').style.display = 'block';
  el('schematic-placeholder').style.display = 'none';
  el('schematic').innerHTML = html;
}

// Row classification: departure/arrival win (structural endpoints), then
// kiss point (operationally significant regardless of position), then any
// other waypoint. Connector/link rows get no tint -- they're a network
// segment, not a point.
function rowClassFor(item) {
  if (item.type === 'Start') return 'row-departure';
  if (item.type === 'Finish') return 'row-arrival';
  if (item.isKissPoint) return 'row-kiss';
  if (item.type === 'Connector') return '';
  return 'row-waypoint';
}

export function renderTableBreakdown(res) {
  const items = res.sequenceData;
  const startMinutes = getDepartureStartMinutes();
  let html = '';
  items.forEach((item) => {
    html += '<tr class="' + rowClassFor(item) + '"><td>' + item.seq + '</td>' +
      '<td>' + escapeHtml(item.shortName) + '</td>' +
      '<td>' + (item.outboundLeg > 0 ? item.outboundLeg.toFixed(1) + ' km' : '-') + '</td>' +
      '<td><strong>' + item.outboundCum.toFixed(1) + ' km</strong></td>' +
      '<td>' + formatDuration(item.outboundTimeHrs) + '</td>' +
      '<td><strong>' + formatClockTime(startMinutes, item.outboundTimeHrs) + '</strong></td>' +
      '<td class="ret-col">' + (item.returnLeg > 0 ? item.returnLeg.toFixed(1) + ' km' : '-') + '</td>' +
      '<td class="ret-col"><strong>' + item.returnCum.toFixed(1) + ' km</strong></td>' +
      '<td class="ret-col">' + formatDuration(item.returnTimeHrs) + '</td></tr>';
  });
  el('table-body').innerHTML = html;
  el('export-btn').disabled = false;
}

export function renderCalculatedRoute(res) {
  renderSummaryCard(res);
  renderTableBreakdown(res);
  renderSchematicDiagram(res);
  renderRouteOptionsUI(res);
  renderRouteOnMap(res);
  el('export-btn').disabled = false;
}

export function selectRouteAlternative(alternatives, index) {
  const res = alternatives[index];
  res.routeAlternatives = alternatives;
  res.selectedAlternativeIndex = index;
  App.lastCalculatedRoute = res;
  renderCalculatedRoute(res);
}
