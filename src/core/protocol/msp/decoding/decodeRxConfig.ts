import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

const BETAFLIGHT_API_1_47_RX_CONFIG_BYTES = 39;

export interface MspRxConfig {
  readonly serialRxProvider: number;
  readonly stickMax: number;
  readonly stickCenter: number;
  readonly stickMin: number;
  readonly receiverMinUsec: number;
  readonly receiverMaxUsec: number;
  readonly fpvCameraAngleDegrees: number;
  readonly rcSmoothingSetpointCutoff: number;
  readonly rcSmoothingThrottleCutoff: number;
  readonly rcSmoothingAutoFactorThrottle: number;
  readonly rcSmoothingAutoFactor: number;
  readonly rcSmoothing: number;
  /** Exact response bytes. SET encoders clone and patch only owned fields. */
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
  const stickMax = reader.readU16LE();
  const stickCenter = reader.readU16LE();
  const stickMin = reader.readU16LE();
  reader.readU8(); // bind
  const receiverMinUsec = reader.readU16LE();
  const receiverMaxUsec = reader.readU16LE();
  reader.readU8(); // deprecated interpolation
  reader.readU8(); // interpolation interval
  reader.readU16LE(); // airmode threshold
  reader.readU8(); // SPI protocol
  reader.readU32LE(); // SPI id
  reader.readU8(); // SPI channel count
  const fpvCameraAngleDegrees = reader.readU8();
  reader.readU8(); // deprecated interpolation channels
  reader.readU8(); // deprecated smoothing type
  const rcSmoothingSetpointCutoff = reader.readU8();
  const rcSmoothingThrottleCutoff = reader.readU8();
  const rcSmoothingAutoFactorThrottle = reader.readU8();
  reader.readU8(); // deprecated derivative type
  reader.readU8(); // USB HID type
  const rcSmoothingAutoFactor = reader.readU8();
  const rcSmoothing = reader.readU8();
  return Object.freeze({
    serialRxProvider,
    stickMax,
    stickCenter,
    stickMin,
    receiverMinUsec,
    receiverMaxUsec,
    fpvCameraAngleDegrees,
    rcSmoothingSetpointCutoff,
    rcSmoothingThrottleCutoff,
    rcSmoothingAutoFactorThrottle,
    rcSmoothingAutoFactor,
    rcSmoothing,
    raw: payload.slice(),
  });
}
