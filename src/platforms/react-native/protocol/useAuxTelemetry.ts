/**
 * Pass 7.6c: React bindings for the auxiliary Region 3 telemetry lifecycle
 * surface on MspSessionCoordinator - useSyncExternalStore wrappers
 * following useMspSessionState.ts's established pattern exactly.
 *
 * Unlike useTelemetryValue() this does NOT need the scheduler-reattach
 * dance: the snapshot reads coordinator-owned state (the per-session aux
 * channel-state map), and every mutation of that state - registration,
 * circuit break, teardown - runs notifyAuxTelemetry(), so a single
 * subscribeAuxTelemetry() subscription covers the full lifecycle.
 *
 * Snapshot stability (the IDLE_IDENTIFICATION_STATE lesson): channel
 * state is a string literal (referentially trivial), so
 * useSyncExternalStore's stable-snapshot contract holds without extra
 * caching here.
 */

import {useCallback, useSyncExternalStore} from 'react';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {AuxTelemetryChannelState} from './MspSessionCoordinator';

function subscribeAux(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeAuxTelemetry(listener);
}

/** Lifecycle verdict for one auxiliary poll id in one UI session.
 * 'ACTIVE' also covers "never registered" (non-Betaflight sessions) -
 * the poll's TelemetryValue reads UNAVAILABLE there, which is the
 * signal the cards actually render from. */
export function useAuxTelemetryChannelState(sessionId: string, pollId: string): AuxTelemetryChannelState {
  const getSnapshot = useCallback(
    () => mspSessionCoordinator.getAuxTelemetryChannelState(sessionId, pollId),
    [sessionId, pollId],
  );
  return useSyncExternalStore(subscribeAux, getSnapshot);
}
