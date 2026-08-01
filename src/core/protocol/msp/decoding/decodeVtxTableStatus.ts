import { MspPayloadReader } from './MspPayloadReader';

export interface MspVtxTableStatus {
  readonly deviceType: number;
  readonly ready: boolean;
  readonly tableAvailable: boolean;
  readonly bands: number;
  readonly channels: number;
  readonly powerLevels: number;
}

export function decodeVtxTableStatus(payload: Uint8Array): MspVtxTableStatus {
  const reader = new MspPayloadReader(payload);
  const deviceType = reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU16LE();
  const ready = reader.readU8() !== 0;
  reader.readU8();
  reader.readU16LE();
  const tableAvailable = reader.readU8() !== 0;
  const bands = reader.readU8();
  const channels = reader.readU8();
  const powerLevels = reader.readU8();
  return Object.freeze({
    deviceType,
    ready,
    tableAvailable,
    bands,
    channels,
    powerLevels,
  });
}
