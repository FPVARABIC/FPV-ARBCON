import type { MspRequestOptions } from '../../../core/protocol/mspClient';
import type { MspFrame } from '../../../core/protocol/mspTypes';
import type { MspTelemetryScheduler } from '../../../core/protocol/telemetry';
import {
  MSP2_GET_TEXT,
  MSP2_SET_TEXT,
  MSP_ADVANCED_CONFIG,
  MSP_ARMING_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_BOXIDS,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_REBOOT,
  MSP_RX_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import { createGeneralConfigurationDraft } from '../../../core/state/generalConfigurationModel';
import type { MspIdentificationState } from './MspSessionCoordinator';
import {
  GeneralConfigurationController,
  type GeneralConfigurationSessionCoordinator,
} from './GeneralConfigurationController';

type Script = { payload: Uint8Array } | { reject: unknown };
const EMPTY = new Uint8Array(0);
const key = { sessionId: 'configuration-fc', generation: 7 } as const;

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

function u32(value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, value, true);
  return payload;
}

function textPayload(type: number, value: string): Uint8Array {
  return Uint8Array.from([
    type,
    value.length,
    ...[...value].map(character => character.charCodeAt(0)),
  ]);
}

function advancedPayload(pidProcessDenom = 2, motorProtocol = 7): Uint8Array {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, pidProcessDenom);
  view.setUint8(3, motorProtocol);
  view.setUint16(4, 480, true);
  view.setUint16(6, 550, true);
  view.setUint8(12, 48);
  view.setUint16(13, 125, true);
  view.setInt16(15, -4, true);
  view.setUint8(19, 70);
  return payload;
}

function rxPayload(cameraAngle = 10): Uint8Array {
  const payload = new Uint8Array(39);
  payload[22] = cameraAngle;
  return payload;
}

function buildPayload(): Uint8Array {
  const payload = new Uint8Array(30);
  const view = new DataView(payload.buffer);
  view.setUint16(26, 16413, true);
  view.setUint16(28, 0, true);
  return payload;
}

function statusPayload(armed: boolean): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29,
    0, 0, 0, 0, 0,
  ]);
}

function identification(apiMinor = 47): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
      apiVersion: {
        mspProtocolVersion: 0,
        apiVersionMajor: 1,
        apiVersionMinor: apiMinor,
      },
      board: { gyroSampleRateHz: 8000 },
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

function harness() {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = { identification: identification(), recovery: 'READY' as const };
  const coordinator: GeneralConfigurationSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({ sessionId, generation: 7 }),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  return {
    client,
    telemetry,
    state,
    controller: new GeneralConfigurationController({
      coordinator,
      appStateOwner: { getPhase: () => 'ACTIVE' },
      isMotorTestActive: () => false,
    }),
  };
}

function enqueueSnapshot(
  client: FakeClient,
  options: { featureMask?: number; pid?: number; motorProtocol?: number } = {},
) {
  client.enqueue(MSP_FEATURE_CONFIG, {
    payload: u32(options.featureMask ?? 0),
  });
  client.enqueue(MSP_BEEPER_CONFIG, { payload: new Uint8Array(9) });
  client.enqueue(MSP_ARMING_CONFIG, {
    payload: Uint8Array.from([5, 0, 25, 0]),
  });
  client.enqueue(
    MSP2_GET_TEXT,
    { payload: textPayload(2, 'QUAD') },
    { payload: textPayload(1, 'PILOT') },
  );
  client.enqueue(MSP_RX_CONFIG, { payload: rxPayload() });
  client.enqueue(MSP_ADVANCED_CONFIG, {
    payload: advancedPayload(options.pid, options.motorProtocol),
  });
  client.enqueue(MSP_BUILD_INFO, { payload: buildPayload() });
}

describe('GeneralConfigurationController', () => {
  it('loads all configuration groups under one telemetry pause lease', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    await expect(h.controller.load(key)).resolves.toMatchObject({
      kind: 'LOADED',
      snapshot: {
        craftName: 'QUAD',
        pilotName: 'PILOT',
        gyroSampleRateHz: 8000,
      },
    });
    expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
    expect(h.client.calls.map(call => call.command)).toEqual([
      MSP_FEATURE_CONFIG,
      MSP_BEEPER_CONFIG,
      MSP_ARMING_CONFIG,
      MSP2_GET_TEXT,
      MSP2_GET_TEXT,
      MSP_RX_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_BUILD_INFO,
    ]);
  });

  it('fails closed BELOW the reviewed MSP API, and opens above it', async () => {
    // This assertion changed deliberately. It used to demand
    // UNSUPPORTED_FIRMWARE for API 1.48 - an exact `!== 47` lock that
    // turned Betaflight 4.7 into a dead screen while Ports, GPS and
    // Receiver kept working on the same board. The floor is real and
    // still enforced; the ceiling was not, and every payload this screen
    // reads or writes was re-checked against 1.48 in
    // betaflightApiSupport.ts before it was removed.
    const below = harness();
    below.state.identification = identification(46);
    await expect(below.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(below.client.calls).toEqual([]);

    const above = harness();
    above.state.identification = identification(48);
    const result = (await above.controller.load(key)) as {kind: string; reason?: string};
    // It may still fail further along on this harness's scripting - what
    // it must not do is refuse the board for its version.
    expect(result.reason).not.toBe('UNSUPPORTED_FIRMWARE');
    expect(above.client.calls).not.toEqual([]);
  });

  it('rejects stale state before DISARMED proof or a write', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('expected loaded snapshot');
    enqueueSnapshot(h.client, { motorProtocol: 6 });
    await expect(
      h.controller.save(key, loaded.snapshot, {
        ...createGeneralConfigurationDraft(loaded.snapshot),
        featureMaskRaw: 2 ** 22,
      }),
    ).resolves.toEqual({ kind: 'REJECTED', reason: 'STALE_BASE' });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_FEATURE_CONFIG,
    );
  });

  it('never writes when the fresh flight-mode proof is ARMED', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('expected loaded snapshot');
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(true) });
    await expect(
      h.controller.save(key, loaded.snapshot, {
        ...createGeneralConfigurationDraft(loaded.snapshot),
        featureMaskRaw: 2 ** 22,
      }),
    ).resolves.toEqual({ kind: 'REJECTED', reason: 'FC_ARMED' });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_FEATURE_CONFIG,
    );
  });

  it('writes one changed group, persists once, verifies and reboots', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('expected loaded snapshot');
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP_SET_FEATURE_CONFIG, { payload: EMPTY });
    h.client.enqueue(MSP_EEPROM_WRITE, { payload: EMPTY });
    enqueueSnapshot(h.client, { featureMask: 2 ** 22 });
    h.client.enqueue(MSP_REBOOT, { payload: EMPTY });

    await expect(
      h.controller.save(key, loaded.snapshot, {
        ...createGeneralConfigurationDraft(loaded.snapshot),
        featureMaskRaw: 2 ** 22,
      }),
    ).resolves.toMatchObject({
      kind: 'SAVED_VERIFIED',
      rebootAcknowledged: true,
    });
    const commands = h.client.calls.map(call => call.command);
    expect(
      commands.filter(command => command === MSP_SET_FEATURE_CONFIG),
    ).toHaveLength(1);
    expect(commands.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(
      1,
    );
    expect(commands.indexOf(MSP_STATUS_EX)).toBeLessThan(
      commands.indexOf(MSP_SET_FEATURE_CONFIG),
    );
    expect(commands.at(-1)).toBe(MSP_REBOOT);
  });

  it('does not retry an ambiguous text write or persist afterward', async () => {
    const h = harness();
    enqueueSnapshot(h.client);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error('expected loaded snapshot');
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    h.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    h.client.enqueue(MSP2_SET_TEXT, { reject: { code: 'MSP_TIMEOUT' } });
    await expect(
      h.controller.save(key, loaded.snapshot, {
        ...createGeneralConfigurationDraft(loaded.snapshot),
        craftName: 'NEW',
      }),
    ).resolves.toEqual({ kind: 'UNCONFIRMED', stage: 'CRAFT_NAME' });
    expect(
      h.client.calls.filter(call => call.command === MSP2_SET_TEXT),
    ).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_EEPROM_WRITE,
    );
  });
});
