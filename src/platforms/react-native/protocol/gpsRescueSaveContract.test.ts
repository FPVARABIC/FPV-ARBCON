/**
 * GPS RESCUE, THROUGH THE CONTROLLER THAT ACTUALLY TALKS TO THE BOARD.
 *
 * The decoder and encoder tests prove the bytes. This file proves the
 * things only the controller can get wrong, and every one of them is a
 * way a pilot could be told their rescue is configured when it is not:
 *
 *   - MSP_GPS_RESCUE is an OPTIONAL command. A board that does not
 *     implement it must degrade the rescue card, not take the Failsafe
 *     screen down - but a TIMEOUT must not be laundered into "this board
 *     has no rescue", because that hides a failing link.
 *   - A rescue parameter is only written when it changed. Editing the
 *     failsafe delay must not rewrite the rescue block.
 *   - The full save contract applies unchanged: DISARMED, fresh base,
 *     acknowledged write, EEPROM, readback compare.
 */

import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BOXIDS,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_GPS_RESCUE,
  MSP_RXFAIL_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_SET_GPS_RESCUE,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {gpsRescuePayload} from '../../../core/protocol/__testUtils__/gpsRescueFixtures';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import type {MspFailsafeSnapshot} from '../../../core/protocol/msp/decoding/decodeFailsafe';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {FailsafeConfigurationController, type FailsafeSessionCoordinator} from './FailsafeConfigurationController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'rescue-fc', generation: 4} as const;

class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array}> = [];
  private readonly scripts = new Map<number, Script[]>();
  getEpoch() {
    return 1;
  }
  enqueue(command: number, ...scripts: Script[]) {
    this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]);
  }
  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    this.calls.push({command, payload});
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) throw script.reject;
    return {
      protocolVersion: 'v1',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: script?.payload ?? EMPTY,
    };
  }
  commands(): number[] {
    return this.calls.map(call => call.command);
  }
  sent(command: number): Uint8Array[] {
    return this.calls.filter(call => call.command === command).map(call => call.payload);
  }
}

function identification(): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
      board: {},
    },
  } as MspIdentificationState;
}

function harness() {
  const client = new FakeClient();
  const telemetry = {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
  const coordinator: FailsafeSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => identification(),
    getSessionKey: sessionId => ({sessionId, generation: 4}),
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

const failsafeMain = (delay = 15) => Uint8Array.from([delay, 60, 232, 3, 0, 100, 0, 1]);
const failsafeRx = () => Uint8Array.from([0, 220, 5, 0, 220, 5, 0, 220, 5, 0, 232, 3, 1, 220, 5]);
/** BUILD_OPTION_GPS at the offset decodeBuildOptions reads it from. */
function buildInfo(withGps: boolean): Uint8Array {
  const data = new Uint8Array(30);
  if (withGps) new DataView(data.buffer).setUint16(26, 16412, true);
  return data;
}

/** One complete snapshot read: the three failsafe frames plus rescue. */
function enqueueRead(
  client: FakeClient,
  options: {delay?: number; gps?: boolean; rescue?: Script} = {},
) {
  const {delay = 15, gps = true, rescue = {payload: gpsRescuePayload()}} = options;
  client.enqueue(MSP_FAILSAFE_CONFIG, {payload: failsafeMain(delay)});
  client.enqueue(MSP_RXFAIL_CONFIG, {payload: failsafeRx()});
  client.enqueue(MSP_BUILD_INFO, {payload: buildInfo(gps)});
  if (gps) client.enqueue(MSP_GPS_RESCUE, rescue);
}

function enqueueDisarmed(client: FakeClient) {
  client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
  client.enqueue(MSP_STATUS_EX, {
    payload: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]),
  });
}

async function load(h: ReturnType<typeof harness>, options?: Parameters<typeof enqueueRead>[1]): Promise<MspFailsafeSnapshot> {
  enqueueRead(h.client, options);
  const result = await h.controller.load(key);
  if (result.kind !== 'LOADED') throw new Error(`load ${result.kind}`);
  return result.snapshot;
}

describe('reading GPS Rescue from a real board', () => {
  it('reads the parameters and reports them as present', async () => {
    const snapshot = await load(harness());
    expect(snapshot.gpsRescueAvailability).toBe('PRESENT');
    expect(snapshot.gpsRescue?.returnAltitudeM).toBe(120);
    expect(snapshot.gpsRescue?.minSats).toBe(9);
  });

  it('never asks a build without GPS for parameters it cannot have', async () => {
    const h = harness();
    const snapshot = await load(h, {gps: false});
    expect(snapshot.gpsRescueAvailability).toBe('NO_GPS_IN_BUILD');
    expect(h.client.commands()).not.toContain(MSP_GPS_RESCUE);
  });

  it('keeps the Failsafe screen alive when the board refuses the command', async () => {
    // A wing build, or GPS_RESCUE compiled out: the firmware answers with
    // an error frame. Failing the whole load here would leave an operator
    // unable to reach the failsafe delay because of a feature they may
    // not even use.
    const h = harness();
    const snapshot = await load(h, {rescue: {reject: {code: 'MSP_REMOTE_ERROR'}}});
    expect(snapshot.gpsRescueAvailability).toBe('COMMAND_UNSUPPORTED');
    expect(snapshot.gpsRescue).toBeUndefined();
    expect(snapshot.config.delayDeciseconds).toBe(15);
  });

  it('does NOT launder a timeout into an absent feature', async () => {
    // The distinction this test exists for. A dying link reported as
    // "this board has no GPS Rescue" would hide a fault the operator has
    // to know about before flying.
    const h = harness();
    enqueueRead(h.client, {rescue: {reject: {code: 'MSP_TIMEOUT'}}});
    const result = await h.controller.load(key);
    expect(result.kind).toBe('FAILED');
  });

  it('shows nothing rather than a number it could not decode', async () => {
    const h = harness();
    const snapshot = await load(h, {rescue: {payload: new Uint8Array(4)}});
    expect(snapshot.gpsRescueAvailability).toBe('UNREADABLE');
    expect(snapshot.gpsRescue).toBeUndefined();
  });
});

describe('saving a GPS Rescue parameter', () => {
  it('writes the block, persists it, and confirms it from a readback', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, returnAltitudeM: 150},
    };
    enqueueRead(h.client); // the pre-write freshness read
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_GPS_RESCUE, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client, {rescue: {payload: gpsRescuePayload({returnAltitudeM: 150})}});

    const result = await h.controller.save(key, original, draft);

    expect(result.kind).toBe('SAVED_VERIFIED');
    const written = h.client.sent(MSP_SET_GPS_RESCUE);
    expect(written).toHaveLength(1);
    expect(new DataView(written[0].buffer).getUint16(2, true)).toBe(150);
    // The autopilot fields rode along untouched, as they must.
    expect(new DataView(written[0].buffer).getUint16(12, true)).toBe(1275);
  });

  it('persists only after the write was acknowledged', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, minSats: 12},
    };
    enqueueRead(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_GPS_RESCUE, {reject: {code: 'MSP_TIMEOUT'}});

    const result = await h.controller.save(key, original, draft);

    expect(result.kind).toBe('UNCONFIRMED');
    expect(h.client.commands()).not.toContain(MSP_EEPROM_WRITE);
  });

  it('refuses the word "verified" when the board reads back something else', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, descentDistanceM: 250},
    };
    enqueueRead(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_GPS_RESCUE, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client); // unchanged: the write did not take

    const result = await h.controller.save(key, original, draft);

    expect(result.kind).not.toBe('SAVED_VERIFIED');
  });

  it('refuses to write onto rescue values that moved underneath the operator', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, minSats: 12},
    };
    // The board now reports a different return altitude - a CLI edit, or
    // another client. The operator's diff must not land on it.
    enqueueRead(h.client, {rescue: {payload: gpsRescuePayload({returnAltitudeM: 60})}});

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'STALE_BASE',
    });
    expect(h.client.commands()).not.toContain(MSP_SET_GPS_RESCUE);
  });

  it('will not touch a rescue parameter on an ARMED aircraft', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, minSats: 12},
    };
    enqueueRead(h.client);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {
      payload: Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]),
    });

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'FC_ARMED',
    });
    expect(h.client.commands()).not.toContain(MSP_SET_GPS_RESCUE);
  });

  it('leaves the rescue block alone when only the failsafe delay changed', async () => {
    // MSP_SET_GPS_RESCUE is all-or-nothing, so an unnecessary send would
    // rewrite eleven settings to change one that is not among them.
    const h = harness();
    const original = await load(h);
    const draft = {...createFailsafeConfigurationDraft(original), delayDeciseconds: 20};
    enqueueRead(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client, {delay: 20});

    const result = await h.controller.save(key, original, draft);

    expect(result.kind).toBe('SAVED_VERIFIED');
    expect(h.client.commands()).toContain(MSP_SET_FAILSAFE_CONFIG);
    expect(h.client.commands()).not.toContain(MSP_SET_GPS_RESCUE);
  });

  it('refuses a rescue value the firmware itself would reject, without touching the board', async () => {
    const h = harness();
    const original = await load(h);
    const draft = {
      ...createFailsafeConfigurationDraft(original),
      // settings.c caps gps_rescue_return_alt at 1000 m.
      gpsRescue: {...createFailsafeConfigurationDraft(original).gpsRescue!, returnAltitudeM: 2500},
    };

    await expect(h.controller.save(key, original, draft)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    expect(h.client.commands()).not.toContain(MSP_SET_GPS_RESCUE);
  });

  it('writes the failsafe procedure BEFORE the rescue parameters it uses', async () => {
    // Order matters on an interrupted save: if the procedure lands and
    // the parameters do not, the aircraft still holds the rescue settings
    // it already had rather than half of a new set.
    const h = harness();
    const original = await load(h);
    const base = createFailsafeConfigurationDraft(original);
    const draft = {...base, procedure: 2 as const, gpsRescue: {...base.gpsRescue!, minSats: 12}};
    enqueueRead(h.client);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_FAILSAFE_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_SET_GPS_RESCUE, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client);

    await h.controller.save(key, original, draft);

    const commands = h.client.commands();
    expect(commands.indexOf(MSP_SET_FAILSAFE_CONFIG)).toBeLessThan(commands.indexOf(MSP_SET_GPS_RESCUE));
    expect(commands.indexOf(MSP_SET_GPS_RESCUE)).toBeLessThan(commands.indexOf(MSP_EEPROM_WRITE));
  });
});
