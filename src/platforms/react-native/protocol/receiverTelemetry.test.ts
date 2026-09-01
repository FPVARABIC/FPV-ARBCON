import {
  MSP_ATTITUDE,
  MSP_RC,
  createMspTelemetryScheduler,
  type MspFrame,
  type MspTelemetryScheduler,
} from '../../../core';
import {FakeClock} from '../../../core/protocol/telemetry/clock';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {
  RECEIVER_CHANNELS_POLL_ID,
  RECEIVER_CHANNELS_POLL_INTERVAL_MS,
  acquireReceiverTelemetry,
} from './receiverTelemetry';

afterEach(() => jest.restoreAllMocks());
describe('acquireReceiverTelemetry', () => {
  it('registers one real MSP_RC poll and releases it by reference count', () => {
    const unregister = jest.fn(); const registerPoll = jest.fn(() => unregister); const releaseSuppression = jest.fn(); const acquirePollSuppression = jest.fn(() => releaseSuppression);
    const acquirePollIntervalOverride = jest.fn(() => jest.fn());
    jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll, acquirePollSuppression, acquirePollIntervalOverride} as unknown as MspTelemetryScheduler);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 1});
    const key = {sessionId: 'rx', generation: 1}; const first = acquireReceiverTelemetry(key); const second = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledWith(expect.objectContaining({id: RECEIVER_CHANNELS_POLL_ID, command: MSP_RC, intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS}));
    expect(acquirePollSuppression).toHaveBeenCalledWith('attitude');
    first(); expect(unregister).not.toHaveBeenCalled(); expect(releaseSuppression).not.toHaveBeenCalled(); second(); expect(unregister).toHaveBeenCalledTimes(1); expect(releaseSuppression).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale generation', () => {
    const registerPoll = jest.fn(); const acquirePollSuppression = jest.fn(); const acquirePollIntervalOverride = jest.fn(() => jest.fn()); jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll, acquirePollSuppression, acquirePollIntervalOverride} as unknown as MspTelemetryScheduler); jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 2});
    acquireReceiverTelemetry({sessionId: 'rx', generation: 1}); expect(registerPoll).not.toHaveBeenCalled();
    expect(acquirePollSuppression).not.toHaveBeenCalled();
  });

  it('gives each scheduler slot to live RC while hidden attitude is suppressed', async () => {
    const clock = new FakeClock(0);
    const calls: number[] = [];
    const scheduler = createMspTelemetryScheduler({
      request: async (command): Promise<MspFrame> => {
        calls.push(command);
        return {
          protocolVersion: 'v1',
          wireFormat: 'v1',
          direction: 'response',
          command,
          flags: 0,
          payload: command === MSP_RC
            ? Uint8Array.from([220, 5, 232, 3])
            : Uint8Array.from([0, 0, 0, 0, 0, 0]),
        };
      },
    }, {clock, singleFlight: true});
    scheduler.registerPoll({
      id: 'attitude',
      command: MSP_ATTITUDE,
      intervalMs: 50,
      staleAfterMs: 500,
      priority: 0,
      decode: () => 0,
    });
    jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue(scheduler);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx-live', generation: 1});

    const release = acquireReceiverTelemetry({sessionId: 'rx-live', generation: 1});
    for (let index = 0; index < 4; index += 1) {
      scheduler.tick();
      await scheduler.waitUntilIdle();
      clock.advance(50);
    }
    expect(calls).toEqual([MSP_RC, MSP_RC, MSP_RC, MSP_RC]);
    expect(scheduler.getValue(RECEIVER_CHANNELS_POLL_ID)).toMatchObject({status: 'FRESH'});

    release();
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(calls.at(-1)).toBe(MSP_ATTITUDE);
  });
});

/**
 * Receiver P1. The pre-P1 suite asserted the registration's interval as
 * `intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS` - the constant
 * compared against itself, which would have held at any value. These pin
 * the registration contract to real numbers and cover the cross-screen
 * reference counting that P0 found load-bearing and untested.
 */
describe('Receiver P1 - live RC registration contract', () => {
  const mockScheduler = () => {
    const unregister = jest.fn();
    const registerPoll = jest.fn((_definition: {
      intervalMs: number; staleAfterMs: number; priority: number; command: number;
    }) => unregister);
    const releaseSuppression = jest.fn();
    const acquirePollSuppression = jest.fn(() => releaseSuppression);
    const releaseStatusBoost = jest.fn();
    const acquirePollIntervalOverride = jest.fn((_id: string, _intervalMs: number) => releaseStatusBoost);
    jest
      .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
      .mockReturnValue({registerPoll, acquirePollSuppression, acquirePollIntervalOverride} as unknown as MspTelemetryScheduler);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 1});
    return {registerPoll, unregister, acquirePollSuppression, releaseSuppression, acquirePollIntervalOverride, releaseStatusBoost};
  };

  it('P1-B: requests the decoupled 33ms interval, not the old 50ms grid value', () => {
    const {registerPoll} = mockScheduler();
    acquireReceiverTelemetry({sessionId: 'rx', generation: 1})();
    const definition = registerPoll.mock.calls[0][0];
    expect(RECEIVER_CHANNELS_POLL_INTERVAL_MS).toBe(33);
    expect(definition.intervalMs).toBe(33);
    expect(definition.command).toBe(MSP_RC);
    // P1-H: audited and deliberately unchanged at the new cadence.
    expect(definition.staleAfterMs).toBe(700);
    // Primary priority: live RC is the responsive channel.
    expect(definition.priority).toBe(2);
  });

  it('P1-P item 16: reference counting survives the ReceiverScreen / ModesScreen / FailsafeScreen handoff', () => {
    const {registerPoll, unregister, releaseSuppression} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};

    // All three screens can be mounted and holding a reference at once -
    // MainTabsScreen keeps visited panels mounted.
    const receiverScreen = acquireReceiverTelemetry(key);
    const modesScreen = acquireReceiverTelemetry(key);
    const failsafeScreen = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledTimes(1); // P1 item 26: never duplicated

    receiverScreen();
    failsafeScreen();
    expect(unregister).not.toHaveBeenCalled();
    expect(releaseSuppression).not.toHaveBeenCalled();

    modesScreen();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(releaseSuppression).toHaveBeenCalledTimes(1);
  });

  it('P1-F: a tab switch never leaves two live registrations or a leaked suppression owner', () => {
    const {registerPoll, unregister, acquirePollSuppression, releaseSuppression} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};

    // React runs the departing screen's effect cleanup before the
    // arriving screen's effect, so a Receiver -> Modes switch is
    // release-then-acquire. At no point may two registrations be live.
    const receiverScreen = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledTimes(1);
    receiverScreen();
    expect(unregister).toHaveBeenCalledTimes(1);
    const modesScreen = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(1); // still exactly one live

    // Suppression ownership tracks it one-for-one - no leak either way.
    expect(acquirePollSuppression).toHaveBeenCalledTimes(2);
    expect(releaseSuppression).toHaveBeenCalledTimes(1);
    modesScreen();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(releaseSuppression).toHaveBeenCalledTimes(2);
  });

  it('P1-P item 26: releasing twice cannot unregister a later screen\'s registration', () => {
    const {registerPoll, unregister} = mockScheduler();
    const key = {sessionId: 'rx', generation: 1};
    const first = acquireReceiverTelemetry(key);
    first();
    first(); // double release - a stale cleanup firing late
    expect(unregister).toHaveBeenCalledTimes(1);

    acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledTimes(2);
    // The second registration must still be live.
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
