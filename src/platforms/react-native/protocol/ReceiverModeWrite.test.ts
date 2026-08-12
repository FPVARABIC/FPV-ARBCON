/**
 * RECEIVER P4 - the mode/provider save transaction, end to end.
 *
 * What these pin is not "does the write happen" but the four ways a
 * receiver configurator gets someone hurt:
 *
 *   1. It writes a mask built from a stale read, silently switching off
 *      whatever another screen enabled in the meantime.
 *   2. It lets a SERIAL mode be applied with no UART behind it, so the
 *      aircraft comes back from reboot with no control input.
 *   3. It reports a stored-but-not-yet-running configuration as applied,
 *      because MSP_STATUS_EX reports rebootRequired=0 for exactly these
 *      two fields.
 *   4. It calls a half-written transaction "failed", so the operator
 *      believes the flight controller is untouched when it is not.
 */

import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BOXIDS, MSP_BUILD_INFO, MSP_EEPROM_WRITE, MSP_FEATURE_CONFIG, MSP_RSSI_CONFIG,
  MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_FEATURE_CONFIG,
  MSP_SET_RX_CONFIG, MSP_SET_RX_MAP, MSP_STATUS_EX, MSP_TX_INFO,
  MSP2_COMMON_SERIAL_CONFIG, MSP2_COMMON_SET_SERIAL_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {createReceiverConfigurationDraft, type ReceiverConfigurationSnapshot} from '../../../core/state/receiverConfigurationModel';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {ReceiverConfigurationController, type ReceiverSessionCoordinator} from './ReceiverConfigurationController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'receiver-p4', generation: 4} as const;

/* FIRMWARE FACT - config/feature.h @ pinned 1.47. */
const RX_PPM = 2 ** 0;
const RX_SERIAL = 2 ** 3;
const GPS = 2 ** 7;
const TELEMETRY = 2 ** 10;
const OSD = 2 ** 18;
const UNKNOWN_HIGH_BIT = 2 ** 31;
const FUNCTION_RX_SERIAL = 2 ** 6; // io/serial.h:43
/* msp_build_info.h @ pinned 1.47. */
const OPTION_CRSF = 4097;
const OPTION_SBUS = 4103;
const OPTION_PPM = 4102;

/** MSP_BUILD_INFO: 26-byte header, then u16 option ids, then a zero. */
function buildInfoPayload(optionIds: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(26 + optionIds.length * 2 + 2);
  const view = new DataView(bytes.buffer);
  optionIds.forEach((id, index) => view.setUint16(26 + index * 2, id, true));
  return bytes;
}

class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = [];
  private readonly scripts = new Map<number, Script[]>();
  getEpoch() { return 1; }
  enqueue(command: number, ...scripts: Script[]) { this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]); }
  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) throw script.reject;
    return {protocolVersion: 'v1', wireFormat: options.wireFormat, direction: 'response', command, flags: 0, payload: script?.payload ?? EMPTY};
  }
  commands() { return this.calls.map(call => call.command); }
  payloadFor(command: number) { return this.calls.find(call => call.command === command)?.payload; }
}

function rxPayload(provider = 9): Uint8Array {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = provider;
  view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true);
  view.setUint16(8, 885, true); view.setUint16(10, 2115, true);
  // Bytes this screen does not own, given non-zero values so a synthetic
  // payload cannot pass by accident.
  bytes[16] = 19;                              // rx_spi_protocol
  view.setUint32(17, 0xdeadbeef, true);        // rx_spi_id
  bytes[21] = 4;                               // rx_spi_rf_channel_count
  bytes[22] = 20;                              // fpvCamAngleDegrees
  bytes[29] = 3;                               // USB HID type - General Configuration owns this
  bytes[27] = 30; bytes[30] = 30; bytes[31] = 1;
  return bytes;
}
function featurePayload(mask: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, mask >>> 0, true);
  return bytes;
}
function portsPayload(entries: readonly (readonly [number, number])[]): Uint8Array {
  const bytes = new Uint8Array(1 + entries.length * 9);
  bytes[0] = entries.length;
  const view = new DataView(bytes.buffer);
  entries.forEach(([identifier, functionMask], index) => {
    const offset = 1 + index * 9;
    bytes[offset] = identifier;
    view.setUint32(offset + 1, functionMask, true);
  });
  return bytes;
}
function statusPayload(armed: boolean, rebootRequired = false): Uint8Array {
  const bytes = Uint8Array.from([0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]);
  new DataView(bytes.buffer).setUint32(17, 0, true);
  bytes[21] = rebootRequired ? 1 : 0;
  return bytes;
}
function identification(): MspIdentificationState {
  return {status: 'SUCCEEDED', identity: {firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'}, apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47}, board: {}}} as MspIdentificationState;
}
function scheduler(): MspTelemetryScheduler {
  return {acquirePauseLease: jest.fn(() => ({release: jest.fn()})), discardPendingDemands: jest.fn(), waitUntilIdle: jest.fn(() => Promise.resolve()), requestRefresh: jest.fn()} as unknown as MspTelemetryScheduler;
}
function harness() {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {ownership: 'ACTIVE' as const, recovery: 'READY' as const};
  const coordinator: ReceiverSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => identification(),
    getSessionKey: sessionId => ({sessionId, generation: 4}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  return {client, state, controller: new ReceiverConfigurationController({coordinator, appStateOwner: {getPhase: () => 'ACTIVE'}, isMotorTestActive: () => false})};
}
function enqueueSnapshot(client: FakeClient, provider = 9, map = [0, 1, 3, 2, 4, 5, 6, 7]) {
  client.enqueue(MSP_RX_CONFIG, {payload: rxPayload(provider)});
  client.enqueue(MSP_RX_MAP, {payload: Uint8Array.from(map)});
  client.enqueue(MSP_RSSI_CONFIG, {payload: Uint8Array.from([0])});
  client.enqueue(MSP_RC_DEADBAND, {payload: Uint8Array.from([2, 3, 4, 5, 0])});
}
async function loadOriginal(h: ReturnType<typeof harness>, provider = 9): Promise<ReceiverConfigurationSnapshot> {
  enqueueSnapshot(h.client, provider);
  const out = await h.controller.load(key);
  if (out.kind !== 'LOADED') throw new Error(out.kind);
  return out.snapshot;
}

interface SaveScript {
  freshMask: number;
  ports?: readonly (readonly [number, number])[] | 'reject';
  /** Provider written back on the verification read. */
  readbackProvider?: number;
  /** Mask returned by the post-write MSP_FEATURE_CONFIG verification. */
  verifyMask?: number;
  /** Build options the FC reports; 'reject' = board cannot answer. */
  buildOptions?: readonly number[] | 'reject';
  failFeatureWrite?: unknown;
  failRxConfigWrite?: unknown;
  failEeprom?: unknown;
  rebootRequired?: boolean;
}

/** Queues everything the save transaction reads and writes, in order. */
function queueSave(h: ReturnType<typeof harness>, script: SaveScript, options: {provider?: number} = {}) {
  const provider = options.provider ?? 9;
  enqueueSnapshot(h.client, provider);                                   // fresh stale-base read
  h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(script.freshMask)});
  // P4 CLOSURE: capability is re-read inside the transaction.
  if (script.buildOptions === 'reject') h.client.enqueue(MSP_BUILD_INFO, {reject: new Error('unsupported')});
  else h.client.enqueue(MSP_BUILD_INFO, {payload: buildInfoPayload(script.buildOptions ?? [OPTION_CRSF, OPTION_SBUS, OPTION_PPM])});
  if (script.ports === 'reject') h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {reject: new Error('unsupported')});
  else if (script.ports !== undefined) h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {payload: portsPayload(script.ports)});
  h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
  h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
  h.client.enqueue(MSP_SET_RX_CONFIG, script.failRxConfigWrite !== undefined ? {reject: script.failRxConfigWrite} : {payload: EMPTY});
  h.client.enqueue(MSP_SET_FEATURE_CONFIG, script.failFeatureWrite !== undefined ? {reject: script.failFeatureWrite} : {payload: EMPTY});
  h.client.enqueue(MSP_EEPROM_WRITE, script.failEeprom !== undefined ? {reject: script.failEeprom} : {payload: EMPTY});
  enqueueSnapshot(h.client, script.readbackProvider ?? provider);        // verification read
  if (script.verifyMask !== undefined) h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(script.verifyMask)});
  h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false, script.rebootRequired ?? false)});
}

/* ==================================================== MODE MUTATION */
describe('P4 mode write - the mask that goes out', () => {
  it('reads the feature mask FRESH inside the transaction, never the loaded one', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    // The page was loaded when only SERIAL was set. By save time another
    // screen has enabled GPS, telemetry and OSD.
    const fresh = RX_SERIAL | GPS | TELEMETRY | OSD | UNKNOWN_HIGH_BIT;
    const desired = RX_PPM | GPS | TELEMETRY | OSD | UNKNOWN_HIGH_BIT;
    queueSave(h, {freshMask: fresh, verifyMask: desired});
    const outcome = await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    expect(outcome.kind).toBe('SAVED_REBOOT_REQUIRED');
    // A feature read happens INSIDE the save, after the snapshot read.
    const order = h.client.commands();
    expect(order.indexOf(MSP_FEATURE_CONFIG)).toBeGreaterThan(order.indexOf(MSP_RC_DEADBAND));
    expect(order.indexOf(MSP_FEATURE_CONFIG)).toBeLessThan(order.indexOf(MSP_SET_FEATURE_CONFIG));
  });

  it('sends the COMPLETE mask, with every unrelated bit preserved', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const fresh = RX_SERIAL | GPS | TELEMETRY | OSD | UNKNOWN_HIGH_BIT;
    const desired = RX_PPM | GPS | TELEMETRY | OSD | UNKNOWN_HIGH_BIT;
    queueSave(h, {freshMask: fresh, verifyMask: desired});
    await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    const payload = h.client.payloadFor(MSP_SET_FEATURE_CONFIG)!;
    expect(payload).toHaveLength(4);
    expect(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)).toBe(desired >>> 0);
  });

  it('refuses when the receiver mode changed under us, without writing anything', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    // The page was showing SERIAL; the FC now reports PPM.
    queueSave(h, {freshMask: RX_PPM | GPS});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
    expect(h.client.commands()).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does NOT refuse when only an unrelated feature changed under us', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const fresh = RX_SERIAL | GPS; // GPS appeared since load
    queueSave(h, {freshMask: fresh, verifyMask: RX_PPM | GPS});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED'});
    // ...and GPS is still on in what we sent.
    const payload = h.client.payloadFor(MSP_SET_FEATURE_CONFIG)!;
    // eslint-disable-next-line no-bitwise
    expect(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true) & GPS).toBe(GPS);
  });

  it('verifies the WHOLE mask on read-back, not just the mode', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const fresh = RX_SERIAL | GPS;
    // The FC reports the right MODE but has silently lost GPS.
    queueSave(h, {freshMask: fresh, verifyMask: RX_PPM});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toMatchObject({kind: 'SAVED_UNVERIFIED'});
  });

  it('refuses a mode the capability matrix does not clear, before any I/O', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    for (const mode of ['SPI', 'MSP', 'NONE'] as const) {
      const before = h.client.calls.length;
      await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode, baseFeatureMaskRaw: RX_SERIAL}))
        .resolves.toEqual({kind: 'REJECTED', reason: 'MODE_NOT_WRITABLE'});
      expect(h.client.calls.length).toBe(before);
    }
  });

  it('persists only after the writes, and reports reboot-required afterwards', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, verifyMask: RX_PPM});
    const outcome = await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    const order = h.client.commands();
    expect(order.indexOf(MSP_EEPROM_WRITE)).toBeGreaterThan(order.indexOf(MSP_SET_FEATURE_CONFIG));
    expect(outcome).toMatchObject({kind: 'SAVED_REBOOT_REQUIRED', evidence: 'STRUCTURAL_REQUIRED'});
  });

  it('reports reboot-required even though the FC says rebootRequired=0', async () => {
    // This is the whole point of the STRUCTURAL evidence class: msp.c
    // never calls configRebootUpdateCheckU8 for the feature mask, so the
    // FC's own flag is 0 after a perfectly successful mode change.
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, verifyMask: RX_PPM, rebootRequired: false});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED', evidence: 'STRUCTURAL_REQUIRED'});
  });
});

/* ================================================== PORTS DEPENDENCY */
describe('P4 serial dependency is enforced before any write', () => {
  const toSerial = {mode: 'SERIAL' as const, baseFeatureMaskRaw: RX_PPM};

  it('allows the transition with exactly one Serial RX UART', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_PPM, ports: [[1, FUNCTION_RX_SERIAL], [2, 0]], verifyMask: RX_SERIAL});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), toSerial))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED'});
  });

  it.each([
    ['DEPENDENCY_MISSING', [[1, 0], [2, 0]] as const],
    ['DEPENDENCY_AMBIGUOUS', [[1, FUNCTION_RX_SERIAL], [2, FUNCTION_RX_SERIAL]] as const],
  ])('rejects with %s and writes nothing', async (reason, ports) => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_PPM, ports});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), toSerial))
      .resolves.toEqual({kind: 'REJECTED', reason});
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
    expect(h.client.commands()).not.toContain(MSP_EEPROM_WRITE);
  });

  it('rejects with DEPENDENCY_UNKNOWN rather than guessing when Ports cannot be read', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_PPM, ports: 'reject'});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), toSerial))
      .resolves.toEqual({kind: 'REJECTED', reason: 'DEPENDENCY_UNKNOWN'});
  });

  it('does not consult Ports at all for a non-serial target', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, verifyMask: RX_PPM});
    await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    expect(h.client.commands()).not.toContain(MSP2_COMMON_SERIAL_CONFIG);
  });

  it('NEVER writes Ports, in any transition', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    // Switching AWAY from serial must not "tidy up" the UART either.
    queueSave(h, {freshMask: RX_SERIAL, verifyMask: RX_PPM});
    await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    expect(h.client.commands()).not.toContain(MSP2_COMMON_SET_SERIAL_CONFIG);
  });
});

/* ======================================================== PROVIDER */
describe('P4 provider write is a read-modify-write of RX_CONFIG', () => {
  it('patches only byte 0 and preserves every field this screen does not own', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9); // CRSF
    queueSave(h, {freshMask: RX_SERIAL, ports: [[1, FUNCTION_RX_SERIAL]], readbackProvider: 2});
    const draft = {...createReceiverConfigurationDraft(original), serialRxProvider: 2}; // SBUS
    await expect(h.controller.save(key, original, draft)).resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED'});

    const written = h.client.payloadFor(MSP_SET_RX_CONFIG)!;
    const base = rxPayload(9);
    expect(written[0]).toBe(2);
    // Everything else identical to what the FC sent us, byte for byte.
    for (let index = 1; index < base.length; index += 1) {
      expect({index, value: written[index]}).toEqual({index, value: base[index]});
    }
    // Named explicitly because they belong to other screens/features.
    expect(written[29]).toBe(3);                  // USB HID type - General Configuration
    expect(written[16]).toBe(19);                 // rx_spi_protocol
    expect(written[22]).toBe(20);                 // fpvCamAngleDegrees
  });

  it('reports a provider change as reboot-required, on structural evidence', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);
    queueSave(h, {freshMask: RX_SERIAL, ports: [[1, FUNCTION_RX_SERIAL]], readbackProvider: 2, rebootRequired: false});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED', evidence: 'STRUCTURAL_REQUIRED'});
  });

  it('rejects an out-of-enum provider before any I/O', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const before = h.client.calls.length;
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 17}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(h.client.calls.length).toBe(before);
  });

  it('checks the serial UART dependency for a provider-only change too', async () => {
    // The mode is already SERIAL, so a provider change lands on a
    // receiver that needs its UART just as much.
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, ports: [[1, 0]]});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'DEPENDENCY_MISSING'});
  });
});

/* ============================================ COMBINED + INTERRUPTION */
describe('P4 combined transaction and interruption truth', () => {
  it('writes RX_CONFIG before the feature mask, and EEPROM after both', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_PPM, ports: [[1, FUNCTION_RX_SERIAL]], readbackProvider: 2, verifyMask: RX_SERIAL});
    const draft = {...createReceiverConfigurationDraft(original), serialRxProvider: 2};
    await expect(h.controller.save(key, original, draft, {mode: 'SERIAL', baseFeatureMaskRaw: RX_PPM}))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED'});
    const order = h.client.commands();
    expect(order.indexOf(MSP_SET_RX_CONFIG)).toBeLessThan(order.indexOf(MSP_SET_FEATURE_CONFIG));
    expect(order.indexOf(MSP_SET_FEATURE_CONFIG)).toBeLessThan(order.indexOf(MSP_EEPROM_WRITE));
  });

  it('reports PARTIAL_UNPERSISTED when the second write definitely never went', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {
      freshMask: RX_PPM, ports: [[1, FUNCTION_RX_SERIAL]],
      failFeatureWrite: Object.assign(new Error('queue full'), {code: 'MSP_QUEUE_FULL'}),
    });
    const draft = {...createReceiverConfigurationDraft(original), serialRxProvider: 2};
    const outcome = await h.controller.save(key, original, draft, {mode: 'SERIAL', baseFeatureMaskRaw: RX_PPM});
    expect(outcome).toMatchObject({
      kind: 'PARTIAL_UNPERSISTED',
      failedStage: 'FEATURE',
      confirmedStages: ['RX_CONFIG'],
      definitelyNotSent: true,
    });
    // Nothing persisted, and no retry attempted on our own initiative.
    expect(h.client.commands()).not.toContain(MSP_EEPROM_WRITE);
    expect(h.client.calls.filter(call => call.command === MSP_SET_FEATURE_CONFIG)).toHaveLength(1);
  });

  it('reports PARTIAL_UNPERSISTED when the second write is merely ambiguous', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {
      freshMask: RX_PPM, ports: [[1, FUNCTION_RX_SERIAL]],
      failFeatureWrite: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'}),
    });
    const draft = {...createReceiverConfigurationDraft(original), serialRxProvider: 2};
    await expect(h.controller.save(key, original, draft, {mode: 'SERIAL', baseFeatureMaskRaw: RX_PPM}))
      .resolves.toMatchObject({kind: 'PARTIAL_UNPERSISTED', failedStage: 'FEATURE', definitelyNotSent: false});
  });

  it('is NOT partial when the very first write fails - nothing landed', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {
      freshMask: RX_SERIAL, ports: [[1, FUNCTION_RX_SERIAL]],
      failRxConfigWrite: Object.assign(new Error('encode failed'), {code: 'MSP_ENCODE_FAILED'}),
    });
    const outcome = await h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2});
    expect(outcome.kind).toBe('FAILED');
  });

  it('keeps EEPROM ambiguity as UNCONFIRMED, not partial - RAM is complete, persistence is not', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {
      freshMask: RX_SERIAL, ports: [[1, FUNCTION_RX_SERIAL]],
      failEeprom: Object.assign(new Error('timeout'), {code: 'MSP_TIMEOUT'}),
    });
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toEqual({kind: 'UNCONFIRMED', stage: 'EEPROM'});
  });

  it('reports SAVED_UNVERIFIED when the configuration read-back disagrees', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    // Read-back still says CRSF although SBUS was written.
    queueSave(h, {freshMask: RX_SERIAL, ports: [[1, FUNCTION_RX_SERIAL]], readbackProvider: 9});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toMatchObject({kind: 'SAVED_UNVERIFIED'});
  });

  it('proves DISARMED before any of it', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(RX_SERIAL)});
    h.client.enqueue(MSP_BUILD_INFO, {payload: buildInfoPayload([OPTION_CRSF, OPTION_PPM])});
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(true)});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
  });

  it('rejects a mode change on a link that is recovering, before I/O', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    h.state.recovery = 'RECOVERING' as never;
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'LINK_RECOVERING'});
  });

  it('treats a mode-only change as a real change even with an untouched draft', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, verifyMask: RX_PPM});
    const outcome = await h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL});
    expect(outcome.kind).not.toBe('NO_CHANGES');
    // No configuration payload was written, only the mask.
    expect(h.client.commands()).not.toContain(MSP_SET_RX_CONFIG);
    expect(h.client.commands()).toContain(MSP_SET_FEATURE_CONFIG);
  });

  it('still reports NO_CHANGES when neither the draft nor the mode moved', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    const before = h.client.calls.length;
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original)))
      .resolves.toMatchObject({kind: 'NO_CHANGES'});
    expect(h.client.calls.length).toBe(before);
  });
});

/* ================================================ STRUCTURAL NEGATIVES */
describe('P4 structural negatives', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, 'ReceiverConfigurationController.ts'), 'utf8');

  it('exposes exactly one save entry point - no second authority', () => {
    const controller = harness().controller as unknown as Record<string, unknown>;
    for (const name of ['saveMode', 'saveProvider', 'saveRuntime', 'applyMode', 'writeFeatureMask']) {
      expect(controller[name]).toBeUndefined();
    }
    expect(typeof controller.save).toBe('function');
  });

  it('has one reboot implementation, and save never triggers it', () => {
    // Comments discuss the reboot at length; only executable code counts.
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Exactly two: the import and the one requester.request call.
    expect(executable.match(/MSP_REBOOT/g) ?? []).toHaveLength(2);
    // And the reboot lives in its own method, not inside save().
    const saveBody = executable.slice(executable.indexOf('async save('), executable.indexOf('private async writeOnce'));
    expect(saveBody).not.toContain('MSP_REBOOT');
    expect(saveBody.length).toBeGreaterThan(500);
  });

  it('never writes Ports and never writes RXFAIL', () => {
    expect(source).not.toContain('MSP2_COMMON_SET_SERIAL_CONFIG');
    expect(source).not.toContain('MSP_SET_RXFAIL_CONFIG');
  });

  it('invents no ExpressLRS provider value', () => {
    expect(source).not.toMatch(/ELRS|ExpressLRS/i);
  });

  it('reads MSP_TX_INFO for the RSSI source and fabricates no link quality', () => {
    expect(source).toContain('MSP_TX_INFO');
    expect(source.toLowerCase()).not.toContain('linkquality');
  });
});

/* ============================================== BUILD CAPABILITY GATE */
describe('P4 closure: build capability is enforced at the write boundary', () => {
  it('refuses a provider the connected build did not report, with UNAVAILABLE', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);            // running CRSF
    queueSave(h, {freshMask: RX_SERIAL, buildOptions: [OPTION_CRSF], ports: [[1, FUNCTION_RX_SERIAL]]});
    // SBUS is a perfectly valid enum value this build has no driver for.
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'CAPABILITY_UNAVAILABLE'});
    expect(h.client.commands()).not.toContain(MSP_SET_RX_CONFIG);
    expect(h.client.commands()).not.toContain(MSP_EEPROM_WRITE);
  });

  it('refuses a provider change when the board reported nothing, with NOT_PROVEN', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);
    queueSave(h, {freshMask: RX_SERIAL, buildOptions: 'reject', ports: [[1, FUNCTION_RX_SERIAL]]});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'CAPABILITY_NOT_PROVEN'});
    expect(h.client.commands()).not.toContain(MSP_SET_RX_CONFIG);
  });

  it('allows a provider the build DID report', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);
    queueSave(h, {freshMask: RX_SERIAL, buildOptions: [OPTION_CRSF, OPTION_SBUS], ports: [[1, FUNCTION_RX_SERIAL]], readbackProvider: 2});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toMatchObject({kind: 'SAVED_REBOOT_REQUIRED'});
    // And it is still a clone-and-patch of a FRESH payload.
    const written = h.client.payloadFor(MSP_SET_RX_CONFIG)!;
    expect(written[0]).toBe(2);
    expect(written[29]).toBe(3);   // USB HID type, General Configuration's
    expect(written[16]).toBe(19);  // rx_spi_protocol
  });

  it('refuses a PPM transition on a build that never reported PPM', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    queueSave(h, {freshMask: RX_SERIAL, buildOptions: [OPTION_CRSF]});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'PPM', baseFeatureMaskRaw: RX_SERIAL}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'CAPABILITY_UNAVAILABLE'});
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
  });

  it('refuses a SERIAL transition whose provider this build lacks', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);            // stored CRSF
    // Build has SBUS only, so switching to SERIAL would run CRSF with no
    // CRSF driver - the exact silent failure this gate exists for.
    queueSave(h, {freshMask: RX_PPM, buildOptions: [OPTION_SBUS], ports: [[1, FUNCTION_RX_SERIAL]]});
    await expect(h.controller.save(key, original, createReceiverConfigurationDraft(original), {mode: 'SERIAL', baseFeatureMaskRaw: RX_PPM}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'CAPABILITY_UNAVAILABLE'});
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
  });

  it('re-reads capability INSIDE the transaction, so no earlier answer can authorise this write', async () => {
    const h = harness();
    const original = await loadOriginal(h, 9);
    // A runtime read first - this is the "old" capability answer, and it
    // says SBUS is present.
    h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(RX_SERIAL)});
    h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {payload: portsPayload([[1, FUNCTION_RX_SERIAL]])});
    h.client.enqueue(MSP_BUILD_INFO, {payload: buildInfoPayload([OPTION_CRSF, OPTION_SBUS])});
    h.client.enqueue(MSP_TX_INFO, {payload: Uint8Array.from([6, 0])});
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ', runtime: {selectableProviders: [2, 9]},
    });
    // The board is then replaced/reflashed: the SAVE's own read says CRSF only.
    queueSave(h, {freshMask: RX_SERIAL, buildOptions: [OPTION_CRSF], ports: [[1, FUNCTION_RX_SERIAL]]});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), serialRxProvider: 2}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'CAPABILITY_UNAVAILABLE'});
    expect(h.client.calls.filter(call => call.command === MSP_BUILD_INFO)).toHaveLength(2);
  });

  it('does not read capability at all when neither mode nor provider is changing', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueSnapshot(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    h.client.enqueue(MSP_SET_RX_MAP, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueSnapshot(h.client, 9, [1, 2, 3, 0, 4, 5, 6, 7]);
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    await expect(h.controller.save(key, original, {...createReceiverConfigurationDraft(original), channelMapText: 'TAER1234'}))
      .resolves.toMatchObject({kind: 'SAVED_VERIFIED'});
    expect(h.client.commands()).not.toContain(MSP_BUILD_INFO);
  });

  it('reports capability on the runtime read without ever writing anything', async () => {
    const h = harness();
    h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(RX_SERIAL)});
    h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {payload: portsPayload([[1, FUNCTION_RX_SERIAL]])});
    h.client.enqueue(MSP_BUILD_INFO, {payload: buildInfoPayload([OPTION_CRSF, OPTION_PPM])});
    h.client.enqueue(MSP_TX_INFO, {payload: Uint8Array.from([6, 0])});
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ',
      runtime: {buildOptionsKnown: true, selectableModes: ['PPM', 'SERIAL'], selectableProviders: [9]},
    });
    expect(h.client.commands().filter(command => command > 200 && command < 300)).toEqual([]);
    expect(h.client.commands()).not.toContain(MSP_SET_FEATURE_CONFIG);
  });

  it('reports NOT KNOWN rather than empty support when the board cannot answer', async () => {
    const h = harness();
    h.client.enqueue(MSP_FEATURE_CONFIG, {payload: featurePayload(RX_SERIAL)});
    h.client.enqueue(MSP2_COMMON_SERIAL_CONFIG, {payload: portsPayload([[1, FUNCTION_RX_SERIAL]])});
    h.client.enqueue(MSP_BUILD_INFO, {reject: new Error('unsupported')});
    h.client.enqueue(MSP_TX_INFO, {payload: Uint8Array.from([6, 0])});
    await expect(h.controller.readRuntime(key)).resolves.toMatchObject({
      kind: 'READ',
      runtime: {buildOptionsKnown: false, selectableModes: [], selectableProviders: []},
    });
  });
});
