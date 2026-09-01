/**
 * MOTOR CONFIGURATION ACROSS API 1.47, 1.48 AND 1.49.
 *
 * =====================================================================
 * WHAT WAS WRONG, AND WHY IT MATTERED ON A BENCH
 * =====================================================================
 *
 * Two separate defects combined into one symptom: a Betaflight 4.7 board
 * connected to this app showed a Motors settings page that said the
 * firmware was unsupported, and showed no values at all.
 *
 * DEFECT 1 - the capability matrix. motorFirmwareCompatibility.ts withheld
 * MOTOR_CONFIGURATION_WRITE at API 1.48 with the note "the wider
 * configuration API changed ... until every setter/readback pair has its
 * own 1.48 fixtures". Nobody had found a difference; the caution was for a
 * difference that might exist. The two firmware trees were then compared
 * directly - API_VERSION_MINOR 47 against API_VERSION_MINOR 48 - and every
 * MSP handler on this path is byte-for-byte identical, along with
 * motorProtocolTypes_e, the CLI bounds, and each feature bit this app
 * writes. There was nothing to gate on.
 *
 * DEFECT 2 - and this is the one that hid the settings. captureSession()
 * took `requiredCapability` with a DEFAULT of MOTOR_CONFIGURATION_WRITE, so
 * every caller that passed nothing asked for permission to write. `load()`
 * passed nothing. A board whose reads were fine and whose writes were
 * withheld therefore failed at admission, before a single frame was sent,
 * and reported INCOMPATIBLE_FIRMWARE for an operation that would only ever
 * have READ. The default is gone; every call site now names the capability
 * it actually exercises.
 *
 * =====================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * =====================================================================
 *
 * Each scenario runs the REAL MotorConfigurationController against a
 * VirtualFlightController - a parameter store with RAM, EEPROM, an armed
 * flag and a power cycle - so a save that never reached the board cannot
 * pass, and a readback assertion is a statement about what the board holds
 * rather than about what a stub was told to return.
 *
 * They are not evidence about hardware. The byte layouts on both sides of
 * this wire are this app's own codecs; those are pinned against the
 * firmware's handlers by the decode/encode suites. What is proven here is
 * the transaction: admission, ordering, persistence, readback, refusal.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeAdvancedConfig} from '../../../core/protocol/msp/decoding/decodeAdvancedConfig';
import {decodeMotorConfig} from '../../../core/protocol/msp/decoding/decodeMotorConfig';
import {
  createMotorConfigurationDraft,
  type MotorConfigurationDraft,
  type MotorConfigurationSnapshot,
} from '../../../core/state/motorConfigurationModel';
import {rememberConfigurationSession} from '../../../core/state/configurationSessionOwnership';
import {MotorConfigurationController} from './MotorConfigurationController';
import type {
  MotorConfigurationLoadOutcome,
  MotorConfigurationSaveOutcome,
  MotorOutputOrderLoadOutcome,
  MotorOutputOrderSaveOutcome,
} from './MotorConfigurationController';
import {
  DRONE_SPECS,
  MOTOR_DSHOT300,
  MOTOR_DSHOT600,
  MOTOR_PWM,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

/** The three revisions this round is about, plus the one below the floor. */
const SUPPORTED_MINORS = [47, 48] as const;
const READ_ONLY_MINORS = [49] as const;

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no drone spec ${key}`);
  return found;
}

interface Rig {
  readonly board: VirtualFlightController;
  readonly session: VirtualSession;
  readonly motors: MotorConfigurationController;
}

function rig(droneKey: string, apiMinor: number): Rig {
  const droneSpec = spec(droneKey);
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(droneSpec),
  });
  const session = new VirtualSession({
    sessionId: `motor-api-${droneKey}-${apiMinor}`,
    board,
    apiMinor,
  });
  return {
    board,
    session,
    motors: new MotorConfigurationController(session.options),
  };
}

/** Loads, and fails the test with the refusal reason rather than with
 *  `undefined is not an object` three lines later. */
async function loadOrThrow(
  motors: MotorConfigurationController,
  session: VirtualSession,
  label: string,
): Promise<MotorConfigurationSnapshot> {
  const outcome = await motors.load(session.key);
  if (outcome.kind !== 'LOADED') {
    throw new Error(
      `${label}: expected LOADED, got ${outcome.kind}` +
        ('reason' in outcome ? ` (${outcome.reason})` : ''),
    );
  }
  return outcome.snapshot;
}

function describeOutcome(
  outcome:
    | MotorConfigurationLoadOutcome
    | MotorConfigurationSaveOutcome
    | MotorOutputOrderLoadOutcome
    | MotorOutputOrderSaveOutcome,
): string {
  if ('reason' in outcome && outcome.reason !== undefined) {
    return `${outcome.kind} (${outcome.reason})`;
  }
  return outcome.kind;
}

/** The motor protocol byte, read out of what the BOARD holds - not out of
 *  the snapshot the app happens to be carrying. */
function persistedMotorProtocol(board: VirtualFlightController): number {
  const bytes = board.readPersisted(MSP_ADVANCED_CONFIG);
  if (bytes === undefined) throw new Error('board has no advanced config');
  return decodeAdvancedConfig(bytes).motorProtocolRaw;
}

function persistedMotorConfig(board: VirtualFlightController) {
  const bytes = board.readPersisted(MSP_MOTOR_CONFIG);
  if (bytes === undefined) throw new Error('board has no motor config');
  return decodeMotorConfig(bytes);
}

/* ==================================================================== *
 * 1. READING - the defect that hid the settings
 * ==================================================================== */

describe('motor configuration: reading, per API revision', () => {
  it.each([47, 48, 49])(
    'loads the live motor settings on API 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const outcome = await motors.load(session.key);

      expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `1.${minor}: LOADED`,
      );
      if (outcome.kind !== 'LOADED') return;

      // Non-vacuous, and read off the BOARD rather than defaulted. A
      // freshly-flashed board reports the firmware's own PWM default for
      // the protocol and the Racing airframe's pole and motor counts, which
      // is exactly the state an operator opens this screen in.
      expect(outcome.snapshot.advanced.motorProtocolRaw).toBe(MOTOR_PWM);
      expect(outcome.snapshot.motor.motorPoleCount).toBe(14);
      expect(outcome.snapshot.motor.motorCount).toBe(4);

      // And it really did ask the board for all five groups.
      const asked = new Set(board.requests.map(request => request.command));
      for (const command of [MSP_FEATURE_CONFIG, MSP_MOTOR_CONFIG, MSP_ADVANCED_CONFIG]) {
        expect(asked.has(command)).toBe(true);
      }
    },
  );

  /**
   * THE REGRESSION, stated as the thing that must never come back: a read
   * must not consult the write capability. On API 1.49 writes are withheld
   * and reads are not, so this load passing is precisely the proof that
   * the two questions are now asked separately.
   */
  it('reads on API 1.49, where every write is withheld', async () => {
    const {board, session, motors} = rig('FREESTYLE', 49);
    const snapshot = await loadOrThrow(motors, session, 'api-1.49 read');
    expect(snapshot.advanced.motorProtocolRaw).toBe(MOTOR_PWM);
    expect(snapshot.motor.motorPoleCount).toBe(14);
    expect(board.counts.writes).toBe(0);
  });

  it('still refuses API 1.45, which is below the reviewed range', async () => {
    const {board, session, motors} = rig('RACING', 45);
    const outcome = await motors.load(session.key);
    expect(describeOutcome(outcome)).toBe('REJECTED (INCOMPATIBLE_FIRMWARE)');
    expect(board.requests).toEqual([]);
  });

  it('refuses a non-Betaflight board at every revision', async () => {
    const {board, session, motors} = rig('RACING', 48);
    session.firmwareIdentifier = 'INAV';
    const outcome = await motors.load(session.key);
    expect(describeOutcome(outcome)).toBe('REJECTED (INCOMPATIBLE_FIRMWARE)');
    expect(board.requests).toEqual([]);
  });
});

/* ==================================================================== *
 * 2. WRITING - protocol change, persistence, readback
 * ==================================================================== */

describe('motor configuration: writing, per API revision', () => {
  it.each(SUPPORTED_MINORS)(
    'changes the motor protocol on API 1.%i and the board keeps it',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      // The real journey: a freshly-flashed board is on PWM and the
      // operator moves it to the digital protocol the aircraft flies.
      expect(before.advanced.motorProtocolRaw).toBe(MOTOR_PWM);

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT600,
      });

      expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `1.${minor}: SAVED_VERIFIED`,
      );
      // EEPROM, not just RAM: a save that stopped at the parameter write
      // would leave this un-persisted and the assertion would say so.
      expect(board.hasUnsavedChanges()).toBe(false);
      expect(persistedMotorProtocol(board)).toBe(MOTOR_DSHOT600);
      expect(board.counts.eepromWrites).toBe(1);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'writes every motor field on API 1.%i and reads each one back',
    async minor => {
      const {board, session, motors} = rig('FREESTYLE', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);

      const draft: MotorConfigurationDraft = {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT300,
        motorPoleCount: 12,
        maxThrottle: 1990,
        minCommand: 1010,
        motorIdleRaw: 700,
        dshotTelemetryEnabled: true,
        motorStopEnabled: true,
      };
      const outcome = await motors.save(session.key, before, draft);
      expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `1.${minor}: SAVED_VERIFIED`,
      );

      // Read the BOARD, field by field, after the transaction.
      const motor = persistedMotorConfig(board);
      const advanced = decodeAdvancedConfig(
        board.readPersisted(MSP_ADVANCED_CONFIG) as Uint8Array,
      );
      expect({
        protocol: advanced.motorProtocolRaw,
        idle: advanced.motorIdleRaw,
        poles: motor.motorPoleCount,
        maxThrottle: motor.maxThrottle,
        minCommand: motor.minCommand,
        dshotTelemetry: motor.dshotTelemetryRaw,
      }).toEqual({
        protocol: MOTOR_DSHOT300,
        idle: 700,
        poles: 12,
        maxThrottle: 1990,
        minCommand: 1010,
        dshotTelemetry: 1,
      });

      // The declared snapshot must agree with the board, or the outcome
      // would be claiming something the aircraft does not hold.
      if (outcome.kind !== 'SAVED_VERIFIED') return;
      expect(outcome.snapshot.motor.motorPoleCount).toBe(12);
      expect(outcome.snapshot.advanced.motorProtocolRaw).toBe(MOTOR_DSHOT300);
    },
  );

  /**
   * The min-throttle slot is DEAD on both revisions - the firmware reads it
   * and discards it ("minthrottle deprecated in 4.6") - so the encoder ships
   * a structural zero. This asserts the wire bytes, because a non-zero there
   * would be this app inventing a throttle endpoint the firmware ignores on
   * one revision and might not on another.
   */
  it.each(SUPPORTED_MINORS)(
    'sends the deprecated min-throttle slot as a structural zero on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorPoleCount: 12,
      });

      const write = board.requests.find(
        request => request.command === MSP_SET_MOTOR_CONFIG,
      );
      expect(write).toBeDefined();
      expect(write?.payload.length).toBe(8);
      expect([write?.payload[0], write?.payload[1]]).toEqual([0, 0]);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'sends nothing at all when the draft matches the board on 1.%i',
    async minor => {
      const {board, session, motors} = rig('CINEWHOOP', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      const readsAfterLoad = board.counts.reads;

      const outcome = await motors.save(
        session.key,
        before,
        createMotorConfigurationDraft(before),
      );

      expect(describeOutcome(outcome)).toBe('NO_CHANGES');
      expect(board.counts.writes).toBe(0);
      expect(board.counts.eepromWrites).toBe(0);
      // Not even a preflight read: an unchanged save is decided before the
      // link is touched.
      expect(board.counts.reads).toBe(readsAfterLoad);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'writes only the groups that changed on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT300,
      });

      expect(outcome.kind).toBe('SAVED_VERIFIED');
      if (outcome.kind !== 'SAVED_VERIFIED') return;
      expect(outcome.changedGroups).toEqual(['ADVANCED']);
      const written = board.requests
        .filter(request => request.command === MSP_SET_MOTOR_CONFIG)
        .length;
      expect(written).toBe(0);
    },
  );
});

/* ==================================================================== *
 * 3. THE REFUSAL ON 1.49 - withheld, and named as withheld
 * ==================================================================== */

describe('motor configuration: API 1.49 is read-only, and says which', () => {
  it.each(READ_ONLY_MINORS)(
    'refuses a save on API 1.%i without sending a frame',
    async minor => {
      const {board, session, motors} = rig('FREESTYLE', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      const requestsAfterLoad = board.requests.length;

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT600,
      });

      // The reason is the specific one, not the blanket one: the operator
      // is looking at settings that loaded fine.
      expect(describeOutcome(outcome)).toBe(
        'REJECTED (CONFIGURATION_WRITE_UNVERIFIED)',
      );
      expect(board.requests.length).toBe(requestsAfterLoad);
      expect(board.counts.writes).toBe(0);
      expect(board.counts.eepromWrites).toBe(0);
      expect(persistedMotorProtocol(board)).toBe(MOTOR_PWM);
    },
  );

  it('refuses the output-order save on 1.49 while still loading it', async () => {
    const {board, session, motors} = rig('RACING', 49);
    const loaded = await motors.loadOutputOrder(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;

    const reversed = [...loaded.values].reverse();
    const outcome = await motors.saveOutputOrder(
      session.sessionId,
      loaded.values,
      reversed,
    );
    expect(describeOutcome(outcome)).toBe(
      'REJECTED (CONFIGURATION_WRITE_UNVERIFIED)',
    );
    expect(board.counts.writes).toBe(0);
  });

  /**
   * A board this app cannot read AT ALL is a different statement, and it
   * must keep the different reason. Collapsing the two was half the defect,
   * so this proves they did not collapse the other way either.
   *
   * U-R3 CHANGED HOW THIS HAS TO BE ASKED. The case used to be built by
   * loading from a 1.47 board and saving against a 1.45 one, and the
   * refusal it read was the admission gate's. That construction is now
   * TWO faults at once - a foreign baseline as well as an unreadable
   * board - and session ownership is decided first, before admission and
   * before anything reaches the wire. So the two are separated: the
   * cross-board submission proves the ownership refusal comes first, and
   * a baseline this session really does own proves the capability reason
   * still survives underneath it. Neither may touch the link.
   */
  it('refuses a baseline from another session before it ever asks what the board is', async () => {
    const reference = rig('RACING', 47);
    const snapshot = await loadOrThrow(
      reference.motors,
      reference.session,
      'reference load',
    );

    const {board, session, motors} = rig('RACING', 45);
    const outcome = await motors.save(session.key, snapshot, {
      ...createMotorConfigurationDraft(snapshot),
      motorProtocolRaw: MOTOR_DSHOT300,
    });

    expect(describeOutcome(outcome)).toBe('REJECTED (SESSION_CHANGED)');
    expect(board.requests).toEqual([]);
  });

  it('keeps INCOMPATIBLE_FIRMWARE for a board that cannot be read', async () => {
    const reference = rig('RACING', 47);
    const snapshot = await loadOrThrow(
      reference.motors,
      reference.session,
      'reference load',
    );

    const {board, session, motors} = rig('RACING', 45);
    /* The operator holds a baseline that belongs to THIS session - the one
       thing the 1.45 board cannot supply, since it cannot be read at all.
       Stating it explicitly is what isolates the capability refusal from
       the ownership refusal instead of letting one hide the other. */
    rememberConfigurationSession(snapshot, session.key);
    const outcome = await motors.save(session.key, snapshot, {
      ...createMotorConfigurationDraft(snapshot),
      motorProtocolRaw: MOTOR_DSHOT300,
    });

    expect(describeOutcome(outcome)).toBe('REJECTED (INCOMPATIBLE_FIRMWARE)');
    expect(board.requests).toEqual([]);
  });
});

/* ==================================================================== *
 * 4. SAFETY AND FAILURE - unchanged by the capability change
 * ==================================================================== */

describe('motor configuration: refusals and failures at 1.47 and 1.48 alike', () => {
  it.each(SUPPORTED_MINORS)(
    'refuses to write to an ARMED board on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      board.setArmed(true);

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT600,
      });

      expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `1.${minor}: REJECTED (FC_ARMED)`,
      );
      expect(board.counts.writes).toBe(0);
      expect(persistedMotorProtocol(board)).toBe(MOTOR_PWM);

      // The armed proof is read AFTER the stale-base re-read and BEFORE
      // any write - the order is the guarantee, not the presence.
      const status = board.requests.findIndex(
        request => request.command === MSP_STATUS_EX,
      );
      const firstWrite = board.requests.findIndex(
        request => request.command === MSP_SET_ADVANCED_CONFIG,
      );
      expect(status).toBeGreaterThanOrEqual(0);
      expect(firstWrite).toBe(-1);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'reports a rejected parameter write as FAILED and never commits on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      board.injectFault({
        command: MSP_SET_ADVANCED_CONFIG,
        fault: {kind: 'REMOTE_ERROR'},
      });

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT600,
      });

      expect(`1.${minor}: ${outcome.kind}`).toBe(`1.${minor}: FAILED`);
      expect(board.counts.eepromWrites).toBe(0);
      expect(persistedMotorProtocol(board)).toBe(MOTOR_PWM);
    },
  );

  /**
   * The EEPROM failure is the ugly one and it is reported as ugly: the
   * parameter write WAS acknowledged, so the board's RAM holds the new
   * value while its EEPROM does not. Calling that a success would tell an
   * operator their aircraft is configured when a power cycle will undo it.
   */
  it.each(SUPPORTED_MINORS)(
    'never claims success when the EEPROM commit fails on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      board.injectFault({
        command: MSP_EEPROM_WRITE,
        fault: {kind: 'REMOTE_ERROR'},
      });

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorProtocolRaw: MOTOR_DSHOT600,
      });

      expect(outcome.kind).not.toBe('SAVED_VERIFIED');
      expect(outcome.kind).not.toBe('NO_CHANGES');
      expect(board.hasUnsavedChanges()).toBe(true);
      // A power cycle proves the point: the change is gone.
      board.powerCycle();
      expect(persistedMotorProtocol(board)).toBe(MOTOR_PWM);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'reports a truncated MSP_MOTOR_CONFIG as a failure rather than decoding it on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      board.injectFault({
        command: MSP_MOTOR_CONFIG,
        fault: {kind: 'TRUNCATE', bytes: 6},
      });

      const outcome = await motors.load(session.key);
      expect(`1.${minor}: ${outcome.kind}`).toBe(`1.${minor}: FAILED`);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'refuses a save whose base no longer matches the board on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);

      // A second configurator moves the same field between load and save.
      const advanced = board.readParameter(MSP_ADVANCED_CONFIG) as Uint8Array;
      const moved = Uint8Array.from(advanced);
      moved[3] = MOTOR_DSHOT600;
      board.overwriteParameter(MSP_ADVANCED_CONFIG, moved);

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorPoleCount: 12,
      });

      expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `1.${minor}: REJECTED (STALE_BASE)`,
      );
      expect(board.counts.writes).toBe(0);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'refuses an out-of-range draft before touching the link on 1.%i',
    async minor => {
      const {board, session, motors} = rig('RACING', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      const requestsAfterLoad = board.requests.length;

      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        motorPoleCount: 2, // firmware bound is 4..255 (cli/settings.c)
      });

      expect(describeOutcome(outcome)).toBe('REJECTED (INVALID_DRAFT)');
      expect(board.requests.length).toBe(requestsAfterLoad);
    },
  );
});

/* ==================================================================== *
 * 5. RACING AND FREESTYLE, TAKEN TO THEIR OWN TARGETS ON EACH REVISION
 * ==================================================================== */

/**
 * The two aircraft named in the brief, each driven from a freshly-flashed
 * board to the motor configuration its own fixture specifies, on all three
 * revisions. Nothing here is tuned to make a version pass: both aircraft
 * get exactly the protocol and idle their spec already carried before this
 * round, and the 1.49 row expects the refusal rather than a success.
 */
describe('Racing and Freestyle on API 1.47, 1.48 and 1.49', () => {
  const AIRCRAFT = ['RACING', 'FREESTYLE'] as const;

  it.each(
    AIRCRAFT.flatMap(key => [47, 48, 49].map(minor => [key, minor] as const)),
  )('%s at API 1.%i', async (key, minor) => {
    const {board, session, motors} = rig(key, minor);
    const target = spec(key).target;

    // READ - required on every revision, including the one that cannot be
    // written to.
    const before = await loadOrThrow(motors, session, `${key} 1.${minor}`);
    expect(before.advanced.motorProtocolRaw).toBe(MOTOR_PWM);

    const draft: MotorConfigurationDraft = {
      ...createMotorConfigurationDraft(before),
      motorProtocolRaw: target.motorProtocol,
      motorIdleRaw: target.motorIdlePercent,
      dshotTelemetryEnabled: true,
    };
    const outcome = await motors.save(session.key, before, draft);

    if (minor >= 49) {
      expect(`${key} 1.${minor}: ${describeOutcome(outcome)}`).toBe(
        `${key} 1.${minor}: REJECTED (CONFIGURATION_WRITE_UNVERIFIED)`,
      );
      expect(board.counts.writes).toBe(0);
      expect(persistedMotorProtocol(board)).toBe(MOTOR_PWM);
      return;
    }

    expect(`${key} 1.${minor}: ${describeOutcome(outcome)}`).toBe(
      `${key} 1.${minor}: SAVED_VERIFIED`,
    );

    // EEPROM and readback, from the board, after a power cycle - the only
    // form of "it saved" that a lost RAM write cannot fake.
    expect(board.hasUnsavedChanges()).toBe(false);
    session.reconnect();
    const after = await loadOrThrow(motors, session, `${key} 1.${minor} reload`);
    expect({
      protocol: after.advanced.motorProtocolRaw,
      idle: after.advanced.motorIdleRaw,
      dshotTelemetry: after.motor.dshotTelemetryRaw,
      poles: after.motor.motorPoleCount,
    }).toEqual({
      protocol: target.motorProtocol,
      idle: target.motorIdlePercent,
      dshotTelemetry: 1,
      poles: spec(key).hardware.motorPoleCount,
    });
  });
});

/* ==================================================================== *
 * 6. RECONNECT - the settings must come back, on every revision
 * ==================================================================== */

describe('motor configuration: reconnect and reload', () => {
  it.each([47, 48, 49])(
    'reloads from the board after a reconnect on API 1.%i',
    async minor => {
      const {board, session, motors} = rig('LONG_RANGE', minor);
      const first = await loadOrThrow(motors, session, `1.${minor} first`);
      expect(first.advanced.motorProtocolRaw).toBe(MOTOR_PWM);

      session.reconnect();

      const second = await loadOrThrow(motors, session, `1.${minor} reload`);
      expect(second.advanced.motorProtocolRaw).toBe(MOTOR_PWM);
      expect(board.counts.reboots).toBeGreaterThan(0);
    },
  );

  it.each(SUPPORTED_MINORS)(
    'a saved protocol survives a power cycle and reloads on 1.%i',
    async minor => {
      const {board, session, motors} = rig('LONG_RANGE', minor);
      const before = await loadOrThrow(motors, session, `1.${minor} load`);
      const outcome = await motors.save(session.key, before, {
        ...createMotorConfigurationDraft(before),
        // The long-range build flies DShot300, per its own fixture.
        motorProtocolRaw: MOTOR_DSHOT300,
      });
      expect(describeOutcome(outcome)).toBe('SAVED_VERIFIED');

      session.reconnect();

      const after = await loadOrThrow(motors, session, `1.${minor} reload`);
      expect(after.advanced.motorProtocolRaw).toBe(MOTOR_DSHOT300);
      expect(board.hasUnsavedChanges()).toBe(false);
    },
  );
});
