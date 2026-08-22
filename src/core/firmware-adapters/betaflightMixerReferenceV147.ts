/**
 * M-B - the ORIGINAL MIXER REFERENCE MODEL for Betaflight MSP API 1.47.
 *
 * WHAT THIS MODULE IS. A frozen, hand-authored table of the facts about
 * Betaflight's 27 mixer modes that are needed to UNDERSTAND AN AIRFRAME'S
 * TOPOLOGY: how many motor outputs the mixer implies and where that number
 * comes from, how many servo outputs the firmware writes for it, and which
 * airframe family the firmware itself puts it in. It is a description of
 * observed behaviour, re-derived from source and re-expressed in this
 * project's own vocabulary.
 *
 * WHAT THIS MODULE IS NOT.
 *  - It is NOT a reimplementation of mixTable(). No mixing is performed
 *    here and none ever will be.
 *  - It holds NO MIXER COEFFICIENTS. The per-motor throttle/roll/pitch/yaw
 *    numbers that make an airframe fly are deliberately absent: this
 *    application never computes a mix, so storing them would be dead
 *    weight that also happens to be the most transcription-like part of
 *    the upstream tables.
 *  - It contains no upstream code, no upstream comments, no upstream
 *    identifiers beyond the mixer NAMES, which are protocol vocabulary
 *    (they appear on the wire's enum and in the CLI) rather than
 *    expression.
 *  - It has no I/O, no transport, no React, no UI, and no mutable state.
 *
 * ============================ SOURCE PIN ============================
 * Every line reference below is Betaflight firmware commit
 * 7348054f268f0058574719c134e9f149565bb8ea (FC 2025.12.5), whose
 * src/main/msp/msp_protocol.h:61-62 declares API_VERSION_MAJOR 1 /
 * API_VERSION_MINOR 47.
 *
 * NOTE ON THE PIN. Earlier modules in this repository cite Betaflight
 * 2025.12.2 @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e. That is a
 * DIFFERENT point release at the SAME MSP API version. This module was
 * re-derived at 7348054f and cites 7348054f throughout; where a fact is
 * shared with the older pin the two agree, and where this module could
 * not confirm agreement it says so rather than assuming it.
 *
 * CROSS-CHECKED AGAINST API 1.49. The same reading was performed at
 * Betaflight master commit 1efac3ef1 (API_VERSION_MINOR 49). For every
 * fact in this file the two are identical:
 *   - `mixers[]` is byte-identical between the two commits (verified by
 *     hashing the table text at both).
 *   - mixerConfigureOutput() is line-for-line identical
 *     (mixer_init.c:422-451 @ 1.47, mixer_init.c:424-453 @ 1.49).
 *   - validateAndFixConfig()'s mixer block is identical
 *     (config.c:209-217 @ 1.47, config.c:221-228 @ 1.49).
 * The one motor-path difference between the releases is in MSP_SET_MOTOR
 * and is documented in motorTestCommandVector.ts, not here.
 *
 * API 1.48 IS NOT VERIFIED and nothing in this file claims otherwise. No
 * branch anywhere keys off an API version.
 *
 * ================== HOW THE FIRMWARE COUNTS MOTORS ==================
 * mixer_init.c:422-451, mixerConfigureOutput() - the ONLY writer of
 * mixerRuntime.motorCount on a build without USE_QUAD_MIXER_ONLY, and the
 * value getMotorCount() returns (mixer_init.c:293-296), which is in turn
 * the byte MSP_MOTOR_CONFIG puts at offset 6 (msp.c:1445):
 *
 *   - The count is reset to 0.
 *   - If the mode is MIXER_CUSTOM, MIXER_CUSTOM_TRI or
 *     MIXER_CUSTOM_AIRPLANE, the firmware WALKS customMotorMixer(i) from
 *     index 0, stops at the first entry whose `throttle` is exactly 0.0f,
 *     and the count is the number of entries it walked past - bounded by
 *     MAX_SUPPORTED_MOTORS.
 *   - OTHERWISE the count is mixers[mode].motorCount, clamped to
 *     MAX_SUPPORTED_MOTORS.
 *
 * There is no third path, no default-then-override, and no fallback from
 * the custom branch to the table. See MotorCountStrategy below, which
 * encodes exactly this split and nothing else.
 *
 * ================== HOW THE FIRMWARE WRITES SERVOS ==================
 * servos.c:342-412, writeServos() - a switch on the mixer mode that
 * writes a FIXED, mode-specific list of servo channels, plus two more
 * when FEATURE_SERVO_TILT is on or the mode is MIXER_GIMBAL
 * (servos.c:400-403, updateGimbalServos() at servos.c:333-337 writing
 * exactly two), plus any channel-forwarding servos (servos.c:406-411).
 *
 * The per-mode number recorded here is therefore a BASE, not a total, and
 * the field is named `baseServoOutputs` for that reason. Two runtime
 * features add to it and neither is a property of the mixer.
 */

import {
  MIXER_MODE_QUADX,
  MIXER_MODE_QUADX_1234,
} from '../protocol/msp/decoding/decodeMixerConfig';

/** src/main/target/common_defaults_post.h:351 @ 7348054f. The bound on a
 * standard build; a USE_QUAD_MIXER_ONLY target compiles with 4 and simply
 * reports a smaller count. */
export const MIXER_REFERENCE_MAX_SUPPORTED_MOTORS = 8;

/** src/main/target/common_defaults_post.h:353 @ 7348054f. */
export const MIXER_REFERENCE_MAX_SUPPORTED_SERVOS = 8;

/** src/main/flight/mixer.h:40 @ 7348054f: `MIXER_TRI = 1`. The enum has no
 * zero member; mixers[0] is an unreachable placeholder that keeps the
 * table's indices aligned with the enum. */
export const MIXER_MODE_MIN = 1;

/** src/main/flight/mixer.h:66 @ 7348054f: `MIXER_OCTOX8P = 27`. */
export const MIXER_MODE_MAX = 27;

/**
 * WHERE A MIXER'S MOTOR COUNT COMES FROM. A discriminated union rather
 * than a number, because the four cases are genuinely different claims
 * and flattening them to a number would let "the firmware will tell us at
 * runtime" masquerade as "we know it is three".
 *
 *  TABLE_FIXED             - mixerConfigureOutput()'s else-branch reads
 *                            mixers[mode].motorCount, which is a compile-
 *                            time constant. `count` is that constant.
 *  CUSTOM_RUNTIME_DERIVED  - mixerConfigureOutput()'s custom branch walks
 *                            customMotorMixer() to the first zero
 *                            throttle. The result is whatever the board's
 *                            CLI `mmix` rows say, from 0 up to
 *                            MAX_SUPPORTED_MOTORS, and MSP cannot read
 *                            those rows at all (see CUSTOM_MIXER_IS_CLI_ONLY).
 *  NO_MOTORS               - TABLE_FIXED with a count of zero, kept
 *                            separate so a caller cannot accidentally
 *                            treat "this mixer drives no motors" as a
 *                            missing value.
 *  UNKNOWN                 - the mixer id is not in the pinned table. No
 *                            number is invented for it.
 */
export type MotorCountStrategy =
  | {readonly kind: 'TABLE_FIXED'; readonly count: number}
  | {readonly kind: 'CUSTOM_RUNTIME_DERIVED'}
  | {readonly kind: 'NO_MOTORS'}
  | {readonly kind: 'UNKNOWN'};

/**
 * HOW MANY SERVO CHANNELS writeServos() emits for this mixer BEFORE
 * FEATURE_SERVO_TILT and channel forwarding add their own. Same shape and
 * same reasoning as MotorCountStrategy.
 *
 *  TABLE_FIXED - the mode has a branch in writeServos() (or is
 *                MIXER_GIMBAL, whose two servos come from the gimbal
 *                block instead of the switch). `count` is how many
 *                writeServoWithTracking() calls that branch makes.
 *  NO_SERVOS   - the mode falls through writeServos()'s `default: break`
 *                and is not MIXER_GIMBAL, so the switch writes none.
 *  UNKNOWN     - the mixer id is not in the pinned table.
 */
export type ServoCountStrategy =
  | {readonly kind: 'TABLE_FIXED'; readonly count: number}
  | {readonly kind: 'NO_SERVOS'}
  | {readonly kind: 'UNKNOWN'};

/**
 * THE AIRFRAME FAMILY, assigned from explicit firmware evidence for every
 * one of the 27 modes. Deliberately NOT derived as "anything that is not
 * fixed wing is a multirotor": that rule silently files helicopters,
 * camera gimbals, a PPM-to-servo relay, bicopters, dualcopters and
 * singlecopters as quadcopters, and every one of those is wrong.
 *
 *  MULTIROTOR       - motor-only airframes: mixers[mode].useServo is
 *                     false and writeServos() has no branch for them, so
 *                     the entire control authority is in the motors.
 *  FIXED_WING       - exactly the three modes mixerModeIsFixedWing()
 *                     returns true for (mixer_init.c:517-530).
 *  ROTORCRAFT_OTHER - the two helicopter modes. Rotorcraft, but the
 *                     firmware's own servo tables and the CCPM swashplate
 *                     make them nothing like a multirotor.
 *  SERVO_ONLY       - modes whose mixers[] row has motorCount 0 and
 *                     useServo true, and which exist to drive servos from
 *                     something other than a flight mix: the camera
 *                     gimbal and the PPM-to-servo relay.
 *  MIXED_ACTUATOR   - airframes where motors and servos SHARE the control
 *                     axes: the two tricopter modes (whose motor mixer
 *                     carries a yaw coefficient of exactly 0.0 on all
 *                     three motors, because yaw comes from the tail
 *                     servo), plus bicopter, dualcopter and singlecopter.
 *  CUSTOM           - MIXER_CUSTOM alone. The firmware declines to
 *                     classify it: useServo is false, writeServos() has
 *                     no branch, mixerModeIsFixedWing() and
 *                     mixerIsTricopter() are both false, and what it
 *                     actually flies is decided by CLI `mmix` rows that
 *                     MSP never exposes. Saying "unknown" here would be
 *                     equally true; saying "multirotor" would be a guess.
 *  UNKNOWN          - the mixer id is not in the pinned table.
 *
 * NOTE that CUSTOM_AIRPLANE is FIXED_WING and CUSTOM_TRI is
 * MIXED_ACTUATOR. Their motor COUNT is runtime-derived, but the firmware
 * is explicit about their airframe: mixerModeIsFixedWing() names
 * MIXER_CUSTOM_AIRPLANE (mixer_init.c:521), mixerIsTricopter() names
 * MIXER_CUSTOM_TRI (mixer_init.c:327), and writeServos() gives each the
 * same servo list as its non-custom twin (servos.c:349-368). Family and
 * count strategy are two independent axes and this table keeps them so.
 */
export type AirframeFamily =
  | 'MULTIROTOR'
  | 'FIXED_WING'
  | 'ROTORCRAFT_OTHER'
  | 'SERVO_ONLY'
  | 'MIXED_ACTUATOR'
  | 'CUSTOM'
  | 'UNKNOWN';

/**
 * A mixer mode that validateAndFixConfig() (config.c:200-218 @ 7348054f)
 * REWRITES to another mode on a standard build, before anything can
 * observe it.
 *
 * The rule, applied to any mode that is not one of the three custom ones:
 *
 *   if (mixers[m].motorCount && mixers[m].motor == NULL)  -> MIXER_CUSTOM
 *   if (mixers[m].useServo && servoMixers[m].servoRuleCount == 0)
 *                                                 -> MIXER_CUSTOM_AIRPLANE
 *
 * WHY THIS IS RECORDED BUT NEVER ACTED ON. It runs inside readEEPROM()
 * (config.c:690) and writeUnmodifiedConfigToEEPROM() (config.c:701), so
 * by the time this application can read MSP_MIXER_CONFIG the rewrite has
 * already happened and the byte on the wire is the POST-validation mode.
 * The field exists to explain to a reader why three of the 27 modes can
 * be written and never read back, not to let any code predict a rewrite.
 *
 * It is also BUILD-CONDITIONAL. The whole block is compiled out under
 * USE_QUAD_MIXER_ONLY, the second rule additionally requires USE_SERVOS,
 * and the servo rule counts it consults collapse to zero for four more
 * modes when USE_UNCOMMON_MIXERS is absent. Both USE_SERVOS
 * (common_pre.h:206) and USE_UNCOMMON_MIXERS (common_pre.h:376) are
 * unconditional on a standard build at this pin, which is the build this
 * field describes and the only one it claims anything about.
 */
export interface MixerConfigValidationRewrite {
  /** The mixer id the firmware substitutes. */
  readonly toMixerId: number;
  /** Which of the two rules fires. */
  readonly rule: 'MOTOR_COUNT_WITHOUT_MOTOR_TABLE' | 'USE_SERVO_WITHOUT_SERVO_RULES';
}

/** One row of the reference table. Every field is a re-expressed reading
 * of the pinned source; none is inferred from another. */
export interface MixerReferenceEntry {
  /** The wire value: MSP_MIXER_CONFIG offset 0, and the mixerMode_e
   * ordinal. 1..27. */
  readonly mixerId: number;
  /**
   * The firmware's own identifier for the mode, as it appears in
   * mixerMode_e and (in an abbreviated form) in the CLI's mixer names.
   * PROTOCOL VOCABULARY, not a display string: it is never shown to a
   * user, never translated, and carries no branding.
   */
  readonly firmwareName: string;
  readonly motorCountStrategy: MotorCountStrategy;
  /** Servo channels writeServos()'s own branch emits. See
   * ServoCountStrategy - this is a base, not a total. */
  readonly baseServoOutputs: ServoCountStrategy;
  readonly family: AirframeFamily;
  /** mixers[mode].useServo (mixer_init.c:253-283), which is what
   * hasServos() returns (mixer_init.c:288-291). Recorded separately from
   * `baseServoOutputs` because the two genuinely disagree for three
   * modes: MIXER_HELI_90_DEG and MIXER_PPM_TO_SERVO have useServo true
   * and no writeServos() branch at all, and MIXER_GIMBAL has useServo
   * true with its two servos coming from the gimbal block rather than the
   * switch. */
  readonly tableUseServo: boolean;
  /** True where mixerModeIsFixedWing() (mixer_init.c:517-530) returns
   * true. Kept as its own field, not derived from `family`, so the
   * firmware predicate stays independently checkable. */
  readonly firmwareFixedWingPredicate: boolean;
  /** True where mixerIsTricopter() (mixer_init.c:325-328) returns true. */
  readonly firmwareTricopterPredicate: boolean;
  /** Present only for the three modes a standard build rewrites. */
  readonly configValidationRewrite?: MixerConfigValidationRewrite;
}

const TABLE_FIXED = (count: number): MotorCountStrategy =>
  Object.freeze({kind: 'TABLE_FIXED' as const, count});
const CUSTOM_RUNTIME_DERIVED: MotorCountStrategy = Object.freeze({
  kind: 'CUSTOM_RUNTIME_DERIVED' as const,
});
const NO_MOTORS: MotorCountStrategy = Object.freeze({kind: 'NO_MOTORS' as const});

const SERVOS = (count: number): ServoCountStrategy =>
  Object.freeze({kind: 'TABLE_FIXED' as const, count});
const NO_SERVOS: ServoCountStrategy = Object.freeze({kind: 'NO_SERVOS' as const});

/** MIXER_CUSTOM, the target of the MOTOR_COUNT_WITHOUT_MOTOR_TABLE rule. */
const MIXER_ID_CUSTOM = 23;
/** MIXER_CUSTOM_AIRPLANE, the target of the USE_SERVO_WITHOUT_SERVO_RULES
 * rule. */
const MIXER_ID_CUSTOM_AIRPLANE = 24;
/** MIXER_CUSTOM_TRI. */
const MIXER_ID_CUSTOM_TRI = 25;

const entry = (
  mixerId: number,
  firmwareName: string,
  motorCountStrategy: MotorCountStrategy,
  baseServoOutputs: ServoCountStrategy,
  family: AirframeFamily,
  tableUseServo: boolean,
  firmwareFixedWingPredicate: boolean,
  firmwareTricopterPredicate: boolean,
  configValidationRewrite?: MixerConfigValidationRewrite,
): MixerReferenceEntry =>
  Object.freeze(
    configValidationRewrite === undefined
      ? {
          mixerId,
          firmwareName,
          motorCountStrategy,
          baseServoOutputs,
          family,
          tableUseServo,
          firmwareFixedWingPredicate,
          firmwareTricopterPredicate,
        }
      : {
          mixerId,
          firmwareName,
          motorCountStrategy,
          baseServoOutputs,
          family,
          tableUseServo,
          firmwareFixedWingPredicate,
          firmwareTricopterPredicate,
          configValidationRewrite: Object.freeze(configValidationRewrite),
        },
  );

/**
 * The 27 mixer modes of Betaflight MSP API 1.47, in wire order.
 *
 * Motor counts come from mixers[] (mixer_init.c:253-283) for every
 * non-custom mode and from mixerConfigureOutput()'s custom branch
 * (mixer_init.c:426-436) for the three custom ones. Servo counts come
 * from writeServos() (servos.c:342-404). Families are argued in the
 * AirframeFamily doc comment above; the two firmware predicates are
 * transcribed from mixerModeIsFixedWing() and mixerIsTricopter().
 *
 * THE THREE CUSTOM MODES ALL DERIVE THEIR COUNT AT RUNTIME. mixers[] does
 * carry a motorCount for two of them - `{1, true, NULL}` for
 * CUSTOM_AIRPLANE and `{3, true, NULL}` for CUSTOM_TRI - and neither
 * number is ever read for the count, because mixerConfigureOutput()'s
 * first branch matches all three modes and returns before the
 * else-branch that would consult the table. Those table numbers are
 * therefore NOT recorded as counts anywhere in this file; recording them
 * would create a second, wrong answer to a question this table already
 * answers correctly.
 */
export const BETAFLIGHT_MIXER_REFERENCE_V147: readonly MixerReferenceEntry[] =
  Object.freeze([
    entry(1, 'TRI', TABLE_FIXED(3), SERVOS(1), 'MIXED_ACTUATOR', true, false, true),
    entry(2, 'QUADP', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(3, 'QUADX', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(4, 'BICOPTER', TABLE_FIXED(2), SERVOS(2), 'MIXED_ACTUATOR', true, false, false),
    // motorCount 0 with useServo true. Its two servos are written by the
    // gimbal block (servos.c:400-403), not by the writeServos() switch.
    entry(5, 'GIMBAL', NO_MOTORS, SERVOS(2), 'SERVO_ONLY', true, false, false),
    entry(6, 'Y6', TABLE_FIXED(6), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(7, 'HEX6', TABLE_FIXED(6), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(8, 'FLYING_WING', TABLE_FIXED(1), SERVOS(2), 'FIXED_WING', true, true, false),
    entry(9, 'Y4', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(10, 'HEX6X', TABLE_FIXED(6), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(11, 'OCTOX8', TABLE_FIXED(8), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(12, 'OCTOFLATP', TABLE_FIXED(8), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(13, 'OCTOFLATX', TABLE_FIXED(8), NO_SERVOS, 'MULTIROTOR', false, false, false),
    // SERVO_PLANE_INDEX_MIN..MAX is SERVO_FLAPS(2)..SERVO_THROTTLE(7), six
    // channels (servos.h:75-76, servos.c:363-368).
    entry(14, 'AIRPLANE', TABLE_FIXED(1), SERVOS(6), 'FIXED_WING', true, true, false),
    entry(15, 'HELI_120_CCPM', TABLE_FIXED(1), SERVOS(4), 'ROTORCRAFT_OTHER', true, false, false),
    // useServo true, servoMixers[16].servoRuleCount 0 (servos.c:206), and
    // no writeServos() branch: rewritten before it can be observed.
    entry(16, 'HELI_90_DEG', NO_MOTORS, NO_SERVOS, 'ROTORCRAFT_OTHER', true, false, false, {
      toMixerId: MIXER_ID_CUSTOM_AIRPLANE,
      rule: 'USE_SERVO_WITHOUT_SERVO_RULES',
    }),
    entry(17, 'VTAIL4', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(18, 'HEX6H', TABLE_FIXED(6), NO_SERVOS, 'MULTIROTOR', false, false, false),
    // Same shape as HELI_90_DEG: useServo true, servoMixers[19] empty.
    entry(19, 'PPM_TO_SERVO', NO_MOTORS, NO_SERVOS, 'SERVO_ONLY', true, false, false, {
      toMixerId: MIXER_ID_CUSTOM_AIRPLANE,
      rule: 'USE_SERVO_WITHOUT_SERVO_RULES',
    }),
    entry(20, 'DUALCOPTER', TABLE_FIXED(2), SERVOS(2), 'MIXED_ACTUATOR', true, false, false),
    // mixers[21] is `{1, true, NULL}` - a non-zero motorCount with a NULL
    // motor table - which is exactly the MOTOR_COUNT_WITHOUT_MOTOR_TABLE
    // rule's trigger. SERVO_SINGLECOPTER_INDEX_MIN..MAX is four channels
    // (servos.h:81-82, servos.c:388-391).
    entry(21, 'SINGLECOPTER', TABLE_FIXED(1), SERVOS(4), 'MIXED_ACTUATOR', true, false, false, {
      toMixerId: MIXER_ID_CUSTOM,
      rule: 'MOTOR_COUNT_WITHOUT_MOTOR_TABLE',
    }),
    entry(22, 'ATAIL4', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(
      MIXER_ID_CUSTOM,
      'CUSTOM',
      CUSTOM_RUNTIME_DERIVED,
      NO_SERVOS,
      'CUSTOM',
      false,
      false,
      false,
    ),
    entry(
      MIXER_ID_CUSTOM_AIRPLANE,
      'CUSTOM_AIRPLANE',
      CUSTOM_RUNTIME_DERIVED,
      SERVOS(6),
      'FIXED_WING',
      true,
      true,
      false,
    ),
    entry(
      MIXER_ID_CUSTOM_TRI,
      'CUSTOM_TRI',
      CUSTOM_RUNTIME_DERIVED,
      SERVOS(1),
      'MIXED_ACTUATOR',
      true,
      false,
      true,
    ),
    entry(26, 'QUADX_1234', TABLE_FIXED(4), NO_SERVOS, 'MULTIROTOR', false, false, false),
    entry(27, 'OCTOX8P', TABLE_FIXED(8), NO_SERVOS, 'MULTIROTOR', false, false, false),
  ]);

const BY_ID: ReadonlyMap<number, MixerReferenceEntry> = new Map(
  BETAFLIGHT_MIXER_REFERENCE_V147.map(row => [row.mixerId, row]),
);

/**
 * Looks up one mixer mode, or returns undefined for an id the pinned
 * table does not cover. NEVER substitutes a default: an unrecognised
 * mixer is an unrecognised mixer, and a quad-shaped guess would be the
 * exact failure this module exists to prevent.
 */
export function findMixerReference(
  mixerModeRaw: number,
): MixerReferenceEntry | undefined {
  if (!Number.isInteger(mixerModeRaw)) {
    return undefined;
  }
  return BY_ID.get(mixerModeRaw);
}

/**
 * MIXERS FOR WHICH THIS APPLICATION HAS AN ORIGINAL POSITIONAL LAYOUT.
 *
 * A PROPERTY OF THIS APP'S OWN DRAWING, NOT OF BETAFLIGHT. Membership
 * means someone here authored a diagram that places each motor output at
 * a real position on the airframe. It says nothing about the firmware,
 * and nothing about propeller rotation direction: no layout in this
 * application asserts a direction, and none may be derived from a mixer
 * mode (see motorTopologyTruth.ts, which refuses to carry one).
 *
 * Adding a mixer here requires authoring new artwork in this project.
 * Copying a Betaflight SVG, GLTF or image to satisfy it is not permitted
 * under this project's reuse policy, and no such asset has been copied.
 *
 * Every other mixer falls back to the numbered-output presentation, which
 * is honest about showing outputs rather than positions.
 */
export const MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT: readonly number[] =
  Object.freeze([MIXER_MODE_QUADX, MIXER_MODE_QUADX_1234]);

/** Whether this application can draw the mixer's outputs in their real
 * airframe positions. */
export function mixerHasAuthoredPositionalLayout(mixerModeRaw: number): boolean {
  return MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT.includes(mixerModeRaw);
}

/**
 * WHY A CUSTOM MIXER'S MOTOR COUNT CANNOT BE PREDICTED FROM MSP.
 *
 * The rows mixerConfigureOutput() walks live in the `customMotorMixer`
 * parameter group, and at this pin the ONLY way to read or write them is
 * the CLI `mmix` command (cli.c:1842-1908). No MSP command carries them
 * at API 1.47, and none carries them at API 1.49 either. `mmix reset`
 * zeroes all eight rows, which makes the derived count 0 - including for
 * MIXER_CUSTOM_TRI, whose table row says 3 and is never consulted.
 *
 * Exported as a named constant so a caller states this rather than
 * silently filling the gap.
 */
export const CUSTOM_MIXER_IS_CLI_ONLY =
  'The custom motor mixer rows are readable and writable only through the ' +
  'CLI `mmix` command at this pinned firmware. No MSP command exposes them, ' +
  'so the motor count a custom mixer derives can be observed through ' +
  'MSP_MOTOR_CONFIG but never predicted from the mixer mode alone.';
