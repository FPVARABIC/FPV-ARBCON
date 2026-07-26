/**
 * Pass 7.7, Region 5 - the read side of the single shared FC-tool mutex.
 * useSyncExternalStore over the controller's own subscribe(), exactly
 * like useAuxTelemetry's existing pattern: no polling, no second store.
 */

import {useSyncExternalStore} from 'react';

import {fcToolsController} from './FcToolsController';
import type {FcToolOutcome, FcToolPhase, FcToolsController} from './FcToolsController';
import type {ArmedState, MspStatusExDiagnostics} from '../../../core';

export function useFcToolPhase(controller: FcToolsController = fcToolsController): FcToolPhase {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getPhase(),
    () => controller.getPhase(),
  );
}

export function useFcToolOutcome(controller: FcToolsController = fcToolsController): FcToolOutcome | undefined {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getLastOutcome(),
    () => controller.getLastOutcome(),
  );
}

/**
 * The armed state the Region-5 controls gate on: read from the
 * at-most-once BOXIDS mapping the controller owns, never polled and
 * never guessed. The effect-free `ensure` call belongs in the caller's
 * own useEffect; this hook only reads and re-renders when the mapping
 * (or any other controller state) changes.
 */
export function useFcToolArmedState(
  sessionId: string,
  status: MspStatusExDiagnostics | undefined,
  controller: FcToolsController = fcToolsController,
): ArmedState {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.peekArmedState(sessionId, status),
    () => controller.peekArmedState(sessionId, status),
  );
}
