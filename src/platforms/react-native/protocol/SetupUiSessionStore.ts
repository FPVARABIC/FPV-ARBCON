/**
 * Pass 7.1 - pure UI-state storage for the Setup screen, keyed by
 * SetupUiSessionKey (see MspSessionCoordinator.ts's own doc comment on that
 * type) rather than by sessionId alone: a reused native sessionId string
 * must never let one physical session's UI state (which diagnostic sections
 * are expanded, which incidents were dismissed, the orientation-view
 * offset) leak into a different activation of that same id.
 *
 * A module-level singleton, mirroring MspSessionCoordinator's own
 * established precedent (see that file's class doc comment for why: no
 * React Context usage and no generic event-emitter/pub-sub pattern exists
 * elsewhere in this codebase for cross-cutting state).
 *
 * ==========================================================================
 * PASS 7.7 - IMMUTABLE SNAPSHOTS, ONE WRITER, BOUNDED HISTORY
 * ==========================================================================
 * CONFIRMED baseline defects (read from the Pass 7.6c source of this file,
 * not assumed):
 *
 *  1. LEAKED MUTABLE COLLECTIONS. getState() returned the STORED object,
 *     whose expandedDiagnosticSections/dismissedAutoOpenIncidents were live
 *     `Set` instances and whose orientationViewOffset was a live object -
 *     any reader could `getState(key).expandedDiagnosticSections.add(...)`
 *     and silently mutate stored state.
 *  2. UNSTABLE SNAPSHOT IDENTITY for unknown keys: every getState() of a
 *     never-written key built a brand-new defaultState() object, so
 *     repeated reads returned different references while nothing changed.
 *  3. UNBOUNDED GROWTH: the file's own doc comment acknowledged entries are
 *     "deliberately left uncollected" with no policy at all.
 *
 * The representation is now an actually-immutable snapshot: recursively
 * frozen plain objects with SORTED FROZEN ARRAYS instead of Sets.
 * `Object.freeze(new Set(...))` is deliberately NOT used - freezing a Set
 * does not make its internal entries immutable (add/delete still mutate
 * it), which is exactly the trap this representation avoids. Mutable input
 * collections are normalized/cloned on ingress, so a caller keeping a
 * reference to what it passed in cannot reach into stored state either.
 *
 * Snapshot identity: the SAME frozen object is returned for repeated reads
 * while the stored state is unchanged (including the shared EMPTY_STATE for
 * every never-written key), and a NEW frozen object appears only when an
 * update actually changes something - the referential-stability contract
 * useSyncExternalStore requires.
 *
 * Bounded history: at most SETUP_UI_SESSION_HISTORY_LIMIT terminal (older-
 * generation) entries are retained per sessionId, evicted oldest-generation
 * first and deterministically. The CURRENT (highest-generation) entry for a
 * sessionId is never evicted, so an ACTIVE/CLOSING session cannot lose its
 * own state; and because keys carry the generation, old state can never
 * leak into a new physical generation.
 */

import type {SetupUiSessionKey} from './MspSessionCoordinator';

export type SetupUiSessionState = {
  /** Sorted, frozen. Was a mutable Set before Pass 7.7. */
  readonly expandedDiagnosticSections: readonly string[];
  /** Sorted, frozen. Was a mutable Set before Pass 7.7. */
  readonly dismissedAutoOpenIncidents: readonly string[];
  readonly orientationViewOffset: {readonly rollDeg: number; readonly pitchDeg: number; readonly yawDeg: number};
  /** Pass 7.4, Step 5: has this session already seen the one-time hint
   * ("view only, does not calibrate FC sensors") the first time
   * "إعادة ضبط عرض الاتجاه" is pressed? */
  readonly hasSeenOrientationResetHint: boolean;
};

/** Named, documented finite bound on retained TERMINAL (older-generation)
 * entries per sessionId. Small on purpose: this state is a handful of UI
 * booleans/ids whose only reason to survive a generation change is a user
 * quickly re-plugging the same device. */
export const SETUP_UI_SESSION_HISTORY_LIMIT = 4;

function freezeState(state: {
  expandedDiagnosticSections: readonly string[];
  dismissedAutoOpenIncidents: readonly string[];
  orientationViewOffset: {rollDeg: number; pitchDeg: number; yawDeg: number};
  hasSeenOrientationResetHint: boolean;
}): SetupUiSessionState {
  return Object.freeze({
    expandedDiagnosticSections: Object.freeze([...state.expandedDiagnosticSections].sort()),
    dismissedAutoOpenIncidents: Object.freeze([...state.dismissedAutoOpenIncidents].sort()),
    orientationViewOffset: Object.freeze({...state.orientationViewOffset}),
    hasSeenOrientationResetHint: state.hasSeenOrientationResetHint,
  }) as SetupUiSessionState;
}

/** One shared frozen instance for every never-written key - repeated reads
 * of an unknown key must return the SAME reference (Pass 7.1's own
 * IDLE_IDENTIFICATION_STATE lesson, applied here). */
const EMPTY_STATE: SetupUiSessionState = freezeState({
  expandedDiagnosticSections: [],
  dismissedAutoOpenIncidents: [],
  orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
  hasSeenOrientationResetHint: false,
});

/** Accepts whatever a caller passes (array, Set, or nothing) and returns a
 * normalized plain array - cloned, so the caller's own collection is never
 * retained by this store. */
function normalizeIds(value: readonly string[] | ReadonlySet<string> | undefined, fallback: readonly string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  return Array.isArray(value) ? [...value] : [...(value as ReadonlySet<string>)];
}

/** Patch shape - accepts Sets for ergonomic call sites while the STORED
 * representation stays immutable arrays. */
export type SetupUiSessionStatePatch = {
  expandedDiagnosticSections?: readonly string[] | ReadonlySet<string>;
  dismissedAutoOpenIncidents?: readonly string[] | ReadonlySet<string>;
  orientationViewOffset?: {rollDeg: number; pitchDeg: number; yawDeg: number};
  hasSeenOrientationResetHint?: boolean;
};

/** Composite key serialization - a reused sessionId string with a
 * different generation must serialize to a different map key. generation
 * is a plain integer (see MspSessionCoordinator.ts), so ':' can never
 * appear inside either component and cannot cause two distinct keys to
 * collide on the same serialized string. */
function serializeKey(key: SetupUiSessionKey): string {
  return `${key.sessionId}:${key.generation}`;
}

function sameState(a: SetupUiSessionState, b: SetupUiSessionState): boolean {
  return (
    a.hasSeenOrientationResetHint === b.hasSeenOrientationResetHint &&
    a.orientationViewOffset.rollDeg === b.orientationViewOffset.rollDeg &&
    a.orientationViewOffset.pitchDeg === b.orientationViewOffset.pitchDeg &&
    a.orientationViewOffset.yawDeg === b.orientationViewOffset.yawDeg &&
    a.expandedDiagnosticSections.length === b.expandedDiagnosticSections.length &&
    a.expandedDiagnosticSections.every((id, index) => id === b.expandedDiagnosticSections[index]) &&
    a.dismissedAutoOpenIncidents.length === b.dismissedAutoOpenIncidents.length &&
    a.dismissedAutoOpenIncidents.every((id, index) => id === b.dismissedAutoOpenIncidents[index])
  );
}

export class SetupUiSessionStore {
  /** THE single writer surface is update()/resetOrientationViewOffset();
   * every other consumer is a reader of frozen snapshots. */
  private readonly states = new Map<string, SetupUiSessionState>();
  /** sessionId -> generations that have an entry, insertion-ordered, used
   * for the deterministic bounded eviction below. */
  private readonly generationsBySession = new Map<string, number[]>();

  /** Never throws - a key this store has never seen an update() for
   * returns the shared frozen empty state rather than an error, and
   * repeated calls return the SAME reference while nothing changes. */
  getState(key: SetupUiSessionKey): SetupUiSessionState {
    return this.states.get(serializeKey(key)) ?? EMPTY_STATE;
  }

  update(key: SetupUiSessionKey, patch: SetupUiSessionStatePatch): void {
    const serialized = serializeKey(key);
    const current = this.states.get(serialized) ?? EMPTY_STATE;
    const next = freezeState({
      expandedDiagnosticSections: normalizeIds(patch.expandedDiagnosticSections, current.expandedDiagnosticSections),
      dismissedAutoOpenIncidents: normalizeIds(patch.dismissedAutoOpenIncidents, current.dismissedAutoOpenIncidents),
      orientationViewOffset: patch.orientationViewOffset ?? {...current.orientationViewOffset},
      hasSeenOrientationResetHint: patch.hasSeenOrientationResetHint ?? current.hasSeenOrientationResetHint,
    });
    if (this.states.has(serialized) && sameState(current, next)) {
      return; // no real change: keep the existing snapshot reference stable
    }
    this.states.set(serialized, next);
    this.trackGeneration(key);
  }

  /** Pass 7.4: "إعادة ضبط عرض الاتجاه" - zeroes ONLY the local
   * orientation-view offset. Deliberately does not touch any other field
   * of this session's state, and (same as every other method here) never
   * talks to MspSessionCoordinator/MspClient - resetting the VIEW is not
   * an MSP command and must never be confused with FC sensor
   * calibration. */
  resetOrientationViewOffset(key: SetupUiSessionKey): void {
    this.update(key, {orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0}});
  }

  /** Diagnostic/test seam: how many entries exist for a sessionId. */
  entryCountFor(sessionId: string): number {
    return this.generationsBySession.get(sessionId)?.length ?? 0;
  }

  /** Records the generation and evicts oldest TERMINAL generations beyond
   * the bound. The highest generation seen for a sessionId is the current
   * one and is never evicted. */
  private trackGeneration(key: SetupUiSessionKey): void {
    const generations = this.generationsBySession.get(key.sessionId) ?? [];
    if (!generations.includes(key.generation)) {
      generations.push(key.generation);
    }
    generations.sort((a, b) => a - b);
    // Keep the newest (current) plus up to the bound of older terminal ones.
    while (generations.length > SETUP_UI_SESSION_HISTORY_LIMIT + 1) {
      const evicted = generations.shift();
      if (evicted !== undefined) {
        this.states.delete(`${key.sessionId}:${evicted}`);
      }
    }
    this.generationsBySession.set(key.sessionId, generations);
  }
}

export const setupUiSessionStore = new SetupUiSessionStore();
