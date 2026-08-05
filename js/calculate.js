// The "Calculate Route" pipeline: turns the selected departure, arrival,
// and required stops into a sequence of legs on the internal road network,
// falling back to OSRM (osrm.js) leg-by-leg -- or, if the network can't
// connect the trip at all, for the whole trip -- when needed.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { nearestPointOnLineCoords } from './util.js';
import { findNetworkAnchorCandidates, findClosestGraphNode, runDijkstra, computeRouteAlternatives } from './graph.js';
import { fetchOsrmRoute, attemptOsrmFallback } from './osrm.js';
import { renderCalculatedRoute, selectRouteAlternative } from './render.js';

function snapNode(wp) {
  const pt = [wp.lng, wp.lat];
  const candidates = findNetworkAnchorCandidates(pt, CONFIG.connectorCandidateCount);
  if (!candidates.length) return null;
  const snapped = candidates[0];
  const graphKey = findClosestGraphNode(snapped.coordinates);
  return { wp, snapped, graphKey, connectorDist: snapped.distKm, anchorCandidates: candidates };
}

function buildDistanceMatrix(nodeList) {
  const n = nodeList.length;
  const matrix = [];
  for (let i = 0; i < n; i++) { matrix.push(new Array(n).fill(Infinity)); matrix[i][i] = 0; }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const result = runDijkstra(nodeList[i].graphKey, nodeList[j].graphKey, null);
      matrix[i][j] = result ? (nodeList[i].connectorDist + result.totalDistance + nodeList[j].connectorDist) : Infinity;
    }
  }
  return matrix;
}

function pathLength(order, matrix) {
  let d = 0;
  for (let i = 0; i < order.length - 1; i++) d += matrix[order[i]][order[i + 1]];
  return d;
}

// Open-path ordering with fixed start (index 0) and fixed end (index n-1):
// nearest-neighbor construction, then 2-opt local search on the interior.
function optimizeStopOrder(matrix, n) {
  if (n <= 2) return [0, 1].slice(0, n);
  const middle = [];
  for (let i = 1; i < n - 1; i++) middle.push(i);
  let order = [0];
  let current = 0;
  const remaining = middle.slice();
  while (remaining.length) {
    let best = -1, bestIdx = -1, bestDist = Infinity;
    remaining.forEach((idx, ri) => { if (matrix[current][idx] < bestDist) { bestDist = matrix[current][idx]; best = idx; bestIdx = ri; } });
    order.push(best);
    remaining.splice(bestIdx, 1);
    current = best;
  }
  order.push(n - 1);

  let improved = true, iterations = 0;
  while (improved && iterations < 300) {
    improved = false;
    iterations++;
    for (let a = 1; a < order.length - 2; a++) {
      for (let b = a + 1; b < order.length - 1; b++) {
        const newOrder = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
        if (pathLength(newOrder, matrix) < pathLength(order, matrix) - 1e-9) { order = newOrder; improved = true; }
      }
    }
  }
  return order;
}

function buildRouteSequenceData(res) {
  const items = [];
  let seqIndex = 1, outboundCum = 0;
  const stops = res.orderedStopWaypoints;

  stops.forEach((node, i) => {
    const isFirst = i === 0, isLast = i === stops.length - 1;
    const type = isFirst ? 'Start' : (isLast ? 'Finish' : 'Required Waypoint');

    items.push({
      seq: seqIndex++, type, id: node.wp.id,
      desc: (isFirst ? 'Departure (A): ' : isLast ? 'Arrival (B): ' : 'Required Waypoint: ') + node.wp.name + ' [ID: ' + node.wp.id + ']',
      shortName: node.wp.name, isKissPoint: node.wp.isKissPoint,
      lat: node.wp.lat, lng: node.wp.lng,
      outboundLeg: 0, outboundCum
    });

    if (!isLast) {
      const next = stops[i + 1];
      const legInfo = res._legInfo[i];

      if (node.connectorDist > 0.001) {
        outboundCum += node.connectorDist;
        items.push({ seq: seqIndex++, type: 'Connector', desc: 'Link to Network Line', shortName: 'Link', isKissPoint: false, outboundLeg: node.connectorDist, outboundCum });
      }

      const stopsOnThisLeg = res.detectedWaypoints.filter((dw) => dw._legIndex === i);
      let lastLocationKm = 0;
      stopsOnThisLeg.forEach((dw) => {
        const legDist = dw.locationWithinLeg - lastLocationKm;
        outboundCum += legDist;
        lastLocationKm = dw.locationWithinLeg;
        items.push({
          seq: seqIndex++,
          type: dw.wp.isKissPoint ? 'Kisspoint' : 'Pass-Through Waypoint', id: dw.wp.id,
          desc: 'Waypoint: ' + dw.wp.name + ' [ID: ' + dw.wp.id + ']',
          shortName: dw.wp.name, isKissPoint: dw.wp.isKissPoint,
          lat: dw.wp.lat, lng: dw.wp.lng,
          outboundLeg: legDist, outboundCum
        });
      });

      const remaining = legInfo.pathDist - lastLocationKm;
      if (next.connectorDist > 0.001) {
        outboundCum += remaining + next.connectorDist;
        items.push({ seq: seqIndex++, type: 'Connector', desc: 'Link to Next Waypoint', shortName: 'Link', isKissPoint: false, outboundLeg: (remaining + next.connectorDist), outboundCum });
      } else {
        outboundCum += remaining;
      }
    }
  });

  if (items.length) items[items.length - 1].outboundCum = res.totalDist;

  const totalRouteDist = res.totalDist;
  items.forEach((item) => { item.returnCum = totalRouteDist - item.outboundCum; });
  for (let i = 0; i < items.length; i++) {
    let leg = 0;
    if (i < items.length - 1) leg = items[i + 1].returnCum - items[i].returnCum;
    items[i].returnLeg = Math.abs(leg);
  }

  applyTimingToSequenceData(items, res.avgSpeedKmh, res.kissStopMinutes);
  return items;
}

// Separated from buildRouteSequenceData so timing can be recomputed on its
// own (e.g. when the user tweaks the kisspoint stop duration after already
// calculating) without re-running pathfinding.
//
// A waypoint's own displayed time never includes its own stop -- that
// delay only applies to whatever comes after it. Outbound accumulates
// forward from departure; return accumulates backward from arrival, since
// on the way back the same kisspoints are re-encountered in the opposite
// order.
export function applyTimingToSequenceData(items, avgSpeedKmh, kissStopMinutes) {
  const kissStopHrs = (kissStopMinutes || 0) / 60;

  let outboundStopAccum = 0;
  items.forEach((item) => {
    item.outboundTimeHrs = avgSpeedKmh > 0 ? (item.outboundCum / avgSpeedKmh) + outboundStopAccum : null;
    if (item.isKissPoint) outboundStopAccum += kissStopHrs;
  });

  let returnStopAccum = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].returnTimeHrs = avgSpeedKmh > 0 ? (items[i].returnCum / avgSpeedKmh) + returnStopAccum : null;
    if (items[i].isKissPoint) returnStopAccum += kissStopHrs;
  }
}

// A waypoint's actual position and its snapped point on the network are
// rarely exactly the same spot -- a site set back from the road, or a
// point nowhere near any digitized road at all. That gap used to always be
// drawn as a straight line, fine for a short driveway but visibly wrong
// for anything longer since it cuts across blocks/buildings ignoring the
// street grid. This routes the gap through OSRM instead whenever it's long
// enough to matter, storing the real road geometry as node.connectorCoords
// and replacing the straight-line connectorDist with OSRM's actual road
// distance -- the idea being to stay on our own verified network for as
// much of the trip as possible, and only hand off to a general router for
// the stretch we haven't mapped ourselves. Silently keeps the straight
// line if OSRM can't route the gap either.
//
// Tries every candidate anchor point (not just the geometrically-nearest
// one) over OSRM in parallel and keeps whichever actually yields the
// shortest real-road distance, then updates node.graphKey/snapped to match
// the winning candidate so the internal-network path computed afterwards
// departs from that same improved anchor.
function resolveNodeConnectors(nodeList) {
  return Promise.all(nodeList.map((node) => {
    if (!node || node.connectorDist <= CONFIG.connectorRouteMinKm) return null;
    const candidates = (node.anchorCandidates && node.anchorCandidates.length) ? node.anchorCandidates : [node.snapped];
    return Promise.all(candidates.map((candidate) =>
      fetchOsrmRoute([node.wp.lng, node.wp.lat], candidate.coordinates).then((osrmData) =>
        osrmData ? { candidate, route: osrmData.routes[0] } : null
      )
    )).then((results) => {
      const valid = results.filter(Boolean);
      if (!valid.length) return; // keep the straight line to the nearest candidate
      const best = valid.reduce((a, b) => (b.route.distance < a.route.distance ? b : a));
      node.snapped = best.candidate;
      node.graphKey = findClosestGraphNode(best.candidate.coordinates);
      node.connectorCoords = best.route.geometry.coordinates;
      node.connectorDist = best.route.distance / 1000;
    });
  }));
}

export function runCalculate(depWp, arrWp, requiredStops, toleranceKm, avgSpeedKmh, kissStopMinutes) {
  const waypointsInOrder = [depWp].concat(requiredStops).concat([arrWp]);
  const nodeList = waypointsInOrder.map(snapNode);

  if (nodeList.some((n) => !n || !n.graphKey)) {
    attemptOsrmFallback(waypointsInOrder, toleranceKm, avgSpeedKmh, kissStopMinutes,
      'Route Unreachable', 'One or more selected waypoints could not be snapped to the route network.');
    return Promise.resolve();
  }

  return resolveNodeConnectors(nodeList).then(() => {
    if (nodeList.length === 2) {
      const pathAlternatives = computeRouteAlternatives(nodeList[0].graphKey, nodeList[1].graphKey, CONFIG.maxRouteAlternatives);
      if (pathAlternatives.length === 0) {
        attemptOsrmFallback(waypointsInOrder, toleranceKm, avgSpeedKmh, kissStopMinutes,
          'Route Unreachable', 'No continuous network route found between the selected waypoints.');
        return;
      }
      const routeAlternatives = pathAlternatives.map((networkPath) =>
        buildResultFromSinglePath(nodeList, networkPath, toleranceKm, avgSpeedKmh, kissStopMinutes)
      );
      selectRouteAlternative(routeAlternatives, 0);
      return;
    }

    const distanceMatrix = buildDistanceMatrix(nodeList);
    const order = optimizeStopOrder(distanceMatrix, nodeList.length);

    return buildHybridMultiLegResult(nodeList, order, toleranceKm, avgSpeedKmh, kissStopMinutes).then((res) => {
      if (!res) {
        attemptOsrmFallback(waypointsInOrder, toleranceKm, avgSpeedKmh, kissStopMinutes,
          'Route Unreachable', 'No continuous network route found connecting all selected waypoints, and OSM routing failed for at least one leg.');
        return;
      }
      res.sequenceData = buildRouteSequenceData(res);
      res.routeAlternatives = null;
      App.lastCalculatedRoute = res;
      renderCalculatedRoute(res);
    });
  });
}

// Single A→B leg, reusing a pre-computed Dijkstra path (for route alternatives).
function buildResultFromSinglePath(nodeList, networkPath, toleranceKm, avgSpeedKmh, kissStopMinutes) {
  const a = nodeList[0], b = nodeList[1];
  const routeCoords = [];
  networkPath.edges.forEach((edge, idx) => { if (idx === 0) routeCoords.push(edge.coords[0]); routeCoords.push(edge.coords[1]); });

  const excludeIds = [a.wp.id, b.wp.id];
  const detected = [];
  App.waypoints.forEach((wp) => {
    if (excludeIds.indexOf(wp.id) !== -1 || wp.lng == null) return;
    const snapped = nearestPointOnLineCoords(routeCoords, [wp.lng, wp.lat]);
    if (snapped && snapped.distKm <= toleranceKm) detected.push({ wp, _legIndex: 0, locationWithinLeg: snapped.location, distFromRouteKm: snapped.distKm });
  });
  detected.sort((x, y) => x.locationWithinLeg - y.locationWithinLeg);

  const totalDist = a.connectorDist + networkPath.totalDistance + b.connectorDist;
  const res = {
    nodeList, order: [0, 1], orderedStopWaypoints: [a, b],
    routeCoords, detectedWaypoints: detected, totalDist, avgSpeedKmh, kissStopMinutes,
    _legInfo: [{ startKm: 0, aConnector: a.connectorDist, bConnector: b.connectorDist, pathDist: networkPath.totalDistance }]
  };
  res.sequenceData = buildRouteSequenceData(res);
  return res;
}

// Multi-leg version that also tags each detected waypoint with which leg it
// belongs to (needed by buildRouteSequenceData to place it correctly).
//
// Per-leg hybrid: each consecutive stop-to-stop leg is tried on the
// internal network first; only legs that come back disconnected get routed
// over OSRM instead, one request per failing leg (in parallel). Legs that
// already work internally never touch the network, and a trip with one
// disconnected required stop doesn't throw away the internal route for its
// other, perfectly good legs. Always resolves (never rejects) -- returns
// null only if some leg has neither an internal path nor a usable OSRM
// one, so the caller can fall back to routing the whole trip over OSRM as
// a last resort.
//
// Stop ordering (buildDistanceMatrix/optimizeStopOrder) still runs on
// internal-network distances only, before this function is called -- OSRM
// isn't consulted for ordering, only for patching an already-chosen leg's
// path. A required stop that's genuinely off-network may therefore not
// land in a truly optimal position in the visiting order.
function buildHybridMultiLegResult(nodeList, order, toleranceKm, avgSpeedKmh, kissStopMinutes) {
  const legPlans = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = nodeList[order[i]], b = nodeList[order[i + 1]];
    // Always try the internal network first, even when one end is
    // off-network -- graphKey is always the nearest network node to that
    // point, however far away, so this still gets the leg as close as
    // possible via our own roads. resolveNodeConnectors() (already run
    // before this) bridges the remaining gap to the real waypoint over
    // OSRM. pathResult is null (falling through to whole-leg OSRM below)
    // only when the graph itself is disconnected between a and b.
    legPlans.push({ a, b, pathResult: runDijkstra(a.graphKey, b.graphKey, null) });
  }

  const pendingLegs = legPlans.filter((lp) => !lp.pathResult);
  if (!pendingLegs.length) {
    return Promise.resolve(assembleMultiLegResult(nodeList, order, legPlans, toleranceKm, avgSpeedKmh, kissStopMinutes, false));
  }

  return Promise.all(pendingLegs.map((lp) =>
    fetchOsrmRoute([lp.a.wp.lng, lp.a.wp.lat], [lp.b.wp.lng, lp.b.wp.lat]).then((osrmData) => { lp.osrm = osrmData; })
  )).then(() => {
    if (legPlans.some((lp) => !lp.pathResult && !lp.osrm)) return null;
    return assembleMultiLegResult(nodeList, order, legPlans, toleranceKm, avgSpeedKmh, kissStopMinutes, true);
  });
}

function assembleMultiLegResult(nodeList, order, legPlans, toleranceKm, avgSpeedKmh, kissStopMinutes, isHybrid) {
  let routeCoords = [], totalDist = 0;
  const legInfo = [], detectedWaypoints = [];
  const excludeIds = nodeList.map((n) => n.wp.id);
  let osrmLegCount = 0;

  legPlans.forEach((lp, i) => {
    let legCoords, pathDist, aConnector, bConnector;
    if (lp.pathResult) {
      legCoords = [];
      lp.pathResult.edges.forEach((edge, idx) => { if (idx === 0) legCoords.push(edge.coords[0]); legCoords.push(edge.coords[1]); });
      pathDist = lp.pathResult.totalDistance;
      aConnector = lp.a.connectorDist;
      bConnector = lp.b.connectorDist;
    } else {
      osrmLegCount++;
      const route = lp.osrm.routes[0];
      legCoords = route.geometry.coordinates;
      aConnector = (lp.osrm.waypoints[0].distance || 0) / 1000;
      bConnector = (lp.osrm.waypoints[1].distance || 0) / 1000;
      pathDist = route.distance / 1000;
    }

    App.waypoints.forEach((wp) => {
      if (excludeIds.indexOf(wp.id) !== -1 || wp.lng == null) return;
      const snapped = nearestPointOnLineCoords(legCoords, [wp.lng, wp.lat]);
      if (snapped && snapped.distKm <= toleranceKm) {
        detectedWaypoints.push({ wp, _legIndex: i, locationWithinLeg: snapped.location, distFromRouteKm: snapped.distKm });
      }
    });

    routeCoords = routeCoords.concat(legCoords);
    legInfo.push({ startKm: totalDist, aConnector, bConnector, pathDist });
    totalDist += aConnector + pathDist + bConnector;
  });

  // Must be geographic order (leg, then position within the leg) --
  // buildRouteSequenceData assumes ascending order and derives each leg
  // distance from the delta to the previous stop. Out-of-order entries
  // produce a negative delta, which the table then shows as "-" instead of
  // the real value.
  detectedWaypoints.sort((x, y) => (x._legIndex !== y._legIndex ? x._legIndex - y._legIndex : x.locationWithinLeg - y.locationWithinLeg));

  const orderedStopWaypoints = order.map((idx) => nodeList[idx]);
  const res = {
    nodeList, order, orderedStopWaypoints,
    routeCoords, detectedWaypoints,
    totalDist, avgSpeedKmh, kissStopMinutes, _legInfo: legInfo
  };
  if (isHybrid && osrmLegCount > 0) {
    res.viaOsrm = true;
    res.osrmNote = osrmLegCount + ' of ' + legPlans.length + ' leg(s) routed over OSM roads -- not fully on the internal road network.';
  }
  return res;
}
