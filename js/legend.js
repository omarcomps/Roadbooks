// The collapsible "Legend" panel on the map, plus the generic open/close
// wiring shared with the sidebar's "data status" panel. The legend content
// is rebuilt from scratch every time the map's content changes, so it only
// ever lists what's actually drawn right now.

import { App } from './state.js';
import { el } from './util.js';
import { BASE_WAYPOINT_TYPE_COLORS, BASE_WAYPOINT_FALLBACK_COLOR } from './map.js';

export function setupCornerPanels() {
  // Plain toggles, no outside-click auto-close -- these are reference
  // panels meant to stay open while working, not transient dropdown menus
  // (the legend defaults to expanded for exactly that reason).
  function wireToggle(btnId, panelId) {
    el(btnId).addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = el(panelId);
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
  }
  wireToggle('data-info-toggle', 'data-info-details');
  wireToggle('legend-toggle', 'legend-details');
  updateLegend();
}

function legendSwatchDot(color) {
  return '<span class="legend-swatch" style="width:12px;height:12px;border-radius:50%;background:' + color + ';border:1.5px solid #fff;box-shadow:0 0 0 1px #cbd5e1;"></span>';
}
function legendSwatchLine(color, dashed) {
  return '<span class="legend-line" style="border-top-color:' + color + ';' + (dashed ? 'border-top-style:dashed;' : '') + '"></span>';
}
function legendRow(swatchHtml, label) {
  return '<div class="legend-row">' + swatchHtml + label + '</div>';
}

export function updateLegend() {
  const panel = el('legend-details');
  if (!panel) return;
  const rows = [];

  if (App.networkBaseLine) rows.push(legendRow(legendSwatchLine('#94a3b8', false), 'Road network'));

  const res = App.lastCalculatedRoute;
  if (res) {
    rows.push(legendRow(legendSwatchLine('#d02327', res.viaOsrm), res.viaOsrm ? 'Calculated route (OSM fallback)' : 'Calculated route'));
    const hasConnector = res.nodeList.some((n) => n.connectorDist > 0.001);
    if (hasConnector) rows.push(legendRow(legendSwatchLine('#d97706', true), 'Connector link'));
    rows.push(legendRow(legendSwatchDot('#d02327'), 'Departure (A)'));
    rows.push(legendRow(legendSwatchDot('#1e3a5f'), 'Arrival (B)'));
    if (res.orderedStopWaypoints.length > 2) rows.push(legendRow(legendSwatchDot('#7c3aed'), 'Required waypoint'));
    if (res.detectedWaypoints.some((w) => w.wp.isKissPoint)) rows.push(legendRow(legendSwatchDot('#d97706'), 'Kisspoint'));
    if (res.detectedWaypoints.some((w) => !w.wp.isKissPoint)) rows.push(legendRow(legendSwatchDot('#94a3b8'), 'Waypoint on route'));
  } else if (App.waypoints.length) {
    const hasType = (t) => (w) => !w.isKissPoint && String(w.type || '').toLowerCase() === t;
    const isOtherType = (w) => !w.isKissPoint && !BASE_WAYPOINT_TYPE_COLORS[String(w.type || '').toLowerCase()];
    if (App.waypoints.some(hasType('coordination'))) rows.push(legendRow(legendSwatchDot(BASE_WAYPOINT_TYPE_COLORS.coordination), 'Coordination (click to edit)'));
    if (App.waypoints.some(hasType('base'))) rows.push(legendRow(legendSwatchDot(BASE_WAYPOINT_TYPE_COLORS.base), 'Base (click to edit)'));
    if (App.waypoints.some(hasType('site'))) rows.push(legendRow(legendSwatchDot(BASE_WAYPOINT_TYPE_COLORS.site), 'Site (click to edit)'));
    if (App.waypoints.some((w) => w.isKissPoint)) rows.push(legendRow(legendSwatchDot('#d97706'), 'Kisspoint (click to edit)'));
    if (App.waypoints.some(isOtherType)) rows.push(legendRow(legendSwatchDot(BASE_WAYPOINT_FALLBACK_COLOR), 'Other waypoint (click to edit)'));
  }

  panel.innerHTML = rows.length ? rows.join('') : '<div class="legend-row" style="color:#94a3b8;font-style:italic;">Nothing on the map yet</div>';
}
