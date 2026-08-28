/* eslint-disable no-bitwise -- fixtures use the same function-mask notation as firmware. */
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

type Script = { payload: Uint8Array } | { reject: unknown };

class FakeClient {
  readonly calls: Array<{
    command: number;
    payload: Uint8Array;
    options: MspRequestOptions;
  }> = [];
  private readonly scripts = new Map<number, Script[]>();
  private epoch = 1;
  getEpoch(): number {
    return this.epoch;
  }
  enqueue(command: number, ...scripts: Script[]): void {
    this.scripts.set(command, [
      ...(this.scripts.get(command) ?? []),
      ...scripts,
    ]);
  }
  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({ command, payload, options });
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) {
      if (
        typeof script.reject === 'object' &&
        script.reject !== null &&
        'code' in script.reject &&
        script.reject.code === 'MSP_TIMEOUT'
      )
        this.epoch += 1;
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

const EMPTY = new Uint8Array(0);
const key = { sessionId: 'fc-1', generation: 3 } as const;
const port = (
  identifier: number,
  functionMask: number,
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 0,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xaa]),
});
const originalPorts = [port(20, 1), port(0, 1 << 6)] as const;

function statusPayload(armed = false): Uint8Array {
  return Uint8Array.from([
    0,
    0,
    0,
    0,
    0,
    0,
    armed ? 1 : 0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
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

function identification(
  identifier = 'BTFL',
  minor = 48,
): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: {
        identifier,
        knownFamily: identifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV',
      },
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

function harness(options: { armed?: boolean; motorTest?: boolean } = {}) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {
    identification: identification(),
    generation: 3,
    ownership: 'ACTIVE' as const,
    recovery: 'READY' as const,
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
    isMotorTestActive: () => options.motorTest === true,
  });
  return {
    client,
    telemetry,
    state,
    controller,
    armed: options.armed === true,
  };
}

function enqueueSerial(
  client: FakeClient,
  ports: readonly MspSerialPortRecord[] = originalPorts,
): void {
  client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {
    payload: encodeSerialPorts(ports),
  });
}

function featurePayload(mask = 0): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, mask, true);
  return payload;
}

function enqueueSnapshot(
  client: FakeClient,
  ports: readonly MspSerialPortRecord[] = originalPorts,
  featureMask = 0,
): void {
  enqueueSerial(client, ports);
  client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(featureMask) });
}

async function loadOriginal(h: ReturnType<typeof harness>) {
  enqueueSnapshot(h.client);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED')
    throw new Error(`Expected LOADED, got ${result.kind}`);
  return result.snapshot;
}

describe('PortsConfigurationController', () => {
  it('loads the real MSP2 serial records under one telemetry pause lease', async () => {
    const h = harness();
    const loaded = await loadOriginal(h);
    expect(loaded.ports).toHaveLength(2);
    expect(loaded.ports[0].extensionBytes).toEqual(Uint8Array.from([0xaa]));
    expect(h.client.calls[0]).toMatchObject({
      command: MSP2_COMMON_SERIAL_CONFIG,
      options: { wireFormat: 'v2' },
    });
    expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an available but incomplete VTX table from an unavailable table', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_RX_CONFIG, { payload: Uint8Array.from([9]) });
    h.client.enqueue(MSP_BUILD_INFO, {
      payload: Uint8Array.from([...new Array(26).fill(0), 0, 0]),
    });
    h.client.enqueue(MSP_VTX_CONFIG, {
      payload: Uint8Array.from([
        3, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 4,
      ]),
    });

    const loaded = await h.controller.load(key);

    expect(loaded).toMatchObject({
      kind: 'LOADED',
      snapshot: {
        vtxTable: {
          kind: 'OBSERVED',
          value: { tableAvailable: true, tableConfigured: false },
        },
      },
    });
  });

  it('fails closed for a different firmware family before any MSP request', async () => {
    const h = harness();
    h.state.identification = identification('INAV');
    await expect(h.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(h.client.calls).toEqual([]);
  });

  it('rejects an active motor test before reading or writing ports', async () => {
    const h = harness({ motorTest: true });
    await expect(h.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'MOTOR_TEST_ACTIVE',
    });
    expect(h.client.calls).toEqual([]);
  });

  it('rejects stale base before armed proof and writes', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client, [port(20, 1), port(0, 1 << 1)]);
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    await expect(h.controller.save(key, original, desired)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP2_COMMON_SET_SERIAL_CONFIG,
    );
  });

  it('never writes when the fresh status says ARMED', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(true) });
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    await expect(h.controller.save(key, original, desired)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'FC_ARMED',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP2_COMMON_SET_SERIAL_CONFIG,
    );
  });

  it('writes once, persists once, verifies readback, and requests reboot', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP2_COMMON_SET_SERIAL_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_SET_FEATURE_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_EEPROM_WRITE, { payload: EMPTY });
    enqueueSnapshot(h.client, desired, 2 ** 27);
    h.client.enqueue(MSP_REBOOT, { payload: EMPTY });

    await expect(
      h.controller.save(key, original, desired),
    ).resolves.toMatchObject({
      kind: 'SAVED_VERIFIED',
      rebootAcknowledged: true,
    });
    const commands = h.client.calls.map(call => call.command);
    expect(
      commands.filter(command => command === MSP2_COMMON_SET_SERIAL_CONFIG),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_SET_FEATURE_CONFIG),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
    expect(commands.indexOf(MSP_STATUS_EX)).toBeLessThan(
      commands.indexOf(MSP2_COMMON_SET_SERIAL_CONFIG),
    );
    expect(commands.at(-1)).toBe(MSP_REBOOT);
  });

  it('reports ambiguous serial write and never retries or persists it', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP2_COMMON_SET_SERIAL_CONFIG, {
      reject: { code: 'MSP_TIMEOUT' },
    });
    await expect(h.controller.save(key, original, desired)).resolves.toEqual({
      kind: 'UNCONFIRMED',
      stage: 'SERIAL_CONFIG',
    });
    expect(
      h.client.calls.filter(
        call => call.command === MSP2_COMMON_SET_SERIAL_CONFIG,
      ),
    ).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('reports an ambiguous feature write and never retries or persists it', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP2_COMMON_SET_SERIAL_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_SET_FEATURE_CONFIG, {
      reject: { code: 'MSP_TIMEOUT' },
    });
    await expect(h.controller.save(key, original, desired)).resolves.toEqual({
      kind: 'UNCONFIRMED',
      stage: 'FEATURE_CONFIG',
    });
    expect(
      h.client.calls.filter(call => call.command === MSP_SET_FEATURE_CONFIG),
    ).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });

  it('detects a concurrent feature-mask change as stale before writing', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const desired = [
      original.ports[0],
      { ...original.ports[1], functionMask: 1 << 10 },
    ];
    enqueueSnapshot(h.client, originalPorts, 2 ** 7);
    await expect(h.controller.save(key, original, desired)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP2_COMMON_SET_SERIAL_CONFIG,
    );
  });

  it('preserves unknown future bits and extension bytes in the write payload', async () => {
    const h = harness();
    const future = [port(20, 1 | (1 << 20)), port(0, 1 << 6)];
    enqueueSnapshot(h.client, future);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('fixture load failed');
    const desired = [
      loaded.snapshot.ports[0],
      { ...loaded.snapshot.ports[1], functionMask: 1 << 10 },
    ];
    enqueueSnapshot(h.client, future);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP2_COMMON_SET_SERIAL_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_SET_FEATURE_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_EEPROM_WRITE, { payload: EMPTY });
    enqueueSnapshot(h.client, desired, 2 ** 27);
    h.client.enqueue(MSP_REBOOT, { payload: EMPTY });
    await h.controller.save(key, loaded.snapshot, desired);
    const write = h.client.calls.find(
      call => call.command === MSP2_COMMON_SET_SERIAL_CONFIG,
    );
    expect(write?.payload).toEqual(encodeSerialPorts(desired));
  });
});
