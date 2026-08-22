/**
 * SENSORS - ORCHESTRATION ONLY.
 *
 * Wire truth lives in the B-1 codecs, sensor truth in B-2's
 * sensorTruthSemantics, and neither is re-derived here. This module
 * sequences MSP operations and decides when a result may be called done.
 *
 * ==================================================================
 * THE FIVE THINGS THAT MAKE THE NAIVE VERSION WRONG
 * ==================================================================
 *
 * 1. THE ALIGNMENT READ AND WRITE ARE DIFFERENT FRAMES. MSP_SENSOR_ALIGNMENT
 *    (126) answers eleven bytes with the DETECTED gyro flags at byte 3 and
 *    the ENABLED gyro bitmask at byte 4. MSP_SET_SENSOR_ALIGNMENT (220)
 *    takes ten bytes with the ENABLED bitmask at byte 3. Reading eleven
 *    bytes, changing one and sending them back writes the detected flags
 *    into the enable mask - on a dual-gyro board configured to run one
 *    gyro, that starts the other one. Every alignment save here re-reads
 *    the frame inside the same operation and takes the enable mask from
 *    byte FOUR, by name.
 *
 * 2. AN ACK IS NOT AN APPLY. Nothing in msp.c reports a refused write, and
 *    MSP_SET_SENSOR_CONFIG in particular consumes its bytes into whichever
 *    fields the build compiled in and discards the rest. Every save reads
 *    back before anything is persisted; a mismatch stops the sequence with
 *    no EEPROM write and no reboot.
 *
 * 3. A SENSOR SELECTION ONLY TAKES EFFECT AT BOOT. `sensorsAutodetect()`
 *    runs once during init, so changing acc_hardware over MSP changes a
 *    stored setting and nothing else until the board restarts. The hardware
 *    save therefore ends at AWAITING_REBOOT_VERIFICATION and hands back a
 *    token; only `verifyHardwarePersistence()`, against a genuinely NEW
 *    session, can return SUCCEEDED.
 *
 * 4. PERSISTENCE AND DETECTION ARE DIFFERENT QUESTIONS. After the reboot,
 *    "is the setting I asked for stored?" and "did the board find that
 *    part?" have separate answers and can legitimately disagree - pinning a
 *    barometer the aircraft does not have stores perfectly and detects
 *    nothing. Success is decided by the CONFIGURED values alone; what was
 *    detected comes back beside it as its own field.
 *
 * 5. A CALIBRATION ACK IS NOT A CALIBRATION. Both calibration handlers are
 *    `if (!ARMING_FLAG(ARMED)) { start... }` and acknowledge either way, so
 *    an armed board answers cheerfully and does nothing. Completion is
 *    observed through the arming-disable flags, never assumed, and every
 *    wait is bounded.
 *
 * ==================================================================
 * WHAT THIS MODULE DOES NOT DO
 * ==================================================================
 *
 * No reconnect driver, no serial queue, no scheduler, no second mutex: the
 * session's existing MspClient, MspTelemetryScheduler, MspSessionCoordinator
 * and fcRebootRecovery are used as they are. Telemetry pausing is not
 * implemented here either - MspOperationCoordinator.execute() takes the
 * scheduler's own pause lease for the whole operation and releases it on
 * every exit path, so a calibration that runs inside one operation is
 * covered by the mechanism that already exists.
 *
 * It does not write board alignment. MSP_SET_BOARD_ALIGNMENT_CONFIG is not
 * imported, not referenced and not sent; those angles belong to Setup.
 *
 * It does not own the gyro. MSP_SENSOR_CONFIG has no gyro byte at this API
 * revision, and the gyro enable mask inside the alignment frame is
 * PRESERVED, never authored.
 */

import {
  BoxIdsAcquisition,
  createMspOperationCoordinator,
  decodeAccTrim,
  decodeCompassConfig,
  decodeGyroSensorActive,
  decodeSensorAlignment,
  decodeSensorConfig,
  decodeSensorConfigActive,
  decodeStatusExDiagnostics,
  deriveArmedState,
  encodeAccTrim,
  encodeCompassConfig,
  encodeSensorAlignment,
  encodeSensorConfig,
  modelSensorHardware,
  MSP_ACC_CALIBRATION,
  MSP_ACC_TRIM,
  MSP_COMPASS_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_MAG_CALIBRATION,
  MSP_SENSOR_ALIGNMENT,
  MSP_SENSOR_CONFIG,
  MSP_SET_ACC_TRIM,
  MSP_SET_COMPASS_CONFIG,
  MSP_SET_SENSOR_ALIGNMENT,
  MSP_SET_SENSOR_CONFIG,
  MSP_STATUS_EX,
  MSP2_GYRO_SENSOR_ACTIVE,
  MSP2_SENSOR_CONFIG_ACTIVE,
  MspOperationOutcomeUnknownError,
  NOT_AVAILABLE_IN_THIS_CONTRACT,
  type AccTrim,
  type ArmedState,
  type BoxIdsOwnerIdentity,
  type CompassConfig,
  type GyroSensorActive,
  type MspClient,
  type MspClientState,
  type MspRequester,
  type MspTelemetryScheduler,
  type SensorAlignment,
  type SensorConfig,
  type SensorConfigActive,
  type SensorConfigContract,
  type SensorHardwareFamily,
} from '../../../core';
import {
  deriveSensorTruthSet,
  sensorsWithContradictions,
  type SensorTruth,
  type SensorTruthSet,
} from '../../../core/state/sensorTruthSemantics';
import {fcRebootRecovery} from './fcRebootRecovery';
import {isSupportedConfigurationApi} from './betaflightApiSupport';
import {
  mspSessionCoordinator,
  type MspIdentificationState,
  type MspSessionOwnershipState,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';
import {
  setupAppStateTelemetryOwner,
  type SetupAppStatePhase,
} from './setupAppStateTelemetryOwner';

const EMPTY = new Uint8Array(0);
const V1 = {wireFormat: 'v1'} as const;
const V2 = {wireFormat: 'v2'} as const;

/* ================================================================== *
 * TIMING, DERIVED FROM THE FIRMWARE RATHER THAN CHOSEN
 * ================================================================== */

/** How often the arming flags are re-read while an ACC calibration runs.
 *  `accStartCalibration()` sets a 400-cycle countdown, so the whole thing
 *  can be over in well under a second; a slow poll would miss it. */
export const ACC_CALIBRATION_POLL_INTERVAL_MS = 100;

/**
 * The whole ACC calibration, not one request.
 *
 * CALIBRATING_ACC_CYCLES is 400 (src/main/sensors/acceleration_init.c), so
 * the honest duration is a fraction of a second; the reference client falls
 * back after about two. This is four times that fallback, which leaves room
 * for a link where every status round trip costs most of its 2000 ms bound,
 * without ever becoming an unbounded wait.
 */
export const ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS = 8_000;

/** The magnetometer process is measured in tens of seconds; a fast poll
 *  would buy nothing and spend the link. */
export const MAG_CALIBRATION_POLL_INTERVAL_MS = 500;

/**
 * How long the CALIBRATING flag has to appear.
 *
 * `compassStartCalibration()` sets magCalProcessActive synchronously inside
 * the MSP handler, so the flag is true on the very next arming-status
 * update - milliseconds. Five seconds is not the expected latency, it is
 * the point past which "the board never started" is the honest reading.
 */
export const MAG_CALIBRATION_START_DEADLINE_MS = 5_000;

/** CALIBRATION_WAIT_US, src/main/sensors/compass.c: the window in which the
 *  operator has to start moving the aircraft. */
export const MAG_CALIBRATION_MOVEMENT_WINDOW_MS = 15_000;

/**
 * The whole magnetometer calibration.
 *
 * CALIBRATION_WAIT_US (15 s) plus CALIBRATION_TIME_US (30 s) is the
 * worst-case 45 s, reached when the operator starts moving at the very end
 * of the wait window. Sixty seconds carries that plus a third again for
 * task and link latency, and is still a bound.
 */
export const MAG_CALIBRATION_ABSOLUTE_DEADLINE_MS = 60_000;

/**
 * The line between "no movement" and "calibrated", read off the firmware's
 * own arithmetic.
 *
 * compass.c ends the process at magCalEndTime. With no movement that is
 * `start + 15 s` and NOTHING IS SAVED. With movement at time t it is
 * `t + 30 s`, so the earliest possible successful end is 30 s. Any value
 * strictly between 15 and 30 separates the two cases; twenty is used
 * because it leaves five seconds of slack on the side where being wrong
 * would report a failure as a success.
 */
export const MAG_NO_MOVEMENT_CUTOFF_MS = 20_000;

/** ARMING_DISABLED_CALIBRATING, runtime_config.h bit 12. Set while
 *  `isCalibrating()` is true for gyro, acc, baro OR mag. */
const CALIBRATING_BIT = 12;
/** ARMING_DISABLED_ACC_CALIBRATION, runtime_config.h bit 23. */
const ACC_CALIBRATION_BIT = 23;

/** Arithmetic, not bitwise: JavaScript's operators are signed 32-bit and
 *  this mask is an unsigned u32. */
function isBitSet(mask: number, index: number): boolean {
  return Math.floor(mask / Math.pow(2, index)) % 2 === 1;
}

/* ================================================================== *
 * PORTS
 * ================================================================== */

export interface SensorsSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): MspClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface SensorsAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

/** The app's existing reboot lifecycle, never a new driver. */
export interface SensorsRebootLifecycle {
  expectReboot(sessionId: string, reason: 'CLI_SAVE'): void;
}

/** Timing seam so a 60-second deadline can be proven without waiting it. */
export interface SensorsClock {
  now(): number;
  sleep(ms: number, signal: {readonly cancelled: boolean}): Promise<void>;
}

const REAL_CLOCK: SensorsClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      const handle = setTimeout(resolve, ms);
      if (signal.cancelled) {
        clearTimeout(handle);
        resolve();
      }
    }),
};

export interface SensorsConfigurationControllerOptions {
  readonly coordinator?: SensorsSessionCoordinator;
  readonly appStateOwner?: SensorsAppStateOwner;
  readonly rebootLifecycle?: SensorsRebootLifecycle;
  readonly clock?: SensorsClock;
}

/* ================================================================== *
 * RESULTS
 * ================================================================== */

export type SensorsBlockReason =
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'UNSUPPORTED_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'OPERATION_IN_PROGRESS'
  /** A required read never landed, so there is nothing safe to edit from. */
  | 'NOT_READY_TO_EDIT'
  /** The draft names a hardware index this build cannot model, and the
   *  board was not already set to it. */
  | 'UNSUPPORTED_VALUE'
  /** The draft touches a field the board's own frame does not carry - a
   *  three-byte MSP_SENSOR_CONFIG has no rangefinder byte to write. */
  | 'UNSUPPORTED_CONTRACT_FIELD'
  /** This firmware build does not answer the command at all. */
  | 'CAPABILITY_ABSENT';

/**
 * A read that a legitimate build may simply not answer.
 *
 * MSP_ACC_TRIM sits inside `#if defined(USE_ACC)`, MSP_COMPASS_CONFIG
 * inside `#ifdef USE_MAG`, and both MSP2 sensor commands post-date API
 * 1.45. A board without them is not a broken board and must not take the
 * whole screen down with it, so the absence is typed and carried.
 */
export type SensorsCapabilityRead<T> =
  | {readonly kind: 'READ'; readonly value: T}
  | {readonly kind: 'NOT_AVAILABLE_ON_THIS_BOARD'};

const ABSENT = Object.freeze({kind: 'NOT_AVAILABLE_ON_THIS_BOARD' as const});

/**
 * Everything a Sensors screen will need, with the three truths kept apart.
 *
 * `configured`, `detected` and `presenceMask` are deliberately three
 * fields rather than one merged view. `truth` is B-2's merge of exactly
 * those three, offered beside them and never instead of them: a save needs
 * the configured values, and only the configured values.
 */
export interface SensorsSnapshot {
  /** MSP_SENSOR_CONFIG - what the board was TOLD to use. */
  readonly configured: SensorConfig;
  /** MSP2_SENSOR_CONFIG_ACTIVE - what it FOUND at boot. */
  readonly detected: SensorsCapabilityRead<SensorConfigActive>;
  /** MSP2_GYRO_SENSOR_ACTIVE - per-slot gyro detection. */
  readonly gyros: SensorsCapabilityRead<GyroSensorActive>;
  /** MSP_SENSOR_ALIGNMENT, all eleven bytes. */
  readonly alignment: SensorAlignment;
  readonly accTrim: SensorsCapabilityRead<AccTrim>;
  readonly compass: SensorsCapabilityRead<CompassConfig>;
  /** MSP_STATUS_EX sensor mask - what the firmware counts as available. */
  readonly presenceMask: number;
  /** Unsigned u32, or undefined when the frame did not carry the tail. */
  readonly armingDisableFlags: number | undefined;
  /** B-2's merge of the three above. Never a health verdict. */
  readonly truth: SensorTruthSet;
}

export type SensorsLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: SensorsSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: SensorsBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * WHAT THE OPERATOR IS ACTUALLY SETTING. Every field is optional, and an
 * absent one means "not mine, leave it alone".
 *
 * THIS SHAPE IS THE POINT, not a convenience. MSP_SET_SENSOR_CONFIG has no
 * per-field write: the frame carries all three, four or five values at
 * once, so every save necessarily restates the fields nobody touched. If
 * those came from the caller's snapshot, a barometer somebody else changed
 * between the screen loading and the operator pressing save would be
 * silently reverted - the save would look perfect and quietly undo another
 * change. Naming only what is being set lets the untouched fields come
 * from the fresh read instead.
 *
 * There is no gyro entry because the command has no gyro byte.
 */
export interface SensorsHardwareDraft {
  readonly acc?: number;
  readonly baro?: number;
  readonly mag?: number;
  /** Only writable when the board's own frame carries the byte. */
  readonly rangefinder?: number;
  readonly opticalflow?: number;
}

/** A COMPLETE set of hardware indices - what a frame actually carries, and
 *  what a mismatch reports. Absent entries mean the frame had no such
 *  byte, never that the value is zero. */
export interface SensorsHardwareState {
  readonly acc: number;
  readonly baro: number;
  readonly mag: number;
  readonly rangefinder?: number;
  readonly opticalflow?: number;
}

/** The families a draft may name, paired with their frame positions. */
const HARDWARE_FIELDS = Object.freeze([
  {key: 'acc', family: 'ACC'},
  {key: 'baro', family: 'BARO'},
  {key: 'mag', family: 'MAG'},
  {key: 'rangefinder', family: 'RANGEFINDER'},
  {key: 'opticalflow', family: 'OPTICALFLOW'},
] as const);

/**
 * ONLY the MSP_SENSOR_ALIGNMENT fields Sensors owns.
 *
 * The gyro alignment bytes, the detected flags and the gyro enable mask are
 * all absent on purpose. Gyro device alignment is not writable over MSP at
 * this revision at all, and the enable mask is somebody else's setting that
 * this save has to carry across without touching.
 */
export interface SensorsMagAlignmentDraft {
  readonly magAlignmentRaw: number;
  /** Decidegrees, signed. Omit to leave the stored angles alone. */
  readonly customDecidegrees?: {
    readonly rollDecidegrees: number;
    readonly pitchDecidegrees: number;
    readonly yawDecidegrees: number;
  };
}

export interface SensorsAccTrimDraft {
  readonly pitch: number;
  readonly roll: number;
}

export interface SensorsCompassDraft {
  readonly magDeclinationDecidegrees: number;
}

/** Where a save has actually got to. An observation seam only: no step can
 *  be skipped, reordered or refused through it. */
export type SensorsSaveProgress =
  /** The frame is on the wire. */
  | 'SENDING'
  /** Reading back, before anything is persisted. */
  | 'VERIFYING_APPLY'
  /** The readback matched; EEPROM write. */
  | 'PERSISTING'
  /** Reading the persisted state one final time. */
  | 'VERIFYING_PERSISTED';

export type SensorsSaveStage =
  | 'SENSOR_CONFIG_WRITE'
  | 'SENSOR_ALIGNMENT_WRITE'
  | 'ACC_TRIM_WRITE'
  | 'COMPASS_WRITE'
  | 'EEPROM';

/** Proof that a hardware save reached the reboot, plus the identity of the
 *  session it must NOT be verified against. */
export interface SensorsPendingHardware {
  readonly sessionId: string;
  readonly writtenOnGeneration: number;
  /** The COMPLETE set the frame carried - the operator's fields plus the
   *  ones taken from the fresh read - so persistence checks all of it. */
  readonly expected: SensorsHardwareState;
  readonly contract: SensorConfigContract;
}

export type SensorsHardwareSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: SensorsSnapshot}
  | {
      readonly kind: 'AWAITING_REBOOT_VERIFICATION';
      readonly pending: SensorsPendingHardware;
    }
  | {
      readonly kind: 'READBACK_MISMATCH';
      readonly expected: SensorsHardwareState;
      readonly observed: SensorsHardwareState;
    }
  | {readonly kind: 'REJECTED'; readonly reason: SensorsBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: SensorsSaveStage}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * What the board FOUND after the reboot, reported beside - never instead
 * of - whether the setting persisted.
 *
 * A configured barometer that the aircraft does not physically have stores
 * perfectly and detects nothing. That is a successful save and a runtime
 * problem, and collapsing the two into one verdict loses whichever half
 * the operator actually needed.
 */
export interface SensorsRuntimeDetection {
  readonly truth: SensorTruthSet;
  /** Families whose three sources disagree. Never a health score. */
  readonly contradictions: readonly SensorTruth[];
}

export type SensorsHardwarePersistenceOutcome =
  | {
      readonly kind: 'SUCCEEDED';
      readonly snapshot: SensorsSnapshot;
      readonly runtime: SensorsRuntimeDetection;
    }
  | {
      readonly kind: 'PERSISTENCE_MISMATCH';
      readonly expected: SensorsHardwareState;
      readonly observed: SensorsHardwareState;
    }
  /** Handed the session the write happened on - that proves nothing. */
  | {readonly kind: 'STALE_SESSION'}
  | {readonly kind: 'REJECTED'; readonly reason: SensorsBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** The non-rebooting saves: alignment, trim and declination. Each ends
 *  with the value the board actually holds, read back after the persist. */
export type SensorsSaveOutcome<TObserved> =
  | {readonly kind: 'NO_CHANGES'; readonly observed: TObserved}
  | {readonly kind: 'SUCCEEDED'; readonly observed: TObserved}
  | {
      readonly kind: 'READBACK_MISMATCH';
      readonly expected: TObserved;
      readonly observed: TObserved;
    }
  /** The write and the readback matched, but the value the board held
   *  after the persist did not. */
  | {
      readonly kind: 'PERSISTENCE_MISMATCH';
      readonly expected: TObserved;
      readonly observed: TObserved;
    }
  | {readonly kind: 'REJECTED'; readonly reason: SensorsBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: SensorsSaveStage}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** The magnetometer fields of an alignment frame - what this save owns. */
export interface SensorsMagAlignmentObserved {
  readonly magAlignmentRaw: number;
  readonly rollDecidegrees: number;
  readonly pitchDecidegrees: number;
  readonly yawDecidegrees: number;
}

/* ---------------------------------------------------------------- *
 * CALIBRATION
 * ---------------------------------------------------------------- */

export type SensorsCalibrationTarget = 'ACCELEROMETER' | 'MAGNETOMETER';

export type SensorsCalibrationProgress =
  /** The command is out; nothing has been observed yet. */
  | 'REQUESTED'
  /**
   * The firmware reports it is calibrating, and the movement window has
   * not yet elapsed - so it may still be waiting to be moved. Magnetometer
   * only; the accelerometer has no such phase.
   */
  | 'WAITING_FOR_MOVEMENT'
  /** The firmware reports it is calibrating. */
  | 'CALIBRATING'
  /** It stopped; reading the final arming state. */
  | 'VERIFYING';

/** Why a completion could not be proven, said plainly rather than dressed
 *  up as either success or failure. */
export type SensorsCalibrationUnconfirmedReason =
  /** The status frames carried no arming-disable tail, so there was
   *  nothing to observe. */
  | 'NO_ARMING_FLAGS_IN_STATUS'
  /**
   * The accelerometer finished faster than the link could see, and the
   * ACC_CALIBRATION blocker was already clear beforehand - so its being
   * clear afterwards proves nothing new. Note that this blocker is set
   * only when an uncalibrated accelerometer is ALSO needed by a
   * configured mode (`accNeedsCalibration()`, fc/core.c), so on an acro
   * setup it is legitimately never set at all.
   */
  | 'NO_OBSERVABLE_TRANSITION';

export interface SensorsCalibrationEvidence {
  /** The CALIBRATING flag was observed true and then false. */
  readonly observedCalibratingEdge: boolean;
  /** The ACC_CALIBRATION blocker was set beforehand and clear afterwards. */
  readonly accBlockerCleared: boolean;
  readonly elapsedMs: number;
}

export type SensorsCalibrationOutcome =
  | {
      readonly kind: 'SUCCEEDED';
      readonly evidence: SensorsCalibrationEvidence;
    }
  /**
   * MAGNETOMETER ONLY, and a genuine firmware outcome rather than a
   * timeout. compass.c ends the process at `start + 15 s` with nothing
   * saved when the aircraft was never moved, against `movement + 30 s`
   * when it was. A stop that early is the no-movement branch, and calling
   * it success would report a calibration that explicitly did not happen.
   */
  | {readonly kind: 'NO_MOVEMENT_DETECTED'; readonly elapsedMs: number}
  /** The CALIBRATING flag never appeared, so the board never began. */
  | {readonly kind: 'START_NOT_OBSERVED'}
  | {
      readonly kind: 'COMPLETION_UNCONFIRMED';
      readonly reason: SensorsCalibrationUnconfirmedReason;
      readonly elapsedMs: number;
    }
  | {readonly kind: 'TIMED_OUT'; readonly elapsedMs: number}
  | {readonly kind: 'LINK_LOST'}
  /**
   * Local observation stopped. The board was never told to stop, because
   * the firmware has no command that would tell it - it may still be
   * calibrating.
   */
  | {
      readonly kind: 'OBSERVATION_CANCELLED';
      readonly boardMayStillBeCalibrating: true;
    }
  /** The board reported ARMED. Nothing was sent. */
  | {readonly kind: 'REFUSED_ARMED'}
  /** The armed state could not be established. Nothing was sent. */
  | {readonly kind: 'ARM_STATE_UNKNOWN'}
  | {readonly kind: 'REJECTED'; readonly reason: SensorsBlockReason}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** Handle returned by a calibration so a caller can stop watching it. */
export interface SensorsCalibrationObservation {
  readonly result: Promise<SensorsCalibrationOutcome>;
  /** Stops local observation only. Never claims the board stopped. */
  cancel(): void;
}

/* ================================================================== *
 * INTERNALS
 * ================================================================== */

class SensorsPreflightError extends Error {
  constructor(readonly reason: SensorsBlockReason) {
    super(`Sensors operation refused: ${reason}`);
    this.name = 'SensorsPreflightError';
  }
}

class SensorsStageUnknownError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, readonly stage: SensorsSaveStage) {
    super(Object.freeze({kind: 'SENSORS_AMBIGUOUS_WRITE', stage, error}));
  }
}

function unknownStage(reason: unknown): SensorsSaveStage | undefined {
  const cause = (reason as {readonly cause?: unknown} | undefined)?.cause as
    | {readonly kind?: string; readonly stage?: SensorsSaveStage}
    | undefined;
  return cause?.kind === 'SENSORS_AMBIGUOUS_WRITE' ? cause.stage : undefined;
}

/** The hardware fields a decoded config actually carried, with absent bytes
 *  left absent so a comparison cannot invent agreement. */
function hardwareOf(config: SensorConfig): SensorsHardwareState {
  return Object.freeze({
    acc: config.acc.raw,
    baro: config.baro.raw,
    mag: config.mag.raw,
    ...(config.rangefinder === NOT_AVAILABLE_IN_THIS_CONTRACT
      ? {}
      : {rangefinder: config.rangefinder.raw}),
    ...(config.opticalflow === NOT_AVAILABLE_IN_THIS_CONTRACT
      ? {}
      : {opticalflow: config.opticalflow.raw}),
  });
}

function hardwareEqual(
  a: SensorsHardwareState,
  b: SensorsHardwareState,
): boolean {
  return (
    a.acc === b.acc &&
    a.baro === b.baro &&
    a.mag === b.mag &&
    a.rangefinder === b.rangefinder &&
    a.opticalflow === b.opticalflow
  );
}

/**
 * The complete set a frame will carry: the operator's named fields, and
 * everything else exactly as the board reports it RIGHT NOW.
 *
 * This is where "the fresh read wins for anything nobody touched" actually
 * happens, and it is the difference between a save that changes one sensor
 * and a save that also reverts whatever moved while the screen was open.
 */
function mergeHardware(
  live: SensorsHardwareState,
  draft: SensorsHardwareDraft,
): SensorsHardwareState {
  const merged: Record<string, number> = {
    acc: draft.acc ?? live.acc,
    baro: draft.baro ?? live.baro,
    mag: draft.mag ?? live.mag,
  };
  if (live.rangefinder !== undefined) {
    merged.rangefinder = draft.rangefinder ?? live.rangefinder;
  }
  if (live.opticalflow !== undefined) {
    merged.opticalflow = draft.opticalflow ?? live.opticalflow;
  }
  return Object.freeze(merged as unknown as SensorsHardwareState);
}

function magAlignmentOf(alignment: SensorAlignment): SensorsMagAlignmentObserved {
  return Object.freeze({
    magAlignmentRaw: alignment.mag.raw,
    rollDecidegrees: alignment.magCustom.rollDecidegrees,
    pitchDecidegrees: alignment.magCustom.pitchDecidegrees,
    yawDecidegrees: alignment.magCustom.yawDecidegrees,
  });
}

function magAlignmentEqual(
  a: SensorsMagAlignmentObserved,
  b: SensorsMagAlignmentObserved,
): boolean {
  return (
    a.magAlignmentRaw === b.magAlignmentRaw &&
    a.rollDecidegrees === b.rollDecidegrees &&
    a.pitchDecidegrees === b.pitchDecidegrees &&
    a.yawDecidegrees === b.yawDecidegrees
  );
}

/**
 * Whether a draft field may be written at all.
 *
 * A value the board is ALREADY set to is always acceptable, even when this
 * build cannot name it: preserving an unknown index is the whole point.
 * Introducing one is refused, because asking a flight controller to use a
 * sensor we cannot describe is asking for something we cannot check.
 */
function unsupportedIntroduction(
  family: SensorHardwareFamily,
  next: number,
  current: number,
): boolean {
  return (
    next !== current && modelSensorHardware(family, next).kind === 'UNKNOWN'
  );
}

/* ================================================================== *
 * THE CONTROLLER
 * ================================================================== */

export class SensorsConfigurationController {
  private readonly coordinator: SensorsSessionCoordinator;
  private readonly appStateOwner: SensorsAppStateOwner;
  private readonly rebootLifecycle: SensorsRebootLifecycle;
  private readonly clock: SensorsClock;
  /** One in-flight exclusive Sensors operation per session, at most. */
  private readonly busy = new Set<string>();
  /** One BOXIDS acquisition per session, reused - never a second poll. */
  private readonly boxIds = new Map<
    string,
    {client: MspClient; acquisition: BoxIdsAcquisition}
  >();

  constructor(options: SensorsConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.rebootLifecycle = options.rebootLifecycle ?? fcRebootRecovery;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  /* ---------------------------------------------------------------- *
   * LOAD
   * ---------------------------------------------------------------- */

  async load(key: SetupUiSessionKey): Promise<SensorsLoadOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<SensorsSnapshot>({
        id: `sensors:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new SensorsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester);
        },
      });
      if (result.status === 'SUCCEEDED') {
        return {kind: 'LOADED', snapshot: result.result};
      }
      if (
        result.status === 'SESSION_ENDED' ||
        result.status === 'OUTCOME_UNKNOWN'
      ) {
        return {kind: 'SESSION_ENDED'};
      }
      return result.error instanceof SensorsPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /* ---------------------------------------------------------------- *
   * HARDWARE SELECTION - the one save that needs a reboot
   * ---------------------------------------------------------------- */

  async saveHardwareSelection(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsHardwareDraft,
    onProgress?: (progress: SensorsSaveProgress) => void,
  ): Promise<SensorsHardwareSaveOutcome> {
    const contract = observed.configured.contract;
    const carriesRangefinder = contract !== 'ACC_BARO_MAG';
    const carriesOpticalflow =
      contract === 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW';

    /**
     * THE FRAME'S WIDTH IS THE BOARD'S, NOT THE API'S. A caller that names
     * a field this board's own reply did not carry is refused rather than
     * quietly served by a wider frame: widening would append bytes the
     * firmware would read into whichever fields it compiled in, and the
     * caller would believe it had configured something it had not.
     */
    if (draft.rangefinder !== undefined && !carriesRangefinder) {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_CONTRACT_FIELD'};
    }
    if (draft.opticalflow !== undefined && !carriesOpticalflow) {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_CONTRACT_FIELD'};
    }

    const current = hardwareOf(observed.configured);
    for (const {key, family} of HARDWARE_FIELDS) {
      const next = draft[key];
      const held = current[key];
      if (
        next !== undefined &&
        held !== undefined &&
        unsupportedIntroduction(family, next, held)
      ) {
        return {kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'};
      }
    }

    if (hardwareEqual(current, mergeHardware(current, draft))) {
      return {kind: 'NO_CHANGES', snapshot: observed};
    }

    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<SensorsHardwareSaveOutcome>({
        id: `sensors:hardware:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new SensorsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);

          // (1) FRESH READ, inside this operation. The snapshot the caller
          //     is holding may be minutes old and a field it does not own
          //     may have moved since.
          const live = decodeSensorConfig(
            (await requester.request(MSP_SENSOR_CONFIG, EMPTY, V1)).payload,
          );
          if (live.contract !== contract) {
            // The board is answering a different shape than the one the
            // caller validated its draft against. Refuse rather than guess.
            return {
              kind: 'REJECTED' as const,
              reason: 'UNSUPPORTED_CONTRACT_FIELD' as const,
            };
          }

          /**
           * (2) THE FRAME IS THE OPERATOR'S FIELDS PLUS THE BOARD'S OWN.
           * Whatever the draft did not name comes from the read that just
           * happened, so a value somebody else changed while the screen was
           * open survives this save instead of being reverted by it.
           */
          const liveHardware = hardwareOf(live);
          const expected = mergeHardware(liveHardware, draft);
          if (hardwareEqual(liveHardware, expected)) {
            // Everything the operator asked for is already true. Nothing is
            // written and no EEPROM cycle is spent.
            return {kind: 'NO_CHANGES' as const, snapshot: observed};
          }

          onProgress?.('SENDING');
          await this.writeOnce(
            requester,
            MSP_SET_SENSOR_CONFIG,
            encodeSensorConfig(live.contract, {
              acc: expected.acc,
              baro: expected.baro,
              mag: expected.mag,
              ...(carriesRangefinder
                ? {rangefinder: expected.rangefinder as number}
                : {}),
              ...(carriesOpticalflow
                ? {opticalflow: expected.opticalflow as number}
                : {}),
            }),
            'SENSOR_CONFIG_WRITE',
          );

          // (3) MANDATORY READBACK, before anything is persisted.
          onProgress?.('VERIFYING_APPLY');
          this.assertLive(key, client, epoch);
          const afterWrite = hardwareOf(
            decodeSensorConfig(
              (await requester.request(MSP_SENSOR_CONFIG, EMPTY, V1)).payload,
            ),
          );
          if (!hardwareEqual(afterWrite, expected)) {
            return {
              kind: 'READBACK_MISMATCH' as const,
              expected,
              observed: afterWrite,
            };
          }

          // (4) Only now.
          onProgress?.('PERSISTING');
          this.assertLive(key, client, epoch);
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');

          /**
           * (5) A SENSOR SELECTION IS READ ONCE, AT BOOT.
           * `sensorsAutodetect()` runs during init and never again, so the
           * value is stored but the board is still running whatever it
           * found last time. The reboot is not decoration - it is the only
           * thing that makes this setting take effect - and it is handed
           * to the app's existing lifecycle rather than driven here.
           */
          this.rebootLifecycle.expectReboot(key.sessionId, 'CLI_SAVE');
          return {
            kind: 'AWAITING_REBOOT_VERIFICATION' as const,
            pending: Object.freeze({
              sessionId: key.sessionId,
              writtenOnGeneration: key.generation,
              expected,
              contract: live.contract,
            }),
          };
        },
      });
      if (result.status === 'SUCCEEDED') return result.result;
      if (result.status === 'OUTCOME_UNKNOWN') {
        const stage = unknownStage(result.reason);
        return stage !== undefined
          ? {kind: 'UNCONFIRMED', stage}
          : {kind: 'SESSION_ENDED'};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof SensorsPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /**
   * The only path to a successful hardware save, and it needs a different
   * session than the one that wrote.
   */
  async verifyHardwarePersistence(
    key: SetupUiSessionKey,
    pending: SensorsPendingHardware,
  ): Promise<SensorsHardwarePersistenceOutcome> {
    /**
     * A generation that still matches the write means the board never went
     * away, so a matching readback would only be reading the RAM the write
     * already changed. Refused by identity rather than by timing.
     */
    if (key.generation === pending.writtenOnGeneration) {
      return {kind: 'STALE_SESSION'};
    }
    const loaded = await this.load(key);
    if (loaded.kind !== 'LOADED') {
      return loaded.kind === 'REJECTED'
        ? {kind: 'REJECTED', reason: loaded.reason}
        : loaded.kind === 'SESSION_ENDED'
          ? {kind: 'SESSION_ENDED'}
          : {kind: 'FAILED', error: loaded.error};
    }
    const observed = hardwareOf(loaded.snapshot.configured);
    if (!hardwareEqual(observed, pending.expected)) {
      return {
        kind: 'PERSISTENCE_MISMATCH',
        expected: pending.expected,
        observed,
      };
    }
    /**
     * PERSISTENCE IS SETTLED; DETECTION IS A SEPARATE ANSWER. The stored
     * values are what the operator asked for - that is the save. What the
     * board found when it restarted with them is a different fact, and it
     * travels beside the success rather than overruling it.
     */
    return {
      kind: 'SUCCEEDED',
      snapshot: loaded.snapshot,
      runtime: Object.freeze({
        truth: loaded.snapshot.truth,
        contradictions: sensorsWithContradictions(loaded.snapshot.truth),
      }),
    };
  }

  /* ---------------------------------------------------------------- *
   * MAGNETOMETER ALIGNMENT
   * ---------------------------------------------------------------- */

  async saveMagAlignment(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsMagAlignmentDraft,
    onProgress?: (progress: SensorsSaveProgress) => void,
  ): Promise<SensorsSaveOutcome<SensorsMagAlignmentObserved>> {
    const snapshotOwned = magAlignmentOf(observed.alignment);
    const wantedFrom = (
      live: SensorsMagAlignmentObserved,
    ): SensorsMagAlignmentObserved =>
      Object.freeze({
        magAlignmentRaw: draft.magAlignmentRaw,
        rollDecidegrees:
          draft.customDecidegrees?.rollDecidegrees ?? live.rollDecidegrees,
        pitchDecidegrees:
          draft.customDecidegrees?.pitchDecidegrees ?? live.pitchDecidegrees,
        yawDecidegrees:
          draft.customDecidegrees?.yawDecidegrees ?? live.yawDecidegrees,
      });
    // A cheap refusal before any operation is opened. The authoritative
    // no-change check happens again inside, against the fresh read.
    if (magAlignmentEqual(snapshotOwned, wantedFrom(snapshotOwned))) {
      return {kind: 'NO_CHANGES', observed: snapshotOwned};
    }

    return this.runVerifiedWrite<SensorsMagAlignmentObserved>({
      key,
      operation: 'alignment',
      stage: 'SENSOR_ALIGNMENT_WRITE',
      onProgress,
      run: async (requester, live) => {
        /**
         * THE FRESH READ IS NOT AN OPTIMISATION.
         *
         * Byte 4 of this frame is the gyro enable mask, which Sensors does
         * not own and must carry across untouched; taking it from a stale
         * snapshot would write back whatever it was when the screen last
         * loaded. The custom angles the draft did not name come from the
         * same fresh read, for the same reason.
         *
         * And byte 3 - the DETECTED gyro flags - is deliberately not read
         * here at all: the write's byte 3 is the ENABLED mask, and the two
         * are one offset apart in the read.
         */
        const liveOwned = magAlignmentOf(live.alignment);
        const wanted = wantedFrom(liveOwned);
        if (magAlignmentEqual(liveOwned, wanted)) {
          return {kind: 'NO_CHANGES', observed: liveOwned};
        }
        await this.writeOnce(
          requester,
          MSP_SET_SENSOR_ALIGNMENT,
          encodeSensorAlignment({
            magAlignmentRaw: wanted.magAlignmentRaw,
            gyroEnabledBitmaskRaw: live.alignment.gyroEnabledBitmaskRaw,
            magCustomDecidegrees: {
              rollDecidegrees: wanted.rollDecidegrees,
              pitchDecidegrees: wanted.pitchDecidegrees,
              yawDecidegrees: wanted.yawDecidegrees,
            },
          }),
          'SENSOR_ALIGNMENT_WRITE',
        );
        return {kind: 'WROTE', expected: wanted};
      },
      readOwned: async requester =>
        magAlignmentOf(
          decodeSensorAlignment(
            (await requester.request(MSP_SENSOR_ALIGNMENT, EMPTY, V1)).payload,
          ),
        ),
      equal: magAlignmentEqual,
    });
  }

  /* ---------------------------------------------------------------- *
   * ACCELEROMETER TRIM
   * ---------------------------------------------------------------- */

  async saveAccTrim(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsAccTrimDraft,
    onProgress?: (progress: SensorsSaveProgress) => void,
  ): Promise<SensorsSaveOutcome<SensorsAccTrimDraft>> {
    if (observed.accTrim.kind !== 'READ') {
      return {kind: 'REJECTED', reason: 'CAPABILITY_ABSENT'};
    }
    const current: SensorsAccTrimDraft = Object.freeze({
      pitch: observed.accTrim.value.pitch,
      roll: observed.accTrim.value.roll,
    });
    if (current.pitch === draft.pitch && current.roll === draft.roll) {
      return {kind: 'NO_CHANGES', observed: current};
    }
    // The range lives only in the CLI settings table; the MSP handler
    // stores whatever arrives. Refusing here is refused BEFORE the wire.
    try {
      encodeAccTrim(draft);
    } catch {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'};
    }

    return this.runVerifiedWrite<SensorsAccTrimDraft>({
      key,
      operation: 'acc-trim',
      stage: 'ACC_TRIM_WRITE',
      onProgress,
      run: async requester => {
        await this.writeOnce(
          requester,
          MSP_SET_ACC_TRIM,
          encodeAccTrim(draft),
          'ACC_TRIM_WRITE',
        );
        return {
          kind: 'WROTE',
          expected: Object.freeze({pitch: draft.pitch, roll: draft.roll}),
        };
      },
      readOwned: async requester => {
        const trim = decodeAccTrim(
          (await requester.request(MSP_ACC_TRIM, EMPTY, V1)).payload,
        );
        return Object.freeze({pitch: trim.pitch, roll: trim.roll});
      },
      equal: (a, b) => a.pitch === b.pitch && a.roll === b.roll,
    });
  }

  /* ---------------------------------------------------------------- *
   * MAGNETIC DECLINATION
   * ---------------------------------------------------------------- */

  async saveCompassDeclination(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsCompassDraft,
    onProgress?: (progress: SensorsSaveProgress) => void,
  ): Promise<SensorsSaveOutcome<SensorsCompassDraft>> {
    if (observed.compass.kind !== 'READ') {
      return {kind: 'REJECTED', reason: 'CAPABILITY_ABSENT'};
    }
    const current: SensorsCompassDraft = Object.freeze({
      magDeclinationDecidegrees:
        observed.compass.value.magDeclinationDecidegrees,
    });
    if (
      current.magDeclinationDecidegrees === draft.magDeclinationDecidegrees
    ) {
      return {kind: 'NO_CHANGES', observed: current};
    }
    try {
      encodeCompassConfig(draft);
    } catch {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'};
    }

    return this.runVerifiedWrite<SensorsCompassDraft>({
      key,
      operation: 'compass',
      stage: 'COMPASS_WRITE',
      onProgress,
      run: async requester => {
        await this.writeOnce(
          requester,
          MSP_SET_COMPASS_CONFIG,
          encodeCompassConfig(draft),
          'COMPASS_WRITE',
        );
        return {
          kind: 'WROTE',
          expected: Object.freeze({
            magDeclinationDecidegrees: draft.magDeclinationDecidegrees,
          }),
        };
      },
      readOwned: async requester =>
        Object.freeze({
          magDeclinationDecidegrees: decodeCompassConfig(
            (await requester.request(MSP_COMPASS_CONFIG, EMPTY, V1)).payload,
          ).magDeclinationDecidegrees,
        }),
      equal: (a, b) =>
        a.magDeclinationDecidegrees === b.magDeclinationDecidegrees,
    });
  }

  /* ---------------------------------------------------------------- *
   * CALIBRATION
   * ---------------------------------------------------------------- */

  calibrateAccelerometer(
    key: SetupUiSessionKey,
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): SensorsCalibrationObservation {
    return this.runCalibration('ACCELEROMETER', key, onProgress);
  }

  calibrateMagnetometer(
    key: SetupUiSessionKey,
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): SensorsCalibrationObservation {
    return this.runCalibration('MAGNETOMETER', key, onProgress);
  }

  private runCalibration(
    target: SensorsCalibrationTarget,
    key: SetupUiSessionKey,
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): SensorsCalibrationObservation {
    const signal = {cancelled: false};
    const result = this.observeCalibration(target, key, signal, onProgress);
    return {
      result,
      cancel: () => {
        signal.cancelled = true;
      },
    };
  }

  private async observeCalibration(
    target: SensorsCalibrationTarget,
    key: SetupUiSessionKey,
    signal: {cancelled: boolean},
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): Promise<SensorsCalibrationOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    const startedAt = this.clock.now();
    try {
      const outcome = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<SensorsCalibrationOutcome>({
        id: `sensors:calibrate:${target}:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new SensorsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);

          /**
           * DISARMED, PROVED. Both firmware handlers are
           * `if (!ARMING_FLAG(ARMED)) { start... }` and acknowledge either
           * way, so an armed board answers cheerfully and calibrates
           * nothing. The armed state comes from the BOXIDS mapping and a
           * fresh status frame - never from the arming-disable mask, whose
           * bits do not mean "armed" - and an unresolvable state refuses
           * rather than assumes.
           */
          const identity: BoxIdsOwnerIdentity = {
            physicalGeneration: key.generation,
            mspEpoch: epoch,
          };
          const stillOwned = (): boolean => {
            try {
              this.assertLive(key, client, epoch);
              return true;
            } catch {
              return false;
            }
          };
          const mapping = await this.boxIdsFor(key.sessionId, client).acquire(
            identity,
            stillOwned,
          );
          this.assertLive(key, client, epoch);
          const baseline = decodeStatusExDiagnostics(
            (await requester.request(MSP_STATUS_EX, EMPTY, V1)).payload,
          );
          const armed: ArmedState =
            mapping.kind === 'READY'
              ? deriveArmedState(
                  baseline.flightModeFlagsLow32,
                  baseline.readiness.extraFlightModeFlagBytes,
                  mapping.permanentIds,
                )
              : 'UNKNOWN';
          if (armed === 'ARMED') {
            return {kind: 'REFUSED_ARMED' as const};
          }
          if (armed !== 'DISARMED' || baseline.readiness.malformedTail === true) {
            return {kind: 'ARM_STATE_UNKNOWN' as const};
          }

          const baselineFlags = baseline.readiness.armingDisableFlags;
          const accBlockerWasSet =
            baselineFlags !== undefined &&
            isBitSet(baselineFlags, ACC_CALIBRATION_BIT);

          // The command. Its acknowledgement is not a result.
          onProgress?.('REQUESTED');
          this.assertLive(key, client, epoch);
          await requester.request(
            target === 'ACCELEROMETER'
              ? MSP_ACC_CALIBRATION
              : MSP_MAG_CALIBRATION,
            EMPTY,
            V1,
          );

          return this.watchCalibration(target, key, client, epoch, requester, {
            signal,
            startedAt,
            accBlockerWasSet,
            onProgress,
          });
        },
      });
      if (outcome.status === 'SUCCEEDED') return outcome.result;
      /**
       * WHO STOPPED THIS - us, or the link? Cancellation is the one fact
       * held LOCALLY and with certainty, so it decides, and the link is
       * what is left. The precedence is deliberate: "we stopped watching,
       * the board may still be calibrating" stays true whatever the link
       * did, while "the connection was lost" would assert something about
       * hardware we did not observe.
       */
      if (
        outcome.status === 'SESSION_ENDED' ||
        outcome.status === 'OUTCOME_UNKNOWN'
      ) {
        return signal.cancelled
          ? {kind: 'OBSERVATION_CANCELLED', boardMayStillBeCalibrating: true}
          : {kind: 'LINK_LOST'};
      }
      return outcome.error instanceof SensorsPreflightError
        ? {kind: 'REJECTED', reason: outcome.error.reason}
        : {kind: 'FAILED', error: outcome.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /**
   * The bounded watch. Every exit is terminal and every wait has a
   * deadline; there is no path that spins forever.
   */
  private async watchCalibration(
    target: SensorsCalibrationTarget,
    key: SetupUiSessionKey,
    client: MspClient,
    epoch: number,
    requester: MspRequester,
    watch: {
      readonly signal: {readonly cancelled: boolean};
      readonly startedAt: number;
      readonly accBlockerWasSet: boolean;
      readonly onProgress?: (progress: SensorsCalibrationProgress) => void;
    },
  ): Promise<SensorsCalibrationOutcome> {
    const isMag = target === 'MAGNETOMETER';
    const interval = isMag
      ? MAG_CALIBRATION_POLL_INTERVAL_MS
      : ACC_CALIBRATION_POLL_INTERVAL_MS;
    const absoluteDeadline =
      watch.startedAt +
      (isMag
        ? MAG_CALIBRATION_ABSOLUTE_DEADLINE_MS
        : ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS);
    const startDeadline = isMag
      ? watch.startedAt + MAG_CALIBRATION_START_DEADLINE_MS
      : absoluteDeadline;

    let sawCalibrating = false;
    let sawAnyFlags = false;
    let stillCalibrating = false;
    let announcedCalibrating = false;

    for (;;) {
      if (watch.signal.cancelled) {
        return {
          kind: 'OBSERVATION_CANCELLED',
          boardMayStillBeCalibrating: true,
        };
      }
      const elapsed = () => this.clock.now() - watch.startedAt;
      if (this.clock.now() >= absoluteDeadline) {
        /**
         * THE DEADLINE HAS THREE DIFFERENT MEANINGS, and collapsing them
         * would report a calibration that probably worked as a failure.
         *
         *  - The board was STILL calibrating when we gave up. That is a
         *    genuine timeout: something is stuck or slower than any honest
         *    run.
         *  - The status frames never carried the arming-disable tail, so
         *    there was nothing to observe at all.
         *  - The flags were readable, the board never showed CALIBRATING,
         *    and it never claimed to need calibrating either. For the
         *    accelerometer this is the ordinary case rather than a fault:
         *    the 400-cycle countdown can finish between two polls, and the
         *    ACC blocker is only ever set when a configured mode needs the
         *    accelerometer, so on an acro setup there is legitimately
         *    nothing to see. Saying so is the honest answer; claiming
         *    success would be inventing evidence, and claiming a timeout
         *    would be inventing a fault.
         */
        if (stillCalibrating) {
          return {kind: 'TIMED_OUT', elapsedMs: elapsed()};
        }
        return {
          kind: 'COMPLETION_UNCONFIRMED',
          reason: sawAnyFlags
            ? 'NO_OBSERVABLE_TRANSITION'
            : 'NO_ARMING_FLAGS_IN_STATUS',
          elapsedMs: elapsed(),
        };
      }
      /**
       * THE START DEADLINE IS ITS OWN ANSWER, and only the magnetometer
       * has one. compassStartCalibration() sets its flag synchronously
       * inside the MSP handler, so a flag that has not appeared after
       * seconds means the board never began - a different fact from a
       * calibration that ran and could not be confirmed. The
       * accelerometer's 400-cycle countdown can legitimately finish
       * between two polls, so demanding to see it start there would
       * manufacture failures.
       */
      if (isMag && !sawCalibrating && this.clock.now() >= startDeadline) {
        return {kind: 'START_NOT_OBSERVED'};
      }

      await this.clock.sleep(interval, watch.signal);
      if (watch.signal.cancelled) {
        return {
          kind: 'OBSERVATION_CANCELLED',
          boardMayStillBeCalibrating: true,
        };
      }
      try {
        this.assertLive(key, client, epoch);
      } catch (error) {
        /**
         * APP_BACKGROUNDED is the app losing the ability to watch while
         * the cable, the port and the board may all be fine. Reporting
         * that as a lost connection would state something about the
         * hardware that was never observed.
         */
        return error instanceof SensorsPreflightError &&
          error.reason === 'APP_BACKGROUNDED'
          ? {kind: 'OBSERVATION_CANCELLED', boardMayStillBeCalibrating: true}
          : {kind: 'LINK_LOST'};
      }

      let flags: number | undefined;
      try {
        const status = decodeStatusExDiagnostics(
          (await requester.request(MSP_STATUS_EX, EMPTY, V1)).payload,
        );
        flags =
          status.readiness.malformedTail === true
            ? undefined
            : status.readiness.armingDisableFlags;
      } catch {
        /**
         * A board can stop answering MSP for a moment while it calibrates.
         * One missed status is not a verdict - the absolute deadline above
         * is what makes this bounded - so keep watching.
         */
        continue;
      }
      if (flags === undefined) {
        continue;
      }
      sawAnyFlags = true;
      const calibrating = isBitSet(flags, CALIBRATING_BIT);
      stillCalibrating = calibrating;

      if (calibrating) {
        sawCalibrating = true;
        if (isMag) {
          /**
           * WHICH PHASE, AND HOW THAT IS KNOWN. compass.c ends the process
           * at `start + CALIBRATION_WAIT_US` when the aircraft was never
           * moved, and re-arms the end to `movement + CALIBRATION_TIME_US`
           * when it was. So a process still running once the movement
           * window has elapsed PROVES movement was detected. Before that
           * point, it may still be waiting - and the honest label says so
           * rather than claiming a phase nothing observed.
           */
          const pastWindow =
            elapsed() >= MAG_CALIBRATION_MOVEMENT_WINDOW_MS;
          const next: SensorsCalibrationProgress = pastWindow
            ? 'CALIBRATING'
            : 'WAITING_FOR_MOVEMENT';
          if (!announcedCalibrating || pastWindow) {
            watch.onProgress?.(next);
            announcedCalibrating = true;
          }
        } else if (!announcedCalibrating) {
          watch.onProgress?.('CALIBRATING');
          announcedCalibrating = true;
        }
        continue;
      }

      // Not calibrating. Either it finished, or it never started.
      if (!sawCalibrating) {
        // Nothing observed yet; keep waiting for the start or the deadline.
        continue;
      }

      watch.onProgress?.('VERIFYING');
      const settledAt = elapsed();

      if (isMag) {
        /**
         * A MAGNETOMETER RUN THAT STOPS EARLY DID NOT CALIBRATE. The
         * firmware's own arithmetic makes this decidable: with no
         * movement it stops at 15 s having saved nothing; with movement
         * the earliest possible stop is 30 s. Reporting the first as
         * success would tell an operator their compass was calibrated
         * when the firmware explicitly beeped a failure.
         */
        if (settledAt < MAG_NO_MOVEMENT_CUTOFF_MS) {
          return {kind: 'NO_MOVEMENT_DETECTED', elapsedMs: settledAt};
        }
        return {
          kind: 'SUCCEEDED',
          evidence: Object.freeze({
            observedCalibratingEdge: true,
            accBlockerCleared: false,
            elapsedMs: settledAt,
          }),
        };
      }

      const accBlockerNowClear = !isBitSet(flags, ACC_CALIBRATION_BIT);
      return {
        kind: 'SUCCEEDED',
        evidence: Object.freeze({
          observedCalibratingEdge: true,
          accBlockerCleared: watch.accBlockerWasSet && accBlockerNowClear,
          elapsedMs: settledAt,
        }),
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * SHARED
   * ---------------------------------------------------------------- */

  /**
   * The sequence every non-rebooting save follows, once.
   *
   *   fresh read -> write -> readback -> EEPROM -> final read
   *
   * The fresh read is inside the operation, so nothing a caller is holding
   * can leak into the frame; the readback is what separates "the frame was
   * accepted" from "the value changed"; and the final read is what
   * separates "the persist was acknowledged" from "the board holds it".
   */
  private async runVerifiedWrite<TOwned>(spec: {
    readonly key: SetupUiSessionKey;
    readonly operation: string;
    readonly stage: SensorsSaveStage;
    readonly onProgress?: (progress: SensorsSaveProgress) => void;
    readonly run: (
      requester: MspRequester,
      live: SensorsSnapshot,
    ) => Promise<
      | {readonly kind: 'WROTE'; readonly expected: TOwned}
      | {readonly kind: 'NO_CHANGES'; readonly observed: TOwned}
    >;
    readonly readOwned: (requester: MspRequester) => Promise<TOwned>;
    readonly equal: (a: TOwned, b: TOwned) => boolean;
  }): Promise<SensorsSaveOutcome<TOwned>> {
    const {key} = spec;
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<SensorsSaveOutcome<TOwned>>({
        id: `sensors:${spec.operation}:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new SensorsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const live = await this.readSnapshot(requester);

          spec.onProgress?.('SENDING');
          this.assertLive(key, client, epoch);
          const written = await spec.run(requester, live);
          if (written.kind === 'NO_CHANGES') {
            // The fresh read says it is already so. Nothing was written,
            // and no EEPROM cycle is spent.
            return {kind: 'NO_CHANGES' as const, observed: written.observed};
          }
          const expected = written.expected;

          spec.onProgress?.('VERIFYING_APPLY');
          this.assertLive(key, client, epoch);
          const afterWrite = await spec.readOwned(requester);
          if (!spec.equal(afterWrite, expected)) {
            return {
              kind: 'READBACK_MISMATCH' as const,
              expected,
              observed: afterWrite,
            };
          }

          spec.onProgress?.('PERSISTING');
          this.assertLive(key, client, epoch);
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');

          spec.onProgress?.('VERIFYING_PERSISTED');
          this.assertLive(key, client, epoch);
          const afterPersist = await spec.readOwned(requester);
          if (!spec.equal(afterPersist, expected)) {
            return {
              kind: 'PERSISTENCE_MISMATCH' as const,
              expected,
              observed: afterPersist,
            };
          }
          return {kind: 'SUCCEEDED' as const, observed: afterPersist};
        },
      });
      if (result.status === 'SUCCEEDED') return result.result;
      if (result.status === 'OUTCOME_UNKNOWN') {
        const stage = unknownStage(result.reason);
        return stage !== undefined
          ? {kind: 'UNCONFIRMED', stage}
          : {kind: 'SESSION_ENDED'};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof SensorsPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /**
   * The seven reads, in one place.
   *
   * Board alignment is NOT among them. MSP_BOARD_ALIGNMENT_CONFIG describes
   * how the whole flight controller is mounted, it belongs to Setup, and
   * reading it here would be the first step towards owning it.
   */
  private async readSnapshot(
    requester: MspRequester,
  ): Promise<SensorsSnapshot> {
    const configured = decodeSensorConfig(
      (await requester.request(MSP_SENSOR_CONFIG, EMPTY, V1)).payload,
    );
    const detected = await this.optional(async () =>
      decodeSensorConfigActive(
        (await requester.request(MSP2_SENSOR_CONFIG_ACTIVE, EMPTY, V2)).payload,
      ),
    );
    const gyros = await this.optional(async () =>
      decodeGyroSensorActive(
        (await requester.request(MSP2_GYRO_SENSOR_ACTIVE, EMPTY, V2)).payload,
      ),
    );
    const alignment = decodeSensorAlignment(
      (await requester.request(MSP_SENSOR_ALIGNMENT, EMPTY, V1)).payload,
    );
    const accTrim = await this.optional(async () =>
      decodeAccTrim((await requester.request(MSP_ACC_TRIM, EMPTY, V1)).payload),
    );
    const compass = await this.optional(async () =>
      decodeCompassConfig(
        (await requester.request(MSP_COMPASS_CONFIG, EMPTY, V1)).payload,
      ),
    );
    const status = decodeStatusExDiagnostics(
      (await requester.request(MSP_STATUS_EX, EMPTY, V1)).payload,
    );

    return Object.freeze({
      configured,
      detected,
      gyros,
      alignment,
      accTrim,
      compass,
      presenceMask: status.sensorPresenceMask,
      armingDisableFlags:
        status.readiness.malformedTail === true
          ? undefined
          : status.readiness.armingDisableFlags,
      truth: deriveSensorTruthSet({
        configured,
        detected: detected.kind === 'READ' ? detected.value : undefined,
        presenceMask: status.sensorPresenceMask,
      }),
    });
  }

  /**
   * A read a legitimate build may not answer.
   *
   * MSP_ACC_TRIM and MSP_COMPASS_CONFIG are compiled out on builds without
   * an accelerometer or magnetometer, and the two MSP2 sensor commands
   * post-date API 1.45. Losing the whole screen because a board does not
   * carry a magnetometer would be reporting a capability as a fault.
   */
  private async optional<T>(
    read: () => Promise<T>,
  ): Promise<SensorsCapabilityRead<T>> {
    try {
      return {kind: 'READ', value: await read()};
    } catch {
      return ABSENT;
    }
  }

  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    stage: SensorsSaveStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, V1);
    } catch (error) {
      // A write whose outcome cannot be known must not be reported as a
      // clean failure - the board may have applied it.
      throw new SensorsStageUnknownError(error, stage);
    }
  }

  private boxIdsFor(sessionId: string, client: MspClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing !== undefined && existing.client === client) {
      return existing.acquisition;
    }
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, {client, acquisition});
    return acquisition;
  }

  private capture(
    key: SetupUiSessionKey,
  ):
    | {client: MspClient; scheduler: MspTelemetryScheduler; epoch: number}
    | {reason: SensorsBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      return {reason: 'APP_BACKGROUNDED'};
    }
    const identification = this.coordinator.getIdentificationState(
      key.sessionId,
    );
    if (
      identification.status === 'IDLE' ||
      identification.status === 'RUNNING'
    ) {
      return {reason: 'IDENTIFYING'};
    }
    if (!isSupportedConfigurationApi(identification)) {
      return {reason: 'UNSUPPORTED_FIRMWARE'};
    }
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      client === undefined ||
      scheduler === undefined
    ) {
      return {reason: 'DISCONNECTED'};
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      return {reason: 'LINK_RECOVERING'};
    }
    return {client, scheduler, epoch: client.getEpoch()};
  }

  private assertLive(
    key: SetupUiSessionKey,
    client: MspClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      throw new SensorsPreflightError('APP_BACKGROUNDED');
    }
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new SensorsPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      throw new SensorsPreflightError('LINK_RECOVERING');
    }
  }

  private operations(
    sessionId: string,
    client: MspClient,
    scheduler: MspTelemetryScheduler,
  ) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      {captureCurrent: () => this.coordinator.getSessionKey(sessionId)},
      {
        getContext: () => ({
          clientState:
            this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          // Cached only; the authoritative armed check happens inside
          // execute() against a fresh reading.
          isArmed: false,
        }),
      },
    );
  }
}

export const sensorsConfigurationController =
  new SensorsConfigurationController();
