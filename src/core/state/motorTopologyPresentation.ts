/**
 * M-D - HOW TOPOLOGY TRUTH IS SAID, WITHOUT SAYING IT IN ANY ONE LANGUAGE.
 *
 * Every function here returns an i18n KEY (and its parameters), never a
 * sentence. Arabic lives in the locale file; this module decides WHICH
 * sentence is true.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. M-B built a topology model
 * that keeps four answers to "how many motors" side by side and refuses to
 * merge them. A presentation layer is exactly where they get quietly
 * merged back together, because one number is easier to draw than four
 * facts. So:
 *
 *   - The COMMANDABLE count has exactly one source, and this module does
 *     not compute it: it asks motorTestPulseMotorNumbers(), the same
 *     function the controller uses to decide which motor numbers it will
 *     accept. A screen and a controller that disagree about how many
 *     motors exist is the defect M-C removed; deriving the list twice
 *     would reintroduce it.
 *   - The EXPECTED count has its own describe function that cannot see the
 *     runtime one, and vice versa.
 *   - There is no fallback anywhere. A count that cannot be established
 *     yields a state that says so. It never yields four.
 *
 * WHAT THIS MODULE REFUSES TO SAY.
 *
 *  - NO HEALTH VOCABULARY. No key contains healthy, ok, working, good,
 *    fault or broken, and a test refuses one that does. Topology is a
 *    configuration, not a measurement of whether anything works.
 *  - NO ROTATION DIRECTION. Not CW, not CCW, not "props out". M-A
 *    established that actual propeller rotation is not readable as
 *    authoritative truth, so there is no key for it.
 *  - NO SERVO COMMAND. Servo involvement is described so an operator knows
 *    their tricopter's tail is not in the motor test. Describing an
 *    actuator is not offering to drive it.
 *  - NO POSITIONAL CLAIM WITHOUT AN AUTHORED LAYOUT. A diagram is offered
 *    only where this application has actually modelled the arrangement.
 *    A numbered list is not a degraded mode; it is the correct answer when
 *    the geometry is not known, and it is a first-class one.
 */

import type {ServoCountStrategy} from '../firmware-adapters/betaflightMixerReferenceV147';
import {motorTestPulseMotorNumbers} from './motorTestController';
import type {
  MotorTopologyContradiction,
  MotorTopologyTruth,
} from './motorTopologyTruth';

const NS = 'motorsScreen.topology';

/** A key plus whatever it interpolates. */
export interface MotorTopologyPhrase {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

const phrase = (
  key: string,
  params?: Record<string, string | number>,
): MotorTopologyPhrase =>
  Object.freeze(params === undefined ? {key} : {key, params: Object.freeze(params)});

/**
 * The airframe's identity, read-only.
 *
 * A mixer id outside the pinned table keeps its RAW NUMBER and is labelled
 * as unknown. It is never normalised to a quad, never given a family it
 * did not declare, and never silently dropped - an operator running a
 * firmware newer than our pin is entitled to see what their board actually
 * said.
 */
export function describeAirframe(truth: MotorTopologyTruth): MotorTopologyPhrase {
  if (truth.mixer === undefined) {
    return phrase(`${NS}.airframe.unknownRaw`, {raw: truth.mixerModeRaw});
  }
  return phrase(`${NS}.airframe.${truth.mixer.firmwareName}`);
}

/**
 * WHAT CAN ACTUALLY BE COMMANDED, and nothing else.
 *
 * Deliberately a discriminated union rather than a number, because three
 * of the four cases are not counts and a caller that receives a plain
 * number will eventually treat one of them as zero motors.
 */
export type CommandableMotorScope =
  | {
      readonly kind: 'COMMANDABLE';
      readonly count: number;
      /** 1..count. MSP output slots, never airframe positions. */
      readonly motorNumbers: readonly number[];
    }
  /** MSP_MOTOR_CONFIG said zero. A legitimate configuration for a
   * servo-only mixer, and NOT an error on its own (see topologyNotices). */
  | {readonly kind: 'NO_MOTORS_REPORTED'}
  /** MSP_MOTOR_CONFIG has not been read. Distinct from zero: "no motors"
   * and "we have not asked" are different sentences. */
  | {readonly kind: 'RUNTIME_COUNT_NOT_READ'}
  /** Read, but outside 1..8. Reported as the figure it was, not clamped. */
  | {readonly kind: 'RUNTIME_COUNT_UNUSABLE'; readonly reported: number};

/**
 * The single motor-count question this screen is allowed to ask.
 *
 * NOTE THE DELEGATION. The 1..N list comes from motorTestPulseMotorNumbers
 * in the controller, not from a loop here. That function is the M-C
 * authority for which motor numbers a pulse request will accept, so a UI
 * built on it cannot render a control the controller would refuse - and
 * cannot omit one it would accept.
 */
export function commandableMotorScope(
  truth: MotorTopologyTruth,
): CommandableMotorScope {
  if (truth.runtimeMotorCount.kind === 'NOT_READ') {
    return Object.freeze({kind: 'RUNTIME_COUNT_NOT_READ' as const});
  }
  const reported = truth.runtimeMotorCount.count;
  if (reported === 0) {
    return Object.freeze({kind: 'NO_MOTORS_REPORTED' as const});
  }
  const motorNumbers = motorTestPulseMotorNumbers(reported);
  if (motorNumbers.length === 0) {
    // Non-empty count that the controller will not accept: above
    // MAX_SUPPORTED_MOTORS, or otherwise unusable. Say so; do not clamp.
    return Object.freeze({kind: 'RUNTIME_COUNT_UNUSABLE' as const, reported});
  }
  return Object.freeze({
    kind: 'COMMANDABLE' as const,
    count: motorNumbers.length,
    motorNumbers,
  });
}

/** How the flight controller's own count is stated. Cannot see the mixer
 *  table's expectation, by construction. */
export function describeRuntimeMotorCount(
  scope: CommandableMotorScope,
): MotorTopologyPhrase {
  switch (scope.kind) {
    case 'COMMANDABLE':
      return phrase(`${NS}.runtimeCount.reported`, {count: scope.count});
    case 'NO_MOTORS_REPORTED':
      return phrase(`${NS}.runtimeCount.none`);
    case 'RUNTIME_COUNT_NOT_READ':
      return phrase(`${NS}.runtimeCount.notRead`);
    case 'RUNTIME_COUNT_UNUSABLE':
      return phrase(`${NS}.runtimeCount.unusable`, {reported: scope.reported});
  }
}

/** What the MIXER implies - a different question, answered separately and
 *  never substituted for the one above. */
export function describeExpectedMotorCount(
  truth: MotorTopologyTruth,
): MotorTopologyPhrase {
  const expected = truth.expectedMotorCount;
  switch (expected.kind) {
    case 'TABLE_FIXED':
      return phrase(`${NS}.expectedCount.fixed`, {count: expected.count});
    case 'CUSTOM_RUNTIME_DERIVED':
      // The CLI's `mmix` rows are on no MSP command at this pin, so this
      // is not a missing read - it is not readable at all. Saying
      // "unknown" would invite an operator to go looking for it.
      return phrase(`${NS}.expectedCount.customRuntimeDerived`);
    case 'NO_MOTORS':
      return phrase(`${NS}.expectedCount.none`);
    case 'UNKNOWN':
      return phrase(`${NS}.expectedCount.unknown`);
  }
}

/**
 * Servo actuators this airframe uses, as INFORMATION.
 *
 * The reason this exists at all: on a tricopter the yaw comes from a tail
 * servo, and an operator who sees three motor controls and nothing else
 * has no way to tell whether the fourth output is missing or simply is not
 * a motor. Naming it closes that gap. Nothing here is commandable.
 */
export type ServoInvolvement =
  | {readonly kind: 'NO_SERVOS'}
  | {
      readonly kind: 'SERVO_OUTPUTS';
      readonly count: number;
      readonly phrase: MotorTopologyPhrase;
    }
  /** mixers[].useServo is set but writeServos() has no branch for the
   * mode. Two modes are like this at the pin, and both are rewritten to
   * something else by validateAndFixConfig() before a board can run them,
   * so this state should be unreachable from a live FC. Represented rather
   * than asserted away. */
  | {readonly kind: 'DECLARED_WITHOUT_MODELLED_OUTPUTS'}
  | {readonly kind: 'UNKNOWN'};

export function describeServoInvolvement(
  truth: MotorTopologyTruth,
): ServoInvolvement {
  const servos: ServoCountStrategy = truth.expectedServoCount;
  if (servos.kind === 'UNKNOWN') {
    return Object.freeze({kind: 'UNKNOWN' as const});
  }
  if (servos.kind === 'NO_SERVOS') {
    return truth.mixer?.tableUseServo === true
      ? Object.freeze({kind: 'DECLARED_WITHOUT_MODELLED_OUTPUTS' as const})
      : Object.freeze({kind: 'NO_SERVOS' as const});
  }
  // Keyed per mixer, not per count: a tricopter's single servo is a tail
  // rudder and a singlecopter's four are vanes. One generic "N servos"
  // sentence would be true and useless.
  const key =
    truth.mixer === undefined
      ? `${NS}.servo.generic`
      : `${NS}.servo.${truth.mixer.firmwareName}`;
  return Object.freeze({
    kind: 'SERVO_OUTPUTS' as const,
    count: servos.count,
    phrase: phrase(key, {count: servos.count}),
  });
}

/**
 * Whether an arrangement may be DRAWN.
 *
 * `layoutKnown` is a property of THIS APPLICATION's drawing, not of the
 * firmware: it is true only for the mixers whose positional layout we have
 * authored and checked. Everything else gets a numbered list.
 *
 * No diagram is better than a false diagram. A hexacopter rendered on quad
 * geometry does not merely look wrong - it tells the operator that motor 5
 * is somewhere it is not, and they will act on that when a motor spins.
 */
export type TopologyPresentationMode = 'POSITIONAL_DIAGRAM' | 'NUMBERED_LIST';

export function topologyPresentationMode(
  truth: MotorTopologyTruth,
): TopologyPresentationMode {
  if (!truth.layoutKnown) {
    return 'NUMBERED_LIST';
  }
  // An authored layout still describes a specific motor count. If the
  // running firmware reported a different one, the drawing no longer
  // matches the machine and the list is the honest answer.
  const scope = commandableMotorScope(truth);
  if (scope.kind !== 'COMMANDABLE') {
    return 'NUMBERED_LIST';
  }
  const expected = truth.expectedMotorCount;
  if (expected.kind === 'TABLE_FIXED' && expected.count !== scope.count) {
    return 'NUMBERED_LIST';
  }
  return 'POSITIONAL_DIAGRAM';
}

/**
 * How loudly a topology fact is said.
 *
 * Three levels, because collapsing them into one red banner would make an
 * ordinary custom mixer look like a fault:
 *
 *   INFORMATIONAL  A true statement about what is knowable. Nothing is
 *                  wrong. An unknown mixer id and a custom mixer both live
 *                  here.
 *   DIAGNOSTIC     Two readings that do not agree, where one of them is
 *                  still authoritative and the screen keeps working.
 *   CONTRADICTION  The board said something the pinned firmware's own
 *                  rules make impossible. Rare, and worth showing plainly.
 */
export type TopologyNoticeSeverity =
  | 'INFORMATIONAL'
  | 'DIAGNOSTIC'
  | 'CONTRADICTION';

export type TopologyNoticeId =
  | MotorTopologyContradiction
  /** Not a contradiction: the three custom modes take their motor count
   * from CLI rows that no MSP command carries. Reported so the absent
   * expected-count is explained rather than looking like a missing read. */
  | 'CUSTOM_TOPOLOGY_NOT_OBSERVABLE_OVER_MSP';

export interface TopologyNotice {
  readonly id: TopologyNoticeId;
  readonly severity: TopologyNoticeSeverity;
  readonly phrase: MotorTopologyPhrase;
  /** The two figures, kept apart, for the notices that compare a pair.
   * Never pre-formatted into one sentence. */
  readonly comparison?: {
    readonly expected: MotorTopologyPhrase;
    readonly reported: MotorTopologyPhrase;
  };
}

const SEVERITY: Readonly<Record<MotorTopologyContradiction, TopologyNoticeSeverity>> =
  Object.freeze({
    // A firmware newer than our pin, or a mixer we have not catalogued.
    // The board is fine and the motors still work.
    MIXER_MODE_NOT_IN_PINNED_TABLE: 'INFORMATIONAL',
    // mixerConfigureOutput() clamps on both branches, so the running
    // firmware cannot produce this.
    RUNTIME_COUNT_EXCEEDS_FIRMWARE_MAXIMUM: 'CONTRADICTION',
    // Reachable: a mixer changed without the reboot mixerInit() needs.
    RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE: 'DIAGNOSTIC',
    RUNTIME_COUNT_NONZERO_FOR_MOTORLESS_MIXER: 'DIAGNOSTIC',
    // MSP_MOTOR's own guard makes this unreachable.
    OBSERVED_ENABLED_SLOTS_EXCEED_RUNTIME_COUNT: 'CONTRADICTION',
    // The driver abandons init on first failure, so a hole is unreachable.
    OBSERVED_ENABLED_SLOTS_NOT_CONTIGUOUS: 'CONTRADICTION',
    // msp.c writes both counts from getMotorCount(), but telemetry is the
    // one that stops arriving first on a real link.
    TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT: 'DIAGNOSTIC',
  });

/**
 * Every topology fact worth surfacing, in a stable order, each with its
 * own severity.
 *
 * THE COMMANDABLE COUNT IS NEVER CHANGED BY ANY OF THESE. A mismatch
 * between what a mixer expects and what the firmware reported is reported;
 * it does not rewrite the runtime figure and it does not disable the motor
 * test. M-C established that the runtime count owns commandability, and a
 * diagnostic that quietly revoked it would undo that.
 */
export function topologyNotices(
  truth: MotorTopologyTruth,
): readonly TopologyNotice[] {
  const notices: TopologyNotice[] = [];

  if (truth.customMixer.kind === 'RUNTIME_DERIVED_NOT_READABLE_OVER_MSP') {
    notices.push(
      Object.freeze({
        id: 'CUSTOM_TOPOLOGY_NOT_OBSERVABLE_OVER_MSP' as const,
        severity: 'INFORMATIONAL' as const,
        phrase: phrase(`${NS}.notice.CUSTOM_TOPOLOGY_NOT_OBSERVABLE_OVER_MSP`),
      }),
    );
  }

  for (const contradiction of truth.contradictions) {
    const base = {
      id: contradiction,
      severity: SEVERITY[contradiction],
      phrase: phrase(`${NS}.notice.${contradiction}`, noticeParams(truth, contradiction)),
    };
    notices.push(
      Object.freeze(
        contradiction === 'RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE'
          ? {
              ...base,
              comparison: Object.freeze({
                expected: describeExpectedMotorCount(truth),
                reported: describeRuntimeMotorCount(commandableMotorScope(truth)),
              }),
            }
          : base,
      ),
    );
  }

  return Object.freeze(notices);
}

function noticeParams(
  truth: MotorTopologyTruth,
  contradiction: MotorTopologyContradiction,
): Record<string, string | number> | undefined {
  switch (contradiction) {
    case 'MIXER_MODE_NOT_IN_PINNED_TABLE':
      return {raw: truth.mixerModeRaw};
    case 'TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT':
      return truth.telemetryFrameMotorCount.kind === 'REPORTED' &&
        truth.runtimeMotorCount.kind === 'REPORTED'
        ? {
            telemetry: truth.telemetryFrameMotorCount.count,
            runtime: truth.runtimeMotorCount.count,
          }
        : undefined;
    default:
      return undefined;
  }
}

/** The strongest severity present, for a caller that needs one summary
 *  level. Returns undefined when there is nothing to say - which is the
 *  ordinary case and must not render as a cleared alarm. */
export function highestTopologyNoticeSeverity(
  notices: readonly TopologyNotice[],
): TopologyNoticeSeverity | undefined {
  const order: readonly TopologyNoticeSeverity[] = [
    'CONTRADICTION',
    'DIAGNOSTIC',
    'INFORMATIONAL',
  ];
  return order.find(level => notices.some(notice => notice.severity === level));
}
