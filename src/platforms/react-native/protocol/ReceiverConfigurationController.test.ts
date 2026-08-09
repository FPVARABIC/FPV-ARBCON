import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {MSP_BOXIDS, MSP_EEPROM_WRITE, MSP_RSSI_CONFIG, MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_RX_MAP, MSP_STATUS_EX} from '../../../core/protocol/msp/commands/mspCommands';
import {createReceiverConfigurationDraft, type ReceiverConfigurationSnapshot} from '../../../core/state/receiverConfigurationModel';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {ReceiverConfigurationController, type ReceiverSessionCoordinator} from './ReceiverConfigurationController';

type Script = {payload: Uint8Array} | {reject: unknown}; const EMPTY = new Uint8Array(0); const key = {sessionId: 'receiver-fc', generation: 4} as const;
class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = []; private readonly scripts = new Map<number, Script[]>();
  getEpoch() { return 1; }
  enqueue(command: number, ...scripts: Script[]) { this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]); }
  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> { this.calls.push({command, payload, options}); const script = this.scripts.get(command)?.shift(); if (script !== undefined && 'reject' in script) throw script.reject; return {protocolVersion: 'v1', wireFormat: options.wireFormat, direction: 'response', command, flags: 0, payload: script?.payload ?? EMPTY}; }
}
function rxPayload(): Uint8Array { const bytes = new Uint8Array(39); const view = new DataView(bytes.buffer); bytes[0] = 9; view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true); view.setUint16(8, 885, true); view.setUint16(10, 2115, true); bytes[27] = 30; bytes[30] = 30; bytes[31] = 1; return bytes; }
function statusPayload(armed: boolean): Uint8Array { return Uint8Array.from([0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]); }
function identification(identifier = 'BTFL'): MspIdentificationState { return {status: 'SUCCEEDED', identity: {firmware: {identifier, knownFamily: identifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV'}, apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47}, board: {}}} as MspIdentificationState; }
function scheduler(): MspTelemetryScheduler { return {acquirePauseLease: jest.fn(() => ({release: jest.fn()})), discardPendingDemands: jest.fn(), waitUntilIdle: jest.fn(() => Promise.resolve()), requestRefresh: jest.fn()} as unknown as MspTelemetryScheduler; }
function harness(options: {motorTest?: boolean} = {}) {
  const client = new FakeClient(); const telemetry = scheduler(); const state = {identification: identification(), generation: 4, ownership: 'ACTIVE' as const, recovery: 'READY' as const};
  const coordinator: ReceiverSessionCoordinator = {getOwnershipState: () => state.ownership, getIdentificationState: () => state.identification, getSessionKey: sessionId => ({sessionId, generation: state.generation}), getActiveMspClient: () => client, getTelemetryScheduler: () => telemetry, getMspRecoveryState: () => state.recovery};
  return {client, telemetry, state, controller: new ReceiverConfigurationController({coordinator, appStateOwner: {getPhase: () => 'ACTIVE'}, isMotorTestActive: () => options.motorTest === true})};
}
function enqueueSnapshot(client: FakeClient, map = [0, 1, 3, 2, 4, 5, 6, 7]) { client.enqueue(MSP_RX_CONFIG, {payload: rxPayload()}); client.enqueue(MSP_RX_MAP, {payload: Uint8Array.from(map)}); client.enqueue(MSP_RSSI_CONFIG, {payload: Uint8Array.from([0])}); client.enqueue(MSP_RC_DEADBAND, {payload: Uint8Array.from([2, 3, 4, 5, 0])}); }
async function loadOriginal(h: ReturnType<typeof harness>): Promise<ReceiverConfigurationSnapshot> { enqueueSnapshot(h.client); const out = await h.controller.load(key); if (out.kind !== 'LOADED') throw new Error(out.kind); return out.snapshot; }

describe('ReceiverConfigurationController', () => {
  it('loads all receiver groups under one exclusive telemetry pause', async () => { const h = harness(); const snapshot = await loadOriginal(h); expect(snapshot.rx.serialRxProvider).toBe(9); expect(snapshot.channelMap).toEqual([0, 1, 3, 2, 4, 5, 6, 7]); expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1); });
  it('fails closed before I/O for unsupported firmware and motor-test activity', async () => { const unsupported = harness(); unsupported.state.identification = identification('INAV'); await expect(unsupported.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_FIRMWARE'}); expect(unsupported.client.calls).toEqual([]); const motors = harness({motorTest: true}); await expect(motors.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'}); expect(motors.client.calls).toEqual([]); });
  it('rejects ARMED before a receiver write', async () => { const h = harness(); const original = await loadOriginal(h); enqueueSnapshot(h.client); h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])}); h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(true)}); const draft = {...createReceiverConfigurationDraft(original), channelMapText: 'TAER1234'}; await expect(h.controller.save(key, original, draft)).resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'}); expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_RX_MAP); });
  it('writes once, persists, and accepts only matching readback', async () => { const h = harness(); const original = await loadOriginal(h); enqueueSnapshot(h.client); h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])}); h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)}); h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY}); h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY}); enqueueSnapshot(h.client, [1, 2, 3, 0, 4, 5, 6, 7]); const draft = {...createReceiverConfigurationDraft(original), channelMapText: 'TAER1234'}; await expect(h.controller.save(key, original, draft)).resolves.toEqual(expect.objectContaining({kind: 'SAVED_VERIFIED'})); expect(h.client.calls.filter(call => call.command === MSP_SET_RX_MAP)).toHaveLength(1); expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1); });
});
