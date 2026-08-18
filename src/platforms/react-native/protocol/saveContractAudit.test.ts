/**
 * THE SAVE CONTRACT, ON THE CONTROLLERS THAT NEVER PROVED IT.
 *
 * WHY THIS FILE EXISTS. Every settings controller implements the same
 * four-outcome contract - SAVED_VERIFIED, SAVED_UNVERIFIED, UNCONFIRMED,
 * REJECTED(STALE_BASE) - but the tests behind it are wildly uneven.
 * Receiver has 40 tests and exercises all of them; Failsafe, Power, OSD
 * and VTX have three each, and between them cover exactly two paths:
 * "it saved" and "it refused while armed". Nothing proved what happens
 * when a write's outcome is UNKNOWN, when the board changed underneath
 * the operator, or when the readback disagrees with what was sent.
 *
 * That is the inverse of the risk. Failsafe decides what the aircraft
 * does when the link dies; Power decides the cell count and the voltage
 * alarms a long-range pilot flies to. A "saved" that did not save, or a
 * silent write onto a base that moved, is worst exactly there.
 *
 * These are AUDIT tests: they assert the contract these controllers
 * already claim, on the paths nothing was checking. They add no
 * behaviour and change no gate.
 */

import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BATTERY_CONFIG,
  MSP_BOXIDS,
  MSP_BUILD_INFO,
  MSP_CURRENT_METER_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_OSD_CANVAS,
  MSP_OSD_CONFIG,
  MSP_RXFAIL_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP_SET_VTX_CONFIG,
  MSP_VTX_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  MSP_SET_BATTERY_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_STATUS_EX,
  MSP_VOLTAGE_METER_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import {createPowerConfigurationDraft} from '../../../core/state/powerConfigurationModel';
import {createOsdConfigurationDraft} from '../../../core/state/osdConfigurationModel';
import {createVtxConfigurationDraft} from '../../../core/state/vtxConfigurationModel';
import type {MspFailsafeSnapshot} from '../../../core/protocol/msp/decoding/decodeFailsafe';
import type {MspPowerConfigurationSnapshot} from '../../../core/protocol/msp/decoding/decodePowerConfiguration';
import type {MspOsdSnapshot} from '../../../core/protocol/msp/decoding/decodeOsdConfiguration';
import type {MspVtxSnapshot} from '../../../core/protocol/msp/decoding/decodeVtxConfiguration';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {
  FailsafeConfigurationController,
  type FailsafeSessionCoordinator,
} from './FailsafeConfigurationController';
import {
  PowerConfigurationController,
  type PowerSessionCoordinator,
} from './PowerConfigurationController';
import {OsdConfigurationController} from './OsdConfigurationController';
import {VtxConfigurationController} from './VtxConfigurationController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'audit-fc', generation: 5} as const;

class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array}> = [];
  private readonly scripts = new Map<number, Script[]>();
  getEpoch() {
    return 1;
  }
  enqueue(command: number, ...scripts: Script[]) {
    this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]);
  }
  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({command, payload});
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) {
      throw script.reject;
    }
    return {
      protocolVersion: 'v1',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: script?.payload ?? EMPTY,
    };
  }
}

function identification(minor = 47): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: minor},
      board: {},
    },
  } as MspIdentificationState;
}

function scheduler(): MspTelemetryScheduler {
  return {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
}

/** DISARMED, with the ARM box at permanent id 0 and no blockers. */
function status(armed: boolean): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0,
  ]);
}

/* ------------------------------------------------------------------ *
 * FAILSAFE
 * ------------------------------------------------------------------ */

function failsafeMain(delay = 15): Uint8Array {
  return Uint8Array.from([delay, 60, 232, 3, 0, 100, 0, 1]);
}
function failsafeRx(changed = false): Uint8Array {
  return Uint8Array.from([
    0, 220, 5, 0, 220, 5, 0, 220, 5, 0, 232, 3,
    changed ? 2 : 1, changed ? 226 : 220, changed ? 4 : 5,
  ]);
}
function buildInfo(): Uint8Array {
  const data = new Uint8Array(30);
  new DataView(data.buffer).setUint16(26, 16412, true);
  return data;
}

function failsafeHarness() {
  const client = new FakeClient();
  const telemetry = scheduler();
  const coordinator: FailsafeSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => identification(),
    getSessionKey: sessionId => ({sessionId, generation: 5}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY',
  };
  return {
    client,
    controller: new FailsafeConfigurationController({
      coordinator,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => false,
    }),
  };
}

function enqueueFailsafe(client: FakeClient, delay = 15, changed = false) {
  client.enqueue(MSP_FAILSAFE_CONFIG, {payload: failsafeMain(delay)});
  client.enqueue(MSP_RXFAIL_CONFIG, {payload: failsafeRx(changed)});
  client.enqueue(MSP_BUILD_INFO, {payload: buildInfo()});
}

async function loadFailsafe(
  h: ReturnType<typeof failsafeHarness>,
): Promise<MspFailsafeSnapshot> {
  enqueueFailsafe(h.client);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED') {
    throw new Error(result.kind);
  }
  return result.snapshot;
}

function enqueueDisarmed(client: FakeClient) {
  client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
  client.enqueue(MSP_STATUS_EX, {payload: status(false)});
}

describe('failsafe: the paths nothing was checking', () => {
  it('refuses to write onto a board that changed underneath the operator', async () => {
    // The pilot loads failsafe, someone flashes or a CLI writes, and the
    // pilot presses save. Writing the pilot's diff onto a base that moved
    // silently changes settings they never saw.
    const h = failsafeHarness();
    const original = await loadFailsafe(h);
    enqueueFailsafe(h.client, 99); // the FC now reports a different delay
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_FAILSAFE_CONFIG,
    );
  });

  it('reports a write whose outcome is UNKNOWN as unconfirmed, never as saved', async () => {
    // A timeout after the frame is on the wire. The firmware may or may
    // not have applied it, and the one thing the app must not do is tell
    // the pilot their failsafe is set.
    const h = failsafeHarness();
    const original = await loadFailsafe(h);
    enqueueFailsafe(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('UNCONFIRMED');
    if (result.kind === 'UNCONFIRMED') {
      // The STAGE is what tells the pilot which group is in doubt.
      expect(result.stage).toBeDefined();
    }
  });

  it('does not persist when the settings write never landed', async () => {
    const h = failsafeHarness();
    const original = await loadFailsafe(h);
    enqueueFailsafe(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};

    await h.controller.save(key, original, draft);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does not claim verification when the readback disagrees', async () => {
    // Everything acknowledged, EEPROM written, and the board reads back
    // the OLD value. That is a real failure mode (a rejected value the
    // firmware clamped) and it must not present as success.
    const h = failsafeHarness();
    const original = await loadFailsafe(h);
    enqueueFailsafe(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueFailsafe(h.client); // unchanged - the write did not take
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).not.toBe('SAVED_VERIFIED');
  });

  it('treats an encode failure as a definite non-write, not an ambiguous one', async () => {
    // The frame never reached the wire, so nothing is in doubt. Calling
    // this UNCONFIRMED would send the pilot to re-check a board that was
    // never touched.
    const h = failsafeHarness();
    const original = await loadFailsafe(h);
    enqueueFailsafe(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {reject: {code: 'MSP_ENCODE_FAILED'}});
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('FAILED');
  });
});

/* ------------------------------------------------------------------ *
 * POWER
 * ------------------------------------------------------------------ */

/** decodeBatteryConfiguration's own field order: three legacy u8s, then
 * capacity, the two meter sources, and min/max/warning cell centivolts. */
function batteryConfig(capacity = 1500): Uint8Array {
  return Uint8Array.from([
    0, 0, 0,
    capacity % 256, Math.floor(capacity / 256),
    1, // voltageMeterSource
    1, // currentMeterSource
    74, 1, // min 3.30 V
    174, 1, // max 4.30 V
    94, 1, // warning 3.50 V
  ]);
}
/** count, then one 5-byte subframe: id, sensorType, scale, divider, multiplier. */
function voltageMeters(): Uint8Array {
  return Uint8Array.from([1, 5, 10, 0, 110, 10, 1]);
}
/** count, then one 6-byte subframe: id, sensorType, int16 scale, int16 offset. */
function currentMeters(): Uint8Array {
  return Uint8Array.from([1, 6, 20, 0, 100, 0, 0, 0]);
}

function powerHarness() {
  const client = new FakeClient();
  const telemetry = scheduler();
  const coordinator: PowerSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => identification(),
    getSessionKey: sessionId => ({sessionId, generation: 5}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY',
  };
  return {
    client,
    controller: new PowerConfigurationController({
      coordinator,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => false,
    }),
  };
}

function enqueuePower(client: FakeClient, capacity = 1500) {
  client.enqueue(MSP_BATTERY_CONFIG, {payload: batteryConfig(capacity)});
  client.enqueue(MSP_VOLTAGE_METER_CONFIG, {payload: voltageMeters()});
  client.enqueue(MSP_CURRENT_METER_CONFIG, {payload: currentMeters()});
}

async function loadPower(
  h: ReturnType<typeof powerHarness>,
): Promise<MspPowerConfigurationSnapshot> {
  enqueuePower(h.client);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED') {
    throw new Error(result.kind);
  }
  return result.snapshot;
}

describe('power: the paths nothing was checking', () => {
  it('refuses to write onto a board that changed underneath the operator', async () => {
    const h = powerHarness();
    const original = await loadPower(h);
    enqueuePower(h.client, 2200); // capacity changed on the board
    const draft = {...createPowerConfigurationDraft(original), capacityMah: 1800};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_BATTERY_CONFIG,
    );
  });

  it('reports a write whose outcome is UNKNOWN as unconfirmed, never as saved', async () => {
    const h = powerHarness();
    const original = await loadPower(h);
    enqueuePower(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BATTERY_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createPowerConfigurationDraft(original), capacityMah: 1800};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('UNCONFIRMED');
  });

  it('does not persist when the settings write never landed', async () => {
    const h = powerHarness();
    const original = await loadPower(h);
    enqueuePower(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BATTERY_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createPowerConfigurationDraft(original), capacityMah: 1800};

    await h.controller.save(key, original, draft);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does not claim verification when the readback disagrees', async () => {
    const h = powerHarness();
    const original = await loadPower(h);
    enqueuePower(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BATTERY_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueuePower(h.client); // still 1500 - the write did not take
    const draft = {...createPowerConfigurationDraft(original), capacityMah: 1800};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).not.toBe('SAVED_VERIFIED');
  });

  it('treats an encode failure as a definite non-write, not an ambiguous one', async () => {
    const h = powerHarness();
    const original = await loadPower(h);
    enqueuePower(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BATTERY_CONFIG, {reject: {code: 'MSP_ENCODE_FAILED'}});
    const draft = {...createPowerConfigurationDraft(original), capacityMah: 1800};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('FAILED');
  });
});

/* ------------------------------------------------------------------ *
 * OSD
 *
 * This file's own header named OSD and VTX alongside Failsafe and
 * Power - four controllers with three tests each, covering "it saved"
 * and "it refused while armed" and nothing else. The first round closed
 * Failsafe and Power and left these two open, so an OSD save whose
 * outcome was UNKNOWN, or whose base had moved, or whose readback
 * disagreed, was unproven behaviour on a screen that writes to EEPROM.
 *
 * On OSD specifically the stale-base case is not theoretical. The layout
 * is edited by dragging elements to positions; a base that moved between
 * the read and the save means the operator's diff lands on somebody
 * else's layout, and OSD element positions are packed bit fields, so a
 * wrong base does not produce a wrong number - it produces an element
 * somewhere nobody put it.
 * ------------------------------------------------------------------ */

function osdConfigPayload(rssi: number): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  let o = 0;
  bytes[o++] = 1; bytes[o++] = 3; bytes[o++] = 1; bytes[o++] = rssi;
  view.setUint16(o, 1400, true); o += 2;
  bytes[o++] = 0; bytes[o++] = 1;
  view.setUint16(o, 120, true); o += 2;
  view.setUint16(o, 0x0805, true); o += 2;
  bytes[o++] = 1; bytes[o++] = 1; bytes[o++] = 1;
  view.setUint16(o, 0x0a21, true); o += 2;
  view.setUint16(o, 1, true); o += 2;
  bytes[o++] = 2;
  view.setUint32(o, 1, true); o += 4;
  bytes[o++] = 3; bytes[o++] = 1; bytes[o++] = 0; bytes[o++] = 24; bytes[o++] = 11;
  view.setUint16(o, 70, true); o += 2;
  view.setInt16(o, -95, true); o += 2;
  return bytes.slice(0, o);
}

function osdHarness(minor = 47) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const coordinator = {
    getOwnershipState: () => 'ACTIVE' as const,
    getIdentificationState: () => identification(minor),
    getSessionKey: (sessionId: string) => ({sessionId, generation: 5}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY' as const,
  };
  return {
    client,
    controller: new OsdConfigurationController({
      coordinator: coordinator as never,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => false,
    }),
  };
}

function enqueueOsd(client: FakeClient, rssi = 30) {
  client.enqueue(MSP_OSD_CONFIG, {payload: osdConfigPayload(rssi)});
  client.enqueue(MSP_OSD_CANVAS, {payload: Uint8Array.from([53, 20])});
}

async function loadOsd(h: ReturnType<typeof osdHarness>): Promise<MspOsdSnapshot> {
  enqueueOsd(h.client);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED') throw new Error(result.kind);
  return result.snapshot;
}

describe('osd: the paths nothing was checking', () => {
  it('refuses to write onto a board that changed underneath the operator', async () => {
    const h = osdHarness();
    const original = await loadOsd(h);
    enqueueOsd(h.client, 55); // the FC now reports a different alarm
    const draft = {...createOsdConfigurationDraft(original), rssiAlarmPercent: 35};

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_OSD_CONFIG);
  });

  it('reports a write whose outcome is UNKNOWN as unconfirmed, never as saved', async () => {
    const h = osdHarness();
    const original = await loadOsd(h);
    enqueueOsd(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_OSD_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createOsdConfigurationDraft(original), rssiAlarmPercent: 35};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('UNCONFIRMED');
  });

  it('does not persist when the settings write never landed', async () => {
    const h = osdHarness();
    const original = await loadOsd(h);
    enqueueOsd(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_OSD_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});
    const draft = {...createOsdConfigurationDraft(original), rssiAlarmPercent: 35};

    await h.controller.save(key, original, draft);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does not claim verification when the readback disagrees', async () => {
    const h = osdHarness();
    const original = await loadOsd(h);
    enqueueOsd(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_OSD_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueOsd(h.client); // still 30 - the write did not take
    const draft = {...createOsdConfigurationDraft(original), rssiAlarmPercent: 35};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).not.toBe('SAVED_VERIFIED');
  });

  it('treats an encode failure as a definite non-write, not an ambiguous one', async () => {
    const h = osdHarness();
    const original = await loadOsd(h);
    enqueueOsd(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_OSD_CONFIG, {reject: {code: 'MSP_ENCODE_FAILED'}});
    const draft = {...createOsdConfigurationDraft(original), rssiAlarmPercent: 35};

    const result = await h.controller.save(key, original, draft);
    expect(result.kind).toBe('FAILED');
  });
});

/* ------------------------------------------------------------------ *
 * VTX
 *
 * The same five paths, and the stakes here are a transmitter that may
 * be on a channel or a power level the operator did not choose - a
 * regulatory problem as well as a flying one. An UNCONFIRMED write is
 * exactly the case where the pilot must NOT be told the VTX is set.
 * ------------------------------------------------------------------ */

/** The 15-byte MSP_VTX_CONFIG frame; channel 1 is 5658 MHz, 2 is 5678. */
function vtxConfigPayload(channel: number): Uint8Array {
  return Uint8Array.from([
    3, 1, channel, 1, 0, channel === 1 ? 168 : 188, 22, 1, 0, 0, 0, 1, 1, 2, 1,
  ]);
}
const VTX_BAND = Uint8Array.from([1, 8, 82, 65, 67, 69, 66, 65, 78, 68, 82, 1, 2, 20, 23, 34, 23]);
const VTX_POWER = Uint8Array.from([1, 14, 0, 3, 50, 53, 0]);

function vtxHarness(minor = 47) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const coordinator = {
    getOwnershipState: () => 'ACTIVE' as const,
    getIdentificationState: () => identification(minor),
    getSessionKey: (sessionId: string) => ({sessionId, generation: 5}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY' as const,
  };
  return {
    client,
    controller: new VtxConfigurationController({
      coordinator: coordinator as never,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => false,
    }),
  };
}

function enqueueVtx(client: FakeClient, channel = 1) {
  client.enqueue(MSP_VTX_CONFIG, {payload: vtxConfigPayload(channel)});
  client.enqueue(MSP_VTXTABLE_BAND, {payload: VTX_BAND});
  client.enqueue(MSP_VTXTABLE_POWERLEVEL, {payload: VTX_POWER});
}

async function loadVtx(h: ReturnType<typeof vtxHarness>): Promise<MspVtxSnapshot> {
  enqueueVtx(h.client);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED') throw new Error(result.kind);
  return result.snapshot;
}

/** Channel 2 on the same band, with the frequency that goes with it. */
function vtxChannelTwo(original: MspVtxSnapshot) {
  return {...createVtxConfigurationDraft(original), channel: 2, frequencyMhz: 5820};
}

describe('vtx: the paths nothing was checking', () => {
  it('refuses to write onto a board that changed underneath the operator', async () => {
    const h = vtxHarness();
    const original = await loadVtx(h);
    enqueueVtx(h.client, 2); // the VTX moved channel on its own
    await expect(h.controller.save(key, original, vtxChannelTwo(original))).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_SET_VTX_CONFIG);
  });

  it('reports a write whose outcome is UNKNOWN as unconfirmed, never as saved', async () => {
    // The transmitter may now be on either channel. Telling the pilot it
    // is set is the one answer that could put them on somebody else's.
    const h = vtxHarness();
    const original = await loadVtx(h);
    enqueueVtx(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_VTX_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});

    const result = await h.controller.save(key, original, vtxChannelTwo(original));
    expect(result.kind).toBe('UNCONFIRMED');
  });

  it('does not persist when the settings write never landed', async () => {
    const h = vtxHarness();
    const original = await loadVtx(h);
    enqueueVtx(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_VTX_CONFIG, {reject: {code: 'MSP_TIMEOUT'}});

    await h.controller.save(key, original, vtxChannelTwo(original));
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('does not claim verification when the readback disagrees', async () => {
    const h = vtxHarness();
    const original = await loadVtx(h);
    enqueueVtx(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_VTX_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueVtx(h.client); // still channel 1 - the write did not take

    const result = await h.controller.save(key, original, vtxChannelTwo(original));
    expect(result.kind).not.toBe('SAVED_VERIFIED');
  });

  it('treats an encode failure as a definite non-write, not an ambiguous one', async () => {
    const h = vtxHarness();
    const original = await loadVtx(h);
    enqueueVtx(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_VTX_CONFIG, {reject: {code: 'MSP_ENCODE_FAILED'}});

    const result = await h.controller.save(key, original, vtxChannelTwo(original));
    expect(result.kind).toBe('FAILED');
  });
});

/* ==================================================================== *
 * THE SAME COMPLETE SAVE, ON EVERY API VERSION THE FLOOR ADMITS
 * ==================================================================== */

/**
 * apiVersionCompatibility.test.ts proves this for Failsafe and Power.
 * These are the other two controllers whose fixtures exist here, so the
 * cheap thing to do is the right thing: run the WHOLE save - fresh read,
 * DISARMED proof, write, EEPROM, readback compare - against a board
 * reporting 1.47, then 1.48, then 1.49.
 *
 * The claim being tested is not "the screen opens". It is that the
 * 1.47-shaped payload this app writes is still correct on a newer board,
 * and the readback comparison at the end of the save is what would catch
 * it if it were not.
 *
 * STILL NOT a real 1.48 board. The scripted board answers with the
 * payloads this app decodes, which is exactly the forward-compatibility
 * claim under test. A physical Betaflight 4.7 remains a hardware item.
 */
const SAVE_VERSIONS = [47, 48, 49] as const;

describe.each(SAVE_VERSIONS)('a complete OSD save on API 1.%s', minor => {
  it('writes, persists and verifies against a readback', async () => {
    const h = osdHarness(minor);
    const original = await loadOsd(h);
    enqueueOsd(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_OSD_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueOsd(h.client, 35);

    const result = await h.controller.save(key, original, {
      ...createOsdConfigurationDraft(original),
      rssiAlarmPercent: 35,
    });

    expect(result.kind).toBe('SAVED_VERIFIED');
    expect(h.client.calls.map(call => call.command)).toContain(MSP_EEPROM_WRITE);
  });
});

describe.each(SAVE_VERSIONS)('a complete VTX save on API 1.%s', minor => {
  it('writes, persists and verifies against a readback', async () => {
    const h = vtxHarness(minor);
    const original = await loadVtx(h);
    enqueueVtx(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_VTX_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueVtx(h.client, 2);

    const result = await h.controller.save(key, original, vtxChannelTwo(original));

    expect(result.kind).toBe('SAVED_VERIFIED');
    expect(h.client.calls.map(call => call.command)).toContain(MSP_EEPROM_WRITE);
  });
});
