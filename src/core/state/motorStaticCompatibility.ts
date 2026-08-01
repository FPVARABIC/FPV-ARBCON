/**
 * LEGACY AUDIT ARTIFACT — NOT USED BY THE CURRENT MOTOR-TEST RUNTIME.
 * The live path uses the versioned firmware capability matrix and its
 * reviewed motor-vector adapter instead of this single-board profile.
 *
 * Pass 1C - PURE, DETERMINISTIC, FAIL-CLOSED evaluation of already
 * acquired static motor facts against the single supported v1 profile.
 *
 * WHAT THIS ANSWERS, AND ONLY THIS:
 *   "Do these two bindings belong to the same exact MSP session, and do
 *    their FC-reported static facts match the one supported profile?"
 *
 * WHAT `SUPPORTED` DOES NOT MEAN. It is a STATIC CONFIGURATION MATCH and
 * nothing else. It is not readiness, not safety, not authorization, and
 * not permission to pulse a motor. In particular it says nothing about:
 * whether the FC is armed right now; whether arming-disable restrictions
 * are still in force; whether a battery is connected or healthy; whether
 * this app holds an exclusive motor-test lease; whether a stop can be
 * delivered in time; whether any native stop protection exists; or
 * whether the physical aircraft matches anything the operator described.
 * Those are later dynamic gates that do not exist yet.
 *
 * PURE. No I/O, no MSP request, no acquisition, no refresh, no polling,
 * no timer, no cache, no subscription, no inference. It consumes two
 * completed immutable bindings and returns a fresh frozen value.
 *
 * NOTHING IS INFERRED FROM ANYTHING ELSE. Motor count is read from its
 * own decoded field, never derived from the Quad X mixer. The firmware
 * version comes only from the FC's own MSP_FC_VERSION response, never
 * from the MSP API version, the "BTFL" variant, a build-time provenance
 * constant, a stored preference or operator input.
 *
 * USER-PROVIDED HARDWARE FACTS ARE ABSENT BY CONSTRUCTION - frame, ESC
 * model, ESC firmware, motor model/KV, battery brand/capacity/C-rating
 * and cell count are not evaluated here and are not FC-reported.
 */

import {MIXER_MODE_QUADX} from '../protocol/msp/decoding/decodeMixerConfig';
import {MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {motorSessionIdentitiesMatch} from './motorFcFirmwareVersion';
import type {MotorFcFirmwareVersionBinding} from './motorFcFirmwareVersion';
import type {MotorStaticFactsBinding, MotorStaticFactsSessionIdentity} from './motorStaticFacts';

/* ------------------------------------------------------------------ *
 * The single supported v1 profile, in the repository's own canonical
 * decoded units. Every constant below is the value the FC itself
 * reports - none is a display string or an operator-supplied label.
 * ------------------------------------------------------------------ */

/** MSP_FC_VARIANT, 4 ASCII bytes (msp.c @ the pinned tag,
 * FC_FIRMWARE_IDENTIFIER = "BTFL", build/version.h:26). Case-sensitive. */
export const SUPPORTED_FIRMWARE_VARIANT_IDENTIFIER = 'BTFL';

/** MSP_FC_VERSION's exact text. A suffixed pre-release such as
 * "2025.12.2-RC1" is a DIFFERENT build and is not supported. */
export const SUPPORTED_FIRMWARE_VERSION_TEXT = '2025.12.2';
/** build/version.h:28,31 - FC_VERSION_YEAR 2025 minus FC_CALVER_BASE_YEAR 2000. */
export const SUPPORTED_FIRMWARE_YEAR_OFFSET_RAW = 25;
export const SUPPORTED_FIRMWARE_YEAR = 2025;
/** build/version.h:33. */
export const SUPPORTED_FIRMWARE_MONTH = 12;
/** build/version.h:35. */
export const SUPPORTED_FIRMWARE_PATCH = 2;

/** msp_protocol.h:61-62 @ the pinned tag. Compared NUMERICALLY. */
export const SUPPORTED_API_VERSION_MAJOR = 1;
export const SUPPORTED_API_VERSION_MINOR = 47;

/** MSP_BOARD_INFO's targetName field (msp.c:693,
 * `sbufWritePString(dst, targetName)`) - the FC TARGET, never the board
 * identifier, manufacturer id, board display name or an operator label.
 * Case-sensitive. */
export const SUPPORTED_TARGET_NAME = 'SPEEDYBEEF405V4';

/** MSP_MIXER_CONFIG offset 0. flight/mixer.h:42 `MIXER_QUADX = 3`.
 * Reused from the decoder rather than restated. */
export const SUPPORTED_MIXER_MODE_RAW = MIXER_MODE_QUADX;

/** MSP_MOTOR_CONFIG offset 6 (`getMotorCount()`) - its own independently
 * decoded fact. NEVER inferred from the mixer being Quad X. */
export const SUPPORTED_MOTOR_COUNT = 4;

/** MSP_ADVANCED_CONFIG offset 3, raw motorProtocolTypes_e. DSHOT600
 * specifically - not "any DShot". Reused from the decoder. */
export const SUPPORTED_MOTOR_PROTOCOL_RAW = MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2;

/**
 * MSP_ADVANCED_CONFIG offset 6, canonical raw integer units.
 * pg/motor.h:83 @ the pinned tag declares
 * `uint16_t motorIdle; // ... in percent * 100`, so 5.5% is exactly 550.
 * Compared as an INTEGER - no floating-point tolerance, no string
 * formatting, and never converted into a motor pulse value.
 */
export const SUPPORTED_MOTOR_IDLE_RAW = 550;

/** MSP_FEATURE_CONFIG bit 12 (config/feature.h:56). Must be explicitly
 * decoded false. */
export const SUPPORTED_FEATURE_3D_ENABLED = false;

/** MSP_MIXER_CONFIG offset 1 (`yaw_motors_reversed`). FC CONFIGURATION
 * only - it is not proof of physical propeller rotation or of correct
 * props-out installation. Must be explicitly decoded true. */
export const SUPPORTED_YAW_MOTORS_REVERSED_CONFIGURED = true;

/** MSP_MOTOR_CONFIG offset 8 (`useDshotTelemetry`), raw. Must be
 * explicitly 0. */
export const SUPPORTED_DSHOT_TELEMETRY_RAW = 0;

/* ------------------------------------------------------------------ *
 * Result model
 * ------------------------------------------------------------------ */

export type MotorStaticCheckId =
  | 'FIRMWARE_VARIANT'
  | 'FIRMWARE_VERSION'
  | 'MSP_API_VERSION'
  | 'TARGET_NAME'
  | 'MIXER_MODE'
  | 'MOTOR_COUNT'
  | 'MOTOR_PROTOCOL'
  | 'MOTOR_IDLE'
  | 'FEATURE_3D_DISABLED'
  | 'YAW_MOTORS_REVERSED_ENABLED'
  | 'BIDIRECTIONAL_DSHOT_DISABLED';

/** The stable documented order every evaluation reports, always in full
 * and always exactly once per check. */
export const MOTOR_STATIC_CHECK_ORDER: readonly MotorStaticCheckId[] = Object.freeze([
  'FIRMWARE_VARIANT',
  'FIRMWARE_VERSION',
  'MSP_API_VERSION',
  'TARGET_NAME',
  'MIXER_MODE',
  'MOTOR_COUNT',
  'MOTOR_PROTOCOL',
  'MOTOR_IDLE',
  'FEATURE_3D_DISABLED',
  'YAW_MOTORS_REVERSED_ENABLED',
  'BIDIRECTIONAL_DSHOT_DISABLED',
] as const);

export type MotorStaticCheckStatus = 'STATIC_PROFILE_MATCH' | 'STATIC_PROFILE_MISMATCH';

export interface MotorStaticCheckResult {
  readonly checkId: MotorStaticCheckId;
  readonly status: MotorStaticCheckStatus;
  /** Canonical machine-stable rendering of the required value. Never a
   * localized or user-facing message - presentation belongs to a UI
   * layer that does not exist yet. */
  readonly expected: string;
  /** Canonical machine-stable rendering of what the FC actually
   * reported, including for missing or unrecognized values. */
  readonly received: string;
}

export type MotorStaticCompatibilityStatus = 'SUPPORTED' | 'UNSUPPORTED';

export interface MotorStaticCompatibility {
  /** A fresh frozen copy of the composite identity BOTH bindings agreed
   * on. Equality was proven before any fact was inspected. */
  readonly sessionIdentity: MotorStaticFactsSessionIdentity;
  /** SUPPORTED only when every single check matched. STATIC
   * CONFIGURATION ONLY - see this file's own doc comment. */
  readonly status: MotorStaticCompatibilityStatus;
  /** Every check, in MOTOR_STATIC_CHECK_ORDER, always complete. */
  readonly checks: readonly MotorStaticCheckResult[];
  /** Stable typed identifiers of every mismatching check, in the same
   * order. Empty when SUPPORTED. */
  readonly mismatchedCheckIds: readonly MotorStaticCheckId[];
}

export type MotorStaticCompatibilityEvaluation =
  | {readonly kind: 'EVALUATED'; readonly compatibility: MotorStaticCompatibility}
  | {readonly kind: 'NOT_EVALUATED'; readonly reason: 'SESSION_IDENTITY_MISMATCH'};

/* ------------------------------------------------------------------ *
 * Rendering helpers - deliberately total, so a missing or malformed
 * value produces an honest rendering rather than throwing.
 * ------------------------------------------------------------------ */

function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : `NON_FINITE(${String(value)})`;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'MISSING';
  }
  return `UNRECOGNIZED(${typeof value})`;
}

function check(
  checkId: MotorStaticCheckId,
  matched: boolean,
  expected: string,
  received: string,
): MotorStaticCheckResult {
  return Object.freeze({
    checkId,
    status: matched ? 'STATIC_PROFILE_MATCH' : 'STATIC_PROFILE_MISMATCH',
    expected,
    received,
  } as const);
}

function copySessionIdentity(
  identity: MotorStaticFactsSessionIdentity,
): MotorStaticFactsSessionIdentity {
  // Explicit field copy, never a spread of the caller's object.
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

/**
 * Evaluates two completed bindings against the supported v1 profile.
 *
 * A configuration mismatch is a NORMAL RESULT, never a thrown error.
 * Identity incoherence is different in kind: it prevents evaluation
 * entirely and yields NOT_EVALUATED with no checks and no compatibility
 * result, because facts from two different sessions must never be
 * combined, reported together, or partially compared.
 *
 * Every check runs - there is no short-circuit on the first mismatch -
 * so a caller sees the complete picture in one pass.
 */
export function evaluateMotorStaticCompatibility(
  staticFactsBinding: MotorStaticFactsBinding,
  firmwareVersionBinding: MotorFcFirmwareVersionBinding,
): MotorStaticCompatibilityEvaluation {
  // GATE: exact composite-identity equality, BY VALUE, before a single
  // fact is looked at. Neither binding's identity is treated as
  // authoritative on mismatch - the evaluation simply does not happen.
  if (
    !motorSessionIdentitiesMatch(
      staticFactsBinding.sessionIdentity,
      firmwareVersionBinding.sessionIdentity,
    )
  ) {
    return Object.freeze({kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'} as const);
  }

  const facts = staticFactsBinding.facts;
  const identity = facts.flightControllerIdentity;
  const firmware = identity.firmware;
  const apiVersion = identity.apiVersion;
  const board = identity.board;
  const version = firmwareVersionBinding.firmwareVersion;

  const firmwareVersionMatched =
    version.yearOffsetRaw === SUPPORTED_FIRMWARE_YEAR_OFFSET_RAW &&
    version.year === SUPPORTED_FIRMWARE_YEAR &&
    version.month === SUPPORTED_FIRMWARE_MONTH &&
    version.patch === SUPPORTED_FIRMWARE_PATCH &&
    version.versionString === SUPPORTED_FIRMWARE_VERSION_TEXT &&
    version.suffix === null;

  const apiVersionMatched =
    apiVersion.apiVersionMajor === SUPPORTED_API_VERSION_MAJOR &&
    apiVersion.apiVersionMinor === SUPPORTED_API_VERSION_MINOR;

  const checks: readonly MotorStaticCheckResult[] = Object.freeze([
    check(
      'FIRMWARE_VARIANT',
      firmware.identifier === SUPPORTED_FIRMWARE_VARIANT_IDENTIFIER,
      SUPPORTED_FIRMWARE_VARIANT_IDENTIFIER,
      renderValue(firmware.identifier),
    ),
    check(
      'FIRMWARE_VERSION',
      firmwareVersionMatched,
      // The full coherent final-release fact set, not just the text.
      `${SUPPORTED_FIRMWARE_VERSION_TEXT} (yearOffsetRaw ${SUPPORTED_FIRMWARE_YEAR_OFFSET_RAW}, ` +
        `${SUPPORTED_FIRMWARE_YEAR}.${SUPPORTED_FIRMWARE_MONTH}.${SUPPORTED_FIRMWARE_PATCH}, no suffix)`,
      `${renderValue(version.versionString)} (yearOffsetRaw ${renderValue(version.yearOffsetRaw)}, ` +
        `${renderValue(version.year)}.${renderValue(version.month)}.${renderValue(version.patch)}, ` +
        `suffix ${renderValue(version.suffix)})`,
    ),
    check(
      'MSP_API_VERSION',
      apiVersionMatched,
      `${SUPPORTED_API_VERSION_MAJOR}.${SUPPORTED_API_VERSION_MINOR}`,
      `${renderValue(apiVersion.apiVersionMajor)}.${renderValue(apiVersion.apiVersionMinor)}`,
    ),
    check(
      'TARGET_NAME',
      board.targetName === SUPPORTED_TARGET_NAME,
      SUPPORTED_TARGET_NAME,
      renderValue(board.targetName),
    ),
    check(
      'MIXER_MODE',
      facts.mixerModeRaw === SUPPORTED_MIXER_MODE_RAW,
      String(SUPPORTED_MIXER_MODE_RAW),
      renderValue(facts.mixerModeRaw),
    ),
    check(
      'MOTOR_COUNT',
      facts.motorCount === SUPPORTED_MOTOR_COUNT,
      String(SUPPORTED_MOTOR_COUNT),
      renderValue(facts.motorCount),
    ),
    check(
      'MOTOR_PROTOCOL',
      facts.motorProtocolRaw === SUPPORTED_MOTOR_PROTOCOL_RAW,
      String(SUPPORTED_MOTOR_PROTOCOL_RAW),
      renderValue(facts.motorProtocolRaw),
    ),
    check(
      'MOTOR_IDLE',
      facts.motorIdleRaw === SUPPORTED_MOTOR_IDLE_RAW,
      String(SUPPORTED_MOTOR_IDLE_RAW),
      renderValue(facts.motorIdleRaw),
    ),
    check(
      'FEATURE_3D_DISABLED',
      facts.feature3dEnabled === SUPPORTED_FEATURE_3D_ENABLED,
      String(SUPPORTED_FEATURE_3D_ENABLED),
      renderValue(facts.feature3dEnabled),
    ),
    check(
      'YAW_MOTORS_REVERSED_ENABLED',
      facts.yawMotorsReversedConfigured === SUPPORTED_YAW_MOTORS_REVERSED_CONFIGURED,
      String(SUPPORTED_YAW_MOTORS_REVERSED_CONFIGURED),
      renderValue(facts.yawMotorsReversedConfigured),
    ),
    check(
      'BIDIRECTIONAL_DSHOT_DISABLED',
      facts.dshotTelemetryRaw === SUPPORTED_DSHOT_TELEMETRY_RAW,
      String(SUPPORTED_DSHOT_TELEMETRY_RAW),
      renderValue(facts.dshotTelemetryRaw),
    ),
  ]);

  const mismatchedCheckIds: readonly MotorStaticCheckId[] = Object.freeze(
    checks
      .filter(entry => entry.status === 'STATIC_PROFILE_MISMATCH')
      .map(entry => entry.checkId),
  );

  return Object.freeze({
    kind: 'EVALUATED',
    compatibility: Object.freeze({
      sessionIdentity: copySessionIdentity(staticFactsBinding.sessionIdentity),
      status: mismatchedCheckIds.length === 0 ? 'SUPPORTED' : 'UNSUPPORTED',
      checks,
      mismatchedCheckIds,
    } as const),
  } as const);
}
