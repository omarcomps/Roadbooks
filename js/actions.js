// The two sidebar buttons that aren't part of the calculate pipeline
// itself: clearing the form back to its starting state, and exporting the
// current manifest to a CSV file.

import { App } from './state.js';
import { el, formatCoords, formatDuration, formatClockTime, getDepartureStartMinutes } from './util.js';
import { setBaseWaypointsVisible, setNetworkLineDimmed } from './map.js';
import { resetTable } from './render.js';
import { renderRequiredChips, checkReadyToCalculate } from './combos.js';
import { updateLegend } from './legend.js';

export function onReset() {
  App.selectedDepWp = null;
  App.selectedArrWp = null;
  App.requiredStops = [];
  el('dep-input').value = '';
  el('arr-input').value = '';
  el('req-input').value = '';
  renderRequiredChips();

  App.lastCalculatedRoute = null;
  if (App.routeLayerGroup) App.routeLayerGroup.clearLayers();
  setBaseWaypointsVisible(true);
  setNetworkLineDimmed(false);

  el('summary-card').style.display = 'none'; el('summary-card').innerHTML = '';
  el('options-card').style.display = 'none'; el('options-card').innerHTML = '';
  el('schematic-card').style.display = 'none'; el('schematic').innerHTML = '';
  el('schematic-placeholder').style.display = 'block';
  resetTable();
  checkReadyToCalculate();
  updateLegend();
}

export function onExportCsv() {
  if (!App.lastCalculatedRoute) return;
  const items = App.lastCalculatedRoute.sequenceData;
  const startMinutes = getDepartureStartMinutes();

  let csv = 'Seq,Type,Kisspoint,Waypoint_Name_Segment,Coordinates_Lat_Lng,Outbound_Leg_km,Outbound_Cum_Dist_km,Outbound_Time_to_Reach,Outbound_ETA,Return_Leg_km,Return_Cum_Dist_km,Return_Time\n';
  items.forEach((item) => {
    csv += item.seq + ',"' + item.type + '","' + (item.isKissPoint ? 'Yes' : 'No') + '","' + String(item.desc).replace(/"/g, '""') + '","' + formatCoords(item.lat, item.lng) + '",' +
      item.outboundLeg.toFixed(1) + ',' + item.outboundCum.toFixed(1) + ',"' + formatDuration(item.outboundTimeHrs) + '","' + formatClockTime(startMinutes, item.outboundTimeHrs) + '",' +
      item.returnLeg.toFixed(1) + ',' + item.returnCum.toFixed(1) + ',"' + formatDuration(item.returnTimeHrs) + '"\n';
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'route_manifest.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
