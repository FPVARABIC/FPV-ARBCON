import type { MspTelemetryScheduler } from '../../../core';
import { mspSessionCoordinator } from './MspSessionCoordinator';
import {
  GPS_DETAIL_HOME_POLL_ID,
  GPS_DETAIL_RAW_POLL_ID,
  GPS_DETAIL_SATELLITES_POLL_ID,
  acquireGpsDetailTelemetry,
} from './gpsDetailTelemetry';

function schedulerHarness() {
  const definitions: Array<{
    id: string;
    intervalMs: number;
    staleAfterMs: number;
    priority: number;
    initialDelayMs?: number;
  }> = [];
  const unregisters: jest.Mock[] = [];
  const scheduler = {
    registerPoll: jest.fn(definition => {
      definitions.push(definition);
      const unregister = jest.fn();
      unregisters.push(unregister);
      return unregister;
    }),
  } as unknown as MspTelemetryScheduler;
  return { scheduler, definitions, unregisters };
}

afterEach(() => jest.restoreAllMocks());

describe('acquireGpsDetailTelemetry', () => {
  it('registers the three detailed channels once and removes them on final release', () => {
    const h = schedulerHarness();
    jest
      .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
      .mockReturnValue(h.scheduler);
    jest
      .spyOn(mspSessionCoordinator, 'getSessionKey')
      .mockReturnValue({ sessionId: 'gps-1', generation: 7 });
    const key = { sessionId: 'gps-1', generation: 7 };
    const releaseFirst = acquireGpsDetailTelemetry(key);
    const releaseSecond = acquireGpsDetailTelemetry(key);

    expect(h.definitions.map(item => item.id)).toEqual([
      GPS_DETAIL_RAW_POLL_ID,
      GPS_DETAIL_HOME_POLL_ID,
      GPS_DETAIL_SATELLITES_POLL_ID,
    ]);
    expect(h.definitions).toMatchObject([
      {
        intervalMs: 750,
        staleAfterMs: 2500,
        priority: -1,
      },
      {
        intervalMs: 1000,
        staleAfterMs: 3500,
        priority: -2,
        initialDelayMs: 200,
      },
      {
        intervalMs: 2500,
        staleAfterMs: 7500,
        priority: -3,
        initialDelayMs: 450,
      },
    ]);
    releaseFirst();
    expect(
      h.unregisters.every(unregister => unregister.mock.calls.length === 0),
    ).toBe(true);
    releaseSecond();
    expect(
      h.unregisters.every(unregister => unregister.mock.calls.length === 1),
    ).toBe(true);
  });

  it('does not register against a stale physical-session generation', () => {
    const h = schedulerHarness();
    jest
      .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
      .mockReturnValue(h.scheduler);
    jest
      .spyOn(mspSessionCoordinator, 'getSessionKey')
      .mockReturnValue({ sessionId: 'gps-2', generation: 9 });
    acquireGpsDetailTelemetry({ sessionId: 'gps-2', generation: 8 });
    expect(h.definitions).toEqual([]);
  });
});
