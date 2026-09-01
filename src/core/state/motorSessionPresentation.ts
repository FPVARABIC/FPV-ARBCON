/**
 * WHAT THE MOTORS SESSION TOGGLE IS ALLOWED TO SAY.
 *
 * THE DEFECT THIS EXISTS TO FIX, measured before it was designed. The
 * workspace toggle used to be driven by a UI-local `useState(false)`
 * called `professionalEnabled`, and `deriveWorkspacePhase` read that
 * boolean as if it were session truth. It is not. The controller's clean
 * teardown leaves `outcome.kind === 'READY'` untouched and only sets
 * `phase = 'CLOSED'` (motorTestController.ts:4295 and :4321), so after any
 * teardown the operator did not personally initiate - leaving the tab,
 * backgrounding the app, a USB drop - the pair became:
 *
 *     phase: 'CLOSED'   outcome: 'READY'   professionalEnabled: true
 *
 * and the toggle rendered READY. A closed session presented as an open
 * one. That is the "persistent session state is visually unclear" the
 * operator reported from the phone, stated exactly.
 *
 * THE RULE HERE: the CONTROLLER's phase decides ON and OFF. The operator's
 * intent may only decide OPENING, and may never hold a session open that
 * the controller has closed. A boolean the UI owns can be stale; a phase
 * the controller publishes cannot.
 *
 * DO NOT LOOK FALSELY OFF EITHER. A teardown that could not complete is
 * ERROR, not OFF - the arming restriction may still be held and the stop
 * may be unproven, so "OFF" would be a second lie in the opposite
 * direction. Both directions are failures; only one of them is obvious.
 *
 * NO I/O, NO REACT, NO TIMER. A pure function of a snapshot, so the states
 * that only occur on real hardware can be tested exhaustively here.
 */

import type {MotorTestControllerSnapshot} from './motorTestController';

/**
 * What the operator is told, and nothing else.
 *
 *   OFF      no session; nothing acquired; nothing to release.
 *   OPENING  bring-up in flight. Transitional - not yet ON.
 *   ON       a live session exists. Configuration is leased, the arming
 *            restriction is established, telemetry is paused.
 *   CLOSING  teardown in flight. Transitional - not yet OFF.
 *   ERROR    the session failed, or a teardown did not complete. Never
 *            renders as either ON or OFF.
 *   UNKNOWN  no snapshot at all (no operator bound yet). Distinct from
 *            OFF: "there is no session" and "we cannot see one" are
 *            different sentences and only one of them is reassuring.
 */
export type MotorSessionState =
  | 'OFF'
  | 'OPENING'
  | 'ON'
  | 'CLOSING'
  | 'ERROR'
  | 'UNKNOWN';

/**
 * True only for the two states in which the toggle must not accept a new
 * instruction: a transition already owns the session.
 */
export function motorSessionIsTransitioning(state: MotorSessionState): boolean {
  return state === 'OPENING' || state === 'CLOSING';
}

/**
 * The switch's own `value`. ON is the ONLY state that reads as on.
 *
 * Deliberately not "not OFF": ERROR and UNKNOWN must not present as ON,
 * and CLOSING must not either - a session being torn down is not one the
 * operator can command.
 */
export function motorSessionSwitchValue(state: MotorSessionState): boolean {
  return state === 'ON';
}

/**
 * Whether motor COMMAND authority may exist at all right now.
 *
 * Separate from the session on purpose (see MotorWorkspace): a session is
 * the context, command authority is permission to drive an output inside
 * it. Session ON never implies a motor turns, and this never implies a
 * value above stop.
 */
export function motorControlMayBeEnabled(
  state: MotorSessionState,
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  if (state !== 'ON' || snapshot === undefined) {
    return false;
  }
  // The controller's own readiness still governs. A session can be ON
  // while the machine is Checking, Pulsing or Stopping, and none of those
  // are moments to hand the operator a fresh slider.
  return snapshot.outcome.kind === 'READY';
}

/**
 * Derives the session state from CONTROLLER TRUTH, with the operator's
 * intent admitted for one purpose only: naming the gap between "begin was
 * pressed" and "the controller published PREPARING".
 *
 * @param snapshot     the controller's published snapshot, or undefined.
 * @param openRequested the operator asked for ON and no result has landed.
 */
export function deriveMotorSessionState(
  snapshot: MotorTestControllerSnapshot | undefined,
  openRequested: boolean,
): MotorSessionState {
  if (snapshot === undefined) {
    // Intent alone, with nothing bound, is still an honest OPENING: the
    // operator pressed something and the app is doing it.
    return openRequested ? 'OPENING' : 'UNKNOWN';
  }

  switch (snapshot.phase) {
    case 'IDLE':
      // Nothing acquired. Intent that has not yet reached the controller
      // is the one legitimate reason to show OPENING here.
      return openRequested ? 'OPENING' : 'OFF';
    case 'PREPARING':
      return 'OPENING';
    case 'ACTIVE':
      // A live session whose OUTCOME already failed closed is not ON.
      return snapshot.outcome.kind === 'FAILED_CLOSED' ? 'ERROR' : 'ON';
    case 'CLOSING':
      return 'CLOSING';
    case 'CLOSED':
      // THE CASE THAT CAUSED THIS MODULE. Closed is closed, whatever a UI
      // boolean still believes - but an incomplete teardown is ERROR,
      // because the lease and the arming restriction may still be held.
      if (snapshot.teardown !== undefined && snapshot.teardown.complete !== true) {
        return 'ERROR';
      }
      return snapshot.outcome.kind === 'FAILED_CLOSED' ? 'ERROR' : 'OFF';
  }
}

/**
 * Whether a session in this state still owns something that must be given
 * back. Used to decide whether an OFF instruction has any work to do.
 */
export function motorSessionHoldsAuthority(state: MotorSessionState): boolean {
  return state === 'ON' || state === 'OPENING' || state === 'ERROR';
}
