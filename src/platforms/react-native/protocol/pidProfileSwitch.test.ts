/**
 * SWITCHING THE ACTIVE PID / RATE PROFILE.
 *
 * The screen showed which profile was active and gave no way to change
 * it, so a pilot keeping a cruise profile and a freestyle profile had to
 * reach for the CLI or the radio. `MSP_SELECT_SETTING` is the command
 * Betaflight itself uses, with an encoding that is easy to get wrong:
 * a PID profile is the bare index, a RATE profile is the index OR'd with
 * 0x80 (betaflight-configurator, PidTuningTab.vue).
 *
 * WHAT THESE PROVE, and the last one is the point of the whole feature:
 * an acknowledgement is NOT evidence the profile changed. The board is
 * re-read afterwards, and anything other than "it now reports the
 * profile that was asked for" is refused the word SWITCHED.
 */

import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_ADVANCED_CONFIG,
  MSP_BOXIDS,
  MSP_FILTER_CONFIG,
  MSP_PID,
  MSP_PID_ADVANCED,
  MSP_RC_TUNING,
  MSP_SELECT_SETTING,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {SELECT_SETTING_RATE_PROFILE_FLAG} from '../../../core/protocol/msp/encoding/encodeSelectSetting';
import type {MspIdentificationState} from './MspSessionCoordinator';
import {PidTuningController, type PidSessionCoordinator} from './PidTuningController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'pid-profile', generation: 2} as const;

class FakeClient {
  readonly calls: Array<{command: number; payload: Uint8Array}> = [];
  private readonly scripts = new Map<number, Script[]>();
  /** Set by the test to make MSP_STATUS_EX report a given active pair. */
  pidProfile = 0;
  rateProfile = 0;
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
    const body =
      script?.payload ?? (command === MSP_STATUS_EX ? this.status() : this.defaultFor(command));
    return {
      protocolVersion: 'v1',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: body,
    };
  }
  /** MSP_STATUS_EX: 13-byte prefix (pid profile index at offset 10),
   * then the readiness tail carrying the profile counts. */
  private status(): Uint8Array {
    return Uint8Array.from([
      0, 0, 0, 0, 0, 0, // cycle time, i2c errors, sensors
      0, 0, 0, 0, // flight mode flags - DISARMED
      this.pidProfile, // pid profile index
      0, 0, // cpu load
      3, // pidProfileCount
      this.rateProfile, // controlRateProfileIndex
      0, // extra flight-mode flag bytes
      4, 0, 0, 0, 0, // arming disable flags count + mask
      0, // config state
    ]);
  }
  /**
   * Zero-filled payloads at or above each decoder's minimum length for
   * API 1.47. The VALUES are irrelevant here - this file is about which
   * profile is active and how it is selected, not about tuning numbers -
   * but the LENGTHS are not: a short frame is a decode error, and the
   * controller would report FAILED for a reason that has nothing to do
   * with profile switching.
   */
  private defaultFor(command: number): Uint8Array {
    if (command === MSP_PID) return new Uint8Array(30);
    if (command === MSP_RC_TUNING) return new Uint8Array(60);
    if (command === MSP_PID_ADVANCED) return new Uint8Array(80);
    if (command === MSP_FILTER_CONFIG) return new Uint8Array(60);
    if (command === MSP_ADVANCED_CONFIG) return new Uint8Array(40);
    if (command === MSP_BOXIDS) return Uint8Array.from([0]);
    return EMPTY;
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
  const coordinator: PidSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => identification(),
    getSessionKey: sessionId => ({sessionId, generation: 2}),
    getActiveMspClient: () => client as never,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY',
  } as PidSessionCoordinator;
  return {
    client,
    controller: new PidTuningController({
      coordinator,
      appStateOwner: {getPhase: () => 'ACTIVE'},
      isMotorTestActive: () => false,
    }),
  };
}

function selectCalls(client: FakeClient) {
  return client.calls.filter(call => call.command === MSP_SELECT_SETTING);
}

describe('selecting a PID profile', () => {
  it('sends the bare index, and confirms it from the board', async () => {
    const h = harness();
    h.client.pidProfile = 2; // the board will report the new profile

    const result = await h.controller.selectProfile(key, 'PID', 2);

    expect(result.kind).toBe('SWITCHED');
    expect(selectCalls(h.client)).toHaveLength(1);
    expect(Array.from(selectCalls(h.client)[0].payload)).toEqual([2]);
  });

  it('refuses to call it switched when the board still reports the old profile', async () => {
    // The acknowledgement arrived; the profile did not change. This is
    // the case an ACK-only implementation would report as success.
    const h = harness();
    h.client.pidProfile = 0; // unchanged

    const result = await h.controller.selectProfile(key, 'PID', 2);

    expect(result.kind).toBe('NOT_APPLIED');
    if (result.kind === 'NOT_APPLIED') {
      // ...and the screen is handed the board's REAL state, not the request.
      expect(result.snapshot.pidProfileIndex).toBe(0);
    }
  });
});

describe('selecting a RATE profile', () => {
  it("sets the high bit, which is what distinguishes it from a PID profile", async () => {
    const h = harness();
    h.client.rateProfile = 1;

    const result = await h.controller.selectProfile(key, 'RATE', 1);

    expect(result.kind).toBe('SWITCHED');
    // The literal byte, hand-computed: 0x80 | 1. Re-deriving it with the
    // same OR the encoder uses would assert nothing.
    expect(Array.from(selectCalls(h.client)[0].payload)).toEqual([129]);
    expect(SELECT_SETTING_RATE_PROFILE_FLAG).toBe(0x80);
  });

  it('does not confuse the two selectors', async () => {
    // Rate profile 1 must not be reported as switched because PID
    // profile 1 happens to be active.
    const h = harness();
    h.client.pidProfile = 1;
    h.client.rateProfile = 0;

    const result = await h.controller.selectProfile(key, 'RATE', 1);

    expect(result.kind).toBe('NOT_APPLIED');
  });
});

describe('the select is held to the same safety rules as a save', () => {
  it('refuses an index that would collide with the rate-profile flag', async () => {
    const h = harness();
    const result = await h.controller.selectProfile(key, 'PID', 128);
    expect(result).toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(selectCalls(h.client)).toHaveLength(0);
  });

  it('refuses a negative or fractional index without touching the board', async () => {
    const h = harness();
    await expect(h.controller.selectProfile(key, 'PID', -1)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    await expect(h.controller.selectProfile(key, 'RATE', 1.5)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    expect(selectCalls(h.client)).toHaveLength(0);
  });

  it('will not switch profiles on an ARMED aircraft', async () => {
    const h = harness();
    // Flight-mode flags with the ARM box (permanent id 0) set.
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {
      payload: Uint8Array.from([
        0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 4, 0, 0, 0, 0, 0,
      ]),
    });

    const result = await h.controller.selectProfile(key, 'PID', 1);

    expect(result).toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(selectCalls(h.client)).toHaveLength(0);
  });

  it('reports an unknown outcome as unconfirmed, never as switched', async () => {
    const h = harness();
    h.client.enqueue(MSP_SELECT_SETTING, {reject: {code: 'MSP_TIMEOUT'}});

    const result = await h.controller.selectProfile(key, 'PID', 1);

    expect(result.kind).toBe('UNCONFIRMED');
  });

  it('treats a frame that never left as a plain failure, not an ambiguity', async () => {
    const h = harness();
    h.client.enqueue(MSP_SELECT_SETTING, {reject: {code: 'MSP_ENCODE_FAILED'}});

    const result = await h.controller.selectProfile(key, 'PID', 1);

    expect(result.kind).toBe('FAILED');
  });

  it('re-reads the profile-dependent data, so the screen shows the new profile', async () => {
    // Betaflight reloads everything after a select; a screen that kept
    // showing the previous profile's PIDs would be lying.
    const h = harness();
    h.client.pidProfile = 1;

    await h.controller.selectProfile(key, 'PID', 1);

    const commands = h.client.calls.map(call => call.command);
    const selectAt = commands.indexOf(MSP_SELECT_SETTING);
    expect(selectAt).toBeGreaterThanOrEqual(0);
    for (const group of [MSP_PID, MSP_RC_TUNING, MSP_PID_ADVANCED, MSP_FILTER_CONFIG]) {
      expect(commands.indexOf(group, selectAt)).toBeGreaterThan(selectAt);
    }
  });
});
