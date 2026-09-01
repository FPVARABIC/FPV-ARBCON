/**
 * WHICH FIRMWARE VERSIONS EACH CONFIGURATION SCREEN ACCEPTS, AS A MATRIX.
 *
 * THE DEFECT THIS CLOSES. Eight controllers carried their own inline
 * `apiVersionMinor !== 47`, so Betaflight 4.7 (API 1.48) turned Failsafe,
 * Power, OSD, PID, VTX, Modes, Configuration and FC Tools into
 * UNSUPPORTED_FIRMWARE while Ports, GPS and Receiver kept working. Half a
 * dead app is worse for an operator than a clean refusal, and nothing in
 * the suite noticed because every test constructed a 1.47 board.
 *
 * WHAT THIS FILE ASSERTS, and why it is a matrix rather than a single
 * case: the interesting behaviour is at the BOUNDARIES. 1.46 must still
 * be refused (a real contract difference - MSP_STATUS_EX carries no
 * numberOfRateProfiles before 1.47), 1.47 and 1.48 must both work, and
 * 1.49 stands in for "a version that did not exist when this was
 * written". That last one is the whole point: a future minor must not
 * need a code change to be readable, because the payload rule is
 * lenient reading plus verified-only writing, not a version whitelist.
 *
 * The payload-by-payload justification for 1.48 lives in
 * betaflightApiSupport.ts, checked against betaflight-configurator's
 * MSPHelper.js and the firmware's own msp.c.
 *
 * SCOPE, IN TWO PARTS. The first section probes ADMISSION on all eight
 * controllers - whether the screen opens at all. The second runs a REAL,
 * complete save at each version, because "the screen opens on 1.48" is
 * not the question that matters: a screen that opens and then writes a
 * payload the newer firmware reads differently would pass an admission
 * test and still misconfigure an aircraft. The save probe is on Failsafe
 * (with GPS Rescue) and Power because those carry the full fixture sets;
 * the payload-by-payload argument for the other six is in
 * betaflightApiSupport.ts, checked against MSPHelper.js and msp.c.
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
  MSP_GPS_RESCUE,
  MSP_RXFAIL_CONFIG,
  MSP_SET_BATTERY_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_SET_GPS_RESCUE,
  MSP_STATUS_EX,
  MSP_VOLTAGE_METER_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {deriveSetupDiagnostics} from '../../../core/state/setupDiagnostics';
import {gpsRescuePayload} from '../../../core/protocol/__testUtils__/gpsRescueFixtures';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import {createPowerConfigurationDraft} from '../../../core/state/powerConfigurationModel';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {
  isSupportedConfigurationApi,
  supportsAbsoluteControlGain,
  MINIMUM_CONFIGURATION_API_MINOR,
} from './betaflightApiSupport';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {PowerConfigurationController} from './PowerConfigurationController';
import {OsdConfigurationController} from './OsdConfigurationController';
import {PidTuningController} from './PidTuningController';
import {VtxConfigurationController} from './VtxConfigurationController';
import {ModesConfigurationController} from './ModesConfigurationController';
import {GeneralConfigurationController} from './GeneralConfigurationController';
import {BoardAlignmentController} from './BoardAlignmentController';

const key = {sessionId: 'api-matrix', generation: 3} as const;

/** Answers every request with an empty frame: enough to reach - or not
 * reach - the version gate, which is all this file measures. */
class SilentClient {
  getEpoch() {
    return 1;
  }
  async request(
    command: number,
    _payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    return {
      protocolVersion: 'v1',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: new Uint8Array(0),
    };
  }
}

function identification(minor: number, identifier = 'BTFL'): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: {identifier, knownFamily: 'BETAFLIGHT'},
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

function coordinatorFor(minor: number, identifier = 'BTFL') {
  const client = new SilentClient();
  const telemetry = scheduler();
  return {
    getOwnershipState: () => 'ACTIVE' as const,
    getIdentificationState: () => identification(minor, identifier),
    getSessionKey: (sessionId: string) => ({sessionId, generation: 3}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY' as const,
  };
}

const OPTIONS = {
  appStateOwner: {getPhase: () => 'ACTIVE' as const},
  isMotorTestActive: () => false,
};

/** Every controller that shares the configuration API floor. */
const CONTROLLERS = [
  ['Failsafe', (c: unknown) => new FailsafeConfigurationController({coordinator: c as never, ...OPTIONS})],
  ['Power', (c: unknown) => new PowerConfigurationController({coordinator: c as never, ...OPTIONS})],
  ['OSD', (c: unknown) => new OsdConfigurationController({coordinator: c as never, ...OPTIONS})],
  ['PID', (c: unknown) => new PidTuningController({coordinator: c as never, ...OPTIONS})],
  ['VTX', (c: unknown) => new VtxConfigurationController({coordinator: c as never, ...OPTIONS})],
  ['Modes', (c: unknown) => new ModesConfigurationController({coordinator: c as never, ...OPTIONS})],
  ['Configuration', (c: unknown) => new GeneralConfigurationController({coordinator: c as never, ...OPTIONS})],
  // Board Alignment shares the same floor. Its own suite runs a full
  // save at 1.47/1.48/1.49; it is listed here so that a future change to
  // the shared gate cannot silently leave it behind.
  ['BoardAlignment', (c: unknown) => new BoardAlignmentController({coordinator: c as never, ...OPTIONS})],
] as const;

/**
 * Did the version gate refuse this board?
 *
 * Anything OTHER than UNSUPPORTED_FIRMWARE means admission succeeded -
 * the load may still fail further along on an empty scripted payload,
 * which is expected here and deliberately not asserted.
 */
async function refusedForVersion(
  make: (coordinator: unknown) => {load: (k: typeof key) => Promise<unknown>},
  minor: number,
  identifier = 'BTFL',
): Promise<boolean> {
  const result = (await make(coordinatorFor(minor, identifier)).load(key)) as {
    kind?: string;
    reason?: string;
  };
  return result.kind === 'REJECTED' && result.reason === 'UNSUPPORTED_FIRMWARE';
}

describe('the configuration API floor is one rule, not eight', () => {
  it('refuses everything below the verified contract', () => {
    expect(isSupportedConfigurationApi(identification(46))).toBe(false);
    expect(isSupportedConfigurationApi(identification(45))).toBe(false);
    expect(MINIMUM_CONFIGURATION_API_MINOR).toBe(47);
  });

  it('accepts the verified version and every later minor', () => {
    expect(isSupportedConfigurationApi(identification(47))).toBe(true);
    expect(isSupportedConfigurationApi(identification(48))).toBe(true);
    expect(isSupportedConfigurationApi(identification(49))).toBe(true);
    expect(isSupportedConfigurationApi(identification(60))).toBe(true);
  });

  it('still refuses firmware that is not Betaflight, at any version', () => {
    // The floor was never the only thing the gate did.
    expect(isSupportedConfigurationApi(identification(48, 'INAV'))).toBe(false);
    expect(isSupportedConfigurationApi(identification(48, 'ARDU'))).toBe(false);
  });

  it('refuses a board whose identification never succeeded', () => {
    expect(
      isSupportedConfigurationApi({status: 'FAILED', error: new Error('x')} as MspIdentificationState),
    ).toBe(false);
  });

  it('covers FC Tools too - the eighth screen, which had its own copy', () => {
    // FC Tools does not expose load(); it gates every tool operation on
    // its own compatibility verdict, and that verdict kept an exact
    // `=== 47` after the other seven moved. On Betaflight 4.7 it refused
    // every operation while the screens beside it worked.
    const view = (minor: number, identifier = 'BTFL') =>
      deriveSetupDiagnostics({
        identificationStatus: 'SUCCEEDED',
        identity: {
          firmware: {identifier, knownFamily: 'BETAFLIGHT'},
          apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: minor},
          board: {},
        },
        status: 'FRESH',
        value: undefined,
        channelState: 'ACTIVE',
        connected: true,
      } as never).compatibility;

    expect(view(46)).toBe('OTHER_FIRMWARE_OR_API');
    expect(view(47)).toBe('BETAFLIGHT_API_1_47');
    expect(view(48)).toBe('BETAFLIGHT_API_1_47');
    expect(view(49)).toBe('BETAFLIGHT_API_1_47');
    expect(view(48, 'INAV')).toBe('OTHER_FIRMWARE_OR_API');
  });

  it('knows absolute-control gain stopped being a setting at 1.48', () => {
    // The firmware reads and discards that byte from 1.48, so a screen
    // must not present the decoded value as a live setting.
    expect(supportsAbsoluteControlGain(identification(47))).toBe(true);
    expect(supportsAbsoluteControlGain(identification(48))).toBe(false);
    expect(supportsAbsoluteControlGain(identification(49))).toBe(false);
  });
});

describe.each(CONTROLLERS)('%s admission across API versions', (_name, make) => {
  it('refuses API 1.46 - a real contract difference, not an oversight', async () => {
    await expect(refusedForVersion(make as never, 46)).resolves.toBe(true);
  });

  it('accepts API 1.47 - the verified contract', async () => {
    await expect(refusedForVersion(make as never, 47)).resolves.toBe(false);
  });

  it('accepts API 1.48 - Betaflight 4.7', async () => {
    await expect(refusedForVersion(make as never, 48)).resolves.toBe(false);
  });

  it('accepts API 1.49 - a version that did not exist when this was written', async () => {
    await expect(refusedForVersion(make as never, 49)).resolves.toBe(false);
  });

  it('still refuses a non-Betaflight board on a new API', async () => {
    await expect(refusedForVersion(make as never, 48, 'INAV')).resolves.toBe(true);
  });
});

/* ==================================================================== *
 * PART TWO: DOES IT SAVE, OR DOES IT ONLY OPEN?
 * ==================================================================== */

/**
 * A complete save - fresh read, DISARMED proof, write, EEPROM, readback -
 * run against a board reporting each API version in turn.
 *
 * This is the probe that answers the real question. Relaxing a version
 * gate makes screens OPEN on 1.48; it says nothing about whether the
 * bytes they then write are still correct there. If a 1.47-shaped payload
 * were wrong on 1.48, the readback comparison at the end of the save
 * would refuse to call it verified - so SAVED_VERIFIED at 1.48 and 1.49
 * is evidence about the payload, not just about the gate.
 *
 * What it does NOT prove: a real 1.48 board. The scripted board answers
 * with the 1.47-shaped payloads this app decodes, which is exactly the
 * forward-compatibility claim under test (tail additions are ignored on
 * read; short writes leave newer fields alone by the firmware's own
 * `sbufBytesRemaining` guards). A physical 4.7 board remains a Hardware
 * Verification item.
 */

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);

class ScriptedClient {
  readonly calls: number[] = [];
  private readonly scripts = new Map<number, Script[]>();
  getEpoch() {
    return 1;
  }
  enqueue(command: number, ...scripts: Script[]) {
    this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]);
  }
  async request(command: number, _payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    this.calls.push(command);
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
}

function scriptedCoordinator(client: ScriptedClient, minor: number) {
  const telemetry = scheduler();
  return {
    getOwnershipState: () => 'ACTIVE' as const,
    getIdentificationState: () => identification(minor),
    getSessionKey: (sessionId: string) => ({sessionId, generation: 3}),
    getActiveMspClient: () => client,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY' as const,
  };
}

/** DISARMED, ARM box at permanent id 0. */
const DISARMED_STATUS = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0,
]);
function enqueueDisarmed(client: ScriptedClient) {
  client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
  client.enqueue(MSP_STATUS_EX, {payload: DISARMED_STATUS});
}

/* ---------------------------- Failsafe ---------------------------- */

const failsafeMain = (delay: number) => Uint8Array.from([delay, 60, 232, 3, 0, 100, 0, 1]);
const failsafeRx = () => Uint8Array.from([0, 220, 5, 0, 220, 5, 0, 220, 5, 0, 232, 3, 1, 220, 5]);
function buildInfoWithGps(): Uint8Array {
  const data = new Uint8Array(30);
  new DataView(data.buffer).setUint16(26, 16412, true);
  return data;
}
function enqueueFailsafeRead(client: ScriptedClient, delay: number) {
  client.enqueue(MSP_FAILSAFE_CONFIG, {payload: failsafeMain(delay)});
  client.enqueue(MSP_RXFAIL_CONFIG, {payload: failsafeRx()});
  client.enqueue(MSP_BUILD_INFO, {payload: buildInfoWithGps()});
  client.enqueue(MSP_GPS_RESCUE, {payload: gpsRescuePayload()});
}

/* ------------------------------ Power ------------------------------ */

function batteryConfig(capacity: number): Uint8Array {
  return Uint8Array.from([0, 0, 0, capacity % 256, Math.floor(capacity / 256), 1, 1, 74, 1, 174, 1, 94, 1]);
}
function enqueuePowerRead(client: ScriptedClient, capacity: number) {
  client.enqueue(MSP_BATTERY_CONFIG, {payload: batteryConfig(capacity)});
  client.enqueue(MSP_VOLTAGE_METER_CONFIG, {payload: Uint8Array.from([1, 5, 10, 0, 110, 10, 1])});
  client.enqueue(MSP_CURRENT_METER_CONFIG, {payload: Uint8Array.from([1, 6, 20, 0, 100, 0, 0, 0])});
}

const SAVE_VERSIONS = [46, 47, 48, 49] as const;

describe.each(SAVE_VERSIONS)('a complete Failsafe save on API 1.%s', minor => {
  const supported = minor >= MINIMUM_CONFIGURATION_API_MINOR;

  it(supported ? 'writes, persists and verifies against a readback' : 'is refused before anything is written', async () => {
    const client = new ScriptedClient();
    const controller = new FailsafeConfigurationController({coordinator: scriptedCoordinator(client, minor) as never, ...OPTIONS});
    enqueueFailsafeRead(client, 15);
    const loaded = await controller.load(key);
    if (!supported) {
      expect(loaded).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_FIRMWARE'});
      return;
    }
    if (loaded.kind !== 'LOADED') throw new Error(`load ${loaded.kind}`);

    // The rescue return altitude AND the failsafe delay in one save, so
    // both write groups are exercised on this version.
    const base = createFailsafeConfigurationDraft(loaded.snapshot);
    const draft = {...base, delayDeciseconds: 20, gpsRescue: {...base.gpsRescue!, returnAltitudeM: 150}};
    enqueueFailsafeRead(client, 15); // freshness read: unchanged base
    enqueueDisarmed(client);
    client.enqueue(MSP_SET_FAILSAFE_CONFIG, {payload: EMPTY});
    client.enqueue(MSP_SET_GPS_RESCUE, {payload: EMPTY});
    client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    client.enqueue(MSP_FAILSAFE_CONFIG, {payload: failsafeMain(20)});
    client.enqueue(MSP_RXFAIL_CONFIG, {payload: failsafeRx()});
    client.enqueue(MSP_BUILD_INFO, {payload: buildInfoWithGps()});
    client.enqueue(MSP_GPS_RESCUE, {payload: gpsRescuePayload({returnAltitudeM: 150})});

    const saved = await controller.save(key, loaded.snapshot, draft);

    expect(saved.kind).toBe('SAVED_VERIFIED');
    expect(client.calls).toContain(MSP_SET_GPS_RESCUE);
    expect(client.calls).toContain(MSP_EEPROM_WRITE);
  });
});

describe.each(SAVE_VERSIONS)('a complete Power save on API 1.%s', minor => {
  const supported = minor >= MINIMUM_CONFIGURATION_API_MINOR;

  it(supported ? 'writes, persists and verifies against a readback' : 'is refused before anything is written', async () => {
    const client = new ScriptedClient();
    const controller = new PowerConfigurationController({coordinator: scriptedCoordinator(client, minor) as never, ...OPTIONS});
    enqueuePowerRead(client, 1500);
    const loaded = await controller.load(key);
    if (!supported) {
      expect(loaded).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_FIRMWARE'});
      return;
    }
    if (loaded.kind !== 'LOADED') throw new Error(`load ${loaded.kind}`);

    const draft = {...createPowerConfigurationDraft(loaded.snapshot), capacityMah: 1800};
    enqueuePowerRead(client, 1500);
    enqueueDisarmed(client);
    client.enqueue(MSP_SET_BATTERY_CONFIG, {payload: EMPTY});
    client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueuePowerRead(client, 1800);

    const saved = await controller.save(key, loaded.snapshot, draft);

    expect(saved.kind).toBe('SAVED_VERIFIED');
    expect(client.calls).toContain(MSP_EEPROM_WRITE);
  });
});
