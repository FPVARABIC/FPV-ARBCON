/**
 * Pass 1E - a PURE, DETERMINISTIC, SESSION-BOUND evaluation of already
 * acquired facts against one narrow project policy.
 *
 * WHAT THIS ANSWERS, AND ONLY THIS:
 *   "Do this supplied Pass 1C static compatibility result and this
 *    supplied Pass 1D dynamic observation - both bound to the supplied
 *    composite identity - satisfy Pass 1E's narrow 4S policy?"
 *
 * WHAT `REQUIREMENTS_SATISFIED` DOES NOT MEAN. It is the strongest
 * outcome this module can produce and it is still only a POLICY VERDICT
 * ON SUPPLIED DATA. It is not readiness, not safety, not authorization,
 * not permission to acquire a lease, not permission to send a motor
 * command, and not permission to connect a battery. In particular it
 * proves nothing about: whether the facts are still current; whether they
 * were ever simultaneously true; whether the battery is healthy; whether
 * a motor would physically stop. Those belong to later passes that do not
 * exist. There is deliberately no `isSafe`, `ready`, `authorized`,
 * `allowed`, `canTest`, `canPulse` or `permission` field anywhere in the
 * returned value, and a test asserts their absence.
 *
 * PURE. Synchronous. No I/O, no MSP request, no requester, no client, no
 * transport, no clock read, no global state, no session lookup, no cache,
 * no timer, no subscription, no monitoring. It consumes immutable inputs,
 * mutates none of them, retains none of them by reference, and returns a
 * freshly allocated frozen value on every call.
 *
 * SEQUENTIAL, NOT ATOMIC - AND NOT FRESH
 * --------------------------------------
 * Pass 1D read MSP_STATUS_EX and MSP_BATTERY_STATE as two SEPARATE
 * requests. There is no atomic FC snapshot: the armed state and the
 * battery voltage were true at two different instants. An equal session
 * identity proves the reads belong to the same link scope; it does NOT
 * prove the values coexisted, and it does NOT prove either is still true.
 *
 * The observation may have gone stale the instant Pass 1D returned - a
 * pack unplugged, an arm switch flipped, a desync. Pass 1E does not read
 * the current clock, does not compute the observation's age, does not
 * refresh anything, and does not continuously monitor arming, battery,
 * reboot or session state. A JavaScript timestamp is not a safety
 * watchdog. The observation window below is copied purely as PROVENANCE -
 * it is never a freshness, atomicity, liveness or continuous-validity
 * claim.
 *
 * Future runtime must acquire exclusive ownership, ESTABLISH the MSP
 * arming restriction, REACQUIRE a Pass 1D observation and REEVALUATE this
 * pass before any later motor-command gate can even be considered.
 * Continuous monitoring and a native stop/watchdog path remain later-pass
 * work and remain mandatory before any hardware test.
 *
 * PROVENANCE BOUNDARY
 * -------------------
 * Facts come from the repository (Pass 1C / Pass 1D canonical decoded
 * values). Thresholds come from PASS 1E PROJECT POLICY (below) and are
 * NOT claims about anything MSP reports. No MSP payload byte is decoded
 * here, no decoder is added or modified, the ARM box position is never
 * recomputed, and the raw arming-disable mask is never re-parsed - the
 * canonical decoded facts Pass 1D already provides are used as-is.
 *
 * OFFICIAL SEMANTICS RECONFIRMED at betaflight
 * @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e (tag 2025.12.2, API 1.47):
 *   batteryState_e: BATTERY_OK=0, BATTERY_WARNING, BATTERY_CRITICAL,
 *                   BATTERY_NOT_PRESENT, BATTERY_INIT   battery.h:88-94
 *   canonical voltage: `sbufWriteU16(dst, getBatteryVoltage()); // in
 *                   0.01V steps`                        msp.c:809
 *   ARMING_DISABLED_MSP             = (1 << 16)  runtime_config.h:59
 *   ARMING_DISABLED_REBOOT_REQUIRED = (1 << 21)  runtime_config.h:64
 *   reboot-required config-state bit 0:
 *                   `sbufWriteU8(dst, (getRebootRequired() << 0));`
 *                                                        msp.c:1132
 */

import type {
  MotorDynamicSafetyObservation,
  MotorDynamicSafetyObservationBlockedReason,
  MotorDynamicSafetyObservationOutcome,
} from './motorDynamicSafetyObservation';
import {motorSessionIdentitiesMatch} from './motorFcFirmwareVersion';
import type {MotorStaticCompatibilityEvaluation} from './motorStaticCompatibility';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';

/* ------------------------------------------------------------------ *
 * PASS 1E PROJECT POLICY
 *
 * Deliberate, narrow product decisions for one standard 4S test scope.
 * NONE of these is a value reported by MSP, a firmware default, or a
 * Betaflight constant - they are this project's own conservative limits.
 * All comparisons are INTEGER comparisons on the canonical centivolt
 * field: no floating point, no epsilon, no tolerance, no unit
 * conversion, and never a nominal or user-entered voltage.
 *
 * The voltage range does NOT prove battery health, calibration accuracy,
 * physical identity, cell balance, temperature, internal resistance or
 * absence of damage. It only bounds the total pack voltage the FC itself
 * reported.
 * ------------------------------------------------------------------ */

/** Exactly 4 detected cells. There is no 6S path in this project. */
export const POLICY_REQUIRED_CELL_COUNT = 4;

/** 14.00 V, inclusive. */
export const POLICY_MIN_VOLTAGE_CENTIVOLTS = 1400;

/** 16.80 V, inclusive. */
export const POLICY_MAX_VOLTAGE_CENTIVOLTS = 1680;

/** The FC's own classification must be exactly this token. */
export const POLICY_REQUIRED_BATTERY_STATE_TOKEN = 'BATTERY_OK';

/** The canonical REBOOT_REQUIRED arming-disable token (bit 21). */
const REBOOT_REQUIRED_BLOCKER_TOKEN = 'REBOOT_REQUIRED';

/* ------------------------------------------------------------------ *
 * Result model
 * ------------------------------------------------------------------ */

export type MotorDynamicSafetyPrerequisiteReason =
  /** No Pass 1C result, or its kind was NOT_EVALUATED. */
  | 'STATIC_COMPATIBILITY_NOT_EVALUATED'
  /** Pass 1C evaluated to UNSUPPORTED. Never reinterpreted as a dynamic
   * battery or arming failure. */
  | 'STATIC_PROFILE_UNSUPPORTED'
  /** No Pass 1D result, or its kind was NOT_OBSERVED. */
  | 'DYNAMIC_OBSERVATION_NOT_AVAILABLE'
  /** The caller supplied no current composite identity. */
  | 'CURRENT_SESSION_IDENTITY_UNAVAILABLE'
  /** The Pass 1C identity is not the supplied current identity. */
  | 'STATIC_BINDING_IDENTITY_MISMATCH'
  /** The Pass 1D identity is not the supplied current identity (this
   * also covers a Pass 1C / Pass 1D disagreement). */
  | 'DYNAMIC_BINDING_IDENTITY_MISMATCH'
  /** The observation window is not structurally coherent. */
  | 'OBSERVATION_WINDOW_INVALID'
  /** Canonical Pass 1D values contradict each other in a way that cannot
   * be safely evaluated. Fail closed rather than normalize. */
  | 'DYNAMIC_OBSERVATION_INCOHERENT';

/**
 * Every reason a requirement can block, in this pass's vocabulary. These
 * are BLOCKING REASONS, not errors and not verdicts about the aircraft.
 */
export type MotorDynamicSafetyBlockingReason =
  /** 5.1 - the FC reported itself ARMED. */
  | 'FC_ARMED'
  /** 5.2 - the MSP-specific arming-disable restriction was not observed.
   * Pass 1E never establishes it and never infers it. */
  | 'MSP_ARMING_RESTRICTION_NOT_OBSERVED'
  /** 5.3 - reboot-required was observed true, by either canonical
   * representation. Emitted at most once. */
  | 'REBOOT_REQUIRED'
  /** 5.3 - reboot state was not observed at all (null/absent). */
  | 'REBOOT_STATE_NOT_OBSERVED'
  /** 5.4 - cell count 0: the firmware's "battery not detected". */
  | 'BATTERY_NOT_DETECTED'
  /** 5.4 - a nonzero cell count other than 4, INCLUDING 6. Ordinary
   * observed data that fails policy; it opens no alternate path. */
  | 'BATTERY_CELL_COUNT_NOT_ALLOWED'
  /** 5.5 - below POLICY_MIN_VOLTAGE_CENTIVOLTS. */
  | 'BATTERY_VOLTAGE_BELOW_POLICY'
  /** 5.5 - above POLICY_MAX_VOLTAGE_CENTIVOLTS. */
  | 'BATTERY_VOLTAGE_ABOVE_POLICY'
  /** 5.6 - the FC's own classification, one token per official state. */
  | 'BATTERY_WARNING'
  | 'BATTERY_CRITICAL'
  | 'BATTERY_NOT_PRESENT'
  | 'BATTERY_INITIALIZING'
  /** 5.6 - a raw enum value the pinned authority does not define. NEVER
   * normalized to BATTERY_OK. */
  | 'BATTERY_STATE_UNRECOGNIZED';

/**
 * The canonical, documented, tested emission order. Reasons are always
 * reported in exactly this sequence regardless of evaluation order, so
 * two evaluations of equal facts are byte-identical:
 *
 *   1. armed state
 *   2. MSP arming restriction
 *   3. reboot state
 *   4. battery detection / cell count
 *   5. battery voltage
 *   6. battery-state classification
 */
export const MOTOR_DYNAMIC_BLOCKING_REASON_ORDER: readonly MotorDynamicSafetyBlockingReason[] =
  Object.freeze([
    'FC_ARMED',
    'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
    'REBOOT_REQUIRED',
    'REBOOT_STATE_NOT_OBSERVED',
    'BATTERY_NOT_DETECTED',
    'BATTERY_CELL_COUNT_NOT_ALLOWED',
    'BATTERY_VOLTAGE_BELOW_POLICY',
    'BATTERY_VOLTAGE_ABOVE_POLICY',
    'BATTERY_WARNING',
    'BATTERY_CRITICAL',
    'BATTERY_NOT_PRESENT',
    'BATTERY_INITIALIZING',
    'BATTERY_STATE_UNRECOGNIZED',
  ] as const);

export type MotorDynamicSafetyRequirementsStatus =
  | 'REQUIREMENTS_SATISFIED'
  | 'REQUIREMENTS_NOT_SATISFIED';

/** Copied provenance only. Never a freshness or atomicity claim. */
export interface MotorEvaluatedObservationWindow {
  readonly startedAtMonotonicMillis: number;
  readonly completedAtMonotonicMillis: number;
  readonly durationMillis: number;
}

export type MotorDynamicSafetyRequirementsEvaluation =
  | {
      readonly kind: 'NOT_EVALUATED';
      readonly reason: MotorDynamicSafetyPrerequisiteReason;
      /** Present ONLY when the Pass 1D input itself was NOT_OBSERVED:
       * its canonical reason, copied as a scalar. The source result
       * object is never retained. */
      readonly sourceObservationReason?: MotorDynamicSafetyObservationBlockedReason;
    }
  | {
      readonly kind: 'EVALUATED';
      readonly status: MotorDynamicSafetyRequirementsStatus;
      /** Freshly copied scalars, not a retained input reference. */
      readonly sessionIdentity: MotorStaticFactsSessionIdentity;
      /** Freshly copied scalars. PROVENANCE ONLY. */
      readonly observationWindow: MotorEvaluatedObservationWindow;
      /** Frozen, deduplicated, canonically ordered. Empty when
       * REQUIREMENTS_SATISFIED. */
      readonly blockingReasons: readonly MotorDynamicSafetyBlockingReason[];
    };

export interface EvaluateMotorDynamicSafetyRequirementsInput {
  /** The Pass 1C result. */
  readonly staticCompatibility: MotorStaticCompatibilityEvaluation | undefined;
  /** The Pass 1D result. */
  readonly dynamicObservation: MotorDynamicSafetyObservationOutcome | undefined;
  /** A caller-supplied COPY of the currently active composite identity.
   * This module never looks a session up itself. */
  readonly currentSessionIdentity: MotorStaticFactsSessionIdentity | undefined;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function notEvaluated(
  reason: MotorDynamicSafetyPrerequisiteReason,
  sourceObservationReason?: MotorDynamicSafetyObservationBlockedReason,
): MotorDynamicSafetyRequirementsEvaluation {
  return Object.freeze(
    sourceObservationReason === undefined
      ? ({kind: 'NOT_EVALUATED', reason} as const)
      : ({kind: 'NOT_EVALUATED', reason, sourceObservationReason} as const),
  );
}

function copySessionIdentity(
  identity: MotorStaticFactsSessionIdentity,
): MotorStaticFactsSessionIdentity {
  // Explicit scalar copy, never a spread of a caller-owned object.
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Structural coherence of the observation window. Both endpoints must be
 * finite integers in the SAME canonical monotonic unit Pass 1D recorded
 * them in, and start must not exceed completion. Equal endpoints are
 * valid - an observation can complete inside one clock tick. Nothing is
 * ever converted to wall-clock time.
 */
function isWindowCoherent(observation: MotorDynamicSafetyObservation): boolean {
  const window = observation.observationWindow;
  if (
    !isSafeInteger(window.startedAtMonotonicMillis) ||
    !isSafeInteger(window.completedAtMonotonicMillis) ||
    !isSafeInteger(window.durationMillis)
  ) {
    return false;
  }
  return window.startedAtMonotonicMillis <= window.completedAtMonotonicMillis;
}

/**
 * Defence in depth. The Pass 1D TYPE already makes an unknown armed state
 * impossible inside an OBSERVED result (MotorObservedArmedState is
 * exactly 'ARMED' | 'DISARMED'; an unresolvable ARM bit fails closed to
 * NOT_OBSERVED there). This guard enforces the same invariant at runtime
 * for a hand-built or cast object, so an unknown value can never be
 * silently normalized into "disarmed".
 */
function isObservationCoherent(observation: MotorDynamicSafetyObservation): boolean {
  if (observation.observationKind !== 'DYNAMIC_OBSERVATION') {
    return false;
  }
  if (observation.armedState !== 'ARMED' && observation.armedState !== 'DISARMED') {
    return false;
  }
  const restrictions = observation.armingRestrictions;
  if (typeof restrictions.mspRestrictionPresent !== 'boolean') {
    return false;
  }
  if (restrictions.rebootRequired !== null && typeof restrictions.rebootRequired !== 'boolean') {
    return false;
  }
  if (!Array.isArray(restrictions.blockers)) {
    return false;
  }
  const battery = observation.battery;
  if (!isSafeInteger(battery.cellCount) || battery.cellCount < 0) {
    return false;
  }
  if (!isSafeInteger(battery.voltageCentivolts) || battery.voltageCentivolts < 0) {
    return false;
  }
  const classification = battery.classification;
  return classification.kind === 'KNOWN' || classification.kind === 'UNRECOGNIZED';
}

/**
 * Emits the collected reasons in MOTOR_DYNAMIC_BLOCKING_REASON_ORDER,
 * deduplicated, in a freshly allocated frozen array. Driving the output
 * from the canonical order (rather than from insertion order) makes the
 * ordering a property of the contract, not of the code path taken.
 */
function orderedBlockingReasons(
  collected: ReadonlySet<MotorDynamicSafetyBlockingReason>,
): readonly MotorDynamicSafetyBlockingReason[] {
  return Object.freeze(
    MOTOR_DYNAMIC_BLOCKING_REASON_ORDER.filter(reason => collected.has(reason)),
  );
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * Evaluates supplied Pass 1C and Pass 1D results against the Pass 1E
 * policy.
 *
 * A failed REQUIREMENT is a NORMAL RESULT: kind EVALUATED, status
 * REQUIREMENTS_NOT_SATISFIED, with every applicable blocking reason
 * present. Every requirement is evaluated - there is no short-circuit on
 * the first failure - so a caller sees the complete picture in one call.
 *
 * A failed PREREQUISITE is different in kind: it prevents evaluation
 * entirely and yields NOT_EVALUATED with one typed reason, no status and
 * no blocking reasons. A prerequisite failure NEVER becomes
 * REQUIREMENTS_NOT_SATISFIED, and an ordinary condition failure NEVER
 * becomes NOT_EVALUATED. Expected prerequisite failures never throw.
 */
export function evaluateMotorDynamicSafetyRequirements(
  input: EvaluateMotorDynamicSafetyRequirementsInput,
): MotorDynamicSafetyRequirementsEvaluation {
  const {staticCompatibility, dynamicObservation, currentSessionIdentity} = input;

  // --- Prerequisites, in the documented order -----------------------

  // (1)(2) Pass 1C present and evaluated.
  if (staticCompatibility === undefined || staticCompatibility.kind !== 'EVALUATED') {
    return notEvaluated('STATIC_COMPATIBILITY_NOT_EVALUATED');
  }
  // (3) Pass 1C SUPPORTED. Static incompatibility is reported as exactly
  // that - never reinterpreted as a failed battery or arming condition.
  if (staticCompatibility.compatibility.status !== 'SUPPORTED') {
    return notEvaluated('STATIC_PROFILE_UNSUPPORTED');
  }

  // (4)(5) Pass 1D present and OBSERVED. When it was NOT_OBSERVED its
  // canonical reason is carried through as a copied scalar; the source
  // result object itself is never retained.
  if (dynamicObservation === undefined) {
    return notEvaluated('DYNAMIC_OBSERVATION_NOT_AVAILABLE');
  }
  if (dynamicObservation.kind !== 'OBSERVED') {
    return notEvaluated('DYNAMIC_OBSERVATION_NOT_AVAILABLE', dynamicObservation.reason);
  }
  const observation = dynamicObservation.observation;

  // (6) A current identity must be supplied.
  if (currentSessionIdentity === undefined) {
    return notEvaluated('CURRENT_SESSION_IDENTITY_UNAVAILABLE');
  }

  // (7)(8)(10) Identity equality BY SCALAR VALUE - both components,
  // never by object reference. motorSessionIdentitiesMatch is the
  // repository's existing comparator and checks physicalGeneration and
  // mspEpoch.
  if (
    !motorSessionIdentitiesMatch(
      staticCompatibility.compatibility.sessionIdentity,
      currentSessionIdentity,
    )
  ) {
    return notEvaluated('STATIC_BINDING_IDENTITY_MISMATCH');
  }
  if (!motorSessionIdentitiesMatch(observation.sessionIdentity, currentSessionIdentity)) {
    return notEvaluated('DYNAMIC_BINDING_IDENTITY_MISMATCH');
  }
  // (9) Pass 1C and Pass 1D must also agree with each other. Transitively
  // implied by the two checks above, asserted explicitly so the invariant
  // is enforced here rather than inferred by a reader.
  if (
    !motorSessionIdentitiesMatch(
      staticCompatibility.compatibility.sessionIdentity,
      observation.sessionIdentity,
    )
  ) {
    return notEvaluated('DYNAMIC_BINDING_IDENTITY_MISMATCH');
  }

  // (11) Structural coherence. Window first, then the values themselves.
  if (!isWindowCoherent(observation)) {
    return notEvaluated('OBSERVATION_WINDOW_INVALID');
  }
  if (!isObservationCoherent(observation)) {
    return notEvaluated('DYNAMIC_OBSERVATION_INCOHERENT');
  }

  // --- Requirements. Every one is evaluated; none short-circuits. ----

  const blockers = new Set<MotorDynamicSafetyBlockingReason>();
  const restrictions = observation.armingRestrictions;
  const battery = observation.battery;

  // 5.1 Armed state. Read ONLY from the canonical decoded armed state.
  // Never inferred from an arming-disable flag, from missing motor
  // output, or by recomputing the ARM box position.
  if (observation.armedState === 'ARMED') {
    blockers.add('FC_ARMED');
  }

  // 5.2 MSP-specific arming-disable restriction. Read ONLY from the
  // canonical mspRestrictionPresent fact. No other blocker substitutes
  // for it, and it is never inferred from a general disarmed state, a
  // future ACK or a future write. Pass 1E does not SET this restriction;
  // establishing and re-observing it belongs to a later pass. Unrelated
  // blockers are deliberately NOT failures here - no Pass 1E rule covers
  // them.
  if (!restrictions.mspRestrictionPresent) {
    blockers.add('MSP_ARMING_RESTRICTION_NOT_OBSERVED');
  }

  // 5.3 Reboot state. Two canonical representations exist: the
  // config-state byte (msp.c:1132) and arming-disable bit 21
  // (runtime_config.h:64). EITHER indicating reboot-required blocks, and
  // the Set guarantees exactly one REBOOT_REQUIRED reason. Never
  // inferred from firmware-version mismatch, static incompatibility,
  // configuration assumptions or battery state.
  const rebootBlockerPresent = restrictions.blockers.some(
    blocker => blocker.kind === 'KNOWN' && blocker.token === REBOOT_REQUIRED_BLOCKER_TOKEN,
  );
  if (restrictions.rebootRequired === true || rebootBlockerPresent) {
    blockers.add('REBOOT_REQUIRED');
  } else if (restrictions.rebootRequired === null) {
    // Not observed at all. Never silently treated as "no reboot needed".
    blockers.add('REBOOT_STATE_NOT_OBSERVED');
  }

  // 5.4 Cell count. Never inferred from voltage.
  if (battery.cellCount === 0) {
    blockers.add('BATTERY_NOT_DETECTED');
  } else if (battery.cellCount !== POLICY_REQUIRED_CELL_COUNT) {
    // Includes 6. Ordinary observed data that fails policy - it creates
    // no alternate 6S path anywhere in this module.
    blockers.add('BATTERY_CELL_COUNT_NOT_ALLOWED');
  }

  // 5.5 Voltage. Integer centivolts only - the canonical field. The
  // legacy decivolt byte is never consulted, nothing is converted
  // through floating point, and an in-range total says nothing about
  // individual cell balance.
  if (battery.voltageCentivolts < POLICY_MIN_VOLTAGE_CENTIVOLTS) {
    blockers.add('BATTERY_VOLTAGE_BELOW_POLICY');
  } else if (battery.voltageCentivolts > POLICY_MAX_VOLTAGE_CENTIVOLTS) {
    blockers.add('BATTERY_VOLTAGE_ABOVE_POLICY');
  }

  // 5.6 The FC's own classification. Each official state maps to its own
  // reason; an unrecognized raw value maps to its own reason too and is
  // NEVER normalized to BATTERY_OK. BATTERY_OK cannot override a
  // cell-count or voltage failure, because those are independent
  // requirements already collected above.
  if (battery.classification.kind === 'UNRECOGNIZED') {
    blockers.add('BATTERY_STATE_UNRECOGNIZED');
  } else {
    switch (battery.classification.token) {
      case POLICY_REQUIRED_BATTERY_STATE_TOKEN:
        break;
      case 'BATTERY_WARNING':
        blockers.add('BATTERY_WARNING');
        break;
      case 'BATTERY_CRITICAL':
        blockers.add('BATTERY_CRITICAL');
        break;
      case 'BATTERY_NOT_PRESENT':
        blockers.add('BATTERY_NOT_PRESENT');
        break;
      case 'BATTERY_INIT':
        blockers.add('BATTERY_INITIALIZING');
        break;
      default:
        // A token outside the pinned enum: treated exactly like an
        // unrecognized raw value, never like BATTERY_OK.
        blockers.add('BATTERY_STATE_UNRECOGNIZED');
        break;
    }
  }

  const blockingReasons = orderedBlockingReasons(blockers);

  return Object.freeze({
    kind: 'EVALUATED',
    status:
      blockingReasons.length === 0 ? 'REQUIREMENTS_SATISFIED' : 'REQUIREMENTS_NOT_SATISFIED',
    sessionIdentity: copySessionIdentity(currentSessionIdentity),
    observationWindow: Object.freeze({
      startedAtMonotonicMillis: observation.observationWindow.startedAtMonotonicMillis,
      completedAtMonotonicMillis: observation.observationWindow.completedAtMonotonicMillis,
      durationMillis: observation.observationWindow.durationMillis,
    } as const),
    blockingReasons,
  } as const);
}
