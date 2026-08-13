/**
 * SETUP P3 - stop paying for the orientation model nobody is looking at.
 *
 * THE MEASURED DEFECT. `MSP_ATTITUDE` is registered once, at scheduler
 * creation (MspSessionCoordinator.startTelemetry), at a 50ms period - 20
 * requests a second, forever, for the whole life of the session. P0
 * confirmed by grep that the ONLY consumers of that poll id are inside
 * SetupScreen: `useSetupAttitude` (the hero and the stability panel) and
 * `readSetupFreshAttitude` (the reset-reference capture). MainTabsScreen
 * keeps every opened tab mounted behind `display: 'none'` rather than
 * unmounting it, so a user who opens Setup once and then spends the
 * session on PID, OSD or CLI keeps 20 requests a second flowing on a
 * SERIALISED, single-flight MSP link to render pixels that are not on
 * screen. Every one of those dispatches occupies the single in-flight
 * slot that the visible tab's own telemetry is waiting for.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `setupPresentation.ts`. That
 * facade is Setup's READ-ONLY window onto the protocol layer: hooks that
 * observe, and reads that snapshot. Acquiring a lease is a lifecycle
 * ACTION with a side effect on the scheduler, and putting it behind the
 * read-only facade would make "Setup only reads" untrue - so the action
 * lives here, beside the two lease owners that already exist
 * (receiverTelemetry, sensorsTelemetry) rather than beside the readers.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *  - not a cadence change. `ATTITUDE_POLL_INTERVAL_MS` is untouched; when
 *    Setup is visible the poll runs at exactly the rate it always did;
 *  - not an unregister/re-register. The poll definition stays registered
 *    for the whole session, so its CACHED value survives being hidden and
 *    `getValue()` never flips to UNAVAILABLE - it simply ages into STALE
 *    on its own `updatedAtMs`, which is the honest report. Returning to
 *    Setup shows the last real sample marked stale until a fresh one
 *    lands one poll period later, and never re-presents an old sample as
 *    newly FRESH;
 *  - not a new timer, and not a scheduler-internals change. It uses the
 *    scheduler's OWN reference-counted `acquirePollSuppression`, the same
 *    API Receiver and Sensors already hold against this same poll id.
 *
 * HOW IT COMPOSES WITH THE OTHER TWO OWNERS. Suppression is a plain
 * per-poll-id reference count on the scheduler, so the three owners need
 * to know nothing about each other: the poll is dispatchable only when
 * NOBODY holds a lease. Setup-hidden + Receiver-visible is two leases and
 * one suppressed poll; releasing either one alone still leaves it
 * suppressed. The lease taken here is released the moment Setup becomes
 * visible, which is also the only moment its value is wanted.
 *
 * WHY IT LISTENS FOR THE SCHEDULER. A session's scheduler is created
 * asynchronously, in the `startReading()`-resolved continuation, not
 * synchronously at `openSession()`. A Setup tab that is already hidden
 * when that happens would otherwise miss its own window: there was no
 * scheduler to take a lease against at hide time, and nothing would ever
 * re-ask. `subscribeTelemetryAvailability()` exists for exactly this
 * ("fires whenever getTelemetryScheduler() may now report something
 * different"), so the holder re-syncs on it and picks the lease up the
 * instant the scheduler appears.
 */

import type {MspTelemetryScheduler} from '../../../core';
import {
  ATTITUDE_TELEMETRY_POLL_ID,
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

const NOOP = (): void => {};

interface Holder {
  /** Pins the lease to ONE session generation. A replacement generation
   * reusing the same sessionId is a different session with a different
   * scheduler, and must never inherit this one's lease. */
  readonly generation: number;
  references: number;
  /** The scheduler instance the current lease was taken against - not
   * just "some scheduler for this id". A lease held on a dead scheduler
   * is meaningless, so the identity is what `sync` compares. */
  scheduler: MspTelemetryScheduler | undefined;
  releaseSuppression: (() => void) | undefined;
  unsubscribe: () => void;
}

const holders = new Map<string, Holder>();

/**
 * Brings the held lease into line with the session's CURRENT scheduler.
 * Idempotent, and safe to call when nothing has changed - the identity
 * check makes a no-op cost nothing.
 */
function sync(sessionId: string, holder: Holder): void {
  const currentKey = mspSessionCoordinator.getSessionKey(sessionId);
  // A generation mismatch means this holder outlived its session; it gets
  // no lease at all rather than one on a stranger's scheduler.
  const scheduler =
    currentKey?.generation === holder.generation
      ? mspSessionCoordinator.getTelemetryScheduler(sessionId)
      : undefined;
  if (scheduler === holder.scheduler) {
    return;
  }
  holder.releaseSuppression?.();
  holder.scheduler = scheduler;
  holder.releaseSuppression = scheduler?.acquirePollSuppression(
    ATTITUDE_TELEMETRY_POLL_ID,
  );
}

function dispose(sessionId: string, holder: Holder): void {
  holder.unsubscribe();
  holder.unsubscribe = NOOP;
  holder.releaseSuppression?.();
  holder.releaseSuppression = undefined;
  holder.scheduler = undefined;
  if (holders.get(sessionId) === holder) {
    holders.delete(sessionId);
  }
}

function releaseFor(sessionId: string, holder: Holder): () => void {
  let released = false;
  return () => {
    if (released) {
      return; // an effect cleanup that runs twice must not double-decrement
    }
    released = true;
    const current = holders.get(sessionId);
    if (current !== holder) {
      return; // already disposed, or replaced by a newer generation
    }
    current.references -= 1;
    if (current.references > 0) {
      return;
    }
    dispose(sessionId, current);
  };
}

/**
 * Suppresses the Setup-only attitude poll for as long as the returned
 * release function has not been called. Call this while Setup is HIDDEN;
 * release it when Setup becomes visible.
 *
 * Reference-counted per session, so two hidden Setup surfaces in one host
 * hold one lease between them and the poll resumes only when the last one
 * releases. The returned function is idempotent.
 */
export function acquireSetupHiddenAttitudeSuppression(
  key: SetupUiSessionKey,
): () => void {
  const currentKey = mspSessionCoordinator.getSessionKey(key.sessionId);
  if (currentKey?.generation !== key.generation) {
    // Stale key: the session this caller believes it is on has already
    // been replaced. Suppressing the CURRENT session's poll on its behalf
    // would starve a screen that never asked for it.
    return NOOP;
  }
  const existing = holders.get(key.sessionId);
  if (existing?.generation === key.generation) {
    existing.references += 1;
    // Re-sync rather than assume: teardown does NOT fire the availability
    // notification (it rides the ownership one instead), so a holder that
    // has been sitting through one is the one case where the cached
    // scheduler identity can be out of date without anyone telling us.
    sync(key.sessionId, existing);
    return releaseFor(key.sessionId, existing);
  }
  if (existing !== undefined) {
    dispose(key.sessionId, existing);
  }
  const holder: Holder = {
    generation: key.generation,
    references: 1,
    scheduler: undefined,
    releaseSuppression: undefined,
    unsubscribe: NOOP,
  };
  holders.set(key.sessionId, holder);
  holder.unsubscribe = mspSessionCoordinator.subscribeTelemetryAvailability(
    () => {
      if (holders.get(key.sessionId) !== holder) {
        return;
      }
      sync(key.sessionId, holder);
    },
  );
  sync(key.sessionId, holder);
  return releaseFor(key.sessionId, holder);
}

/** Test-only introspection: does THIS module currently hold a lease for
 * the session? Never used by production code - the scheduler's own
 * reference count is the authority, and this only reports whether we are
 * one of the holders. */
export function isSetupAttitudeSuppressedBySetup(sessionId: string): boolean {
  return holders.get(sessionId)?.releaseSuppression !== undefined;
}
