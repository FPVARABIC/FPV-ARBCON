/**
 * Pass 7.4: React binding for MspSessionCoordinator.getTelemetryScheduler()
 * (Pass 7.4's own real MspTelemetryScheduler integration) - a
 * useSyncExternalStore wrapper mirroring useMspSessionState.ts's own
 * useMspOwnershipState()/useMspIdentificationState() pattern exactly.
 *
 * The subtlety useMspOwnershipState() doesn't have to deal with: a
 * telemetry scheduler does not exist for a sessionId until
 * startTelemetry() runs (the startReading()-confirmed point, slightly
 * AFTER the synchronous ownership->ACTIVE flip - see
 * MspSessionCoordinator.ts's own doc comment), and stops existing again
 * on teardown. A naive one-shot `scheduler?.subscribe(listener)` captured
 * once at mount time would go stale the moment a scheduler is created or
 * destroyed after that - subscribeTelemetry() below instead ALSO
 * subscribes to BOTH ownership-state changes (which correctly cover
 * teardown - see MspSessionCoordinator.ts's own
 * subscribeTelemetryAvailability() doc comment for why teardown doesn't
 * need a second signal) AND the dedicated subscribeTelemetryAvailability()
 * axis (which covers creation, since that does not correspond to any
 * actual ownership status change) - re-attaching to whatever scheduler
 * currently exists for this sessionId on either. Same broad-notify,
 * narrow-in-getSnapshot convention useMspOwnershipState() itself already
 * uses.
 */

import {useCallback, useSyncExternalStore} from 'react';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {TelemetryValue} from '../../../core';

/** Same stable-singleton lesson MspTelemetryScheduler.ts's own
 * UNAVAILABLE_VALUE already applies (Pass 7.1's IDLE_IDENTIFICATION_STATE
 * fix, applied proactively here rather than rediscovered): a fresh
 * `{status: 'UNAVAILABLE'}` literal every call would break
 * useSyncExternalStore's referential-stability contract for any
 * sessionId with no scheduler yet. */
const NO_SCHEDULER_VALUE: TelemetryValue<never> = {status: 'UNAVAILABLE'};

function subscribeTelemetry(sessionId: string, listener: () => void): () => void {
  let unsubscribeScheduler: (() => void) | undefined;

  const attachToCurrentScheduler = () => {
    unsubscribeScheduler?.();
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);
    unsubscribeScheduler = scheduler?.subscribe(listener);
  };

  attachToCurrentScheduler();
  const reattach = () => {
    attachToCurrentScheduler();
    listener();
  };
  const unsubscribeOwnership = mspSessionCoordinator.subscribeOwnershipState(reattach);
  const unsubscribeTelemetryAvailability = mspSessionCoordinator.subscribeTelemetryAvailability(reattach);

  return () => {
    unsubscribeScheduler?.();
    unsubscribeOwnership();
    unsubscribeTelemetryAvailability();
  };
}

export function useTelemetryValue<T>(
  sessionId: string,
  pollId: string,
  enabled = true,
): TelemetryValue<T> {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeTelemetry(sessionId, listener) : () => undefined,
    [enabled, sessionId],
  );
  const getSnapshot = useCallback((): TelemetryValue<T> => {
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);
    // UNAVAILABLE_VALUE-equivalent: no scheduler for this session at all
    // right now. Matches MspTelemetryScheduler.getValue()'s own
    // UNAVAILABLE variant exactly (an unregistered poll id looks
    // identical to a not-yet-existing scheduler from a consumer's
    // perspective - both mean "nothing to show yet").
    return scheduler ? scheduler.getValue<T>(pollId) : NO_SCHEDULER_VALUE;
  }, [sessionId, pollId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
