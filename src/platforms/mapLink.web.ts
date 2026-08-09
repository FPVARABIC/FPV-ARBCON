/**
 * "SHOW THIS FIX ON A MAP" - the browser implementation.
 *
 * `geo:` (the Android sibling of this file) does nothing in a browser, so
 * the web build opens OpenStreetMap over HTTPS instead. OSM rather than a
 * commercial map: it needs no API key, no account and no per-load tracking
 * identifier, which keeps this a plain outbound link rather than a
 * third-party integration embedded in a flight-controller tool.
 *
 * `#map=16/lat/lon` is OSM's own permalink fragment - zoom, latitude,
 * longitude - and `mlat`/`mlon` place the marker. Both are supplied
 * because the fragment alone centres the view without marking the point.
 *
 * `noopener,noreferrer` is not boilerplate here: without `noopener` the
 * opened tab receives a `window.opener` handle back into the configurator,
 * and without `noreferrer` the aircraft's position leaves in a Referer
 * header on every subsequent request that tab makes.
 */

export type MapCoordinate = {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
};

const MAP_ZOOM = 16;

/** The platform's map URL for a coordinate. Exported for tests. */
export function buildMapUrl({
  latitudeDegrees,
  longitudeDegrees,
}: MapCoordinate): string {
  const latitude = encodeURIComponent(String(latitudeDegrees));
  const longitude = encodeURIComponent(String(longitudeDegrees));
  return (
    `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}` +
    `#map=${MAP_ZOOM}/${latitude}/${longitude}`
  );
}

/**
 * Opens the coordinate in a new tab.
 *
 * A blocked pop-up returns null and is ignored for the same reason the
 * Android side swallows its rejection: a failed convenience link is not
 * an error about the GPS fix, and must not interrupt an operator
 * mid-configuration.
 */
export function openMapLocation(coordinate: MapCoordinate): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.open(buildMapUrl(coordinate), '_blank', 'noopener,noreferrer');
}
