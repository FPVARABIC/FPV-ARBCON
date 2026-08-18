/**
 * A GPS Rescue payload built from a field MAP, at any of the four
 * contract lengths.
 *
 * Shared rather than local to one test file because the decoder, the
 * encoder, the model and the controller all need the SAME bytes: a
 * fixture that drifted between them would let a round-trip test pass
 * while the real exchange lost a field. The values are deliberately all
 * distinct, so a swapped pair of offsets cannot coincidentally match.
 *
 * Offsets are betaflight-configurator's MSPHelper.js (case
 * MSPCodes.MSP_GPS_RESCUE) and the firmware's msp.c.
 */

import {GPS_RESCUE_FULL_BYTES} from '../msp/decoding/decodeGpsRescue';

export interface GpsRescueFixtureFields {
  angle: number;
  returnAltitudeM: number;
  descentDistanceM: number;
  groundSpeedCmS: number;
  throttleMin: number;
  throttleMax: number;
  throttleHover: number;
  sanityChecks: number;
  minSats: number;
  ascendRate: number;
  descendRate: number;
  allowArmingWithoutFix: number;
  altitudeMode: number;
  minStartDistM: number;
  initialClimbM: number;
}

/** Distinct values so a mis-ordered field cannot coincidentally pass. */
export const GPS_RESCUE_FIELDS: Readonly<GpsRescueFixtureFields> = Object.freeze({
  angle: 45,
  returnAltitudeM: 120,
  descentDistanceM: 210,
  groundSpeedCmS: 850,
  throttleMin: 1150,
  throttleMax: 1850,
  throttleHover: 1275,
  sanityChecks: 2,
  minSats: 9,
  ascendRate: 640,
  descendRate: 155,
  allowArmingWithoutFix: 1,
  altitudeMode: 1,
  minStartDistM: 17,
  initialClimbM: 33,
});

/** Builds a payload at any of the four contract lengths. */
export function gpsRescuePayload(
  overrides: Partial<GpsRescueFixtureFields> = {},
  length: number = GPS_RESCUE_FULL_BYTES,
): Uint8Array {
  const f = {...GPS_RESCUE_FIELDS, ...overrides};
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  const u16 = (offset: number, value: number) => {
    if (offset + 2 <= length) view.setUint16(offset, value, true);
  };
  const u8 = (offset: number, value: number) => {
    if (offset < length) bytes[offset] = value;
  };
  u16(0, f.angle);
  u16(2, f.returnAltitudeM);
  u16(4, f.descentDistanceM);
  u16(6, f.groundSpeedCmS);
  u16(8, f.throttleMin);
  u16(10, f.throttleMax);
  u16(12, f.throttleHover);
  u8(14, f.sanityChecks);
  u8(15, f.minSats);
  u16(16, f.ascendRate);
  u16(18, f.descendRate);
  u8(20, f.allowArmingWithoutFix);
  u8(21, f.altitudeMode);
  u16(22, f.minStartDistM);
  u16(24, f.initialClimbM);
  return bytes;
}
