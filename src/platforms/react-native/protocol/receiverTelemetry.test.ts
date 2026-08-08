import {MSP_RC, type MspTelemetryScheduler} from '../../../core';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {RECEIVER_CHANNELS_POLL_ID, acquireReceiverTelemetry} from './receiverTelemetry';

afterEach(() => jest.restoreAllMocks());
describe('acquireReceiverTelemetry', () => {
  it('registers one real MSP_RC poll and releases it by reference count', () => {
    const unregister = jest.fn(); const registerPoll = jest.fn(() => unregister);
    jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll} as unknown as MspTelemetryScheduler);
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 1});
    const key = {sessionId: 'rx', generation: 1}; const first = acquireReceiverTelemetry(key); const second = acquireReceiverTelemetry(key);
    expect(registerPoll).toHaveBeenCalledWith(expect.objectContaining({id: RECEIVER_CHANNELS_POLL_ID, command: MSP_RC, intervalMs: 100}));
    first(); expect(unregister).not.toHaveBeenCalled(); second(); expect(unregister).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale generation', () => {
    const registerPoll = jest.fn(); jest.spyOn(mspSessionCoordinator, 'getTelemetryScheduler').mockReturnValue({registerPoll} as unknown as MspTelemetryScheduler); jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockReturnValue({sessionId: 'rx', generation: 2});
    acquireReceiverTelemetry({sessionId: 'rx', generation: 1}); expect(registerPoll).not.toHaveBeenCalled();
  });
});
