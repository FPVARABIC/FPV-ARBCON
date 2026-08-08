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
    jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll, acquirePollSuppression} as unknown as MspTelemetryScheduler);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 1});
    const key = {sessionId: 'rx', generation: 1}; const first = acquireReceiverTelemetry(key); const second = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledWith(expect.objectContaining({id: RECEIVER_CHANNELS_POLL_ID, command: MSP_RC, intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS}));
    expect(acquirePollSuppression).toHaveBeenCalledWith('attitude');
    first(); expect(unregister).not.toHaveBeenCalled(); expect(releaseSuppression).not.toHaveBeenCalled(); second(); expect(unregister).toHaveBeenCalledTimes(1); expect(releaseSuppression).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale generation', () => {
    const registerPoll = jest.fn(); const acquirePollSuppression = jest.fn(); jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll, acquirePollSuppression} as unknown as MspTelemetryScheduler); jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 2});
    acquireReceiverTelemetry({sessionId: 'rx', generation: 1}); expect(registerPoll).not.toHaveBeenCalled();
    expect(acquirePollSuppression).not.toHaveBeenCalled();
  });

  it('gives each 50ms scheduler slot to live RC while hidden attitude is suppressed', async () => {
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
