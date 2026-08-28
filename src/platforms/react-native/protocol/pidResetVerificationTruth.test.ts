/**
 * RESET APPLIED IS NOT RESET FULLY VERIFIED.
 *
 * `resetPidProfile` used to answer with the static OBSERVABLE_RESET_SCOPE
 * constant, so a reset whose MSP2_GET_TEXT read had FAILED still told the
 * operator that "MSP2_GET_TEXT: the profile name" had been verified. The
 * reset itself was correct; the EVIDENCE was not. Same board state, same
 * single write, and yet:
 *
 *   name read succeeds -> READBACK_MISMATCH   fields ["profileName"]
 *   name read fails    -> RESET_APPLIED_PARTIALLY_VERIFIED, no fields,
 *                         and the name still listed as verified
 *
 * These tests hold the corrected contract: `verifiedScope` carries only
 * resources whose read actually answered on THIS reset, and everything
 * else is named in `verificationGaps` instead of being silently dropped.
 *
 * Every case runs the real PidTuningController against the real
 * VirtualPidBoard. None of them asserts on source text.
 */
import type {MspClientState} from '../../../core/protocol/mspClient';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import type {MspPidTuningSnapshot} from '../../../core/protocol/msp/decoding/decodePidTuning';
import {
  MSP2_GET_TEXT,
  MSP_EEPROM_WRITE,
  MSP_PID,
  MSP_REBOOT,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  MSP_SET_RESET_CURR_PID,
  MSP_SIMPLIFIED_TUNING,
} from '../../../core/protocol/msp/commands/pidProfileCommands';
import type {
  MspIdentificationState,
  MspSessionOwnershipState,
  SetupUiSessionKey,
} from './MspSessionCoordinator';
import {
  OBSERVABLE_RESET_SCOPE,
  PidTuningController,
  type PidSessionCoordinator,
} from './PidTuningController';
import {VirtualPidBoard} from './__testUtils__/virtualPidBoard';

/** `MSP_RESET_CONF` (208) wipes the whole configuration. Never ours. */
const MSP_RESET_CONF_NEVER_SENT = 208;

function harness(apiMinor = 47) {
  const board = new VirtualPidBoard({apiMinor, filterBytes: apiMinor >= 48 ? 56 : 49});
  /* The board the coordinator hands out, so a test can replace the FC
     underneath a mounted controller the way a cable swap does. */
  const live = {client: board as VirtualPidBoard};
  const state = {
    ownership: 'ACTIVE' as MspSessionOwnershipState,
    recovery: 'READY' as MspClientState,
    generation: 7,
    phase: 'ACTIVE' as 'ACTIVE' | 'BACKGROUND',
    motorTest: false,
  };
  const telemetry = {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
  const identification = {
    status: 'SUCCEEDED',
    identity: {
      firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: apiMinor},
      board: {gyroSampleRateHz: 8000},
    },
  } as MspIdentificationState;
  const coordinator: PidSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => identification,
    getSessionKey: sessionId => ({sessionId, generation: state.generation}),
    getActiveMspClient: () => live.client as never,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new PidTuningController({
    coordinator,
    appStateOwner: {getPhase: () => state.phase as 'ACTIVE'},
    isMotorTestActive: () => state.motorTest,
  });
  const key: SetupUiSessionKey = {sessionId: 'pid-reset-truth', generation: state.generation};
  return {board, live, state, controller, key};
}

type Harness = ReturnType<typeof harness>;

async function load(h: Harness): Promise<MspPidTuningSnapshot> {
  const outcome = await h.controller.load(h.key);
  if (outcome.kind !== 'LOADED') throw new Error(`load: ${outcome.kind}`);
  return outcome.snapshot;
}

const sent = (h: Harness, command: number): number => h.board.commandCount(command);

/** Reach into the board's own state - the same door the fixtures use. */
type BoardState = {
  activePid: number;
  pidProfiles: Array<{name: string; simplifiedPids: Uint8Array}>;
};
const boardState = (h: Harness): BoardState =>
  (h.board as never as {state: BoardState}).state;
const activeProfile = (h: Harness) => {
  const s = boardState(h);
  return s.pidProfiles[s.activePid];
};

/**
 * A BOARD WHOSE RESET DOES NOT CLEAR SOMETHING.
 *
 * The stock VirtualPidBoard replaces the whole profile on
 * MSP_SET_RESET_CURR_PID, so its name and simplified mode always come back
 * at their defaults and the two optional comparisons can never disagree.
 * That makes it useless for deciding whether a FAILED read is being
 * reported as agreement - both branches would pass for the wrong reason.
 *
 * This restores one field after the reset write and changes nothing else,
 * which is the only condition under which the omission is observable.
 */
function boardThatSurvivesReset(h: Harness, after: (h: Harness) => void): Harness {
  const board = h.board as never as {
    request: (c: number, p: Uint8Array, o: unknown) => Promise<unknown>;
  };
  const original = board.request.bind(board);
  board.request = async (command: number, payload: Uint8Array, options: unknown) => {
    const frame = await original(command, payload, options);
    if (command === MSP_SET_RESET_CURR_PID) after(h);
    return frame;
  };
  after(h);
  return h;
}

const keepName = (name: string) => (h: Harness): void => { activeProfile(h).name = name; };
/** `.simplified_pids_mode`, byte 0 of the simplified PID block. */
const keepSimplifiedMode = (mode: number) => (h: Harness): void => {
  activeProfile(h).simplifiedPids[0] = mode;
};

/** Reads a reset outcome without the caller having to narrow it by hand. */
const evidence = (outcome: unknown) => ({
  kind: (outcome as {kind: string}).kind,
  fields: ((outcome as {fields?: Array<{field: string}>}).fields ?? []).map(f => f.field),
  verifiedScope: (outcome as {verifiedScope?: readonly string[]}).verifiedScope ?? [],
  gapResources: ((outcome as {verificationGaps?: Array<{resource: string}>}).verificationGaps ?? [])
    .map(g => g.resource),
  gapReasons: ((outcome as {verificationGaps?: Array<{reason: string}>}).verificationGaps ?? [])
    .map(g => g.reason),
  persists: (outcome as {persists?: boolean}).persists,
});

/**
 * PROVES THE FAULT INJECTOR ACTUALLY FIRED.
 *
 * Without this the "read failed" cases would pass just as happily against
 * a board that answered normally, which is exactly how the first two
 * attempts at reproducing this defect fooled themselves.
 */
async function proveReadFails(h: Harness, command: number): Promise<void> {
  const before = sent(h, command);
  let threw = false;
  try {
    await (h.board as never as {
      request: (c: number, p: Uint8Array, o: unknown) => Promise<unknown>;
    }).request(command, new Uint8Array(0), {wireFormat: command === MSP2_GET_TEXT ? 'v2' : 'v1'});
  } catch { threw = true; }
  if (!threw) throw new Error(`fault injector for command ${command} did not fire`);
  if (sent(h, command) <= before) throw new Error(`command ${command} was never attempted`);
}

describe('PID reset verification truth - capability and result stay separable', () => {
  /*
   * OBSERVABLE_RESET_SCOPE survives the fix as a CAPABILITY statement - what
   * this build's reader can attempt - and it is deliberately no longer
   * returned as a result. That leaves it with no production consumer, so
   * this is the guard that keeps it honest: add a resource the reset can
   * observe without describing it there, and this fails.
   */
  it('the capability statement describes exactly the resources a reset can observe', async () => {
    const h = harness();
    await load(h);
    const outcome = await h.controller.resetPidProfile(h.key);
    const seen = evidence(outcome);
    const attempted = [...seen.verifiedScope, ...seen.gapResources];

    expect(OBSERVABLE_RESET_SCOPE).toHaveLength(attempted.length);
    /* And it must never be the answer itself - the sentences it holds are
       not resource identifiers, so they can never satisfy verifiedScope. */
    for (const entry of OBSERVABLE_RESET_SCOPE) {
      expect(attempted).not.toContain(entry);
    }
  });
});

describe('PID reset verification truth - the profile name', () => {
  it('reports a mismatch when the name read SUCCEEDS and the name is wrong', async () => {
    const h = boardThatSurvivesReset(harness(), keepName('RACER'));
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(evidence(outcome)).toMatchObject({
      kind: 'READBACK_MISMATCH',
      fields: ['profileName'],
    });
    expect(activeProfile(h).name).toBe('RACER');
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('does NOT claim the name was verified when its read FAILED', async () => {
    const h = boardThatSurvivesReset(harness(), keepName('RACER'));
    await load(h);
    h.board.injectFault({command: MSP2_GET_TEXT, fault: {kind: 'REMOTE_ERROR'}});
    await proveReadFails(h, MSP2_GET_TEXT);

    const outcome = await h.controller.resetPidProfile(h.key);
    const seen = evidence(outcome);

    expect(seen.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    /* The claim the defect used to make. */
    expect(seen.verifiedScope).not.toContain('PROFILE_NAME');
    /* And the fact it used to hide. */
    expect(seen.gapResources).toContain('PROFILE_NAME');
    expect(seen.gapReasons).toEqual(['READ_FAILED']);
    /* A failed read is not a mismatch either - there is no observed value. */
    expect(seen.fields).toEqual([]);
    expect(seen.persists).toBe(false);
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });
});

describe('PID reset verification truth - simplified tuning', () => {
  it('reports a mismatch when the simplified read SUCCEEDS and the mode is wrong', async () => {
    /* PID_SIMPLIFIED_TUNING_RPY is 2; 1 is a different generator mode. */
    const h = boardThatSurvivesReset(harness(), keepSimplifiedMode(1));
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(evidence(outcome)).toMatchObject({
      kind: 'READBACK_MISMATCH',
      fields: ['simplifiedPidsMode'],
    });
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('does NOT claim simplified tuning was verified when its read FAILED', async () => {
    const h = harness();
    await load(h);
    h.board.injectFault({command: MSP_SIMPLIFIED_TUNING, fault: {kind: 'TIMEOUT'}});
    await proveReadFails(h, MSP_SIMPLIFIED_TUNING);

    const outcome = await h.controller.resetPidProfile(h.key);
    const seen = evidence(outcome);

    expect(seen.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    expect(seen.verifiedScope).not.toContain('SIMPLIFIED_TUNING');
    expect(seen.gapResources).toContain('SIMPLIFIED_TUNING');
    expect(seen.gapReasons).toEqual(['READ_FAILED']);
    /* No invented mode, so no mismatch derived from data nobody read. */
    expect(seen.fields).toEqual([]);
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  /*
   * THE CASE THAT IS DELIBERATELY NOT WRITTEN.
   *
   * An "explicitly unsupported" gap would need evidence that the board
   * lacks MSP_SIMPLIFIED_TUNING rather than merely failing to answer it.
   * This controller has none: support is inferred from whether the read
   * succeeds, and MSP2_GET_TEXT has no capability gate either. A test
   * asserting UNSUPPORTED would be asserting a guess, so the gap reason
   * stays at the one thing that is actually known - READ_FAILED.
   */
});

describe('PID reset verification truth - a healthy board', () => {
  it('verifies every resource it attempted and reports no gaps', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);
    const seen = evidence(outcome);

    expect(seen.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    expect([...seen.verifiedScope].sort()).toEqual([
      'FILTER_CONFIG', 'PID', 'PID_ADVANCED', 'PROFILE_NAME', 'SIMPLIFIED_TUNING',
    ]);
    expect(seen.gapResources).toEqual([]);
    expect(seen.fields).toEqual([]);
    /* PARTIALLY still: the firmware rewrites more of pidProfile_t than
       this screen can read, and that is unchanged by the fix. */
    expect(seen.persists).toBe(false);
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
    expect(sent(h, MSP_REBOOT)).toBe(0);
    expect(sent(h, MSP_RESET_CONF_NEVER_SENT)).toBe(0);
  });
});

describe('PID reset verification truth - the mandatory core snapshot', () => {
  it('does not fabricate partial verification when a core read fails', async () => {
    const h = harness();
    await load(h);
    /* MSP_PID is part of readSnapshot, which the reset needs whole. */
    h.board.injectFault({command: MSP_PID, fault: {kind: 'REMOTE_ERROR'}});
    await proveReadFails(h, MSP_PID);

    const outcome = await h.controller.resetPidProfile(h.key);
    const seen = evidence(outcome);

    expect(seen.kind).not.toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    expect(['FAILED', 'UNCONFIRMED', 'SESSION_ENDED']).toContain(seen.kind);
    /* Nothing claimed, nothing persisted, nothing rebooted. */
    expect(seen.verifiedScope).toEqual([]);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
    expect(sent(h, MSP_REBOOT)).toBe(0);
  });
});

describe('PID reset verification truth - safety is unchanged by the evidence fix', () => {
  it('an armed board is refused before any reset write', async () => {
    const h = harness();
    h.board.setArmed(true);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect((outcome as {kind: string}).kind).toBe('REJECTED');
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('a stale session generation cannot land a reset', async () => {
    const h = harness();
    await load(h);
    const stale: SetupUiSessionKey = {sessionId: h.key.sessionId, generation: h.key.generation - 1};

    const outcome = await h.controller.resetPidProfile(stale);

    expect((outcome as {kind: string}).kind).toBe('REJECTED');
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('a reset held over from FC A cannot land on FC B', async () => {
    /* The screen stays mounted while the board underneath is replaced: a
       new VirtualPidBoard AND a bumped physical generation, which is what a
       real cable swap produces. The old key must not reach the new board. */
    const h = harness();
    await load(h);
    const boardB = new VirtualPidBoard({apiMinor: 47, filterBytes: 49});
    const staleKey = {...h.key};
    h.live.client = boardB;
    h.state.generation += 1;

    const outcome = await h.controller.resetPidProfile(staleKey);

    expect((outcome as {kind: string}).kind).toBe('REJECTED');
    expect(boardB.commandCount(MSP_SET_RESET_CURR_PID)).toBe(0);
    expect(boardB.commandCount(MSP_EEPROM_WRITE)).toBe(0);
  });

  it('an unstudied API is refused before any reset write', async () => {
    const h = harness(50);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome).toMatchObject({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });
});
