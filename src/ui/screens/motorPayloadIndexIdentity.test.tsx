/**
 * THE SINGLE MOST IMPORTANT TEST IN THE MOTORS FEATURE.
 *
 * THE CLAIM UNDER TEST. The motor number rendered on the cell the operator
 * selected is the SAME number that ends up as the active index in the
 * MSP_SET_MOTOR payload. If those two ever disagree, the operator watches
 * one arm of the aircraft while a different arm spins - with a propeller
 * on, that is an injury, and every safety gate in this repository would
 * have passed while it happened.
 *
 * WHY IT IS PROVEN END TO END RATHER THAN ASSERTED IN PIECES. "The screen
 * calls pulseMotor(n)" and "the encoder puts the value at index n-1" are
 * each true in isolation and say nothing about the join. This file drives
 * BOTH halves:
 *
 *   half A - the REAL MotorTestController, over the REAL MspClient and the
 *            REAL lease/facts/capability/restriction modules, down to the
 *            actual bytes handed to the transport. Nothing between
 *            pulseMotor() and the wire is reimplemented or stubbed.
 *   half B - the REAL MotorsScreenView, rendered, with the cell selected
 *            the way an operator selects it, asserting which number that
 *            cell displays and which number the long press submits.
 *
 * and then asserts the two agree, per slot, for all four slots.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no ESC, no motor, no LiPo, no
 * emulator, no device. The only fake below the controller is the
 * repository's existing FakeMspTransport.
 */

/**
 * JEST-ONLY MODULE REPLACEMENT, exactly as motorTestController.test.ts
 * does it and for the same reason: the production continuous-safety
 * monitor reader is hard-wired unavailable, which is an authoritative
 * activation blocker. Replacing THE MODULE inside Jest's own registry adds
 * no production seam, flag, option or environment branch - nothing in
 * production can import or reach this replacement.
 */
jest.mock('../../core/state/motorTestContinuousSafetyMonitor', () => ({
  readContinuousSafetyMonitoring: () => 'AVAILABLE_ACCEPTED_SOURCE',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import {
  MotorsScreenView,
  MOTOR_TEST_LONG_PRESS_DELAY_MILLIS,
  computeMotorGlyphLayout,
} from './MotorsScreen';
import {
  createMotorTestController,
  type MotorTestControllerSessionPort,
  type MotorTestControllerSnapshot,
  type MotorTestSessionInvalidationReason,
} from '../../core/state/motorTestController';
import {
  MotorTestTelemetryRegistry,
  type MotorTestBarrierScheduler,
} from '../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type {
  TelemetryPauseLease,
  TelemetryPauseReason,
} from '../../core/protocol/telemetry/telemetryTypes';
import {MspClient} from '../../core/protocol/mspClient';
import {ARMING_DISABLE_FLAGS_COUNT} from '../../core/state/armingBlockers';
import {ARMING_DISABLED_MSP_BIT_INDEX} from '../../core/state/motorArmingRestriction';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {MOTOR_TEST_EXPECTED_CONFIGURATION} from '../../core/state/motorVerificationModel';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {
  MSP_ADVANCED_CONFIG,
  MSP_API_VERSION,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_FC_VERSION,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../core/protocol/msp/commands/mspCommands';

const EMPTY = new Uint8Array(0);
const PHYSICAL_GENERATION = 7;
/** Named here only so the fixture can answer it. */
const MSP_SET_ARMING_DISABLED_FIXTURE = 99;
/** The command whose payload this file exists to inspect. */
const MSP_SET_MOTOR_FIXTURE = 214;
/** drivers/dshot.c:90 - in non-3D DShot this exact value is motor stop. */
const STOP_VALUE = 1000;

/* ------------------------------------------------------------------ *
 * Byte helpers - arithmetic, never bitwise, so a high bit survives
 * ------------------------------------------------------------------ */

function u16(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

function ascii(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0));
}

/** Betaflight's sbufWritePString(): one length byte, then the bytes. */
function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

/* ------------------------------------------------------------------ *
 * The supported-profile fixture
 * (SpeedyBee F405 V4 @ Betaflight 2025.12.2, MSP API 1.47)
 * ------------------------------------------------------------------ */

function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('S405'),
    ...u16(0),
    0,
    0,
    ...pstring('SPEEDYBEEF405V4'),
    ...pstring('SpeedyBee F405 V4'),
    ...pstring('SPBE'),
    ...new Array<number>(32).fill(0),
    1,
    2,
  ]);
}

function statusPayload(): Uint8Array {
  return Uint8Array.from([
    ...u16(125),
    ...u16(0),
    ...u16(0x21),
    ...u32(0),
    2,
    ...u16(15),
    4,
    1,
    0,
    ARMING_DISABLE_FLAGS_COUNT,
    ...u32(Math.pow(2, ARMING_DISABLED_MSP_BIT_INDEX)),
    0,
    ...u16(3400),
    6,
  ]);
}

/** cellCount 4, 15.80 V, BATTERY_OK - inside the accepted policy band. */
function batteryPayload(): Uint8Array {
  return Uint8Array.from([4, ...u16(1500), 15, ...u16(0), ...u16(0), 0, ...u16(1580)]);
}

function script(): Map<number, Uint8Array> {
  return new Map<number, Uint8Array>([
    [MSP_API_VERSION, Uint8Array.from([0, 1, 47])],
    [MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL'))],
    [MSP_BOARD_INFO, boardInfoPayload()],
    [MSP_FC_VERSION, Uint8Array.from([25, 12, 2, 9, ...ascii('2025.12.2')])],
    [MSP_MIXER_CONFIG, Uint8Array.from([3, 1])],
    [
      MSP_MOTOR_CONFIG,
      Uint8Array.from([...u16(0), ...u16(2000), ...u16(1000), 4, 14, 0, 0]),
    ],
    [
      MSP_ADVANCED_CONFIG,
      Uint8Array.from([
        1, 1, 0, 7, ...u16(480), ...u16(550), 0, 0, 0, 0, 0, ...u16(125),
        ...u16(0), 0, 0, 0,
      ]),
    ],
    [MSP_FEATURE_CONFIG, Uint8Array.from(u32(0))],
    // BOXARM's permanent id is 0, placed at index 2 so a hardcoded bit-0
    // assumption would be caught.
    [MSP_BOXIDS, Uint8Array.from([5, 1, 0, 13])],
    [MSP_STATUS_EX, statusPayload()],
    [MSP_BATTERY_STATE, batteryPayload()],
    [MSP_SET_ARMING_DISABLED_FIXTURE, EMPTY],
    [MSP_SET_MOTOR_FIXTURE, EMPTY],
  ]);
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Exactly the two methods the barrier may call. */
class RecordingScheduler implements MotorTestBarrierScheduler {
  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    return {id: `${reason}-1`, release: () => {}};
  }
  waitUntilIdle(): Promise<void> {
    return Promise.resolve();
  }
}

interface Harness {
  readonly transport: FakeMspTransport;
  readonly controller: ReturnType<typeof createMotorTestController>;
  readonly replies: Map<number, Uint8Array>;
  readonly writes: {command: number; payload: number[]}[];
}

function createHarness(): Harness {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, 'motor-payload-index-session');
  const registry = new MotorTestTelemetryRegistry();
  const telemetrySession = registry.openSession(client);
  registry.registerScheduler(telemetrySession, new RecordingScheduler());

  const listeners = new Set<
    (reason: MotorTestSessionInvalidationReason) => void
  >();
  const session: MotorTestControllerSessionPort = {
    client,
    // A FRESH object every call: composite identity is compared by value.
    readCurrentIdentity: () => ({
      physicalGeneration: PHYSICAL_GENERATION,
      mspEpoch: 0,
    }),
    subscribeSessionInvalidated: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  let monotonic = 1_000;
  const controller = createMotorTestController({
    session,
    telemetryRegistry: registry,
    telemetrySession,
    readMonotonicMillis: () => {
      monotonic += 5;
      return monotonic;
    },
  });

  return {transport, controller, replies: script(), writes: []};
}

/** Byte 4 of a v1 request frame is the command. */
function writtenCommand(data: Uint8Array): number {
  return data[4];
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

/** Serves the oldest pending transport write, if any. */
async function serveOne(harness: Harness): Promise<boolean> {
  if (harness.transport.writes.length === 0) {
    return false;
  }
  const data = harness.transport.writes[0].data;
  const command = writtenCommand(data);
  // v1 request frame: $ M < size cmd <payload...> checksum
  harness.writes.push({
    command,
    payload: Array.from(data.subarray(5, 5 + data[3])),
  });
  harness.transport.resolveNextWrite();
  await flush();
  const payload = harness.replies.get(command);
  harness.transport.emitData(
    payload === undefined
      ? buildMspFrameBytes(command, EMPTY, {
          wireFormat: 'v1',
          direction: 'error',
        })
      : buildMspFrameBytes(command, payload, {
          wireFormat: 'v1',
          direction: 'response',
        }),
  );
  await flush();
  return true;
}

async function drive<T>(harness: Harness, operation: Promise<T>): Promise<T> {
  let settled = false;
  const observed = operation.then(value => {
    settled = true;
    return value;
  });
  for (let step = 0; step < 400 && !settled; step++) {
    await flush(3);
    if (settled) {
      break;
    }
    await serveOne(harness);
  }
  return observed;
}

/** Reads a little-endian u16 out of a captured payload. */
function readU16(payload: readonly number[], index: number): number {
  return payload[index * 2] + payload[index * 2 + 1] * 256;
}

/**
 * The indices in a captured MSP_SET_MOTOR payload whose value is ABOVE
 * stop - i.e. the outputs that payload actually commands.
 */
function activeIndices(payload: readonly number[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < payload.length / 2; index++) {
    if (readU16(payload, index) > STOP_VALUE) {
      indices.push(index);
    }
  }
  return indices;
}

/* ------------------------------------------------------------------ *
 * Half B - the rendered screen
 * ------------------------------------------------------------------ */

class FakeOperator implements MotorTestOperatorPort {
  readonly pulsed: number[] = [];
  constructor(private snapshot: MotorTestControllerSnapshot) {}
  getSnapshot(): MotorTestControllerSnapshot {
    return this.snapshot;
  }
  subscribe(): () => void {
    return () => {};
  }
  pulseMotor(motorNumber: number) {
    this.pulsed.push(motorNumber);
    return {accepted: true} as never;
  }
  requestStop() {
    return {accepted: true} as never;
  }
  // The screen never calls either of these in this file, and it must not:
  // a session is begun and ended by the coordinator, never by a render.
  beginSession(): Promise<MotorTestControllerSnapshot> {
    throw new Error('beginSession must not be reached from a render');
  }
  endSession(): Promise<MotorTestControllerSnapshot> {
    throw new Error('endSession must not be reached from a render');
  }
}

function readySnapshot(): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    outcome: {kind: 'READY'},
    machine: {name: 'Ready'},
    activation: {allowed: true, reasons: []},
    pulse: {mayHaveReachedFc: false, motorNumber: undefined},
    stopExecution: {attributionAmbiguous: false},
    telemetryHeld: true,
  } as unknown as MotorTestControllerSnapshot;
}

interface Rendered {
  readonly renderer: ReactTestRenderer.ReactTestRenderer;
  find(testID: string): ReactTestRenderer.ReactTestInstance;
  unmount(): void;
}

function render(operator: FakeOperator): Rendered {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MotorsScreenView operator={operator as unknown as MotorTestOperatorPort} />,
    );
  });
  return {
    renderer,
    find: (testID: string) => {
      const matches = renderer.root
        .findAllByProps({testID})
        .filter(node => typeof node.type !== 'string' || true);
      if (matches.length === 0) {
        throw new Error(`No instance with testID "${testID}"`);
      }
      return matches[0];
    },
    unmount: () => {
      ReactTestRenderer.act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Every string rendered inside one instance's subtree. */
function textsWithin(instance: ReactTestRenderer.ReactTestInstance): string[] {
  return instance
    .findAllByType('Text' as never, {deep: true})
    .flatMap(node =>
      (Array.isArray(node.props.children)
        ? node.props.children
        : [node.props.children]
      ).filter((child: unknown) => typeof child === 'string'),
    ) as string[];
}

/* ================================================================== *
 * THE TEST
 * ================================================================== */

describe('MSP_SET_MOTOR payload index === the motor number on the selected cell', () => {
  for (const slot of [1, 2, 3, 4]) {
    it(`slot ${slot}: the rendered cell, the submitted number and the payload index all agree`, async () => {
      /* ---- half B: what the screen shows and what it submits ---- */
      const operator = new FakeOperator(readySnapshot());
      const rendered = render(operator);

      // Select the output the way an operator does.
      ReactTestRenderer.act(() => {
        rendered.find(`motors-slot-${slot}`).props.onPress();
      });
      // Acknowledge, the way an operator must, or activation is refused.
      for (const key of ['propellers', 'secured', 'battery']) {
        ReactTestRenderer.act(() => {
          rendered.find(`motors-ack-${key}`).props.onPress();
        });
      }
      // The long press is the ONE activation gesture.
      expect(MOTOR_TEST_LONG_PRESS_DELAY_MILLIS).toBe(800);
      ReactTestRenderer.act(() => {
        rendered.find('motors-hold-button').props.onLongPress();
      });

      // The number the screen submitted is the number on the cell.
      expect(operator.pulsed).toEqual([slot]);

      // And that number is what the diagram cell for this slot displays,
      // in the geometrically correct place.
      const cell = computeMotorGlyphLayout().find(entry => entry.slot === slot);
      expect(cell).toBeDefined();
      const glyph = rendered.find(
        `motors-diagram-cell-${cell!.row}-${cell!.side}`,
      );
      expect(textsWithin(glyph)).toContain(`M${slot}`);

      // The cell's claimed airframe position is the accepted mapping's,
      // never a second copy of it.
      const expectedMapping = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
        entry => entry.motorNumber === slot,
      );
      expect(expectedMapping).toBeDefined();
      expect(`${cell!.row}_${cell!.side}`).toBe(expectedMapping!.position);

      rendered.unmount();

      /* ---- half A: the bytes the real controller actually writes ---- */
      const harness = createHarness();
      const setup = await drive(harness, harness.controller.initializeSession());
      expect(setup.machine?.name).toBe('Ready');
      expect(setup.activation.allowed).toBe(true);

      const before = harness.writes.length;
      // THE SAME NUMBER the screen submitted - passed through unchanged.
      const submitted = operator.pulsed[0];
      await drive(
        harness,
        Promise.resolve(harness.controller.pulseMotor(submitted)).then(
          async result => {
            await flush(20);
            return result;
          },
        ),
      );

      const motorWrites = harness.writes
        .slice(before)
        .filter(write => write.command === MSP_SET_MOTOR_FIXTURE);
      expect(motorWrites.length).toBeGreaterThan(0);

      const commanded = motorWrites[0].payload;
      // Four u16 values - the approved Quad X scope and nothing wider.
      expect(commanded).toHaveLength(8);
      // EXACTLY ONE output above stop, and it is at index slot-1.
      expect(activeIndices(commanded)).toEqual([slot - 1]);
      // Every other output is explicitly at stop, not merely "not active".
      for (let index = 0; index < 4; index++) {
        if (index !== slot - 1) {
          expect(readU16(commanded, index)).toBe(STOP_VALUE);
        }
      }

      harness.controller.close();
      await flush(20);
    });
  }

  it('places the four cells where the aircraft actually has them', () => {
    // The literal corrected placement, stated outright so this cannot pass
    // vacuously off the same table it is meant to check:
    //   top-right = M2 front-right   top-left = M4 front-left
    //   bottom-right = M1 rear-right bottom-left = M3 rear-left
    expect(
      computeMotorGlyphLayout().map(cell => [cell.slot, cell.row, cell.side]),
    ).toEqual([
      [2, 'FRONT', 'RIGHT'],
      [4, 'FRONT', 'LEFT'],
      [1, 'REAR', 'RIGHT'],
      [3, 'REAR', 'LEFT'],
    ]);
    // The old defect, named so a regression is unmistakable: M2 (front)
    // and M1 (rear) must never share a row.
    const rowOf = (slot: number) =>
      computeMotorGlyphLayout().find(cell => cell.slot === slot)?.row;
    expect(rowOf(2)).not.toBe(rowOf(1));
    expect(rowOf(4)).not.toBe(rowOf(3));
  });

  it('renders the FRONT row above the REAR row, with a front-of-aircraft indicator', () => {
    const rendered = render(new FakeOperator(readySnapshot()));
    const diagram = rendered.find('motors-diagram');
    const order = diagram
      .findAllByProps({}, {deep: true})
      .map(node => node.props.testID)
      .filter(
        (testID: unknown): testID is string =>
          typeof testID === 'string' &&
          (testID.startsWith('motors-diagram-cell-') ||
            testID === 'motors-diagram-front'),
      );
    const first = (needle: string) => order.indexOf(needle);
    // The front indicator comes before every cell, and the front row
    // before the rear row - top to bottom is nose to tail.
    expect(first('motors-diagram-front')).toBe(0);
    expect(first('motors-diagram-cell-FRONT-RIGHT')).toBeLessThan(
      first('motors-diagram-cell-REAR-RIGHT'),
    );
    expect(first('motors-diagram-cell-FRONT-LEFT')).toBeLessThan(
      first('motors-diagram-cell-REAR-LEFT'),
    );
    // And within a row the RIGHT cell is emitted first, which under the
    // app's forceRTL puts it at the right edge.
    expect(first('motors-diagram-cell-FRONT-RIGHT')).toBeLessThan(
      first('motors-diagram-cell-FRONT-LEFT'),
    );
    rendered.unmount();
  });

  it('never commands more than one output in a single payload', async () => {
    const harness = createHarness();
    await drive(harness, harness.controller.initializeSession());
    await drive(
      harness,
      Promise.resolve(harness.controller.pulseMotor(3)).then(async result => {
        await flush(20);
        return result;
      }),
    );
    for (const write of harness.writes.filter(
      entry => entry.command === MSP_SET_MOTOR_FIXTURE,
    )) {
      expect(activeIndices(write.payload).length).toBeLessThanOrEqual(1);
    }
    harness.controller.close();
    await flush(20);
  });
});
