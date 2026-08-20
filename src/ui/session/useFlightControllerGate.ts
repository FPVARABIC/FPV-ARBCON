/**
 * The gate, bound to the live coordinator.
 *
 * Every input is read through useSyncExternalStore (useMspSessionState),
 * so the gate re-evaluates the instant ownership, the current key or the
 * identification result changes - which is what makes a screen collapse
 * to the disconnected state the moment the board goes away, rather than
 * at the next navigation.
 *
 * The pure decision lives in flightControllerGate.ts; this file only
 * gathers the three facts and hands them over.
 *
 * TWO REFERENTIAL-STABILITY RULES, both learned the hard way here:
 *
 *  1. useSyncExternalStore RE-RENDERS UNTIL getSnapshot IS STABLE.
 *     `getSessionKey()` mints a fresh {sessionId, generation} object per
 *     call, so subscribing to it directly produced a new snapshot every
 *     render and React gave up with "Maximum update depth exceeded" -
 *     an infinite loop that mainTabsRenderCost.test.tsx caught on the
 *     first run. Only the GENERATION is read from the store, as a
 *     number, and the key is rebuilt from it.
 *
 *  2. THE VERDICT ITSELF MUST BE STABLE TOO. It is handed to fifteen
 *     React.memo'd tab panels; a fresh object per render would defeat
 *     every one of them and make each tab switch re-render the whole
 *     shell again - the exact regression that test exists to prevent.
 */

import {useMemo, useSyncExternalStore} from 'react';
import {
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  useMspIdentificationState,
  useMspOwnershipState,
} from '../../platforms/react-native/protocol/useMspSessionState';
import {
  resolveFlightControllerGate,
  type FlightControllerGate,
} from './flightControllerGate';

/**
 * A stable subscribe for the coordinator's CURRENT session key.
 *
 * Ownership changes whenever a session opens or closes, and a generation
 * only ever moves as part of one of those transitions, so the ownership
 * feed is the right notification source for "which key is current now".
 */
function subscribeCurrentKey(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeOwnershipState(listener);
}

/** A number or undefined - never a fresh object. See rule 1 above. */
function useCurrentGeneration(sessionId: string | undefined): number | undefined {
  return useSyncExternalStore(subscribeCurrentKey, () =>
    sessionId === undefined
      ? undefined
      : mspSessionCoordinator.getSessionKey(sessionId)?.generation,
  );
}

export function useFlightControllerGate(
  sessionKey: SetupUiSessionKey | undefined,
): FlightControllerGate {
  // A missing key still has to call the hooks - React requires a stable
  // hook order - so a placeholder id is used and the gate rejects on the
  // undefined key regardless of what these return.
  const sessionId = sessionKey?.sessionId ?? '';
  const ownership = useMspOwnershipState(sessionId);
  const identification = useMspIdentificationState(sessionId);
  const currentGeneration = useCurrentGeneration(sessionKey?.sessionId);

  return useMemo(() => {
    const currentSessionKey =
      sessionKey === undefined || currentGeneration === undefined
        ? undefined
        : {sessionId: sessionKey.sessionId, generation: currentGeneration};
    return resolveFlightControllerGate({
      sessionKey,
      ownership,
      currentSessionKey,
      identification,
    });
  }, [sessionKey, ownership, currentGeneration, identification]);
}
