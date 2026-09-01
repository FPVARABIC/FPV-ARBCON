import {
  MSP_SIMPLIFIED_TUNING_BYTES,
} from '../decoding/pidWireContracts';
import {
  SIMPLIFIED_FILTER_BLOCK_BYTES,
  SIMPLIFIED_PID_BLOCK_BYTES,
  type MspSimplifiedTuning,
} from '../decoding/decodeSimplifiedTuning';

/**
 * MSP_SET_SIMPLIFIED_TUNING (141) - 53 bytes, symmetric with the read.
 *
 * PATCHED INTO THE BOARD'S OWN PAYLOAD, the same strategy the existing PID
 * encoder already uses: clone what was just read and overwrite only the
 * fields being changed. That keeps the two reserved u32s in each block
 * exactly as the firmware sent them instead of zeroing sixteen bytes we do
 * not understand.
 *
 * A NOTE ABOUT THE Hz FIELDS. This payload carries the effective filter
 * frequencies as well as the multipliers, and the firmware stores them and
 * then immediately regenerates them from the multiplier whenever the block's
 * enable flag is set. Sending them is therefore how a block is DISABLED
 * (a zero Hz stays zero and is not regenerated), not how it is tuned. The
 * caller states its intent through the typed fields below rather than by
 * poking bytes.
 */

export interface SimplifiedPidInputPatch {
  readonly modeRaw?: number;
  readonly masterMultiplier?: number;
  readonly rollPitchRatio?: number;
  readonly iGain?: number;
  readonly dGain?: number;
  readonly piGain?: number;
  readonly dMaxGain?: number;
  readonly feedforwardGain?: number;
  readonly pitchPiGain?: number;
}

export interface SimplifiedFilterPatch {
  readonly enabled?: boolean;
  readonly multiplier?: number;
  readonly effectiveHz?: {
    readonly lpf1StaticHz?: number;
    readonly lpf2StaticHz?: number;
    readonly lpf1DynMinHz?: number;
    readonly lpf1DynMaxHz?: number;
  };
}

export interface SimplifiedTuningPatch {
  readonly pids?: SimplifiedPidInputPatch;
  readonly dterm?: SimplifiedFilterPatch;
  readonly gyro?: SimplifiedFilterPatch;
}

const U8_MAX = 0xff;
const U16_MAX = 0xffff;

function assertU8(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(`${name} must be an integer 0-${U8_MAX} for MSP_SET_SIMPLIFIED_TUNING; got ${value}.`);
  }
}

function assertU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
    throw new RangeError(`${name} must be an integer 0-${U16_MAX} for MSP_SET_SIMPLIFIED_TUNING; got ${value}.`);
  }
}

function patchFilterBlock(
  payload: Uint8Array,
  base: number,
  label: string,
  patch: SimplifiedFilterPatch | undefined,
): void {
  if (patch === undefined) return;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (patch.enabled !== undefined) payload[base] = patch.enabled ? 1 : 0;
  if (patch.multiplier !== undefined) {
    assertU8(`${label}.multiplier`, patch.multiplier);
    payload[base + 1] = patch.multiplier;
  }
  const hz = patch.effectiveHz;
  if (hz === undefined) return;
  const write = (offset: number, name: string, value: number | undefined): void => {
    if (value === undefined) return;
    assertU16(`${label}.effectiveHz.${name}`, value);
    dv.setUint16(offset, value, true);
  };
  write(base + 2, 'lpf1StaticHz', hz.lpf1StaticHz);
  write(base + 4, 'lpf2StaticHz', hz.lpf2StaticHz);
  write(base + 6, 'lpf1DynMinHz', hz.lpf1DynMinHz);
  write(base + 8, 'lpf1DynMaxHz', hz.lpf1DynMaxHz);
}

export function encodeSimplifiedTuning(
  observed: MspSimplifiedTuning,
  patch: SimplifiedTuningPatch,
): Uint8Array {
  if (observed.raw.length < MSP_SIMPLIFIED_TUNING_BYTES) {
    throw new RangeError(
      `Cannot encode MSP_SET_SIMPLIFIED_TUNING from a ${observed.raw.length}-byte observation.`,
    );
  }
  const payload = observed.raw.slice(0, MSP_SIMPLIFIED_TUNING_BYTES);
  const pids = patch.pids;
  if (pids !== undefined) {
    const put = (offset: number, name: string, value: number | undefined): void => {
      if (value === undefined) return;
      assertU8(`pids.${name}`, value);
      payload[offset] = value;
    };
    put(0, 'modeRaw', pids.modeRaw);
    put(1, 'masterMultiplier', pids.masterMultiplier);
    put(2, 'rollPitchRatio', pids.rollPitchRatio);
    put(3, 'iGain', pids.iGain);
    put(4, 'dGain', pids.dGain);
    put(5, 'piGain', pids.piGain);
    put(6, 'dMaxGain', pids.dMaxGain);
    put(7, 'feedforwardGain', pids.feedforwardGain);
    put(8, 'pitchPiGain', pids.pitchPiGain);
  }
  patchFilterBlock(payload, SIMPLIFIED_PID_BLOCK_BYTES, 'dterm', patch.dterm);
  patchFilterBlock(
    payload,
    SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES,
    'gyro',
    patch.gyro,
  );
  return payload;
}
