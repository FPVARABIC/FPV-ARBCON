/**
 * WHAT A FILTER WRITE DOES OUTSIDE THE FILTER SETTINGS, TO THE EXACT VALUE.
 *
 * `MSP_SET_FILTER_CONFIG` ends by calling `validateAndFixGyroConfig()`
 * (msp.c:3133 -> config.c:554). That function does not only correct filter
 * frequencies: it can also change `pid_process_denom`, the motor protocol and
 * the motor PWM rate - three truths this screen does not own and does not
 * show.
 *
 * WHY DIRECTION IS NOT ENOUGH. An earlier version of this model accepted any
 * denominator that ROSE, any PWM rate that FELL and any change to DSHOT300.
 * That is not a verification: a board that answered `pid_process_denom = 8`
 * where the rule predicts 2 would have been reported as a successful save
 * with an explained side effect. So every prediction below is an exact VALUE,
 * computed before the write from the same inputs the firmware uses, and an
 * observation is accepted only when it equals that value.
 *
 * WHY SOME OF IT CANNOT BE PREDICTED AT ALL. The first correction inside
 * `validateAndFixGyroConfig` is compiled in only when the TARGET defines
 * `USE_PID_DENOM_CHECK`, and is further gated on `cpu_overclock <
 * USE_PID_DENOM_OVERCLOCK_LEVEL` when that macro exists:
 *
 *     src/platform/STM32/target/STM32F405/target.h:80  USE_PID_DENOM_CHECK
 *     src/platform/STM32/target/STM32F411/target.h:79  USE_PID_DENOM_CHECK
 *     src/platform/STM32/target/STM32G47X/target.h:78  USE_PID_DENOM_CHECK
 *     src/platform/APM32/target/APM32F405/target.h:85  USE_PID_DENOM_CHECK
 *
 * Neither the macro nor `cpu_overclock` travels over MSP. So on a board with
 * DShot telemetry enabled we CANNOT know whether that branch exists, and the
 * honest answer for the truths it touches is NOT_PROVEN rather than a guess
 * in either direction. A caller must fail closed on that, not bless it.
 *
 * Every constant and every branch below is read from the pinned API 1.47 tree
 * and re-checked at 1.48 and 1.49.
 */

import {
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
} from '../protocol/msp/decoding/decodeAdvancedConfig';

/**
 * The PWM-family `motorProtocolTypes_e` positions, declared here rather than
 * imported from the Motors domain module.
 *
 * That module pulls in the motor-test write encoders, and the
 * production-bundle scanner deliberately fences those off so that only the
 * motor-test path can reach them. Depending on it from the PID page to read
 * five integers would have widened that fence for no benefit. A test asserts
 * these agree with the Motors module's own copies, so a divergence is a
 * failure rather than a silent second opinion.
 *
 * `src/main/drivers/motor_types.h:37-51` at the pinned commit.
 */
export const MOTOR_PROTOCOL_RAW_PWM = 0;
export const MOTOR_PROTOCOL_RAW_ONESHOT125 = 1;
export const MOTOR_PROTOCOL_RAW_ONESHOT42 = 2;
export const MOTOR_PROTOCOL_RAW_MULTISHOT = 3;
export const MOTOR_PROTOCOL_RAW_BRUSHED = 4;

/** `src/main/pg/motor.h:32` - BRUSHLESS_MOTORS_PWM_RATE. */
export const BRUSHLESS_MOTORS_PWM_RATE = 480;
/** `src/main/flight/pid.h:33` - MAX_PID_PROCESS_DENOM. */
export const MAX_PID_PROCESS_DENOM = 16;
/** `config.c:597` - the sample rate above which the denom floor is forced. */
export const PID_DENOM_FORCE_SAMPLE_RATE_HZ = 4000;

/**
 * `checkMotorProtocolEnabled` (drivers/motor.c:152) reports DShot for exactly
 * these four protocols. It is the test the PWM-rate clamp uses.
 */
const DSHOT_PROTOCOL_RAWS: ReadonlySet<number> = new Set([
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
]);

/**
 * `config.c:604-624` - the motor update restriction, in SECONDS, per
 * protocol. Every entry that reaches the PWM-rate clamp yields an exact
 * integer when inverted, so the firmware's `lrintf` rounding mode never
 * matters here.
 */
export function motorUpdateRestrictionSeconds(protocolRaw: number): number {
  switch (protocolRaw) {
    case MOTOR_PROTOCOL_RAW_PWM: return 1 / BRUSHLESS_MOTORS_PWM_RATE;
    case MOTOR_PROTOCOL_RAW_ONESHOT125: return 0.0005;
    case MOTOR_PROTOCOL_RAW_ONESHOT42: return 0.0001;
    case MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2: return 0.000250;
    case MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2: return 0.0001;
    // MULTISHOT, BRUSHED, DSHOT600, PROSHOT1000, DISABLED and anything
    // unrecognised share the `default:` arm.
    default: return 0.00003125;
  }
}

/** Everything `validateAndFixGyroConfig` reads before it can decide. */
export interface GyroValidationInputs {
  /** `gyro.sampleRateHz`. Zero or absent disables the whole block. */
  readonly gyroSampleRateHz: number | undefined;
  readonly pidProcessDenom: number;
  readonly useContinuousUpdate: boolean;
  readonly motorProtocolRaw: number;
  readonly motorPwmRate: number;
  /** `motorConfig()->dev.useDshotTelemetry`, from MSP_MOTOR_CONFIG. */
  readonly useDshotTelemetry: boolean;
}

export type SideEffectPrediction =
  | {readonly kind: 'EXACT'; readonly value: number}
  | {readonly kind: 'NOT_PROVEN'; readonly reason: SideEffectUnknownReason};

/** Why an exact value cannot be computed from what MSP can tell us. */
export type SideEffectUnknownReason =
  /** `USE_PID_DENOM_CHECK` / `cpu_overclock` are build-time and invisible. */
  | 'TARGET_PID_DENOM_CHECK_NOT_OBSERVABLE'
  /** The denom depends on a protocol whose post-validation value is unknown. */
  | 'DEPENDS_ON_UNPROVEN_MOTOR_PROTOCOL'
  /** No loop rate was reported, so none of the block can be evaluated. */
  | 'GYRO_SAMPLE_RATE_UNKNOWN';

export interface GyroValidationProjection {
  readonly motorProtocolRaw: SideEffectPrediction;
  readonly pidProcessDenom: SideEffectPrediction;
  readonly motorPwmRate: SideEffectPrediction;
}

const exact = (value: number): SideEffectPrediction => Object.freeze({kind: 'EXACT', value});
const notProven = (reason: SideEffectUnknownReason): SideEffectPrediction =>
  Object.freeze({kind: 'NOT_PROVEN', reason});

/**
 * The exact post-validation values, or an explicit refusal to predict.
 *
 * Reproduces `config.c:554-659` in the firmware's own order: the
 * DShot-telemetry branch first, then the protocol restriction table, then
 * either the PWM-rate clamp (continuous update) or the denominator floor
 * (everything else).
 */
export function projectGyroValidation(inputs: GyroValidationInputs): GyroValidationProjection {
  const rate = inputs.gyroSampleRateHz;
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    // `if (gyro.sampleRateHz > 0)` guards the entire block, so nothing below
    // it can run - but we cannot prove that from a board that never told us
    // its loop rate, so this is unknown rather than "unchanged".
    return Object.freeze({
      motorProtocolRaw: notProven('GYRO_SAMPLE_RATE_UNKNOWN'),
      pidProcessDenom: notProven('GYRO_SAMPLE_RATE_UNKNOWN'),
      motorPwmRate: notProven('GYRO_SAMPLE_RATE_UNKNOWN'),
    });
  }

  // --- the unobservable branch -----------------------------------------
  // `if (cpu_overclock < USE_PID_DENOM_OVERCLOCK_LEVEL && useDshotTelemetry)`
  // inside `#if defined(USE_DSHOT) && defined(USE_PID_DENOM_CHECK)`.
  const protocolMayBeDowngraded =
    inputs.useDshotTelemetry && inputs.motorProtocolRaw === MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2;
  const denomMayBeForced = inputs.useDshotTelemetry && rate > PID_DENOM_FORCE_SAMPLE_RATE_HZ;

  const motorProtocolRaw: SideEffectPrediction = protocolMayBeDowngraded
    ? notProven('TARGET_PID_DENOM_CHECK_NOT_OBSERVABLE')
    // Nothing else in this function assigns the protocol, so it stands.
    : exact(inputs.motorProtocolRaw);

  // --- the PWM rate ------------------------------------------------------
  // Clamped only under continuous update, and only for a protocol that is
  // neither DShot nor plain PWM. The DShot-telemetry branch can only turn
  // DSHOT600 into DSHOT300 - still DShot - so an unproven protocol never
  // changes whether this clamp applies.
  let motorPwmRate = inputs.motorPwmRate;
  if (inputs.useContinuousUpdate) {
    const isDshot = DSHOT_PROTOCOL_RAWS.has(inputs.motorProtocolRaw);
    if (!isDshot && inputs.motorProtocolRaw !== MOTOR_PROTOCOL_RAW_PWM) {
      const maxEscRate = Math.round(1 / motorUpdateRestrictionSeconds(inputs.motorProtocolRaw));
      motorPwmRate = Math.min(motorPwmRate, maxEscRate);
    }
  }

  // --- the denominator ---------------------------------------------------
  let pidProcessDenom: SideEffectPrediction;
  if (denomMayBeForced) {
    pidProcessDenom = notProven('TARGET_PID_DENOM_CHECK_NOT_OBSERVABLE');
  } else if (inputs.useContinuousUpdate) {
    // The `else` arm below never runs, so the denominator is untouched.
    pidProcessDenom = exact(inputs.pidProcessDenom);
  } else if (motorProtocolRaw.kind !== 'EXACT') {
    // The restriction table is keyed by the protocol, so an unproven protocol
    // makes the denominator unprovable too.
    pidProcessDenom = notProven('DEPENDS_ON_UNPROVEN_MOTOR_PROTOCOL');
  } else {
    const samplingTime = 1 / rate;
    let restriction = motorUpdateRestrictionSeconds(motorProtocolRaw.value);
    if (inputs.useDshotTelemetry) restriction *= 2;
    const pidLooptime = samplingTime * inputs.pidProcessDenom;
    let denom = inputs.pidProcessDenom;
    if (pidLooptime < restriction) {
      const ratio = restriction / samplingTime;
      // `uint8_t minPidProcessDenom = motorUpdateRestriction / samplingTime;`
      // truncates on the way into the byte, and the next line rounds up when
      // anything was lost.
      let minimum = Math.trunc(ratio) % 256;
      if (ratio > minimum) minimum += 1;
      minimum = Math.min(Math.max(minimum, 1), MAX_PID_PROCESS_DENOM);
      denom = Math.max(denom, minimum);
    }
    pidProcessDenom = exact(denom);
  }

  return Object.freeze({motorProtocolRaw, pidProcessDenom, motorPwmRate: exact(motorPwmRate)});
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export type CrossSubsystemTruth = 'PID_PROCESS_DENOM' | 'MOTOR_PROTOCOL' | 'MOTOR_PWM_RATE';

export interface AdvancedConfigWitness {
  readonly pidProcessDenom: number;
  readonly motorProtocolRaw: number;
  readonly motorPwmRate: number;
}

export type CrossSubsystemVerdict =
  /** The rule predicts no change, and none happened. */
  | {readonly kind: 'UNCHANGED_EXPECTED'}
  /** The rule predicts an exact new value, and the board produced it. */
  | {readonly kind: 'NORMALISED_EXPECTED'; readonly before: number; readonly after: number}
  /** The board holds something neither the old truth nor the predicted one. */
  | {readonly kind: 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE'; readonly before: number; readonly predicted: number; readonly after: number}
  /** Something moved that MSP cannot let us predict exactly. */
  | {readonly kind: 'PREDICTION_NOT_PROVEN'; readonly before: number; readonly after: number; readonly reason: SideEffectUnknownReason};

export interface CrossSubsystemEntry {
  readonly truth: CrossSubsystemTruth;
  readonly verdict: CrossSubsystemVerdict;
}

export interface CrossSubsystemReport {
  readonly entries: readonly CrossSubsystemEntry[];
  /** Predicted exactly, and moved. Reported, never hidden. */
  readonly normalised: readonly CrossSubsystemEntry[];
  /** Neither the old value nor the predicted one. Never a success. */
  readonly unexpected: readonly CrossSubsystemEntry[];
  /** Moved, and MSP cannot prove what it should have moved to. */
  readonly notProven: readonly CrossSubsystemEntry[];
  /** Every truth that moved, whatever the verdict - all are stale elsewhere. */
  readonly requiresReobserve: readonly CrossSubsystemTruth[];
}

function classifyOne(
  before: number,
  prediction: SideEffectPrediction,
  after: number,
): CrossSubsystemVerdict {
  if (prediction.kind === 'NOT_PROVEN') {
    // Nothing moved, so there is nothing to bless or refuse.
    if (after === before) return Object.freeze({kind: 'UNCHANGED_EXPECTED'});
    return Object.freeze({kind: 'PREDICTION_NOT_PROVEN', before, after, reason: prediction.reason});
  }
  if (after === prediction.value) {
    return after === before
      ? Object.freeze({kind: 'UNCHANGED_EXPECTED'})
      : Object.freeze({kind: 'NORMALISED_EXPECTED', before, after});
  }
  return Object.freeze({kind: 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE', before, predicted: prediction.value, after});
}

/**
 * Compare the observed advanced configuration against the EXACT projection.
 *
 * There is deliberately no direction test anywhere in here.
 */
export function classifyGyroValidationSideEffects(
  before: AdvancedConfigWitness,
  projection: GyroValidationProjection,
  after: AdvancedConfigWitness,
): CrossSubsystemReport {
  const entries: CrossSubsystemEntry[] = [
    {truth: 'PID_PROCESS_DENOM', verdict: classifyOne(before.pidProcessDenom, projection.pidProcessDenom, after.pidProcessDenom)},
    {truth: 'MOTOR_PROTOCOL', verdict: classifyOne(before.motorProtocolRaw, projection.motorProtocolRaw, after.motorProtocolRaw)},
    {truth: 'MOTOR_PWM_RATE', verdict: classifyOne(before.motorPwmRate, projection.motorPwmRate, after.motorPwmRate)},
  ];
  const of = (kind: CrossSubsystemVerdict['kind']): readonly CrossSubsystemEntry[] =>
    Object.freeze(entries.filter(entry => entry.verdict.kind === kind));
  return Object.freeze({
    entries: Object.freeze(entries),
    normalised: of('NORMALISED_EXPECTED'),
    unexpected: of('UNEXPECTED_CROSS_SUBSYSTEM_CHANGE'),
    notProven: of('PREDICTION_NOT_PROVEN'),
    requiresReobserve: Object.freeze(
      entries.filter(entry => entry.verdict.kind !== 'UNCHANGED_EXPECTED').map(entry => entry.truth),
    ),
  });
}

/**
 * THE PROFILE-INDEX REPAIR, AND WHY IT IS NOT IN THIS MODEL.
 *
 * `validateAndFixGyroConfig` ends with (config.c:650-658):
 *
 *     if (activeRateProfile >= CONTROL_RATE_PROFILE_COUNT) activeRateProfile = 0;
 *     loadControlRateProfile();
 *     if (pidProfileIndex >= PID_PROFILE_COUNT) pidProfileIndex = 0;
 *     loadPidProfile();
 *
 * so a filter write really is on the call path that can repair a profile
 * index. But both repairs are conditional on the STORED index already being
 * out of range, and a save only reaches the write after reading both indices
 * from MSP_STATUS_EX and finding them in range. The repair therefore cannot
 * fire during this transaction, and modelling it would be inventing a side
 * effect the actual call chain cannot produce.
 *
 * Exported as a fact so a test can hold the reasoning rather than the comment.
 */
export function profileIndexRepairPossible(
  pidProfileIndex: number,
  pidProfileCount: number,
  rateProfileIndex: number,
  rateProfileCount: number,
): boolean {
  return pidProfileIndex >= pidProfileCount || rateProfileIndex >= rateProfileCount;
}
