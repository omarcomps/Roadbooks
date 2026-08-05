// Add / edit / move / delete a single waypoint: the popup form itself, and
// the ArcGIS FeatureLayer calls that write those changes back to the
// Waypoints layer. Also owns the "Lock/Unlock Data Editing" toggle, since
// that's what gates whether any of this UI is reachable at all.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { el, escapeHtml, roundCoord, formatCoords, describeApplyEditsError, showToast } from './util.js';
import { snapLatLngToRoute } from './graph.js';
import { leafletIcon, dimBaseMarker, hideBaseMarker, setAddingMode, setNetworkLineDimmed, renderBaseWaypointsLayer } from './map.js';

// Add Waypoint can't snap to the route network until the routes layer has
// finished loading, so gate the button on both layers instead of just
// waypoints -- otherwise a click made right after waypoints (usually the
// faster of the two) load places a point with no network to snap onto.
// Locking data editing disables it outright regardless of load state.
export function updateAddWaypointButtonState() {
  el('add-wp-btn').disabled = App.editingLocked || !(App.routesReady && App.waypointsReady);
  // Both layers loaded successfully -- the ArcGIS loader is evidently
  // healthy, so a future crash should be allowed to trigger its own
  // recovery reload instead of being silently ignored because of one that
  // already happened (and was already recovered from) earlier.
  if (App.routesReady && App.waypointsReady) sessionStorage.removeItem('rb_loaderCrashReload');
}

export function setEditingLocked(locked) {
  App.editingLocked = locked;
  const btn = el('lock-edit-btn');
  btn.textContent = locked ? 'Unlock Data Editing' : 'Lock Data Editing';
  btn.className = locked ? 'btn danger block' : 'btn secondary block';
  if (locked && App.isAddingWaypoint) setAddingMode(false);
  updateAddWaypointButtonState();
  setNetworkLineDimmed(!!App.lastCalculatedRoute);
}

function knownTypeList() {
  const seen = [], out = [];
  App.waypoints.forEach((wp) => { if (wp.type && seen.indexOf(wp.type) === -1) { seen.push(wp.type); out.push(wp.type); } });
  return out;
}

function coverageSelectHtml(cls, label, value) {
  const options = CONFIG.cellularCoverageOptions.map((opt) =>
    '<option value="' + escapeHtml(opt) + '"' + (opt === value ? ' selected' : '') + '>' + escapeHtml(opt) + '</option>'
  ).join('');
  return '<label>' + label + '</label><select class="' + cls + '"><option value="">Unknown</option>' + options + '</select>';
}

function buildWaypointForm(opts) {
  const form = document.createElement('div');
  form.className = 'popup-form';
  const uid = 'f' + Date.now() + Math.floor(Math.random() * 1000);

  form.innerHTML =
    '<label>Name</label><input type="text" class="f-name" placeholder="Waypoint name" />' +
    '<label>Type</label><input type="text" class="f-type" list="dl-' + uid + '" placeholder="e.g. Coordination, Site..." />' +
    '<datalist id="dl-' + uid + '"></datalist>' +
    coverageSelectHtml('f-mtn', 'MTN Coverage', opts.mtnCoverage) +
    coverageSelectHtml('f-syriatel', 'Syriatel Coverage', opts.syriatelCoverage) +
    coverageSelectHtml('f-rcell', 'RCell Coverage', opts.rcellCoverage) +
    '<div class="check"><input type="checkbox" class="f-kiss" id="kiss-' + uid + '"/><label for="kiss-' + uid + '" style="margin:0;text-transform:none;font-size:11.5px;">Kisspoint</label></div>' +
    '<div class="f-coords" style="font-size:10px;color:#94a3b8;margin-top:8px;"></div>' +
    '<div class="error"></div>' +
    '<div class="btn-row"></div>';

  const nameInput = form.querySelector('.f-name'), typeInput = form.querySelector('.f-type'), kissCheck = form.querySelector('.f-kiss');
  const mtnSelect = form.querySelector('.f-mtn'), syriatelSelect = form.querySelector('.f-syriatel'), rcellSelect = form.querySelector('.f-rcell');
  const datalist = form.querySelector('datalist');
  knownTypeList().forEach((t) => { const o = document.createElement('option'); o.value = t; datalist.appendChild(o); });

  nameInput.value = opts.name || '';
  typeInput.value = opts.type || '';
  kissCheck.checked = !!opts.isKiss;

  const errorNode = form.querySelector('.error');
  const btnRow = form.querySelector('.btn-row');

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn primary sm';
  saveBtn.textContent = opts.saveLabel || 'Save';
  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { errorNode.textContent = 'Name is required.'; return; }
    const coverage = { mtn: mtnSelect.value, syriatel: syriatelSelect.value, rcell: rcellSelect.value };
    // The save itself runs in the background (see openAddWaypointForm /
    // openEditWaypointForm below) -- the popup closes immediately instead
    // of waiting on the network, and a toast reports success or failure
    // once it's done.
    opts.onSave(name, typeInput.value.trim(), kissCheck.checked, coverage);
  });
  btnRow.appendChild(saveBtn);

  if (opts.onDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger sm';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (!window.confirm('Delete waypoint "' + opts.name + '"? This cannot be undone.')) return;
      opts.onDelete();
    });
    btnRow.appendChild(delBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn secondary sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { opts.onCancel && opts.onCancel(); });
  btnRow.appendChild(cancelBtn);

  return form;
}

export function openAddWaypointForm(latlng) {
  const initialSnap = snapLatLngToRoute(latlng);
  const marker = L.marker(initialSnap || latlng, { icon: leafletIcon('new'), draggable: true }).addTo(App.map);
  App.pendingMarker = marker;

  const form = buildWaypointForm({
    saveLabel: 'Save',
    // Closes the popup and clears the pending marker right away instead of
    // waiting on the network -- the app stays usable while the save
    // happens in the background, and a toast (from saveNewWaypoint itself)
    // reports success or failure once it lands.
    onSave: (name, type, isKiss, coverage) => {
      const savedLatLng = marker.getLatLng();
      App.pendingMarker = null;
      marker.closePopup();
      App.map.removeLayer(marker);
      setAddingMode(false);
      showToast('Saving waypoint "' + name + '"…', false);
      saveNewWaypoint(savedLatLng, name, type, isKiss, coverage).catch(() => { /* already toasted by saveNewWaypoint */ });
    },
    onCancel: () => { marker.closePopup(); }
  });

  const coordsEl = form.querySelector('.f-coords');
  function updateCoordsDisplay(snapped) {
    const ll = marker.getLatLng();
    coordsEl.textContent = formatCoords(ll.lat, ll.lng) + (snapped ? ' · snapped to route' : '');
  }
  updateCoordsDisplay(!!initialSnap);

  marker.on('drag', () => updateCoordsDisplay(false));
  marker.on('dragend', () => {
    const snapped = snapLatLngToRoute(marker.getLatLng());
    if (snapped) marker.setLatLng(snapped);
    updateCoordsDisplay(!!snapped);
  });

  marker.bindPopup(form, { closeOnClick: false, minWidth: 230 }).openPopup();
  marker.on('popupclose', () => { if (App.pendingMarker === marker) { App.map.removeLayer(marker); App.pendingMarker = null; } });
}

export function openEditWaypointForm(wp, circleMarker) {
  // Hide the static base-layer dot while editing so the visible, draggable
  // pin below is the only thing on screen at this location -- otherwise
  // the dot stays put while the drag pin moves, which looks like a glitch.
  hideBaseMarker(circleMarker);
  const marker = L.marker([wp.lat, wp.lng], { icon: leafletIcon('edit'), draggable: true }).addTo(App.map);

  const form = buildWaypointForm({
    name: wp.name, type: wp.type, isKiss: wp.isKissPoint,
    mtnCoverage: wp.mtnCoverage, syriatelCoverage: wp.syriatelCoverage, rcellCoverage: wp.rcellCoverage,
    saveLabel: 'Save Changes',
    // Same background pattern as adding: close immediately, keep working,
    // let the toast (from updateWaypoint/deleteWaypoint) report the
    // outcome. Only re-render the base layer once the server confirms the
    // change, so a failure doesn't show stale/optimistic data.
    onSave: (name, type, isKiss, coverage) => {
      const latlng = marker.getLatLng();
      circleMarker.closePopup();
      App.map.removeLayer(marker);
      dimBaseMarker(circleMarker, false);
      showToast('Saving changes to "' + name + '"…', false);
      updateWaypoint(wp, name, type, isKiss, latlng, coverage).then(() => {
        renderBaseWaypointsLayer();
      }).catch(() => { /* already toasted by updateWaypoint */ });
    },
    onDelete: () => {
      circleMarker.closePopup();
      App.map.removeLayer(marker);
      dimBaseMarker(circleMarker, false);
      showToast('Deleting waypoint "' + wp.name + '"…', false);
      deleteWaypoint(wp).then(() => {
        renderBaseWaypointsLayer();
      }).catch(() => { /* already toasted by deleteWaypoint */ });
    },
    onCancel: () => { circleMarker.closePopup(); App.map.removeLayer(marker); }
  });

  const coordsEl = form.querySelector('.f-coords');
  function updateCoordsDisplay(snapped) {
    const ll = marker.getLatLng();
    coordsEl.textContent = formatCoords(ll.lat, ll.lng) + (snapped ? ' · snapped to route' : '');
  }
  updateCoordsDisplay(false);

  marker.on('drag', () => updateCoordsDisplay(false));
  marker.on('dragend', () => {
    const snapped = snapLatLngToRoute(marker.getLatLng());
    if (snapped) marker.setLatLng(snapped);
    updateCoordsDisplay(!!snapped);
  });

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:10px;color:#94a3b8;margin-top:6px;';
  hint.textContent = 'Drag the pin on the map to move this waypoint.';
  form.appendChild(hint);

  circleMarker.bindPopup(form, { closeOnClick: false, minWidth: 230 }).openPopup();
  circleMarker.on('popupclose', () => { App.map.removeLayer(marker); dimBaseMarker(circleMarker, false); });
}

// Both of these are memoized as a single shared in-flight Promise rather
// than re-invoked per call. AMD's require() has to dynamically inject a
// <script> tag the first time a module is loaded, and if two add/update/
// delete calls overlapped (e.g. a save keeps running in the background
// after its popup already closed, and the user starts a second edit before
// the first finishes loading these modules), Dojo's loader could crash
// with "insertBefore ... parentNode is null" while injecting the same
// script twice concurrently -- seen in the wild as a waypoint save
// silently failing with no toast at all, because the crash happens inside
// require() itself, before this code ever runs. Caching the promise means
// require() only fires once; every later call reuses the already-resolved
// (or still in-flight) result.
let esriEditClassesPromise = null;
function getEsriEditClasses() {
  if (!esriEditClassesPromise) {
    esriEditClassesPromise = new Promise((resolve) => {
      require(['esri/graphic', 'esri/geometry/Point', 'esri/SpatialReference'], (Graphic, EsriPoint, SpatialReference) => {
        resolve({ Graphic, EsriPoint, SpatialReference });
      });
    });
  }
  return esriEditClassesPromise;
}

let waypointsEditLayerPromise = null;
function getWaypointsEditLayer() {
  if (waypointsEditLayerPromise) return waypointsEditLayerPromise;
  waypointsEditLayerPromise = new Promise((resolve, reject) => {
    require(['esri/layers/FeatureLayer'], (FeatureLayer) => {
      console.log('RouteEngine: constructing edit FeatureLayer for', CONFIG.waypointsLayerUrl);
      const layerRef = new FeatureLayer(CONFIG.waypointsLayerUrl, { mode: FeatureLayer.MODE_ONDEMAND });
      App.waypointsEditLayer = layerRef;
      if (layerRef.loaded) { resolve(layerRef); return; }

      let settled = false;
      // Safety net: layer.on('load'/'error') has never been exercised
      // successfully before this feature existed. If either event fails to
      // fire for any reason, this timeout still surfaces a clear error
      // instead of leaving "Saving waypoint..." spinning forever.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        waypointsEditLayerPromise = null;
        console.error('RouteEngine: timed out waiting for Waypoints edit layer to load', layerRef);
        reject(new Error('Timed out waiting for the Waypoints layer to load (15s). Check your connection, that you are signed in, and the browser console for details.'));
      }, 15000);

      layerRef.on('load', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        console.log('RouteEngine: edit FeatureLayer loaded', layerRef);
        resolve(layerRef);
      });
      layerRef.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        waypointsEditLayerPromise = null;
        console.error('RouteEngine: edit FeatureLayer failed to load', err);
        reject((err && err.error) || err || new Error('Waypoints layer failed to load.'));
      });
    });
  });
  return waypointsEditLayerPromise;
}

// Confirmed by testing: including latitude/longitude in the INSERT itself
// reliably fails with "latitude and longitude must be decimal number", but
// the same fields write fine through a follow-up UPDATE. So the point is
// created first without them, then immediately updated with just those two
// fields. If that follow-up update fails for any reason, the waypoint
// still exists (just without lat/lng populated) -- reported as a warning
// rather than losing the add.
function saveNewWaypoint(latlng, name, type, isKiss, coverage) {
  return new Promise((resolve, reject) => {
    getEsriEditClasses().then(({ Graphic, EsriPoint, SpatialReference }) => {
      getWaypointsEditLayer().then((layer) => {
        const fields = CONFIG.waypointFields;
        const roundedLat = roundCoord(latlng.lat), roundedLng = roundCoord(latlng.lng);
        const attrs = {};
        attrs[fields.nameField] = name;
        attrs[fields.typeField] = type || '';
        attrs[fields.kissPointField] = isKiss ? CONFIG.kissPointWriteTrueValue : CONFIG.kissPointWriteFalseValue;
        // Coded-value domains on these fields reject an empty string as an
        // out-of-domain value (and fail the whole edit) -- null is what
        // "no selection" has to mean instead.
        attrs[fields.mtnField] = coverage.mtn || null;
        attrs[fields.syriatelField] = coverage.syriatel || null;
        attrs[fields.rcellField] = coverage.rcell || null;
        const geometry = new EsriPoint(roundedLng, roundedLat, new SpatialReference({ wkid: 4326 }));
        const graphic = new Graphic(geometry, null, attrs);

        layer.applyEdits([graphic], null, null, (addResults) => {
          const result = addResults && addResults[0];
          if (!result || !result.success) {
            const msg = describeApplyEditsError(result, 'Server rejected the edit.');
            showToast('Failed to save waypoint: ' + msg, true);
            reject(new Error(msg));
            return;
          }
          const newWp = {
            id: result.objectId, name, type: type || '', isKissPoint: isKiss,
            mtnCoverage: coverage.mtn || '', syriatelCoverage: coverage.syriatel || '', rcellCoverage: coverage.rcell || '',
            lng: roundedLng, lat: roundedLat
          };
          App.waypoints.push(newWp);
          renderBaseWaypointsLayer();

          const latLngAttrs = {};
          latLngAttrs[fields.idField] = result.objectId;
          latLngAttrs[fields.latField] = roundedLat;
          latLngAttrs[fields.lngField] = roundedLng;
          const latLngGraphic = new Graphic(geometry, null, latLngAttrs);
          layer.applyEdits(null, [latLngGraphic], null, (r, updateResults) => {
            const updResult = updateResults && updateResults[0];
            if (!updResult || !updResult.success) {
              const updMsg = describeApplyEditsError(updResult, 'coordinates could not be written');
              showToast('Waypoint "' + name + '" saved, but ' + updMsg, true);
            } else {
              showToast('Waypoint "' + name + '" saved.', false);
            }
            resolve(newWp);
          }, (err) => {
            showToast('Waypoint "' + name + '" saved, but coordinates could not be written: ' + (err.message || err), true);
            resolve(newWp);
          });
        }, (err) => { showToast('Failed to save waypoint: ' + (err.message || err), true); reject(err); });
      }, (err) => { showToast('Could not reach Waypoints layer: ' + (err.message || err), true); reject(err); });
    });
  });
}

function updateWaypoint(wp, name, type, isKiss, latlng, coverage) {
  return new Promise((resolve, reject) => {
    getEsriEditClasses().then(({ Graphic, EsriPoint, SpatialReference }) => {
      getWaypointsEditLayer().then((layer) => {
        const fields = CONFIG.waypointFields;
        const attrs = {};
        attrs[fields.idField] = wp.id;
        attrs[fields.nameField] = name;
        attrs[fields.typeField] = type || '';
        attrs[fields.kissPointField] = isKiss ? CONFIG.kissPointWriteTrueValue : CONFIG.kissPointWriteFalseValue;
        attrs[fields.mtnField] = coverage.mtn || null;
        attrs[fields.syriatelField] = coverage.syriatel || null;
        attrs[fields.rcellField] = coverage.rcell || null;
        const roundedLat = roundCoord(latlng.lat), roundedLng = roundCoord(latlng.lng);
        attrs[fields.latField] = roundedLat;
        attrs[fields.lngField] = roundedLng;
        const geometry = new EsriPoint(roundedLng, roundedLat, new SpatialReference({ wkid: 4326 }));
        const graphic = new Graphic(geometry, null, attrs);

        layer.applyEdits(null, [graphic], null, (r, updateResults) => {
          const result = updateResults && updateResults[0];
          if (!result || !result.success) {
            const msg = describeApplyEditsError(result, 'Server rejected the update.');
            showToast('Update failed: ' + msg, true);
            reject(new Error(msg));
            return;
          }
          wp.name = name; wp.type = type || ''; wp.isKissPoint = isKiss;
          wp.mtnCoverage = coverage.mtn || ''; wp.syriatelCoverage = coverage.syriatel || ''; wp.rcellCoverage = coverage.rcell || '';
          wp.lng = roundedLng; wp.lat = roundedLat;
          showToast('Waypoint "' + name + '" updated.', false);
          resolve(wp);
        }, (err) => { showToast('Update failed: ' + (err.message || err), true); reject(err); });
      }, (err) => { reject(err); });
    });
  });
}

function deleteWaypoint(wp) {
  return new Promise((resolve, reject) => {
    getEsriEditClasses().then(({ Graphic, EsriPoint, SpatialReference }) => {
      getWaypointsEditLayer().then((layer) => {
        const fields = CONFIG.waypointFields;
        const attrs = {};
        attrs[fields.idField] = wp.id;
        const geometry = new EsriPoint(wp.lng, wp.lat, new SpatialReference({ wkid: 4326 }));
        const graphic = new Graphic(geometry, null, attrs);

        layer.applyEdits(null, null, [graphic], (r, u, deleteResults) => {
          const result = deleteResults && deleteResults[0];
          if (!result || !result.success) {
            const msg = describeApplyEditsError(result, 'Server rejected the delete.');
            showToast('Delete failed: ' + msg, true);
            reject(new Error(msg));
            return;
          }
          App.waypoints = App.waypoints.filter((w) => w.id !== wp.id);
          showToast('Waypoint "' + wp.name + '" deleted.', false);
          resolve();
        }, (err) => { showToast('Delete failed: ' + (err.message || err), true); reject(err); });
      }, (err) => { reject(err); });
    });
  });
}
