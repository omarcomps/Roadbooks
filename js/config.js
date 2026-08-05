// All app settings live here. Nothing else in the codebase should hardcode
// a portal URL, layer URL, or field name -- change it once, here.

export const CONFIG = {

  // --------------------------------------------------------------------
  // AUTHORIZATION -- ArcGIS Portal OAuth
  //
  // appId is this app's registration on the portal below (Portal ->
  // Content -> your app item -> Settings). Its "Redirect URIs" list must
  // include wherever this app is actually served from, plus
  // jimu.js/oauth-callback.html under that same origin -- that file is
  // the popup page the sign-in flow redirects back to. Sign-in will fail
  // with a redirect_uri mismatch if the app is hosted somewhere not on
  // that list.
  // --------------------------------------------------------------------
  portalUrl: 'https://geo.geomsf.org/portal',
  appId: 'VcIZklMbsUfW8voZ',

  // --------------------------------------------------------------------
  // DATA LAYERS -- hosted feature layers this app reads from and writes to
  // --------------------------------------------------------------------
  routesLayerUrl: 'https://geo.geomsf.org/server/rest/services/Hosted/syr_oca_ActiveRoutesDissolved_072026/FeatureServer/0',
  // Road name is read from whichever of these fields is populated first.
  routeNameFields: ['Road', 'road', 'ROAD', 'NAME', 'Name', 'name'],

  waypointsLayerUrl: 'https://geo.geomsf.org/server/rest/services/Hosted/syr_oca_Raod_Waypoints_072026/FeatureServer/0',
  waypointFields: {
    idField: 'fid',
    nameField: 'name',
    typeField: 'type',
    kissPointField: 'kisspoint',
    latField: 'latitude',
    lngField: 'longitude',
    mtnField: 'mtn_coverage',
    syriatelField: 'syriatel_coverage',
    rcellField: 'rcell_coverage'
  },
  // Raw kisspoint field values (lower-cased) that count as "yes".
  kissPointTrueValues: ['yes', 'y', 'true', '1', 'kiss', 'kisspoint', 'swap'],
  kissPointWriteTrueValue: 'Yes',
  kissPointWriteFalseValue: 'No',
  // Waypoint "type" values selectable as a departure/arrival/required stop.
  depArrTypes: ['Coordination', 'Base', 'Site', 'Airport'],
  cellularCoverageOptions: ['Yes with internet', 'Yes, No Internet', 'No coverage'],

  // --------------------------------------------------------------------
  // APP DEFAULTS -- initial values for the route-calculation form
  // --------------------------------------------------------------------
  defaultToleranceMeters: 300,
  toleranceMinMeters: 10,
  toleranceMaxMeters: 5000,
  defaultAvgSpeedKmh: 90,
  defaultDepartureTime: '06:00',
  defaultKissStopMinutes: 15,
  maxRouteAlternatives: 3,
  // How close a placed/dragged waypoint must be to the road network to get
  // pulled onto it. Beyond this it's left at the raw position, so a
  // genuinely off-network waypoint (site set back from the road) can still
  // be added as-is.
  snapToRouteMaxMeters: 50,
  // Below this, the gap between a waypoint and its snapped network point is
  // too small to see on the map and not worth an extra OSRM round trip, so
  // it's left as a straight line. Above it, that gap is routed through OSRM
  // instead so it follows real streets rather than cutting across blocks.
  connectorRouteMinKm: 0.03,
  // How many nearby network points to try over OSRM per connector, keeping
  // whichever produces the shortest real-road distance rather than
  // committing to the single geometrically-nearest one.
  connectorCandidateCount: 3,

  // --------------------------------------------------------------------
  // MAP
  // --------------------------------------------------------------------
  // OSM is the default and a fully legitimate public tile service. The
  // Google layers below are fetched from Google's internal tile endpoint
  // (not the official Maps JavaScript API), which is outside Google's
  // terms of service -- no key, no attribution control, no guarantee it
  // keeps working. Kept here at explicit request; swap for the Maps JS API
  // (with a key) if that ever becomes a problem.
  basemaps: {
    osm: {
      label: 'OpenStreetMap',
      urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    },
    google: {
      label: 'Google Maps',
      urlTemplate: 'https://mt1.google.com/vt/lyrs=r&x={x}&y={y}&z={z}',
      attribution: '© Google',
      maxZoom: 20
    },
    googleSatellite: {
      label: 'Google Satellite',
      urlTemplate: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      attribution: '© Google',
      maxZoom: 20
    }
  },
  defaultBasemap: 'google',

  // --------------------------------------------------------------------
  // ROUTING FALLBACK -- used only when a waypoint can't be reached through
  // the internal ArcGIS road network at all. Free, no API key required.
  // --------------------------------------------------------------------
  osrmBaseUrl: 'https://router.project-osrm.org'
};
