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
 * THE LEGACY PITCH LINK IS NOT OBSERVABLE ON A MODERN WRITE, AND THIS
 * MODULE NO LONGER PRETENDS IT IS.
 *
 * The setter's first two bytes carry roll's RC rate and expo, and before
 * storing each one the firmware checks whether pitch currently equals roll;
 * if it does, pitch is given the new value too (msp.c:2781-2791). That is a
 * legacy convenience for pilots who kept the two axes linked.
 *
 * But the SAME handler then reads explicit pitch bytes later in the payload
 * and assigns them unconditionally:
 *
 *     if (sbufBytesRemaining(src) >= 1) rcRates[FD_PITCH] = sbufReadU8(src);  // offset 12
 *     if (sbufBytesRemaining(src) >= 1) rcExpo[FD_PITCH]  = sbufReadU8(src);  // offset 13
 *
 * so on any payload long enough to reach those offsets the linkage is
 * overwritten before the handler returns. Our encoder always sends the full
 * 24 bytes. THEREFORE THERE IS NO PITCH-FOLLOWS-ROLL NORMALISATION FOR A
 * PRODUCTION WRITE: the explicit pitch bytes are authoritative, and a
 * readback that shows pitch tracking roll when the request did not ask for
 * it is a MISMATCH, not a firmware rule doing its job.
 *
 * The link survives here only as `legacyPitchLinkObservable`, which records
 * the partial-payload lengths at which the firmware would still expose it.
 * Nothing in production produces such a payload.
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
}

/**
 * The payload lengths at which the legacy pitch link would still be visible.
 *
 * `rcRates[FD_PITCH]` is read at offset 12 and `rcExpo[FD_PITCH]` at 13, each
 * behind `sbufBytesRemaining(src) >= 1`. A payload of 12 bytes therefore
 * stops before the RC-rate overwrite; one of 13 bytes stops before the expo
 * overwrite. Anything longer buries the link entirely.
 *
 * HISTORICAL / PARTIAL-PAYLOAD ONLY. Our encoder sends 24 bytes, so both
 * answers are false for every write this app makes.
 */
export function legacyPitchLinkObservable(payloadLength: number): {
  readonly rcRate: boolean;
  readonly expo: boolean;
} {
  return Object.freeze({
    rcRate: payloadLength <= RC_TUNING_OFFSETS.rcRatePitch,
    expo: payloadLength <= RC_TUNING_OFFSETS.expoPitch,
  });
}

/**
 * What the firmware will hold after a FULL 24-byte MSP_SET_RC_TUNING.
 *
 * Every axis takes the requested value, pitch included. The legacy link fires
 * on byte 0 and byte 1 and is then overwritten by the explicit pitch bytes at
 * offsets 12 and 13, so it contributes nothing to the final state and the
 * board's stored values before the write do not change the answer.
 *
 * The parameter is kept for the reader's sake - it is what makes the absence
 * of any dependence on it visible - and is deliberately unused.
 */
export function projectRcTuningWrite(
  _observedBeforeWrite: MspRcTuningFull,
  requested: RcTuningWriteRequest,
): RcTuningWriteProjection {
  return Object.freeze({
    rcRate: Object.freeze([
      requested.rcRate[0], requested.rcRate[1], requested.rcRate[2],
    ]) as readonly [number, number, number],
    expo: Object.freeze([
      requested.expo[0], requested.expo[1], requested.expo[2],
    ]) as readonly [number, number, number],
  });
}
