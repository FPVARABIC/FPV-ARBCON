/**
 * THE SENSOR SAVE THAT OUTLIVES ITS OWN SCREEN.
 *
 * Same problem, same shape and the same reasoning as
 * blackboxPendingSave.ts, for the same structural reason: a hardware
 * selection is read once at boot, so saving one ends in a deliberate
 * reboot - and App.tsx unregisters the whole configuration workspace
 * while a board is rebooting. The screen that pressed Save is gone by the
 * time the board returns, taking any component state with it.
 *
 * The controller refuses to verify persistence against the session that
 * wrote, by identity. That token therefore has to survive a gap that
 * destroys the tree holding it, and it cannot live in the tree.
 *
 * NOT navigation state: a route param survives a page reload and would
 * announce "verifying your save" to somebody who just refreshed. NOT
 * persisted storage: a token kept across an app restart would eventually
 * be checked against a board that had been reflashed or swapped, and the
 * mismatch reported as a failed save that never happened.
 *
 * In memory, for one app run, cleared the moment it is answered.
 */

import {useSyncExternalStore} from 'react';

import type {SensorsPendingHardware} from '../../platforms/react-native/protocol';

let current: SensorsPendingHardware | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const sensorsPendingSave = {
  get(): SensorsPendingHardware | null {
    return current;
  },

  /** Raised by a hardware save that reached the reboot, and nothing else. */
  set(pending: SensorsPendingHardware): void {
    current = pending;
    emit();
  },

  /** Cleared once ANSWERED - verified, mismatched, or refused. A token
   *  that outlived its answer would make the next session verify a save
   *  that had already been reported. */
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

export function useSensorsPendingSave(): SensorsPendingHardware | null {
  return useSyncExternalStore(
    sensorsPendingSave.subscribe,
    sensorsPendingSave.get,
    sensorsPendingSave.get,
  );
}
