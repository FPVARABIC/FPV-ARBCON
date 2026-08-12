import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {MSP_BOXIDS, MSP_EEPROM_WRITE, MSP_FEATURE_CONFIG, MSP_REBOOT, MSP_RSSI_CONFIG, MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_FEATURE_CONFIG, MSP_SET_RX_CONFIG, MSP_SET_RX_MAP, MSP_STATUS_EX, MSP_TX_INFO, MSP2_COMMON_SERIAL_CONFIG, MSP2_COMMON_SET_SERIAL_CONFIG} from '../../../core/protocol/msp/commands/mspCommands';
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
function statusPayload(armed: boolean, options: {rebootRequired?: boolean; armingDisableFlags?: number} = {}): Uint8Array {
  const bytes = Uint8Array.from([0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]);
  // Index 16 is ARMING_DISABLE_FLAGS_COUNT, 17-20 the u32 mask, 21 the
  // config-state byte whose bit 0 is getRebootRequired() (msp.c:1130).
  new DataView(bytes.buffer).setUint32(17, options.armingDisableFlags ?? 0, true);
  bytes[21] = options.rebootRequired === true ? 1 : 0;
  return bytes;
}
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

/**
 * RECEIVER P2. The defect these pin: read-back equality proved only that
 * the flight controller STORED the values. For the five rc_smoothing
 * fields the firmware also raises its own reboot-required flag, so the
 * stored value is not the value in force - and the pre-P2 controller
 * reported that as a plain verified success.
 */
describe('Receiver P2 - reboot truth', () => {
  const smoothingDraft = (original: ReceiverConfigurationSnapshot) => ({
    ...createReceiverConfigurationDraft(original),
    // rc_smoothing_auto_factor_rpy - msp.c:3807, a configRebootUpdateCheckU8 field.
    setpointAutoFactor: 40,
  });

  /** Queues the disarm proof, the RX_CONFIG write, EEPROM, and a readback
   * that matches the smoothing draft. `rebootRequired` is what the FC
   * reports on the post-save status read. */
  function queueSmoothingSave(h: ReturnType<typeof harness>, rebootRequired: boolean | 'unreadable') {
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_RX_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    const readback = rxPayload();
    readback[30] = 40; // the saved rc_smoothing_auto_factor_rpy
    h.client.enqueue(MSP_RX_CONFIG, {payload: readback});
    h.client.enqueue(MSP_RX_MAP, {payload: Uint8Array.from([0, 1, 3, 2, 4, 5, 6, 7])});
    h.client.enqueue(MSP_RSSI_CONFIG, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_RC_DEADBAND, {payload: Uint8Array.from([2, 3, 4, 5, 0])});
    h.client.enqueue(
      MSP_STATUS_EX,
      rebootRequired === 'unreadable'
        ? {reject: new Error('status unavailable')}
        : {payload: statusPayload(false, {rebootRequired})},
    );
  }

  it('P2-X item 7: a matching readback is NOT reported as applied when the FC says reboot required', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSmoothingSave(h, true);
    const outcome = await h.controller.save(key, original, smoothingDraft(original));
    expect(outcome.kind).toBe('SAVED_REBOOT_REQUIRED');
    expect(outcome).toMatchObject({evidence: 'FC_REPORTED'});
    // The write and the persist both genuinely happened - this is not a
    // failure path, it is a truthful success that is not yet in force.
    expect(h.client.calls.filter(call => call.command === MSP_SET_RX_CONFIG)).toHaveLength(1);
    expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1);
  });

  it('falls back to the changed-field expectation when the reboot flag cannot be re-read', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSmoothingSave(h, 'unreadable');
    // Conservative on purpose: an unnecessary reboot is safe, a change
    // reported as live when it is not, is not.
    await expect(h.controller.save(key, original, smoothingDraft(original))).resolves.toMatchObject({
      kind: 'SAVED_REBOOT_REQUIRED',
      evidence: 'EXPECTED_UNCONFIRMED',
    });
  });

  it('P2-X item 6: a non-reboot-sensitive change with a clean FC flag stays a plain verified save', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueSnapshot(h.client, [1, 2, 3, 0, 4, 5, 6, 7]);
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false, {rebootRequired: false})});
    await expect(
      h.controller.save(key, original, {...createReceiverConfigurationDraft(original), channelMapText: 'TAER1234'}),
    ).resolves.toMatchObject({kind: 'SAVED_VERIFIED'});
  });

  it('P2-X items 1-4: the write is read-modify-write, preserves unowned RX_CONFIG bytes, and persists only after it', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSmoothingSave(h, false);
    await h.controller.save(key, original, smoothingDraft(original));
    const commands = h.client.calls.map(call => call.command);
    // A fresh RX_CONFIG read precedes the write (stale-base check).
    expect(commands.indexOf(MSP_RX_CONFIG)).toBeLessThan(commands.indexOf(MSP_SET_RX_CONFIG));
    // EEPROM strictly after the configuration write.
    expect(commands.indexOf(MSP_SET_RX_CONFIG)).toBeLessThan(commands.indexOf(MSP_EEPROM_WRITE));
    const written = h.client.calls.find(call => call.command === MSP_SET_RX_CONFIG)!.payload;
    const base = rxPayload();
    expect(written).toHaveLength(39);
    expect(written[30]).toBe(40); // the field we own, changed
    // Every byte this screen does not own survives untouched - including
    // the serial provider (0) and the ExpressLRS tail (32-38).
    for (const index of [0, 7, 16, 17, 18, 19, 20, 21, 22, 29, 32, 33, 34, 35, 36, 37, 38]) {
      expect(written[index]).toBe(base[index]);
    }
  });

  it('P2-X item 3: refuses instead of overwriting when another controller changed RX_CONFIG underneath', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const moved = rxPayload();
    moved[22] = 42; // fpvCamAngleDegrees - owned by General Configurations
    h.client.enqueue(MSP_RX_CONFIG, {payload: moved});
    h.client.enqueue(MSP_RX_MAP, {payload: Uint8Array.from([0, 1, 3, 2, 4, 5, 6, 7])});
    h.client.enqueue(MSP_RSSI_CONFIG, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_RC_DEADBAND, {payload: Uint8Array.from([2, 3, 4, 5, 0])});
    await expect(h.controller.save(key, original, smoothingDraft(original))).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_RX_CONFIG);
  });
});

describe('Receiver P2 - canonical reboot action', () => {
  it('P2-X items 8-9: proves DISARMED, then issues the canonical MSP_REBOOT', async () => {
    const h = harness();
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REBOOT_REQUESTED'});
    expect(h.client.calls.filter(call => call.command === MSP_REBOOT)).toHaveLength(1);
  });

  it('refuses to reboot an ARMED flight controller', async () => {
    const h = harness();
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(true)});
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_REBOOT);
  });

  it('P2-X item 10: a link that vanishes as the board reboots is still a requested reboot, not a failure', async () => {
    const h = harness();
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_REBOOT, {reject: new Error('transport closed')});
    // Success here means "the request was accepted", never "the flight
    // controller came back" - reconnection is a separate observable event.
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REBOOT_REQUESTED'});
  });

  it('refuses a reboot when the session is not usable', async () => {
    const h = harness();
    h.state.ownership = 'IDLE' as never;
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REJECTED', reason: 'DISCONNECTED'});
    expect(h.client.calls).toEqual([]);
  });
});

describe('Receiver P2 - runtime truth read (read-only)', () => {
  function queueRuntime(h: ReturnType<typeof harness>, featureMask: number, options: {ports?: Uint8Array; txInfo?: Uint8Array | 'reject'} = {}) {
    const feature = new Uint8Array(4);
    new DataView(feature.buffer).setUint32(0, featureMask, true);
    h.client.enqueue(MSP_FEATURE_CONFIG, {payload: feature});
    if (options.ports !== undefined) h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {payload: options.ports});
    h.client.enqueue(MSP_TX_INFO, options.txInfo === 'reject' ? {reject: new Error('unsupported')} : {payload: options.txInfo ?? Uint8Array.from([6, 0])});
  }
  /** Count byte, then one 9-byte record: identifier, u32 function mask,
   * four baud indexes - the layout decodeSerialPorts expects. */
  function portsPayload(...ports: ReadonlyArray<readonly [number, number]>): Uint8Array {
    const bytes = new Uint8Array(1 + ports.length * 9);
    bytes[0] = ports.length;
    const view = new DataView(bytes.buffer);
    ports.forEach(([identifier, functionMask], index) => {
      const at = 1 + index * 9;
      bytes[at] = identifier;
      view.setUint32(at + 1, functionMask, true);
    });
    return bytes;
  }

  it('P2-X items 11/22: derives SERIAL from the feature mask and keeps CRSF named CRSF', async () => {
    const h = harness();
    queueRuntime(h, 2 ** 3, {ports: portsPayload([1, 2 ** 6])});
    const outcome = await h.controller.readRuntime(key);
    expect(outcome).toMatchObject({
      kind: 'READ',
      runtime: {
        mode: 'SERIAL',
        providerMeaningful: true,
        portDependency: {kind: 'SERIAL_RX_READY', portIdentifier: 1},
        rssiSource: {kind: 'KNOWN', token: 'RX_PROTOCOL_CRSF'},
      },
    });
    // No ExpressLRS pseudo-provider is invented anywhere in the result.
    expect(JSON.stringify(outcome)).not.toContain('ELRS');
    expect(JSON.stringify(outcome)).not.toContain('ExpressLRS');
  });

  it('P2-X item 24: serial mode with no Serial RX UART reports the mismatch', async () => {
    const h = harness();
    queueRuntime(h, 2 ** 3, {ports: portsPayload([1, 2 ** 0])});
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ',
      runtime: {mode: 'SERIAL', portDependency: {kind: 'SERIAL_RX_UART_MISSING'}},
    });
  });

  it('P2-X item 25: a non-serial mode never even reads Ports', async () => {
    const h = harness();
    queueRuntime(h, 2 ** 25); // RX_SPI
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ',
      runtime: {mode: 'SPI', providerMeaningful: false, portDependency: {kind: 'NOT_APPLICABLE', mode: 'SPI'}},
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP2_COMMON_SERIAL_CONFIG);
  });

  it('P2-X item 35: a board that cannot answer MSP_TX_INFO reports UNAVAILABLE, never a guess', async () => {
    const h = harness();
    queueRuntime(h, 2 ** 3, {ports: portsPayload([1, 2 ** 6]), txInfo: 'reject'});
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ',
      runtime: {rssiSource: {kind: 'UNAVAILABLE'}},
    });
  });

  it('P2-X item 26/33: the runtime read never writes anything, to Receiver or to Ports', async () => {
    const h = harness();
    queueRuntime(h, 2 ** 3, {ports: portsPayload([1, 2 ** 6])});
    await h.controller.readRuntime(key);
    const written = h.client.calls.map(call => call.command);
    for (const write of [MSP_SET_RX_MAP, MSP_SET_RX_CONFIG, MSP_EEPROM_WRITE, MSP_REBOOT, MSP2_COMMON_SET_SERIAL_CONFIG, MSP_SET_FEATURE_CONFIG]) {
      expect(written).not.toContain(write);
    }
  });

  it('P2-X item 42: a busy configuration transaction is refused, not queued behind', async () => {
    const h = harness({motorTest: true});
    await expect(h.controller.readRuntime(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    expect(h.client.calls).toEqual([]);
  });
});

/**
 * RECEIVER P2 CLOSURE - reboot attribution and save-interruption
 * taxonomy.
 *
 * The rule these enforce: uncertainty is never collapsed into success,
 * and a transport failure is only attributed to the reboot when the
 * reboot was actually submitted.
 */
describe('Receiver P2 closure - reboot attribution', () => {
  function queueDisarmProof(h: ReturnType<typeof harness>) {
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
  }
  const notSentError = (code: string) => Object.assign(new Error(code), {code});

  it.each([
    ['MSP_ENCODE_FAILED'],
    ['MSP_QUEUE_FULL'],
    ['MSP_TRANSPORT_QUEUE_FULL'],
    ['MSP_RECOVERY_REQUIRED'],
    ['MSP_RECOVERING'],
    ['MSP_REMOTE_ERROR'],
  ])('A: %s proves the reboot never reached the wire, so it is NOT reported as accepted', async code => {
    const h = harness();
    queueDisarmProof(h);
    h.client.enqueue(MSP_REBOOT, {reject: notSentError(code)});
    const outcome = await h.controller.requestReboot(key);
    expect(outcome.kind).not.toBe('REBOOT_REQUESTED');
    expect(outcome.kind).toBe('FAILED');
  });

  it('B: a transport that dies with an ambiguous error AFTER submission is attributed to the reboot', async () => {
    const h = harness();
    queueDisarmProof(h);
    // A timeout carries no "never sent" guarantee: the frame may well
    // have been delivered and the board stopped answering because it is
    // rebooting. That is the case EXPECT_REBOOT exists for.
    h.client.enqueue(MSP_REBOOT, {reject: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'})});
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REBOOT_REQUESTED'});
    expect(h.client.calls.filter(call => call.command === MSP_REBOOT)).toHaveLength(1);
  });

  it('A: a session lost BEFORE the reboot is dispatched never reports an accepted reboot', async () => {
    const h = harness();
    h.state.ownership = 'IDLE' as never;
    const outcome = await h.controller.requestReboot(key);
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'DISCONNECTED'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_REBOOT);
  });

  it('A: a link already recovering is refused before any reboot is attempted', async () => {
    const h = harness();
    h.state.recovery = 'RECOVERING' as never;
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REJECTED', reason: 'LINK_RECOVERING'});
    expect(h.client.calls).toEqual([]);
  });

  it('A: an unprovable armed state blocks the reboot rather than guessing', async () => {
    const h = harness();
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {reject: new Error('status gone')});
    const outcome = await h.controller.requestReboot(key);
    expect(outcome.kind).not.toBe('REBOOT_REQUESTED');
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_REBOOT);
  });

  it('C: a generation change mid-operation cannot report an accepted reboot', async () => {
    const h = harness();
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    // The board is replaced while the disarm proof is in flight; the
    // delayed pre-reboot response must not authorise the new session.
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.state.generation = 99;
    const outcome = await h.controller.requestReboot(key);
    expect(outcome.kind).not.toBe('REBOOT_REQUESTED');
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_REBOOT);
  });

  it('D: REBOOT_REQUESTED carries no claim of rebooting or reconnecting', async () => {
    const h = harness();
    queueDisarmProof(h);
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});
    const outcome = await h.controller.requestReboot(key);
    // The union has exactly one success shape and it carries no payload:
    // there is nothing in the type that could assert the board came back.
    expect(outcome).toEqual({kind: 'REBOOT_REQUESTED'});
    expect(Object.keys(outcome)).toEqual(['kind']);
  });
});

describe('Receiver P2 closure - save interruption taxonomy', () => {
  const draftFor = (original: ReceiverConfigurationSnapshot) => ({
    ...createReceiverConfigurationDraft(original),
    channelMapText: 'TAER1234',
  });
  function queueToDisarmProof(h: ReturnType<typeof harness>) {
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
  }

  it('1: disconnect before the save starts - nothing is attempted', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.state.ownership = 'IDLE' as never;
    const before = h.client.calls.length;
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'DISCONNECTED',
    });
    expect(h.client.calls.length).toBe(before);
  });

  it('2: failure during the pre-write fresh read - nothing persisted', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.client.enqueue(MSP_RX_CONFIG, {reject: new Error('link lost')});
    const outcome = await h.controller.save(key, original, draftFor(original));
    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    expect(outcome.kind).not.toBe('SAVED_REBOOT_REQUIRED');
    const commands = h.client.calls.map(call => call.command);
    expect(commands).not.toContain(MSP_SET_RX_MAP);
    expect(commands).not.toContain(MSP_EEPROM_WRITE);
  });

  it('3: an ambiguous failure DURING the configuration write is UNCONFIRMED, naming the stage', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueToDisarmProof(h);
    h.client.enqueue(MSP_SET_RX_MAP, {reject: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'})});
    // Not "failed" and certainly not "saved": the write may or may not
    // have landed, and the operator is told not to retry blindly.
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toEqual({
      kind: 'UNCONFIRMED',
      stage: 'RX_MAP',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('3b: a write that provably never reached the wire is a plain failure, not an ambiguous one', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueToDisarmProof(h);
    h.client.enqueue(MSP_SET_RX_MAP, {reject: Object.assign(new Error('queue full'), {code: 'MSP_QUEUE_FULL'})});
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toMatchObject({kind: 'FAILED'});
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('4: an ambiguous failure at the EEPROM step is UNCONFIRMED at stage EEPROM - persistence unknown', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueToDisarmProof(h);
    h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {reject: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'})});
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toEqual({
      kind: 'UNCONFIRMED',
      stage: 'EEPROM',
    });
  });

  it('5: EEPROM acknowledged but the read-back fails - persisted yet UNVERIFIED, never generic success', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueToDisarmProof(h);
    h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    h.client.enqueue(MSP_RX_CONFIG, {reject: new Error('link lost after persist')});
    const outcome = await h.controller.save(key, original, draftFor(original));
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
    // The distinction that matters: the EEPROM write DID complete.
    expect(h.client.calls.filter(call => call.command === MSP_EEPROM_WRITE)).toHaveLength(1);
  });

  it('7: a read-back that does not match the draft can never become SAVED_VERIFIED', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueToDisarmProof(h);
    h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    // The FC reports the OLD map - the write did not take effect.
    enqueueSnapshot(h.client, [0, 1, 3, 2, 4, 5, 6, 7]);
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toMatchObject({
      kind: 'SAVED_UNVERIFIED',
    });
  });

  it('8: APP_BACKGROUNDED is refused before any I/O', async () => {
    const client = new FakeClient();
    const telemetry = scheduler();
    const coordinator: ReceiverSessionCoordinator = {
      getOwnershipState: () => 'ACTIVE', getIdentificationState: () => identification(),
      getSessionKey: sessionId => ({sessionId, generation: 4}), getActiveMspClient: () => client,
      getTelemetryScheduler: () => telemetry, getMspRecoveryState: () => 'READY',
    };
    const controller = new ReceiverConfigurationController({
      coordinator, appStateOwner: {getPhase: () => 'APP_BACKGROUND'}, isMotorTestActive: () => false,
    });
    await expect(controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'APP_BACKGROUNDED'});
    await expect(controller.readRuntime(key)).resolves.toEqual({kind: 'REJECTED', reason: 'APP_BACKGROUNDED'});
    await expect(controller.requestReboot(key)).resolves.toEqual({kind: 'REJECTED', reason: 'APP_BACKGROUNDED'});
    expect(client.calls).toEqual([]);
  });

  it('11: LINK_RECOVERING is refused before any I/O', async () => {
    const h = harness();
    h.state.recovery = 'RECOVERING' as never;
    await expect(h.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'LINK_RECOVERING'});
    expect(h.client.calls).toEqual([]);
  });

  it('12: MOTOR_TEST_ACTIVE blocks every Receiver transaction', async () => {
    // A genuine snapshot, read through a harness that is not blocked, so
    // the save below is refused by the interlock rather than by draft
    // validation.
    const original = await loadOriginal(harness());
    const h = harness({motorTest: true});
    await expect(h.controller.load(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    await expect(h.controller.readRuntime(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    await expect(h.controller.requestReboot(key)).resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    await expect(h.controller.save(key, original, draftFor(original))).resolves.toEqual({
      kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE',
    });
    expect(h.client.calls).toEqual([]);
  });
});

describe('Receiver P2 closure - structural read-only proofs', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, 'ReceiverConfigurationController.ts'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('19/20: the Receiver controller never names a feature-mask or Ports SETTER', () => {
    expect(source).toContain('MSP_FEATURE_CONFIG'); // reading is intended
    expect(source).not.toContain('MSP_SET_FEATURE_CONFIG');
    expect(source).not.toContain('MSP2_COMMON_SET_SERIAL_CONFIG');
  });

  it('19: no receiver-mode setter is reachable on the controller surface', () => {
    const controller = harness().controller as unknown as Record<string, unknown>;
    for (const name of ['setReceiverMode', 'writeReceiverMode', 'saveReceiverMode', 'setFeatureMask']) {
      expect(controller[name]).toBeUndefined();
    }
  });

  it('22: CRSF stays CRSF - no ELRS pseudo-provider token exists anywhere in the Receiver domain', () => {
    const semantics = require('fs').readFileSync(
      require('path').join(__dirname, '../../../core/state/receiverRuntimeSemantics.ts'), 'utf8',
    );
    for (const text of [source, semantics]) {
      expect(text).not.toMatch(/SERIALRX_EXPRESSLRS|['"]ELRS['"]/);
    }
  });
});
