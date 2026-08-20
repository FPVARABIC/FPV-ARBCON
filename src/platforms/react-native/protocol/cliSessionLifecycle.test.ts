/**
 * WHAT LEAVING THE CLI DOES TO THE REST OF THE APPLICATION.
 *
 * THE FIELD REPORT. Open CLI, run some commands, `save` (or just exit),
 * then go to Motors: the session toggle reads UNKNOWN, the session state
 * cannot be read, and no motor-test session can be opened - while the app
 * still shows a connected flight controller. Other screens are affected
 * too. The only recovery is reloading the page or unplugging USB.
 *
 * THIS FILE WIRES THE REAL PIECES TOGETHER, because the defect lives in
 * the seam between them and no single-unit test can see it:
 *
 *   MspSessionCoordinator   (real)  owns the session, the client, the
 *                                   transport, the telemetry scheduler
 *                                   and the motor-test capability
 *   RNMspTransport          (real)  owns raw mode
 *   MspClient               (real)  owns the epoch and the lease
 *   RawCliSessionController (real)  the thing under investigation
 *
 * Only the USB layer underneath is a fake, and it is a fake of the
 * NATIVE client - the same seam MspSessionCoordinator.test.ts fakes.
 *
 * THE QUESTION EVERY TEST HERE ASKS: after the CLI is finished with, is
 * the application in a state a user can keep using without unplugging
 * anything?
 */

import {
  MspClient,
  MSP_ADVANCED_CONFIG,
  MSP_API_VERSION,
  MSP_ANALOG,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
} from '../../../core';
import {MotorConfigurationController} from './MotorConfigurationController';
import {PidTuningController} from './PidTuningController';
import {PortsConfigurationController} from './PortsConfigurationController';
import {ReceiverConfigurationController} from './ReceiverConfigurationController';
import {acquireMotorTestLease} from '../../../core/protocol/motorTestLease';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import {
  LINK_DEAD_AFTER_CONSECUTIVE_FAILURES,
  MspSessionCoordinator,
} from './MspSessionCoordinator';
import type {
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../transport';
import {RawCliSessionController} from './RawCliSessionController';
import {readMotorTestCapability} from './motorTestCapability';
import {FcRebootRecovery} from './fcRebootRecovery';

const SESSION_ID = 'session-cli-lifecycle';

function ascii(text: string): number[] {
  return text.split('').map(character => character.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  // eslint-disable-next-line no-bitwise -- little-endian split.
  return [value & 0xff, (value >> 8) & 0xff];
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

/**
 * A fake USB client that ALSO speaks CLI.
 *
 * The real board answers MSP frames until `#` puts it into CLI mode, then
 * answers text until it leaves. Modelling that switch is the whole point:
 * a fake that only ever speaks MSP could never show what leaving CLI
 * costs.
 */
class FakeUsbBoard {
  readonly dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  readonly detachListeners = new Set<
    (event: UsbSerialSessionDetachedEvent) => void
  >();
  readonly responses = new Map<number, Uint8Array>();
  readonly cliCommands: string[] = [];
  inCliMode = false;
  /** Set when the board has rebooted: it answers nothing at all until a
   *  new session is opened, exactly like a re-enumerating USB device. */
  rebooted = false;
  private pending = '';

  constructor(readonly sessionId: string) {
    this.responses.set(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
    this.responses.set(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
    this.responses.set(
      MSP_BOARD_INFO,
      Uint8Array.from([
        ...ascii('AFF3'),
        ...u16le(0),
        0,
        0,
        ...pstring('TEST'),
        ...pstring('MyBoard'),
        ...pstring('MTKS'),
        ...new Array(32).fill(0),
        0,
      ]),
    );
    this.responses.set(
      MSP_BATTERY_STATE,
      Uint8Array.from([
        4, ...u16le(1500), 168, ...u16le(0), ...u16le(0), 0, ...u16le(1680),
      ]),
    );
    this.responses.set(
      MSP_ANALOG,
      Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]),
    );
    this.responses.set(
      MSP_RAW_GPS,
      Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]),
    );
    this.responses.set(
      MSP_STATUS_EX,
      Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]),
    );
    // The five groups the Motors settings screen reads, so "can a screen
    // read?" is a real question here rather than a stubbed one.
    this.responses.set(MSP_FEATURE_CONFIG, Uint8Array.from([0, 0, 0, 0]));
    this.responses.set(MSP_MIXER_CONFIG, Uint8Array.from([3, 0]));
    this.responses.set(
      MSP_MOTOR_CONFIG,
      Uint8Array.from([...u16le(0), ...u16le(2000), ...u16le(1000), 4, 14, 0, 0]),
    );
    this.responses.set(
      MSP_MOTOR_3D_CONFIG,
      Uint8Array.from([...u16le(1406), ...u16le(1514), ...u16le(1460)]),
    );
    this.responses.set(
      MSP_ADVANCED_CONFIG,
      Uint8Array.from([
        1, 1, 0, 6, ...u16le(480), ...u16le(550), 0, 0, 0, 0, 32,
        ...u16le(125), ...u16le(0), 0, 0, 60,
      ]),
    );
    this.responses.set(MSP_BOXIDS, Uint8Array.from([0]));
  }

  /* ---- the UsbSerialTransportClient surface ------------------------ */

  writeBytes = jest.fn(async (_sessionId: string, dataBase64: string) => {
    if (this.rebooted) return;
    const bytes = base64ToBytes(dataBase64);
    if (this.inCliMode) {
      this.feedCli(bytes);
      return;
    }
    // `#` is the one byte that works in BOTH modes - it is how a client
    // asks a board speaking MSP to start speaking text.
    if (bytes.length >= 1 && bytes[0] === 0x23) {
      this.inCliMode = true;
      this.feedCli(bytes);
      return;
    }
    const command = bytes[4];
    const payload = this.responses.get(command);
    if (payload === undefined) return;
    this.emitFrame(command, payload);
  });

  onDataReceived = jest.fn((listener: (event: UsbSerialDataEvent) => void) => {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  });

  onSessionDetached = jest.fn(
    (listener: (event: UsbSerialSessionDetachedEvent) => void) => {
      this.detachListeners.add(listener);
      return () => this.detachListeners.delete(listener);
    },
  );

  stopReading = jest.fn(async () => undefined);
  startReading = jest.fn(async () => undefined);
  closeSession = jest.fn(async () => undefined);
  openDevice = jest.fn(async () => this.sessionId);
  setBaudRate = jest.fn(async () => undefined);
  setControlLines = jest.fn(async () => undefined);
  saveFirmwareFile = jest.fn(async () => true);

  /* ---- board behaviour --------------------------------------------- */

  /** The USB device going away, as a reboot or an unplug does. */
  detach(): void {
    this.rebooted = true;
    this.inCliMode = false;
    for (const listener of Array.from(this.detachListeners)) {
      listener({sessionId: this.sessionId, reason: 'DEVICE_DETACHED'} as never);
    }
  }

  private feedCli(bytes: Uint8Array): void {
    this.pending += String.fromCharCode(...bytes);
    let index = this.pending.indexOf('\r');
    while (index >= 0) {
      const line = this.pending.slice(0, index).trim();
      this.pending = this.pending.slice(index + 1);
      this.respondCli(line);
      index = this.pending.indexOf('\r');
    }
  }

  private respondCli(line: string): void {
    if (line !== '') this.cliCommands.push(line);
    if (line === '' || line === '#') {
      this.emitText('\r\nEntering CLI Mode\r\n# ');
      return;
    }
    if (line.toLowerCase() === 'save') {
      // THE REAL BEHAVIOUR: Betaflight's `save` writes EEPROM and then
      // REBOOTS (cli.c: cliSave -> writeEEPROM + cliReboot). The USB
      // device goes away mid-sentence.
      this.emitText('\r\nSaving');
      this.detach();
      return;
    }
    if (line.toLowerCase() === 'exit') {
      this.inCliMode = false;
      this.emitText('\r\n');
      return;
    }
    if (line.includes('bogus')) {
      // The firmware's own rejection shape (cli.c cliPrintErrorLinef).
      this.emitText(`\r\n###ERROR IN set: INVALID NAME: bogus###\r\n# `);
      return;
    }
    this.emitText(`\r\n${line} accepted\r\n# `);
  }

  private emitText(text: string): void {
    const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
    const event: UsbSerialDataEvent = {
      sessionId: this.sessionId,
      dataBase64: bytesToBase64(bytes),
    };
    for (const listener of Array.from(this.dataListeners)) listener(event);
  }

  private emitFrame(command: number, payload: Uint8Array): void {
    const frame = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
    const event: UsbSerialDataEvent = {
      sessionId: this.sessionId,
      dataBase64: bytesToBase64(frame),
    };
    for (const listener of Array.from(this.dataListeners)) listener(event);
  }
}

interface Rig {
  readonly coordinator: MspSessionCoordinator;
  readonly board: FakeUsbBoard;
  readonly cli: RawCliSessionController;
  readonly client: MspClient;
  readonly recovery: FcRebootRecovery;
}

/** Every coordinator this file builds, torn down after each test - a live
 *  telemetry interval outliving its suite is what stops jest exiting. */
const OPENED: MspSessionCoordinator[] = [];

afterEach(() => {
  while (OPENED.length > 0) {
    const coordinator = OPENED.pop();
    for (const id of coordinator?.listSessionIds() ?? []) {
      coordinator?.deactivateMspSession(id);
    }
  }
});

async function liveRig(): Promise<Rig> {
  const coordinator = new MspSessionCoordinator();
  OPENED.push(coordinator);
  const board = new FakeUsbBoard(SESSION_ID);
  const client = coordinator.openSession(
    board as unknown as UsbSerialTransportClient,
    SESSION_ID,
  );
  await flushAsync();
  const recovery = new FcRebootRecovery();
  const cli = new RawCliSessionController({
    coordinator,
    appStatePhase: () => 'ACTIVE',
    motorTestActive: () => false,
    rebootRecovery: recovery,
  });
  return {coordinator, board, cli, client, recovery};
}


/**
 * Drives the session's OWN telemetry dispatches until `count` of them
 * have failed in a row.
 *
 * Deliberately not a fake counter: it calls the real scheduler's tick(),
 * which dispatches a real request against the fake board and settles it,
 * so what is being counted here is exactly what would be counted on a
 * bench. Each failing dispatch costs one MSP response timeout, which is
 * why these tests carry their own generous jest timeout.
 */
async function driveFailedDispatches(
  coordinator: MspSessionCoordinator,
  count = LINK_DEAD_AFTER_CONSECUTIVE_FAILURES,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  for (let settled = 0; settled < count; ) {
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    if (scheduler === undefined) return; // the session already ended
    const before = scheduler.getConsecutiveLinkFailureCount();
    scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 60));
    await flushAsync();
    const after =
      coordinator.getTelemetryScheduler(SESSION_ID)?.getConsecutiveLinkFailureCount() ??
      before + 1;
    if (after > before) settled += after - before;
    if (Date.now() > deadline) throw new Error('dispatches never settled');
  }
}

/*
 * There was a driveUntilSuccess() here, for the other half of the count's
 * contract - that any success zeroes it. It is gone rather than kept
 * unused: proving that against a REAL MspClient means driving the client
 * back out of its own recovery, which measures recovery rather than the
 * reset rule. The rule is pinned deterministically at the scheduler
 * instead, in MspTelemetryScheduler.test.ts ("consecutive link
 * failures"), where a FakeClock and a fake requester make it exact.
 */

/**
 * CAN A MOTOR-TEST SESSION BE OPENED RIGHT NOW?
 *
 * This is the exact question the Motors session toggle asks, reduced to
 * the one call that answers it. A capability with no live client, or a
 * link somebody still holds a lease on, fails here - which is precisely
 * what "Motor test session cannot be opened" means on screen.
 */
function canOpenMotorTestSession(coordinator: MspSessionCoordinator): string {
  const capability = readMotorTestCapability(SESSION_ID);
  if (capability === undefined) return 'NO_CAPABILITY';
  if (!capability.isOpen()) return 'CAPABILITY_CLOSED';
  const client = coordinator.getActiveMspClient(SESSION_ID);
  const identity = coordinator.getMotorTestSessionIdentity(SESSION_ID);
  if (client === undefined || identity === undefined) return 'NO_CLIENT';
  const acquired = acquireMotorTestLease({
    client,
    requestedIdentity: identity,
    readCurrentIdentity: () =>
      coordinator.getMotorTestSessionIdentity(SESSION_ID),
  });
  if (acquired.kind !== 'ACQUIRED') return `REFUSED:${acquired.reason}`;
  acquired.lease.release();
  return 'CAN_OPEN';
}

/** Can an ordinary configuration screen load its data? */
async function canScreenRead(
  coordinator: MspSessionCoordinator,
): Promise<string> {
  const controller = new MotorConfigurationController({
    coordinator: coordinator as never,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    isMotorOutputEngaged: () => false,
  });
  const outcome = await controller.load(SESSION_ID);
  return outcome.kind === 'REJECTED'
    ? `REJECTED:${outcome.reason}`
    : outcome.kind;
}

/** Everything a screen needs before it can do anything at all. */
function screenReadiness(coordinator: MspSessionCoordinator) {
  return {
    ownership: coordinator.getOwnershipState(SESSION_ID),
    hasKey: coordinator.getSessionKey(SESSION_ID) !== undefined,
    hasClient: coordinator.getActiveMspClient(SESSION_ID) !== undefined,
    hasScheduler:
      coordinator.getTelemetryScheduler(SESSION_ID) !== undefined,
    motorTest: canOpenMotorTestSession(coordinator),
  };
}

describe('the session survives a CLI window that ends normally', () => {
  it('is usable before CLI is ever opened', async () => {
    const {coordinator} = await liveRig();
    expect(screenReadiness(coordinator)).toEqual({
      ownership: 'ACTIVE',
      hasKey: true,
      hasClient: true,
      hasScheduler: true,
      motorTest: 'CAN_OPEN',
    });
  });

  /**
   * EXIT WITHOUT SAVE. The board does not reboot, so nothing about the
   * session has changed and every screen must be exactly as usable as it
   * was before the CLI window opened.
   */
  it('is usable again after CLI exits without saving', async () => {
    const {coordinator, cli, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    expect(cli.getPhase()).toBe('ACTIVE');
    await cli.execute('get motor_poles');
    await cli.exitWithoutSave();

    expect(cli.getPhase()).toBe('IDLE');
    expect(board.cliCommands).toContain('exit');
    expect(screenReadiness(coordinator)).toEqual({
      ownership: 'ACTIVE',
      hasKey: true,
      hasClient: true,
      hasScheduler: true,
      motorTest: 'CAN_OPEN',
    });
  });

  it('leaves no lease behind after exiting without saving', async () => {
    const {coordinator, cli, client} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    expect(client.isMotorTestLeaseHeld()).toBe(true);
    await cli.exitWithoutSave();
    expect(client.isMotorTestLeaseHeld()).toBe(false);

    // And the link can be leased again immediately - which is exactly
    // what opening a motor-test session or a configuration transaction
    // has to do next.
    await cli.begin(key);
    expect(cli.getPhase()).toBe('ACTIVE');
    await cli.exitWithoutSave();
  });

  it('opens and closes CLI repeatedly without degrading', async () => {
    const {coordinator, cli, client} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    for (let round = 1; round <= 5; round += 1) {
      await cli.begin(key);
      expect(`round ${round} phase`).toBe(
        `round ${round} ${cli.getPhase() === 'ACTIVE' ? 'phase' : cli.getPhase()}`,
      );
      await cli.execute('get motor_poles');
      await cli.exitWithoutSave();
      expect(`round ${round} lease`).toBe(
        `round ${round} ${client.isMotorTestLeaseHeld() ? 'HELD' : 'lease'}`,
      );
      const motors = canOpenMotorTestSession(coordinator);
      expect(`round ${round} motors`).toBe(
        `round ${round} ${motors === 'CAN_OPEN' ? 'motors' : motors}`,
      );
    }
  });
});

/* ==================================================================== *
 * SAVE - the case the field report is actually about
 * ==================================================================== */

describe('the session after a CLI save, which reboots the board', () => {
  /**
   * THE REPRODUCTION.
   *
   * `save` makes Betaflight write EEPROM and reboot. The USB device goes
   * away underneath the app. What must NOT happen is the app carrying on
   * as though it still had a session: a key, a client and a scheduler
   * that all name a board which is no longer there. Every screen that
   * asks "am I connected?" gets yes, and every screen that then tries to
   * use the session gets nothing.
   */
  it('does not keep claiming a live session after the board reboots', async () => {
    const {coordinator, cli, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    await cli.execute('set motor_poles = 12');
    await cli.saveAndClose();
    await flushAsync();

    expect(board.cliCommands).toContain('save');
    expect(cli.getPhase()).toBe('IDLE');

    // The board is gone. The app must say so, not offer a dead session.
    const readiness = screenReadiness(coordinator);
    expect({
      ownership: readiness.ownership,
      offersASession: readiness.hasKey,
      motorTest: readiness.motorTest,
    }).toEqual({
      ownership: 'INACTIVE',
      offersASession: false,
      motorTest: 'NO_CAPABILITY',
    });
  });

  it('lets a brand new session be opened for the same id after the reboot', async () => {
    const {coordinator, cli} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');
    const firstGeneration = key.generation;

    await cli.begin(key);
    await cli.saveAndClose();
    await flushAsync();

    // The device re-enumerates and the app opens a session for it again -
    // the ordinary reconnect path, no page reload and no unplug.
    const reconnected = new FakeUsbBoard(SESSION_ID);
    coordinator.openSession(
      reconnected as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();

    const readiness = screenReadiness(coordinator);
    expect({
      ownership: readiness.ownership,
      hasClient: readiness.hasClient,
      hasScheduler: readiness.hasScheduler,
      motorTest: readiness.motorTest,
    }).toEqual({
      ownership: 'ACTIVE',
      hasClient: true,
      hasScheduler: true,
      motorTest: 'CAN_OPEN',
    });

    // And it is a genuinely NEW physical session, so no screen holding a
    // draft from before the reboot can write it to the rebooted board.
    const newKey = coordinator.getSessionKey(SESSION_ID);
    expect(newKey?.generation).not.toBe(firstGeneration);
  });

  it('leaves no lease and no raw-mode diversion behind after a save', async () => {
    const {coordinator, cli, client} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    await cli.saveAndClose();
    await flushAsync();

    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(cli.getPhase()).toBe('IDLE');
  });
});

/* ==================================================================== *
 * THE LINK DYING WHILE CLI IS OPEN
 * ==================================================================== */

describe('the session after the link dies under an open CLI window', () => {
  it('reports the loss and can be reopened, without a reload', async () => {
    const {coordinator, cli, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    board.detach();
    await flushAsync();

    // Tearing the CLI down over a dead link must not throw and must not
    // hang; it must simply end.
    await cli.exitWithoutSave();
    expect(cli.getPhase()).toBe('IDLE');
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');

    const reconnected = new FakeUsbBoard(SESSION_ID);
    coordinator.openSession(
      reconnected as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();
    expect(screenReadiness(coordinator).motorTest).toBe('CAN_OPEN');
  });
});

/* ==================================================================== *
 * THE HAND-OFF: `save` DECLARES ITS OWN REBOOT
 * ==================================================================== */

describe('a CLI save declares the reboot before it causes it', () => {
  /**
   * THE FIX, AT ITS NARROWEST POINT.
   *
   * Everything downstream - the redirect landing without
   * `afterSessionLoss`, the workspace reconnecting on its own, the
   * operator not being asked to press Connect after pressing Save -
   * depends on this one call happening, and happening BEFORE the bytes go
   * out. A link that dies between the write and the next statement would
   * otherwise be indistinguishable from a cable coming out.
   */
  it('records the expectation, so the loss is recognised as ours', async () => {
    const {cli, coordinator, recovery} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    expect(recovery.getPhase().kind).toBe('IDLE');
    await cli.begin(key);
    await cli.saveAndClose();
    await flushAsync();

    // The session did end - and it ended EXPECTEDLY.
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    expect(recovery.noteSessionLost(SESSION_ID)).toBe(true);
    expect(recovery.shouldReconnectAutomatically()).toBe(true);
  });

  it('does NOT declare a reboot for an ordinary exit', async () => {
    // `exit` leaves CLI without saving and without rebooting, so a loss
    // afterwards is a genuine fault and must be treated as one.
    const {cli, coordinator, recovery} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    await cli.exitWithoutSave();

    expect(recovery.getPhase().kind).toBe('IDLE');
    expect(recovery.noteSessionLost(SESSION_ID)).toBe(false);
  });

  it('does not declare a reboot for a save it refuses to send', async () => {
    // A session that saw a CLI error must not send `save` at all - and
    // must therefore not tell the app to expect a reboot either.
    const {cli, coordinator, recovery, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    const rejected = await cli.execute('set bogus = 1');
    expect(rejected.error).toBe(true);

    // The controller refuses to send `save` at all after an error.
    await expect(cli.saveAndClose()).rejects.toThrow(/لن يُرسل save/);
    expect(recovery.getPhase().kind).toBe('IDLE');
    expect(board.cliCommands).not.toContain('save');
    await cli.exitWithoutSave();
  });
});

/* ==================================================================== *
 * NAVIGATION / SESSION STRESS
 * ==================================================================== */

describe('a long run through the app leaves nothing behind', () => {
  /**
   * The sequence a real bench session actually looks like, repeated until
   * a leak would show. What is being hunted here is cumulative damage:
   * a lease released once but not the second time, a capability that
   * survives one rebuild but not three, an epoch that stops advancing.
   *
   * Every round asserts the SAME things, so a failure names the round it
   * first appeared in rather than just "something is wrong at the end".
   */
  it('survives five rounds of screen -> CLI -> save -> rebuild -> screen', async () => {
    const coordinator = new MspSessionCoordinator();
    OPENED.push(coordinator);
    const recovery = new FcRebootRecovery();
    let board = new FakeUsbBoard(SESSION_ID);
    coordinator.openSession(
      board as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();

    const generations: number[] = [];

    for (let round = 1; round <= 5; round += 1) {
      const label = `round ${round}`;

      // ---- a configuration screen reads -----------------------------
      expect(`${label} read`).toBe(`${label} ${await canScreenRead(coordinator) === 'LOADED' ? 'read' : await canScreenRead(coordinator)}`);

      // ---- the motor-test session can be opened and given back ------
      expect(`${label} motors`).toBe(
        `${label} ${canOpenMotorTestSession(coordinator) === 'CAN_OPEN' ? 'motors' : canOpenMotorTestSession(coordinator)}`,
      );

      // ---- CLI, with a save that reboots the board ------------------
      const key = coordinator.getSessionKey(SESSION_ID);
      if (key === undefined) throw new Error(`${label}: no session key`);
      generations.push(key.generation);

      const cli = new RawCliSessionController({
        coordinator,
        appStatePhase: () => 'ACTIVE',
        motorTestActive: () => false,
        rebootRecovery: recovery,
      });
      await cli.begin(key);
      await cli.execute('set motor_poles = 14');
      await cli.saveAndClose();
      await flushAsync();

      expect(`${label} cli idle`).toBe(`${label} ${cli.getPhase() === 'IDLE' ? 'cli idle' : cli.getPhase()}`);
      expect(`${label} expected`).toBe(
        `${label} ${recovery.noteSessionLost(SESSION_ID) ? 'expected' : 'UNEXPECTED'}`,
      );

      // ---- the board comes back and the shell rebuilds the session --
      recovery.noteReconnecting();
      board = new FakeUsbBoard(SESSION_ID);
      coordinator.openSession(
        board as unknown as UsbSerialTransportClient,
        SESSION_ID,
      );
      await flushAsync();
      recovery.noteRecovered();
      recovery.reset();
    }

    // Every rebuild produced a genuinely new physical generation, so no
    // screen holding an old key could ever have written to a new board.
    expect(new Set(generations).size).toBe(generations.length);

    // And the app is still fully usable at the end of all of it.
    expect(await canScreenRead(coordinator)).toBe('LOADED');
    expect(canOpenMotorTestSession(coordinator)).toBe('CAN_OPEN');
  });
});

/* ==================================================================== *
 * THE ZOMBIE: A DEAD BOARD THAT NEVER FIRED A DETACH
 * ==================================================================== */

describe('a board that reboots WITHOUT a detach event', () => {
  /**
   * WHY THIS CASE EXISTS AT ALL.
   *
   * On Android the native layer reports the USB device going away, and
   * everything downstream follows from that event. Web Serial gives no
   * such guarantee: a port object can stay open across a device
   * re-enumeration, so a `save` reboot can leave the application holding
   * a port that is present, writable, and answering nothing.
   *
   * That is the worst shape a connection can take, because every check
   * the app makes says yes. This test does not assume the app handles it
   * - it MEASURES what the app currently believes while the board is
   * silent, so the answer is a fact rather than a hope.
   */
  it('declares the session dead once the link stops answering', async () => {
    const {coordinator, cli, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    await cli.begin(key);
    await cli.execute('set motor_poles = 14');

    // The board reboots and answers nothing more - and, crucially, fires
    // NO detach. `rebooted` makes writeBytes a silent no-op; the detach
    // listeners are deliberately not called.
    board.rebooted = true;
    board.inCliMode = false;
    await cli.exitWithoutSave();

    // Enough failed dispatches in a row for the verdict to land. Nothing
    // new polls here: these are the telemetry dispatches the session was
    // already making, failing against a board that is gone.
    await driveFailedDispatches(coordinator);

    expect({
      ownership: coordinator.getOwnershipState(SESSION_ID),
      hasKey: coordinator.getSessionKey(SESSION_ID) !== undefined,
      capability: readMotorTestCapability(SESSION_ID) === undefined,
    }).toEqual({
      ownership: 'INACTIVE',
      hasKey: false,
      capability: true,
    });
  }, 30_000);

  it('does NOT end the session for a single transient failure', async () => {
    // The bound exists precisely so one dropped packet cannot end a
    // flight controller session. This is the half of the contract that a
    // too-eager verdict would break.
    const {coordinator} = await liveRig();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    if (scheduler === undefined) throw new Error('no scheduler');

    await driveFailedDispatches(
      coordinator,
      LINK_DEAD_AFTER_CONSECUTIVE_FAILURES - 1,
    );

    expect({
      failures: scheduler.getConsecutiveLinkFailureCount(),
      ownership: coordinator.getOwnershipState(SESSION_ID),
      hasKey: coordinator.getSessionKey(SESSION_ID) !== undefined,
    }).toEqual({
      failures: LINK_DEAD_AFTER_CONSECUTIVE_FAILURES - 1,
      ownership: 'ACTIVE',
      hasKey: true,
    });
  }, 30_000);

  /**
   * The RESET half of the contract - that any success zeroes the count,
   * so a flaky link is never mistaken for a dead one - is proven
   * deterministically at the scheduler, in
   * MspTelemetryScheduler.test.ts ("consecutive dispatch failures").
   * Reproducing it here would mean driving a real MspClient back out of
   * recovery, which measures recovery rather than the reset rule.
   */
  it('tears the session down exactly once, however many failures follow', async () => {
    const {coordinator} = await liveRig();
    let inactiveNotifications = 0;
    coordinator.subscribeOwnershipState(() => {
      if (coordinator.getOwnershipState(SESSION_ID) === 'INACTIVE') {
        inactiveNotifications += 1;
      }
    });

    await driveFailedDispatches(coordinator, LINK_DEAD_AFTER_CONSECUTIVE_FAILURES + 4);

    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    // One transition to INACTIVE, not one per failed dispatch.
    expect(inactiveNotifications).toBe(1);
  }, 30_000);

  it('recovers into a usable session after the zombie is detected', async () => {
    const {coordinator, cli, board, recovery} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');
    const deadGeneration = key.generation;

    await cli.begin(key);
    recovery.expectReboot(SESSION_ID, 'CLI_SAVE');
    board.rebooted = true;
    board.inCliMode = false;
    await cli.exitWithoutSave();
    await driveFailedDispatches(coordinator);

    // The loss is recognised as the reboot we asked for, so the shell
    // reconnects on its own rather than stamping it as a fault.
    expect(recovery.noteSessionLost(SESSION_ID)).toBe(true);
    expect(recovery.shouldReconnectAutomatically()).toBe(true);

    const reconnected = new FakeUsbBoard(SESSION_ID);
    coordinator.openSession(
      reconnected as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();
    recovery.noteRecovered();

    expect(coordinator.getSessionKey(SESSION_ID)?.generation).not.toBe(
      deadGeneration,
    );
    expect(await canScreenRead(coordinator)).toBe('LOADED');
    expect(canOpenMotorTestSession(coordinator)).toBe('CAN_OPEN');
  }, 30_000);

  /**
   * AND THE CONSEQUENCE, stated as the thing a user would hit: a screen
   * asks the silent board for its settings and gets nothing back.
   *
   * The app is entitled to fail here - what it must NOT do is report
   * success, and what it must eventually do is stop claiming the session
   * is usable.
   */
  it('fails a screen read against the silent board rather than faking one', async () => {
    const {coordinator, board} = await liveRig();
    board.rebooted = true;

    const outcome = await canScreenRead(coordinator);
    expect(outcome).not.toBe('LOADED');
  }, 30_000);

  /**
   * A DIFFERENT BOARD IS A DIFFERENT BOARD.
   *
   * The dangerous version of "recovery" is one that hands the new link
   * the dead session's identity: a lease minted against the board that
   * vanished would then still be honoured against whatever is plugged in
   * now, and a Motors screen could spin a motor on hardware it never
   * opened a session with. So this pins the negative - nothing from the
   * dead session may be reusable - as well as the positive.
   */
  it('does not let a DIFFERENT flight controller inherit the dead session', async () => {
    const {coordinator, board} = await liveRig();
    const deadKey = coordinator.getSessionKey(SESSION_ID);
    const deadIdentity = coordinator.getMotorTestSessionIdentity(SESSION_ID);
    if (deadKey === undefined || deadIdentity === undefined) {
      throw new Error('no session to lose');
    }

    board.rebooted = true;
    await driveFailedDispatches(coordinator);
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');

    // Something else is plugged in - same transport session id (the OS
    // reused the port), genuinely different hardware.
    const otherBoard = new FakeUsbBoard(SESSION_ID);
    otherBoard.responses.set(
      MSP_BOARD_INFO,
      Uint8Array.from([
        ...ascii('OTHR'),
        ...u16le(0),
        0,
        0,
        ...pstring('TEST'),
        ...pstring('OtherBoard'),
        ...pstring('MTKS'),
        ...new Array(32).fill(0),
        0,
      ]),
    );
    coordinator.openSession(
      otherBoard as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();

    const freshKey = coordinator.getSessionKey(SESSION_ID);
    const freshIdentity = coordinator.getMotorTestSessionIdentity(SESSION_ID);
    expect(freshKey?.generation).not.toBe(deadKey.generation);
    expect(freshIdentity).not.toBe(deadIdentity);

    // The decisive one: a lease asked for under the DEAD identity is
    // refused against the live client, so nothing minted before the loss
    // can command the board that is there now.
    const client = coordinator.getActiveMspClient(SESSION_ID);
    if (client === undefined) throw new Error('no client after reconnect');
    const stale = acquireMotorTestLease({
      client,
      requestedIdentity: deadIdentity,
      readCurrentIdentity: () =>
        coordinator.getMotorTestSessionIdentity(SESSION_ID),
    });
    expect(stale.kind).not.toBe('ACQUIRED');
  }, 30_000);

  /**
   * RECOVERY IS NOT A MOTORS FEATURE.
   *
   * Every configuration screen refuses on the SAME session-level reasons
   * (DISCONNECTED / LINK_RECOVERING / IDENTIFYING), so those reasons are
   * exactly the right thing to assert on: while the board is a zombie
   * each screen must refuse for a session reason, and after the
   * reconnect none of them may. What each screen then does with the
   * bytes is its own test's business - the question here is only whether
   * the session still stands in the way.
   */
  it('makes Motors, PID, Ports and Receiver usable again after recovery', async () => {
    const {coordinator, board} = await liveRig();
    const key = coordinator.getSessionKey(SESSION_ID);
    if (key === undefined) throw new Error('no session key');

    const deps = {
      coordinator: coordinator as never,
      appStateOwner: {getPhase: () => 'ACTIVE' as const},
      isMotorOutputEngaged: () => false,
      isMotorTestActive: () => false,
    };
    /** Every screen's own gate, asked in its own controller. */
    const screenGates = async (sessionKey: {
      sessionId: string;
      generation: number;
    }) => ({
      motors: await new MotorConfigurationController(deps)
        .load(sessionKey.sessionId)
        .then(r => (r.kind === 'REJECTED' ? r.reason : r.kind)),
      pid: await new PidTuningController(deps)
        .load(sessionKey)
        .then(r => (r.kind === 'REJECTED' ? r.reason : r.kind)),
      ports: await new PortsConfigurationController(deps)
        .load(sessionKey)
        .then(r => (r.kind === 'REJECTED' ? r.reason : r.kind)),
      receiver: await new ReceiverConfigurationController(deps)
        .load(sessionKey)
        .then(r => (r.kind === 'REJECTED' ? r.reason : r.kind)),
    });
    const SESSION_REASONS = ['DISCONNECTED', 'LINK_RECOVERING', 'IDENTIFYING'];

    board.rebooted = true;
    await driveFailedDispatches(coordinator);
    const whileDead = await screenGates(key);
    for (const [screen, outcome] of Object.entries(whileDead)) {
      // Which session reason it is depends on how far the teardown has
      // unwound (the identification state resets too, so IDENTIFYING is
      // as correct an answer as DISCONNECTED). That it is a SESSION
      // reason at all is the claim: no screen may be admitted.
      expect(`${screen}:${SESSION_REASONS.includes(outcome)}`).toBe(
        `${screen}:true`,
      );
    }

    const reconnected = new FakeUsbBoard(SESSION_ID);
    coordinator.openSession(
      reconnected as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );
    await flushAsync();
    const freshKey = coordinator.getSessionKey(SESSION_ID);
    if (freshKey === undefined) throw new Error('no session after reconnect');

    const afterRecovery = await screenGates(freshKey);
    for (const [screen, outcome] of Object.entries(afterRecovery)) {
      expect(`${screen}:${SESSION_REASONS.includes(outcome)}`).toBe(
        `${screen}:false`,
      );
    }
    // And Motors, whose reads this fixture answers in full, goes all the
    // way to loaded data rather than merely past the gate.
    expect(afterRecovery.motors).toBe('LOADED');
  }, 30_000);
});
