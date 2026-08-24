/**
 * WHICHEVER SCREEN NEEDS THE AIRCRAFT, READS THE AIRCRAFT.
 *
 * =====================================================================
 * THE RULE THIS ENFORCES
 * =====================================================================
 *
 * M-F3F §15: Setup must not depend on MotorsScreen. It is the screen an
 * operator opens FIRST, and it must be able to show the right aircraft
 * on a connection where Motors has never been visited. So the shared
 * record (`observedAirframeTruth`) is not something only Motors fills:
 * any screen that needs it mounts this hook, and the first one to have a
 * session performs the read.
 *
 * §10: it is still ONE record. This hook publishes into the same store
 * Motors publishes into, from the same verified configuration
 * transaction, and it never keeps a private copy. A second reader is not
 * a second truth.
 *
 * =====================================================================
 * WHAT IT DOES NOT DO
 * =====================================================================
 *
 * It does not poll, and it does not re-read on every render: ONE read
 * per session, and only when the record does not already describe that
 * session. Motors normally gets there first (it reads the configuration
 * for its own editor), in which case this hook issues nothing at all and
 * simply reports what is already known.
 *
 * It does not take the configuration interlock, acquire a capability
 * scope, or pause telemetry. That is not an optimisation - a `load()`
 * here measurably starved Setup's own attitude poll and cost it a third
 * box-id acquisition, which is the screen paying to ask a question about
 * itself.
 *
 * It does not guess. A read that fails leaves the record empty, and the
 * consumer draws no airframe rather than a plausible one.
 */

import {useEffect, useRef, useSyncExternalStore} from 'react';

import {
  observedAirframeTruth,
  type ObservedAirframe,
} from '../../core/state/observedAirframeTruth';
import {motorConfigurationController} from '../../platforms/react-native/protocol';

/**
 * The read this hook performs, injectable so a test can supply a board
 * without a transport.
 *
 * DELIBERATELY THE NARROW READ, not the settings transaction. See
 * `readObservedAirframe` on the controller for why: the full `load()`
 * takes an exclusive interlock, acquires a fresh capability scope and
 * pauses telemetry, and a screen that only draws the aircraft must not
 * pay - or make its own screen pay - any of that.
 */
export interface ObservedAirframeReader {
  readObservedAirframe(sessionId: string): Promise<
    | {readonly mixerModeRaw: number; readonly motorCount: number | undefined}
    | undefined
  >;
}

/**
 * The observed airframe for the CURRENT session, reading it once if
 * nobody has.
 *
 * Returns `undefined` when nothing is connected, when the read has not
 * landed yet, when it failed, or when the record belongs to a previous
 * session - a stale record is not an answer about the board in front of
 * the operator now.
 */
export function useObservedAirframe(
  sessionId: string | undefined,
  reader: ObservedAirframeReader = motorConfigurationController,
): ObservedAirframe | undefined {
  const observed = useSyncExternalStore(
    listener => observedAirframeTruth.subscribe(listener),
    () => observedAirframeTruth.get(),
  );
  /** The session a read has already been started for, so a re-render
   *  cannot start a second one. */
  const requested = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === undefined) {
      requested.current = undefined;
      /* A DISCONNECTED BOARD HAS NO AIRFRAME. Clearing here rather than
         letting the last one stand is what stops a screen drawing the
         previous aircraft over a dead link. */
      observedAirframeTruth.clear();
      return;
    }
    if (observedAirframeTruth.get()?.sessionId === sessionId) return;
    if (requested.current === sessionId) return;
    requested.current = sessionId;
    let abandoned = false;
    reader
      .readObservedAirframe(sessionId)
      .then(observedAirframe => {
        if (abandoned || observedAirframe === undefined) return;
        observedAirframeTruth.publish({
          mixerModeRaw: observedAirframe.mixerModeRaw,
          motorCount: observedAirframe.motorCount,
          sessionId,
        });
      })
      .catch(() => {
        /* A failed read publishes nothing. The consumer's own "no
           airframe" rendering is the honest outcome, and a retry belongs
           to whatever the operator does next, not to a loop here. */
      });
    return () => {
      abandoned = true;
    };
  }, [reader, sessionId]);

  return observed?.sessionId === sessionId ? observed : undefined;
}
