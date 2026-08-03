/**
 * "SHOW THIS FIX ON A MAP" - the Android implementation.
 *
 * `geo:` is the correct Android intent URI: it hands the coordinate to
 * whichever map application the operator actually has installed, works
 * offline if that application caches tiles, and asks for no network
 * permission of its own.
 *
 * It is NOT correct in a browser - nothing handles `geo:` there - so this
 * module has a `.web.ts` sibling that builds an OpenStreetMap HTTPS URL
 * instead. GpsScreen imports './mapLink' with no extension and gets the
 * right one per platform, exactly like the USB transport seam.
 *
 * Both implementations only ever BUILD AND OPEN A URL. Neither embeds a
 * map, loads tiles, or sends the aircraft's position anywhere on its own:
 * the operator taps a button, and a coordinate they are already looking
 * at is handed to an application they chose. That is the boundary the
 * Arabic UI promises ("لا توجد روابط أو واجهات خارجية" elsewhere in the
 * product), and it is why this stays a link rather than an integration.
 */

import {Linking} from 'react-native';

export type MapCoordinate = {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
};

/** The platform's map URL for a coordinate. Exported for tests. */
export function buildMapUrl({
  latitudeDegrees,
  longitudeDegrees,
}: MapCoordinate): string {
  return `geo:${latitudeDegrees},${longitudeDegrees}?q=${latitudeDegrees},${longitudeDegrees}`;
}

/**
 * Opens the coordinate in the platform's map surface.
 *
 * Rejections are swallowed deliberately, and this is the pre-existing
 * behaviour, not a new decision: there is no map application on the
 * device, or the browser blocked the tab. Neither is an error about the
 * GPS fix itself, and raising an alert over a failed convenience link
 * would interrupt an operator mid-configuration for nothing.
 */
export function openMapLocation(coordinate: MapCoordinate): void {
  Linking.openURL(buildMapUrl(coordinate)).catch(() => {});
}
