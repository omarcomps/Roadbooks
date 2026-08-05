// Single mutable object holding everything the app needs to remember
// between renders: loaded data, the current selection, the route just
// calculated, and references to the live map layers. Every module reads
// and writes through this same object rather than keeping its own copy.

export const App = {
  // Loaded from the portal
  waypoints: [],
  networkGraph: { nodes: {}, adj: {} },
  routeCoordSegments: [],
  nodeGrid: null,
  nodeGridMaxRadius: 0,
  gridCellDeg: 0.02,

  routesReady: false,
  waypointsReady: false,
  routesError: null,
  waypointsError: null,
  routesFeatureCount: null,
  waypointsFeatureCount: null,

  // Current form selection
  selectedDepWp: null,
  selectedArrWp: null,
  requiredStops: [],

  // Last successful calculation
  lastCalculatedRoute: null,

  // Leaflet
  map: null,
  baseTileLayer: null,
  baseWaypointsLayerGroup: null,
  routeLayerGroup: null,
  networkBaseLine: null,
  latLngSearchMarker: null,

  // Add/edit-waypoint workflow
  isAddingWaypoint: false,
  pendingMarker: null,
  editingLocked: true,
  waypointsEditLayer: null,

  toastTimer: null
};
