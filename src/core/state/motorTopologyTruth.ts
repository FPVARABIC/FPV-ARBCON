/**
 * M-B - MOTOR TOPOLOGY TRUTH: four independent answers to four different
 * questions about an airframe, assembled without any of them overwriting
 * any other.
 *
 * THE PROBLEM THIS TYPE EXISTS TO SOLVE. Betaflight will tell you how
 * many motors a machine has in four different places, and they are not
 * the same question:
 *
 *   1. THE MIXER TABLE says what the configured mixer mode implies - a
 *      compile-time constant for 24 of the 27 modes, and "walk the CLI's
 *      custom rows" for the other three.
 *   2. MSP_MOTOR_CONFIG offset 6 is getMotorCount(), the number the
 *      RUNNING firmware settled on at boot. This is the authority.
 *   3. MSP_MOTOR returns EIGHT output slots whatever the airframe is, and
 *      writes a zero into any slot that is not an enabled motor output.
 *   4. MSP_MOTOR_TELEMETRY declares its own count in its first byte.
 *
 * The reference Configurator collapses (2) and (3) with a
 * `min(motor_count, firstZeroIndex)` and falls back to a hard-coded 4
 * when the mixer is unrecognised. That is a display convenience; it is
 * not a truth model, and it cannot represent a disagreement at all. This
 * module keeps all four answers, side by side, and reports disagreements
 * as disagreements.
 *
 * NO FIELD OVERWRITES ANOTHER. There is no merge step, no precedence
 * order and no "best guess" field. A caller that wants one number picks
 * the one whose question it is actually asking, and the type makes it say
 * which.
 *
 * ============================ SOURCE PIN ============================
 * Betaflight firmware commit 7348054f268f0058574719c134e9f149565bb8ea
 * (FC 2025.12.5), MSP API 1.47 (msp_protocol.h:61-62). Cross-checked
 * against master 1efac3ef1 (API 1.49); see betaflightMixerReferenceV147.ts
 * for the per-file identity findings. API 1.48 is NOT VERIFIED and no
 * branch here keys off any API version.
 *
 * ================ WHY MSP_MOTOR'S ZEROS ARE NOT A COUNT ================
 * msp.c:1198-1211 @ 7348054f writes, for each of eight slots:
 *
 *     if (!motorIsEnabled() || i >= MAX_SUPPORTED_MOTORS || !motorIsMotorEnabled(i))
 *         -> zero
 *     else
 *         -> motorConvertToExternal(motor[i])
 *
 * Three separate readings establish what a zero means and what it does
 * not mean:
 *
 *  (a) ENABLED SLOTS ARE CONTIGUOUS FROM ZERO. motorIsMotorEnabled(i)
 *      (motor.c:350-353) delegates to the motor driver. All three drivers
 *      - analog PWM (pwm_output_hw.c:212-260), DShot DMA
 *      (dshot_dpwm.c:187-212) and DShot bitbang (dshot_bitbang.c:748-799)
 *      - loop `motorIndex` from 0 while it is below both
 *      MAX_SUPPORTED_MOTORS and the device count, set that index's
 *      `enabled` flag on success, and on the FIRST failure abandon the
 *      whole initialisation: they zero the device count, return false,
 *      and motorDevInit() (motor.c:272-311) installs the null device
 *      whose isMotorEnabled always returns false. Upstream's own comment
 *      on those failure paths calls it "a break in the motors". So a HOLE
 *      IS NOT REACHABLE: `[1200, 1200, 0, 1200, 0, 0, 0, 0]` cannot be
 *      produced by the enable mask. Either the first k slots are enabled
 *      and the rest are not, or none are.
 *
 *  (b) AN ENABLED SLOT DOES NOT REPORT ZERO. On the DShot path
 *      dshotConvertToExternal() (dshot.c:96-113) floors its result at
 *      PWM_RANGE_MIN, i.e. 1000. On the analog path pwmConvertToExternal()
 *      is an identity cast and the disarmed value is
 *      motorConfig->mincommand (motor.c analogInitEndpoints, non-3D
 *      branch) or flight3DConfig()->neutral3d under 3D; `min_command`'s
 *      settable range is PWM_PULSE_MIN..PWM_PULSE_MAX = 750..2250
 *      (settings.c:960, rx.h:37-38), and validateAndFixConfig() raises it
 *      to at least 1000 for brushed motors (config.c:282-284).
 *
 *  (c) BUT A ZERO STILL DOES NOT BOUND THE MOTOR COUNT, because the
 *      FIRST condition in that `if` is `!motorIsEnabled()` - a single
 *      device-wide flag, not a per-slot one. motorDisable() is called
 *      during ESC passthrough (serial_4way.c:151-161,
 *      serial_escserial.c:941), around blocking DShot commands
 *      (msp.c:3582, cli.c:3938) and by the CLI (cli.c:1650). While it is
 *      clear, MSP_MOTOR returns EIGHT ZEROES on a perfectly healthy
 *      four-motor quad. So an observed count of zero enabled slots is a
 *      normal state, never evidence that the airframe has no motors.
 *
 * THE RULE THIS MODULE THEREFORE FOLLOWS: `runtimeMotorCount` comes
 * SOLELY from MSP_MOTOR_CONFIG. MSP_MOTOR contributes eight observed
 * slots, each ENABLED or DISABLED_OR_UNAVAILABLE_SENTINEL, and a derived
 * `observedEnabledSlotCount` that is deliberately NOT called a motor
 * count and is never allowed to redefine the topology.
 *
 * ================== WHAT THIS MODULE REFUSES TO CARRY ==================
 *  - NO PROPELLER ROTATION DIRECTION. Not CW, not CCW, not "props out",
 *    not "reversed". A mixer mode does not determine which way a
 *    propeller turns, and `yaw_motors_reversed` is a PID sign flip rather
 *    than an output remap (see decodeMixerConfig.ts). Only a human
 *    looking at the aircraft can establish direction. There is no field
 *    for it here and a test enforces that there never is.
 *  - NO HEALTH, SCORE OR VERDICT. A disagreement between two frames is
 *    reported as a named disagreement, not diagnosed as a fault.
 *  - NO PHYSICAL CLAIM. Nothing here says a motor is spinning, stopped,
 *    connected or working. Those remain REQUIRES HARDWARE TEST.
 *
 * PRESENTATION INDEPENDENCE. Slot indices in this module are LOGICAL
 * firmware output indices, zero-based, in the order MSP_MOTOR sent them.
 * They are never reordered for a right-to-left interface; mirroring is a
 * drawing decision that belongs to a view, and reversing an index here
 * would silently renumber the machine's motors.
 */

import {
  findMixerReference,
  mixerHasAuthoredPositionalLayout,
  MIXER_REFERENCE_MAX_SUPPORTED_MOTORS,
  type AirframeFamily,
  type MixerReferenceEntry,
  type MotorCountStrategy,
  type ServoCountStrategy,
} from '../firmware-adapters/betaflightMixerReferenceV147';
import {MSP_MOTOR_OUTPUT_SLOT_COUNT} from '../protocol/msp/decoding/decodeMotorOutputs';

/** One slot of the eight MSP_MOTOR always returns. */
export type MotorOutputSlot =
  | {
      readonly kind: 'ENABLED';
      /** The external value the firmware reported for this slot. NOT a
       * statement that anything is turning. */
      readonly externalValue: number;
    }
  | {
      /** Zero on the wire. Means "not an enabled motor output right now",
       * which covers a slot beyond the motor count, a slot the driver
       * never allocated, and EVERY slot while motorIsEnabled() is clear.
       * It is one sentinel for several causes and this type does not
       * pretend to tell them apart. */
      readonly kind: 'DISABLED_OR_UNAVAILABLE_SENTINEL';
    };

/** MSP_MOTOR_CONFIG offset 6 - the authority, when it has been read. */
export type RuntimeMotorCount =
  | {readonly kind: 'REPORTED'; readonly count: number}
  | {readonly kind: 'NOT_READ'};

/** MSP_MOTOR - eight slots, or nothing. */
export type ObservedMotorOutputs =
  | {readonly kind: 'NOT_READ'}
  | {
      readonly kind: 'OBSERVED';
      /** Exactly MSP_MOTOR_OUTPUT_SLOT_COUNT entries, logical order. */
      readonly slots: readonly MotorOutputSlot[];
      /**
       * How many slots reported an enabled output in THIS frame.
       *
       * DELIBERATELY NOT NAMED A MOTOR COUNT, and deliberately never
       * assigned to `runtimeMotorCount`. It is a lower bound at best: it
       * is legitimately 0 on a healthy machine whenever motorIsEnabled()
       * is clear (see this module's header, reading (c)).
       */
      readonly observedEnabledSlotCount: number;
      /** Whether every enabled slot precedes every disabled one. The
       * firmware's driver initialisation makes false unreachable; if it
       * is ever false, that is a genuine contradiction and is reported as
       * one rather than silently normalised. */
      readonly enabledSlotsAreContiguousFromZero: boolean;
    };

/**
 * MSP_MOTOR_TELEMETRY's own leading byte.
 *
 * NAMED FOR THE FRAME, NOT FOR THE FLEET. It is the number of records
 * THIS TELEMETRY FRAME carries, which msp.c:1213-1214 writes as
 * getMotorCount() - so it normally equals the runtime count, and a name
 * like "number of motors with telemetry" would be a different and much
 * stronger claim: it would suggest each record is a valid measurement
 * from a responding ESC. It is not. SOURCE AVAILABLE, PACKET RECEIVED and
 * VALID MEASUREMENT AVAILABLE remain three separate facts, decided
 * elsewhere and never by this count.
 */
export type TelemetryFrameMotorCount =
  | {readonly kind: 'REPORTED'; readonly count: number}
  | {readonly kind: 'NOT_READ'};

/** What can be known about a custom mixer's rows. */
export type CustomMixerVisibility =
  | {readonly kind: 'NOT_APPLICABLE'}
  | {
      /** The mixer is one of the three custom modes, so its motor count
       * is whatever the CLI `mmix` rows produced. Those rows are not on
       * any MSP command at this pin, so the count can be OBSERVED through
       * MSP_MOTOR_CONFIG but never PREDICTED. */
      readonly kind: 'RUNTIME_DERIVED_NOT_READABLE_OVER_MSP';
    };

/**
 * A named disagreement between two things the flight controller said.
 *
 * EVERY MEMBER IS A PROTOCOL-LEVEL CONTRADICTION - two frames, or a frame
 * and the pinned firmware's own rules, that cannot both be right. None of
 * them is a product gap, a missing screen or an unimplemented feature.
 * In particular there is deliberately NO member for "this mixer expects
 * servos and this application does not model servos": that is a statement
 * about our product's scope, the flight controller has said nothing
 * inconsistent, and filing it here would corrupt a channel that exists to
 * report the board contradicting itself.
 */
export type MotorTopologyContradiction =
  /** MSP_MIXER_CONFIG's mode byte is not one of the 27 the pinned table
   * covers. Nothing about the airframe is assumed from it. */
  | 'MIXER_MODE_NOT_IN_PINNED_TABLE'
  /** MSP_MOTOR_CONFIG reported more motors than MAX_SUPPORTED_MOTORS.
   * mixerConfigureOutput() clamps to that bound on both of its branches,
   * so this cannot happen at the pinned firmware. */
  | 'RUNTIME_COUNT_EXCEEDS_FIRMWARE_MAXIMUM'
  /** The mixer's count is a compile-time constant and the running
   * firmware reported a different one. */
  | 'RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE'
  /** The mixer drives no motors at all and the firmware reported some. */
  | 'RUNTIME_COUNT_NONZERO_FOR_MOTORLESS_MIXER'
  /** More slots reported an enabled output than the firmware says it has
   * motors. MSP_MOTOR's own guard makes this unreachable. */
  | 'OBSERVED_ENABLED_SLOTS_EXCEED_RUNTIME_COUNT'
  /** A disabled slot precedes an enabled one. The driver initialisation
   * makes a hole unreachable; see reading (a) in the header. */
  | 'OBSERVED_ENABLED_SLOTS_NOT_CONTIGUOUS'
  /** MSP_MOTOR_TELEMETRY declared a different count from
   * MSP_MOTOR_CONFIG, though msp.c writes both from getMotorCount(). */
  | 'TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT';

/** Everything this module knows about one airframe's topology. */
export interface MotorTopologyTruth {
  /** The raw MSP_MIXER_CONFIG byte, preserved even when unrecognised. */
  readonly mixerModeRaw: number;
  /** The pinned table row, or undefined for an id outside it. */
  readonly mixer: MixerReferenceEntry | undefined;
  /** UNKNOWN when the mixer id is not in the table. Never guessed. */
  readonly family: AirframeFamily;
  /** WHAT THE MIXER IMPLIES - a strategy, not a number. */
  readonly expectedMotorCount: MotorCountStrategy;
  /** Servo channels writeServos() emits for this mixer, before
   * FEATURE_SERVO_TILT and channel forwarding. Carried so a reader can
   * see that an airframe has servo actuators; NOT a request to build a
   * servo screen and NOT a contradiction if none exists. */
  readonly expectedServoCount: ServoCountStrategy;
  /** WHAT THE RUNNING FIRMWARE SAYS - the authority. */
  readonly runtimeMotorCount: RuntimeMotorCount;
  /** WHAT THE OUTPUT FRAME SHOWED - eight slots, never a count. */
  readonly observedMotorOutputs: ObservedMotorOutputs;
  /** WHAT THE TELEMETRY FRAME DECLARED - its own record count. */
  readonly telemetryFrameMotorCount: TelemetryFrameMotorCount;
  readonly customMixer: CustomMixerVisibility;
  /** Whether THIS APPLICATION has an original positional diagram for this
   * mixer. A property of our drawing, not of the firmware, and never a
   * claim about rotation direction. */
  readonly layoutKnown: boolean;
  /** Named disagreements, in a stable order. Empty when the board's
   * answers are consistent with each other and with the pinned rules. */
  readonly contradictions: readonly MotorTopologyContradiction[];
}

/** Already-decoded frames. Every field is optional because a caller may
 * legitimately have read some and not others; absence is reported as
 * NOT_READ and never filled in. */
export interface MotorTopologyObservation {
  /** MSP_MIXER_CONFIG offset 0, raw. */
  readonly mixerModeRaw: number;
  /** MSP_MOTOR_CONFIG offset 6. */
  readonly runtimeMotorCount?: number;
  /** MSP_MOTOR, exactly eight external values in logical output order. */
  readonly motorOutputSlots?: readonly number[];
  /** MSP_MOTOR_TELEMETRY's leading byte. */
  readonly telemetryFrameMotorCount?: number;
}

export class MotorTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorTopologyError';
  }
}

function requireSlotVector(values: readonly number[]): void {
  if (!Array.isArray(values)) {
    throw new MotorTopologyError(
      `deriveMotorTopologyTruth: motorOutputSlots must be an array, received ${typeof values}.`,
    );
  }
  if (values.length !== MSP_MOTOR_OUTPUT_SLOT_COUNT) {
    throw new MotorTopologyError(
      `deriveMotorTopologyTruth: motorOutputSlots must carry exactly ` +
        `${MSP_MOTOR_OUTPUT_SLOT_COUNT} slots, received ${values.length}. ` +
        'MSP_MOTOR always returns eight, whatever the airframe (msp.c:1199 @ 7348054f); ' +
        'a shorter vector means the caller trimmed it, and trimming is exactly the ' +
        'mistake this model exists to prevent.',
    );
  }
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new MotorTopologyError(
        `deriveMotorTopologyTruth: motorOutputSlots[${index}] must be a non-negative ` +
          `integer, received ${String(value)}.`,
      );
    }
  }
}

function requireCount(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MotorTopologyError(
      `deriveMotorTopologyTruth: ${label} must be a non-negative integer, received ${String(value)}.`,
    );
  }
}

function readSlots(values: readonly number[]): ObservedMotorOutputs {
  const slots: MotorOutputSlot[] = values.map(value =>
    value === 0
      ? Object.freeze({kind: 'DISABLED_OR_UNAVAILABLE_SENTINEL' as const})
      : Object.freeze({kind: 'ENABLED' as const, externalValue: value}),
  );
  const observedEnabledSlotCount = slots.filter(slot => slot.kind === 'ENABLED').length;
  // Contiguous means: no ENABLED slot appears after a
  // DISABLED_OR_UNAVAILABLE_SENTINEL one. Computed by looking for the
  // first sentinel and checking nothing enabled follows it, rather than
  // by comparing against the count - the two differ precisely in the
  // hole case, which is the case worth detecting.
  const firstSentinel = slots.findIndex(
    slot => slot.kind === 'DISABLED_OR_UNAVAILABLE_SENTINEL',
  );
  const enabledSlotsAreContiguousFromZero =
    firstSentinel === -1 ||
    slots.slice(firstSentinel).every(slot => slot.kind !== 'ENABLED');
  return Object.freeze({
    kind: 'OBSERVED' as const,
    slots: Object.freeze(slots),
    observedEnabledSlotCount,
    enabledSlotsAreContiguousFromZero,
  });
}

/**
 * Assembles the topology truth for one airframe.
 *
 * Total and side-effect-free. It never defaults a count, never merges two
 * answers into one, and never substitutes a quad for an airframe it does
 * not recognise. It throws only on inputs that are structurally
 * impossible on the wire - a slot vector that is not eight long, or a
 * negative count - because those mean a caller reshaped the data before
 * it arrived here.
 */
export function deriveMotorTopologyTruth(
  observation: MotorTopologyObservation,
): MotorTopologyTruth {
  const {mixerModeRaw} = observation;
  if (typeof mixerModeRaw !== 'number' || !Number.isInteger(mixerModeRaw)) {
    throw new MotorTopologyError(
      `deriveMotorTopologyTruth: mixerModeRaw must be an integer, received ${String(mixerModeRaw)}.`,
    );
  }

  const mixer = findMixerReference(mixerModeRaw);
  const contradictions: MotorTopologyContradiction[] = [];
  if (mixer === undefined) {
    contradictions.push('MIXER_MODE_NOT_IN_PINNED_TABLE');
  }

  const expectedMotorCount: MotorCountStrategy =
    mixer?.motorCountStrategy ?? Object.freeze({kind: 'UNKNOWN' as const});
  const expectedServoCount: ServoCountStrategy =
    mixer?.baseServoOutputs ?? Object.freeze({kind: 'UNKNOWN' as const});

  let runtimeMotorCount: RuntimeMotorCount = Object.freeze({kind: 'NOT_READ' as const});
  if (observation.runtimeMotorCount !== undefined) {
    requireCount(observation.runtimeMotorCount, 'runtimeMotorCount');
    runtimeMotorCount = Object.freeze({
      kind: 'REPORTED' as const,
      count: observation.runtimeMotorCount,
    });
  }

  let observedMotorOutputs: ObservedMotorOutputs = Object.freeze({
    kind: 'NOT_READ' as const,
  });
  if (observation.motorOutputSlots !== undefined) {
    requireSlotVector(observation.motorOutputSlots);
    observedMotorOutputs = readSlots(observation.motorOutputSlots);
  }

  let telemetryFrameMotorCount: TelemetryFrameMotorCount = Object.freeze({
    kind: 'NOT_READ' as const,
  });
  if (observation.telemetryFrameMotorCount !== undefined) {
    requireCount(observation.telemetryFrameMotorCount, 'telemetryFrameMotorCount');
    telemetryFrameMotorCount = Object.freeze({
      kind: 'REPORTED' as const,
      count: observation.telemetryFrameMotorCount,
    });
  }

  if (runtimeMotorCount.kind === 'REPORTED') {
    const reported = runtimeMotorCount.count;
    if (reported > MIXER_REFERENCE_MAX_SUPPORTED_MOTORS) {
      contradictions.push('RUNTIME_COUNT_EXCEEDS_FIRMWARE_MAXIMUM');
    }
    if (expectedMotorCount.kind === 'TABLE_FIXED' && reported !== expectedMotorCount.count) {
      contradictions.push('RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE');
    }
    if (expectedMotorCount.kind === 'NO_MOTORS' && reported > 0) {
      contradictions.push('RUNTIME_COUNT_NONZERO_FOR_MOTORLESS_MIXER');
    }
    if (
      observedMotorOutputs.kind === 'OBSERVED' &&
      observedMotorOutputs.observedEnabledSlotCount > reported
    ) {
      // The reverse - FEWER enabled slots than motors - is NOT recorded.
      // It is the normal state whenever motorIsEnabled() is clear, and
      // calling it a contradiction would flag a healthy board mid-ESC-
      // passthrough as broken.
      contradictions.push('OBSERVED_ENABLED_SLOTS_EXCEED_RUNTIME_COUNT');
    }
    if (
      telemetryFrameMotorCount.kind === 'REPORTED' &&
      telemetryFrameMotorCount.count !== reported
    ) {
      contradictions.push('TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT');
    }
  }

  if (
    observedMotorOutputs.kind === 'OBSERVED' &&
    !observedMotorOutputs.enabledSlotsAreContiguousFromZero
  ) {
    contradictions.push('OBSERVED_ENABLED_SLOTS_NOT_CONTIGUOUS');
  }

  const customMixer: CustomMixerVisibility =
    expectedMotorCount.kind === 'CUSTOM_RUNTIME_DERIVED'
      ? Object.freeze({kind: 'RUNTIME_DERIVED_NOT_READABLE_OVER_MSP' as const})
      : Object.freeze({kind: 'NOT_APPLICABLE' as const});

  return Object.freeze({
    mixerModeRaw,
    mixer,
    family: mixer?.family ?? 'UNKNOWN',
    expectedMotorCount,
    expectedServoCount,
    runtimeMotorCount,
    observedMotorOutputs,
    telemetryFrameMotorCount,
    customMixer,
    layoutKnown: mixerHasAuthoredPositionalLayout(mixerModeRaw),
    contradictions: Object.freeze(contradictions),
  });
}
