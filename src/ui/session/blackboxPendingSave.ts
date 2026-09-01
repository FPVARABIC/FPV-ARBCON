/**
 * THE SAVE THAT OUTLIVES ITS OWN SCREEN.
 *
 * =====================================================================
 * WHY THIS HAS TO EXIST AT ALL
 * =====================================================================
 *
 * A Blackbox save ends with a deliberate reboot, and this application
 * unmounts the entire configuration workspace while one is in flight -
 * App.tsx registers the `Setup` route only while a verified connection
 * exists, and a rebooting board is not one. So the screen that pressed
 * Save is GONE by the time the board comes back, along with any component
 * state it was holding.
 *
 * The controller's own contract is that `verifyPersistence()` may only be
 * called against a session whose generation differs from the one the write
 * happened on - it refuses the old one by identity. That token therefore
 * has to survive the gap between two sessions, which means it cannot live
 * in the tree that the gap destroys.
 *
 * =====================================================================
 * WHY IT IS NOT NAVIGATION STATE, AND NOT STORAGE
 * =====================================================================
 *
 * The same reasoning as connectionNotice, which this deliberately mirrors:
 * a route param survives a page reload and would have the app announce
 * "verifying your save" to somebody who just refreshed the browser, and it
 * becomes a history entry the Back button can return to. Persisted storage
 * is worse again - a token kept across an app restart would eventually be
 * checked against a board that had been reflashed, powered down, or
 * swapped for another one, and a mismatch would then be reported as a
 * failed save that never happened.
 *
 * In memory, for the lifetime of one app run, cleared the moment it is
 * answered. If the app itself dies mid-reboot, the token dies with it and
 * the screen simply re-reads the board like any other first load - which
 * is the truthful outcome, because nothing was ever verified.
 */

import {useSyncExternalStore} from 'react';

import type {BlackboxPendingPersistence} from '../../platforms/react-native/protocol';

let current: BlackboxPendingPersistence | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const blackboxPendingSave = {
  get(): BlackboxPendingPersistence | null {
    return current;
  },

  /** Raised by a save that reached the reboot, and by nothing else. */
  set(pending: BlackboxPendingPersistence): void {
    current = pending;
    emit();
  },

  /**
   * Cleared once the token has been ANSWERED - verified, mismatched, or
   * refused. A token that stayed after its answer would make the next
   * session verify a save that was already reported.
   */
  clear(): void {
    if (current === null) return;
    current = null;
    emit();
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * The token as React state.
 *
 * The snapshot is the stored object itself - a frozen value replaced only
 * by set()/clear() - so it is referentially stable between changes, which
 * is what useSyncExternalStore requires. Building a fresh object per read
 * would loop forever.
 */
export function useBlackboxPendingSave(): BlackboxPendingPersistence | null {
  return useSyncExternalStore(blackboxPendingSave.subscribe, blackboxPendingSave.get);
}
