import type { MspRequestOptions } from '../../../core/protocol/mspClient';
import type { MspFrame } from '../../../core/protocol/mspTypes';
import type { MspTelemetryScheduler } from '../../../core/protocol/telemetry';
import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP_BOXIDS,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_GPS_CONFIG,
  MSP_REBOOT,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_GPS_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  encodeGpsConfiguration,
  encodeSerialPorts,
  type MspGpsConfiguration,
  type MspSerialPortRecord,
} from '../../../core/protocol/msp';
import {
  createGpsConfigurationDraft,
  type GpsConfigurationSnapshot,
} from '../../../core/state/gpsConfigurationModel';
import type { MspIdentificationState } from './MspSessionCoordinator';
import {
  GpsConfigurationController,
  type GpsSessionCoordinator,
} from './GpsConfigurationController';

type Script = { payload: Uint8Array } | { reject: unknown };
const EMPTY = new Uint8Array(0);
const key = { sessionId: 'gps-fc', generation: 4 } as const;

class FakeClient {
  readonly calls: Array<{
    command: number;
    payload: Uint8Array;
    options: MspRequestOptions;
  }> = [];
  private readonly scripts = new Map<number, Script[]>();
  private epoch = 1;
  getEpoch() {
    return this.epoch;
  }
  enqueue(command: number, ...scripts: Script[]) {
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

const originalConfig: MspGpsConfiguration = {
  provider: 0,
  sbasMode: 0,
  autoConfig: false,
  autoBaud: false,
  homePointOnce: false,
  useGalileo: false,
};
const desiredConfig: MspGpsConfiguration = {
  provider: 1,
  sbasMode: 1,
  autoConfig: true,
  autoBaud: false,
  homePointOnce: true,
  useGalileo: true,
};
const ports: readonly MspSerialPortRecord[] = [
  {
    identifier: 5,
    functionMask: 2,
    mspBaudIndex: 5,
    gpsBaudIndex: 4,
    telemetryBaudIndex: 0,
    blackboxBaudIndex: 0,
    extensionBytes: new Uint8Array(0),
  },
];

function featurePayload(mask: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, mask, true);
  return payload;
}

function statusPayload(armed: boolean): Uint8Array {
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

function identification(identifier = 'BTFL'): MspIdentificationState {
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
        apiVersionMinor: 47,
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
    generation: 4,
    ownership: 'ACTIVE' as const,
    recovery: 'READY' as const,
  };
  const coordinator: GpsSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({ sessionId, generation: state.generation }),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new GpsConfigurationController({
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

function enqueueSnapshot(
  client: FakeClient,
  mask: number,
  config: MspGpsConfiguration,
) {
  client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(mask) });
  client.enqueue(MSP_GPS_CONFIG, { payload: encodeGpsConfiguration(config) });
  client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {
    payload: encodeSerialPorts(ports),
  });
}

async function loadOriginal(
  h: ReturnType<typeof harness>,
): Promise<GpsConfigurationSnapshot> {
  enqueueSnapshot(h.client, 0, originalConfig);
  const outcome = await h.controller.load(key);
  if (outcome.kind !== 'LOADED')
    throw new Error(`Expected LOADED, got ${outcome.kind}`);
  return outcome.snapshot;
}

describe('GpsConfigurationController', () => {
  it('loads the feature, six-byte GPS config and actual GPS UART under one pause lease', async () => {
    const h = harness();
    const snapshot = await loadOriginal(h);
    expect(snapshot.configuration).toEqual(originalConfig);
    expect(snapshot.ports[0].identifier).toBe(5);
    expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
  });

  it('fails closed for another firmware family and an active motor test', async () => {
    const h = harness();
    h.state.identification = identification('INAV');
    await expect(h.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(h.client.calls).toEqual([]);
    const motor = harness({ motorTest: true });
    await expect(motor.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'MOTOR_TEST_ACTIVE',
    });
    expect(motor.client.calls).toEqual([]);
  });

  it('rejects a stale GPS base before armed proof or any write', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(0) });
    h.client.enqueue(MSP_GPS_CONFIG, {
      payload: encodeGpsConfiguration({ ...originalConfig, sbasMode: 2 }),
    });
    await expect(
      h.controller.save(key, original, {
        ...createGpsConfigurationDraft(original),
        provider: 1,
      }),
    ).resolves.toEqual({ kind: 'REJECTED', reason: 'STALE_BASE' });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_GPS_CONFIG,
    );
  });

  it('never writes when the fresh status proves ARMED', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(0) });
    h.client.enqueue(MSP_GPS_CONFIG, {
      payload: encodeGpsConfiguration(originalConfig),
    });
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(true) });
    await expect(
      h.controller.save(key, original, {
        ...createGpsConfigurationDraft(original),
        provider: 1,
      }),
    ).resolves.toEqual({ kind: 'REJECTED', reason: 'FC_ARMED' });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_GPS_CONFIG,
    );
  });

  it('writes each changed group once, persists once, verifies and reboots', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.client.enqueue(
      MSP_FEATURE_CONFIG,
      { payload: featurePayload(0) },
      { payload: featurePayload(2 ** 7) },
    );
    h.client.enqueue(
      MSP_GPS_CONFIG,
      { payload: encodeGpsConfiguration(originalConfig) },
      { payload: encodeGpsConfiguration(desiredConfig) },
    );
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP_SET_FEATURE_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_SET_GPS_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_EEPROM_WRITE, { payload: EMPTY });
    h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {
      payload: encodeSerialPorts(ports),
    });
    h.client.enqueue(MSP_REBOOT, { payload: EMPTY });

    await expect(
      h.controller.save(key, original, { enabled: true, ...desiredConfig }),
    ).resolves.toMatchObject({
      kind: 'SAVED_VERIFIED',
      rebootAcknowledged: true,
    });
    const commands = h.client.calls.map(call => call.command);
    expect(
      commands.filter(command => command === MSP_SET_FEATURE_CONFIG),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_SET_GPS_CONFIG),
    ).toHaveLength(1);
    expect(
      commands.filter(command => command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
    expect(commands.indexOf(MSP_STATUS_EX)).toBeLessThan(
      commands.indexOf(MSP_SET_GPS_CONFIG),
    );
    expect(commands.at(-1)).toBe(MSP_REBOOT);
  });

  it('reports an ambiguous GPS write, never retries it and never persists', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.client.enqueue(MSP_FEATURE_CONFIG, { payload: featurePayload(0) });
    h.client.enqueue(MSP_GPS_CONFIG, {
      payload: encodeGpsConfiguration(originalConfig),
    });
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP_SET_GPS_CONFIG, { reject: { code: 'MSP_TIMEOUT' } });
    await expect(
      h.controller.save(key, original, {
        ...createGpsConfigurationDraft(original),
        provider: 1,
      }),
    ).resolves.toEqual({ kind: 'UNCONFIRMED', stage: 'GPS_CONFIG' });
    expect(
      h.client.calls.filter(call => call.command === MSP_SET_GPS_CONFIG),
    ).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });
});
