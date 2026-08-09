import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BOXIDS,
  MSP_BOXNAMES,
  MSP_EEPROM_WRITE,
  MSP_MODE_RANGES,
  MSP_MODE_RANGES_EXTRA,
  MSP_SET_MODE_RANGE,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {createModesConfigurationDraft, type ModesConfigurationDraft} from '../../../core/state/modesConfigurationModel';
import type {MspModesConfiguration} from '../../../core/protocol/msp/decoding/decodeModes';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {ModesConfigurationController, type ModesSessionCoordinator} from './ModesConfigurationController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'modes-fc', generation: 8} as const;
const NAMES = Uint8Array.from([...Buffer.from('ARM;ANGLE;BEEPER;', 'ascii')]);
const IDS = Uint8Array.from([0, 1, 13]);

class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = [];
  private readonly scripts = new Map<number, Script[]>();
  getEpoch() { return 1; }
  enqueue(command: number, ...scripts: Script[]) {
    this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]);
  }
  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) throw script.reject;
    return {protocolVersion: 'v1', wireFormat: options.wireFormat, direction: 'response', command, flags: 0, payload: script?.payload ?? EMPTY};
  }
}

function tables(range?: {aux: number; startStep: number; endStep: number; logic: 0 | 1}) {
  const ranges = new Uint8Array(20 * 4);
  const extra = new Uint8Array(1 + 20 * 3);
  extra[0] = 20;
  if (range !== undefined) {
    ranges.set([1, range.aux, range.startStep, range.endStep], 0);
    extra.set([1, range.logic, 0], 1);
  }
  return {ranges, extra};
}

function enqueueSnapshot(client: FakeClient, range?: {aux: number; startStep: number; endStep: number; logic: 0 | 1}) {
  const payloads = tables(range);
  client.enqueue(MSP_BOXNAMES, {payload: NAMES});
  client.enqueue(MSP_BOXIDS, {payload: IDS});
  client.enqueue(MSP_MODE_RANGES, {payload: payloads.ranges});
  client.enqueue(MSP_MODE_RANGES_EXTRA, {payload: payloads.extra});
}

function statusPayload(armed: boolean): Uint8Array {
  return Uint8Array.from([0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]);
}

function identification(identifier = 'BTFL'): MspIdentificationState {
  return {status: 'SUCCEEDED', identity: {firmware: {identifier, knownFamily: identifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV'}, apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47}, board: {}}} as MspIdentificationState;
}

function scheduler(): MspTelemetryScheduler {
  return {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
}

function harness(options: {motorTest?: boolean} = {}) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {identification: identification(), generation: 8, ownership: 'ACTIVE' as const, recovery: 'READY' as const};
  const coordinator: ModesSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({sessionId, generation: state.generation}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  return {
    client,
    telemetry,
    state,
    controller: new ModesConfigurationController({
      coordinator,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => options.motorTest === true,
    }),
  };
}

async function loadOriginal(h: ReturnType<typeof harness>): Promise<MspModesConfiguration> {
  enqueueSnapshot(h.client);
  const outcome = await h.controller.load(key);
  if (outcome.kind !== 'LOADED') throw new Error(outcome.kind);
  return outcome.snapshot;
}

function changedDraft(original: MspModesConfiguration): ModesConfigurationDraft {
  return {
    ...createModesConfigurationDraft(original),
    conditions: [{kind: 'RANGE', permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600, logic: 1}],
  };
}

describe('ModesConfigurationController', () => {
  it('loads all four official mode groups under one telemetry pause', async () => {
    const h = harness();
    const snapshot = await loadOriginal(h);
    expect(snapshot.capacity).toBe(20);
    expect(snapshot.definitions.map(item => item.name)).toEqual(['ARM', 'ANGLE', 'BEEPER']);
    expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
  });

  it('fails closed before I/O for unsupported firmware and motor testing', async () => {
    const unsupported = harness();
    unsupported.state.identification = identification('INAV');
    await expect(unsupported.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_FIRMWARE'});
    expect(unsupported.client.calls).toEqual([]);
    const motors = harness({motorTest: true});
    await expect(motors.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    expect(motors.client.calls).toEqual([]);
  });

  it('rejects ARMED before the first mode-range write', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: IDS});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(true)});
    await expect(h.controller.save(key, original, changedDraft(original))).resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_MODE_RANGE);
  });

  it('rejects invalid drafts and stale baselines without writing', async () => {
    const invalid = harness();
    const invalidOriginal = await loadOriginal(invalid);
    const bad: ModesConfigurationDraft = {conditions: [{kind: 'RANGE', permanentId: 1, auxChannelIndex: 99, start: 1200, end: 1600, logic: 0}]};
    await expect(invalid.controller.save(key, invalidOriginal, bad)).resolves.toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(invalid.client.calls.map(call => call.command)).not.toContain(MSP_SET_MODE_RANGE);

    const stale = harness();
    const staleOriginal = await loadOriginal(stale);
    enqueueSnapshot(stale.client, {aux: 0, startStep: 16, endStep: 32, logic: 0});
    await expect(stale.controller.save(key, staleOriginal, changedDraft(staleOriginal))).resolves.toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});
    expect(stale.client.calls.map(call => call.command)).not.toContain(MSP_SET_MODE_RANGE);
  });

  it('does not retry an ambiguous indexed write or continue to EEPROM', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: IDS});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_MODE_RANGE, {reject: Object.assign(new Error('timeout'), {code: 'MSP_RESPONSE_TIMEOUT'})});
    await expect(h.controller.save(key, original, changedDraft(original))).resolves.toEqual({kind: 'UNCONFIRMED', stage: {kind: 'MODE_RANGE', index: 0}});
    expect(h.client.calls.filter(call => call.command === MSP_SET_MODE_RANGE)).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('writes all twenty indexed rows once, persists once and verifies readback', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: IDS});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_MODE_RANGE, ...Array.from({length: 20}, () => ({payload: EMPTY})));
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueSnapshot(h.client, {aux: 2, startStep: 12, endStep: 28, logic: 1});
    await expect(h.controller.save(key, original, changedDraft(original))).resolves.toEqual(expect.objectContaining({kind: 'SAVED_VERIFIED'}));
    const writes = h.client.calls.filter(call => call.command === MSP_SET_MODE_RANGE);
    expect(writes).toHaveLength(20);
    expect([...writes[0].payload]).toEqual([0, 1, 2, 12, 28, 1, 0]);
    expect([...writes[19].payload]).toEqual([19, 0, 0, 0, 0, 0, 0]);
    expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1);
  });
});
