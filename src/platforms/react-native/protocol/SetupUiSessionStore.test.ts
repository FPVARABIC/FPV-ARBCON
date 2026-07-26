import {SetupUiSessionStore, SETUP_UI_SESSION_HISTORY_LIMIT} from './SetupUiSessionStore';
import type {SetupUiSessionKey} from './MspSessionCoordinator';

const KEY_A: SetupUiSessionKey = {sessionId: 'session-1', generation: 1};
const KEY_A_GEN_2: SetupUiSessionKey = {sessionId: 'session-1', generation: 2};
const KEY_B: SetupUiSessionKey = {sessionId: 'session-2', generation: 1};

/**
 * Pass 7.7 note on the assertions below: WRITES still accept `Set` inputs
 * (ergonomic call sites), but the STORED/returned representation is now a
 * frozen, sorted plain array - the Pass 7.7 immutable-snapshot contract.
 * `Object.freeze(new Set(...))` was rejected deliberately: freezing a Set
 * does not stop add()/delete() from mutating its entries.
 */
describe('SetupUiSessionStore', () => {
  it('returns a fresh default state for a never-seen key, without throwing', () => {
    const store = new SetupUiSessionStore();

    const state = store.getState(KEY_A);

    expect(state).toEqual({
      expandedDiagnosticSections: [],
      dismissedAutoOpenIncidents: [],
      orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
      hasSeenOrientationResetHint: false,
    });
  });

  it('state persists across repeated getState() calls for the same key', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});
    const first = store.getState(KEY_A);
    const second = store.getState(KEY_A);

    expect(first).toEqual(second);
    expect(second.expandedDiagnosticSections).toEqual(['motors']);
  });

  it('update() merges a partial patch, leaving other fields untouched', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {orientationViewOffset: {rollDeg: 10, pitchDeg: 0, yawDeg: 0}});
    store.update(KEY_A, {dismissedAutoOpenIncidents: new Set(['incident-1'])});

    const state = store.getState(KEY_A);
    expect(state.orientationViewOffset).toEqual({rollDeg: 10, pitchDeg: 0, yawDeg: 0});
    expect(state.dismissedAutoOpenIncidents).toEqual(['incident-1']);
  });

  it('a different sessionId is independent state, even with the same generation number', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});
    store.update(KEY_B, {expandedDiagnosticSections: new Set(['receiver'])});

    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(['motors']);
    expect(store.getState(KEY_B).expandedDiagnosticSections).toEqual(['receiver']);
  });

  it('DIFFERENT generation values for the same sessionId produce genuinely independent state', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});

    // Same sessionId string as KEY_A, but a different generation - the
    // core guarantee this whole composite-key design depends on: a reused
    // sessionId must never inherit a previous activation's UI state.
    expect(store.getState(KEY_A_GEN_2)).toEqual({
      expandedDiagnosticSections: [],
      dismissedAutoOpenIncidents: [],
      orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
      hasSeenOrientationResetHint: false,
    });

    store.update(KEY_A_GEN_2, {expandedDiagnosticSections: new Set(['esc'])});

    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(['motors']);
    expect(store.getState(KEY_A_GEN_2).expandedDiagnosticSections).toEqual(['esc']);
  });

  describe('resetOrientationViewOffset()', () => {
    it('zeroes a non-zero offset', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {orientationViewOffset: {rollDeg: 12, pitchDeg: -6, yawDeg: 90}});

      store.resetOrientationViewOffset(KEY_A);

      expect(store.getState(KEY_A).orientationViewOffset).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    });

    it('leaves every other field of the same session untouched', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {
        orientationViewOffset: {rollDeg: 12, pitchDeg: -6, yawDeg: 90},
        expandedDiagnosticSections: new Set(['motors']),
        dismissedAutoOpenIncidents: new Set(['incident-1']),
      });

      store.resetOrientationViewOffset(KEY_A);

      const state = store.getState(KEY_A);
      expect(state.expandedDiagnosticSections).toEqual(['motors']);
      expect(state.dismissedAutoOpenIncidents).toEqual(['incident-1']);
    });

    it('never touches a different session (different sessionId or different generation)', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {orientationViewOffset: {rollDeg: 12, pitchDeg: -6, yawDeg: 90}});
      store.update(KEY_A_GEN_2, {orientationViewOffset: {rollDeg: 5, pitchDeg: 5, yawDeg: 5}});
      store.update(KEY_B, {orientationViewOffset: {rollDeg: 1, pitchDeg: 1, yawDeg: 1}});

      store.resetOrientationViewOffset(KEY_A);

      expect(store.getState(KEY_A_GEN_2).orientationViewOffset).toEqual({rollDeg: 5, pitchDeg: 5, yawDeg: 5});
      expect(store.getState(KEY_B).orientationViewOffset).toEqual({rollDeg: 1, pitchDeg: 1, yawDeg: 1});
    });

    it('is a no-op (still zero) when called on a never-seen key', () => {
      const store = new SetupUiSessionStore();

      store.resetOrientationViewOffset(KEY_A);

      expect(store.getState(KEY_A).orientationViewOffset).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    });
  });

  describe('hasSeenOrientationResetHint', () => {
    it('defaults to false for a never-seen key', () => {
      const store = new SetupUiSessionStore();
      expect(store.getState(KEY_A).hasSeenOrientationResetHint).toBe(false);
    });

    it('can be set via update() and persists across reads', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {hasSeenOrientationResetHint: true});
      expect(store.getState(KEY_A).hasSeenOrientationResetHint).toBe(true);
    });

    it('is independent per session key', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {hasSeenOrientationResetHint: true});
      expect(store.getState(KEY_A_GEN_2).hasSeenOrientationResetHint).toBe(false);
      expect(store.getState(KEY_B).hasSeenOrientationResetHint).toBe(false);
    });

    it('resetOrientationViewOffset() does not affect it', () => {
      const store = new SetupUiSessionStore();
      store.update(KEY_A, {hasSeenOrientationResetHint: true});
      store.resetOrientationViewOffset(KEY_A);
      expect(store.getState(KEY_A).hasSeenOrientationResetHint).toBe(true);
    });
  });
});

describe('SetupUiSessionStore - Pass 7.7 immutability, snapshot stability and bounded history', () => {
  it('returns the SAME frozen reference for repeated reads of a never-written key', () => {
    const store = new SetupUiSessionStore();
    const first = store.getState(KEY_A);
    const second = store.getState(KEY_A);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('returns the same reference while state is unchanged, and a NEW reference only after a real change', () => {
    const store = new SetupUiSessionStore();
    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});
    const afterWrite = store.getState(KEY_A);
    expect(store.getState(KEY_A)).toBe(afterWrite);

    // A no-op update (same values) must NOT churn the snapshot identity.
    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});
    expect(store.getState(KEY_A)).toBe(afterWrite);

    // A real change produces a new frozen snapshot.
    store.update(KEY_A, {hasSeenOrientationResetHint: true});
    const changed = store.getState(KEY_A);
    expect(changed).not.toBe(afterWrite);
    expect(changed.hasSeenOrientationResetHint).toBe(true);
  });

  it('every nested collection is genuinely immutable - mutating what a reader receives cannot change stored state', () => {
    const store = new SetupUiSessionStore();
    store.update(KEY_A, {
      expandedDiagnosticSections: new Set(['motors', 'esc']),
      dismissedAutoOpenIncidents: new Set(['incident-1']),
      orientationViewOffset: {rollDeg: 1, pitchDeg: 2, yawDeg: 3},
    });
    const snapshot = store.getState(KEY_A);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.expandedDiagnosticSections)).toBe(true);
    expect(Object.isFrozen(snapshot.dismissedAutoOpenIncidents)).toBe(true);
    expect(Object.isFrozen(snapshot.orientationViewOffset)).toBe(true);

    // Attempt to mutate every nested structure (non-strict mode silently
    // ignores writes to frozen objects, so assert stored state afterwards).
    try {
      (snapshot.expandedDiagnosticSections as string[]).push('injected');
    } catch {
      // frozen array in strict mode - equally acceptable
    }
    try {
      (snapshot.dismissedAutoOpenIncidents as string[]).push('injected');
    } catch {
      /* ignored */
    }
    try {
      (snapshot.orientationViewOffset as {rollDeg: number}).rollDeg = 999;
    } catch {
      /* ignored */
    }

    const after = store.getState(KEY_A);
    expect(after.expandedDiagnosticSections).toEqual(['esc', 'motors']);
    expect(after.dismissedAutoOpenIncidents).toEqual(['incident-1']);
    expect(after.orientationViewOffset).toEqual({rollDeg: 1, pitchDeg: 2, yawDeg: 3});
  });

  it('clones mutable input on ingress - mutating the caller\'s own Set afterwards cannot reach stored state', () => {
    const store = new SetupUiSessionStore();
    const callerSet = new Set(['motors']);
    store.update(KEY_A, {expandedDiagnosticSections: callerSet});
    callerSet.add('injected-later');
    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(['motors']);
  });

  it('old-generation state cannot leak into a new physical generation', () => {
    const store = new SetupUiSessionStore();
    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors']), hasSeenOrientationResetHint: true});
    expect(store.getState(KEY_A_GEN_2).expandedDiagnosticSections).toEqual([]);
    expect(store.getState(KEY_A_GEN_2).hasSeenOrientationResetHint).toBe(false);
  });

  it('evicts oldest TERMINAL generations deterministically and never evicts the current one', () => {
    const store = new SetupUiSessionStore();
    const total = SETUP_UI_SESSION_HISTORY_LIMIT + 3;
    for (let generation = 1; generation <= total; generation++) {
      store.update({sessionId: 'session-1', generation}, {hasSeenOrientationResetHint: true});
    }

    // Bound respected: newest (current) + at most LIMIT older entries.
    expect(store.entryCountFor('session-1')).toBe(SETUP_UI_SESSION_HISTORY_LIMIT + 1);
    // The CURRENT (highest) generation is always retained...
    expect(store.getState({sessionId: 'session-1', generation: total}).hasSeenOrientationResetHint).toBe(true);
    // ...and the oldest ones were evicted, deterministically oldest-first.
    expect(store.getState({sessionId: 'session-1', generation: 1}).hasSeenOrientationResetHint).toBe(false);
    expect(store.getState({sessionId: 'session-1', generation: 2}).hasSeenOrientationResetHint).toBe(false);
    expect(
      store.getState({sessionId: 'session-1', generation: total - 1}).hasSeenOrientationResetHint,
    ).toBe(true);
  });

  it('eviction is per sessionId - one device\'s history never evicts another\'s', () => {
    const store = new SetupUiSessionStore();
    store.update(KEY_B, {hasSeenOrientationResetHint: true});
    for (let generation = 1; generation <= SETUP_UI_SESSION_HISTORY_LIMIT + 3; generation++) {
      store.update({sessionId: 'session-1', generation}, {hasSeenOrientationResetHint: true});
    }
    expect(store.getState(KEY_B).hasSeenOrientationResetHint).toBe(true);
    expect(store.entryCountFor('session-2')).toBe(1);
  });
});
