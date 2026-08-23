import {MspPayloadReadError} from './MspPayloadReader';
import {
  MSP_PID_ADVANCED_BYTES,
  absControlLifetime,
  integratedYawLifetime,
  type PidAdvancedFieldLifetime,
  type PidApiContract,
} from './pidWireContracts';

/**
 * THE WHOLE OF MSP_PID_ADVANCED, not the six fields one screen happens to use.
 *
 * 61 bytes at API 1.47, 1.48 and 1.49 alike. Every offset below is read from
 * the firmware serializer at the pinned 1.47 commit and re-checked against
 * 1.48 and 1.49 - the diff between those three trees touches three FIELDS and
 * moves no byte.
 *
 * WHY THE RETIRED SLOTS ARE MODELLED RATHER THAN SKIPPED. When Betaflight
 * drops a feature it does not shrink the payload; it writes a literal zero
 * and stops reading the byte. So `absControlGain === 0` on an API 1.48 board
 * says nothing whatsoever about absolute control - the field is simply gone.
 * Reporting the raw 0 with no lifetime beside it would invite exactly the
 * "raw zero means the feature is off" mistake this phase is meant to prevent.
 *
 * The reserved and was-* slots are carried too, because the encoder writes
 * back a patched copy of the board's own payload and needs them to survive
 * untouched.
 */

/** Offsets, 0-based, into the 61-byte payload. */
export const PID_ADVANCED_OFFSETS = Object.freeze({
  feedforwardTransition: 8,
  rateAccelLimit: 13,
  yawRateAccelLimit: 15,
  angleLimit: 17,
  antiGravityGain: 21,
  itermRotation: 25,
  itermRelax: 27,
  itermRelaxType: 28,
  absControlGain: 29,
  throttleBoost: 30,
  acroTrainerAngleLimit: 31,
  feedforwardRoll: 32,
  feedforwardPitch: 34,
  feedforwardYaw: 36,
  dMaxRoll: 39,
  dMaxPitch: 40,
  dMaxYaw: 41,
  dMaxGain: 42,
  dMaxAdvance: 43,
  useIntegratedYaw: 44,
  integratedYawRelax: 45,
  itermRelaxCutoff: 46,
  motorOutputLimit: 47,
  autoProfileCellCount: 48,
  dynIdleMinRpm: 49,
  feedforwardAveraging: 50,
  feedforwardSmoothFactor: 51,
  feedforwardBoost: 52,
  feedforwardMaxRateLimit: 53,
  feedforwardJitterFactor: 54,
  vbatSagCompensation: 55,
  thrustLinearization: 56,
  tpaMode: 57,
  tpaRate: 58,
  tpaBreakpoint: 59,
} as const);

/**
 * Slots the firmware serializes as a literal constant and never reads back
 * into a live field at any of the three pinned versions. They are preserved
 * byte-for-byte by the encoder and are NOT presented as settings.
 */
export const PID_ADVANCED_RESERVED_OFFSETS: readonly number[] = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 18, 19, 20, 23, 24, 26, 38,
]);

/** flight/pid.h: TPA_MODE_PD, TPA_MODE_D, and TPA_MODE_PDS behind USE_WING. */
export const TPA_MODE_PD = 0;
export const TPA_MODE_D = 1;
export const TPA_MODE_PDS = 2;
/** flight/pid.h: `#define TPA_MAX 100`, and MSP_SET_PID_ADVANCED applies it. */
export const TPA_RATE_MAX = 100;

export interface PidAdvancedRetireable {
  readonly raw: number;
  readonly lifetime: PidAdvancedFieldLifetime;
}

export interface MspPidAdvanced {
  readonly contract: PidApiContract;

  /* feedforward */
  readonly feedforwardTransition: number;
  readonly feedforward: readonly [number, number, number];
  readonly feedforwardAveraging: number;
  readonly feedforwardSmoothFactor: number;
  readonly feedforwardBoost: number;
  readonly feedforwardMaxRateLimit: number;
  readonly feedforwardJitterFactor: number;

  /* D Max - a dynamic upper bound on D, not a second static D */
  readonly dMax: readonly [number, number, number];
  readonly dMaxGain: number;
  readonly dMaxAdvance: number;

  /* throttle/pitch attenuation, PID-profile scoped since the field moved
     out of MSP_RC_TUNING */
  readonly tpaMode: number;
  readonly tpaRate: number;
  readonly tpaBreakpoint: number;

  /* i-term family */
  readonly itermRotation: number;
  readonly itermRelax: number;
  readonly itermRelaxType: number;
  readonly itermRelaxCutoff: number;

  /* the rest of the expert set */
  readonly rateAccelLimit: number;
  readonly yawRateAccelLimit: number;
  readonly angleLimit: number;
  readonly antiGravityGain: number;
  readonly throttleBoost: number;
  readonly acroTrainerAngleLimit: number;
  readonly motorOutputLimit: number;
  /** flight/pid.h declares this `int8_t`. Decoded signed on purpose. */
  readonly autoProfileCellCount: number;
  readonly dynIdleMinRpm: number;
  readonly vbatSagCompensation: number;
  readonly thrustLinearization: number;

  /* version-dependent semantics */
  readonly absControlGain: PidAdvancedRetireable;
  readonly useIntegratedYaw: PidAdvancedRetireable;
  readonly integratedYawRelax: PidAdvancedRetireable;

  readonly raw: Uint8Array;
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function i8(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt8(offset);
}

export function decodePidAdvancedFull(payload: Uint8Array, contract: PidApiContract): MspPidAdvanced {
  if (payload.length < MSP_PID_ADVANCED_BYTES) {
    throw new MspPayloadReadError(
      `MSP_PID_ADVANCED requires ${MSP_PID_ADVANCED_BYTES} bytes; received ${payload.length}.`,
    );
  }
  const o = PID_ADVANCED_OFFSETS;
  const retireable = (offset: number, lifetime: PidAdvancedFieldLifetime): PidAdvancedRetireable =>
    Object.freeze({raw: payload[offset], lifetime});
  const integratedYaw = integratedYawLifetime(contract);
  return Object.freeze({
    contract,
    feedforwardTransition: payload[o.feedforwardTransition],
    feedforward: Object.freeze([
      u16(payload, o.feedforwardRoll),
      u16(payload, o.feedforwardPitch),
      u16(payload, o.feedforwardYaw),
    ]) as readonly [number, number, number],
    feedforwardAveraging: payload[o.feedforwardAveraging],
    feedforwardSmoothFactor: payload[o.feedforwardSmoothFactor],
    feedforwardBoost: payload[o.feedforwardBoost],
    feedforwardMaxRateLimit: payload[o.feedforwardMaxRateLimit],
    feedforwardJitterFactor: payload[o.feedforwardJitterFactor],
    dMax: Object.freeze([
      payload[o.dMaxRoll],
      payload[o.dMaxPitch],
      payload[o.dMaxYaw],
    ]) as readonly [number, number, number],
    dMaxGain: payload[o.dMaxGain],
    dMaxAdvance: payload[o.dMaxAdvance],
    tpaMode: payload[o.tpaMode],
    tpaRate: payload[o.tpaRate],
    tpaBreakpoint: u16(payload, o.tpaBreakpoint),
    itermRotation: payload[o.itermRotation],
    itermRelax: payload[o.itermRelax],
    itermRelaxType: payload[o.itermRelaxType],
    itermRelaxCutoff: payload[o.itermRelaxCutoff],
    rateAccelLimit: u16(payload, o.rateAccelLimit),
    yawRateAccelLimit: u16(payload, o.yawRateAccelLimit),
    angleLimit: payload[o.angleLimit],
    antiGravityGain: u16(payload, o.antiGravityGain),
    throttleBoost: payload[o.throttleBoost],
    acroTrainerAngleLimit: payload[o.acroTrainerAngleLimit],
    motorOutputLimit: payload[o.motorOutputLimit],
    autoProfileCellCount: i8(payload, o.autoProfileCellCount),
    dynIdleMinRpm: payload[o.dynIdleMinRpm],
    vbatSagCompensation: payload[o.vbatSagCompensation],
    thrustLinearization: payload[o.thrustLinearization],
    absControlGain: retireable(o.absControlGain, absControlLifetime(contract)),
    useIntegratedYaw: retireable(o.useIntegratedYaw, integratedYaw),
    integratedYawRelax: retireable(o.integratedYawRelax, integratedYaw),
    raw: payload.slice(),
  });
}

/**
 * What the firmware will store when it is handed `requested`.
 *
 * MSP_SET_PID_ADVANCED is almost a straight copy, with exactly one
 * normalisation: `tpa_rate = MIN(value, TPA_MAX)`. Modelling it here is what
 * later lets a readback call an observed 100 against a requested 120
 * NORMALISED rather than a mismatch - while the input validation upstream
 * still refuses to send 120 in the first place.
 */
export function projectPidAdvancedWrite(requested: {readonly tpaRate: number}): {readonly tpaRate: number} {
  return Object.freeze({tpaRate: Math.min(requested.tpaRate, TPA_RATE_MAX)});
}
