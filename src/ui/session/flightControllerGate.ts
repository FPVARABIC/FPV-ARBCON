/**
 * ONE DEFINITION OF "THERE IS A FLIGHT CONTROLLER TO CONFIGURE".
 *
 * THE DEFECT THIS CLOSES. Every configuration tab mounted its screen
 * whether or not anything was plugged in, because MainTabsScreen passed
 * `sessionKey` straight through and each screen then invented its own
 * posture for `undefined`. Measured before this existed: the Motors tab
 * with NO flight controller rendered 90 labelled nodes over 3.4 screens
 * of scroll, with five controls still enabled, under the heading
 * "مختبر العتاد"; PID rendered its profile cards with "—" in every
 * field, as though it had read them. A screen that looks like it is
 * reading a board it cannot see is worse than no screen at all.
 *
 * WHY A ROUTE PARAMETER IS NOT AN ANSWER. `sessionKey` arrives in
 * navigation params, and navigation params persist: through a browser
 * back/forward, through a state restore, through a reboot that ended the
 * session it names. Holding one proves only that a session existed once.
 * The coordinator is the only thing that knows what is true NOW, so this
 * asks it three separate questions and requires all three:
 *
 *   1. OWNERSHIP is ACTIVE - the transport is open and ours.
 *   2. The coordinator's CURRENT generation matches the key's. A
 *      reconnect mints a new generation, so a key from before it is
 *      refused rather than silently reused against different hardware.
 *   3. IDENTIFICATION has SUCCEEDED - we know what board this is. Until
 *      it has, no screen can honestly render firmware-shaped fields.
 *
 * This module is deliberately PURE - no React, no coordinator import -
 * so every combination of the three axes can be asserted directly
 * instead of inferred from a rendered tree.
 *
 * SCOPE. This is the SCREEN gate, and it is the second of two layers,
 * not the only one. Every configuration controller already refuses a
 * read or a write on a session that is not current (their own `capture`
 * guards, returning DISCONNECTED / LINK_RECOVERING). That layer is what
 * makes a stale operation impossible; this layer is what stops the app
 * presenting a dead session as a working screen in the first place.
 */

import type {
  MspIdentificationState,
  MspSessionOwnershipState,
  SetupUiSessionKey,
} from '../../platforms/react-native/protocol';

/**
 * Why a screen is not usable, or that it is.
 *
 * The reasons are kept apart rather than collapsed into one "not ready"
 * because they are different situations for the operator: nothing is
 * plugged in, versus the board went away, versus we are still asking it
 * what it is. Only the copy differs - the gate is closed in all three.
 */
export type FlightControllerGate =
  | {readonly kind: 'READY'; readonly sessionKey: SetupUiSessionKey}
  /** No session key at all: nothing has ever been connected here. */
  | {readonly kind: 'NO_SESSION'}
  /** A key we hold is not the one the coordinator recognises now. */
  | {readonly kind: 'STALE_SESSION'}
  /** Live link, but we do not yet know what board is on it. */
  | {readonly kind: 'IDENTIFYING'};

export interface FlightControllerGateInputs {
  /** The key the screen was handed, from navigation params. */
  readonly sessionKey: SetupUiSessionKey | undefined;
  readonly ownership: MspSessionOwnershipState;
  readonly currentSessionKey: SetupUiSessionKey | undefined;
  readonly identification: MspIdentificationState;
}

export function resolveFlightControllerGate(
  inputs: FlightControllerGateInputs,
): FlightControllerGate {
  const {sessionKey, ownership, currentSessionKey, identification} = inputs;
  if (sessionKey === undefined) return {kind: 'NO_SESSION'};

  // ACTIVATING and CLOSING are both "not usable": one has not finished
  // opening, the other is already tearing down. Only ACTIVE passes.
  if (ownership !== 'ACTIVE') return {kind: 'STALE_SESSION'};

  // The coordinator has no session under this id at all, or has a
  // DIFFERENT one than the key names. Either way the key is history.
  if (
    currentSessionKey === undefined ||
    currentSessionKey.sessionId !== sessionKey.sessionId ||
    currentSessionKey.generation !== sessionKey.generation
  ) {
    return {kind: 'STALE_SESSION'};
  }

  // A FAILED identification is not "identifying" - it is a board we
  // could not read, and a configuration screen has nothing to show for
  // it. Treated as stale so the operator is sent back to the connection
  // workspace, which is where that failure is actually reported.
  if (identification.status === 'FAILED') return {kind: 'STALE_SESSION'};
  if (identification.status !== 'SUCCEEDED') return {kind: 'IDENTIFYING'};

  return {kind: 'READY', sessionKey};
}

/** Every tab whose screen genuinely needs a flight controller on the
 *  other end. Exported so a test can assert the list rather than trust
 *  a reading of MainTabsScreen's JSX.
 *
 *  SETUP is absent on purpose and must stay absent: it HOSTS the
 *  connection workspace when nothing is connected, so gating it would
 *  remove the only way to connect and make the gate a trap. */
export const FC_DEPENDENT_TABS = Object.freeze([
  'MOTORS',
  'PORTS',
  'GPS',
  'CONFIGURATIONS',
  'RECEIVER',
  'PID',
  'MODES',
  'FAILSAFE',
  'POWER',
  'OSD',
  'VTX',
  'SENSORS',
  'PRESETS',
  'CLI',
] as const);

export type FcDependentTab = (typeof FC_DEPENDENT_TABS)[number];

export function tabRequiresFlightController(tab: string): boolean {
  return (FC_DEPENDENT_TABS as readonly string[]).includes(tab);
}
