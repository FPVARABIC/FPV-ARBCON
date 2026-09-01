/**
 * MSP_SET_GPS_RESCUE (225) - the write side of decodeGpsRescue.ts.
 *
 * TWO RULES, both taken from the firmware's own handler rather than from
 * the configurator's convenience:
 *
 * 1. NEVER LENGTHEN THE FRAME BEYOND WHAT THE BOARD SENT. msp.c reads the
 *    nine base fields unconditionally and then guards each appended block
 *    with `if (sbufBytesRemaining(src) >= N)`. A frame that is SHORTER
 *    than the board's own version therefore leaves the newer fields at
 *    their stored values - safe, and the reason a 1.47-shaped write is
 *    correct on a 1.48 board. A frame that is LONGER is the dangerous
 *    direction: bytes we invented would land in fields we have not
 *    verified. So the payload length is driven by the snapshot's
 *    presentFieldCount - what this board actually sent - and by nothing
 *    else.
 *
 * 2. ECHO THE FOUR AUTOPILOT FIELDS. `angle`, `throttleMin`,
 *    `throttleMax` and `throttleHover` sit inside this payload but belong
 *    to PG_AUTOPILOT, shared with Altitude Hold and Position Hold (see
 *    decodeGpsRescue.ts). They are written back exactly as read. They
 *    cannot be edited here, and a save must not disturb them.
 *
 * There is no partial write: MSP_SET_GPS_RESCUE has no per-field
 * addressing, so the whole block goes or none of it does. That is why the
 * caller only sends it when the draft actually differs.
 */

import type {MspGpsRescueConfiguration} from '../decoding/decodeGpsRescue';
import {
  GPS_RESCUE_BASE_BYTES,
  GPS_RESCUE_FULL_BYTES,
  GPS_RESCUE_WITH_MIN_START_BYTES,
  GPS_RESCUE_WITH_RATES_BYTES,
} from '../decoding/decodeGpsRescue';
import {
  createGpsRescueDraft,
  gpsRescueDraftsEqual,
  validateGpsRescueDraft,
  type GpsRescueDraft,
} from '../../../state/gpsRescueConfigurationModel';

/**
 * Returns the payload for MSP_SET_GPS_RESCUE, or undefined when the draft
 * is byte-identical to what the board reported.
 *
 * `undefined` rather than an empty array because this command is
 * all-or-nothing: "nothing to send" is a different statement from "send
 * an empty write".
 */
export function encodeChangedGpsRescue(
  snapshot: MspGpsRescueConfiguration,
  draft: GpsRescueDraft,
): Uint8Array | undefined {
  if (validateGpsRescueDraft(draft, snapshot).length > 0) {
    throw new RangeError('Invalid GPS Rescue draft.');
  }
  if (gpsRescueDraftsEqual(createGpsRescueDraft(snapshot), draft)) {
    return undefined;
  }
  return encodeGpsRescue(snapshot, draft);
}

/** The payload itself, at exactly the length this board uses. */
export function encodeGpsRescue(
  snapshot: MspGpsRescueConfiguration,
  draft: GpsRescueDraft,
): Uint8Array {
  const length = frameLength(snapshot.presentFieldCount);
  const payload = new Uint8Array(length);
  const view = new DataView(payload.buffer);
  const {preserved} = snapshot;

  view.setUint16(0, preserved.angle, true);
  view.setUint16(2, draft.returnAltitudeM, true);
  view.setUint16(4, draft.descentDistanceM, true);
  view.setUint16(6, draft.groundSpeedCmS, true);
  view.setUint16(8, preserved.throttleMin, true);
  view.setUint16(10, preserved.throttleMax, true);
  view.setUint16(12, preserved.throttleHover, true);
  payload[14] = draft.sanityChecks;
  payload[15] = draft.minSats;

  if (length >= GPS_RESCUE_WITH_RATES_BYTES) {
    view.setUint16(16, draft.ascendRate, true);
    view.setUint16(18, draft.descendRate, true);
    payload[20] = draft.allowArmingWithoutFix;
    payload[21] = draft.altitudeMode;
  }
  if (length >= GPS_RESCUE_WITH_MIN_START_BYTES) {
    view.setUint16(22, draft.minStartDistM, true);
  }
  if (length >= GPS_RESCUE_FULL_BYTES) {
    view.setUint16(24, draft.initialClimbM, true);
  }
  return payload;
}

/**
 * Clamps a reported length onto the four contract sizes.
 *
 * A board newer than this build may send MORE than 26 bytes; the decoder
 * ignores the tail and this must not try to reproduce it, because bytes
 * we did not decode are bytes whose meaning we do not know. Writing 26
 * leaves them untouched, which is precisely what the firmware's
 * `sbufBytesRemaining` guards are for.
 */
function frameLength(presentFieldCount: number): number {
  if (presentFieldCount >= GPS_RESCUE_FULL_BYTES) return GPS_RESCUE_FULL_BYTES;
  if (presentFieldCount >= GPS_RESCUE_WITH_MIN_START_BYTES) return GPS_RESCUE_WITH_MIN_START_BYTES;
  if (presentFieldCount >= GPS_RESCUE_WITH_RATES_BYTES) return GPS_RESCUE_WITH_RATES_BYTES;
  return GPS_RESCUE_BASE_BYTES;
}
