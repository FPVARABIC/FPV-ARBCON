import {MspPayloadReader} from './MspPayloadReader';
export interface SensorVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface MspRawImu {
  readonly accelerometer: SensorVector3;
  readonly gyroscopeDps: SensorVector3;
  readonly magnetometer: SensorVector3;
}
export interface MspAltitude {
  readonly altitudeCm: number;
  readonly variometerCms: number;
}
function vector(reader: MspPayloadReader): SensorVector3 {
  return Object.freeze({
    x: reader.readS16LE(),
    y: reader.readS16LE(),
    z: reader.readS16LE(),
  });
}
export function decodeRawImu(payload: Uint8Array): MspRawImu {
  // Betaflight reads this positionally with no length guard at all
  // (src/js/msp/MSPHelper.js); a firmware that appends or omits a
  // trailing field must not close the screen that shows it.
  const reader = new MspPayloadReader(payload, {lenient: true});
  return Object.freeze({
    accelerometer: vector(reader),
    gyroscopeDps: vector(reader),
    magnetometer: vector(reader),
  });
}
export function decodeAltitude(payload: Uint8Array): MspAltitude {
  // Betaflight reads this positionally with no length guard at all
  // (src/js/msp/MSPHelper.js); a firmware that appends or omits a
  // trailing field must not close the screen that shows it.
  const reader = new MspPayloadReader(payload, {lenient: true});
  const raw = reader.readU32LE();
  return Object.freeze({
    altitudeCm: raw >= 0x80000000 ? raw - 0x100000000 : raw,
    variometerCms: reader.readS16LE(),
  });
}
