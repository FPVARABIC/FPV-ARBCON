/**
 * "THE BOARD WENT AWAY", told to Home without going through navigation.
 *
 * WHY THIS IS NOT A ROUTE PARAM. Losing a link returns the operator to
 * Home, and Home has to say why. The obvious way to carry that is a
 * param on the Start route - and it is wrong twice over: a param is
 * navigation state, so it survives a refresh and would announce a lost
 * connection to somebody who just reloaded the page, and it becomes a
 * browser history entry the Back button can return to.
 *
 * So it is a one-shot signal instead. Set when a tracked session dies,
 * read once by whoever is showing Home, and gone. It cannot be restored,
 * deep-linked, or navigated back into.
 */

import {useSyncExternalStore} from 'react';

export type ConnectionNotice = 'SESSION_LOST' | null;

let current: ConnectionNotice = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const connectionNotice = {
  get(): ConnectionNotice {
    return current;
  },

  /** Raised by the session-loss rule, and by nothing else. */
  raise(notice: Exclude<ConnectionNotice, null>): void {
    if (current === notice) return;
    current = notice;
    emit();
  },

  /**
   * Cleared when the operator has seen it, or when a new connection
   * attempt starts - reporting the previous loss over a fresh attempt
   * is noise, not news.
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
 * The notice as React state. The snapshot is a string-or-null, which is
 * referentially stable by construction - useSyncExternalStore re-renders
 * until it settles, and a fresh object every read never would.
 */
export function useConnectionNotice(): ConnectionNotice {
  return useSyncExternalStore(connectionNotice.subscribe, connectionNotice.get);
}
