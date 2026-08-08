import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {MSP_ADVANCED_CONFIG, MSP_BOXIDS, MSP_EEPROM_WRITE, MSP_FILTER_CONFIG, MSP_PID, MSP_PID_ADVANCED, MSP_RC_TUNING, MSP_SET_FILTER_CONFIG, MSP_SET_PID, MSP_SET_PID_ADVANCED, MSP_SET_RC_TUNING, MSP_STATUS_EX} from '../../../core/protocol/msp/commands/mspCommands';
import {createPidTuningDraft} from '../../../core/state/pidTuningModel';
import type {MspPidTuningSnapshot} from '../../../core/protocol/msp/decoding/decodePidTuning';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {PidTuningController, type PidSessionCoordinator} from './PidTuningController';

type Script = {payload: Uint8Array} | {reject: unknown}; const EMPTY = new Uint8Array(0); const key = {sessionId: 'pid-fc', generation: 4} as const;
class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = []; private readonly scripts = new Map<number, Script[]>();
  getEpoch() { return 1; }
  enqueue(command: number, ...scripts: Script[]) { this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]); }
  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> { this.calls.push({command, payload, options}); const script = this.scripts.get(command)?.shift(); if (script !== undefined && 'reject' in script) throw script.reject; return {protocolVersion: 'v1', wireFormat: options.wireFormat, direction: 'response', command, flags: 0, payload: script?.payload ?? EMPTY}; }
}
function statusPayload(armed: boolean, pidProfileIndex = 0, controlRateProfileIndex = 0, pidProfileCount = 3): Uint8Array {
  const bytes = new Uint8Array(22);
  bytes[6] = armed ? 1 : 0;
  bytes[10] = pidProfileIndex;
  bytes[13] = pidProfileCount;
  bytes[14] = controlRateProfileIndex;
  bytes[15] = 0; // no flight-mode extension bytes
  bytes[16] = 29; // arming-disable flag count
  return bytes;
}
function identification(identifier = 'BTFL', minor = 47): MspIdentificationState { return {status: 'SUCCEEDED', identity: {firmware: {identifier, knownFamily: identifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV'}, apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: minor}, board: {gyroSampleRateHz: 8000}}} as MspIdentificationState; }
function scheduler(): MspTelemetryScheduler { return {acquirePauseLease: jest.fn(() => ({release: jest.fn()})), discardPendingDemands: jest.fn(), waitUntilIdle: jest.fn(() => Promise.resolve()), requestRefresh: jest.fn()} as unknown as MspTelemetryScheduler; }
function harness(options: {motorTest?: boolean} = {}) {
  const client = new FakeClient(); const telemetry = scheduler(); const state = {identification: identification(), generation: 4, ownership: 'ACTIVE' as const, recovery: 'READY' as const};
  const coordinator: PidSessionCoordinator = {getOwnershipState: () => state.ownership, getIdentificationState: () => state.identification, getSessionKey: sessionId => ({sessionId, generation: state.generation}), getActiveMspClient: () => client, getTelemetryScheduler: () => telemetry, getMspRecoveryState: () => state.recovery};
  return {client, telemetry, state, controller: new PidTuningController({coordinator, appStateOwner: {getPhase: () => 'ACTIVE'}, isMotorTestActive: () => options.motorTest === true})};
}
function pidPayload(rollP = 42): Uint8Array { return Uint8Array.from([rollP, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]); }
function advancedPayload(yawF = 140): Uint8Array { const bytes = new Uint8Array(61); const view = new DataView(bytes.buffer); view.setUint16(32, 120, true); view.setUint16(34, 130, true); view.setUint16(36, yawF, true); return bytes; }
function generalAdvancedPayload(pidProcessDenom = 2): Uint8Array { const bytes = new Uint8Array(20); bytes[0] = 1; bytes[1] = pidProcessDenom; return bytes; }
function ratesPayload(rollRcRate = 100): Uint8Array { const bytes = new Uint8Array(24); bytes[0] = rollRcRate; bytes[12] = 100; bytes[11] = 100; bytes[14] = 0; bytes[15] = 100; const view = new DataView(bytes.buffer); view.setUint16(16, 1998, true); view.setUint16(18, 1998, true); view.setUint16(20, 1998, true); bytes[22] = 0; bytes[23] = 50; return bytes; }
function filterPayload(gyroStaticHz = 0): Uint8Array { const bytes = new Uint8Array(49); new DataView(bytes.buffer).setUint16(20, gyroStaticHz, true); return bytes; }
function enqueueSnapshot(client: FakeClient, rollP = 42, yawF = 140, rollRcRate = 100, gyroStaticHz = 0, pidProfileIndex = 0, controlRateProfileIndex = 0) { client.enqueue(MSP_PID, {payload: pidPayload(rollP)}); client.enqueue(MSP_PID_ADVANCED, {payload: advancedPayload(yawF)}); client.enqueue(MSP_RC_TUNING, {payload: ratesPayload(rollRcRate)}); client.enqueue(MSP_FILTER_CONFIG, {payload: filterPayload(gyroStaticHz)}); client.enqueue(MSP_ADVANCED_CONFIG, {payload: generalAdvancedPayload()}); client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false, pidProfileIndex, controlRateProfileIndex)}); }
async function loadOriginal(h: ReturnType<typeof harness>): Promise<MspPidTuningSnapshot> { enqueueSnapshot(h.client); const outcome = await h.controller.load(key); if (outcome.kind !== 'LOADED') throw new Error(outcome.kind); return outcome.snapshot; }

describe('PidTuningController', () => {
  it('loads PID, advanced, rates and filters under one exclusive telemetry pause', async () => { const h = harness(); const snapshot = await loadOriginal(h); expect(snapshot.terms[0].p).toBe(42); expect(snapshot.feedforward).toEqual([120, 130, 140]); expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1); });
  it('fails closed before I/O for unsupported API and motor-test activity', async () => { const unsupported = harness(); unsupported.state.identification = identification('BTFL', 46); await expect(unsupported.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_FIRMWARE'}); expect(unsupported.client.calls).toEqual([]); const motors = harness({motorTest: true}); await expect(motors.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'}); expect(motors.client.calls).toEqual([]); });
  it('rejects ARMED before any PID write', async () => { const h = harness(); const original = await loadOriginal(h); enqueueSnapshot(h.client); h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])}); h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(true)}); const base = createPidTuningDraft(original); const draft = {...base, roll: {...base.roll, p: 50}}; await expect(h.controller.save(key, original, draft)).resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'}); expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_PID); });
  it('writes each changed group once, persists once, and accepts matching readback only', async () => { const h = harness(); const original = await loadOriginal(h); enqueueSnapshot(h.client); h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])}); h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)}); h.client.enqueue(MSP_SET_PID, {payload: EMPTY}); h.client.enqueue(MSP_SET_PID_ADVANCED, {payload: EMPTY}); h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY}); enqueueSnapshot(h.client, 50, 222); const base = createPidTuningDraft(original); const draft = {...base, roll: {...base.roll, p: 50}, yaw: {...base.yaw, f: 222}}; await expect(h.controller.save(key, original, draft)).resolves.toEqual(expect.objectContaining({kind: 'SAVED_VERIFIED'})); expect(h.client.calls.filter(call => call.command === MSP_SET_PID)).toHaveLength(1); expect(h.client.calls.filter(call => call.command === MSP_SET_PID_ADVANCED)).toHaveLength(1); expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1); });

  it('writes changed Rates and Filters once each and verifies their readback', async () => {
    const h = harness(); const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_RC_TUNING, {payload: EMPTY});
    h.client.enqueue(MSP_SET_FILTER_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueSnapshot(h.client, 42, 140, 120, 300);
    const base = createPidTuningDraft(original);
    const draft = {
      ...base,
      rates: {...base.rates, roll: {...base.rates.roll, rcRate: 120}},
      filters: {...base.filters, gyroLpf1StaticHz: 300},
    };

    await expect(h.controller.save(key, original, draft)).resolves.toEqual(expect.objectContaining({kind: 'SAVED_VERIFIED'}));
    expect(h.client.calls.filter(call => call.command === MSP_SET_RC_TUNING)).toHaveLength(1);
    expect(h.client.calls.filter(call => call.command === MSP_SET_FILTER_CONFIG)).toHaveLength(1);
    expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1);
  });

  it('rejects a filter edit before writes when loop-rate evidence is unavailable', async () => {
    const h = harness();
    const identified = identification();
    if (identified.status !== 'SUCCEEDED') throw new Error('Expected identified fixture');
    h.state.identification = {...identified, identity: {...identified.identity, board: {...identified.identity.board, gyroSampleRateHz: undefined}}};
    enqueueSnapshot(h.client);
    const outcome = await h.controller.load(key);
    if (outcome.kind !== 'LOADED') throw new Error(outcome.kind);
    const base = createPidTuningDraft(outcome.snapshot);
    const draft = {...base, filters: {...base.filters, gyroLpf1StaticHz: 300}};

    await expect(h.controller.save(key, outcome.snapshot, draft)).resolves.toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_FILTER_CONFIG);
  });

  it('rejects a stale baseline before armed-state acquisition or writes', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client, 43);
    const base = createPidTuningDraft(original);
    const draft = {...base, roll: {...base.roll, p: 50}};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_BOXIDS);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_PID);
  });

  it('rejects a PID or Rates profile switch before armed-state acquisition or writes', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client, 42, 140, 100, 0, 1, 2);
    const base = createPidTuningDraft(original);
    const draft = {...base, roll: {...base.roll, p: 50}};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_BOXIDS);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_PID);
  });

  it('reports an ambiguous PID write as unconfirmed and never retries it', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_PID, {reject: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'})});
    const base = createPidTuningDraft(original);
    const draft = {...base, roll: {...base.roll, p: 50}};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'UNCONFIRMED',
      stage: 'PID',
    });
    expect(h.client.calls.filter(call => call.command === MSP_SET_PID)).toHaveLength(1);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does not claim verified success when readback differs from the saved draft', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_PID, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueSnapshot(h.client, 49);
    const base = createPidTuningDraft(original);
    const draft = {...base, roll: {...base.roll, p: 50}};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual(
      expect.objectContaining({kind: 'SAVED_UNVERIFIED'}),
    );
  });
});
