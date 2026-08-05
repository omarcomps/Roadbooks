// Loads the two hosted feature layers this app runs on -- the road
// network (Routes) and the point-of-interest list (Waypoints) -- and
// keeps the "data status" panel in the sidebar in sync with load progress.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { el, escapeHtml } from './util.js';
import { buildGraphFromRouteFeatures } from './graph.js';
import { renderNetworkBaseLayer, renderBaseWaypointsLayer } from './map.js';
import { checkReadyToCalculate } from './combos.js';
import { updateAddWaypointButtonState } from './waypoint-edit.js';

// Memoized: loadRoutes() and loadWaypoints() both call this at startup
// back-to-back, and two concurrent first-time require() calls for the same
// not-yet-cached AMD module is exactly the kind of race that crashes
// Dojo's script-injecting loader (see the window.onerror handler in
// main.js).
let esriQueryClassesPromise = null;
function getEsriQueryClasses() {
  if (!esriQueryClassesPromise) {
    esriQueryClassesPromise = new Promise((resolve) => {
      require(['esri/tasks/query', 'esri/tasks/QueryTask', 'esri/SpatialReference'], (EsriQuery, QueryTask, SpatialReference) => {
        resolve({ EsriQuery, QueryTask, SpatialReference });
      });
    });
  }
  return esriQueryClassesPromise;
}

function queryAllFeatures(url) {
  return new Promise((resolve, reject) => {
    getEsriQueryClasses().then(({ EsriQuery, QueryTask, SpatialReference }) => {
      const queryTask = new QueryTask(url);
      const pageSize = 1000;
      let allFeatures = [], prevFirstStamp = null;
      const maxPages = 200;

      function stampOf(feat) {
        if (!feat) return null;
        return JSON.stringify(feat.attributes) + '|' + (feat.geometry ? feat.geometry.x + ',' + feat.geometry.y : '');
      }

      function fetchPage(start, pageIndex) {
        const q = new EsriQuery();
        q.where = '1=1';
        q.outFields = ['*'];
        q.returnGeometry = true;
        q.outSpatialReference = new SpatialReference({ wkid: 4326 });
        q.start = start;
        q.num = pageSize;
        queryTask.execute(q, (result) => {
          const feats = result.features || [];
          const firstStamp = stampOf(feats[0]);
          if (pageIndex > 0 && firstStamp !== null && firstStamp === prevFirstStamp) {
            console.warn('Layer at ' + url + ' does not support paging — stopping after ' + allFeatures.length + ' features.');
            resolve(allFeatures);
            return;
          }
          prevFirstStamp = firstStamp;
          allFeatures = allFeatures.concat(feats);
          if (feats.length === pageSize && pageIndex < maxPages) fetchPage(start + pageSize, pageIndex + 1);
          else resolve(allFeatures);
        }, reject);
      }

      fetchPage(0, 0);
    });
  });
}

// Corner panel in the sidebar: a compact always-visible summary badge plus
// an expandable details view naming each loaded layer, its feature count,
// and the service URL it was read from.
function updateDataStatus() {
  const dot = el('data-info-dot'), summary = el('data-info-summary'), details = el('data-info-details');

  if (App.routesError || App.waypointsError) {
    dot.className = 'dot err';
    const msgs = [];
    if (App.routesError) msgs.push('Routes: ' + App.routesError);
    if (App.waypointsError) msgs.push('Waypoints: ' + App.waypointsError);
    summary.textContent = 'Data failed to load';
    details.innerHTML = '<div class="info-layer"><span style="color:#b91c1c;">' + escapeHtml(msgs.join(' · ')) + '</span></div>';
    return;
  }

  if (App.routesReady && App.waypointsReady) {
    dot.className = 'dot ok';
    summary.textContent = 'Routes and waypoints data loaded';
  } else {
    dot.className = 'dot';
    summary.textContent = 'Loading routes and waypoints data…';
  }

  details.innerHTML =
    '<div class="info-layer"><div class="info-layer-name">Routes</div>' +
    '<div class="info-layer-count">' + (App.routesFeatureCount == null ? 'loading…' : App.routesFeatureCount + ' segments') + '</div>' +
    '<a class="info-layer-url" href="' + escapeHtml(CONFIG.routesLayerUrl) + '" target="_blank" rel="noopener">' + escapeHtml(CONFIG.routesLayerUrl) + '</a></div>' +
    '<div class="info-layer"><div class="info-layer-name">Waypoints</div>' +
    '<div class="info-layer-count">' + (App.waypointsFeatureCount == null ? 'loading…' : App.waypointsFeatureCount + ' waypoints') + '</div>' +
    '<a class="info-layer-url" href="' + escapeHtml(CONFIG.waypointsLayerUrl) + '" target="_blank" rel="noopener">' + escapeHtml(CONFIG.waypointsLayerUrl) + '</a></div>';
}

export function loadRoutes() {
  queryAllFeatures(CONFIG.routesLayerUrl).then((features) => {
    buildGraphFromRouteFeatures(features);
    App.routesReady = true;
    App.routesFeatureCount = features.length;
    updateDataStatus();
    if (App.map) renderNetworkBaseLayer();
    checkReadyToCalculate();
    updateAddWaypointButtonState();
  }).catch((err) => {
    console.error('Routes load failed', err);
    App.routesError = (err && err.message) || String(err);
    updateDataStatus();
  });
}

export function loadWaypoints() {
  queryAllFeatures(CONFIG.waypointsLayerUrl).then((features) => {
    const fields = CONFIG.waypointFields;
    const kissTrueValues = CONFIG.kissPointTrueValues.map((v) => String(v).toLowerCase());

    App.waypoints = features.map((f) => {
      const attrs = f.attributes || {};
      const kissRaw = String(attrs[fields.kissPointField] == null ? '' : attrs[fields.kissPointField]).toLowerCase();
      return {
        id: attrs[fields.idField],
        name: attrs[fields.nameField] || ('Waypoint ' + attrs[fields.idField]),
        type: attrs[fields.typeField] || '',
        isKissPoint: kissTrueValues.indexOf(kissRaw) !== -1,
        mtnCoverage: attrs[fields.mtnField] || '',
        syriatelCoverage: attrs[fields.syriatelField] || '',
        rcellCoverage: attrs[fields.rcellField] || '',
        lng: f.geometry ? f.geometry.x : null,
        lat: f.geometry ? f.geometry.y : null
      };
    });
    App.waypointsReady = true;
    App.waypointsFeatureCount = App.waypoints.length;
    updateDataStatus();

    ['dep-input', 'arr-input', 'req-input'].forEach((id) => { el(id).disabled = false; });
    el('dep-input').placeholder = 'Search departure...';
    el('arr-input').placeholder = 'Search arrival...';
    el('req-input').placeholder = 'Add a required waypoint...';
    updateAddWaypointButtonState();

    if (App.map) renderBaseWaypointsLayer();
    checkReadyToCalculate();
  }).catch((err) => {
    console.error('Waypoints load failed', err);
    App.waypointsError = (err && err.message) || String(err);
    updateDataStatus();
  });
}
