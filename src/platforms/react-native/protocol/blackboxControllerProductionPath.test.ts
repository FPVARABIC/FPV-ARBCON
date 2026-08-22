/**
 * THE BLACKBOX CONTROLLER, DRIVEN THROUGH THE REAL STACK.
 *
 * A virtual flight controller answers real MSP frames over the real
 * MspSessionCoordinator; the controller under test is the production one.
 * Nothing about the controller is mocked - only the USB device is.
 *
 * The two facts this suite exists to hold down:
 *
 *   AN ACK IS NOT AN APPLY. Betaflight wraps MSP_SET_BLACKBOX_CONFIG in
 *   `if (blackboxMayEditConfig())` and, when that is false, consumes the
 *   frame, changes nothing and replies normally. FC_SILENT below behaves
 *   exactly that way, and the controller must catch it by readback and stop
 *   before EEPROM and before the reboot.
 *
 *   AN EEPROM ACK IS NOT PERSISTENCE. save() can never return success; only
 *   verifyPersistence(), against a session whose generation differs from the
 *   one the write happened on, can.
 *
 * Every expected payload is hand-written from the firmware serializers.
 */

import {
  BlackboxConfigurationController,
  BLACKBOX_ERASE_ABSOLUTE_DEADLINE_MS,
  BLACKBOX_ERASE_POLL_INTERVAL_MS,
  type BlackboxClock,
  type BlackboxOwnedDraft,
  type BlackboxSnapshot,
} from './BlackboxConfigurationController';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import type {
  UsbSerialDataEvent,
  UsbSerialTransportClient,
} from '../transport';

const MSP_API_VERSION = 1;
const MSP_FC_VARIANT = 2;
const MSP_BOARD_INFO = 4;
const MSP_FEATURE_CONFIG = 36;
const MSP_ADVANCED_CONFIG = 90;
const MSP_SET_ADVANCED_CONFIG = 91;
const MSP_DATAFLASH_SUMMARY = 70;
const MSP_DATAFLASH_ERASE = 72;
const MSP_SDCARD_SUMMARY = 79;
const MSP_BLACKBOX_CONFIG = 80;
const MSP_SET_BLACKBOX_CONFIG = 81;
const MSP_EEPROM_WRITE = 250;

const b = (...values: number[]): Uint8Array => Uint8Array.from(values);

/* ================================================================== *
 * HAND-WRITTEN FRAMES
 * ================================================================== */

/**
 * MSP_BLACKBOX_CONFIG. The legacy fields carry DELIBERATELY ODD values so a
 * save that substituted defaults instead of echoing them is visible.
 *   supported 1 · device · num 7 · denom 13 · pRatio 0x0135 (309) ·
 *   sampleRate · mask
 */
function blackboxFrame(options: {
  supported?: number;
  device: number;
  sampleRate: number;
  mask?: readonly number[];
}): Uint8Array {
  return b(
    options.supported ?? 1,
    options.device,
    7,
    13,
    0x35,
    0x01,
    options.sampleRate,
    ...(options.mask ?? [0, 0, 0, 0]),
  );
}

/**
 * MSP_ADVANCED_CONFIG, 20 bytes. Every unowned field is a distinctive value
 * so a stale-overwrite is unmistakable in an assertion.
 */
const ADVANCED_UNOWNED = {
  gyroSyncDenom: 17,
  pidProcessDenom: 4,
  useContinuousUpdate: 1,
  motorProtocol: 6,
  motorPwmRate: 0x01e0, // 480
  motorIdle: 0x0226, // 550
  gyroUse32kHz: 0,
  motorInversion: 1,
  gyroToUse: 2,
  gyroHighFsr: 1,
  gyroMovementCalibrationThreshold: 203,
  gyroCalibrationDuration: 0x007d, // 125
  gyroYawOffset: -1234,
  checkOverflow: 1,
  debugModeCount: 60,
} as const;

function advancedFrame(debugMode: number): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, ADVANCED_UNOWNED.gyroSyncDenom);
  view.setUint8(1, ADVANCED_UNOWNED.pidProcessDenom);
  view.setUint8(2, ADVANCED_UNOWNED.useContinuousUpdate);
  view.setUint8(3, ADVANCED_UNOWNED.motorProtocol);
  view.setUint16(4, ADVANCED_UNOWNED.motorPwmRate, true);
  view.setUint16(6, ADVANCED_UNOWNED.motorIdle, true);
  view.setUint8(8, ADVANCED_UNOWNED.gyroUse32kHz);
  view.setUint8(9, ADVANCED_UNOWNED.motorInversion);
  view.setUint8(10, ADVANCED_UNOWNED.gyroToUse);
  view.setUint8(11, ADVANCED_UNOWNED.gyroHighFsr);
  view.setUint8(12, ADVANCED_UNOWNED.gyroMovementCalibrationThreshold);
  view.setUint16(13, ADVANCED_UNOWNED.gyroCalibrationDuration, true);
  view.setInt16(15, ADVANCED_UNOWNED.gyroYawOffset, true);
  view.setUint8(17, ADVANCED_UNOWNED.checkOverflow);
  view.setUint8(18, debugMode);
  view.setUint8(19, ADVANCED_UNOWNED.debugModeCount);
  return bytes;
}

/** MSP_DATAFLASH_SUMMARY: flags, u32 sectors, u32 total, u32 used. */
function dataflashFrame(
  flags: number,
  total: readonly number[],
  used: readonly number[],
): Uint8Array {
  return b(flags, 0x00, 0x01, 0x00, 0x00, ...total, ...used);
}
const SIXTEEN_MIB = [0x00, 0x00, 0x00, 0x01] as const;
const EIGHT_MIB = [0x00, 0x00, 0x80, 0x00] as const;
const ZERO32 = [0x00, 0x00, 0x00, 0x00] as const;

/** MSP_SDCARD_SUMMARY: an unconfigured slot. */
const SD_UNCONFIGURED = b(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/** FEATURE mask with FEATURE_BLACKBOX (bit 19) set: 0x00080000. */
const FEATURE_WITH_BLACKBOX = b(0x00, 0x00, 0x08, 0x00);

/* ================================================================== *
 * THE VIRTUAL FLIGHT CONTROLLER
 * ================================================================== */

interface FcBehaviour {
  /** Ignore MSP_SET_BLACKBOX_CONFIG the way a logging board does. */
  readonly silentlyRejectBlackboxWrite?: boolean;
  readonly device?: number;
  readonly sampleRate?: number;
  readonly mask?: readonly number[];
  readonly debugMode?: number;
  readonly dataflash?: Uint8Array;
  /** Replaces the dataflash reply after the erase command is accepted. */
  readonly dataflashAfterErase?: readonly Uint8Array[];
}

class VirtualFc {
  readonly requested: number[] = [];
  readonly writes: {command: number; payload: number[]}[] = [];
  private device: number;
  private sampleRate: number;
  private mask: readonly number[];
  private debugMode: number;
  private dataflash: Uint8Array;
  private readonly afterErase: Uint8Array[];
  private erasing = false;
  private readonly listeners = new Set<(e: UsbSerialDataEvent) => void>();
  /** Set to make every later request behave as a dead link. */
  silent = false;

  constructor(
    readonly sessionId: string,
    private readonly behaviour: FcBehaviour = {},
  ) {
    this.device = behaviour.device ?? 1;
    this.sampleRate = behaviour.sampleRate ?? 1;
    this.mask = behaviour.mask ?? [0, 0, 0, 0];
    this.debugMode = behaviour.debugMode ?? 0;
    this.dataflash =
      behaviour.dataflash ?? dataflashFrame(0x03, SIXTEEN_MIB, EIGHT_MIB);
    this.afterErase = [...(behaviour.dataflashAfterErase ?? [])];
  }

  private reply(command: number, payload: Uint8Array): void {
    const frame = buildMspFrameBytes(command, payload, {
      wireFormat: 'v1',
      direction: 'response',
    });
    Promise.resolve().then(() => {
      for (const listener of Array.from(this.listeners)) {
        listener({sessionId: this.sessionId, dataBase64: bytesToBase64(frame)});
      }
    });
  }

  private handle(command: number, payload: Uint8Array): Uint8Array | undefined {
    switch (command) {
      case MSP_API_VERSION:
        return b(0, 1, 47);
      case MSP_FC_VARIANT:
        return b(66, 84, 70, 76);
      case MSP_BOARD_INFO:
        return b(
          83, 80, 66, 69, 0, 0, 0, 0,
          4, 83, 52, 48, 53,
          4, 83, 52, 48, 53,
          4, 83, 80, 66, 69,
          ...new Array(32).fill(0), 0,
        );
      case MSP_FEATURE_CONFIG:
        return FEATURE_WITH_BLACKBOX;
      case MSP_BLACKBOX_CONFIG:
        return blackboxFrame({
          device: this.device,
          sampleRate: this.sampleRate,
          mask: this.mask,
        });
      case MSP_SET_BLACKBOX_CONFIG:
        if (this.behaviour.silentlyRejectBlackboxWrite !== true) {
          this.device = payload[0];
          this.sampleRate = payload[5];
          this.mask = Array.from(payload.slice(6, 10));
        }
        // Either way, an ordinary success reply - as the firmware does.
        return new Uint8Array(0);
      case MSP_ADVANCED_CONFIG:
        return advancedFrame(this.debugMode);
      case MSP_SET_ADVANCED_CONFIG:
        this.debugMode = payload[18];
        return new Uint8Array(0);
      case MSP_DATAFLASH_SUMMARY:
        if (this.erasing && this.afterErase.length > 0) {
          const next = this.afterErase.shift();
          if (next !== undefined) this.dataflash = next;
        }
        return this.dataflash;
      case MSP_DATAFLASH_ERASE:
        this.erasing = true;
        return new Uint8Array(0);
      case MSP_SDCARD_SUMMARY:
        return SD_UNCONFIGURED;
      case MSP_EEPROM_WRITE:
        return new Uint8Array(0);
      default:
        return new Uint8Array(0);
    }
  }

  readonly client: UsbSerialTransportClient = {
    writeBytes: (_sessionId: string, dataBase64: string) => {
      if (this.silent) return Promise.resolve(undefined);
      const frame = base64ToBytes(dataBase64);
      const command = frame[4];
      const size = frame[3];
      const payload = frame.slice(5, 5 + size);
      this.requested.push(command);
      if (payload.length > 0) {
        this.writes.push({command, payload: Array.from(payload)});
      }
      const reply = this.handle(command, payload);
      if (reply !== undefined) this.reply(command, reply);
      return Promise.resolve(undefined);
    },
    onDataReceived: (listener: (e: UsbSerialDataEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    onSessionDetached: () => () => undefined,
    onDeviceDetached: () => () => undefined,
    onError: () => () => undefined,
    startReading: () => Promise.resolve(undefined),
    stopReading: () => Promise.resolve(undefined),
    closeSession: () => Promise.resolve(undefined),
  } as unknown as UsbSerialTransportClient;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A clock the tests drive, so a 120-second deadline costs no seconds. */
class FakeClock implements BlackboxClock {
  private current = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.current;
  }
  async sleep(ms: number, signal: {readonly cancelled: boolean}): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    if (signal.cancelled) return;
    /* Advance the VIRTUAL clock by the full interval but yield for a real
       macrotask, so a 120-second deadline costs milliseconds while a test
       can still cancel or drop the link part-way through. */
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

let sessionSeq = 0;

async function connect(behaviour: FcBehaviour = {}) {
  sessionSeq += 1;
  const sessionId = `blackbox-${sessionSeq}`;
  const fc = new VirtualFc(sessionId, behaviour);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(fc.client, sessionId);
  await sleep(400);
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) throw new Error('no session key after identification');
  return {fc, coordinator, sessionId, key};
}

function controllerFor(
  coordinator: MspSessionCoordinator,
  options: {
    readonly clock?: BlackboxClock;
    readonly reboots?: {sessionId: string; reason: string}[];
  } = {},
) {
  return new BlackboxConfigurationController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {
      expectReboot: (sessionId, reason) => {
        options.reboots?.push({sessionId, reason});
      },
    },
    clock: options.clock,
  });
}

const draftFrom = (
  snapshot: BlackboxSnapshot,
  over: Partial<BlackboxOwnedDraft> = {},
): BlackboxOwnedDraft => ({
  deviceRaw: snapshot.config.deviceRaw,
  sampleRateRaw: snapshot.config.sampleRateRaw,
  disabledFieldsMask: snapshot.config.disabledFieldsMask,
  debugMode: snapshot.debugMode,
  ...over,
});

/* ================================================================== *
 * LOAD
 * ================================================================== */

describe('loading blackbox state', () => {
  it('reads the five commands it needs and nothing it does not', async () => {
    const {fc, coordinator, key} = await connect();
    const loaded = await controllerFor(coordinator).load(key);
    expect(loaded.kind).toBe('LOADED');
    for (const command of [
      MSP_FEATURE_CONFIG,
      MSP_BLACKBOX_CONFIG,
      MSP_DATAFLASH_SUMMARY,
      MSP_SDCARD_SUMMARY,
      MSP_ADVANCED_CONFIG,
    ]) {
      expect([command, fc.requested.includes(command)]).toEqual([command, true]);
    }
    // Phase A proved the reference client loads MSP_SENSOR_CONFIG (55) here
    // and never reads it, and that MSP2_SENSOR_CONFIG_ACTIVE serves only the
    // virtual device we do not support. Neither is requested.
    expect(fc.requested).not.toContain(55);
  });

  it('separates firmware support, the feature flag and the storage states', async () => {
    const {coordinator, key} = await connect();
    const loaded = await controllerFor(coordinator).load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const s = loaded.snapshot;
    expect(s.config.supported).toBe(true); // the BUILD has Blackbox
    expect(s.blackboxFeatureEnabled).toBe(true); // FEATURE_BLACKBOX is on
    expect(s.configuration.device.device).toBe('FLASH'); // persisted device
    expect(s.dataflash.state).toBe('READY_WITH_DATA'); // storage truth
    expect(s.sdcard.configured).toBe(false); // no SD slot configured
    expect(s.sdcard.measurementsValid).toBe(false);
  });

  it('reports an unsupported build as a capability, not an error', async () => {
    const {coordinator, key} = await connect();
    // Force the all-zero !USE_BLACKBOX reply by reading a board that has it.
    const loaded = await controllerFor(coordinator).load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    // The FC above IS supported; the refusal is proven on the save path.
    const save = await controllerFor(coordinator).save(
      key,
      {...loaded.snapshot, config: {...loaded.snapshot.config, supported: false}},
      draftFrom(loaded.snapshot, {deviceRaw: 2}),
    );
    expect(save).toEqual({kind: 'REJECTED', reason: 'BLACKBOX_UNSUPPORTED'});
  });

  it('loads even when there is no flash and no SD card', async () => {
    const {coordinator, key} = await connect({
      dataflash: dataflashFrame(0x00, ZERO32, ZERO32),
    });
    const loaded = await controllerFor(coordinator).load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    expect(loaded.snapshot.dataflash.state).toBe('UNSUPPORTED');
    expect(loaded.snapshot.sdcard.configured).toBe(false);
    // Serial logging is still describable, so the load is not a failure.
    expect(loaded.snapshot.config.supported).toBe(true);
  });
});

/* ================================================================== *
 * SAVE
 * ================================================================== */

describe('saving blackbox configuration', () => {
  it('sends nothing at all when the draft matches what the board holds', async () => {
    const {fc, coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const before = fc.requested.length;
    const result = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot),
    );
    expect(result.kind).toBe('NO_CHANGES');
    expect(fc.requested.length).toBe(before);
    expect(fc.requested).not.toContain(MSP_SET_BLACKBOX_CONFIG);
    expect(fc.requested).not.toContain(MSP_EEPROM_WRITE);
  });

  it('P0: an ACK with no change is caught, and nothing is persisted', async () => {
    // THE DEFECT. The board answers MSP_SET_BLACKBOX_CONFIG normally and
    // changes nothing - exactly what blackboxMayEditConfig() === false does.
    const reboots: {sessionId: string; reason: string}[] = [];
    const {fc, coordinator, key} = await connect({
      silentlyRejectBlackboxWrite: true,
    });
    const controller = controllerFor(coordinator, {reboots});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);

    const result = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2}),
    );

    expect(result.kind).toBe('READBACK_MISMATCH');
    if (result.kind !== 'READBACK_MISMATCH') throw new Error('unreachable');
    expect(result.stage).toBe('BLACKBOX');
    expect(result.expected.deviceRaw).toBe(2);
    expect(result.observed.deviceRaw).toBe(1);

    // The write WAS sent and WAS acknowledged...
    expect(fc.requested).toContain(MSP_SET_BLACKBOX_CONFIG);
    // ...and nothing was persisted, and no reboot was requested.
    expect(fc.requested).not.toContain(MSP_EEPROM_WRITE);
    expect(fc.requested).not.toContain(MSP_SET_ADVANCED_CONFIG);
    expect(reboots).toEqual([]);
  });

  it('preserves the legacy blackbox fields it does not own', async () => {
    const {fc, coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {sampleRateRaw: 3}),
    );
    const write = fc.writes.find(w => w.command === MSP_SET_BLACKBOX_CONFIG);
    expect(write).toBeDefined();
    // device, num, denom, pRatio LE, sampleRate, mask LE - hand-written.
    // The odd 7 / 13 / 0x0135 are the board's; defaults would be 1/1/0.
    expect(write?.payload).toEqual([
      1, 7, 13, 0x35, 0x01, 3, 0, 0, 0, 0,
    ]);
  });

  it('preserves every advanced-config field except debugMode', async () => {
    const {fc, coordinator, key} = await connect({debugMode: 0});
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {debugMode: 42}),
    );
    const write = fc.writes.find(w => w.command === MSP_SET_ADVANCED_CONFIG);
    expect(write).toBeDefined();
    // Hand-written from the 19-byte MSP_SET_ADVANCED_CONFIG contract, with
    // the board's own distinctive values echoed back and byte 18 changed.
    expect(write?.payload).toEqual([
      17, 4, 1, 6,
      0xe0, 0x01,
      0x26, 0x02,
      0, 1, 2, 1, 203,
      0x7d, 0x00,
      0x2e, 0xfb, // -1234 little-endian signed
      1,
      42,
    ]);
  });

  it('reaches the reboot but never reports success on its own', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {fc, coordinator, key, sessionId} = await connect();
    const controller = controllerFor(coordinator, {reboots});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);

    const result = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2, debugMode: 42}),
    );

    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
    // The ordering is the contract: write, readback, advanced, eeprom.
    const order = fc.requested.filter(c =>
      [
        MSP_SET_BLACKBOX_CONFIG,
        MSP_BLACKBOX_CONFIG,
        MSP_SET_ADVANCED_CONFIG,
        MSP_EEPROM_WRITE,
      ].includes(c),
    );
    expect(order.indexOf(MSP_EEPROM_WRITE)).toBeGreaterThan(
      order.indexOf(MSP_SET_BLACKBOX_CONFIG),
    );
    expect(order.lastIndexOf(MSP_BLACKBOX_CONFIG)).toBeLessThan(
      order.indexOf(MSP_EEPROM_WRITE),
    );
    expect(reboots).toEqual([{sessionId, reason: 'CLI_SAVE'}]);
    // And no result shape in the union can be read as success here.
    expect(Object.keys(result)).not.toContain('snapshot');
  });

  it('refuses a device this build cannot name', async () => {
    const {fc, coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    // 4 is BLACKBOX_DEVICE_VIRTUAL, which exists on master only.
    const result = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 4}),
    );
    expect(result).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'});
    expect(fc.requested).not.toContain(MSP_SET_BLACKBOX_CONFIG);
  });

  it('lets an unmodelled value the board already had stay put', async () => {
    // Reading a newer board must not force a normalisation on save.
    const {coordinator, key} = await connect({device: 4});
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    expect(loaded.snapshot.configuration.device.device).toBe('UNKNOWN');
    const result = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {sampleRateRaw: 2}),
    );
    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
  });
});

/* ================================================================== *
 * PERSISTENCE VERIFICATION
 * ================================================================== */

describe('persistence verification', () => {
  it('refuses the session the write happened on', async () => {
    const {coordinator, key, sessionId} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const saved = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') throw new Error(saved.kind);

    // THE REGRESSION. The board never rebooted, so this key is the same
    // generation the write used. A readback here reads the RAM the write
    // already changed and proves nothing about EEPROM.
    const verified = await controller.verifyPersistence(key, saved.pending);
    expect(verified).toEqual({kind: 'STALE_SESSION'});
    expect(saved.pending.sessionId).toBe(sessionId);
  });

  it('succeeds only on a new session whose readback matches', async () => {
    const {coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const saved = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2, debugMode: 42}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') throw new Error(saved.kind);

    // A genuinely different generation - what a reboot produces.
    const rebooted = {...key, generation: key.generation + 1};
    const stubbed = new BlackboxConfigurationController({
      coordinator: {
        getOwnershipState: () => coordinator.getOwnershipState(key.sessionId),
        getIdentificationState: () =>
          coordinator.getIdentificationState(key.sessionId),
        getSessionKey: () => rebooted,
        getActiveMspClient: () => coordinator.getActiveMspClient(key.sessionId),
        getTelemetryScheduler: () =>
          coordinator.getTelemetryScheduler(key.sessionId),
        getMspRecoveryState: () =>
          coordinator.getMspRecoveryState(key.sessionId),
      },
      appStateOwner: {getPhase: () => 'ACTIVE'},
      rebootLifecycle: {expectReboot: () => undefined},
    });
    const verified = await stubbed.verifyPersistence(rebooted, saved.pending);
    expect(verified.kind).toBe('SUCCEEDED');
  });

  it('reports a persistence mismatch rather than success', async () => {
    const {coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const saved = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') throw new Error(saved.kind);

    const rebooted = {...key, generation: key.generation + 1};
    const stubbed = new BlackboxConfigurationController({
      coordinator: {
        getOwnershipState: () => coordinator.getOwnershipState(key.sessionId),
        getIdentificationState: () =>
          coordinator.getIdentificationState(key.sessionId),
        getSessionKey: () => rebooted,
        getActiveMspClient: () => coordinator.getActiveMspClient(key.sessionId),
        getTelemetryScheduler: () =>
          coordinator.getTelemetryScheduler(key.sessionId),
        getMspRecoveryState: () =>
          coordinator.getMspRecoveryState(key.sessionId),
      },
      appStateOwner: {getPhase: () => 'ACTIVE'},
      rebootLifecycle: {expectReboot: () => undefined},
    });
    // Pretend the board came back holding something else.
    const verified = await stubbed.verifyPersistence(rebooted, {
      ...saved.pending,
      expected: {...saved.pending.expected, deviceRaw: 3},
    });
    expect(verified.kind).toBe('PERSISTENCE_MISMATCH');
  });
});

/* ================================================================== *
 * ERASE
 * ================================================================== */

describe('erasing the onboard flash', () => {
  it('refuses when the PERSISTED device is not flash', async () => {
    // The operator may have selected FLASH in a draft, but the firmware
    // switches on the saved device and would erase nothing.
    const {fc, coordinator, key} = await connect({device: 2});
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const outcome = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(outcome).toEqual({kind: 'REFUSED', reason: 'DEVICE_NOT_FLASH'});
    expect(fc.requested).not.toContain(MSP_DATAFLASH_ERASE);
  });

  it('refuses an already-empty volume', async () => {
    const {fc, coordinator, key} = await connect({
      dataflash: dataflashFrame(0x03, SIXTEEN_MIB, ZERO32),
    });
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const outcome = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(outcome).toEqual({kind: 'REFUSED', reason: 'ALREADY_EMPTY'});
    expect(fc.requested).not.toContain(MSP_DATAFLASH_ERASE);
  });

  it('refuses a board with no flash at all', async () => {
    const {fc, coordinator, key} = await connect({
      dataflash: dataflashFrame(0x00, ZERO32, ZERO32),
    });
    const controller = controllerFor(coordinator);
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const outcome = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(outcome).toEqual({kind: 'REFUSED', reason: 'DATAFLASH_UNSUPPORTED'});
    expect(fc.requested).not.toContain(MSP_DATAFLASH_ERASE);
  });

  it('succeeds only when the volume reports READY with nothing stored', async () => {
    const clock = new FakeClock();
    const {fc, coordinator, key} = await connect({
      dataflashAfterErase: [
        // Mid-erase: supported, NOT ready. Not empty, not a failure.
        dataflashFrame(0x02, SIXTEEN_MIB, EIGHT_MIB),
        dataflashFrame(0x02, SIXTEEN_MIB, EIGHT_MIB),
        // Ready again but still holding data - still not done.
        dataflashFrame(0x03, SIXTEEN_MIB, EIGHT_MIB),
        // Done.
        dataflashFrame(0x03, SIXTEEN_MIB, ZERO32),
      ],
    });
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const outcome = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(outcome.kind).toBe('SUCCEEDED');
    if (outcome.kind !== 'SUCCEEDED') throw new Error('unreachable');
    expect(outcome.dataflash.state).toBe('READY_EMPTY');
    expect(fc.requested).toContain(MSP_DATAFLASH_ERASE);
    // Four polls at the published interval, and no invented cadence.
    expect(clock.sleeps.every(ms => ms === BLACKBOX_ERASE_POLL_INTERVAL_MS)).toBe(
      true,
    );
  });

  it('ends at the absolute deadline instead of polling forever', async () => {
    const clock = new FakeClock();
    const {coordinator, key} = await connect({
      // Never becomes empty.
      dataflashAfterErase: [],
    });
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const outcome = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(outcome.kind).toBe('TIMED_OUT');
    if (outcome.kind !== 'TIMED_OUT') throw new Error('unreachable');
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
      BLACKBOX_ERASE_ABSOLUTE_DEADLINE_MS,
    );
    // The deadline bounds the OPERATION, so the poll count is finite.
    expect(clock.sleeps.length).toBeLessThanOrEqual(
      BLACKBOX_ERASE_ABSOLUTE_DEADLINE_MS / BLACKBOX_ERASE_POLL_INTERVAL_MS + 1,
    );
  });

  it('cancelling stops the watch and never claims the board stopped', async () => {
    const clock = new FakeClock();
    const {coordinator, key} = await connect({dataflashAfterErase: []});
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const observation = controller.eraseDataflash(key, loaded.snapshot);
    await sleep(20);
    observation.cancel();
    const outcome = await observation.result;
    expect(outcome).toEqual({
      kind: 'OBSERVATION_CANCELLED',
      boardMayStillBeErasing: true,
    });
    // A late poll after cancellation cannot change the settled result.
    const settled = await observation.result;
    expect(settled.kind).toBe('OBSERVATION_CANCELLED');
  });

  it('reports a lost link as a lost link, not as a finished erase', async () => {
    const clock = new FakeClock();
    const {fc, coordinator, key, sessionId} = await connect({
      dataflashAfterErase: [dataflashFrame(0x02, SIXTEEN_MIB, EIGHT_MIB)],
    });
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const observation = controller.eraseDataflash(key, loaded.snapshot);
    await sleep(20);
    fc.silent = true;
    await coordinator.deactivateMspSession?.(sessionId);
    const outcome = await observation.result;
    expect(['LINK_LOST', 'OBSERVATION_CANCELLED']).toContain(outcome.kind);
    expect(outcome.kind).not.toBe('SUCCEEDED');
  });

  it('refuses a second operation while one is running', async () => {
    const clock = new FakeClock();
    const {coordinator, key} = await connect({dataflashAfterErase: []});
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    const first = controller.eraseDataflash(key, loaded.snapshot);
    await sleep(10);
    const second = await controller.eraseDataflash(key, loaded.snapshot).result;
    expect(second).toEqual({
      kind: 'REJECTED',
      reason: 'OPERATION_IN_PROGRESS',
    });
    const concurrentSave = await controller.save(
      key,
      loaded.snapshot,
      draftFrom(loaded.snapshot, {deviceRaw: 2}),
    );
    expect(concurrentSave).toEqual({
      kind: 'REJECTED',
      reason: 'OPERATION_IN_PROGRESS',
    });
    first.cancel();
    await first.result;
    // ...and ownership is released, so the next operation is allowed.
    const afterwards = await controller.load(key);
    expect(afterwards.kind).toBe('LOADED');
  });

  it('releases ownership after every terminal path', async () => {
    const clock = new FakeClock();
    const {coordinator, key} = await connect({
      dataflashAfterErase: [dataflashFrame(0x03, SIXTEEN_MIB, ZERO32)],
    });
    const controller = controllerFor(coordinator, {clock});
    const loaded = await controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    // SUCCEEDED
    await controller.eraseDataflash(key, loaded.snapshot).result;
    expect((await controller.load(key)).kind).toBe('LOADED');
    // REFUSED - never took ownership at all
    await controller.eraseDataflash(key, {
      ...loaded.snapshot,
      dataflash: {...loaded.snapshot.dataflash, state: 'READY_EMPTY'},
    }).result;
    expect((await controller.load(key)).kind).toBe('LOADED');
    // NO_CHANGES
    await controller.save(key, loaded.snapshot, draftFrom(loaded.snapshot));
    expect((await controller.load(key)).kind).toBe('LOADED');
  });
});
