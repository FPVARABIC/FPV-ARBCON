import { MspPayloadReader } from './MspPayloadReader';

export const MSP_TEXT_PILOT_NAME = 1;
export const MSP_TEXT_CRAFT_NAME = 2;
export const MSP_TEXT_MAX_BYTES = 16;

export interface MspTextValue {
  readonly type: number;
  readonly value: string;
}

/** MSP2_GET_TEXT response: text type, length, then single-byte text. */
export function decodeMspText(payload: Uint8Array): MspTextValue {
  const reader = new MspPayloadReader(payload);
  const type = reader.readU8();
  const length = reader.readU8();
  if (length > MSP_TEXT_MAX_BYTES) {
    throw new RangeError(`MSP text length ${length} exceeds ${MSP_TEXT_MAX_BYTES}.`);
  }
  return Object.freeze({ type, value: reader.readFixedAscii(length) });
}
