import { MspPayloadReader } from './MspPayloadReader';

export interface MspCompGps {
  readonly distanceToHomeMeters: number;
  readonly directionToHomeDegrees: number;
  readonly updateToggle: number;
}

export function decodeCompGps(payload: Uint8Array): MspCompGps {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    distanceToHomeMeters: reader.readU16LE(),
    directionToHomeDegrees: reader.readU16LE(),
    updateToggle: reader.readU8(),
  });
}
