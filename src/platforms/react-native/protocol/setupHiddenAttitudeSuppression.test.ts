/**
 * SETUP P3 - proof that the hidden 20Hz attitude poll actually stops, and
 * that stopping it cannot damage anything else.
 *
 * The fake scheduler below implements the REAL reference-counting
 * semantics of acquirePollSuppression (a per-id count, dispatchable only
 * at zero) rather than a bare jest.fn(). That is deliberate: the
 * interesting failures in this file are all about COMPOSITION - Setup's
 * lease living alongside the leases Receiver and Sensors already take on
 * this same poll id - and a mock that only counts calls cannot tell a
 * correctly-composed pair of leases from a double release.
 */

import type {MspTelemetryScheduler} from '../../../core';
import {
  ATTITUDE_TELEMETRY_POLL_ID,
  mspSessionCoordinator,
} from './MspSessionCoordinator';
import {
  acquireSetupHiddenAttitudeSuppression,
  isSetupAttitudeSuppressedBySetup,
} from './setupHiddenAttitudeSuppression';

class FakeScheduler {
  readonly counts = new Map<string, number>();
  /** Every id ever suppressed, so a test can prove NOTHING ELSE moved. */
  readonly touched: string[] = [];

  acquirePollSuppression(id: string): () => void {
    this.touched.push(id);
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.counts.set(id, (this.counts.get(id) ?? 0) - 1);
    };
  }

  isSuppressed(id: string): boolean {
    return (this.counts.get(id) ?? 0) > 0;
  }

  asScheduler(): MspTelemetryScheduler {
    return this as unknown as MspTelemetryScheduler;
  }
}

/**
 * A FRESH session id per test. The holder map is module state keyed by
 * session id - exactly as it is in production, where several sessions can
 * legitimately coexist - so giving each test its own id isolates them
 * without a test-only reset hatch in the production module.
 */
let sessionSeq = 0;
let SESSION = 'setup-p3-0';
beforeEach(() => {
  sessionSeq += 1;
  SESSION = `setup-p3-${sessionSeq}`;
});

/** Mirrors the coordinator's real shape closely enough to drive the
 * holder: a session key, a scheduler that can appear later, and the
 * telemetry-availability notification that announces it. */
function mockCoordinator(initial: {
  generation: number;
  scheduler?: FakeScheduler;
}): {
  setScheduler: (next: FakeScheduler | undefined) => void;
  setGeneration: (next: number) => void;
  /** Fires the availability notification, like startTelemetry() does. */
  notify: () => void;
  listenerCount: () => number;
} {
  let scheduler = initial.scheduler;
  let generation = initial.generation;
  const listeners = new Set<() => void>();

  jest
    .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
    .mockImplementation(() => scheduler?.asScheduler());
  jest
    .spyOn(mspSessionCoordinator, 'getSessionKey')
    .mockImplementation(() => ({sessionId: SESSION, generation}));
  jest
    .spyOn(mspSessionCoordinator, 'subscribeTelemetryAvailability')
    .mockImplementation(listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  return {
    setScheduler: next => {
      scheduler = next;
    },
    setGeneration: next => {
      generation = next;
    },
    notify: () => {
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('acquireSetupHiddenAttitudeSuppression', () => {
  it('suppresses the attitude poll while Setup is hidden', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
  });

  it('suppresses THAT poll and no other', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    const release = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });
    release();

    expect(scheduler.touched).toEqual([ATTITUDE_TELEMETRY_POLL_ID]);
  });

  it('makes the poll dispatchable again when Setup becomes visible', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    const release = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });
    release();

    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(false);
  });

  it('reference-counts: the poll stays suppressed until the LAST holder releases', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});
    const key = {sessionId: SESSION, generation: 1};

    const first = acquireSetupHiddenAttitudeSuppression(key);
    const second = acquireSetupHiddenAttitudeSuppression(key);

    first();
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
    second();
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(false);
  });

  it('takes exactly ONE scheduler lease for two hidden holders', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});
    const key = {sessionId: SESSION, generation: 1};

    acquireSetupHiddenAttitudeSuppression(key);
    acquireSetupHiddenAttitudeSuppression(key);

    expect(scheduler.touched).toEqual([ATTITUDE_TELEMETRY_POLL_ID]);
    expect(scheduler.counts.get(ATTITUDE_TELEMETRY_POLL_ID)).toBe(1);
  });

  it('is idempotent: a cleanup that runs twice does not over-release', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});
    const key = {sessionId: SESSION, generation: 1};

    const first = acquireSetupHiddenAttitudeSuppression(key);
    const second = acquireSetupHiddenAttitudeSuppression(key);
    first();
    first();

    // If the double call had decremented twice, the surviving holder's
    // lease would already be gone.
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
    second();
    expect(scheduler.counts.get(ATTITUDE_TELEMETRY_POLL_ID)).toBe(0);
  });

  it('refuses a stale generation rather than suppressing a stranger session', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 2, scheduler});

    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    expect(scheduler.touched).toEqual([]);
    expect(isSetupAttitudeSuppressedBySetup(SESSION)).toBe(false);
  });

  it('does not throw when no scheduler exists yet', () => {
    mockCoordinator({generation: 1, scheduler: undefined});

    const release = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    expect(isSetupAttitudeSuppressedBySetup(SESSION)).toBe(false);
    expect(() => release()).not.toThrow();
  });

  it('picks the lease up when the scheduler appears later', () => {
    // The real sequence: a session opens, Setup is hidden before
    // startReading() resolves, and only then does startTelemetry() build
    // the scheduler and announce it.
    const coordinator = mockCoordinator({generation: 1, scheduler: undefined});
    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    const scheduler = new FakeScheduler();
    coordinator.setScheduler(scheduler);
    coordinator.notify();

    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
  });

  it('ignores a late scheduler that belongs to a newer generation', () => {
    const coordinator = mockCoordinator({generation: 1, scheduler: undefined});
    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    const scheduler = new FakeScheduler();
    coordinator.setScheduler(scheduler);
    coordinator.setGeneration(2);
    coordinator.notify();

    expect(scheduler.touched).toEqual([]);
  });

  it('moves the lease when the session gets a replacement scheduler', () => {
    const first = new FakeScheduler();
    const coordinator = mockCoordinator({generation: 1, scheduler: first});
    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    const second = new FakeScheduler();
    coordinator.setScheduler(second);
    coordinator.notify();

    expect(first.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(false);
    expect(second.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
  });

  it('hands the lease to a newer generation and releases the old one', () => {
    const scheduler = new FakeScheduler();
    const coordinator = mockCoordinator({generation: 1, scheduler});
    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    coordinator.setGeneration(2);
    acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 2,
    });

    // One lease, not two stacked: the generation-1 holder was disposed.
    expect(scheduler.counts.get(ATTITUDE_TELEMETRY_POLL_ID)).toBe(1);
  });

  it('a release from the OLD generation cannot cancel the new one', () => {
    const scheduler = new FakeScheduler();
    const coordinator = mockCoordinator({generation: 1, scheduler});
    const stale = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    coordinator.setGeneration(2);
    acquireSetupHiddenAttitudeSuppression({sessionId: SESSION, generation: 2});
    stale();

    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
  });

  it('detaches its availability listener once the last holder releases', () => {
    const scheduler = new FakeScheduler();
    const coordinator = mockCoordinator({generation: 1, scheduler});
    const key = {sessionId: SESSION, generation: 1};

    const first = acquireSetupHiddenAttitudeSuppression(key);
    const second = acquireSetupHiddenAttitudeSuppression(key);
    expect(coordinator.listenerCount()).toBe(1);

    first();
    expect(coordinator.listenerCount()).toBe(1);
    second();
    expect(coordinator.listenerCount()).toBe(0);
  });

  it('never attaches a second listener for a repeated acquire', () => {
    const scheduler = new FakeScheduler();
    const coordinator = mockCoordinator({generation: 1, scheduler});
    const key = {sessionId: SESSION, generation: 1};

    acquireSetupHiddenAttitudeSuppression(key);
    acquireSetupHiddenAttitudeSuppression(key);
    acquireSetupHiddenAttitudeSuppression(key);

    expect(coordinator.listenerCount()).toBe(1);
  });
});

describe('composition with the other two owners of this poll id', () => {
  /** Receiver and Sensors take the SAME lease on the SAME id today. */
  it('stays suppressed while Receiver still holds its own lease', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    const receiverLease = scheduler.acquirePollSuppression(
      ATTITUDE_TELEMETRY_POLL_ID,
    );
    const setupLease = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });

    setupLease();
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
    receiverLease();
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(false);
  });

  it('stays suppressed while Setup is hidden after Sensors releases', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    const sensorsLease = scheduler.acquirePollSuppression(
      ATTITUDE_TELEMETRY_POLL_ID,
    );
    acquireSetupHiddenAttitudeSuppression({sessionId: SESSION, generation: 1});

    sensorsLease();
    expect(scheduler.isSuppressed(ATTITUDE_TELEMETRY_POLL_ID)).toBe(true);
  });

  it('releasing Setup does not disturb an unrelated poll id', () => {
    const scheduler = new FakeScheduler();
    mockCoordinator({generation: 1, scheduler});

    const otherLease = scheduler.acquirePollSuppression('some-other-poll');
    const release = acquireSetupHiddenAttitudeSuppression({
      sessionId: SESSION,
      generation: 1,
    });
    release();

    expect(scheduler.isSuppressed('some-other-poll')).toBe(true);
    otherLease();
  });
});
