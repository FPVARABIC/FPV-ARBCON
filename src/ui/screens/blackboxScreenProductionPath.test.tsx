/**
 * THE SCREEN, THE CONTROLLER AND A BOARD ON THE WIRE.
 *
 * Nothing is stubbed between the rendered tree and the MSP frames: the
 * real BlackboxConfigurationController drives the real
 * MspSessionCoordinator against a virtual flight controller that answers
 * hand-written payloads. Only the USB device is imaginary.
 *
 * TWO WHOLE JOURNEYS, both of them the ones that can lie:
 *
 *   THE SAVE. Change a setting, watch it go out, watch it read back,
 *   watch EEPROM, watch the reboot, come back on a NEW session, and only
 *   then see «تم الحفظ». The assertion that matters is the one taken at
 *   every earlier step: no success anywhere before the final readback.
 *
 *   THE ERASE. Confirm, send, and then watch a volume go not-ready, then
 *   ready-but-still-full, then empty. The screen must stay busy through
 *   the first two - an acknowledgement is not an erased chip, and neither
 *   is a volume that has merely become readable again.
 *
 * THE VIRTUAL BOARD IS WRITTEN INDEPENDENTLY of the controller suite's
 * one, on purpose. A single shared fixture is a single place to
 * accidentally relax when a test goes red.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {
  base64ToBytes,
  bytesToBase64,
} from '../../platforms/react-native/protocol/base64';
import {MspSessionCoordinator} from '../../platforms/react-native/protocol/MspSessionCoordinator';
import {BlackboxConfigurationController} from '../../platforms/react-native/protocol/BlackboxConfigurationController';
import type {
  UsbSerialDataEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {blackboxPendingSave} from '../session/blackboxPendingSave';
import BlackboxScreen from './BlackboxScreen';

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

afterEach(() => {
  blackboxPendingSave.clear();
});

/* ================================================================== *
 * COMMANDS - the numbers, written out rather than imported, so this
 * file states the contract instead of agreeing with it.
 * ================================================================== */

const MSP_API_VERSION = 1;
const MSP_FC_VARIANT = 2;
const MSP_BOARD_INFO = 4;
const MSP_FEATURE_CONFIG = 36;
const MSP_DATAFLASH_SUMMARY = 70;
const MSP_DATAFLASH_ERASE = 72;
const MSP_SDCARD_SUMMARY = 79;
const MSP_BLACKBOX_CONFIG = 80;
const MSP_SET_BLACKBOX_CONFIG = 81;
const MSP_ADVANCED_CONFIG = 90;
const MSP_SET_ADVANCED_CONFIG = 91;
const MSP_EEPROM_WRITE = 250;

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/* ------------------------------------------------------------------ *
 * PAYLOADS, hand-written from the firmware serializers.
 * ------------------------------------------------------------------ */

/**
 * MSP_BLACKBOX_CONFIG, 11 bytes:
 *   supported · device · legacy num · legacy denom · u16 pRatio ·
 *   sampleRate · u32 fields_disabled_mask
 *
 * The legacy values are deliberately unusual (num 3, denom 11,
 * pRatio 0x0208 = 520) so a save that substituted defaults instead of
 * echoing the board's own values shows up in the recorded write.
 */
const blackboxConfigFrame = (device: number, sampleRate: number): Uint8Array =>
  bytes(1, device, 3, 11, 0x08, 0x02, sampleRate, 0, 0, 0, 0);

/** MSP_DATAFLASH_SUMMARY, 13 bytes: flags · u32 sectors · u32 total · u32 used. */
const dataflashFrame = (
  flags: number,
  total: readonly number[],
  used: readonly number[],
): Uint8Array => bytes(flags, 0x00, 0x02, 0x00, 0x00, ...total, ...used);

/** 16 MiB = 0x01000000, little-endian. */
const SIXTEEN_MIB = [0x00, 0x00, 0x00, 0x01] as const;
/** 4 MiB = 0x00400000. */
const FOUR_MIB = [0x00, 0x00, 0x40, 0x00] as const;
const ZERO32 = [0x00, 0x00, 0x00, 0x00] as const;
/** MSP_FLASHFS_FLAG_READY | MSP_FLASHFS_FLAG_SUPPORTED. */
const FLASH_READY = 0x03;
/** SUPPORTED without READY - a volume mid-operation. */
const FLASH_BUSY = 0x02;

/** MSP_SDCARD_SUMMARY, 11 bytes. An unconfigured slot. */
const SD_UNCONFIGURED = bytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/**
 * MSP_FEATURE_CONFIG as a REAL board answers it.
 *
 * FEATURE_OSD (1 << 18) and FEATURE_AIRMODE (1 << 22): 0x00440000,
 * little-endian. There is deliberately no blackbox bit here, because
 * `features_e` in src/main/config/feature.h has none - see the test
 * below.
 */
const REALISTIC_FEATURE_MASK = bytes(0x00, 0x00, 0x44, 0x00);

/** MSP_ADVANCED_CONFIG, 20 bytes, with distinctive unowned values. */
function advancedFrame(debugMode: number): Uint8Array {
  const frame = new Uint8Array(20);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 8); // gyro sync denom (deprecated)
  view.setUint8(1, 2); // pid process denom
  view.setUint8(2, 1);
  view.setUint8(3, 5); // motor protocol
  view.setUint16(4, 480, true);
  view.setUint16(6, 550, true);
  view.setUint8(8, 0);
  view.setUint8(9, 0);
  view.setUint8(10, 1);
  view.setUint8(11, 0);
  view.setUint8(12, 41);
  view.setUint16(13, 125, true);
  view.setInt16(15, -300, true);
  view.setUint8(17, 1);
  view.setUint8(18, debugMode);
  view.setUint8(19, 60); // DEBUG_COUNT - read-only
  return frame;
}

/* ================================================================== *
 * THE VIRTUAL BOARD
 * ================================================================== */

interface BoardOptions {
  readonly device?: number;
  readonly sampleRate?: number;
  readonly debugMode?: number;
  readonly dataflash?: Uint8Array;
  /** Replies handed out, in order, once the erase command is accepted. */
  readonly dataflashAfterErase?: readonly Uint8Array[];
}

class VirtualBoard {
  readonly requested: number[] = [];
  readonly writes: {command: number; payload: number[]}[] = [];
  private device: number;
  private sampleRate: number;
  private debugMode: number;
  private dataflash: Uint8Array;
  private readonly afterErase: Uint8Array[];
  private erasing = false;
  private readonly listeners = new Set<(event: UsbSerialDataEvent) => void>();

  constructor(readonly sessionId: string, options: BoardOptions = {}) {
    this.device = options.device ?? 1;
    this.sampleRate = options.sampleRate ?? 0;
    this.debugMode = options.debugMode ?? 0;
    this.dataflash =
      options.dataflash ?? dataflashFrame(FLASH_READY, SIXTEEN_MIB, FOUR_MIB);
    this.afterErase = [...(options.dataflashAfterErase ?? [])];
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

  private handle(command: number, payload: Uint8Array): Uint8Array {
    switch (command) {
      case MSP_API_VERSION:
        return bytes(0, 1, 47);
      case MSP_FC_VARIANT:
        return bytes(66, 84, 70, 76);
      case MSP_BOARD_INFO:
        return bytes(
          83, 80, 66, 69, 0, 0, 0, 0,
          4, 83, 52, 48, 53,
          4, 83, 52, 48, 53,
          4, 83, 80, 66, 69,
          ...new Array(32).fill(0), 0,
        );
      case MSP_FEATURE_CONFIG:
        return REALISTIC_FEATURE_MASK;
      case MSP_BLACKBOX_CONFIG:
        return blackboxConfigFrame(this.device, this.sampleRate);
      case MSP_SET_BLACKBOX_CONFIG:
        this.device = payload[0];
        this.sampleRate = payload[5];
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
      const frame = base64ToBytes(dataBase64);
      const command = frame[4];
      const size = frame[3];
      const payload = frame.slice(5, 5 + size);
      this.requested.push(command);
      if (payload.length > 0) {
        this.writes.push({command, payload: Array.from(payload)});
      }
      this.reply(command, this.handle(command, payload));
      return Promise.resolve(undefined);
    },
    onDataReceived: (listener: (event: UsbSerialDataEvent) => void) => {
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * THE 500 ms ERASE POLL, HELD OPEN UNTIL THE TEST RELEASES IT.
 *
 * A clock that merely advanced instantly would let the whole erase finish
 * inside one await, and every intermediate state - not-ready, then
 * ready-but-still-full - would go past unobserved. The point of the test
 * is precisely that the screen must not call either of those a success,
 * so each poll is gated: `tick()` releases exactly one.
 */
class GatedClock {
  private current = 0;
  readonly sleeps: number[] = [];
  private readonly waiting: (() => void)[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number, signal: {readonly cancelled: boolean}): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    if (signal.cancelled) return;
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  /** Release one held poll, and let its request settle. */
  async tick(): Promise<void> {
    const next = this.waiting.shift();
    next?.();
    await sleep(40);
  }

  get held(): number {
    return this.waiting.length;
  }
}

let boardSeq = 0;

async function bringUpBoard(options: BoardOptions = {}) {
  boardSeq += 1;
  const sessionId = `bb-ui-${boardSeq}`;
  const board = new VirtualBoard(sessionId, options);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(board.client, sessionId);
  await sleep(400);
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) throw new Error('the board never identified');
  return {board, coordinator, sessionId, key};
}

function controllerOn(
  coordinator: MspSessionCoordinator,
  options: {clock?: GatedClock; reboots?: string[]} = {},
) {
  return new BlackboxConfigurationController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {
      expectReboot: sessionId => options.reboots?.push(sessionId),
    },
    clock: options.clock,
  });
}

/* ------------------------------------------------------------------ *
 * RENDERING HELPERS
 * ------------------------------------------------------------------ */

/**
 * Text inside ONE testID subtree - so a negative assertion cannot be
 * satisfied (or defeated) by an unrelated part of the page.
 *
 * It walks the RENDERED JSON, which is the host tree only. Walking test
 * INSTANCES instead reports every string twice, because a composite and
 * the host it renders both carry the same testID; walking ELEMENTS misses
 * the words inside a composite child entirely (a Button keeps its label
 * in a prop). The rendered JSON has neither problem.
 */
interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: unknown;
}

function textIn(tree: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const locate = (node: unknown): RenderedNode | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = locate(child);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== 'object') return undefined;
    const shape = node as RenderedNode;
    if ((shape.props as {testID?: string} | undefined)?.testID === testID) {
      return shape;
    }
    return locate(shape.children);
  };
  const found = locate(tree.toJSON());
  if (found === undefined) return '';
  const out: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (node !== null && typeof node === 'object') {
      collect((node as RenderedNode).children);
    }
  };
  collect(found.children);
  return out.join(' ');
}

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === 'object') {
      visit((node as {children?: unknown}).children);
    }
  };
  visit(tree.toJSON());
  return out.join(' ');
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({testID}).length > 0;

function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onPress === 'function');
  if (node === undefined) throw new Error(`No pressable ${testID}`);
  act(() => {
    node.props.onPress();
  });
}

function selectOption(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  key: string,
): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onSelect === 'function');
  if (node === undefined) throw new Error(`No selector ${testID}`);
  act(() => {
    node.props.onSelect(key);
  });
}

async function mount(
  controller: BlackboxConfigurationController,
  key: {sessionId: string; generation: number},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <BlackboxScreen sessionKey={key} active controller={controller} />,
    );
    await sleep(60);
  });
  await act(async () => {
    await sleep(60);
  });
  return tree;
}

/* ================================================================== *
 * THE FEATURE BIT THAT DOES NOT EXIST
 * ================================================================== */

describe('the "is logging enabled" question', () => {
  /**
   * P0, AND IT WAS OURS.
   *
   * B-3 read MSP_FEATURE_CONFIG and reported bit 19 as FEATURE_BLACKBOX.
   * There is no such feature. `features_e` in src/main/config/feature.h
   * at BOTH pinned revisions goes ... FEATURE_OSD = 1 << 18,
   * FEATURE_CHANNEL_FORWARDING = 1 << 20 ... - bit 19 is an unused gap,
   * and no member of that enum mentions blackbox at all. blackbox.c
   * never calls featureIsEnabled() for itself either; the only feature it
   * consults is FEATURE_GPS, for the GPS field.
   *
   * Betaflight gates logging on the CONFIGURED DEVICE and nothing else:
   * a destination of BLACKBOX_DEVICE_NONE means nothing is written, and
   * any other value means it is.
   *
   * So the screen was reading a bit that means nothing, and would have
   * told every operator of every real board that their logging was
   * switched off - beside a flash chip with logs on it.
   *
   * This board answers with a realistic mask (OSD + airmode, no bit 19)
   * and a persisted FLASH destination, which is a board that logs.
   */
  it('never calls logging disabled on a board that has a destination set', async () => {
    const {coordinator, key} = await bringUpBoard({device: 1});
    const controller = controllerOn(coordinator);
    const tree = await mount(controller, key);
    expect(has(tree, 'blackbox-feature-disabled')).toBe(false);
    expect(textOf(tree)).not.toContain(ar.blackbox.featureDisabled);
    act(() => tree.unmount());
  }, 30000);

  it('says nothing is being logged when the destination IS none', async () => {
    const {coordinator, key} = await bringUpBoard({device: 0});
    const controller = controllerOn(coordinator);
    const tree = await mount(controller, key);
    // The truthful statement, and it comes from the device byte.
    expect(has(tree, 'blackbox-feature-disabled')).toBe(true);
    expect(textIn(tree, 'blackbox-persisted-device')).toContain(
      ar.blackbox.device.NONE,
    );
    act(() => tree.unmount());
  }, 30000);

  it('asks the board for nothing it cannot interpret', async () => {
    const {board, coordinator, key} = await bringUpBoard({device: 1});
    const controller = controllerOn(coordinator);
    const tree = await mount(controller, key);
    // MSP_FEATURE_CONFIG is not read: there is nothing in it this screen
    // can say anything true about.
    const afterIdentify = board.requested.filter(
      command => command === MSP_FEATURE_CONFIG,
    );
    expect(afterIdentify).toEqual([]);
    act(() => tree.unmount());
  }, 30000);
});

/* ================================================================== *
 * §49 - THE WHOLE SAVE, ON A REAL SESSION
 * ================================================================== */

describe('saving through the production path', () => {
  it('reaches «تم الحفظ» only after a readback on a NEW session', async () => {
    const reboots: string[] = [];
    const {board, coordinator, sessionId, key} = await bringUpBoard({
      device: 1,
      sampleRate: 0,
    });
    const controller = controllerOn(coordinator, {reboots});
    const tree = await mount(controller, key);

    // The board's own values are what the screen opened with.
    expect(textIn(tree, 'blackbox-persisted-device')).toContain(
      ar.blackbox.device.FLASH,
    );

    // Change BOTH owned wire fields.
    selectOption(tree, 'blackbox-device-select', '2');
    selectOption(tree, 'blackbox-rate-select', '2');
    // Still nothing claimed.
    expect(textOf(tree)).not.toContain(ar.blackbox.outcome.saved);

    await act(async () => {
      press(tree, 'blackbox-save-bar-save');
      await sleep(200);
    });

    // The wire tells the story: write, readback, EEPROM - in that order.
    const setIndex = board.requested.indexOf(MSP_SET_BLACKBOX_CONFIG);
    const eepromIndex = board.requested.indexOf(MSP_EEPROM_WRITE);
    expect(setIndex).toBeGreaterThan(-1);
    expect(eepromIndex).toBeGreaterThan(setIndex);
    // A readback sits BETWEEN them. That is the whole point.
    expect(
      board.requested.slice(setIndex + 1, eepromIndex),
    ).toContain(MSP_BLACKBOX_CONFIG);

    // The write echoed the board's own legacy fields rather than defaults.
    const write = board.writes.find(
      entry => entry.command === MSP_SET_BLACKBOX_CONFIG,
    );
    expect(write?.payload).toEqual([2, 3, 11, 0x08, 0x02, 2, 0, 0, 0, 0]);

    // A reboot was requested, and NO success has appeared.
    expect(reboots).toEqual([sessionId]);
    expect(textOf(tree)).not.toContain(ar.blackbox.outcome.saved);
    // The screen is waiting on the post-reboot readback, and says so.
    expect(textOf(tree)).toContain(ar.blackbox.saveStage.VERIFYING_AFTER_REBOOT);
    // The token survives the screen, because the screen is about to go.
    expect(blackboxPendingSave.get()?.writtenOnGeneration).toBe(key.generation);

    // THE REBOOT. The workspace unmounts with the connection, exactly as
    // App.tsx does when the verified session disappears.
    act(() => tree.unmount());

    /**
     * THE BOARD COMES BACK ON A NEW SESSION.
     *
     * The SAME virtual board, still holding what the save actually wrote,
     * reached through a coordinator that reports the incremented
     * generation a reopen mints. That is the whole point: the readback
     * below reads the board's own state rather than a fixture chosen
     * here, and it happens on a session identity the controller will
     * accept - it refuses the previous one outright.
     */
    const rebooted = {sessionId, generation: key.generation + 1};
    expect(rebooted.generation).not.toBe(key.generation);
    const afterReboot = new BlackboxConfigurationController({
      coordinator: {
        getOwnershipState: () => coordinator.getOwnershipState(sessionId),
        getIdentificationState: () =>
          coordinator.getIdentificationState(sessionId),
        getSessionKey: () => rebooted,
        getActiveMspClient: () => coordinator.getActiveMspClient(sessionId),
        getTelemetryScheduler: () => coordinator.getTelemetryScheduler(sessionId),
        getMspRecoveryState: () => coordinator.getMspRecoveryState(sessionId),
      },
      appStateOwner: {getPhase: () => 'ACTIVE'},
      rebootLifecycle: {expectReboot: () => undefined},
    });
    const revived = await mount(afterReboot, rebooted);

    expect(textIn(revived, 'blackbox-status-line')).toContain(
      ar.blackbox.outcome.saved,
    );
    // And what it read back IS what was asked for, not what was there before.
    expect(textIn(revived, 'blackbox-persisted-device')).toContain(
      ar.blackbox.device.SDCARD,
    );
    // And the token has been answered, so it cannot be checked twice.
    expect(blackboxPendingSave.get()).toBeNull();
    act(() => revived.unmount());
  }, 30000);

  it('never says saved when the board acknowledges and changes nothing', async () => {
    /**
     * THE FIRMWARE'S OWN BEHAVIOUR. MSP_SET_BLACKBOX_CONFIG is wrapped in
     * `if (blackboxMayEditConfig())`; when that is false the frame is
     * consumed, nothing changes, and an ordinary success reply goes back.
     * This board does exactly that.
     */
    const reboots: string[] = [];
    boardSeq += 1;
    const sessionId = `bb-ui-silent-${boardSeq}`;
    const board = new VirtualBoard(sessionId, {device: 1, sampleRate: 0});
    // Consume the write and change nothing - the silent rejection.
    const original = board.client.writeBytes.bind(board.client);
    (board.client as {writeBytes: unknown}).writeBytes = (
      id: string,
      dataBase64: string,
    ) => {
      const frame = base64ToBytes(dataBase64);
      if (frame[4] === MSP_SET_BLACKBOX_CONFIG) {
        board.requested.push(MSP_SET_BLACKBOX_CONFIG);
        const ack = buildMspFrameBytes(
          MSP_SET_BLACKBOX_CONFIG,
          new Uint8Array(0),
          {wireFormat: 'v1', direction: 'response'},
        );
        Promise.resolve().then(() =>
          (board as unknown as {
            listeners: Set<(event: UsbSerialDataEvent) => void>;
          }).listeners.forEach(listener =>
            listener({sessionId, dataBase64: bytesToBase64(ack)}),
          ),
        );
        return Promise.resolve(undefined);
      }
      return original(id, dataBase64);
    };
    const coordinator = new MspSessionCoordinator();
    coordinator.openSession(board.client, sessionId);
    await sleep(400);
    const key = coordinator.getSessionKey(sessionId);
    if (key === undefined) throw new Error('the board never identified');

    const controller = controllerOn(coordinator, {reboots});
    const tree = await mount(controller, key);
    selectOption(tree, 'blackbox-device-select', '2');
    await act(async () => {
      press(tree, 'blackbox-save-bar-save');
      await sleep(200);
    });

    expect(textIn(tree, 'blackbox-status-line')).toContain(
      ar.blackbox.outcome.readbackMismatch,
    );
    expect(textOf(tree)).not.toContain(ar.blackbox.outcome.saved);
    // Nothing was persisted and nothing was rebooted.
    expect(board.requested).not.toContain(MSP_EEPROM_WRITE);
    expect(reboots).toEqual([]);
    expect(blackboxPendingSave.get()).toBeNull();
    act(() => tree.unmount());
  }, 30000);

  it('sends nothing at all when the operator changes nothing', async () => {
    const {board, coordinator, key} = await bringUpBoard();
    const controller = controllerOn(coordinator);
    const tree = await mount(controller, key);
    const before = board.requested.length;
    // With no change there is no save surface to press at all.
    const bar = tree.root
      .findAllByProps({testID: 'blackbox-save-bar'})
      .find(node => typeof node.props.visible === 'boolean');
    expect(bar?.props.visible).toBe(false);
    expect(board.requested.length).toBe(before);
    expect(board.requested).not.toContain(MSP_SET_BLACKBOX_CONFIG);
    expect(board.requested).not.toContain(MSP_EEPROM_WRITE);
    act(() => tree.unmount());
  }, 30000);
});

/* ================================================================== *
 * §50 - THE WHOLE ERASE, ON A REAL SESSION
 * ================================================================== */

describe('erasing through the production path', () => {
  it('stays busy until the volume itself reports READY with nothing stored', async () => {
    const clock = new GatedClock();
    const {board, coordinator, key} = await bringUpBoard({
      device: 1,
      dataflash: dataflashFrame(FLASH_READY, SIXTEEN_MIB, FOUR_MIB),
      dataflashAfterErase: [
        // 1. Acknowledged, and the chip is no longer readable.
        dataflashFrame(FLASH_BUSY, SIXTEEN_MIB, FOUR_MIB),
        // 2. Readable again - and STILL holding four megabytes.
        dataflashFrame(FLASH_READY, SIXTEEN_MIB, FOUR_MIB),
        // 3. Done.
        dataflashFrame(FLASH_READY, SIXTEEN_MIB, ZERO32),
      ],
    });
    const controller = controllerOn(coordinator, {clock});
    const tree = await mount(controller, key);

    // The card opened with a real measurement.
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('4');
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('16');

    press(tree, 'blackbox-erase-button');
    expect(board.requested).not.toContain(MSP_DATAFLASH_ERASE);
    // ONE confirmation, and only then is anything destructive sent.
    press(tree, 'blackbox-erase-confirm');

    await act(async () => {
      await sleep(40);
    });

    /* STEP 1 - THE ACKNOWLEDGEMENT. The destructive command is on the wire
       and has been answered. That is not an erased chip, and the screen
       must claim nothing. */
    expect(board.requested).toContain(MSP_DATAFLASH_ERASE);
    expect(has(tree, 'blackbox-erase-progress')).toBe(true);
    expect(textOf(tree)).not.toContain(ar.blackbox.erase.succeeded);
    // No invented percentage anywhere on the page.
    expect(textOf(tree)).not.toContain('%');
    // And the pre-erase measurement is gone, because nothing is measuring.
    expect(has(tree, 'blackbox-flash-usage')).toBe(false);
    expect(has(tree, 'blackbox-flash-bar')).toBe(false);

    /* STEP 2 - NOT READY. Mid-erase the volume stops answering as ready.
       That is progress, not failure, and still not success. */
    await act(async () => {
      await clock.tick();
    });
    expect(has(tree, 'blackbox-erase-progress')).toBe(true);
    expect(textOf(tree)).not.toContain(ar.blackbox.erase.succeeded);

    /* STEP 3 - READY AGAIN, AND STILL HOLDING FOUR MEGABYTES.
       This is the state a naive implementation calls done: the volume is
       readable, `ready` is true, the poll got a clean answer. It is not
       done. Only used === 0 is done. */
    await act(async () => {
      await clock.tick();
    });
    expect(has(tree, 'blackbox-erase-progress')).toBe(true);
    expect(textOf(tree)).not.toContain(ar.blackbox.erase.succeeded);

    /* STEP 4 - EMPTY. */
    await act(async () => {
      await clock.tick();
    });

    expect(textIn(tree, 'blackbox-erase-outcome')).toBe(ar.blackbox.erase.succeeded);
    expect(textIn(tree, 'blackbox-flash-state')).toContain(
      ar.blackbox.flashState.READY_EMPTY,
    );
    // The capacity survived; only the used figure went to zero.
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('16');
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('0');
    // Nothing is left to erase, so nothing is offered.
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    // The poll ran at the published cadence and invented no other.
    expect(clock.sleeps.every(ms => ms === 500)).toBe(true);
    act(() => tree.unmount());
  }, 30000);

  it('offers no erase when the SAVED destination is not the onboard flash', async () => {
    // The chip is present and full; the board logs to its SD card. The
    // firmware's blackboxEraseAll() would do nothing at all.
    const {board, coordinator, key} = await bringUpBoard({
      device: 2,
      dataflash: dataflashFrame(FLASH_READY, SIXTEEN_MIB, FOUR_MIB),
    });
    const controller = controllerOn(coordinator);
    const tree = await mount(controller, key);
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    // And selecting flash in the DRAFT does not unlock it either.
    selectOption(tree, 'blackbox-device-select', '1');
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    expect(textIn(tree, 'blackbox-erase-needs-save')).toContain(
      ar.blackbox.eraseNeedsSavedDevice,
    );
    expect(board.requested).not.toContain(MSP_DATAFLASH_ERASE);
    act(() => tree.unmount());
  }, 30000);
});
