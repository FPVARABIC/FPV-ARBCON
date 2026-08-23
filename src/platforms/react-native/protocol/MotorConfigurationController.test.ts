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
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MIXER_CONFIG,
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
    isMotorOutputEngaged: () => options.motorTestActive === true,
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
  it('shares the versioned firmware gate and refuses INAV before any request', async () => {
    const harness = makeHarness();
    const compatible = compatibleIdentity();
    if (compatible.status !== 'SUCCEEDED') {
      throw new Error('fixture must be identified');
    }
    harness.state.identification = {
      status: 'SUCCEEDED',
      identity: {
        ...compatible.identity,
        firmware: {identifier: 'INAV', knownFamily: 'INAV'},
        apiVersion: {
          ...compatible.identity.apiVersion,
          apiVersionMajor: 2,
          apiVersionMinor: 5,
        },
      },
    };

    await expect(harness.controller.load('fc-1')).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'INCOMPATIBLE_FIRMWARE',
    });
    expect(harness.client.calls).toEqual([]);
  });

  /** Points the harness's identified firmware at a different API minor. */
  function atApiMinor(
    harness: ReturnType<typeof makeHarness>,
    apiVersionMinor: number,
  ): void {
    const compatible = compatibleIdentity();
    if (compatible.status !== 'SUCCEEDED') {
      throw new Error('fixture must be identified');
    }
    harness.state.identification = {
      status: 'SUCCEEDED',
      identity: {
        ...compatible.identity,
        apiVersion: { ...compatible.identity.apiVersion, apiVersionMinor },
      },
    };
  }

  /**
   * This test used to be called "keeps general configuration writes disabled
   * on the partial API-1.48 adapter" and asserted that a 1.48 LOAD returned
   * REJECTED/INCOMPATIBLE_FIRMWARE. Both halves of that were wrong.
   *
   * The write gate had nothing behind it: every motor MSP handler is
   * byte-identical between the API 1.47 and API 1.48 firmware trees. And a
   * LOAD should never have consulted the write capability in the first
   * place - it did only because captureSession defaulted the required
   * capability to MOTOR_CONFIGURATION_WRITE.
   */
  it('reads and writes on API 1.48, whose motor contract matches 1.47', async () => {
    const harness = makeHarness();
    atApiMinor(harness, 48);

    const original = await loadOriginal(harness);
    expect(original.advanced.motorProtocolRaw).toBe(7);

    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload() });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      payload: new Uint8Array(0),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: new Uint8Array(0) });
    enqueueSnapshot(harness.client, 550, 6);

    const outcome = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorProtocolRaw: 6,
    });
    expect(outcome.kind).toBe('SAVED_VERIFIED');
  });

  /**
   * API 1.49 has no published Betaflight source to check a setter against,
   * so the write stays withheld - but the READ does not, and the refusal
   * names the write rather than the screen.
   */
  it('reads on API 1.49 and refuses only the write, by its own reason', async () => {
    const harness = makeHarness();
    atApiMinor(harness, 49);

    const original = await loadOriginal(harness);
    const callsAfterLoad = harness.client.calls.length;
    expect(callsAfterLoad).toBeGreaterThan(0);

    const outcome = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorProtocolRaw: 6,
    });
    expect(outcome).toEqual({
      kind: 'REJECTED',
      reason: 'CONFIGURATION_WRITE_UNVERIFIED',
    });
    expect(harness.client.calls.length).toBe(callsAfterLoad);
  });

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

  /**
   * M-E §8 - NO SUCCESS BEFORE VERIFICATION, PROVED.
   *
   * M-E gave the Motors screen a mixer selector, so the byte this
   * transaction writes now changes which aircraft the flight controller
   * believes it is. Mutation testing then found that nothing asserted the
   * readback comparison at all: deleting it left every test green while
   * the app reported a mixer change as saved that the board had not
   * taken.
   *
   * The flight controller here acknowledges the write and the EEPROM
   * commit, and then reports the OLD mixer. That is the case the operator
   * must never be told is a success.
   */
  it('reports a mixer that did not take as SAVED_UNVERIFIED, not as saved', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_MIXER_CONFIG, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: Uint8Array.from([]) });
    // The readback: the SAME mixer byte the board started with.
    enqueueSnapshot(harness.client);

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      mixerModeRaw: 10,
    });

    expect(result).toMatchObject({
      kind: 'SAVED_UNVERIFIED',
      rebootRequired: true,
      changedGroups: ['MIXER'],
    });
    // The write and the persist both happened - the transaction is not
    // being described as a failure either.
    const commands = harness.client.calls.map(call => call.command);
    expect(commands).toContain(MSP_SET_MIXER_CONFIG);
    expect(commands).toContain(MSP_EEPROM_WRITE);
  });

  it('reports a mixer the board DID take as verified', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);
    enqueueSnapshot(harness.client);
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload(false) });
    harness.client.enqueue(MSP_SET_MIXER_CONFIG, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: Uint8Array.from([]) });
    // The readback: the mixer the operator asked for.
    harness.client.enqueue(MSP_FEATURE_CONFIG, { payload: FEATURE });
    harness.client.enqueue(MSP_MIXER_CONFIG, {
      payload: Uint8Array.from([10, MIXER[1]]),
    });
    harness.client.enqueue(MSP_MOTOR_CONFIG, { payload: MOTOR });
    harness.client.enqueue(MSP_MOTOR_3D_CONFIG, { payload: MOTOR_3D });
    harness.client.enqueue(MSP_ADVANCED_CONFIG, {
      payload: advancedPayload(550, 7),
    });

    const result = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      mixerModeRaw: 10,
    });

    expect(result).toMatchObject({
      kind: 'SAVED_VERIFIED',
      rebootRequired: true,
      changedGroups: ['MIXER'],
    });
  });

  /**
   * M-E: THE UNOWNED FIELDS COME FROM THE LIVE BOARD, NOT FROM THE BASE.
   *
   * MSP_SET_FEATURE_CONFIG carries ONE 32-bit mask for the whole
   * aircraft. Motors owns three bits of it; GPS, Ports, Receiver and
   * General own others. There is no way to set one bit, so whichever
   * snapshot the mask is mirrored from is the mask the aircraft ends up
   * with - and mirroring it from the snapshot this editor loaded means a
   * Motors save silently reverts whatever another screen changed since.
   *
   * The stale-base check cannot catch it: it compares the DRAFT, which
   * projects only the three owned bits, so an unowned bit set in between
   * compares equal and is then overwritten. Every signal says success.
   *
   * Mutation testing found that nothing asserted which snapshot the mask
   * came from. Here bit 5 - not one of the three Motors owns - is set on
   * the live board after this editor loaded, the operator toggles
   * MOTOR_STOP, and the mask that goes on the wire must still carry it.
   */
  it('mirrors unowned feature bits from the live board, not from the stale base', async () => {
    const harness = makeHarness();
    const original = await loadOriginal(harness);

    // The live board, read under the transaction's own lease.
    const OTHER_SCREENS_BIT = 1 << 5;
    harness.client.enqueue(MSP_FEATURE_CONFIG, {
      payload: Uint8Array.from([OTHER_SCREENS_BIT, 0, 0, 0]),
    });
    harness.client.enqueue(MSP_MIXER_CONFIG, {payload: MIXER});
    harness.client.enqueue(MSP_MOTOR_CONFIG, {payload: MOTOR});
    harness.client.enqueue(MSP_MOTOR_3D_CONFIG, {payload: MOTOR_3D});
    harness.client.enqueue(MSP_ADVANCED_CONFIG, {
      payload: advancedPayload(550, 7),
    });
    harness.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    harness.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});
    harness.client.enqueue(MSP_SET_FEATURE_CONFIG, {
      payload: Uint8Array.from([]),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, {payload: Uint8Array.from([])});
    enqueueSnapshot(harness.client);

    await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorStopEnabled: true,
    });

    const write = harness.client.calls.find(
      call => call.command === MSP_SET_FEATURE_CONFIG,
    );
    expect(write).toBeDefined();
    // The other screen's bit survives the Motors save.
    expect(write!.payload[0] & OTHER_SCREENS_BIT).toBe(OTHER_SCREENS_BIT);
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

  it.each([46, 48])(
    'allows the independently verified minimal DShot direction operation on API 1.%s',
    async apiVersionMinor => {
      const harness = makeHarness();
      const compatible = compatibleIdentity();
      if (compatible.status !== 'SUCCEEDED') {
        throw new Error('fixture must be identified');
      }
      harness.state.identification = {
        status: 'SUCCEEDED',
        identity: {
          ...compatible.identity,
          apiVersion: {...compatible.identity.apiVersion, apiVersionMinor},
        },
      };
      enqueueSnapshot(harness.client, 550, 6);
      harness.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
      harness.client.enqueue(MSP_STATUS_EX, {
        payload: statusPayload(false),
      });
      harness.client.enqueue(MSP2_SEND_DSHOT_COMMAND, {
        payload: Uint8Array.from([]),
      });

      await expect(
        harness.controller.setEscDirection('fc-1', 2, 'NORMAL'),
      ).resolves.toMatchObject({
        kind: 'ACKNOWLEDGED',
        motorNumber: 2,
        direction: 'NORMAL',
        physicallyVerified: false,
      });
      expect(
        harness.client.calls.filter(
          call => call.command === MSP2_SEND_DSHOT_COMMAND,
        ),
      ).toHaveLength(1);
      const commands = harness.client.calls.map(call => call.command);
      expect(commands).toEqual(
        expect.arrayContaining([
          MSP_FEATURE_CONFIG,
          MSP_MOTOR_CONFIG,
          MSP_ADVANCED_CONFIG,
          MSP_STATUS_EX,
          MSP2_SEND_DSHOT_COMMAND,
        ]),
      );
      expect(commands).not.toContain(MSP_MIXER_CONFIG);
      expect(commands).not.toContain(MSP_MOTOR_3D_CONFIG);
    },
  );

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

/**
 * M-D §0. The M-C report claimed the Motors screen sends no mixer write.
 * These two tests establish, through the production controller and against
 * the recorded wire traffic, what it actually does - because a claim about
 * the wire that was never measured on the wire is not evidence.
 *
 * msp_protocol.h:114-115 @ 7348054f
 *   MSP_MIXER_CONFIG      42   out message: GET
 *   MSP_SET_MIXER_CONFIG  43   in  message: SET   <- msp.c:3734-3743
 *                                    byte 0 mixerMode, byte 1 yaw_motors_reversed
 */
describe('M-D §0 - what the Motors screen really does with command 43', () => {
  /** HEX6X, yaw not reversed. Deliberately not a quad: a mixer byte that
   * came back as 3 would then be a normalisation bug, not a coincidence. */
  const HEX_MIXER = Uint8Array.from([10, 0]);
  /** The same hexacopter after the yaw sign flip took effect. */
  const HEX_MIXER_REVERSED = Uint8Array.from([10, 1]);

  /** One full five-group read, as the FC would answer it. The controller
   * performs three of these per save: the load, the pre-write re-read that
   * guards against a stale base, and the post-write verification. */
  function enqueueHexSnapshot(
    harness: ReturnType<typeof makeHarness>,
    mixer: Uint8Array = HEX_MIXER,
    protocol = 7,
  ): void {
    harness.client.enqueue(MSP_FEATURE_CONFIG, { payload: FEATURE });
    harness.client.enqueue(MSP_MIXER_CONFIG, { payload: mixer });
    harness.client.enqueue(MSP_MOTOR_CONFIG, { payload: MOTOR });
    harness.client.enqueue(MSP_MOTOR_3D_CONFIG, { payload: MOTOR_3D });
    harness.client.enqueue(MSP_ADVANCED_CONFIG, {
      payload: advancedPayload(550, protocol),
    });
  }

  async function loadHexacopter(harness: ReturnType<typeof makeHarness>) {
    enqueueHexSnapshot(harness);
    const loaded = await harness.controller.load('fc-1');
    if (loaded.kind !== 'LOADED') {
      throw new Error(`Expected LOADED, received ${loaded.kind}`);
    }
    expect(loaded.snapshot.mixer.mixerModeRaw).toBe(10);
    return loaded.snapshot;
  }

  it('DOES put command 43 on the wire when the yaw sign flip is saved', async () => {
    // The finding that corrects M-C. `motor-config-yaw-reversed` in
    // MotorConfigurationPanel is bound to draft.yawMotorsReversed, which is
    // byte 1 of this command. Betaflight's own Motors tab owns this same
    // write; the value of stating it here is that it is now measured.
    const harness = makeHarness();
    const original = await loadHexacopter(harness);
    enqueueHexSnapshot(harness); // the pre-write re-read
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload() });
    harness.client.enqueue(MSP_SET_MIXER_CONFIG, { payload: new Uint8Array(0) });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: new Uint8Array(0) });
    enqueueHexSnapshot(harness, HEX_MIXER_REVERSED); // the verification read

    const outcome = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      yawMotorsReversed: true,
    });
    expect(outcome.kind).toBe('SAVED_VERIFIED');

    const mixerWrites = harness.client.calls.filter(
      call => call.command === MSP_SET_MIXER_CONFIG,
    );
    expect(mixerWrites).toHaveLength(1);
    // Byte 0 is the airframe the FC reported, byte-identical. Byte 1 is the
    // only thing the user changed.
    expect(Array.from(mixerWrites[0].payload)).toEqual([10, 1]);
  });

  it('sends NO mixer write when only a non-mixer field is saved', async () => {
    // A protocol change must not drag the airframe byte onto the wire with
    // it. This is the assertion M-C thought it was making.
    const harness = makeHarness();
    const original = await loadHexacopter(harness);
    enqueueHexSnapshot(harness); // the pre-write re-read
    harness.client.enqueue(MSP_BOXIDS, { payload: Uint8Array.from([0]) });
    harness.client.enqueue(MSP_STATUS_EX, { payload: statusPayload() });
    harness.client.enqueue(MSP_SET_ADVANCED_CONFIG, {
      payload: new Uint8Array(0),
    });
    harness.client.enqueue(MSP_EEPROM_WRITE, { payload: new Uint8Array(0) });
    enqueueHexSnapshot(harness, HEX_MIXER, 6); // the verification read

    const outcome = await harness.controller.save('fc-1', original, {
      ...createMotorConfigurationDraft(original),
      motorProtocolRaw: 6,
    });
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(harness.client.calls.map(call => call.command)).not.toContain(
      MSP_SET_MIXER_CONFIG,
    );
  });
});
