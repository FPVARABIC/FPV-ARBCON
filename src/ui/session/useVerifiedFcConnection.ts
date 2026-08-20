/**
 * The application-shape question, bound to the live coordinator.
 *
 * Read through useSyncExternalStore so the answer changes the instant
 * the hardware does: a board going away removes the configuration
 * workspace from the navigator in the same commit, rather than at the
 * next navigation.
 *
 * REFERENTIAL STABILITY IS LOAD-BEARING HERE. useSyncExternalStore
 * re-renders until getSnapshot returns a stable value, so the snapshot
 * is a STRING - a compact encoding of every fact the resolver needs -
 * and the objects are rebuilt from the coordinator only when that string
 * changes. Subscribing to freshly-minted objects instead is an infinite
 * render loop, which is exactly how the previous attempt failed.
 */

import {useMemo, useSyncExternalStore} from 'react';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {
  resolveVerifiedConnection,
  type CandidateSession,
  type VerifiedConnection,
} from './verifiedConnection';

/** Every feed that can change the answer, in one subscription. */
function subscribeEverything(listener: () => void): () => void {
  const unsubscribes = [
    mspSessionCoordinator.subscribeOwnershipState(listener),
    mspSessionCoordinator.subscribeIdentificationState(listener),
    fcRebootRecovery.subscribe(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

function rebootInFlight(): boolean {
  const phase = fcRebootRecovery.getPhase().kind;
  return (
    phase === 'EXPECTED' ||
    phase === 'WAITING_FOR_LINK' ||
    phase === 'RECONNECTING'
  );
}

function readSessions(): CandidateSession[] {
  return mspSessionCoordinator.listSessionIds().map(sessionId => ({
    sessionId,
    ownership: mspSessionCoordinator.getOwnershipState(sessionId),
    sessionKey: mspSessionCoordinator.getSessionKey(sessionId),
    identification: mspSessionCoordinator.getIdentificationState(sessionId),
  }));
}

/**
 * A primitive fingerprint of everything the resolver reads. Two renders
 * that would produce the same verdict produce the same string, so
 * useSyncExternalStore settles.
 */
function fingerprint(): string {
  const sessions = readSessions()
    .map(
      session =>
        `${session.sessionId}|${session.ownership}|` +
        `${session.sessionKey?.generation ?? '-'}|` +
        `${session.identification.status}`,
    )
    .join(';');
  return `${rebootInFlight() ? 'R' : '-'}#${sessions}`;
}

export function useVerifiedFcConnection(): VerifiedConnection {
  const snapshot = useSyncExternalStore(subscribeEverything, fingerprint);
  return useMemo(
    () =>
      resolveVerifiedConnection({
        sessions: readSessions(),
        rebootInFlight: rebootInFlight(),
      }),
    // The fingerprint IS the dependency: it changes exactly when one of
    // the facts behind the verdict changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot],
  );
}
