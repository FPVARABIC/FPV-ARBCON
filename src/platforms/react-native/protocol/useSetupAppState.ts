/**
 * Pass 7.7 - the read side of the single AppState owner. The owner
 * already has subscribe()/getPhase(); this only exposes them to React so
 * Region 5's controls can disable themselves the instant the app leaves
 * the foreground. It adds NO second AppState listener.
 */

import {useSyncExternalStore} from 'react';

import {setupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';
import type {SetupAppStatePhase, SetupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';

export function useSetupAppStatePhase(
  owner: SetupAppStateTelemetryOwner = setupAppStateTelemetryOwner,
): SetupAppStatePhase {
  return useSyncExternalStore(
    listener => owner.subscribe(listener),
    () => owner.getPhase(),
    () => owner.getPhase(),
  );
}
