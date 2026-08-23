import {MspPayloadReadError} from './MspPayloadReader';
import {MSP_RC_TUNING_BYTES} from './pidWireContracts';

/**
 * THE WHOLE OF MSP_RC_TUNING - 24 bytes, and unchanged across 1.47, 1.48
 * and 1.49.
 *
 * Two things about this payload are easy to get wrong and both are modelled
 * here rather than commented away.
 *
 * TPA IS NOT IN HERE ANY MORE. Bytes 5 and 8-9 are where tpa_rate and
 * tpa_breakpoint used to live. The firmware now serialises literal zeros into
 * them and, on the way in, reads them and throws them away - the real fields
 * moved into the PID profile and travel on MSP_PID_ADVANCED. A model that
 * still calls these bytes TPA would be reading a constant and calling it a
 * setting.
 *
 * WRITING ROLL CAN WRITE PITCH. The setter's first two bytes carry roll's RC
 * rate and expo, and before storing each one it checks whether pitch
 * currently equals roll; if it does, pitch is given the new value too. It is
 * a legacy convenience for pilots who keep the two axes linked, and it is
 * state-dependent: the same payload has different effects on two boards whose
 * stored pitch differs. `projectRcTuningWrite` below reproduces it so that a
 * readback can tell "pitch followed roll, as designed" apart from "pitch is
 * not what we asked for".
 */

export const RC_TUNING_OFFSETS = Object.freeze({
  rcRateRoll: 0,
  expoRoll: 1,
  superRateRoll: 2,
  superRatePitch: 3,
  superRateYaw: 4,
  retiredTpaRate: 5,
  throttleMid: 6,
  throttleExpo: 7,
  retiredTpaBreakpoint: 8,
  expoYaw: 10,
  rcRateYaw: 11,
  rcRatePitch: 12,
  expoPitch: 13,
  throttleLimitType: 14,
  throttleLimitPercent: 15,
  rateLimitRoll: 16,
  rateLimitPitch: 18,
  rateLimitYaw: 20,
  ratesType: 22,
  throttleHover: 23,
} as const);

/** The three bytes the firmware serialises as constants and discards on write. */
export const RC_TUNING_RETIRED_OFFSETS: readonly number[] = Object.freeze([5, 8, 9]);

export interface MspRcTuningFull {
  /** Indexed roll, pitch, yaw. */
  readonly rcRate: readonly [number, number, number];
  readonly expo: readonly [number, number, number];
  readonly superRate: readonly [number, number, number];
  readonly rateLimit: readonly [number, number, number];
  readonly ratesTypeRaw: number;
  readonly throttleMid: number;
  readonly throttleExpo: number;
  readonly throttleHover: number;
  readonly throttleLimitType: number;
  readonly throttleLimitPercent: number;
  /** Carried so a caller can prove the firmware really did send zeros. */
  readonly retiredTpaBytes: readonly [number, number, number];
  readonly raw: Uint8Array;
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

export function decodeRcTuningFull(payload: Uint8Array): MspRcTuningFull {
  if (payload.length < MSP_RC_TUNING_BYTES) {
    throw new MspPayloadReadError(
      `MSP_RC_TUNING requires ${MSP_RC_TUNING_BYTES} bytes; received ${payload.length}.`,
    );
  }
  const o = RC_TUNING_OFFSETS;
  return Object.freeze({
    rcRate: Object.freeze([
      payload[o.rcRateRoll], payload[o.rcRatePitch], payload[o.rcRateYaw],
    ]) as readonly [number, number, number],
    expo: Object.freeze([
      payload[o.expoRoll], payload[o.expoPitch], payload[o.expoYaw],
    ]) as readonly [number, number, number],
    superRate: Object.freeze([
      payload[o.superRateRoll], payload[o.superRatePitch], payload[o.superRateYaw],
    ]) as readonly [number, number, number],
    rateLimit: Object.freeze([
      u16(payload, o.rateLimitRoll), u16(payload, o.rateLimitPitch), u16(payload, o.rateLimitYaw),
    ]) as readonly [number, number, number],
    ratesTypeRaw: payload[o.ratesType],
    throttleMid: payload[o.throttleMid],
    throttleExpo: payload[o.throttleExpo],
    throttleHover: payload[o.throttleHover],
    throttleLimitType: payload[o.throttleLimitType],
    throttleLimitPercent: payload[o.throttleLimitPercent],
    retiredTpaBytes: Object.freeze([
      payload[o.retiredTpaRate], payload[o.retiredTpaBreakpoint], payload[o.retiredTpaBreakpoint + 1],
    ]) as readonly [number, number, number],
    raw: payload.slice(),
  });
}

/** The subset of RC tuning a write actually carries per axis. */
export interface RcTuningWriteRequest {
  readonly rcRate: readonly [number, number, number];
  readonly expo: readonly [number, number, number];
}

export interface RcTuningWriteProjection {
  readonly rcRate: readonly [number, number, number];
  readonly expo: readonly [number, number, number];
  /** True when pitch was dragged along by roll rather than by the request. */
  readonly pitchFollowedRollRcRate: boolean;
  readonly pitchFollowedRollExpo: boolean;
}

/**
 * What the firmware will hold after MSP_SET_RC_TUNING.
 *
 * The rule, verbatim in behaviour: byte 0 is roll's RC rate; if the STORED
 * pitch RC rate equals the STORED roll RC rate at the moment of the write,
 * pitch takes the new roll value too. Then roll is stored. Expo, byte 1,
 * follows the same rule. Pitch's own bytes arrive later in the payload and
 * overwrite the linkage if the caller sent a different pitch - so the linkage
 * only actually shows when the request leaves pitch alone.
 *
 * Pure: `observed` is never modified.
 */
export function projectRcTuningWrite(
  observed: MspRcTuningFull,
  requested: RcTuningWriteRequest,
): RcTuningWriteProjection {
  const rcRateLinked = observed.rcRate[1] === observed.rcRate[0];
  const expoLinked = observed.expo[1] === observed.expo[0];

  // The linkage fires first, then the explicit pitch byte lands on top.
  const linkedPitchRcRate = rcRateLinked ? requested.rcRate[0] : observed.rcRate[1];
  const linkedPitchExpo = expoLinked ? requested.expo[0] : observed.expo[1];

  const finalPitchRcRate = requested.rcRate[1];
  const finalPitchExpo = requested.expo[1];

  return Object.freeze({
    rcRate: Object.freeze([
      requested.rcRate[0], finalPitchRcRate, requested.rcRate[2],
    ]) as readonly [number, number, number],
    expo: Object.freeze([
      requested.expo[0], finalPitchExpo, requested.expo[2],
    ]) as readonly [number, number, number],
    pitchFollowedRollRcRate: rcRateLinked && linkedPitchRcRate !== observed.rcRate[1],
    pitchFollowedRollExpo: expoLinked && linkedPitchExpo !== observed.expo[1],
  });
}
