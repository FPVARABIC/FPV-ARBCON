/**
 * React bindings for MspSessionCoordinator's ownership/identification/
 * MspClient-recovery-state axes (Pass 6.4b; recovery state added Pass
 * 7.4, Step 4) - a thin useSyncExternalStore wrapper around
 * subscribeOwnershipState()/getOwnershipState(),
 * subscribeIdentificationState()/getIdentificationState(), and
 * subscribeMspRecoveryState()/getMspRecoveryState(). Shared between
 * UsbConnectionScreen.tsx (which derives mspActive from ownership state)
 * and UsbSerialDebugPanel.tsx (which displays identification results) so
 * neither has to duplicate this wiring; useMspRecoveryState() itself is
 * for Region 1's Setup top-bar connection indicator (Step 4).
 *
 * The subscribe functions are defined once, at module scope, rather than
 * inline inside each hook - they don't depend on sessionId (a change to
 * ANY session's ownership/identification/recovery-state notifies every
 * subscriber; the getSnapshot function is what narrows to one specific
 * sessionId), so a single stable function reference can be reused across
 * every call site, letting useSyncExternalStore avoid needless
 * resubscription.
 */

import {useSyncExternalStore} from 'react';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {MspClientState} from '../../../core';
import type {MspIdentificationState, MspSessionOwnershipState} from './MspSessionCoordinator';

function subscribeOwnership(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeOwnershipState(listener);
}

function subscribeIdentification(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeIdentificationState(listener);
}

function subscribeMspRecoveryState(listener: () => void): () => void {
  return mspSessionCoordinator.subscribeMspRecoveryState(listener);
}

export function useMspOwnershipState(sessionId: string): MspSessionOwnershipState {
  return useSyncExternalStore(subscribeOwnership, () => mspSessionCoordinator.getOwnershipState(sessionId));
}

export function useMspIdentificationState(sessionId: string): MspIdentificationState {
  return useSyncExternalStore(subscribeIdentification, () => mspSessionCoordinator.getIdentificationState(sessionId));
}

/** undefined for a sessionId with no active session - mirrors
 * getMspRecoveryState()'s own convention (see that method's doc comment
 * for why no object-caching machinery is needed here: MspClientState is
 * a bare string union, always referentially stable via ===). */
export function useMspRecoveryState(sessionId: string): MspClientState | undefined {
  return useSyncExternalStore(subscribeMspRecoveryState, () => mspSessionCoordinator.getMspRecoveryState(sessionId));
}
