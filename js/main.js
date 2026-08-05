// Entry point. Registers a recovery handler for a known ArcGIS loader
// crash, then waits on auth.js to confirm a Portal sign-in before wiring
// up the rest of the UI and kicking off the data loads.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { el, showLoading, hideLoading, readKissStopMinutes } from './util.js';
import { initAuth } from './auth.js';
import { initMap, switchBasemap, goToLatLng, setAddingMode } from './map.js';
import { setupCombos, validateTolerance } from './combos.js';
import { setupCornerPanels } from './legend.js';
import { loadRoutes, loadWaypoints } from './data.js';
import { runCalculate, applyTimingToSequenceData } from './calculate.js';
import { renderSummaryCard, renderTableBreakdown, renderSchematicDiagram, showSummaryError } from './render.js';
import { onReset, onExportCsv } from './actions.js';
import { setEditingLocked } from './waypoint-edit.js';

// ArcGIS JS API 3.x's Dojo-based AMD loader has a known-flaky script
// injection path: loading a not-yet-cached module can throw "can't access
// property 'insertBefore', wa.parentNode is null" if the DOM node Dojo
// cached as its insertion point has gone away by the time it tries to use
// it. Once that happens the loader is left broken for the rest of the
// page's life -- every later esri/* module load (add/edit/move waypoint,
// even the initial routes/waypoints load) silently fails from then on,
// which is why one crash early on looks like "everything is broken." A
// full page reload gives the loader a completely fresh DOM/script state
// and reliably recovers, so this does that automatically -- once per
// session, so a genuine unrelated error can't cause a reload loop.
window.addEventListener('error', (e) => {
  const msg = (e && e.message) || '';
  if (msg.indexOf('insertBefore') === -1 || msg.indexOf('parentNode') === -1) return;
  if (sessionStorage.getItem('rb_loaderCrashReload')) {
    console.error('RouteEngine: ArcGIS loader crashed again after a recovery reload -- not retrying further', e.error || e);
    return;
  }
  sessionStorage.setItem('rb_loaderCrashReload', '1');
  console.error('RouteEngine: ArcGIS loader crashed (insertBefore/parentNode) -- reloading to recover', e.error || e);
  location.reload();
});

function startApp() {
  el('signin-overlay').style.display = 'none';
  el('app').style.display = 'flex';

  initMap();
  setupCombos();
  setupCornerPanels();

  const basemapSelect = el('basemap-select');
  Object.keys(CONFIG.basemaps).forEach((key) => {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = CONFIG.basemaps[key].label;
    basemapSelect.appendChild(o);
  });
  basemapSelect.value = CONFIG.defaultBasemap;
  basemapSelect.addEventListener('change', () => switchBasemap(basemapSelect.value));

  el('latlng-go-btn').addEventListener('click', goToLatLng);
  el('latlng-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') goToLatLng(); });

  el('tolerance-input').value = CONFIG.defaultToleranceMeters;
  el('speed-input').value = CONFIG.defaultAvgSpeedKmh;
  el('departure-time-input').value = CONFIG.defaultDepartureTime;
  el('departure-time-input').addEventListener('change', () => {
    if (App.lastCalculatedRoute) {
      renderTableBreakdown(App.lastCalculatedRoute);
      renderSchematicDiagram(App.lastCalculatedRoute);
    }
  });
  el('kiss-stop-input').value = CONFIG.defaultKissStopMinutes;
  el('kiss-stop-input').addEventListener('change', () => {
    const res = App.lastCalculatedRoute;
    if (!res) return;
    res.kissStopMinutes = readKissStopMinutes();
    applyTimingToSequenceData(res.sequenceData, res.avgSpeedKmh, res.kissStopMinutes);
    renderSummaryCard(res);
    renderTableBreakdown(res);
    renderSchematicDiagram(res);
  });
  el('tolerance-input').addEventListener('change', validateTolerance);

  el('calc-btn').addEventListener('click', () => {
    const toleranceKm = validateTolerance() / 1000;
    const speed = parseFloat(el('speed-input').value);
    if (!isFinite(speed) || speed <= 0) { showSummaryError('Invalid Average Speed', 'Enter a positive number of km/h before calculating.'); return; }
    const kissStopMinutes = readKissStopMinutes();
    showLoading('Calculating route…');
    // Deferred a tick so the loading overlay actually paints before the
    // (synchronous, sometimes chunky) pathfinding work below blocks the
    // main thread.
    setTimeout(() => {
      Promise.resolve()
        .then(() => runCalculate(App.selectedDepWp, App.selectedArrWp, App.requiredStops.slice(), toleranceKm, speed, kissStopMinutes))
        .catch((err) => {
          console.error('runCalculate failed', err);
          showSummaryError('Calculation Failed', (err && err.message) || String(err));
        })
        .then(() => hideLoading());
    }, 0);
  });

  el('reset-btn').addEventListener('click', onReset);
  el('export-btn').addEventListener('click', onExportCsv);
  el('add-wp-btn').addEventListener('click', () => setAddingMode(!App.isAddingWaypoint));
  el('lock-edit-btn').addEventListener('click', () => setEditingLocked(!App.editingLocked));
  setEditingLocked(true);

  loadRoutes();
  loadWaypoints();
}

initAuth(startApp);
