/**
 * Pass 7.6c - pure semantic derivations for the Receiver, GPS, and
 * Flight-controller cards. Wire truth in, PROVEN meaning out - the same
 * decoder/semantics split batteryTelemetry.ts established.
 */

import type {MspAnalog, MspRawGpsCompact, MspStatusExCompact} from '../protocol';
import {STATUS_SENSOR_GPS_BIT} from '../protocol';

/** RSSI_MAX_VALUE (rx/rx.h:193 @ pin) - the verified getRssi() range. */
export const RSSI_MAX_VALUE = 1023;

/**
 * MSP_ANALOG's RSSI: 0..1023, but a wire value of 0 is ambiguous - an
 * unconfigured RSSI source and a genuine zero-signal reading are
 * indistinguishable by this command alone, and no audited read-only
 * source in this pass can prove the configuration. Per the Pass 7.6c
 * contract ("if RSSI-source availability cannot be distinguished safely,
 * show unavailable - do not show a misleading 0%"), zero maps to
 * NOT_DISTINGUISHABLE; any nonzero reading proves a live source and maps
 * to a percentage: round((rssi / 1023) * 100).
 */
export type ReceiverRssiSemantics =
  | {kind: 'PERCENT'; percent: number}
  | {kind: 'NOT_DISTINGUISHABLE'};

export function deriveReceiverRssi(analog: MspAnalog): ReceiverRssiSemantics {
  if (analog.rssi === 0) {
    return {kind: 'NOT_DISTINGUISHABLE'};
  }
  return {kind: 'PERCENT', percent: Math.round((analog.rssi / RSSI_MAX_VALUE) * 100)};
}

/** A set GPS sensor-presence bit means DETECTED by the FC, never
 * "healthy" - used only to distinguish "GPS present but no fix yet" from
 * "no proven GPS support/presence". */
export function isGpsPresent(statusEx: MspStatusExCompact): boolean {
  return (statusEx.sensorPresenceMask & STATUS_SENSOR_GPS_BIT) !== 0;
}

export type GpsCardSemantics =
  | {kind: 'NO_PRESENCE_PROOF'}
  | {kind: 'NO_FIX'; satelliteCount: number}
  | {kind: 'FIX'; satelliteCount: number};

/**
 * gpsPresent comes from the shared MSP_STATUS_EX decode (no duplicate
 * command is issued for it); undefined means presence could not be
 * proven (e.g. the FC channel is unavailable). Zero satellites alone
 * never proves GPS hardware is absent, and no-fix is not an error.
 */
export function deriveGpsCard(gps: MspRawGpsCompact, gpsPresent: boolean | undefined): GpsCardSemantics {
  if (gps.hasFix) {
    return {kind: 'FIX', satelliteCount: gps.satelliteCount};
  }
  if (gpsPresent === true) {
    return {kind: 'NO_FIX', satelliteCount: gps.satelliteCount};
  }
  return {kind: 'NO_PRESENCE_PROOF'};
}
