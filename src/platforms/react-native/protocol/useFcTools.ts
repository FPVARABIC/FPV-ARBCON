/**
 * Pass 7.7, Region 5 - the read side of the single shared FC-tool mutex.
 * useSyncExternalStore over the controller's own subscribe(), exactly
 * like useAuxTelemetry's existing pattern: no polling, no second store.
 */

import {useCallback, useRef, useSyncExternalStore} from 'react';

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

/**
 * Pass 7.7A (A-1): the outcome THIS mounted subscriber may show.
 *
 * Two independent guards, deliberately not collapsed into one:
 *  - a MOUNT BASELINE captured once per component instance, so an
 *    outcome published before this instance existed can never be
 *    replayed or re-announced after a remount;
 *  - PROVENANCE revocation inside the controller, so a replacement
 *    physical generation or MSP epoch immediately hides an older
 *    session's outcome, while a transient detach with no replacement
 *    leaves an already-received acknowledgement alone.
 *
 * The baseline lives in a ref, so React Strict Mode's double effect
 * invocation reuses the same instance's baseline rather than shifting
 * it, and an unmounted instance's cleanup can never touch controller
 * state at all - there is none to clear.
 */
export function useFcToolPublication(
  sessionId: string,
  controller: FcToolsController = fcToolsController,
): FcToolOutcome | undefined {
  const mountedAtSequence = useRef<number | undefined>(undefined);
  if (mountedAtSequence.current === undefined) {
    mountedAtSequence.current = controller.getPublicationSequence();
  }
  const baseline = mountedAtSequence.current;

  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const snapshot = useCallback(
    () => controller.getVisibleOutcome(sessionId, baseline),
    [controller, sessionId, baseline],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
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
