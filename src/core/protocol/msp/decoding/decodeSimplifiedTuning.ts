import {MspPayloadReadError} from './MspPayloadReader';
import {MSP_SIMPLIFIED_TUNING_BYTES} from './pidWireContracts';

/**
 * MSP_SIMPLIFIED_TUNING (140) and MSP_SET_SIMPLIFIED_TUNING (141).
 *
 * 53 bytes, and - rare among this page's commands - the firmware's reader and
 * writer are field-for-field symmetric. Three blocks:
 *
 *   PID    17 bytes   9 u8 inputs + two reserved u32
 *   Dterm  18 bytes   2 u8 inputs + four u16 EFFECTIVE Hz + two reserved u32
 *   Gyro   18 bytes   2 u8 inputs + four u16 EFFECTIVE Hz + two reserved u32
 *
 * THE BLOCKS MIX TWO KINDS OF NUMBER, which is the trap this file exists to
 * prevent. `multiplier` is an input to a generator; the four Hz beside it are
 * that generator's OUTPUT, and the firmware overwrites them from the
 * multiplier the moment the block's enable flag is set. Sending a Hz value
 * and expecting it back is not a mismatch when the flag is on - it is the
 * documented behaviour. The types below keep the two apart by name and by
 * nesting so that assigning one to the other does not compile.
 *
 * THE RESERVED u32s ARE READ AND CARRIED. The firmware writes zero into them
 * today, but it reads them back into nothing, so a future firmware could
 * start using them. Preserving what the board sent costs two fields and keeps
 * a later write honest.
 */

export const SIMPLIFIED_PID_BLOCK_BYTES = 17;
export const SIMPLIFIED_FILTER_BLOCK_BYTES = 18;

/** config/simplified_tuning.h */
export const SIMPLIFIED_TUNING_PIDS_MIN = 0;
export const SIMPLIFIED_TUNING_FILTERS_MIN = 10;
export const SIMPLIFIED_TUNING_MAX = 200;
export const SIMPLIFIED_TUNING_DEFAULT = 100;
export const SIMPLIFIED_TUNING_D_DEFAULT = 100;

/**
 * pidSimplifiedTuningMode_e. Three is the enum's own COUNT sentinel and is
 * not a storable mode; anything else is genuinely unknown and stays unknown -
 * a raw value we cannot name must never quietly become OFF, because OFF is a
 * claim that no generation is happening.
 */
export const SIMPLIFIED_PIDS_MODE_OFF = 0;
export const SIMPLIFIED_PIDS_MODE_RP = 1;
export const SIMPLIFIED_PIDS_MODE_RPY = 2;
export const SIMPLIFIED_PIDS_MODE_COUNT_SENTINEL = 3;

export type SimplifiedPidsMode =
  | {readonly kind: 'OFF'}
  | {readonly kind: 'RP'}
  | {readonly kind: 'RPY'}
  | {readonly kind: 'UNKNOWN'; readonly raw: number};

export function classifySimplifiedPidsMode(raw: number): SimplifiedPidsMode {
  if (raw === SIMPLIFIED_PIDS_MODE_OFF) return Object.freeze({kind: 'OFF'});
  if (raw === SIMPLIFIED_PIDS_MODE_RP) return Object.freeze({kind: 'RP'});
  if (raw === SIMPLIFIED_PIDS_MODE_RPY) return Object.freeze({kind: 'RPY'});
  return Object.freeze({kind: 'UNKNOWN', raw});
}

/** The nine PID-block generator inputs. All PID-profile scoped. */
export interface SimplifiedPidInputs {
  readonly modeRaw: number;
  readonly mode: SimplifiedPidsMode;
  readonly masterMultiplier: number;
  readonly rollPitchRatio: number;
  readonly iGain: number;
  readonly dGain: number;
  readonly piGain: number;
  readonly dMaxGain: number;
  readonly feedforwardGain: number;
  readonly pitchPiGain: number;
  readonly reserved: readonly [number, number];
}

/**
 * A filter block: the two inputs, then the four Hz the generator writes.
 * `enabled` + `multiplier` are inputs; `effectiveHz` is output. Never the same
 * type, never the same field.
 */
export interface SimplifiedFilterBlock {
  readonly enabled: boolean;
  readonly enabledRaw: number;
  readonly multiplier: number;
  readonly effectiveHz: {
    readonly lpf1StaticHz: number;
    readonly lpf2StaticHz: number;
    readonly lpf1DynMinHz: number;
    readonly lpf1DynMaxHz: number;
  };
  readonly reserved: readonly [number, number];
}

export interface MspSimplifiedTuning {
  readonly pids: SimplifiedPidInputs;
  /** PID-profile scoped: lives in pidProfile_t. */
  readonly dterm: SimplifiedFilterBlock;
  /** GLOBAL: lives in gyroConfig_t, not in the PID profile. */
  readonly gyro: SimplifiedFilterBlock;
  readonly raw: Uint8Array;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeFilterBlock(payload: Uint8Array, base: number): SimplifiedFilterBlock {
  const dv = view(payload);
  return Object.freeze({
    enabled: payload[base] !== 0,
    enabledRaw: payload[base],
    multiplier: payload[base + 1],
    effectiveHz: Object.freeze({
      lpf1StaticHz: dv.getUint16(base + 2, true),
      lpf2StaticHz: dv.getUint16(base + 4, true),
      lpf1DynMinHz: dv.getUint16(base + 6, true),
      lpf1DynMaxHz: dv.getUint16(base + 8, true),
    }),
    reserved: Object.freeze([
      dv.getUint32(base + 10, true),
      dv.getUint32(base + 14, true),
    ]) as readonly [number, number],
  });
}

export function decodeSimplifiedTuning(payload: Uint8Array): MspSimplifiedTuning {
  if (payload.length < MSP_SIMPLIFIED_TUNING_BYTES) {
    throw new MspPayloadReadError(
      `MSP_SIMPLIFIED_TUNING requires ${MSP_SIMPLIFIED_TUNING_BYTES} bytes; received ${payload.length}.`,
    );
  }
  const dv = view(payload);
  const dtermBase = SIMPLIFIED_PID_BLOCK_BYTES;
  const gyroBase = SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES;
  return Object.freeze({
    pids: Object.freeze({
      modeRaw: payload[0],
      mode: classifySimplifiedPidsMode(payload[0]),
      masterMultiplier: payload[1],
      rollPitchRatio: payload[2],
      iGain: payload[3],
      dGain: payload[4],
      piGain: payload[5],
      dMaxGain: payload[6],
      feedforwardGain: payload[7],
      pitchPiGain: payload[8],
      reserved: Object.freeze([dv.getUint32(9, true), dv.getUint32(13, true)]) as readonly [number, number],
    }),
    dterm: decodeFilterBlock(payload, dtermBase),
    gyro: decodeFilterBlock(payload, gyroBase),
    raw: payload.slice(),
  });
}

/**
 * MSP_VALIDATE_SIMPLIFIED_TUNING (145): three independent u8 booleans, in the
 * firmware's own order - PIDs, then GYRO, then DTERM.
 *
 * This is the firmware's OPINION about whether the stored values still match
 * what the sliders would generate. It is one input to a verification, never
 * the verification itself: it compares against a temporary copy and says
 * nothing about whether a write of ours reached EEPROM.
 */
export interface SimplifiedTuningValidity {
  readonly pidsValid: boolean;
  readonly gyroValid: boolean;
  readonly dtermValid: boolean;
}

export const MSP_VALIDATE_SIMPLIFIED_TUNING_BYTES = 3;

export function decodeSimplifiedTuningValidity(payload: Uint8Array): SimplifiedTuningValidity {
  if (payload.length < MSP_VALIDATE_SIMPLIFIED_TUNING_BYTES) {
    throw new MspPayloadReadError(
      `MSP_VALIDATE_SIMPLIFIED_TUNING requires ${MSP_VALIDATE_SIMPLIFIED_TUNING_BYTES} bytes; received ${payload.length}.`,
    );
  }
  return Object.freeze({
    pidsValid: payload[0] !== 0,
    gyroValid: payload[1] !== 0,
    dtermValid: payload[2] !== 0,
  });
}

/**
 * MSP_CALCULATE_SIMPLIFIED_PID (142) answers with `writePidfs`: three axes of
 * {u8 P, u8 I, u8 D, u8 dMax, u16 F} - 18 bytes, and NOT the shape it was
 * asked in. It runs against a temporary copy of the profile and stores
 * nothing, which is why it is classified PURE_FIRMWARE_CALCULATION_RPC and
 * must never be reached by a save path.
 */
export const MSP_CALCULATE_SIMPLIFIED_PID_RESPONSE_BYTES = 18;

export interface CalculatedPidfAxis {
  readonly p: number;
  readonly i: number;
  readonly d: number;
  readonly dMax: number;
  readonly f: number;
}

export function decodeCalculatedPidfs(payload: Uint8Array): readonly CalculatedPidfAxis[] {
  if (payload.length < MSP_CALCULATE_SIMPLIFIED_PID_RESPONSE_BYTES) {
    throw new MspPayloadReadError(
      `MSP_CALCULATE_SIMPLIFIED_PID requires ${MSP_CALCULATE_SIMPLIFIED_PID_RESPONSE_BYTES} bytes; received ${payload.length}.`,
    );
  }
  const dv = view(payload);
  return Object.freeze(Array.from({length: 3}, (_unused, axis) => {
    const base = axis * 6;
    return Object.freeze({
      p: payload[base],
      i: payload[base + 1],
      d: payload[base + 2],
      dMax: payload[base + 3],
      f: dv.getUint16(base + 4, true),
    });
  })) as readonly CalculatedPidfAxis[];
}
