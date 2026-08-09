import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';
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
  if (payload.length !== 18)
    throw new MspPayloadReadError(
      `MSP_RAW_IMU must be exactly 18 bytes; received ${payload.length}.`,
    );
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    accelerometer: vector(reader),
    gyroscopeDps: vector(reader),
    magnetometer: vector(reader),
  });
}
export function decodeAltitude(payload: Uint8Array): MspAltitude {
  if (payload.length !== 6)
    throw new MspPayloadReadError(
      `MSP_ALTITUDE must be exactly 6 bytes; received ${payload.length}.`,
    );
  const reader = new MspPayloadReader(payload);
  const raw = reader.readU32LE();
  return Object.freeze({
    altitudeCm: raw >= 0x80000000 ? raw - 0x100000000 : raw,
    variometerCms: reader.readS16LE(),
  });
}
