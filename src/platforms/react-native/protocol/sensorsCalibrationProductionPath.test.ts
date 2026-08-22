/**
 * THE CALIBRATION LIFECYCLES, DRIVEN THROUGH THE REAL STACK.
 *
 * A virtual flight controller answers real MSP frames over the real
 * MspSessionCoordinator; the controller under test is the production one.
 *
 * THE FACTS THIS SUITE EXISTS TO HOLD DOWN:
 *
 *   AN ACK IS NOT A CALIBRATION. Both firmware handlers are
 *   `if (!ARMING_FLAG(ARMED)) { start... }` and acknowledge either way, so
 *   an armed board answers cheerfully and calibrates nothing.
 *
 *   COMPLETION IS OBSERVED, NEVER TIMED. The evidence is the
 *   ARMING_DISABLED_CALIBRATING bit and, for the accelerometer, the
 *   ARMING_DISABLED_ACC_CALIBRATION bit. A run that cannot be proven ends
 *   as unconfirmed rather than as a success.
 *
 *   A MAGNETOMETER RUN THAT STOPS EARLY DID NOT CALIBRATE. compass.c ends
 *   at `start + 15 s` having saved nothing when the aircraft was never
 *   moved, against `movement + 30 s` when it was.
 *
 * Every wait is driven by an injected clock, so a sixty-second deadline
 * costs no seconds.
 */

import {
  SensorsConfigurationController,
  ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS,
  ACC_CALIBRATION_POLL_INTERVAL_MS,
  MAG_CALIBRATION_ABSOLUTE_DEADLINE_MS,
  MAG_CALIBRATION_MOVEMENT_WINDOW_MS,
  MAG_CALIBRATION_POLL_INTERVAL_MS,
  MAG_CALIBRATION_START_DEADLINE_MS,
  MAG_NO_MOVEMENT_CUTOFF_MS,
  type SensorsCalibrationProgress,
  type SensorsClock,
} from './SensorsConfigurationController';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import {
  VirtualSensorsFc,
  ACC_CALIBRATION_BIT,
  CALIBRATING_BIT,
  MSP_ACC_CALIBRATION,
  MSP_MAG_CALIBRATION,
  type SensorsFcBehaviour,
} from './__testUtils__/virtualSensorsFc';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const bit = (index: number): number => Math.pow(2, index);
const CALIBRATING = bit(CALIBRATING_BIT);
const ACC_NEEDS_CALIBRATION = bit(ACC_CALIBRATION_BIT);
/** With a BOXIDS reply of [0,1,2], index 0 is BOXARM. */
const ARMED_FLIGHT_MODE_BITS = 1;

/** A clock the tests drive, so a sixty-second deadline costs milliseconds. */
class FakeClock implements SensorsClock {
  private current = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.current;
  }
  async sleep(ms: number, signal: {readonly cancelled: boolean}): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    if (signal.cancelled) return;
    // Advance the VIRTUAL clock by the whole interval but yield for a real
    // macrotask, so a long deadline is cheap while a test can still cancel
    // or drop the link part-way through.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

let sessionSeq = 0;

async function connect(behaviour: SensorsFcBehaviour = {}) {
  sessionSeq += 1;
  const sessionId = `sensors-cal-${sessionSeq}`;
  const fc = new VirtualSensorsFc(sessionId, behaviour);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(fc.client, sessionId);
  await sleep(400);
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) throw new Error('no session key after identification');
  return {fc, coordinator, sessionId, key};
}

function controllerFor(
  coordinator: MspSessionCoordinator,
  clock: SensorsClock,
  appState?: {getPhase: () => 'ACTIVE' | 'APP_BACKGROUND'},
) {
  return new SensorsConfigurationController({
    coordinator,
    appStateOwner: appState ?? {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {expectReboot: () => undefined},
    clock,
  });
}

/** How many status polls fit before a deadline, so a script can be built
 *  without hard-coding a count that a constant change would invalidate. */
const pollsBefore = (deadlineMs: number, intervalMs: number): number =>
  Math.ceil(deadlineMs / intervalMs);

/* ================================================================== *
 * PRECONDITIONS
 * ================================================================== */

describe('before any calibration command is sent', () => {
  it('refuses outright when the board reports ARMED', async () => {
    const {fc, coordinator, key} = await connect({
      flightModeFlagsLow32: ARMED_FLIGHT_MODE_BITS,
    });
    const controller = controllerFor(coordinator, new FakeClock());
    const outcome = await controller.calibrateAccelerometer(key).result;
    expect(outcome).toEqual({kind: 'REFUSED_ARMED'});
    // The firmware would have acknowledged this and done nothing.
    expect(fc.requested).not.toContain(MSP_ACC_CALIBRATION);
  });

  it('refuses when the armed state cannot be established', async () => {
    // Without a BOXIDS mapping the ARM bit's position is unknown, and the
    // arming-disable mask does not mean "armed".
    const {fc, coordinator, key} = await connect({noBoxIds: true});
    const controller = controllerFor(coordinator, new FakeClock());
    const outcome = await controller.calibrateMagnetometer(key).result;
    expect(outcome).toEqual({kind: 'ARM_STATE_UNKNOWN'});
    expect(fc.requested).not.toContain(MSP_MAG_CALIBRATION);
  });
});

/* ================================================================== *
 * ACCELEROMETER
 * ================================================================== */

describe('accelerometer calibration', () => {
  it('succeeds when the CALIBRATING flag rises and falls', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    // Baseline read, then calibrating, then clear.
    fc.scriptedArmingFlags.push(0, CALIBRATING, CALIBRATING, 0);
    const clock = new FakeClock();
    const seen: SensorsCalibrationProgress[] = [];
    const outcome = await controllerFor(coordinator, clock).calibrateAccelerometer(
      key,
      progress => seen.push(progress),
    ).result;
    expect(outcome.kind).toBe('SUCCEEDED');
    if (outcome.kind === 'SUCCEEDED') {
      expect(outcome.evidence.observedCalibratingEdge).toBe(true);
    }
    expect(seen).toEqual(['REQUESTED', 'CALIBRATING', 'VERIFYING']);
    expect(fc.requested).toContain(MSP_ACC_CALIBRATION);
  });

  it('records the ACC blocker clearing as its own piece of evidence', async () => {
    /**
     * ARMING_DISABLED_ACC_CALIBRATION is set by accNeedsCalibration() when
     * an uncalibrated accelerometer is ALSO needed by a configured mode
     * (angle, horizon, althold, poshold, GPS rescue, camstab, calib or
     * acro trainer). Going from set to clear is the strongest evidence
     * available that a calibration actually took.
     */
    const {fc, coordinator, key} = await connect({
      armingDisableFlags: ACC_NEEDS_CALIBRATION,
    });
    fc.scriptedArmingFlags.push(
      ACC_NEEDS_CALIBRATION, // baseline: it needs calibrating
      ACC_NEEDS_CALIBRATION + CALIBRATING, // running
      ACC_NEEDS_CALIBRATION + CALIBRATING,
      0, // done, and it no longer needs calibrating
    );
    const outcome = await controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateAccelerometer(key).result;
    expect(outcome.kind).toBe('SUCCEEDED');
    if (outcome.kind === 'SUCCEEDED') {
      expect(outcome.evidence).toMatchObject({
        observedCalibratingEdge: true,
        accBlockerCleared: true,
      });
    }
  });

  it('does not claim the blocker cleared when it was never set to begin with', async () => {
    // On an acro setup the blocker is legitimately never set, so its being
    // clear afterwards proves nothing new and must not be reported as if
    // it did.
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(0, CALIBRATING, CALIBRATING, 0);
    const outcome = await controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateAccelerometer(key).result;
    expect(outcome.kind).toBe('SUCCEEDED');
    if (outcome.kind === 'SUCCEEDED') {
      expect(outcome.evidence.accBlockerCleared).toBe(false);
      expect(outcome.evidence.observedCalibratingEdge).toBe(true);
    }
  });

  it('ends as unconfirmed when nothing observable ever happened', async () => {
    /**
     * The 400-cycle countdown can finish between two polls, and on an acro
     * setup the ACC blocker is legitimately never set at all - so there can
     * genuinely be nothing to see. That is reported as unconfirmed rather
     * than as either a success or a failure.
     */
    const {coordinator, key} = await connect({armingDisableFlags: 0});
    const clock = new FakeClock();
    const outcome = await controllerFor(coordinator, clock).calibrateAccelerometer(
      key,
    ).result;
    expect(outcome.kind).toBe('COMPLETION_UNCONFIRMED');
    if (outcome.kind === 'COMPLETION_UNCONFIRMED') {
      expect(outcome.reason).toBe('NO_OBSERVABLE_TRANSITION');
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
        ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS,
      );
    }
  });

  it('times out rather than waiting forever when the board never stops', async () => {
    const {coordinator, key} = await connect({
      armingDisableFlags: CALIBRATING,
    });
    const clock = new FakeClock();
    const outcome = await controllerFor(coordinator, clock).calibrateAccelerometer(
      key,
    ).result;
    expect(outcome.kind).toBe('TIMED_OUT');
    if (outcome.kind === 'TIMED_OUT') {
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
        ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS,
      );
    }
    // Bounded, and bounded by the deadline rather than by a poll count.
    expect(clock.sleeps.length).toBeLessThanOrEqual(
      pollsBefore(ACC_CALIBRATION_ABSOLUTE_DEADLINE_MS, ACC_CALIBRATION_POLL_INTERVAL_MS) + 2,
    );
  });
});

/* ================================================================== *
 * MAGNETOMETER
 * ================================================================== */

describe('magnetometer calibration', () => {
  /** A script that stays CALIBRATING for `ms`, then clears. */
  function calibratingFor(ms: number): number[] {
    const polls = Math.ceil(ms / MAG_CALIBRATION_POLL_INTERVAL_MS);
    return [0, ...new Array(polls).fill(CALIBRATING), 0];
  }

  it('succeeds only after the flag has risen and then fallen', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    // Run past the movement window and past the no-movement cutoff, then stop.
    fc.scriptedArmingFlags.push(...calibratingFor(MAG_NO_MOVEMENT_CUTOFF_MS + 5_000));
    const clock = new FakeClock();
    const seen: SensorsCalibrationProgress[] = [];
    const outcome = await controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
      progress => seen.push(progress),
    ).result;
    expect(outcome.kind).toBe('SUCCEEDED');
    if (outcome.kind === 'SUCCEEDED') {
      expect(outcome.evidence.observedCalibratingEdge).toBe(true);
      expect(outcome.evidence.elapsedMs).toBeGreaterThanOrEqual(
        MAG_NO_MOVEMENT_CUTOFF_MS,
      );
    }
    expect(seen[0]).toBe('REQUESTED');
    expect(seen).toContain('WAITING_FOR_MOVEMENT');
    expect(seen).toContain('CALIBRATING');
    expect(seen[seen.length - 1]).toBe('VERIFYING');
    expect(fc.requested).toContain(MSP_MAG_CALIBRATION);
  });

  it('only claims the movement phase once the window has provably elapsed', async () => {
    /**
     * compass.c re-arms its end time to `movement + 30 s` the moment
     * movement is detected. So a process still running once the 15-second
     * window has passed PROVES movement was seen; before that it may still
     * be waiting, and the label says so instead of guessing.
     */
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...calibratingFor(MAG_NO_MOVEMENT_CUTOFF_MS + 5_000));
    const clock = new FakeClock();
    const timeline: {at: number; progress: SensorsCalibrationProgress}[] = [];
    await controllerFor(coordinator, clock).calibrateMagnetometer(key, progress => {
      timeline.push({at: clock.now(), progress});
    }).result;
    const firstCalibrating = timeline.find(
      entry => entry.progress === 'CALIBRATING',
    );
    expect(firstCalibrating).toBeDefined();
    expect(firstCalibrating?.at).toBeGreaterThanOrEqual(
      MAG_CALIBRATION_MOVEMENT_WINDOW_MS,
    );
  });

  it('never reports a progress percentage, because the firmware sends none', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...calibratingFor(MAG_NO_MOVEMENT_CUTOFF_MS + 5_000));
    const seen: SensorsCalibrationProgress[] = [];
    await controllerFor(coordinator, new FakeClock()).calibrateMagnetometer(
      key,
      progress => seen.push(progress),
    ).result;
    for (const progress of seen) {
      expect(typeof progress).toBe('string');
      expect(progress).not.toMatch(/\d/);
    }
  });

  it('reports a run that stopped inside the movement window as no movement', async () => {
    /**
     * With no movement, compass.c beeps a failure and saves nothing. A stop
     * that early is that branch, and calling it success would tell an
     * operator their compass was calibrated when it explicitly was not.
     */
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(
      ...calibratingFor(MAG_CALIBRATION_MOVEMENT_WINDOW_MS),
    );
    const clock = new FakeClock();
    const outcome = await controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    ).result;
    expect(outcome.kind).toBe('NO_MOVEMENT_DETECTED');
    if (outcome.kind === 'NO_MOVEMENT_DETECTED') {
      expect(outcome.elapsedMs).toBeLessThan(MAG_NO_MOVEMENT_CUTOFF_MS);
    }
  });

  it('reports START_NOT_OBSERVED when the flag never appears', async () => {
    // compassStartCalibration() sets its flag synchronously inside the MSP
    // handler, so a flag that never appears means the board never began.
    const {coordinator, key} = await connect({armingDisableFlags: 0});
    const clock = new FakeClock();
    const outcome = await controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    ).result;
    expect(outcome).toEqual({kind: 'START_NOT_OBSERVED'});
    // And it gave up at the START deadline, not at the whole-run one.
    expect(clock.now()).toBeLessThan(MAG_CALIBRATION_ABSOLUTE_DEADLINE_MS);
    expect(clock.now()).toBeGreaterThanOrEqual(MAG_CALIBRATION_START_DEADLINE_MS);
  });

  it('times out rather than waiting forever when the board never stops', async () => {
    const {coordinator, key} = await connect({armingDisableFlags: CALIBRATING});
    const clock = new FakeClock();
    const outcome = await controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    ).result;
    expect(outcome.kind).toBe('TIMED_OUT');
    if (outcome.kind === 'TIMED_OUT') {
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
        MAG_CALIBRATION_ABSOLUTE_DEADLINE_MS,
      );
    }
  });
});

/* ================================================================== *
 * CANCELLATION, LINK LOSS AND LATE RESULTS
 * ================================================================== */

describe('who stopped the observation', () => {
  it('reports a local cancellation as cancelled, and says the board may still be calibrating', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const clock = new FakeClock();
    const observation = controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    );
    await sleep(30);
    observation.cancel();
    const outcome = await observation.result;
    expect(outcome).toEqual({
      kind: 'OBSERVATION_CANCELLED',
      boardMayStillBeCalibrating: true,
    });
    // The firmware has no cancel command, so nothing was sent to stop it.
    expect(fc.requested.filter(c => c === MSP_MAG_CALIBRATION)).toHaveLength(1);
  });

  it('ignores a completion that lands after the cancellation', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const clock = new FakeClock();
    const observation = controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    );
    await sleep(30);
    observation.cancel();
    const outcome = await observation.result;
    // The board "finishes" now. Nothing may change the settled outcome.
    fc.setArmingDisableFlags(0);
    await sleep(20);
    expect(await observation.result).toBe(outcome);
    expect(outcome.kind).toBe('OBSERVATION_CANCELLED');
  });

  it('reports a dead link as lost, not as a cancellation', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const clock = new FakeClock();
    const observation = controllerFor(coordinator, clock).calibrateMagnetometer(
      key,
    );
    await sleep(30);
    coordinator.deactivateMspSession(key.sessionId);
    const outcome = await observation.result;
    expect(outcome).toEqual({kind: 'LINK_LOST'});
  });

  it('reports the app losing sight of the board as a cancellation, not a lost link', async () => {
    // The cable, the port and the board may all be perfectly fine; only
    // our ability to watch went away.
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    let phase: 'ACTIVE' | 'APP_BACKGROUND' = 'ACTIVE';
    const clock = new FakeClock();
    const observation = controllerFor(coordinator, clock, {
      getPhase: () => phase,
    }).calibrateMagnetometer(key);
    await sleep(30);
    phase = 'APP_BACKGROUND';
    const outcome = await observation.result;
    expect(outcome).toEqual({
      kind: 'OBSERVATION_CANCELLED',
      boardMayStillBeCalibrating: true,
    });
  });
});

/* ================================================================== *
 * TELEMETRY OWNERSHIP
 * ================================================================== */

describe('live polling while a calibration runs', () => {
  it('holds the scheduler paused for the whole calibration and releases it after', async () => {
    /**
     * NOT A LOCAL FLAG. This reads the REAL scheduler's own diagnostics:
     * MspOperationCoordinator.execute() takes its pause lease for the
     * duration of the operation, so a calibration that runs inside one is
     * covered by the mechanism that already exists rather than by a second
     * one built here.
     */
    const {fc, coordinator, key, sessionId} = await connect({
      armingDisableFlags: 0,
    });
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const scheduler = coordinator.getTelemetryScheduler(sessionId);
    if (scheduler === undefined) throw new Error('no scheduler');
    expect(scheduler.describeDiagnostics().pauseReasons).not.toContain(
      'EXCLUSIVE_OPERATION',
    );

    const observation = controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateMagnetometer(key);
    await sleep(40);
    expect(scheduler.describeDiagnostics().pauseReasons).toContain(
      'EXCLUSIVE_OPERATION',
    );

    observation.cancel();
    await observation.result;
    expect(scheduler.describeDiagnostics().pauseReasons).not.toContain(
      'EXCLUSIVE_OPERATION',
    );
  });

  it('releases the pause even when the calibration times out', async () => {
    const {coordinator, key, sessionId} = await connect({
      armingDisableFlags: CALIBRATING,
    });
    const scheduler = coordinator.getTelemetryScheduler(sessionId);
    if (scheduler === undefined) throw new Error('no scheduler');
    const outcome = await controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateAccelerometer(key).result;
    expect(outcome.kind).toBe('TIMED_OUT');
    expect(scheduler.describeDiagnostics().pauseReasons).not.toContain(
      'EXCLUSIVE_OPERATION',
    );
  });
});

/* ================================================================== *
 * WHO STOPPED IT, DECIDED AT THE COORDINATOR LEVEL
 * ================================================================== */

describe('when the operation itself never gets to run', () => {
  /**
   * The two cases above settle INSIDE the watch loop, which knows exactly
   * why it stopped. These two settle at the coordinator, which does not -
   * it only reports that the session went away. That is precisely where a
   * wrong precedence would go unnoticed, so both directions are pinned
   * here as well.
   */
  it('reports a cancellation that raced a dying session as a cancellation', async () => {
    const {coordinator, key, sessionId} = await connect({
      armingDisableFlags: 0,
    });
    const observation = controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateMagnetometer(key);
    // Both in the same turn, before the operation body can begin: the
    // caller stopped watching AND the session went away.
    observation.cancel();
    coordinator.deactivateMspSession(sessionId);
    const outcome = await observation.result;
    /* Cancellation wins, deliberately. "We stopped watching, the board may
       still be calibrating" stays true whatever the link did; "the
       connection was lost" would assert something about hardware nobody
       observed. */
    expect(outcome).toEqual({
      kind: 'OBSERVATION_CANCELLED',
      boardMayStillBeCalibrating: true,
    });
  });

  it('reports a dying session with no cancellation as a lost link', async () => {
    const {coordinator, key, sessionId} = await connect({
      armingDisableFlags: 0,
    });
    const observation = controllerFor(
      coordinator,
      new FakeClock(),
    ).calibrateAccelerometer(key);
    coordinator.deactivateMspSession(sessionId);
    const outcome = await observation.result;
    expect(outcome).toEqual({kind: 'LINK_LOST'});
  });
});

/* ================================================================== *
 * EXCLUSIVITY AND RESOURCE RELEASE
 * ================================================================== */

describe('one operation at a time', () => {
  it('refuses a second calibration while one is running', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const controller = controllerFor(coordinator, new FakeClock());
    const first = controller.calibrateMagnetometer(key);
    await sleep(30);
    const second = await controller.calibrateAccelerometer(key).result;
    expect(second).toEqual({
      kind: 'REJECTED',
      reason: 'OPERATION_IN_PROGRESS',
    });
    first.cancel();
    await first.result;
  });

  it('refuses a hardware save while a calibration is running', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const controller = controllerFor(coordinator, new FakeClock());
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');
    const running = controller.calibrateAccelerometer(key);
    await sleep(30);
    const save = await controller.saveHardwareSelection(key, loaded.snapshot, {
      mag: 5,
    });
    expect(save).toEqual({kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'});
    running.cancel();
    await running.result;
  });

  it('refuses a trim save while a calibration is running', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const controller = controllerFor(coordinator, new FakeClock());
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');
    const running = controller.calibrateMagnetometer(key);
    await sleep(30);
    const save = await controller.saveAccTrim(key, loaded.snapshot, {
      pitch: 10,
      roll: 10,
    });
    expect(save).toEqual({kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'});
    running.cancel();
    await running.result;
  });

  it('lets the next operation start once a terminal outcome has settled', async () => {
    /**
     * The exclusive lease is taken by MspOperationCoordinator.execute() and
     * released on every exit path it has. If a cancelled calibration leaked
     * one, this second operation would be refused forever.
     */
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const controller = controllerFor(coordinator, new FakeClock());
    const first = controller.calibrateMagnetometer(key);
    await sleep(30);
    first.cancel();
    await first.result;
    const loaded = await controller.load(key);
    expect(loaded.kind).toBe('LOADED');
  });

  it('lets the next operation start after a timeout too', async () => {
    const {coordinator, key} = await connect({armingDisableFlags: CALIBRATING});
    const controller = controllerFor(coordinator, new FakeClock());
    const timedOut = await controller.calibrateAccelerometer(key).result;
    expect(timedOut.kind).toBe('TIMED_OUT');
    const loaded = await controller.load(key);
    expect(loaded.kind).toBe('LOADED');
  });
});
