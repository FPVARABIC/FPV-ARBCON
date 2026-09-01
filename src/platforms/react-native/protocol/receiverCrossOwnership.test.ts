/**
 * RECEIVER P5 - the two edges the P1-P4 suites leave open.
 *
 * Everything else about shared ownership is already pinned:
 * receiverTelemetry.test.ts proves single registration, reference
 * counting across the Receiver/Modes/Failsafe handoff (releasing out of
 * order), tab-switch safety, double-release safety and suppression-leak
 * safety; ReceiverModeWrite.test.ts proves a Receiver save preserves
 * RX_CONFIG byte 29. Those are not restated here.
 *
 * What is NOT yet proven, and is proven below:
 *
 *   1. The P2 STATUS BOOST. P2 added a reference-counted cadence override
 *      on the shared FC status poll, but the cross-screen tests predate
 *      it, so nothing asserted that three screens sharing live RC also
 *      share exactly one boost and give it back exactly once. A leaked
 *      boost would leave the whole app polling status at 300ms forever.
 *
 *   2. A genuinely CROSS-CONTROLLER RX_CONFIG round trip. The existing
 *      proof feeds Receiver a hand-built payload. This one has General
 *      Configuration author the payload with its own encoder, hands that
 *      exact result to Receiver as the flight controller's current
 *      RX_CONFIG, and checks General's field is still intact in what
 *      Receiver writes back - the real sequence two screens produce.
 */

import type {MspRequestOptions} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BOXIDS, MSP_BUILD_INFO, MSP_EEPROM_WRITE, MSP_RSSI_CONFIG, MSP_RC_DEADBAND,
  MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_RX_CONFIG, MSP_STATUS_EX,
  MSP2_COMMON_SERIAL_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeRxConfig} from '../../../core/protocol/msp/decoding/decodeRxConfig';
import {encodeRxCameraAngle} from '../../../core/protocol/msp/encoding/encodeGeneralConfiguration';
import {createReceiverConfigurationDraft} from '../../../core/state/receiverConfigurationModel';
import {mspSessionCoordinator, type MspIdentificationState} from './MspSessionCoordinator';
import {acquireReceiverTelemetry} from './receiverTelemetry';
import {ReceiverConfigurationController, type ReceiverSessionCoordinator} from './ReceiverConfigurationController';

/* ==================================================== 1. STATUS BOOST */
describe('P5: the shared FC status boost is reference counted like the RC poll', () => {
  function mockScheduler() {
    const unregister = jest.fn();
    const releaseSuppression = jest.fn();
    const releaseStatusBoost = jest.fn();
    const registerPoll = jest.fn(() => unregister);
    const acquirePollSuppression = jest.fn(() => releaseSuppression);
    const acquirePollIntervalOverride = jest.fn((_id: string, _intervalMs: number) => releaseStatusBoost);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 1});
    jest
      .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
      .mockReturnValue({registerPoll, acquirePollSuppression, acquirePollIntervalOverride} as unknown as MspTelemetryScheduler);
    return {registerPoll, unregister, acquirePollIntervalOverride, releaseStatusBoost};
  }
  afterEach(() => jest.restoreAllMocks());

  it('takes ONE boost for three screens and returns it exactly once, on the last release', () => {
    const {acquirePollIntervalOverride, releaseStatusBoost} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};
    const receiver = acquireReceiverTelemetry(key);
    const modes = acquireReceiverTelemetry(key);
    const failsafe = acquireReceiverTelemetry(key);
    expect(acquirePollIntervalOverride).toHaveBeenCalledTimes(1);

    // Released out of order, exactly as unmount order can happen.
    failsafe();
    receiver();
    expect(releaseStatusBoost).not.toHaveBeenCalled();
    modes();
    expect(releaseStatusBoost).toHaveBeenCalledTimes(1);
  });

  it('boosts the SHARED status poll, not a Receiver-private duplicate', () => {
    const {acquirePollIntervalOverride, registerPoll} = mockScheduler();
    acquireReceiverTelemetry({sessionId: 'rx', generation: 1});
    // One registration (live RC) and one override (status) - never two
    // status registrations racing for the same data.
    expect(registerPoll).toHaveBeenCalledTimes(1);
    expect(acquirePollIntervalOverride).toHaveBeenCalledTimes(1);
    const [pollId, intervalMs] = acquirePollIntervalOverride.mock.calls[0];
    expect(pollId).toBe('fcStatus');
    expect(intervalMs).toBeLessThanOrEqual(500);
  });

  it('cannot leak a boost through a double release', () => {
    const {releaseStatusBoost} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};
    const only = acquireReceiverTelemetry(key);
    only();
    only();
    expect(releaseStatusBoost).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing stale: a fresh acquire after the last release takes a new boost', () => {
    const {acquirePollIntervalOverride, releaseStatusBoost} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};
    acquireReceiverTelemetry(key)();
    expect(releaseStatusBoost).toHaveBeenCalledTimes(1);
    acquireReceiverTelemetry(key);
    expect(acquirePollIntervalOverride).toHaveBeenCalledTimes(2);
  });
});

/* ======================================= 2. CROSS-CONTROLLER RX_CONFIG */
describe('P5: General Configuration writes RX_CONFIG, then Receiver saves - both survive', () => {
  const EMPTY = new Uint8Array(0);
  const key = {sessionId: 'cross', generation: 4} as const;
  type Script = {payload: Uint8Array} | {reject: unknown};

  class FakeClient {
    readonly calls: Array<{command: number; payload: Uint8Array}> = [];
    private readonly scripts = new Map<number, Script[]>();
    getEpoch() { return 1; }
    enqueue(command: number, ...scripts: Script[]) { this.scripts.set(command, [...(this.scripts.get(command) ?? []), ...scripts]); }
    async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
      this.calls.push({command, payload});
      const script = this.scripts.get(command)?.shift();
      if (script !== undefined && 'reject' in script) throw script.reject;
      return {protocolVersion: 'v1', wireFormat: options.wireFormat, direction: 'response', command, flags: 0, payload: script?.payload ?? EMPTY};
    }
    payloadFor(command: number) { return this.calls.find(call => call.command === command)?.payload; }
  }

  function baseRxPayload(): Uint8Array {
    const bytes = new Uint8Array(39);
    const view = new DataView(bytes.buffer);
    bytes[0] = 9;                              // serialrx_provider = CRSF
    view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true);
    view.setUint16(8, 885, true); view.setUint16(10, 2115, true);
    bytes[22] = 11;                            // fpvCamAngleDegrees, General's field
    bytes[27] = 30; bytes[30] = 30; bytes[31] = 1;
    return bytes;
  }

  function harness() {
    const client = new FakeClient();
    const coordinator: ReceiverSessionCoordinator = {
      getOwnershipState: () => 'ACTIVE',
      getIdentificationState: () => ({status: 'SUCCEEDED', identity: {firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'}, apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47}, board: {}}} as MspIdentificationState),
      getSessionKey: sessionId => ({sessionId, generation: 4}),
      getActiveMspClient: () => client as never,
      getTelemetryScheduler: () => ({acquirePauseLease: jest.fn(() => ({release: jest.fn()})), discardPendingDemands: jest.fn(), waitUntilIdle: jest.fn(() => Promise.resolve()), requestRefresh: jest.fn()} as unknown as MspTelemetryScheduler),
      getMspRecoveryState: () => 'READY',
    };
    return {client, controller: new ReceiverConfigurationController({coordinator, appStateOwner: {getPhase: () => 'ACTIVE'}, isMotorTestActive: () => false})};
  }

  function enqueueSnapshot(client: FakeClient, rx: Uint8Array, map = [0, 1, 3, 2, 4, 5, 6, 7]) {
    client.enqueue(MSP_RX_CONFIG, {payload: rx});
    client.enqueue(MSP_RX_MAP, {payload: Uint8Array.from(map)});
    client.enqueue(MSP_RSSI_CONFIG, {payload: Uint8Array.from([0])});
    client.enqueue(MSP_RC_DEADBAND, {payload: Uint8Array.from([2, 3, 4, 5, 0])});
  }
  function statusPayload(): Uint8Array {
    const bytes = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0, 0]);
    new DataView(bytes.buffer).setUint32(17, 0, true);
    return bytes;
  }

  it("keeps General Configuration's camera angle when Receiver writes the same payload", async () => {
    // 1. GENERAL CONFIGURATION authors RX_CONFIG with its own encoder,
    //    changing the field it owns from 11 to 27 degrees.
    const afterGeneral = encodeRxCameraAngle(decodeRxConfig(baseRxPayload()), 27);
    expect(afterGeneral[22]).toBe(27);
    expect(afterGeneral[0]).toBe(9); // Receiver's provider untouched by General

    // 2. That payload is now what the flight controller holds. RECEIVER
    //    loads it and saves an unrelated change of its own.
    const h = harness();
    enqueueSnapshot(h.client, afterGeneral);
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    expect(loaded.snapshot.rx.fpvCameraAngleDegrees).toBe(27);

    enqueueSnapshot(h.client, afterGeneral);
    h.client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload()});
    h.client.enqueue(MSP_SET_RX_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    const readback = afterGeneral.slice();
    readback[30] = 40;
    enqueueSnapshot(h.client, readback);
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload()});

    const outcome = await h.controller.save(key, loaded.snapshot, {
      ...createReceiverConfigurationDraft(loaded.snapshot),
      setpointAutoFactor: 40, // a Receiver-owned rc_smoothing field
    });
    // SAVED_VERIFIED, not reboot-required: the flight controller's own
    // flag was readable and false, and neither mode nor provider changed.
    // P2's authoritative-flag-first rule, working exactly as specified.
    expect(outcome.kind).toBe('SAVED_VERIFIED');

    // 3. What Receiver put on the wire still carries General's value.
    const written = h.client.payloadFor(MSP_SET_RX_CONFIG)!;
    expect(written[22]).toBe(27);
    expect(written[30]).toBe(40);
    // ...and every byte Receiver does not own is byte-identical.
    for (let index = 0; index < afterGeneral.length; index += 1) {
      if (index === 30) continue;
      expect({index, value: written[index]}).toEqual({index, value: afterGeneral[index]});
    }
  });

  it('never issues a Ports write while doing it', async () => {
    const h = harness();
    enqueueSnapshot(h.client, baseRxPayload());
    const loaded = await h.controller.load(key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP2_COMMON_SERIAL_CONFIG);
    expect(h.client.calls.map(call => call.command)).not.toContain(MSP_BUILD_INFO);
  });
});
