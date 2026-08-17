import {MspPayloadReader} from './MspPayloadReader';

/**
 * The full API 1.47 layout. This is a WRITE precondition, not a read one:
 * encodeReceiverConfig patches fixed offsets inside the original response, so
 * it must refuse a payload shorter than the layout it patches.
 */
export const BETAFLIGHT_API_1_47_RX_CONFIG_BYTES = 39;

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
 * Betaflight MSP_RX_CONFIG API 1.47. The camera angle is byte 22.
 *
 * The read is TOLERANT and the write is STRICT, which is where Betaflight
 * puts each: its handler reads every trailing field behind an apiVersion
 * gate over a reader that returns null past the end, so an older firmware
 * with a shorter payload still populates the tab. Demanding 39 bytes here
 * meant such a board could not even VIEW its receiver settings. Nothing is
 * lost by relaxing it: `raw` still carries the exact response, and
 * encodeReceiverConfig independently refuses to build a write from a payload
 * shorter than the offsets it patches - so a truncated read can never become
 * a corrupt write.
 */
export function decodeRxConfig(payload: Uint8Array): MspRxConfig {
  const reader = new MspPayloadReader(payload, {lenient: true});
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
