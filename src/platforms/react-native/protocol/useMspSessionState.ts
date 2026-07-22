/**
 * React bindings for MspSessionCoordinator's two independent state axes
 * (Pass 6.4b) - a thin useSyncExternalStore wrapper around
 * subscribeOwnershipState()/getOwnershipState() and
 * subscribeIdentificationState()/getIdentificationState(). Shared between
 * UsbConnectionScreen.tsx (which derives mspActive from ownership state)
 * and UsbSerialDebugPanel.tsx (which displays identification results) so
 * neither has to duplicate this wiring.
 *
 * The subscribe functions are defined once, at module scope, rather than
 * inline inside each hook - they don't depend on sessionId (a change to
 * ANY session's ownership/identification notifies every subscriber; the
 * getSnapshot function is what narrows to one specific sessionId), so a
 * single stable function reference can be reused across every call site,
 * letting useSyncExternalStore avoid needless resubscription.
 */

import {useSyncExternalStore} from 'react';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {MspIdentificationState, MspSessionOwnershipState} from './MspSessionCoordinator';

function subscribeOwnership(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeOwnershipState(listener);
}

function subscribeIdentification(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeIdentificationState(listener);
}

export function useMspOwnershipState(sessionId: string): MspSessionOwnershipState {
  return useSyncExternalStore(subscribeOwnership, () => mspSessionCoordinator.getOwnershipState(sessionId));
}

export function useMspIdentificationState(sessionId: string): MspIdentificationState {
  return useSyncExternalStore(subscribeIdentification, () => mspSessionCoordinator.getIdentificationState(sessionId));
}
