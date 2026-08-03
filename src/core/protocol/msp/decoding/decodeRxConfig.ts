import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

const BETAFLIGHT_API_1_47_RX_CONFIG_BYTES = 39;

export interface MspRxConfig {
  readonly serialRxProvider: number;
  readonly fpvCameraAngleDegrees: number;
  /** Exact response bytes. The SET encoder clones and patches only byte 22. */
  readonly raw: Uint8Array;
}

/**
 * Betaflight MSP_RX_CONFIG API 1.47. The camera angle is byte 22. We still
 * bounds-check the prefix field by field so a short/corrupt response cannot
 * be accepted as editable state, while retaining the complete payload for a
 * surgical write that preserves receiver and smoothing settings.
 */
export function decodeRxConfig(payload: Uint8Array): MspRxConfig {
  if (payload.length < BETAFLIGHT_API_1_47_RX_CONFIG_BYTES) {
    throw new MspPayloadReadError(
      `MSP_RX_CONFIG API 1.47 requires ${BETAFLIGHT_API_1_47_RX_CONFIG_BYTES} bytes; received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const serialRxProvider = reader.readU8();
  reader.readU16LE(); // stick max
  reader.readU16LE(); // stick center
  reader.readU16LE(); // stick min
  reader.readU8(); // bind
  reader.readU16LE(); // rx min usec
  reader.readU16LE(); // rx max usec
  reader.readU8(); // deprecated interpolation
  reader.readU8(); // interpolation interval
  reader.readU16LE(); // airmode threshold
  reader.readU8(); // SPI protocol
  reader.readU32LE(); // SPI id
  reader.readU8(); // SPI channel count
  const fpvCameraAngleDegrees = reader.readU8();
  return Object.freeze({
    serialRxProvider,
    fpvCameraAngleDegrees,
    raw: payload.slice(),
  });
}
