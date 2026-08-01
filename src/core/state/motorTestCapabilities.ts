/**
 * LEGACY AUDIT ARTIFACT — NOT USED BY THE CURRENT MOTOR-TEST RUNTIME.
 * The live path uses `motorFirmwareCompatibility.ts` plus the reviewed
 * version-specific motor-vector adapter.
 *
 * Phase 2B - the PURE, session-bound motor-test capability snapshot.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A total, side-effect-free composer that answers exactly one question:
 * does a set of ALREADY-NORMALIZED static facts match the one narrowly
 * approved hardware/firmware profile? It returns an inert, deeply frozen
 * record of that answer, bound to one opaque session authority.
 *
 * WHAT "PROFILE_SUPPORTED" MEANS - AND WHAT IT NEVER MEANS
 * -------------------------------------------------------
 * It means ONLY: "the static evidence handed to this function matches the
 * approved profile". That is a COMPATIBILITY statement about
 * configuration, nothing else.
 *
 * It does NOT mean, and must never be read as meaning, that motor testing
 * is authorized, safe, ready, armed-safe, battery-safe, or permitted to
 * reach a wire. It says nothing about armed state, arming-disable flags,
 * BOX IDs, battery condition, telemetry, transport health, motor
 * direction, or whether any motor can be stopped. Every one of those is a
 * LIVE gate owned by a later pass, and none of them is represented here.
 *
 * Possessing this object confers no capability whatsoever. It carries no
 * command, no motor index, no motor value, no payload, no client, no
 * transport, no writer, no lease, no callback and no native handle - only
 * primitives, and the caller's own opaque authority reference.
 *
 * WHERE THE EVIDENCE COMES FROM
 * -----------------------------
 * NOT from here. This module performs no I/O and reads nothing from a
 * flight controller. It evaluates values supplied by its caller. Mapping
 * official MSP replies onto these normalized fields is a separate,
 * later adapter pass, and this file deliberately contains none of that
 * mapping - no command id, no wire offset, no enum decoding.
 *
 * FAIL-CLOSED BY CONSTRUCTION
 * ---------------------------
 * Anything missing, malformed, non-finite, mistyped, mis-cased,
 * whitespace-padded, near-but-not-equal, or simply outside the approved
 * profile yields PROFILE_UNSUPPORTED with an explicit blocker. There is
 * no permissive default anywhere, nothing is trimmed, case-folded,
 * coerced or rounded into acceptance, and unsupported evidence never
 * throws - a caller must be able to ask this question safely about
 * arbitrary input.
 */

import type {MotorTestSessionAuthority} from './motorTestStateMachine';

export type {MotorTestSessionAuthority};

/* ------------------------------------------------------------------ *
 * The approved profile
 * ------------------------------------------------------------------ */

/**
 * The one approved static profile, in NORMALIZED units.
 *
 * Every value here is the exact literal a caller's evidence must equal.
 * Exported so a caller - and this module's own tests - can build a
 * conforming input without restating magic values, and so any future
 * change to the approved profile happens in exactly one place.
 *
 * Normalization contract, stated once:
 *  - `fcVariantIdentifier` is the firmware's own 4-character variant
 *    identifier, verbatim and case-sensitive.
 *  - `apiVersionMajor` / `apiVersionMinor` are the two MSP API version
 *    components as plain integers, i.e. 1 and 47 for API "1.47".
 *  - `firmwareYear` / `firmwareMonth` / `firmwarePatch` are the calendar
 *    version components as plain integers, i.e. 2025, 12 and 2 for the
 *    "2025.12.2" release. The YEAR IS ALREADY FULL - any offset encoding
 *    used on the wire must be undone by the adapter before it reaches
 *    this module.
 *  - `boardTargetName` is the board target identifier, verbatim and
 *    case-sensitive.
 *  - `mixerProfile` and `motorProtocol` are normalized TOKENS, not raw
 *    firmware enum values. Translating an enum into a token is the
 *    adapter's job precisely so that a version-sensitive number is never
 *    compared here.
 *  - `motorIdleHundredthsPercent` is motor idle in HUNDREDTHS OF A
 *    PERCENT, so the approved 5.5% is the exact integer 550. It is a
 *    CONFIGURATION reading only; no motor command may be derived from
 *    it, and this module derives none.
 *  - the three booleans are configuration flags, true meaning the named
 *    condition is enabled.
 */
export const MOTOR_TEST_SUPPORTED_PROFILE = Object.freeze({
  fcVariantIdentifier: 'BTFL',
  apiVersionMajor: 1,
  apiVersionMinor: 47,
  firmwareYear: 2025,
  firmwareMonth: 12,
  firmwarePatch: 2,
  boardTargetName: 'SPEEDYBEEF405V4',
  mixerProfile: 'QUAD_X',
  motorCount: 4,
  motorProtocol: 'DSHOT600',
  motorIdleHundredthsPercent: 550,
  feature3dEnabled: false,
  propsOutConfigured: true,
  bidirectionalDshotEnabled: false,
});

/** The normalized snapshot exposed on a supported result. Field for
 * field identical to MOTOR_TEST_SUPPORTED_PROFILE, but always a freshly
 * built frozen copy so no caller shares storage with the constant. */
export interface MotorTestProfileSnapshot {
  readonly fcVariantIdentifier: string;
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
  readonly firmwareYear: number;
  readonly firmwareMonth: number;
  readonly firmwarePatch: number;
  readonly boardTargetName: string;
  readonly mixerProfile: string;
  readonly motorCount: number;
  readonly motorProtocol: string;
  readonly motorIdleHundredthsPercent: number;
  readonly feature3dEnabled: boolean;
  readonly propsOutConfigured: boolean;
  readonly bidirectionalDshotEnabled: boolean;
}

/**
 * Caller-supplied evidence.
 *
 * Every member is `unknown` and optional ON PURPOSE. This function is a
 * validation boundary: it must be callable with anything at all - a
 * partially-decoded response, a hand-built object, a value that turned
 * out to be `undefined` - and must answer without throwing. Typing the
 * input strictly would push the failure earlier, into a cast, which is
 * exactly where a fail-closed check stops being one.
 */
export interface MotorTestProfileEvidence {
  readonly fcVariantIdentifier?: unknown;
  readonly apiVersionMajor?: unknown;
  readonly apiVersionMinor?: unknown;
  readonly firmwareYear?: unknown;
  readonly firmwareMonth?: unknown;
  readonly firmwarePatch?: unknown;
  readonly boardTargetName?: unknown;
  readonly mixerProfile?: unknown;
  readonly motorCount?: unknown;
  readonly motorProtocol?: unknown;
  readonly motorIdleHundredthsPercent?: unknown;
  readonly feature3dEnabled?: unknown;
  readonly propsOutConfigured?: unknown;
  readonly bidirectionalDshotEnabled?: unknown;
}

/* ------------------------------------------------------------------ *
 * Blockers
 * ------------------------------------------------------------------ */

/** One profile fact. The list is this module's own vocabulary; it is
 * deliberately not the wire's, so no command or offset appears. */
export type MotorTestProfileFact =
  | 'FC_VARIANT'
  | 'MSP_API_VERSION'
  | 'FIRMWARE_VERSION'
  | 'BOARD_TARGET'
  | 'MIXER_PROFILE'
  | 'MOTOR_COUNT'
  | 'MOTOR_PROTOCOL'
  | 'MOTOR_IDLE'
  | 'FEATURE_3D'
  | 'PROPS_OUT_CONFIGURATION'
  | 'BIDIRECTIONAL_DSHOT';

/**
 * Why a fact blocked the profile.
 *
 * The distinction is load-bearing for a future operator message: "we
 * could not read this" is a different problem from "we read it and this
 * build is out of scope", and collapsing the two would hide a decoding
 * bug behind an apparently deliberate incompatibility.
 */
export type MotorTestCapabilityBlockerKind =
  /** Absent, wrong type, non-finite, or otherwise unusable as evidence. */
  | 'EVIDENCE_MISSING_OR_INVALID'
  /** Well-formed and understood, but not the approved profile. */
  | 'EVIDENCE_UNSUPPORTED';

export interface MotorTestCapabilityBlocker {
  readonly fact: MotorTestProfileFact;
  readonly kind: MotorTestCapabilityBlockerKind;
}

/** Fixed, module-owned evaluation order. Blocker order therefore depends
 * only on WHICH facts failed, never on the key order of the caller's
 * object - two callers passing the same problems in different shapes get
 * byte-identical blocker lists. At most one blocker exists per fact, so
 * the list is duplicate-free by construction. */
const FACT_ORDER: readonly MotorTestProfileFact[] = Object.freeze([
  'FC_VARIANT',
  'MSP_API_VERSION',
  'FIRMWARE_VERSION',
  'BOARD_TARGET',
  'MIXER_PROFILE',
  'MOTOR_COUNT',
  'MOTOR_PROTOCOL',
  'MOTOR_IDLE',
  'FEATURE_3D',
  'PROPS_OUT_CONFIGURATION',
  'BIDIRECTIONAL_DSHOT',
]);

/** Shared frozen empty list, so a supported result allocates nothing
 * mutable and every caller observes the same inert value. */
const NO_BLOCKERS: readonly MotorTestCapabilityBlocker[] = Object.freeze([]);

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

export type MotorTestCapabilities =
  | {
      /** STATIC PROFILE COMPATIBILITY ONLY. Read this file's own doc
       * comment before treating it as anything else: it is never
       * authorization, readiness or safety. */
      readonly status: 'PROFILE_SUPPORTED';
      /** The exact object the caller supplied. Identity is the whole
       * point; it is never cloned, inspected or serialized. */
      readonly authority: MotorTestSessionAuthority;
      readonly profile: MotorTestProfileSnapshot;
      /** Always empty on a supported result. */
      readonly blockers: readonly MotorTestCapabilityBlocker[];
    }
  | {
      readonly status: 'PROFILE_UNSUPPORTED';
      readonly authority: MotorTestSessionAuthority;
      /** Non-empty, ordered by FACT_ORDER, duplicate-free. A normalized
       * profile is deliberately NOT exposed here: half-valid evidence
       * must not be readable as if it described the aircraft. */
      readonly blockers: readonly MotorTestCapabilityBlocker[];
    };

/* ------------------------------------------------------------------ *
 * Validation - total, and never permissive
 * ------------------------------------------------------------------ */

type BlockerKind = MotorTestCapabilityBlockerKind | undefined;

function checkExactString(value: unknown, expected: string): BlockerKind {
  if (typeof value !== 'string') {
    return 'EVIDENCE_MISSING_OR_INVALID';
  }
  // No trim, no case-fold. Padded or mis-cased evidence is a real
  // mismatch, and quietly repairing it would let an unverified build
  // through under a name it does not actually report.
  return value === expected ? undefined : 'EVIDENCE_UNSUPPORTED';
}

function checkExactInteger(value: unknown, expected: number): BlockerKind {
  // Number.isInteger is false for NaN, both infinities and every
  // fractional value, so all three are classed as unusable evidence
  // rather than as a supportable-but-different build.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 'EVIDENCE_MISSING_OR_INVALID';
  }
  return value === expected ? undefined : 'EVIDENCE_UNSUPPORTED';
}

function checkExactBoolean(value: unknown, expected: boolean): BlockerKind {
  if (typeof value !== 'boolean') {
    return 'EVIDENCE_MISSING_OR_INVALID';
  }
  return value === expected ? undefined : 'EVIDENCE_UNSUPPORTED';
}

/** Combines the components of a multi-part fact. Unusable evidence
 * outranks unsupported evidence: if any component could not be read, the
 * honest report is that the fact could not be established at all. */
function worstOf(kinds: readonly BlockerKind[]): BlockerKind {
  let unsupported = false;
  for (const kind of kinds) {
    if (kind === 'EVIDENCE_MISSING_OR_INVALID') {
      return 'EVIDENCE_MISSING_OR_INVALID';
    }
    if (kind === 'EVIDENCE_UNSUPPORTED') {
      unsupported = true;
    }
  }
  return unsupported ? 'EVIDENCE_UNSUPPORTED' : undefined;
}

function evaluateFact(
  fact: MotorTestProfileFact,
  evidence: MotorTestProfileEvidence,
): BlockerKind {
  const want = MOTOR_TEST_SUPPORTED_PROFILE;
  switch (fact) {
    case 'FC_VARIANT':
      return checkExactString(
        evidence.fcVariantIdentifier,
        want.fcVariantIdentifier,
      );
    case 'MSP_API_VERSION':
      return worstOf([
        checkExactInteger(evidence.apiVersionMajor, want.apiVersionMajor),
        checkExactInteger(evidence.apiVersionMinor, want.apiVersionMinor),
      ]);
    case 'FIRMWARE_VERSION':
      return worstOf([
        checkExactInteger(evidence.firmwareYear, want.firmwareYear),
        checkExactInteger(evidence.firmwareMonth, want.firmwareMonth),
        checkExactInteger(evidence.firmwarePatch, want.firmwarePatch),
      ]);
    case 'BOARD_TARGET':
      return checkExactString(evidence.boardTargetName, want.boardTargetName);
    case 'MIXER_PROFILE':
      return checkExactString(evidence.mixerProfile, want.mixerProfile);
    case 'MOTOR_COUNT':
      return checkExactInteger(evidence.motorCount, want.motorCount);
    case 'MOTOR_PROTOCOL':
      return checkExactString(evidence.motorProtocol, want.motorProtocol);
    case 'MOTOR_IDLE':
      return checkExactInteger(
        evidence.motorIdleHundredthsPercent,
        want.motorIdleHundredthsPercent,
      );
    case 'FEATURE_3D':
      return checkExactBoolean(evidence.feature3dEnabled, want.feature3dEnabled);
    case 'PROPS_OUT_CONFIGURATION':
      return checkExactBoolean(
        evidence.propsOutConfigured,
        want.propsOutConfigured,
      );
    case 'BIDIRECTIONAL_DSHOT':
      return checkExactBoolean(
        evidence.bidirectionalDshotEnabled,
        want.bidirectionalDshotEnabled,
      );
    default:
      // Compile-time exhaustiveness: a new fact cannot be added to
      // MotorTestProfileFact without being evaluated here. Deliberately
      // does not throw - see the file comment on remaining total.
      return assertExhaustive(fact);
  }
}

function assertExhaustive(value: never): BlockerKind {
  // A `never` value is assignable to anything, so this consumes the
  // parameter without any runtime behaviour. Unreachable in practice;
  // classed as unusable evidence if it ever were reached, because an
  // unevaluated fact has certainly not been established.
  return value;
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Builds the frozen normalized snapshot from the APPROVED constants
 * rather than by re-reading the caller's object.
 *
 * That is deliberate and is what detaches the result from caller-owned
 * storage: this branch is reachable only when every fact was already
 * proven equal to the approved value, so copying from the constant
 * yields an identical snapshot that shares no reference with the input
 * and cannot be changed by mutating it afterwards.
 */
function buildProfileSnapshot(): MotorTestProfileSnapshot {
  const want = MOTOR_TEST_SUPPORTED_PROFILE;
  return Object.freeze({
    fcVariantIdentifier: want.fcVariantIdentifier,
    apiVersionMajor: want.apiVersionMajor,
    apiVersionMinor: want.apiVersionMinor,
    firmwareYear: want.firmwareYear,
    firmwareMonth: want.firmwareMonth,
    firmwarePatch: want.firmwarePatch,
    boardTargetName: want.boardTargetName,
    mixerProfile: want.mixerProfile,
    motorCount: want.motorCount,
    motorProtocol: want.motorProtocol,
    motorIdleHundredthsPercent: want.motorIdleHundredthsPercent,
    feature3dEnabled: want.feature3dEnabled,
    propsOutConfigured: want.propsOutConfigured,
    bidirectionalDshotEnabled: want.bidirectionalDshotEnabled,
  });
}

/**
 * Composes the session-bound capability snapshot.
 *
 * Pure and total: no I/O, no timer, no clock, no randomness, no mutable
 * module state, and no throw for any evidence value. The same authority
 * plus the same evidence always yields an equal result.
 *
 * The returned object, its profile snapshot, its blocker array and every
 * blocker inside it are all frozen, so `readonly` - which is erased at
 * runtime - is never the only protection.
 *
 * A supported result is a statement about CONFIGURATION COMPATIBILITY
 * and nothing more. It is not permission to send anything.
 */
export function composeMotorTestCapabilities(
  authority: MotorTestSessionAuthority,
  evidence: MotorTestProfileEvidence,
): MotorTestCapabilities {
  const blockers: MotorTestCapabilityBlocker[] = [];
  for (const fact of FACT_ORDER) {
    const kind = evaluateFact(fact, evidence);
    if (kind !== undefined) {
      blockers.push(Object.freeze({fact, kind}));
    }
  }

  if (blockers.length > 0) {
    return Object.freeze({
      status: 'PROFILE_UNSUPPORTED' as const,
      authority,
      blockers: Object.freeze(blockers),
    });
  }

  return Object.freeze({
    status: 'PROFILE_SUPPORTED' as const,
    authority,
    profile: buildProfileSnapshot(),
    blockers: NO_BLOCKERS,
  });
}

/** Convenience predicate. Reads the discriminant and nothing else, so it
 * cannot drift from the type. It reports STATIC PROFILE COMPATIBILITY -
 * never authorization, readiness or safety. */
export function isMotorTestProfileSupported(
  capabilities: MotorTestCapabilities,
): boolean {
  return capabilities.status === 'PROFILE_SUPPORTED';
}
