// ENTRY CLEANUP: SetupScreen now hosts the USB connection workspace
// (UsbConnectionScreen) for its disconnected state, so importing it pulls
// in the transport client whose TurboModule must be mocked under Jest -
// the exact mock App.test.tsx has always used.
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

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
 * does it and for the same reason: this file is about the PAYLOAD INDEX
 * IDENTITY, and a live observation loop competing for the fake link would
 * make it a test of scheduling instead. Replacing THE MODULE inside Jest's
 * own registry adds no production seam, flag, option or environment branch
 * - nothing in production can import or reach this replacement, and the
 * real decision path is proven in motorTestSafetyMonitor.test.ts and
 * motorTestBenchGate.test.ts.
 */
jest.mock('../../core/state/motorTestContinuousSafetyMonitor', () => ({
  readMotorArmedStateEvidence: () => 'FRESH_DISARMED',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

/**
 * The Motors container reads the session identity from the coordinator
 * singleton, which needs a real USB session to have one. Only that read and
 * its invalidation subscription are replaced - the SAME two members this
 * file's own `session` port already supplies to the controller directly. The
 * lease, the barrier, the binding, the capability store and the controller
 * are all real and untouched.
 */
jest.mock('../../platforms/react-native/protocol', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol'),
  mspSessionCoordinator: {
    getMotorTestSessionIdentity: () => ({physicalGeneration: 7, mspEpoch: 0}),
    getIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        apiVersion: {
          mspProtocolVersion: 0,
          apiVersionMajor: 1,
          apiVersionMinor: 47,
        },
        firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
        board: {},
      },
    }),
    subscribeIdentificationState: () => () => {},
    subscribeMotorTestSessionInvalidated: () => () => {},
    // Read by the container to display a bring-up cause in the blocked
    // state. Undefined here is the truthful answer: this fixture opens the
    // capability directly, so no bring-up step ever ran, let alone threw.
    getSessionBringUpFailure: () => undefined,
    // Paired with the getter: the container reads once AND subscribes,
    // so a stub missing this is a TypeError at render time.
    subscribeSessionBringUpFailure: () => () => {},
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import {presentConnectedBoard} from '../session/__testUtils__/connectedBoard';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  readMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
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
import {StyleSheet} from 'react-native';
import {openMotorsTechnicalDetails} from './__testUtils__/motorsTechnicalDetails';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {betaflightApi147Identity} from '../../core/protocol/__testUtils__/motorFirmwareFixtures';
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
    readFirmwareIdentification: () => ({
      status: 'SUCCEEDED',
      identity: betaflightApi147Identity(),
    }),
    subscribeFirmwareIdentification: () => () => undefined,
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

  const harness = {transport, controller, replies: script(), writes: []};
  // REGISTERED FOR GUARANTEED TEARDOWN. See the afterEach below: a harness
  // that a failing assertion skipped past must still be torn down, so the
  // registry is populated at construction rather than at the end of a test
  // body that may never be reached.
  OPEN_HARNESSES.push(harness);
  return harness;
}

/**
 * Every harness built in this file, awaiting teardown.
 *
 * WHY THIS EXISTS. `runTeardown()` does real transport I/O - it writes the
 * command-214 all-stop through `executeStopVector()` - and
 * `FakeMspTransport.writeBytes()` returns a Promise that is settled ONLY by
 * an explicit `resolveNextWrite()`, which only `serveOne()` calls, which
 * only `drive()` calls. So `controller.close()` on its own does not finish:
 * it starts a teardown that then waits forever on a write nobody serves.
 *
 * The controller itself is not at fault - it stops the continuous safety
 * monitor and clears the pulse-deadline watchdog SYNCHRONOUSLY, before
 * anything is awaited, so no timer outlives `close()`. What was left
 * running was this file's abandoned teardown, and in the one suite that
 * drives the real motor controller that is exactly the thing that must not
 * be left dangling.
 */
const OPEN_HARNESSES: Harness[] = [];

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
  // P2-ii: wire-format-aware. The engine's supplemental DShot stop is a
  // real MSPv2 request; answering it with a v1 error would never match and
  // would wedge the serialized FIFO for the rest of the session. The
  // pinned API 1.47 firmware speaks MSPv2, so a v2 reply is correct
  // simulation, not a convenience.
  const isV2 = data[1] === 0x58; // '$X<'
  const command = isV2 ? data[4] | (data[5] << 8) : writtenCommand(data);
  harness.writes.push({
    command,
    payload: isV2
      ? Array.from(data.subarray(8, 8 + (data[6] | (data[7] << 8))))
      : Array.from(data.subarray(5, 5 + data[3])),
  });
  harness.transport.resolveNextWrite();
  await flush();
  const payload = harness.replies.get(command);
  const wireFormat = isV2 ? ('v2' as const) : ('v1' as const);
  harness.transport.emitData(
    payload === undefined
      ? buildMspFrameBytes(command, EMPTY, {wireFormat, direction: 'error'})
      : buildMspFrameBytes(command, payload, {wireFormat, direction: 'response'}),
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
  renewPulseHold() {
    return 'RENEWED' as const;
  }
  setEscDirection(
    motorNumber: number,
    direction: import('../../core').DshotEscDirection,
  ) {
    return Promise.resolve({
      kind: 'ACKNOWLEDGED' as const,
      motorNumber,
      direction,
      physicallyVerified: false as const,
    });
  }
  refreshDiagnostics() {
    return Promise.resolve({
      outputs: {state: 'WAITING' as const, value: undefined, observedAtMillis: undefined},
      escTelemetry: {state: 'WAITING' as const, value: undefined, observedAtMillis: undefined},
    });
  }
  requestStop() {
    return {accepted: true} as never;
  }
  // The screen never calls either of these in this file, and it must not:
  // a session is begun and ended by the coordinator, never by a render.
  beginSession(): Promise<MotorTestControllerSnapshot> {
    throw new Error('beginSession must not be reached from a render');
  }
  // P3: facade stubs - this suite drives the legacy pulse path only.
  setMotorValues() {
    return {kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const};
  }
  setMotorValue() {
    return {kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const};
  }
  setMaster() {
    return {kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const};
  }
  stopAll() {
    return 'ACCEPTED' as const;
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
    // M-D: THE FIXTURE NOW STATES THE AIRCRAFT IT DESCRIBES.
    //
    // It used to carry no motor count at all and relied on the screen's
    // four-slot placeholder to produce four cells. That placeholder is
    // gone - an unread count now renders no motors rather than four - so
    // the quad this test has always been about is written down. Both
    // fields are the real authorities: the count from MSP_MOTOR_CONFIG,
    // the mixer from MSP_MIXER_CONFIG (3 = QUADX).
    motorScope: {motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false},
    mixerModeRaw: 3,
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
  // M-E §44: the workflow this suite exercises now lives under the
  // technical details disclosure. One press, as an operator would.
  openMotorsTechnicalDetails(renderer);
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

/**
 * Drives every open harness's teardown TO COMPLETION, serving the
 * transport exactly as a real flight controller would answer it.
 *
 * Runs even when a test throws, which a teardown at the end of a test body
 * cannot promise. `close()` is idempotent - it returns the one stored
 * teardown promise - so a test that already closed cleanly costs nothing
 * here.
 */
afterEach(async () => {
  const harnesses = OPEN_HARNESSES.splice(0, OPEN_HARNESSES.length);
  for (const harness of harnesses) {
    await drive(harness, harness.controller.close());
    await flush(20);
  }
});

/* ================================================================== *
 * THE TEST
 * ================================================================== */

describe('MSP_SET_MOTOR payload index === the motor number on the selected cell', () => {
  for (const slot of [1, 2, 3, 4]) {
    it(`slot ${slot}: the rendered cell, the submitted number and the payload index all agree`, async () => {
      /* ---- half B: what the screen shows and what it submits ---- */
      const operator = new FakeOperator(readySnapshot());
      const rendered = render(operator);

      // Select the output the way an operator does. The numbered selector
      // moved out of the legacy tools card into the core identity section
      // in P1b-B; only the locator changed, and the assertions below -
      // submitted number, rendered cell, payload index - are untouched.
      ReactTestRenderer.act(() => {
        rendered.find(`motor-identity-M${slot}`).props.onPress();
      });
      // The long press is the ONE activation gesture.
      expect(MOTOR_TEST_LONG_PRESS_DELAY_MILLIS).toBe(800);
      ReactTestRenderer.act(() => {
        const hold = rendered.find('motors-hold-button');
        hold.props.onPressIn();
        hold.props.onLongPress();
      });

      // The number the screen submitted is the number on the cell.
      expect(operator.pulsed).toEqual([slot]);

      // And that number is what the diagram node for this slot displays,
      // in the geometrically correct place. M-E replaced the four-cell
      // grid with a coordinate-driven drawing, so the node itself is the
      // handle; the glyph layout it is checked against is unchanged.
      const cell = computeMotorGlyphLayout().find(entry => entry.slot === slot);
      expect(cell).toBeDefined();
      const glyph = rendered.find(`motors-airframe-slot-${slot}`);
      expect(textsWithin(glyph)).toContain(`M${slot}`);

      // The node's claimed airframe position is the accepted mapping's,
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
      // M-C: EIGHT u16 values, the canonical MSP_SET_MOTOR width, on every
      // airframe. The identity this test exists to pin is unchanged and is
      // now checked across the whole frame rather than its first half.
      expect(commanded).toHaveLength(16);
      // EXACTLY ONE output above stop, and it is at index slot-1.
      expect(activeIndices(commanded)).toEqual([slot - 1]);
      // Every other output is explicitly at stop, not merely "not active"
      // - including the four padding slots past this quad's motor count.
      for (let index = 0; index < 8; index++) {
        if (index !== slot - 1) {
          expect(readU16(commanded, index)).toBe(STOP_VALUE);
        }
      }

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
    // The front-of-aircraft indicator is on screen, above the drawing.
    expect(rendered.find('motors-diagram-front')).toBeDefined();

    // M-E: the four-cell grid became a coordinate-driven drawing, so
    // "front row above rear row" is now a claim about PIXELS rather than
    // about emission order - and is asserted as one. The offsets come
    // from the node's own absolute position, which is computed from the
    // layout table's coordinates and from nothing else.
    const topOf = (slot: number): number => {
      const style = StyleSheet.flatten(
        rendered.find(`motors-airframe-slot-${slot}`).props.style,
      ) as {top: number; left: number};
      return style.top;
    };
    const leftOf = (slot: number): number => {
      const style = StyleSheet.flatten(
        rendered.find(`motors-airframe-slot-${slot}`).props.style,
      ) as {top: number; left: number};
      return style.left;
    };
    // QUADX: motors 2 and 4 are at the front, 1 and 3 at the rear.
    expect(topOf(2)).toBeLessThan(topOf(1));
    expect(topOf(4)).toBeLessThan(topOf(3));
    // ...and 1 and 2 are on the right-hand side, 3 and 4 on the left.
    expect(leftOf(2)).toBeGreaterThan(leftOf(4));
    expect(leftOf(1)).toBeGreaterThan(leftOf(3));
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
  });
});


/* ================================================================== *
 * BEGIN -> LEAVE, AT TWO GENUINE STATES.
 *
 * Reuses this file's scripted flight controller verbatim - `script()`,
 * `serveOne()`, `flush()` - so the controller actually advances instead of
 * self-closing on an unserved transport. That self-closing is what made
 * every earlier attempt at this assertion vacuous: nothing was ever held,
 * so "released after leaving" was trivially true.
 *
 * The two resource signals are pre-existing public API:
 * `MspClient.isMotorTestLeaseHeld()` and the snapshot's `telemetryHeld`
 * (= `barrier?.isHeld()`).
 * ================================================================== */

const SHELL_SESSION_ID = 'shell-session';

interface ShellFixture {
  readonly client: MspClient;
  readonly served: Harness;
}

function openShellCapability(): ShellFixture {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, SHELL_SESSION_ID);
  openMotorTestCapability(
    SHELL_SESSION_ID,
    client,
    createMotorTestTelemetryRegistry(),
  );
  // `serveOne` only ever touches transport/replies/writes, so this is the
  // real fixture pointed at the screen's own client rather than a copy of it.
  const served = {
    transport,
    controller: undefined as never,
    replies: script(),
    writes: [],
  } as unknown as Harness;
  return {client, served};
}

/** The controller the SCREEN is using. `operatorPort()` returns the same
 * instance forever, so this is not a second controller. */
function shellController() {
  const capability = readMotorTestCapability(SHELL_SESSION_ID);
  if (capability === undefined) {
    throw new Error('no capability');
  }
  return capability.operatorPort(
    {
      readCurrentIdentity: () => ({physicalGeneration: 7, mspEpoch: 0}),
      readFirmwareIdentification: () => ({
        status: 'SUCCEEDED',
        identity: betaflightApi147Identity(),
      }),
      subscribeFirmwareIdentification: () => () => {},
      subscribeSessionInvalidated: () => () => {},
    } as never,
    () => Date.now(),
  );
}

function renderTabShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SHELL_SESSION_ID, generation: 1}},
  } as never;
  /* The shell's connection gate reads the coordinator, not the route
     parameter, so a rendered configurator needs a board presented to
     it. See ui/session/__testUtils__/connectedBoard.ts. */
  presentConnectedBoard(SHELL_SESSION_ID);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const find = (testID: string) => renderer.root.findAllByProps({testID})[0];
  return {
    renderer,
    find,
    // Resolves the node that OWNS the gesture - see the note in
    // motorsBeginSessionReachesDevice.test.tsx. A ToggleSwitch's outermost
    // testID node has no onPress, so `find(testID).props.onPress()` would
    // throw and `onPress?.()` would silently pass.
    press: (testID: string) => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => typeof candidate.props?.onPress === 'function');
      if (node === undefined) {
        throw new Error(`no pressable node with testID "${testID}"`);
      }
      ReactTestRenderer.act(() => {
        node.props.onPress();
      });
    },
    longPress: (testID: string) =>
      ReactTestRenderer.act(() => {
        const node = find(testID);
        node.props.onPressIn();
        node.props.onLongPress();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

afterEach(() => {
  closeMotorTestCapability(SHELL_SESSION_ID);
});

describe('begin -> leave releases the lease and resumes telemetry', () => {
  /**
   * MEASURED STATE SEQUENCE, from a probe rather than assumed. Serving the
   * script one reply at a time, the controller passes through:
   *
   *   phase=PREPARING machine=undefined lease=false tel=false   <- (a)
   *   phase=ACTIVE    machine=Checking  lease=true  tel=true    <- (a2)
   *   phase=ACTIVE    machine=Ready     lease=true  tel=true    <- (b)
   *
   * So the phase LITERALLY named `PREPARING` is a window in which nothing
   * is held yet, and "held but not yet Ready" is a DIFFERENT state
   * (`ACTIVE`/`Checking`). Both are real and both are covered, because they
   * fail in different ways: (a) can only leak by acquiring AFTER departure,
   * (a2) and (b) can only leak by failing to give back what is already
   * held.
   */
  it('(a) leaving during genuine PREPARING ends with nothing held and nothing commanded', async () => {
    const {client, served} = openShellCapability();
    const shell = renderTabShell();
    shell.press('main-tab-MOTORS');
    const controller = shellController();

    // Leave IMMEDIATELY - no flush, no served reply. Setup is in flight and
    // has not taken anything yet, so the hazard in this exact window is not
    // "does it give back what it holds" - it holds nothing - it is "does
    // the in-flight acquisition land anyway, after the operator has already
    // gone". Asserted rather than timed, so no microtask count is assumed.
    ReactTestRenderer.act(() => {
      shell.press('motor-session-toggle');
    });
    expect(controller.getSnapshot().phase).not.toBe('ACTIVE');
    expect(client.isMotorTestLeaseHeld()).toBe(false);

    // Leave, then let the in-flight setup run to whatever conclusion it
    // reaches.
    await ReactTestRenderer.act(async () => {
      shell.press('main-tab-SETUP');
      for (let i = 0; i < 120; i++) {
        await flush(2);
        await serveOne(served);
      }
    });

    // MEASURED, AND DELIBERATELY NOT ASSERTED AS "NEVER HELD". Setup that is
    // already in flight does go on to take the lease after the operator has
    // left - it cannot be recalled mid-exchange, and cutting it off is
    // exactly what produced the wedged lease documented in
    // `releaseOnLeave`. The hold is TRANSIENT and bounded by setup
    // completing, after which the release happens. What matters is that it
    // ends, and that nothing was commanded while it lasted.
    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(controller.getSnapshot().telemetryHeld).toBe(false);

    // Nothing drove an output at any point: no command-214 write carried a
    // value above stop. This is the reason the transient hold is acceptable
    // rather than merely tolerated.
    for (const write of served.writes) {
      if (write.command === MSP_SET_MOTOR_FIXTURE) {
        expect(activeIndices(write.payload)).toEqual([]);
      }
    }
    shell.unmount();
  });

  it('(a2) leaving while genuinely held but not yet Ready', async () => {
    const {client, served} = openShellCapability();
    const shell = renderTabShell();
    shell.press('main-tab-MOTORS');
    const controller = shellController();

    await ReactTestRenderer.act(async () => {
      shell.press('motor-session-toggle');
      for (
        let i = 0;
        i < 400 && !client.isMotorTestLeaseHeld();
        i++
      ) {
        await flush(3);
        await serveOne(served);
      }
    });

    // Resources genuinely held, machine deliberately short of Ready.
    expect(client.isMotorTestLeaseHeld()).toBe(true);
    expect(controller.getSnapshot().telemetryHeld).toBe(true);
    expect(controller.getSnapshot().machine?.name).not.toBe('Ready');

    await ReactTestRenderer.act(async () => {
      shell.press('main-tab-SETUP');
      for (let i = 0; i < 120; i++) {
        await flush(2);
        await serveOne(served);
      }
    });

    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(controller.getSnapshot().telemetryHeld).toBe(false);
    shell.unmount();
  });

  it('(b) leaving after reaching genuine Ready', async () => {
    const {client, served} = openShellCapability();
    const shell = renderTabShell();
    shell.press('main-tab-MOTORS');
    const controller = shellController();

    await ReactTestRenderer.act(async () => {
      shell.press('motor-session-toggle');
      for (
        let i = 0;
        i < 400 && controller.getSnapshot().machine?.name !== 'Ready';
        i++
      ) {
        await flush(3);
        await serveOne(served);
      }
    });

    // GENUINE Ready, with both resources genuinely held.
    expect(controller.getSnapshot().machine?.name).toBe('Ready');
    expect(client.isMotorTestLeaseHeld()).toBe(true);
    expect(controller.getSnapshot().telemetryHeld).toBe(true);

    // Leave WITHOUT ever holding to test.
    await ReactTestRenderer.act(async () => {
      shell.press('main-tab-SETUP');
      for (let i = 0; i < 60; i++) {
        await flush(2);
        await serveOne(served);
      }
    });

    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(controller.getSnapshot().telemetryHeld).toBe(false);
    shell.unmount();
  });
});
