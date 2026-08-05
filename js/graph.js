// Builds a routable graph out of the raw road-segment features from the
// Routes layer, and finds paths through it. This is what "Calculate Route"
// runs on before ever touching OSRM -- OSRM (osrm.js) only comes in as a
// fallback for the parts of a trip this graph can't connect.

import { App } from './state.js';
import { CONFIG } from './config.js';
import { haversineKm, projectPointOnSegment, edgeId, MinHeap } from './util.js';

function pickRoadName(attrs) {
  const candidates = CONFIG.routeNameFields;
  for (let i = 0; i < candidates.length; i++) if (attrs[candidates[i]]) return attrs[candidates[i]];
  return 'Corridor';
}

export function buildGraphFromRouteFeatures(features) {
  const nodes = {}, adj = {}, segments = [];
  function getNodeKey(c) { return c[0].toFixed(6) + ',' + c[1].toFixed(6); }
  function addNode(k, c) { if (!nodes[k]) { nodes[k] = c; adj[k] = []; } }
  function addEdge(k1, k2, dist, road, seg) {
    adj[k1].push({ to: k2, dist, road, coords: seg });
    adj[k2].push({ to: k1, dist, road, coords: [seg[1], seg[0]] });
  }

  features.forEach((f) => {
    const paths = f.geometry && f.geometry.paths;
    if (!paths) return;
    const road = pickRoadName(f.attributes || {});
    paths.forEach((coords) => {
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i], p2 = coords[i + 1];
        const k1 = getNodeKey(p1), k2 = getNodeKey(p2);
        addNode(k1, p1);
        addNode(k2, p2);
        const d = haversineKm(p1[0], p1[1], p2[0], p2[1]);
        addEdge(k1, k2, d, road, [p1, p2]);
        segments.push([p1, p2]);
      }
    });
  });

  App.networkGraph = { nodes, adj };
  App.routeCoordSegments = segments;
  mergeNearbyGraphNodes();
  buildNodeGrid();
}

// Digitized road segments rarely share exact endpoint coordinates even
// where two stretches of road genuinely meet, which leaves the graph full
// of dead-end (degree-1) nodes a few centimeters to a few meters apart.
// This snaps each dead end onto its nearest neighbor within tolerance so
// the graph is actually connected across those seams.
function mergeNearbyGraphNodes() {
  const SNAP_TOLERANCE_KM = 0.1;
  const { nodes, adj } = App.networkGraph;
  const keys = Object.keys(nodes);
  if (keys.length === 0) return;
  const degree1Keys = keys.filter((k) => (adj[k] || []).length === 1);
  if (degree1Keys.length === 0) return;

  const cellDeg = 0.01, grid = {};
  keys.forEach((key) => {
    const [lng, lat] = nodes[key];
    const ck = Math.floor(lng / cellDeg) + ',' + Math.floor(lat / cellDeg);
    (grid[ck] = grid[ck] || []).push(key);
  });

  const parent = {};
  keys.forEach((k) => { parent[k] = k; });
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  degree1Keys.forEach((key) => {
    const [lng, lat] = nodes[key];
    const cx = Math.floor(lng / cellDeg), cy = Math.floor(lat / cellDeg);
    let bestKey = null, bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid[(cx + dx) + ',' + (cy + dy)];
      if (!bucket) continue;
      bucket.forEach((otherKey) => {
        if (otherKey === key) return;
        const d = haversineKm(lng, lat, nodes[otherKey][0], nodes[otherKey][1]);
        if (d < bestDist) { bestDist = d; bestKey = otherKey; }
      });
    }
    if (bestKey && bestDist <= SNAP_TOLERANCE_KM) union(key, bestKey);
  });

  const mergedNodes = {}, mergedAdj = {};
  keys.forEach((key) => {
    const root = find(key);
    if (!mergedNodes[root]) { mergedNodes[root] = nodes[root]; mergedAdj[root] = []; }
  });
  keys.forEach((key) => {
    const root = find(key);
    (adj[key] || []).forEach((edge) => {
      const toRoot = find(edge.to);
      if (toRoot === root) return;
      mergedAdj[root].push({ to: toRoot, dist: edge.dist, road: edge.road, coords: edge.coords });
    });
  });
  App.networkGraph = { nodes: mergedNodes, adj: mergedAdj };
}

// Coarse spatial index over graph nodes, used by findClosestGraphNode to
// avoid scanning every node in the network on every lookup.
function buildNodeGrid() {
  const GRID = App.gridCellDeg;
  const { nodes } = App.networkGraph;
  const grid = {};
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
  Object.keys(nodes).forEach((key) => {
    const [lng, lat] = nodes[key];
    const cx = Math.floor(lng / GRID), cy = Math.floor(lat / GRID);
    const ck = cx + ',' + cy;
    (grid[ck] = grid[ck] || []).push(key);
    if (cx < minCx) minCx = cx; if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy; if (cy > maxCy) maxCy = cy;
  });
  App.nodeGrid = grid;
  const keyCount = Object.keys(grid).length;
  App.nodeGridMaxRadius = keyCount > 0 ? Math.max(maxCx - minCx, maxCy - minCy, 0) + 1 : 0;
}

export function findClosestGraphNode(targetCoord) {
  if (!App.nodeGrid) return null;
  const { nodes } = App.networkGraph;
  const grid = App.nodeGrid, GRID = App.gridCellDeg;
  const [lng, lat] = targetCoord;
  const cx = Math.floor(lng / GRID), cy = Math.floor(lat / GRID);
  let minVal = Infinity, closestKey = null;

  function scanRing(radius) {
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      const bucket = grid[(cx + dx) + ',' + (cy + dy)];
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const key = bucket[i];
        const d = haversineKm(lng, lat, nodes[key][0], nodes[key][1]);
        if (d < minVal) { minVal = d; closestKey = key; }
      }
    }
  }

  let radius = 0, foundAt = -1;
  while (radius <= App.nodeGridMaxRadius) {
    scanRing(radius);
    if (closestKey !== null && foundAt === -1) foundAt = radius;
    if (foundAt !== -1 && radius >= foundAt + 1) break;
    radius++;
  }
  return closestKey;
}

// edgePenalty lets computeRouteAlternatives() discourage reusing edges
// from an already-found path, without permanently removing them.
export function runDijkstra(startKey, targetKey, edgePenalty) {
  const graph = App.networkGraph;
  const costs = {}, previous = {}, visited = {};
  costs[startKey] = 0;
  const heap = new MinHeap();
  heap.push(0, startKey);

  while (heap.size() > 0) {
    const [cost, current] = heap.pop();
    if (visited[current]) continue;
    visited[current] = true;
    if (current === targetKey) break;
    const edges = graph.adj[current] || [];
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (visited[edge.to]) continue;
      const penalty = edgePenalty ? (edgePenalty[edgeId(current, edge.to)] || 1) : 1;
      const altCost = cost + edge.dist * penalty;
      if (altCost < (costs[edge.to] === undefined ? Infinity : costs[edge.to])) {
        costs[edge.to] = altCost;
        previous[edge.to] = { from: current, road: edge.road, coords: edge.coords, dist: edge.dist };
        heap.push(altCost, edge.to);
      }
    }
  }

  if (costs[targetKey] === undefined) return null;
  const pathEdges = [], nodeKeys = [targetKey];
  let curr = targetKey, realDistance = 0;
  while (previous[curr] !== undefined && previous[curr] !== null) {
    pathEdges.unshift(previous[curr]);
    realDistance += previous[curr].dist;
    curr = previous[curr].from;
    nodeKeys.unshift(curr);
  }
  return { totalDistance: realDistance, edges: pathEdges, nodeKeys };
}

function edgeOverlapRatio(pathA, pathB) {
  const setA = {};
  let sizeA = 0;
  for (let i = 0; i < pathA.nodeKeys.length - 1; i++) { setA[edgeId(pathA.nodeKeys[i], pathA.nodeKeys[i + 1])] = true; sizeA++; }
  let shared = 0;
  const sizeB = pathB.nodeKeys.length - 1;
  for (let j = 0; j < sizeB; j++) if (setA[edgeId(pathB.nodeKeys[j], pathB.nodeKeys[j + 1])]) shared++;
  const minLen = Math.min(sizeA, sizeB);
  return minLen === 0 ? 1 : shared / minLen;
}

// Finds up to maxAlternatives distinct paths: the shortest one, then
// repeatedly re-runs Dijkstra with a heavy penalty on edges already used,
// keeping only candidates that don't mostly retrace a path already found.
export function computeRouteAlternatives(startKey, targetKey, maxAlternatives) {
  const primary = runDijkstra(startKey, targetKey, null);
  if (!primary) return [];
  const results = [primary];
  const penalty = {};

  function applyPenalty(path, factor) {
    for (let i = 0; i < path.nodeKeys.length - 1; i++) {
      const id = edgeId(path.nodeKeys[i], path.nodeKeys[i + 1]);
      penalty[id] = (penalty[id] || 1) * factor;
    }
  }

  applyPenalty(primary, 6);
  for (let i = 1; i < maxAlternatives; i++) {
    const candidate = runDijkstra(startKey, targetKey, penalty);
    if (!candidate) break;
    const isDup = results.some((r) => edgeOverlapRatio(r, candidate) > 0.85);
    if (!isDup) results.push(candidate);
    applyPenalty(candidate, 6);
  }
  results.sort((a, b) => a.totalDistance - b.totalDistance);
  return results;
}

function snapPointToNetwork(pt) {
  let best = null;
  const segments = App.routeCoordSegments;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const proj = projectPointOnSegment(seg[0], seg[1], pt);
    const d = haversineKm(pt[0], pt[1], proj.point[0], proj.point[1]);
    if (!best || d < best.distKm) best = { coordinates: proj.point, distKm: d };
  }
  return best;
}

// The single geometrically-nearest network point isn't always the one that
// leads to the shortest real-road connector -- it might sit on a stretch
// with no direct street to the waypoint, forcing OSRM into a long detour,
// while a slightly further point on a different stretch has a near-direct
// street straight to it. Returns several distinct nearby candidates
// (skipping ones essentially on top of an already-picked one) so
// resolveNodeConnectors() in calculate.js can try each over OSRM and keep
// whichever actually produces the shortest real-road distance.
export function findNetworkAnchorCandidates(pt, maxCandidates) {
  const segments = App.routeCoordSegments;
  const all = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const proj = projectPointOnSegment(seg[0], seg[1], pt);
    const d = haversineKm(pt[0], pt[1], proj.point[0], proj.point[1]);
    all.push({ coordinates: proj.point, distKm: d });
  }
  all.sort((a, b) => a.distKm - b.distKm);
  const picked = [];
  for (let j = 0; j < all.length && picked.length < maxCandidates; j++) {
    const c = all[j];
    const tooClose = picked.some((p) => haversineKm(p.coordinates[0], p.coordinates[1], c.coordinates[0], c.coordinates[1]) < 0.05);
    if (!tooClose) picked.push(c);
  }
  return picked;
}

// Used when placing/dragging a waypoint marker: snaps it onto the nearest
// point on the route network only when that point is genuinely close
// (CONFIG.snapToRouteMaxMeters) -- otherwise the point stays exactly where
// it was placed, so off-network locations can still be added.
export function snapLatLngToRoute(latlng) {
  if (!App.routeCoordSegments || !App.routeCoordSegments.length) return null;
  const snapped = snapPointToNetwork([latlng.lng, latlng.lat]);
  if (!snapped) return null;
  if (snapped.distKm > CONFIG.snapToRouteMaxMeters / 1000) return null;
  return L.latLng(snapped.coordinates[1], snapped.coordinates[0]);
}
