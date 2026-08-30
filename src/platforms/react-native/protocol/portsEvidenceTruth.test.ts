/* eslint-disable no-bitwise -- fixtures use the same function-mask notation as firmware. */
/*
 * PORTS OPTIONAL-EVIDENCE TRUTH, THROUGH THE REAL CONTROLLER.
 *
 * Every test here drives the production PortsConfigurationController and
 * the production serialPortsModel. Nothing is stubbed except the MSP
 * transport, and the transport records which injected faults it actually
 * threw, so a test can prove its fault fired rather than assuming a
 * green result means the failure path ran.
 */
import type { MspRequestOptions } from '../../../core/protocol/mspClient';
import type { MspFrame } from '../../../core/protocol/mspTypes';
import type { MspTelemetryScheduler } from '../../../core/protocol/telemetry';
import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
  MSP_BOXIDS,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_REBOOT,
  MSP_RX_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_STATUS_EX,
  MSP_VTX_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  encodeSerialPorts,
  type MspSerialPortRecord,
} from '../../../core/protocol/msp';
import type { MspIdentificationState } from './MspSessionCoordinator';
import {
  PortsConfigurationController,
  type PortsSessionCoordinator,
} from './PortsConfigurationController';

const EMPTY = new Uint8Array(0);
const MSP_ROLE = 1 << 0;
const GPS = 1 << 1;
const TELEMETRY_FRSKY = 1 << 2;
const RX_SERIAL = 1 << 6;
const BLACKBOX = 1 << 7;

const SERIALRX_SBUS = 2;
const SERIALRX_CRSF = 9;
const BUILD_OPTION_GPS = 16412;
const BUILD_OPTION_FRSKY = 12301;

const TIMEOUT = Object.freeze({ code: 'MSP_TIMEOUT' });
const CMD_UNKNOWN = Object.freeze({ code: 'MSP_REMOTE_ERROR' });
const DETACHED = Object.freeze({ code: 'MSP_DEVICE_DETACHED' });

type Script = { payload: Uint8Array } | { reject: unknown };

/**
 * The transport. `faults` records every injected rejection it ACTUALLY
 * threw - §35's requirement that a failure-path test prove its fault
 * fired, rather than passing because the code never reached the call.
 */
class FakeClient {
  readonly calls: Array<{ command: number; payload: Uint8Array }> = [];
  readonly faults: Array<{ command: number; code: unknown }> = [];
  private readonly scripts = new Map<number, Script[]>();
  private epoch = 1;
  getEpoch(): number {
    return this.epoch;
  }
  bumpEpoch(): void {
    this.epoch += 1;
  }
  enqueue(command: number, ...scripts: Script[]): void {
    this.scripts.set(command, [
      ...(this.scripts.get(command) ?? []),
      ...scripts,
    ]);
  }
  countOf(command: number): number {
    return this.calls.filter(call => call.command === command).length;
  }
  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({ command, payload });
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) {
      this.faults.push({
        command,
        code:
          typeof script.reject === 'object' &&
          script.reject !== null &&
          'code' in script.reject
            ? (script.reject as { code: unknown }).code
            : undefined,
      });
      throw script.reject;
    }
    return {
      protocolVersion: options.wireFormat === 'v1' ? 'v1' : 'v2',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: script?.payload ?? EMPTY,
    };
  }
}

const port = (
  identifier: number,
  functionMask: number,
  overrides: Partial<MspSerialPortRecord> = {},
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 4,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xaa]),
  ...overrides,
});

/** USB MSP, a shared RX+FrSky pad (needs the provider), and a free UART. */
const BOARD = Object.freeze([
  port(20, MSP_ROLE),
  port(0, RX_SERIAL | TELEMETRY_FRSKY),
  port(1, 0),
]);
/** The feature bits this board's roles already imply, so an unrelated
 * edit produces no feature write of its own. */
const BOARD_FEATURES = (1 << 3) | (1 << 10);
const FEATURE_GPS = 1 << 7;

/**
 * An edit that genuinely depends on the unread provider. The shared pad
 * keeps its roles - so its legality still needs the provider - but its
 * telemetry baud changes, and the whole-table write must carry that
 * record. This is the shape the evidence gate exists for.
 */
const TOUCHING = [
  BOARD[0],
  port(0, RX_SERIAL | TELEMETRY_FRSKY, { telemetryBaudIndex: 5 }),
  BOARD[2],
];

function statusPayload(armed = false): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0,
    0,
  ]);
}

function featurePayload(mask = 0): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, mask, true);
  return payload;
}

function buildInfoPayload(ids: readonly number[]): Uint8Array {
  const payload = new Uint8Array(26 + ids.length * 2 + 2);
  const view = new DataView(payload.buffer);
  ids.forEach((id, index) => view.setUint16(26 + index * 2, id, true));
  return payload;
}

/** deviceType, ..., tableAvailable, bands, channels, powerLevels. */
function vtxPayload(available: boolean, configured: boolean): Uint8Array {
  return Uint8Array.from([
    3,
    1,
    1,
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    available ? 1 : 0,
    configured ? 5 : 0,
    configured ? 8 : 0,
    configured ? 4 : 0,
  ]);
}

function identification(minor = 48): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
      apiVersion: {
        mspProtocolVersion: 0,
        apiVersionMajor: 1,
        apiVersionMinor: minor,
      },
      board: {},
    },
  } as MspIdentificationState;
}

function scheduler(): MspTelemetryScheduler {
  return {
    acquirePauseLease: jest.fn(() => ({ release: jest.fn() })),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
}

function harness(options: { motorTest?: boolean } = {}) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {
    identification: identification(),
    generation: 3,
    ownership: 'ACTIVE' as const,
    recovery: 'READY' as const,
    motorTest: options.motorTest === true,
  };
  const coordinator: PortsSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({ sessionId, generation: state.generation }),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new PortsConfigurationController({
    coordinator,
    appStateOwner: { getPhase: () => 'ACTIVE' },
    isMotorTestActive: () => state.motorTest,
  });
  return { client, state, controller };
}

interface Evidence {
  readonly rx?: Script;
  readonly build?: Script;
  readonly vtx?: Script;
}

/** One complete load answer set: ports, features, and the three optional reads. */
function enqueueLoad(
  client: FakeClient,
  ports: readonly MspSerialPortRecord[] = BOARD,
  evidence: Evidence = {},
  featureMask = BOARD_FEATURES,
): void {
  client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {
    payload: encodeSerialPorts(ports),
  });
  client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(featureMask) });
  client.enqueue(
    MSP_RX_CONFIG,
    evidence.rx ?? { payload: Uint8Array.from([SERIALRX_SBUS]) },
  );
  client.enqueue(
    MSP_BUILD_INFO,
    evidence.build ??
      { payload: buildInfoPayload([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]) },
  );
  client.enqueue(MSP_VTX_CONFIG, evidence.vtx ?? { payload: vtxPayload(true, true) });
}

/** The reads the save preflight makes before any evidence work. */
function enqueueSavePreflight(
  client: FakeClient,
  ports: readonly MspSerialPortRecord[] = BOARD,
  featureMask = BOARD_FEATURES,
  armed = false,
): void {
  client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {
    payload: encodeSerialPorts(ports),
  });
  client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(featureMask) });
  client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
  client.enqueue(MSP_STATUS_EX, { payload: statusPayload(armed) });
}

async function load(
  h: ReturnType<typeof harness>,
  ports: readonly MspSerialPortRecord[] = BOARD,
  evidence: Evidence = {},
) {
  enqueueLoad(h.client, ports, evidence);
  const result = await h.controller.load({
    sessionId: 'fc-1',
    generation: h.state.generation,
  });
  if (result.kind !== 'LOADED')
    throw new Error(`Expected LOADED, got ${result.kind}`);
  return result.snapshot;
}

const sessionKey = () => ({ sessionId: 'fc-1', generation: 3 }) as const;

/* ================================================================== *
 * §37 - LOADING NEVER WRITES, WHATEVER THE OPTIONAL READS DO
 * ================================================================== */

describe('a failed optional read never turns a load into a write', () => {
  const WRITES = [
    MSP2_COMMON_SET_SERIAL_CONFIG,
    MSP_SET_FEATURE_CONFIG,
    MSP_EEPROM_WRITE,
    MSP_REBOOT,
  ];

  const scenarios = [
    ['every read succeeds', {}],
    ['the RX provider read times out', { rx: { reject: TIMEOUT } }],
    ['the build-info read is refused by the board', { build: { reject: CMD_UNKNOWN } }],
    ['the VTX read detaches', { vtx: { reject: DETACHED } }],
    [
      'all three optional reads fail',
      {
        rx: { reject: TIMEOUT },
        build: { reject: CMD_UNKNOWN },
        vtx: { reject: DETACHED },
      },
    ],
  ] as const;

  it.each(scenarios)('issues no SET, EEPROM or REBOOT when %s', async (_label, evidence) => {
    const h = harness();
    const snapshot = await load(h, BOARD, evidence as Evidence);
    expect(snapshot.ports).toHaveLength(3);
    for (const command of WRITES) expect(h.client.countOf(command)).toBe(0);
    // The optional reads that were scripted to fail actually did.
    expect(h.client.faults.length).toBe(Object.keys(evidence).length);
  });

  it('a failed optional read does not stop the primary port table from loading', async () => {
    const h = harness();
    const snapshot = await load(h, BOARD, {
      rx: { reject: TIMEOUT },
      build: { reject: TIMEOUT },
      vtx: { reject: TIMEOUT },
    });
    expect(h.client.faults.map(f => f.command).sort()).toEqual(
      [MSP_RX_CONFIG, MSP_BUILD_INFO, MSP_VTX_CONFIG].sort(),
    );
    expect(snapshot.ports.map(p => p.identifier)).toEqual([20, 0, 1]);
    expect(snapshot.serialRxProvider).toEqual({ kind: 'READ_FAILED' });
    expect(snapshot.buildOptionIds).toEqual({ kind: 'READ_FAILED' });
    expect(snapshot.vtxTable).toEqual({ kind: 'READ_FAILED' });
  });

  it('records what it observed when the reads answer', async () => {
    const h = harness();
    const snapshot = await load(h);
    expect(h.client.faults).toEqual([]);
    expect(snapshot.serialRxProvider).toEqual({
      kind: 'OBSERVED',
      value: SERIALRX_SBUS,
    });
    expect(snapshot.buildOptionIds).toEqual({
      kind: 'OBSERVED',
      value: new Set([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]),
    });
    expect(snapshot.vtxTable).toEqual({
      kind: 'OBSERVED',
      value: { tableAvailable: true, tableConfigured: true },
    });
  });

  it('three distinct transport failures produce the same honest answer', async () => {
    for (const reject of [TIMEOUT, CMD_UNKNOWN, DETACHED]) {
      const h = harness();
      const snapshot = await load(h, BOARD, { rx: { reject } });
      expect(h.client.faults).toEqual([
        { command: MSP_RX_CONFIG, code: reject.code },
      ]);
      // Not "unsupported", not "provider 0" - not learned.
      expect(snapshot.serialRxProvider).toEqual({ kind: 'READ_FAILED' });
    }
  });

  it('an empty observed inventory is a board answer, not a failed read', async () => {
    // Firmware that answers MSP_BUILD_INFO with no option ids is
    // reporting "I list nothing", which is not the same as "I did not
    // answer" - and the model reads the two differently.
    const h = harness();
    const snapshot = await load(h, BOARD, {
      build: { payload: buildInfoPayload([]) },
    });
    expect(h.client.faults).toEqual([]);
    expect(snapshot.buildOptionIds).toEqual({
      kind: 'OBSERVED',
      value: new Set(),
    });
  });

  it('the controller refuses firmware below API 1.46 before any read', async () => {
    // The version floor lives in the session preflight, which is why the
    // evidence readers carry no version branch of their own.
    const h = harness();
    h.state.identification = identification(45);
    await expect(h.controller.load(sessionKey())).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(h.client.calls).toEqual([]);
  });
});

/* ================================================================== *
 * §29 - RETRY AND RECOVERY, SEQUENCES A-E
 * ================================================================== */

describe('recovery sequences', () => {
  it('A. a transient read failure clears on the next load, same session', async () => {
    const h = harness();
    const first = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    expect(h.client.faults).toHaveLength(1);
    expect(first.serialRxProvider).toEqual({ kind: 'READ_FAILED' });

    const second = await load(h);
    expect(second.serialRxProvider).toEqual({
      kind: 'OBSERVED',
      value: SERIALRX_SBUS,
    });
  });

  it('B. an unrelated edit saves after a failed provider read, without re-reading', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    expect(h.client.faults).toHaveLength(1);

    // The shared RX pad is untouched; only the free UART gains blackbox.
    const desired = [BOARD[0], BOARD[1], port(1, BLACKBOX)];
    enqueueSavePreflight(h.client);
    enqueueLoad(h.client, desired);
    const before = h.client.countOf(MSP_RX_CONFIG);

    const outcome = await h.controller.save(sessionKey(), original, desired);

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(1);
    // No refusal was owed, so no evidence was refetched for the gate.
    // (The verification re-read afterwards is a different thing.)
    expect(h.client.countOf(MSP_RX_CONFIG)).toBe(before + 1);
  });

  it('C. an edit that touches the unverified port refuses when the re-read fails again', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });

    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_RX_CONFIG, { reject: TIMEOUT });

    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);

    expect(h.client.faults).toEqual([
      { command: MSP_RX_CONFIG, code: 'MSP_TIMEOUT' },
      { command: MSP_RX_CONFIG, code: 'MSP_TIMEOUT' },
    ]);
    expect(outcome).toEqual({
      kind: 'REJECTED',
      reason: 'EVIDENCE_NOT_VERIFIED',
      refusals: [
        {
          reason: 'RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION',
          portIdentifier: 0,
        },
      ],
    });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
    expect(h.client.countOf(MSP_EEPROM_WRITE)).toBe(0);
  });

  it('D. the same edit proceeds when the re-read answers and clears the doubt', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });

    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_RX_CONFIG, {
      payload: Uint8Array.from([SERIALRX_SBUS]),
    });
    enqueueLoad(h.client, TOUCHING);

    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);

    expect(h.client.faults).toHaveLength(1);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(1);
  });

  it('D2. a re-read that proves the edit genuinely wrong says INVALID, not NOT_VERIFIED', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });

    enqueueSavePreflight(h.client);
    // CRSF does not drive the TX line, so the shared pad is really invalid.
    h.client.enqueue(MSP_RX_CONFIG, {
      payload: Uint8Array.from([SERIALRX_CRSF]),
    });

    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);

    expect(outcome).toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
  });

  it('E. adding a build-gated role waits for a build inventory, then proceeds', async () => {
    const h = harness();
    const original = await load(h, BOARD, { build: { reject: CMD_UNKNOWN } });
    expect(original.buildOptionIds).toEqual({ kind: 'READ_FAILED' });

    const desired = [BOARD[0], BOARD[1], port(1, GPS)];

    // First attempt: the inventory still will not answer.
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_BUILD_INFO, { reject: CMD_UNKNOWN });
    const refused = await h.controller.save(sessionKey(), original, desired);
    expect(refused).toEqual({
      kind: 'REJECTED',
      reason: 'EVIDENCE_NOT_VERIFIED',
      refusals: [
        {
          reason: 'BUILD_CAPABILITY_NOT_VERIFIED',
          portIdentifier: 1,
          role: 'GPS',
        },
      ],
    });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);

    // Second attempt: the board answers and lists the option.
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_BUILD_INFO, {
      payload: buildInfoPayload([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]),
    });
    enqueueLoad(h.client, desired, {}, BOARD_FEATURES | FEATURE_GPS);
    const saved = await h.controller.save(sessionKey(), original, desired);
    expect(saved.kind).toBe('SAVED_VERIFIED');
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(1);
    expect(h.client.faults).toHaveLength(2);
  });

  it('E2. a re-read proving the option absent refuses as INVALID, not as doubt', async () => {
    const h = harness();
    const original = await load(h, BOARD, { build: { reject: CMD_UNKNOWN } });
    const desired = [BOARD[0], BOARD[1], port(1, GPS)];
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_BUILD_INFO, {
      payload: buildInfoPayload([BUILD_OPTION_FRSKY]),
    });
    const outcome = await h.controller.save(sessionKey(), original, desired);
    expect(outcome).toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
  });

  it('only the evidence the delta needs is refetched', async () => {
    const h = harness();
    const original = await load(h, BOARD, {
      rx: { reject: TIMEOUT },
      build: { reject: TIMEOUT },
    });
    const desired = [BOARD[0], BOARD[1], port(1, GPS)];
    enqueueSavePreflight(h.client);
    // The inventory must list FrSky too: the shared pad already runs it,
    // and an inventory that omitted it would be a real ROLE_NOT_COMPILED.
    h.client.enqueue(MSP_BUILD_INFO, {
      payload: buildInfoPayload([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]),
    });
    enqueueLoad(h.client, desired, {}, BOARD_FEATURES | FEATURE_GPS);

    const rxBefore = h.client.countOf(MSP_RX_CONFIG);
    const outcome = await h.controller.save(sessionKey(), original, desired);

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    // The GPS addition needs the build inventory. It does not need the
    // provider, and the shared pad it cannot judge is untouched - so the
    // provider is fetched once by verification, not by the gate.
    expect(h.client.countOf(MSP_RX_CONFIG)).toBe(rxBefore + 1);
  });
});

/* ================================================================== *
 * §30 - EVIDENCE DOES NOT CROSS BOARDS
 * ================================================================== */

describe('cross-FC evidence isolation', () => {
  it('a new board that answers is not tainted by the previous one that did not', async () => {
    const h = harness();
    const first = await load(h, BOARD, {
      rx: { reject: TIMEOUT },
      build: { reject: TIMEOUT },
    });
    expect(first.serialRxProvider).toEqual({ kind: 'READ_FAILED' });

    h.state.generation = 4;
    h.client.bumpEpoch();
    enqueueLoad(h.client, BOARD);
    const result = await h.controller.load({
      sessionId: 'fc-1',
      generation: 4,
    });
    if (result.kind !== 'LOADED') throw new Error(`got ${result.kind}`);
    expect(result.snapshot.serialRxProvider).toEqual({
      kind: 'OBSERVED',
      value: SERIALRX_SBUS,
    });
    expect(result.snapshot.buildOptionIds).toEqual({
      kind: 'OBSERVED',
      value: new Set([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]),
    });
  });

  it('a new board that does not answer does not inherit the previous answer', async () => {
    const h = harness();
    const first = await load(h);
    expect(first.serialRxProvider).toEqual({
      kind: 'OBSERVED',
      value: SERIALRX_SBUS,
    });

    h.state.generation = 5;
    h.client.bumpEpoch();
    enqueueLoad(h.client, BOARD, {
      rx: { reject: DETACHED },
      build: { reject: DETACHED },
    });
    const result = await h.controller.load({
      sessionId: 'fc-1',
      generation: 5,
    });
    if (result.kind !== 'LOADED') throw new Error(`got ${result.kind}`);
    expect(h.client.faults.map(f => f.code)).toEqual([
      'MSP_DEVICE_DETACHED',
      'MSP_DEVICE_DETACHED',
    ]);
    expect(result.snapshot.serialRxProvider).toEqual({ kind: 'READ_FAILED' });
    expect(result.snapshot.buildOptionIds).toEqual({ kind: 'READ_FAILED' });
  });

  it('a snapshot from a previous generation cannot authorise a write on this one', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    h.state.generation = 6;
    const desired = [BOARD[0], BOARD[1], port(1, BLACKBOX)];
    const outcome = await h.controller.save(
      { sessionId: 'fc-1', generation: 3 },
      original,
      desired,
    );
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'DISCONNECTED' });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
  });
});

/* ================================================================== *
 * §42 - THE PRE-EXISTING SAVE SAFETY GATES STILL HOLD
 *
 * The evidence gate is new and sits LAST in the preflight chain. None of
 * the older refusals may be displaced by it, and none of them may be
 * bypassed by a snapshot carrying unverified evidence.
 * ================================================================== */

describe('save safety with unverified evidence present', () => {
  it('stale base still wins - the board changed under us', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    enqueueSavePreflight(h.client, [BOARD[0], port(0, RX_SERIAL), BOARD[2]]);
    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'STALE_BASE' });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
  });

  it('an armed board still wins - the more urgent thing to say', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    enqueueSavePreflight(h.client, BOARD, BOARD_FEATURES, true);
    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'FC_ARMED' });
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
  });

  it('a running motor test still refuses before any read', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    h.state.motorTest = true;
    const before = h.client.calls.length;
    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE' });
    expect(h.client.calls.length).toBe(before);
  });

  it('an identical table is NO_CHANGES even when evidence is unverified', async () => {
    const h = harness();
    const original = await load(h, BOARD, {
      rx: { reject: TIMEOUT },
      build: { reject: TIMEOUT },
    });
    const before = h.client.calls.length;
    const outcome = await h.controller.save(sessionKey(), original, [...BOARD]);
    expect(outcome.kind).toBe('NO_CHANGES');
    expect(h.client.calls.length).toBe(before);
  });

  it('a genuinely invalid draft is rejected before the wire, unverified or not', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    // Two MSP-less USB: USB_MSP_REQUIRED, decided without any evidence.
    const before = h.client.calls.length;
    const outcome = await h.controller.save(sessionKey(), original, [
      port(20, 0),
      BOARD[1],
      BOARD[2],
    ]);
    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind !== 'REJECTED') throw new Error('unreachable');
    expect(outcome.reason).toBe('INVALID_CONFIGURATION');
    expect(outcome.issues?.map(issue => issue.code)).toContain(
      'USB_MSP_REQUIRED',
    );
    expect(h.client.calls.length).toBe(before);
  });

  it('an evidence refusal never reaches the EEPROM or the reboot', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_RX_CONFIG, { reject: TIMEOUT });
    const outcome = await h.controller.save(sessionKey(), original, TOUCHING);
    expect(outcome.kind).toBe('REJECTED');
    expect(h.client.countOf(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(0);
    expect(h.client.countOf(MSP_SET_FEATURE_CONFIG)).toBe(0);
    expect(h.client.countOf(MSP_EEPROM_WRITE)).toBe(0);
    expect(h.client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('an ambiguous SET is still reported as UNCONFIRMED, not as a refusal', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    const desired = [BOARD[0], BOARD[1], port(1, BLACKBOX)];
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP2_COMMON_SET_SERIAL_CONFIG, { reject: TIMEOUT });
    const outcome = await h.controller.save(sessionKey(), original, desired);
    expect(h.client.faults.at(-1)).toEqual({
      command: MSP2_COMMON_SET_SERIAL_CONFIG,
      code: 'MSP_TIMEOUT',
    });
    expect(outcome).toEqual({
      kind: 'UNCONFIRMED',
      stage: 'SERIAL_CONFIG',
      confirmedStages: [],
    });
  });

  it('the whole normalized table goes out, and the unverified record byte-identical', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    const desired = [BOARD[0], BOARD[1], port(1, BLACKBOX)];
    enqueueSavePreflight(h.client);
    enqueueLoad(h.client, desired);
    await h.controller.save(sessionKey(), original, desired);

    const write = h.client.calls.find(
      call => call.command === MSP2_COMMON_SET_SERIAL_CONFIG,
    );
    expect(write).toBeDefined();
    // The bytes are the proof, not the intent: the unverified pad's
    // record must appear in the written table exactly as the board
    // reported it.
    const sent = write!.payload;
    const expected = encodeSerialPorts(desired);
    expect(Array.from(sent)).toEqual(Array.from(expected));
    // And the shared pad's own bytes are unchanged from the load.
    const original1 = encodeSerialPorts([BOARD[1]]).slice(1);
    expect(
      Array.from(sent).join(',').includes(Array.from(original1).join(',')),
    ).toBe(true);
  });
});

/* ================================================================== *
 * §38 - WHAT THE SAVE ACTUALLY PUT ON THE WIRE
 * ================================================================== */

describe('write-trace classification', () => {
  it('classifies every frame of a successful save', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    const desired = [BOARD[0], BOARD[1], port(1, BLACKBOX)];
    const start = h.client.calls.length;
    enqueueSavePreflight(h.client);
    enqueueLoad(h.client, desired);

    const outcome = await h.controller.save(sessionKey(), original, desired);
    expect(outcome.kind).toBe('SAVED_VERIFIED');

    const trace = h.client.calls.slice(start).map(call => call.command);
    const count = (command: number) =>
      trace.filter(entry => entry === command).length;

    // Reads: stale-base pair, box ids, armed status, then verification.
    expect(count(MSP2_COMMON_SERIAL_CONFIG)).toBe(2);
    expect(count(MSP_FEATURE_CONFIG)).toBe(2);
    expect(count(MSP_BOXIDS)).toBe(1);
    expect(count(MSP_STATUS_EX)).toBe(1);
    expect(count(MSP_RX_CONFIG)).toBe(1);
    expect(count(MSP_BUILD_INFO)).toBe(1);
    expect(count(MSP_VTX_CONFIG)).toBe(1);
    // Writes: one serial table, no feature change, one EEPROM, one reboot.
    expect(count(MSP2_COMMON_SET_SERIAL_CONFIG)).toBe(1);
    expect(count(MSP_SET_FEATURE_CONFIG)).toBe(0);
    expect(count(MSP_EEPROM_WRITE)).toBe(1);
    expect(count(MSP_REBOOT)).toBe(1);
    // EEPROM never precedes the table it is meant to commit.
    expect(trace.indexOf(MSP_EEPROM_WRITE)).toBeGreaterThan(
      trace.indexOf(MSP2_COMMON_SET_SERIAL_CONFIG),
    );
  });

  it('adds exactly one feature write when the derived mask changes', async () => {
    const h = harness();
    const original = await load(h, BOARD, { rx: { reject: TIMEOUT } });
    // Adding GPS to the free UART turns the GPS feature bit on.
    const desired = [BOARD[0], BOARD[1], port(1, GPS)];
    enqueueSavePreflight(h.client);
    h.client.enqueue(MSP_BUILD_INFO, {
      payload: buildInfoPayload([BUILD_OPTION_GPS]),
    });
    enqueueLoad(h.client, desired, {}, BOARD_FEATURES | FEATURE_GPS);

    const outcome = await h.controller.save(sessionKey(), original, desired);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(h.client.countOf(MSP_SET_FEATURE_CONFIG)).toBe(1);
    const featureWrite = h.client.calls.find(
      call => call.command === MSP_SET_FEATURE_CONFIG,
    );
    expect(
      new DataView(
        featureWrite!.payload.buffer,
        featureWrite!.payload.byteOffset,
      ).getUint32(0, true),
    ).toBe(BOARD_FEATURES | FEATURE_GPS);
  });
});
