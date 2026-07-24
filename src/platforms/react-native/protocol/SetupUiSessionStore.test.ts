import {SetupUiSessionStore} from './SetupUiSessionStore';
import type {SetupUiSessionKey} from './MspSessionCoordinator';

const KEY_A: SetupUiSessionKey = {sessionId: 'session-1', generation: 1};
const KEY_A_GEN_2: SetupUiSessionKey = {sessionId: 'session-1', generation: 2};
const KEY_B: SetupUiSessionKey = {sessionId: 'session-2', generation: 1};

describe('SetupUiSessionStore', () => {
  it('returns a fresh default state for a never-seen key, without throwing', () => {
    const store = new SetupUiSessionStore();

    const state = store.getState(KEY_A);

    expect(state).toEqual({
      expandedDiagnosticSections: new Set(),
      dismissedAutoOpenIncidents: new Set(),
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
    expect(second.expandedDiagnosticSections).toEqual(new Set(['motors']));
  });

  it('update() merges a partial patch, leaving other fields untouched', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {orientationViewOffset: {rollDeg: 10, pitchDeg: 0, yawDeg: 0}});
    store.update(KEY_A, {dismissedAutoOpenIncidents: new Set(['incident-1'])});

    const state = store.getState(KEY_A);
    expect(state.orientationViewOffset).toEqual({rollDeg: 10, pitchDeg: 0, yawDeg: 0});
    expect(state.dismissedAutoOpenIncidents).toEqual(new Set(['incident-1']));
  });

  it('a different sessionId is independent state, even with the same generation number', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});
    store.update(KEY_B, {expandedDiagnosticSections: new Set(['receiver'])});

    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(new Set(['motors']));
    expect(store.getState(KEY_B).expandedDiagnosticSections).toEqual(new Set(['receiver']));
  });

  it('DIFFERENT generation values for the same sessionId produce genuinely independent state', () => {
    const store = new SetupUiSessionStore();

    store.update(KEY_A, {expandedDiagnosticSections: new Set(['motors'])});

    // Same sessionId string as KEY_A, but a different generation - the
    // core guarantee this whole composite-key design depends on: a reused
    // sessionId must never inherit a previous activation's UI state.
    expect(store.getState(KEY_A_GEN_2)).toEqual({
      expandedDiagnosticSections: new Set(),
      dismissedAutoOpenIncidents: new Set(),
      orientationViewOffset: {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
      hasSeenOrientationResetHint: false,
    });

    store.update(KEY_A_GEN_2, {expandedDiagnosticSections: new Set(['esc'])});

    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(new Set(['motors']));
    expect(store.getState(KEY_A_GEN_2).expandedDiagnosticSections).toEqual(new Set(['esc']));
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
      expect(state.expandedDiagnosticSections).toEqual(new Set(['motors']));
      expect(state.dismissedAutoOpenIncidents).toEqual(new Set(['incident-1']));
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
