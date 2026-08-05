// The three waypoint-search boxes in the sidebar (Departure, Arrival,
// Required Waypoints), plus the tolerance-input validation and the
// calculate-button ready check that both depend on the current selection.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { el, escapeHtml } from './util.js';

// Kisspoints are selectable as departure/arrival/required stops regardless
// of their underlying "type" value, same as Coordination/Base/Site.
function isDepArrSelectable(wp) {
  if (wp.isKissPoint) return true;
  const lowerType = String(wp.type || '').toLowerCase();
  return CONFIG.depArrTypes.some((t) => String(t).toLowerCase() === lowerType);
}

// Kisspoint status takes priority over the raw "type" value for grouping --
// a kisspoint always lands in its own "Kisspoint" bucket rather than
// whatever type it happens to carry (e.g. Site).
function comboGroupLabel(wp) {
  return wp.isKissPoint ? 'Kisspoint' : (wp.type || 'Other');
}

// Fixed display order rather than alphabetical, since "Base" would
// otherwise sort before "Coordination".
const COMBO_GROUP_ORDER = ['coordination', 'base', 'kisspoint', 'site'];
function comboGroupPriority(label) {
  const idx = COMBO_GROUP_ORDER.indexOf(String(label || '').toLowerCase());
  return idx === -1 ? COMBO_GROUP_ORDER.length : idx;
}

function renderComboList(listNode, searchText, excludeIds, onSelect) {
  const lowerSearch = String(searchText || '').trim().toLowerCase();
  let candidates = App.waypoints.filter(isDepArrSelectable).filter((wp) => excludeIds.indexOf(wp.id) === -1);
  if (lowerSearch) candidates = candidates.filter((wp) => String(wp.name || '').toLowerCase().indexOf(lowerSearch) !== -1);
  candidates = candidates.slice().sort((a, b) => {
    const ga = comboGroupLabel(a), gb = comboGroupLabel(b);
    const pa = comboGroupPriority(ga), pb = comboGroupPriority(gb);
    if (pa !== pb) return pa - pb;
    if (ga !== gb) return ga.localeCompare(gb);
    return String(a.name).localeCompare(String(b.name));
  });
  candidates = candidates.slice(0, 50);

  listNode.innerHTML = '';
  if (candidates.length === 0) {
    listNode.innerHTML = '<div class="combo-empty">No matching waypoints</div>';
  } else {
    let lastGroup = null;
    candidates.forEach((wp) => {
      const group = comboGroupLabel(wp);
      if (group !== lastGroup) {
        lastGroup = group;
        const header = document.createElement('div');
        header.className = 'combo-group-header';
        header.textContent = group;
        listNode.appendChild(header);
      }
      const item = document.createElement('div');
      item.className = 'combo-item';
      item.innerHTML = '<span>' + escapeHtml(wp.name) + '</span>';
      item.addEventListener('click', (evt) => {
        evt.stopPropagation();
        onSelect(wp);
        listNode.classList.remove('open');
      });
      listNode.appendChild(item);
    });
  }
  listNode.classList.add('open');
}

function currentExcludedIds() {
  const ids = App.requiredStops.map((w) => w.id);
  if (App.selectedDepWp) ids.push(App.selectedDepWp.id);
  if (App.selectedArrWp) ids.push(App.selectedArrWp.id);
  return ids;
}

export function renderRequiredChips() {
  const container = el('req-chips');
  container.innerHTML = '';
  App.requiredStops.forEach((wp, idx) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = '<span>' + escapeHtml(wp.name) + '</span>';
    const x = document.createElement('div');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => {
      App.requiredStops.splice(idx, 1);
      renderRequiredChips();
      checkReadyToCalculate();
    });
    chip.appendChild(x);
    container.appendChild(chip);
  });
}

export function setupCombos() {
  const depInput = el('dep-input'), depList = el('dep-list');
  const arrInput = el('arr-input'), arrList = el('arr-list');
  const reqInput = el('req-input'), reqList = el('req-list');

  function openDep() {
    renderComboList(depList, depInput.value, currentExcludedIds(), (wp) => {
      App.selectedDepWp = wp;
      depInput.value = wp.name;
      checkReadyToCalculate();
    });
  }
  function openArr() {
    renderComboList(arrList, arrInput.value, currentExcludedIds(), (wp) => {
      App.selectedArrWp = wp;
      arrInput.value = wp.name;
      checkReadyToCalculate();
    });
  }
  function openReq() {
    renderComboList(reqList, reqInput.value, currentExcludedIds(), (wp) => {
      App.requiredStops.push(wp);
      reqInput.value = '';
      renderRequiredChips();
      checkReadyToCalculate();
    });
  }

  depInput.addEventListener('click', (e) => { e.stopPropagation(); openDep(); });
  depInput.addEventListener('keyup', openDep);
  arrInput.addEventListener('click', (e) => { e.stopPropagation(); openArr(); });
  arrInput.addEventListener('keyup', openArr);
  reqInput.addEventListener('click', (e) => { e.stopPropagation(); openReq(); });
  reqInput.addEventListener('keyup', openReq);

  document.body.addEventListener('click', () => {
    depList.classList.remove('open');
    arrList.classList.remove('open');
    reqList.classList.remove('open');
  });
}

export function validateTolerance() {
  const min = CONFIG.toleranceMinMeters, max = CONFIG.toleranceMaxMeters;
  const input = el('tolerance-input');
  let val = parseFloat(input.value);
  if (!isFinite(val)) val = CONFIG.defaultToleranceMeters;
  const clamped = Math.min(Math.max(val, min), max);
  const hint = el('tolerance-hint');
  if (clamped !== val) {
    input.value = clamped;
    hint.textContent = 'Clamped to valid range (' + min + '-' + max + 'm).';
    hint.classList.add('warn');
  } else {
    hint.textContent = '';
    hint.classList.remove('warn');
  }
  return clamped;
}

export function checkReadyToCalculate() {
  const ready = App.routesReady && App.waypointsReady && App.selectedDepWp && App.selectedArrWp && App.selectedDepWp.id !== App.selectedArrWp.id;
  el('calc-btn').disabled = !ready;
}
