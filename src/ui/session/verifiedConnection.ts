/**
 * IS THERE A FLIGHT CONTROLLER, RIGHT NOW? The whole application's shape
 * hangs off this one answer.
 *
 * THE ARCHITECTURE THIS SERVES. The configuration workspace - the tab
 * shell and every screen in it - is not a thing that gets disabled when
 * there is no board. It is a thing that DOES NOT EXIST until there is
 * one. App.tsx registers the `Setup` route only while this resolver says
 * CONNECTED, so before that there is no route to navigate to, nothing to
 * deep-link into, nothing to restore from a saved navigation state, and
 * nothing to render for a frame before a guard notices. A screen that is
 * absent from the navigator cannot flash.
 *
 * WHY THIS IS NOT THE PREVIOUS GATE. The earlier attempt asked "is the
 * key this SCREEN was handed still good?" and answered inside each tab
 * panel, which meant the shell, the tab bar and a card reading "no
 * flight controller connected" were all still on screen. This asks a
 * question with no screen in it at all: does the coordinator hold a live,
 * current, identified session anywhere? The answer decides which
 * application the operator is in.
 *
 * FOUR FACTS, ALL REQUIRED, and pressing "connect" is none of them:
 *   1. a session exists in the coordinator at all;
 *   2. its ownership is ACTIVE - not ACTIVATING, not CLOSING;
 *   3. it still has a session key, whose generation IS the current one
 *      by construction (the coordinator mints it);
 *   4. identification SUCCEEDED - we know which board this is.
 *
 * Pure: no React, no coordinator import, so every combination can be
 * asserted directly rather than inferred from a rendered tree.
 */

import type {
  MspIdentificationState,
  MspSessionOwnershipState,
  SetupUiSessionKey,
} from '../../platforms/react-native/protocol';

export interface CandidateSession {
  readonly sessionId: string;
  readonly ownership: MspSessionOwnershipState;
  readonly sessionKey: SetupUiSessionKey | undefined;
  readonly identification: MspIdentificationState;
}

export type VerifiedConnection =
  /** The configuration workspace exists. */
  | {readonly kind: 'CONNECTED'; readonly sessionKey: SetupUiSessionKey}
  /** Nothing usable. The operator sees the connection workspace. */
  | {readonly kind: 'DISCONNECTED'}
  /** A link is up but the board has not said what it is yet. */
  | {readonly kind: 'IDENTIFYING'}
  /**
   * A reboot WE ASKED FOR is in flight - a CLI `save`. Distinct from
   * DISCONNECTED because the operator is told to wait rather than told
   * to plug something in, and because offering a connect button here
   * invites them to fight a recovery that is already running.
   */
  | {readonly kind: 'REBOOTING'};

export function resolveVerifiedConnection(inputs: {
  readonly sessions: readonly CandidateSession[];
  /** fcRebootRecovery is mid-lifecycle for a reboot the app caused. */
  readonly rebootInFlight: boolean;
}): VerifiedConnection {
  const {sessions, rebootInFlight} = inputs;

  for (const session of sessions) {
    if (session.ownership !== 'ACTIVE') continue;
    if (session.sessionKey === undefined) continue;
    if (session.identification.status === 'SUCCEEDED') {
      return {kind: 'CONNECTED', sessionKey: session.sessionKey};
    }
  }

  // An expected reboot outranks "still identifying": during one, the old
  // session is dying and a new one is not up yet, and what the operator
  // needs to see is that the app knows why.
  if (rebootInFlight) return {kind: 'REBOOTING'};

  // A live link whose identity is still being read. FAILED is NOT this -
  // that board was read and could not be understood, which is a
  // connection problem and belongs in the connection workspace.
  for (const session of sessions) {
    if (session.ownership !== 'ACTIVE') continue;
    const {status} = session.identification;
    if (status === 'IDLE' || status === 'RUNNING') return {kind: 'IDENTIFYING'};
  }

  return {kind: 'DISCONNECTED'};
}

/** The single predicate App.tsx registers the protected routes on. */
export function configurationWorkspaceUnlocked(
  connection: VerifiedConnection,
): boolean {
  return connection.kind === 'CONNECTED';
}
