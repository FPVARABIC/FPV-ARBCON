import type { MspRequestOptions } from '../../../core/protocol/mspClient';
import type { MspFrame } from '../../../core/protocol/mspTypes';
import type { MspTelemetryScheduler } from '../../../core/protocol/telemetry';
import {
  MSP_ADVANCED_CONFIG,
  MSP2_MOTOR_OUTPUT_REORDERING,
  MSP2_SET_MOTOR_OUTPUT_REORDERING,
  MSP2_SEND_DSHOT_COMMAND,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import { MSP_BOXIDS } from '../../../core/protocol/msp/commands/mspCommands';
import { createMotorConfigurationDraft } from '../../../core/state/motorConfigurationModel';
import type { MspIdentificationState } from './MspSessionCoordinator';
import {
  MotorConfigurationController,
  type MotorConfigurationSessionCoordinator,
} from './MotorConfigurationController';

function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32le(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

function statusPayload(armed = false): Uint8Array {
  return Uint8Array.from([
    ...u16le(312),
    ...u16le(0),
    ...u16le(41),
    ...u32le(armed ? 1 : 0),
    0,
    ...u16le(12),
    3,
    0,
    0,
    29,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function advancedPayload(idle = 550, protocol = 7): Uint8Array {
  return Uint8Array.from([
    1,
    2,
    0,
    protocol,
    ...u16le(480),
    ...u16le(idle),
    0,
    0,
    0,
    1,
    48,
    ...u16le(125),
    ...u16le(65519),
    2,
    9,
    77,
  ]);
}

const FEATURE = Uint8Array.from([0, 0, 0, 0]);
const MIXER = Uint8Array.from([3, 0]);
const MOTOR = Uint8Array.from([
  ...u16le(0),
  ...u16le(2000),
  ...u16le(1000),
  4,
  14,
  0,
  0,
]);
const MOTOR_3D = Uint8Array.from([
  ...u16le(1406),
  ...u16le(1514),
  ...u16le(1460),
]);

type Script = { readonly payload: Uint8Array } | { readonly reject: unknown };

class FakeClient {
  readonly calls: Array<{
    readonly command: number;
    readonly payload: Uint8Array;
    readonly options: MspRequestOptions;
  }> = [];
  private readonly scripts = new Map<number, Script[]>();
  private epoch = 1;

  getEpoch(): number {
    return this.epoch;
  }

  enqueue(command: number, ...scripts: Script[]): void {
    const existing = this.scripts.get(command) ?? [];
    existing.push(...scripts);
    this.scripts.set(command, existing);
  }

  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({ command, payload, options });
    const queue = this.scripts.get(command);
    const script = queue?.shift();
    if (script !== undefined && 'reject' in script) {
      if (
        script.reject !== null &&
        typeof script.reject === 'object' &&
        'code' in script.reject &&
        script.reject.code === 'MSP_TIMEOUT'
      ) {
        this.epoch += 1;
      }
      throw script.reject;
    }
    const response =
      script !== undefined ? script.payload : Uint8Array.from([]);
    return {
      protocolVersion: 'v1',
      wireFormat: 'v1',
      direction: 'response',
      command,
      flags: 0,
      payload: response,
    };
  }
}

function scheduler(): MspTelemetryScheduler {
  return {
    acquirePauseLease: jest.fn(() => ({ release: jest.fn() })),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
}

function compatibleIdentity(): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
      apiVersion: {
        mspProtocolVersion: 0,
        apiVersionMajor: 1,
        apiVersionMinor: 47,
      },
      board: {},
    },
  } as MspIdentificationState;
}

function makeHarness(
  options: { motorTestActive?: boolean; appActive?: boolean } = {},
) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {
    ownership: 'ACTIVE' as const,
    identification: compatibleIdentity(),
    generation: 3,
    recovery: 'READY' as const,
  };
  const coordinator: MotorConfigurationSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({ sessionId, generation: state.generation }),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new MotorConfigurationController({
    coordinator,
    appStateOwner: {
      getPhase: () =>
        options.appActive === false ? 'APP_BACKGROUND' : 'ACTIVE',
    },
    isMotorTestActive: () => options.motorTestActive === true,
  });
  return { client, controller, telemetry, state };
}

function enqueueSnapshot(client: FakeClient, idle = 550, protocol = 7): void {
  client.enqueue(MSP_FEATURE_CONFIG, { payload: FEATURE });
  client.enqueue(MSP_MIXER_CONFIG, { payload: MIXER });
  client.enqueue(MSP_MOTOR_CONFIG, { payload: MOTOR });
  client.enqueue(MSP_MOTOR_3D_CONFIG, { payload: MOTOR_3D });
  client.enqueue(MSP_ADVANCED_CONFIG, {
    payload: advancedPayload(idle, protocol),
  });
}

async function loadOriginal(harness: ReturnType<typeof makeHarness>) {
  enqueueSnapshot(harness.client);
  const loaded = await harness.controller.load('fc-1');
  if (loaded.kind !== 'LOADED') {
    throw new Error(`Expected LOADED, received ${loaded.kind}`);
  }
  return loaded.snapshot;
}

describe('MotorConfigurationController', () => {
  it('loads all five groups under one telemetry pause lease', async () => {
    const harness = makeHarness();
    const loaded = await loadOriginal(harness);

    expect(loaded.advanced.motorIdleRaw).toBe(550);
    expect(harness.client.calls.map(call => call.command)).toEqual([
      MSP_FEATURE_CONFIG,
      MSP_MIXER_CONFIG,
      MSP_MOTOR_CONFIG,
      MSP_MOTOR_3D_CONFIG,
      MSP_ADVANCED_CONFIG,
    ]);
    expect(harness.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
  });

  it('rejects an active motor-test lifecycle before any request', async () => {
    const harness = makeHarness({ motorTestActive: true });
    expect(await harness.controller.load('fc-1')).toEqual({
      kind: 'REJECTED',
      reason: 'MOTOR_TEST_ACTIVE',
    });
    expect(harness.client.calls).toEqual([]);
  });

  it('returns NO_CHANGES without taking a second lease or writing', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    const callCount = harness.client.calls.length;

    expect(
      await harness.controller.save(
        'fc-1',
        original,
        createMotorConfigurationDraft(original),
      ),
    ).toMatchObject({ kind: 'NO_CHANGES' });
    expect(harness.client.calls).toHaveLength(callCount);
  });

  it('fails closed on ARMED and sends no MSP_SET_* or EEPROM command', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(true) });

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toEqual({ kind: 'REJECTED', reason: 'FC_ARMED' });
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_ADVANCED_CONFIG,
    );
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('rejects a stale base before armed-state acquisition or writes', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client, 575);

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toEqual({ kind: 'REJECTED', reason: 'STALE_BASE' });
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_BOXIDS,
    );
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('writes one changed group, persists once, and verifies one readback', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: Uint8Array.from([]) });
    enqueueSnapshot(harness.client, 600);

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toMatchObject({
      kind: 'SAVED_VERIFIED',
      rebootRequired: true,
      changedGroups: ['ADVANCED'],
    });
    const commands = harness.client.calls.map(call => call.command);
    expect(
      commands.filter(command => command === MSP_SET_ADVANCED_CONFIG),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
    expect(commands.slice(-5)).toEqual([
      MSP_FEATURE_CONFIG,
      MSP_MIXER_CONFIG,
      MSP_MOTOR_CONFIG,
      MSP_MOTOR_3D_CONFIG,
      MSP_ADVANCED_CONFIG,
    ]);
  });

  it('reports a definite first-write rejection without persistence', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      reject: { code: 'MSP_REMOTE_ERROR' },
    });

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toMatchObject({
      kind: 'FAILED',
      acknowledgedGroups: [],
      persisted: false,
    });
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('reports the exact ambiguous group and never retries it', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      reject: { code: 'MSP_TIMEOUT' },
    });

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toEqual({
      kind: 'UNCONFIRMED',
      stage: 'ADVANCED',
      acknowledgedGroups: [],
    });
    expect(
      harness.client.calls.filter(
        call => call.command === MSP_SET_ADVANCED_CONFIG,
      ),
    ).toHaveLength(1);
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('reports ambiguous EEPROM persistence after acknowledged groups', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, {
      reject: { code: 'MSP_TIMEOUT' },
    });

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorIdleRaw: 600,
    });

    expect(result).toEqual({
      kind: 'UNCONFIRMED',
      stage: 'EEPROM',
      acknowledgedGroups: ['ADVANCED'],
    });
    expect(
      harness.client.calls.filter(call => call.command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
  });

  it('loads motor output order through the official MSP v2 command', async () => {
    const harness = makeHarness();
    harness.client.enqueue(MSP2_MOTOR_OUTPUT_REORDERING, {
      payload: Uint8Array.from([4, 2, 0, 3, 1]),
    });

    await expect(harness.controller.loadOutputOrder('fc-1')).resolves.toEqual({
      kind: 'LOADED',
      values: [2, 0, 3, 1],
    });
    expect(harness.client.calls[0]).toMatchObject({
      command: MSP2_MOTOR_OUTPUT_REORDERING,
      options: { wireFormat: 'v2' },
    });
  });

  it('saves output order only after fresh DISARMED proof and verifies readback', async () => {
    const harness = makeHarness();
    harness.client.enqueue(
      MSP2_MOTOR_OUTPUT_REORDERING,
      { payload: Uint8Array.from([4, 0, 1, 2, 3]) },
      { payload: Uint8Array.from([4, 2, 0, 3, 1]) },
    );
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP2_SET_MOTOR_OUTPUT_REORDERING, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: Uint8Array.from([]) });

    await expect(
      harness.controller.saveOutputOrder('fc-1', [0, 1, 2, 3], [2, 0, 3, 1]),
    ).resolves.toEqual({ kind: 'SAVED_VERIFIED', values: [2, 0, 3, 1] });

    const setCall = harness.client.calls.find(
      call => call.command === MSP2_SET_MOTOR_OUTPUT_REORDERING,
    );
    expect(Array.from(setCall?.payload ?? [])).toEqual([4, 2, 0, 3, 1]);
    expect(setCall?.options).toEqual({ wireFormat: 'v2' });
    const commands = harness.client.calls.map(call => call.command);
    expect(commands.indexOf(MSP_STATUS_EX)).toBeLessThan(
      commands.indexOf(MSP2_SET_MOTOR_OUTPUT_REORDERING),
    );
    expect(
      commands.filter(command => command === MSP2_SET_MOTOR_OUTPUT_REORDERING),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
  });

  it('does not write output order when the FC is armed', async () => {
    const harness = makeHarness();
    harness.client.enqueue(MSP2_MOTOR_OUTPUT_REORDERING, {
      payload: Uint8Array.from([4, 0, 1, 2, 3]),
    });
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(true) });

    await expect(
      harness.controller.saveOutputOrder('fc-1', [0, 1, 2, 3], [2, 0, 3, 1]),
    ).resolves.toEqual({ kind: 'REJECTED', reason: 'FC_ARMED' });
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP2_SET_MOTOR_OUTPUT_REORDERING,
    );
  });

  it('never retries an ambiguous motor output order write', async () => {
    const harness = makeHarness();
    harness.client.enqueue(MSP2_MOTOR_OUTPUT_REORDERING, {
      payload: Uint8Array.from([4, 0, 1, 2, 3]),
    });
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP2_SET_MOTOR_OUTPUT_REORDERING, {
      reject: { code: 'MSP_TIMEOUT' },
    });

    await expect(
      harness.controller.saveOutputOrder('fc-1', [0, 1, 2, 3], [2, 0, 3, 1]),
    ).resolves.toEqual({ kind: 'UNCONFIRMED', stage: 'OUTPUT_ORDER' });
    expect(
      harness.client.calls.filter(
        call => call.command === MSP2_SET_MOTOR_OUTPUT_REORDERING,
      ),
    ).toHaveLength(1);
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('sends one persistent blocking DShot direction command after DISARMED proof', async () => {
    const harness = makeHarness();
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP2_SEND_DSHOT_COMMAND, {
      payload: Uint8Array.from([]),
    });

    await expect(
      harness.controller.setEscDirection('fc-1', 3, 'REVERSED'),
    ).resolves.toEqual({
      kind: 'ACKNOWLEDGED',
      motorNumber: 3,
      direction: 'REVERSED',
      physicallyVerified: false,
    });
    const call = harness.client.calls.find(
      candidate => candidate.command === MSP2_SEND_DSHOT_COMMAND,
    );
    expect(Array.from(call?.payload ?? [])).toEqual([1, 2, 2, 8, 12]);
    expect(call?.options).toEqual({ wireFormat: 'v2' });
    expect(harness.client.calls.map(item => item.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('rejects ESC direction for a non-DShot motor protocol', async () => {
    const harness = makeHarness();
    enqueueSnapshot(harness.client, 550, 0);

    await expect(
      harness.controller.setEscDirection('fc-1', 1, 'NORMAL'),
    ).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'ESC_DIRECTION_UNSUPPORTED',
    });
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP2_SEND_DSHOT_COMMAND,
    );
  });

  it('never retries an ambiguous DShot direction command', async () => {
    const harness = makeHarness();
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP2_SEND_DSHOT_COMMAND, {
      reject: { code: 'MSP_TIMEOUT' },
    });

    await expect(
      harness.controller.setEscDirection('fc-1', 1, 'REVERSED'),
    ).resolves.toEqual({ kind: 'UNCONFIRMED' });
    expect(
      harness.client.calls.filter(
        call => call.command === MSP2_SEND_DSHOT_COMMAND,
      ),
    ).toHaveLength(1);
  });
});
