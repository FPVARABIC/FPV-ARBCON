/**
 * Pass 7.1 - pure UI-state storage for the (not-yet-built) Setup screen,
 * keyed by SetupUiSessionKey (see MspSessionCoordinator.ts's own doc
 * comment on that type) rather than by sessionId alone: a reused native
 * sessionId string must never let one physical session's UI state (which
 * diagnostic sections are expanded, which incidents were dismissed, the
 * orientation-view offset) leak into a different activation of that same
 * id.
 *
 * A module-level singleton, mirroring MspSessionCoordinator's own
 * established precedent (see that file's class doc comment for why: no
 * React Context usage and no generic event-emitter/pub-sub pattern exists
 * elsewhere in this codebase for cross-cutting state). Placed alongside
 * MspSessionCoordinator rather than under src/ui/ - it is not a component
 * and has no rendering logic, only a same-shaped singleton keyed by the
 * same session identity that module already owns.
 *
 * Pure storage mechanism only for this pass: no useSyncExternalStore hook,
 * no subscribe/notify machinery, no listening for generation changes. Real
 * UI wiring (a reactive hook, actually reading/writing these fields from
 * the Setup screen) is Pass 7.3.
 *
 * Orphaned entries (a generation that will never be read again, e.g. after
 * its session was torn down) are deliberately left uncollected in this
 * pass: each entry is a handful of small values, growth is bounded by how
 * many times a session is genuinely (re)activated during one app process's
 * life (not by any unbounded user-facing loop), and this store only grows
 * an entry on an actual update() - never merely from a read - so probing
 * getState() for many keys cannot inflate it either. Picking an eviction
 * policy (tie it to the ACTIVE -> INACTIVE ownership transition? an LRU
 * cap?) now, before Pass 7.3's real UI wiring shows what usage actually
 * looks like, would be guessing at a requirement that does not exist yet -
 * left for a later pass if it turns out to matter.
 */

import type {SetupUiSessionKey} from './MspSessionCoordinator';

export type SetupUiSessionState = {
  expandedDiagnosticSections: Set<string>;
  dismissedAutoOpenIncidents: Set<string>;
  orientationViewOffset: {rollDeg: number; pitchDeg: number; yawDeg: number};
};

function defaultState(): SetupUiSessionState {
  return {
    expandedDiagnosticSections: new Set(),
    dismissedAutoOpenIncidents: new Set(),
    orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
  };
}

/** Composite key serialization - a reused sessionId string with a
 * different generation must serialize to a different map key. generation
 * is a plain integer (see MspSessionCoordinator.ts), so ':' can never
 * appear inside either component and cannot cause two distinct keys to
 * collide on the same serialized string. */
function serializeKey(key: SetupUiSessionKey): string {
  return `${key.sessionId}:${key.generation}`;
}

export class SetupUiSessionStore {
  private readonly states = new Map<string, SetupUiSessionState>();

  /** Never throws - a key this store has never seen an update() for
   * returns a fresh default state rather than an error. */
  getState(key: SetupUiSessionKey): SetupUiSessionState {
    return this.states.get(serializeKey(key)) ?? defaultState();
  }

  update(key: SetupUiSessionKey, patch: Partial<SetupUiSessionState>): void {
    const serialized = serializeKey(key);
    const current = this.states.get(serialized) ?? defaultState();
    this.states.set(serialized, {...current, ...patch});
  }
}

export const setupUiSessionStore = new SetupUiSessionStore();
