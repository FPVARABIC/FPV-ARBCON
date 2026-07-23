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
    });

    store.update(KEY_A_GEN_2, {expandedDiagnosticSections: new Set(['esc'])});

    expect(store.getState(KEY_A).expandedDiagnosticSections).toEqual(new Set(['motors']));
    expect(store.getState(KEY_A_GEN_2).expandedDiagnosticSections).toEqual(new Set(['esc']));
  });
});
