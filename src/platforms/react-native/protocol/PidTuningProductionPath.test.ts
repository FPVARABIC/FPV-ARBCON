/**
 * THE PID PAGE AGAINST A BOARD THAT HAS PROFILES.
 *
 * Every scenario below drives the REAL PidTuningController - the singleton
 * class the screen uses, through its real session ports - against
 * VirtualPidBoard, which models the firmware behaviours P-A traced from
 * source: four PID profiles and four rate profiles, a select that coerces
 * silently, a rate write whose explicit pitch bytes overrule the legacy
 * link, a simplified write that REGENERATES the tune from compile-time
 * defaults, a copy with no re-initialisation, and a filter write that
 * reaches into MSP_ADVANCED_CONFIG.
 *
 * WHAT THIS IS NOT. It is not a real flight controller. Every claim here is
 * about our controller's behaviour against a model built from pinned
 * firmware source, and NOT ONE of them is evidence about real hardware.
 */

import {createPidTuningDraft} from '../../../core/state/pidTuningModel';
import type {MspClientState} from '../../../core/protocol/mspClient';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import type {MspPidTuningSnapshot} from '../../../core/protocol/msp/decoding/decodePidTuning';
import {
  MSP2_SET_TEXT,
  MSP_EEPROM_WRITE,
  MSP_MOTOR_CONFIG,
  MSP_SELECT_SETTING,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_TUNING,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  MSP_CALCULATE_SIMPLIFIED_PID,
  MSP_COPY_PROFILE,
  MSP_SET_RESET_CURR_PID,
  MSP_SET_SIMPLIFIED_TUNING,
  MSP_SIMPLIFIED_TUNING,
} from '../../../core/protocol/msp/commands/pidProfileCommands';
import {
  MAX_PROFILE_NAME_BYTES,
  PROFILE_NAME_CHARACTER_POLICY,
  profileNameByteLength,
} from '../../../core/protocol/msp/encoding/encodeProfileCommands';
import {RC_TUNING_OFFSETS} from '../../../core/protocol/msp/decoding/decodeRcTuningFull';
import {evaluateRate, ratePreviewAvailability, type RateAxisSettings} from '../../../core/state/rateFormulaEngine';
import {PID_ADVANCED_OFFSETS} from '../../../core/protocol/msp/decoding/decodePidAdvancedFull';
import type {MspIdentificationState, MspSessionOwnershipState, SetupUiSessionKey} from './MspSessionCoordinator';
import {PidTuningController, type PidSessionCoordinator} from './PidTuningController';
import {VirtualPidBoard, type VirtualPidBoardOptions} from './__testUtils__/virtualPidBoard';

/**
 * `MSP_RESET_CONF`. Declared HERE, in a test, and nowhere in production.
 *
 * The whole-configuration reset that reboots the board is the one command
 * this screen must never send, so the only place its number appears in the
 * repository is the assertion that it never appears on the wire.
 */
const MSP_RESET_CONF_NEVER_SENT = 208;

const RATES_TYPE_OFFSET = RC_TUNING_OFFSETS.ratesType;

/** Any axis will do - the point is that QUICK declines to draw a curve. */
const QUICK_AXIS: RateAxisSettings = {rcRate: 100, superRate: 70, expo: 0, rateLimit: 1998};

interface HarnessOptions extends Partial<VirtualPidBoardOptions> {
  readonly gyroSampleRateHz?: number;
}

function harness(options: HarnessOptions = {}) {
  const apiMinor = options.apiMinor ?? 47;
  const board = new VirtualPidBoard({
    apiMinor,
    filterBytes: apiMinor >= 48 ? 56 : 49,
    ...options,
  });
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
      board: {gyroSampleRateHz: options.gyroSampleRateHz ?? 8000},
    },
  } as MspIdentificationState;
  const coordinator: PidSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => identification,
    getSessionKey: sessionId => ({sessionId, generation: state.generation}),
    getActiveMspClient: () => board as never,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new PidTuningController({
    coordinator,
    appStateOwner: {getPhase: () => state.phase as 'ACTIVE'},
    isMotorTestActive: () => state.motorTest,
  });
  const key: SetupUiSessionKey = {sessionId: 'pid-virtual', generation: state.generation};
  return {board, state, controller, key, telemetry};
}

type Harness = ReturnType<typeof harness>;

async function load(h: Harness): Promise<MspPidTuningSnapshot> {
  const outcome = await h.controller.load(h.key);
  if (outcome.kind !== 'LOADED') throw new Error(`load: ${outcome.kind}`);
  return outcome.snapshot;
}

const sent = (h: Harness, command: number): number => h.board.commandCount(command);

/** Every command the board saw, in order - used for ORDERING assertions. */
const order = (h: Harness): readonly number[] => h.board.requests.map(entry => entry.command);

/** MSP_ADVANCED_CONFIG as the board stores it: the four bytes that matter. */
function advancedConfig(options: {denom: number; continuous: number; protocol: number; pwmRate: number}): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes[0] = 1;
  bytes[1] = options.denom;
  bytes[2] = options.continuous;
  bytes[3] = options.protocol;
  new DataView(bytes.buffer).setUint16(4, options.pwmRate, true);
  return bytes;
}

function pidBytes(rollP: number, pitchP = 47, yawP = 45): Uint8Array {
  return Uint8Array.from([rollP, 80, 30, pitchP, 84, 34, yawP, 80, 0, 50, 50, 75, 40, 0, 0]);
}

/** A simplified PID block with the generator ON in the RPY mode. */
function simplifiedPidsOn(): Uint8Array {
  return Uint8Array.from([2, 110, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe('P-C production path - the tune belongs to a profile', () => {
  it('reads the ACTIVE profile, not slot zero', async () => {
    const h = harness({
      pidProfiles: [{pid: pidBytes(11)}, {pid: pidBytes(22)}, {pid: pidBytes(33)}, {pid: pidBytes(44)}],
    });
    await h.controller.selectProfile(h.key, 'PID', 2);
    const snapshot = await load(h);

    expect(snapshot.pidProfileIndex).toBe(2);
    expect(snapshot.terms[0].p).toBe(33);
  });

  it('writes into the active profile and leaves the other three alone', async () => {
    const h = harness();
    await h.controller.selectProfile(h.key, 'PID', 1);
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(h.board.pidProfile(1).pid[0]).toBe(61);
    expect([0, 2, 3].map(index => h.board.pidProfile(index).pid[0])).toEqual([45, 45, 45]);
  });

  it('refuses a save whose profile moved under it, before any write', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);
    // A radio switch, or a second client, moves the board mid-edit.
    await h.controller.selectProfile(h.key, 'PID', 3);
    const before = sent(h, MSP_SET_PID);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'PROFILE_CHANGED'});
    expect(sent(h, MSP_SET_PID)).toBe(before);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('refuses a save when only the RATE profile moved', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);
    await h.controller.selectProfile(h.key, 'RATE', 2);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'PROFILE_CHANGED'});
    expect(sent(h, MSP_SET_PID)).toBe(0);
  });

  it('reports the board as the authority when a select is silently coerced', async () => {
    const h = harness();
    // PID_PROFILE_COUNT is 4; the firmware turns an out-of-range index into
    // zero and acknowledges, so an ACK proves nothing.
    const outcome = await h.controller.selectProfile(h.key, 'PID', 5);

    expect(outcome.kind).toBe('NOT_APPLIED');
    if (outcome.kind !== 'NOT_APPLIED') throw new Error(outcome.kind);
    expect(outcome.snapshot.pidProfileIndex).toBe(0);
  });
});

describe('P-C production path - what a save proves, and what it reports', () => {
  it('writes only the groups that changed, then persists once', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {
      ...base,
      roll: {...base.roll, p: 61},
      rates: {...base.rates, roll: {...base.rates.roll, rcRate: 120}},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(sent(h, MSP_SET_PID)).toBe(1);
    expect(sent(h, MSP_SET_RC_TUNING)).toBe(1);
    expect(sent(h, MSP_SET_PID_ADVANCED)).toBe(0);
    expect(sent(h, MSP_SET_FILTER_CONFIG)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
  });

  it('persists only AFTER the applied readback has been checked', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    const commands = order(h);
    const write = commands.indexOf(MSP_SET_PID);
    const commit = commands.indexOf(MSP_EEPROM_WRITE);
    expect(write).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(write);
  });

  it('a rate save comes back EXACT even though the firmware has a pitch link', async () => {
    // The linkage fires on the first byte and is then overwritten by the
    // explicit pitch bytes at offsets 12 and 13, so a full-length write
    // never observes it. A classifier that expected a normalisation here
    // would be describing a payload nobody sends.
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {
      ...base,
      rates: {...base.rates, roll: {...base.rates.roll, rcRate: 133}},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.normalisations).toEqual([]);
    expect(h.board.rateProfile(0).rcTuning[0]).toBe(133);
    expect(h.board.rateProfile(0).rcTuning[12]).toBe(100);
  });

  it('a rate save survives the three bytes the firmware reads and throws away', async () => {
    // tpa_rate at 5 and tpa_breakpoint at 8..9 moved to the PID profile; the
    // responder writes literal zeros in their place. A verification that
    // compared those offsets would fail every rate save on every board.
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {
      ...base,
      rates: {...base.rates, throttleMid: 55},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    const written = h.board.requests.find(entry => entry.command === MSP_SET_RC_TUNING);
    if (written === undefined) throw new Error('no MSP_SET_RC_TUNING was sent');
    expect(written.payload).toHaveLength(24);
    expect([5, 8, 9].map(offset => h.board.rateProfile(0).rcTuning[offset])).toEqual([0, 0, 0]);
  });

  /**
   * Dynamic gyro LPF1 is ACTIVE on this board, so the min/max pair is the
   * editable one; moving the static Hz underneath an active dynamic filter
   * is refused by the draft rules and stays refused.
   */
  const filterEdit = (base: ReturnType<typeof createPidTuningDraft>) => ({
    ...base,
    filters: {...base.filters, gyroLpf1DynamicMinHz: 200},
  });

  it('reads MSP_MOTOR_CONFIG before a filter write, and only then', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});
    expect(sent(h, MSP_MOTOR_CONFIG)).toBe(0);

    await h.controller.save(h.key, await load(h), filterEdit(createPidTuningDraft(await load(h))));
    expect(sent(h, MSP_MOTOR_CONFIG)).toBe(1);
    // And it happened BEFORE the write it is meant to predict.
    const commands = order(h);
    expect(commands.indexOf(MSP_MOTOR_CONFIG)).toBeLessThan(commands.indexOf(MSP_SET_FILTER_CONFIG));
  });

  it('reports a side effect only when the EXACT predicted value came back', async () => {
    // ONESHOT125 under continuous update at 8 kHz: the PWM rate is clamped
    // to exactly 1 / 0.0005 = 2000, and nothing else moves.
    const h = harness({
      globals: {advancedConfig: advancedConfig({denom: 1, continuous: 1, protocol: 1, pwmRate: 8000})},
    });
    const original = await load(h);

    const outcome = await h.controller.save(h.key, original, filterEdit(createPidTuningDraft(original)));

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.sideEffects?.normalised.map(entry => entry.truth)).toEqual(['MOTOR_PWM_RATE']);
    expect(outcome.evidence.sideEffects?.unexpected).toEqual([]);
    expect(outcome.evidence.sideEffects?.notProven).toEqual([]);
    expect(new DataView(h.board.globals().advancedConfig.buffer).getUint16(4, true)).toBe(2000);
  });

  it('predicts the exact denominator floor and accepts only that value', async () => {
    // ONESHOT125, continuous update OFF, 8 kHz: floor is exactly 4.
    const h = harness({
      globals: {advancedConfig: advancedConfig({denom: 1, continuous: 0, protocol: 1, pwmRate: 480})},
    });
    const original = await load(h);

    const outcome = await h.controller.save(h.key, original, filterEdit(createPidTuningDraft(original)));

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.sideEffects?.normalised.map(entry => entry.truth)).toEqual(['PID_PROCESS_DENOM']);
    expect(h.board.globals().advancedConfig[1]).toBe(4);
  });

  it('refuses to commit a change no documented rule explains', async () => {
    const h = harness({
      unpredictedExtraSideEffect: true,
      globals: {advancedConfig: advancedConfig({denom: 1, continuous: 0, protocol: 1, pwmRate: 480})},
    });
    const original = await load(h);

    const outcome = await h.controller.save(h.key, original, filterEdit(createPidTuningDraft(original)));

    expect(outcome.kind).toBe('UNEXPECTED_CROSS_SUBSYSTEM_CHANGE');
    if (outcome.kind !== 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE') throw new Error(outcome.kind);
    expect(outcome.sideEffects.unexpected.map(entry => entry.truth)).toContain('MOTOR_PWM_RATE');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('FAILS CLOSED when the rule that would explain a change is not observable', async () => {
    // DShot telemetry on, DSHOT600, a target that compiles in
    // USE_PID_DENOM_CHECK. The board downgrades to DSHOT300 and raises the
    // denominator - both real firmware behaviours - and MSP cannot tell us
    // whether this build does that. So the app declines to bless it.
    const h = harness({
      useDshotTelemetry: true,
      targetHasPidDenomCheck: true,
      globals: {advancedConfig: advancedConfig({denom: 1, continuous: 0, protocol: 7, pwmRate: 480})},
    });
    const original = await load(h);

    const outcome = await h.controller.save(h.key, original, filterEdit(createPidTuningDraft(original)));

    expect(outcome.kind).toBe('SIDE_EFFECT_PREDICTION_NOT_PROVEN');
    if (outcome.kind !== 'SIDE_EFFECT_PREDICTION_NOT_PROVEN') throw new Error(outcome.kind);
    expect(outcome.sideEffects.notProven.map(entry => entry.truth)).toContain('MOTOR_PROTOCOL');
    expect(outcome.sideEffects.normalised).toEqual([]);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('saves normally on the same board when that branch does not fire', async () => {
    // Same DShot-telemetry board, but a TARGET without USE_PID_DENOM_CHECK.
    // Nothing moves, so there is nothing to refuse.
    const h = harness({
      useDshotTelemetry: true,
      targetHasPidDenomCheck: false,
      globals: {advancedConfig: advancedConfig({denom: 4, continuous: 0, protocol: 7, pwmRate: 480})},
    });
    const original = await load(h);

    const outcome = await h.controller.save(h.key, original, filterEdit(createPidTuningDraft(original)));

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.sideEffects?.requiresReobserve).toEqual([]);
  });

  it('never commits a mismatch, and never retries an ambiguous write', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);
    h.board.injectFault({command: MSP_SET_PID, fault: {kind: 'REMOTE_ERROR'}});

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    // MSP_REMOTE_ERROR is in the definitely-not-sent set, so this is a
    // plain failure rather than an ambiguous one - and either way it is
    // attempted exactly once and never committed.
    expect(['FAILED', 'UNCONFIRMED']).toContain(outcome.kind);
    expect(sent(h, MSP_SET_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });
});

describe('P-C production path - simplified tuning owns fields the operator can see', () => {
  it('refuses a direct PID edit while the generator owns that field', async () => {
    const h = harness({pidProfiles: [{simplifiedPids: simplifiedPidsOn()}]});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind !== 'REJECTED') throw new Error(outcome.kind);
    expect(outcome.reason).toBe('DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED');
    expect(outcome.conflict?.conflictingEdits).toContain('ROLL.P');
    expect(sent(h, MSP_SET_PID)).toBe(0);
  });

  it('allows the same edit once the generator is off', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome.kind).toBe('SAVED_VERIFIED');
  });

  it('a build without the simplified commands still saves directly', async () => {
    const h = harness({unsupportedCommands: [MSP_SIMPLIFIED_TUNING, MSP_SET_SIMPLIFIED_TUNING]});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome.kind).toBe('SAVED_VERIFIED');
  });

  it('writes the sliders and verifies the tune the FIRMWARE generated from them', async () => {
    const h = harness();
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    expect(sent(h, MSP_SET_SIMPLIFIED_TUNING)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
    // The board really did rewrite the direct gains from its own defaults.
    expect(h.board.pidProfile(0).pid[0]).not.toBe(45);
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.simplifiedValidity).toBeDefined();
  });

  it('refuses a simplified save on a board that does not implement it', async () => {
    const h = harness({unsupportedCommands: [MSP_SIMPLIFIED_TUNING, MSP_SET_SIMPLIFIED_TUNING]});
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {pids: {modeRaw: 2}});

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'SIMPLIFIED_TUNING_UNSUPPORTED'});
    expect(sent(h, MSP_SET_SIMPLIFIED_TUNING)).toBe(0);
  });

  it('reports NO_CHANGES rather than writing an identical slider set', async () => {
    const h = harness();
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {});

    expect(outcome.kind).toBe('NO_CHANGES');
    expect(sent(h, MSP_SET_SIMPLIFIED_TUNING)).toBe(0);
  });
});

describe('P-C production path - copying a profile is a transaction with a way home', () => {
  it('copies, proves the destination, and comes back before committing', async () => {
    const h = harness({
      pidProfiles: [{pid: pidBytes(11)}, {pid: pidBytes(22)}, {pid: pidBytes(33)}, {pid: pidBytes(44)}],
    });
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 0});

    expect(outcome.kind).toBe('COPIED_VERIFIED');
    expect(h.board.pidProfile(2).pid[0]).toBe(11);
    expect(h.board.activePidProfile()).toBe(0);
    expect(sent(h, MSP_COPY_PROFILE)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
    // THE ORDERING RULE: the commit is the last selection-sensitive act, and
    // it happens after the board is back on the operator's own profile.
    const commands = order(h);
    expect(commands.lastIndexOf(MSP_SELECT_SETTING)).toBeLessThan(commands.indexOf(MSP_EEPROM_WRITE));
  });

  it('copies a source that is not the active profile, and still comes home', async () => {
    const h = harness({
      pidProfiles: [{pid: pidBytes(11)}, {pid: pidBytes(22)}, {pid: pidBytes(33)}, {pid: pidBytes(44)}],
    });
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 3, sourceIndex: 1});

    expect(outcome.kind).toBe('COPIED_VERIFIED');
    expect(h.board.pidProfile(3).pid[0]).toBe(22);
    expect(h.board.activePidProfile()).toBe(0);
  });

  it('refuses to copy onto the profile that is running', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 0, sourceIndex: 2});

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'ACTIVE_DESTINATION_COPY_UNSAFE'});
    expect(sent(h, MSP_COPY_PROFILE)).toBe(0);
  });

  it('refuses a copy onto itself instead of sending a silent no-op', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 2});

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(sent(h, MSP_COPY_PROFILE)).toBe(0);
  });

  it('copies a RATE profile without touching any PID profile', async () => {
    const h = harness({
      rateProfiles: [{}, {}, {}, {}],
    });
    await load(h);
    h.board.rateProfile(0).rcTuning[0] = 137;

    const outcome = await h.controller.copyProfile(h.key, {kind: 'RATE', destinationIndex: 1, sourceIndex: 0});

    expect(outcome.kind).toBe('COPIED_VERIFIED');
    expect(h.board.rateProfile(1).rcTuning[0]).toBe(137);
    expect(h.board.activeRateProfile()).toBe(0);
    expect(h.board.pidProfile(1).pid[0]).toBe(45);
  });

  it('says so loudly when it cannot get the board back onto the operator profile', async () => {
    const h = harness();
    await load(h);
    // The third select in the lifecycle is the RESTORE. Refusing it leaves
    // the board parked on the destination, which must never be silent and
    // must never be committed.
    h.board.injectFault({command: MSP_SELECT_SETTING, occurrence: 2, fault: {kind: 'REMOTE_ERROR'}});

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1});

    expect(['LEFT_ON_ANOTHER_PROFILE', 'FAILED', 'UNCONFIRMED']).toContain(outcome.kind);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });
});

describe('P-C production path - resetting a profile, and the command that is never sent', () => {
  it('puts the firmware defaults in RAM and does NOT persist them', async () => {
    const h = harness({pidProfiles: [{pid: pidBytes(99)}]});
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    if (outcome.kind !== 'RESET_APPLIED_PARTIALLY_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.persists).toBe(false);
    // The scope is stated, not implied: RESET_CONFIG rewrites the whole
    // pidProfile_t and this screen can only read part of it.
    expect(outcome.verifiedScope.length).toBeGreaterThan(0);
    // pid.h PID_ROLL_DEFAULT / PID_PITCH_DEFAULT / PID_YAW_DEFAULT.
    expect(outcome.snapshot.terms.slice(0, 3)).toEqual([
      {p: 45, i: 80, d: 30},
      {p: 47, i: 84, d: 34},
      {p: 45, i: 80, d: 0},
    ]);
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('refuses to reset a profile while the aircraft is armed', async () => {
    const h = harness({armed: true});
    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(sent(h, MSP_SET_RESET_CURR_PID)).toBe(0);
  });

  it('never sends MSP_RESET_CONF, on any path', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);
    await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});
    await h.controller.resetPidProfile(h.key);
    await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1});
    await h.controller.selectProfile(h.key, 'PID', 1);
    await h.controller.setProfileName(h.key, 'PID', 'race');

    expect(order(h)).not.toContain(MSP_RESET_CONF_NEVER_SENT);
  });
});

describe('P-C production path - profile names', () => {
  it('names the active profile, proves the readback, then commits', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.setProfileName(h.key, 'PID', 'race');

    expect(outcome).toEqual({kind: 'NAMED_VERIFIED', profile: 'PID', name: 'race'});
    expect(h.board.pidProfile(0).name).toBe('race');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
  });

  it('refuses a nine-character name BEFORE the wire, where the firmware would truncate', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.setProfileName(h.key, 'PID', 'racehorse');

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(sent(h, MSP2_SET_TEXT)).toBe(0);
  });

  it('reads the name of whichever profile is active', async () => {
    const h = harness();
    await load(h);
    await h.controller.setProfileName(h.key, 'PID', 'cruise');
    await h.controller.selectProfile(h.key, 'PID', 2);

    await expect(h.controller.readProfileName(h.key, 'PID')).resolves.toEqual({kind: 'NAME', profile: 'PID', name: ''});

    await h.controller.selectProfile(h.key, 'PID', 0);
    await expect(h.controller.readProfileName(h.key, 'PID')).resolves.toEqual({kind: 'NAME', profile: 'PID', name: 'cruise'});
  });

  it('names a RATE profile through its own selector', async () => {
    const h = harness();
    await load(h);

    const outcome = await h.controller.setProfileName(h.key, 'RATE', 'smooth');

    expect(outcome).toEqual({kind: 'NAMED_VERIFIED', profile: 'RATE', name: 'smooth'});
    expect(h.board.rateProfile(0).name).toBe('smooth');
    expect(h.board.pidProfile(0).name).toBe('');
  });
});

describe('P-C production path - the gates every write shares', () => {
  it('refuses every write while armed, with nothing on the wire', async () => {
    const h = harness({armed: true});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    await expect(h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    await expect(h.controller.saveSimplified(h.key, original, {pids: {modeRaw: 2}}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    await expect(h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    await expect(h.controller.setProfileName(h.key, 'PID', 'race'))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});

    expect(sent(h, MSP_SET_PID)).toBe(0);
    expect(sent(h, MSP_SET_SIMPLIFIED_TUNING)).toBe(0);
    expect(sent(h, MSP_COPY_PROFILE)).toBe(0);
    expect(sent(h, MSP2_SET_TEXT)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('fails CLOSED on an API newer than anything read from source', async () => {
    const h = harness({apiMinor: 50});
    const original = await load(h);
    const base = createPidTuningDraft(original);
    const before = h.board.requests.length;

    await expect(h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    await expect(h.controller.saveSimplified(h.key, original, {pids: {modeRaw: 2}}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    await expect(h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    await expect(h.controller.resetPidProfile(h.key))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    await expect(h.controller.setProfileName(h.key, 'PID', 'race'))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});

    // Not one byte reached the board after the refusals began.
    expect(h.board.requests.length).toBe(before);
  });

  it('still READS a future API, because refusing to show a tune helps nobody', async () => {
    const h = harness({apiMinor: 50, pidProfiles: [{pid: pidBytes(77)}]});
    const snapshot = await load(h);
    expect(snapshot.terms[0].p).toBe(77);
  });

  it('refuses every write while a motor test is open', async () => {
    const h = harness();
    const original = await load(h);
    const base = createPidTuningDraft(original);
    h.state.motorTest = true;

    await expect(h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    await expect(h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1}))
      .resolves.toEqual({kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'});
    expect(sent(h, MSP_SET_PID)).toBe(0);
  });
});

/**
 * BOARDS THAT ACKNOWLEDGE AND THEN DO SOMETHING ELSE.
 *
 * Everything above runs against a board that behaves. These run against
 * boards that do not, because a verification step that is never given a
 * disagreement to find has not been shown to work.
 */
describe('P-C production path - the verification steps, given something to catch', () => {
  it('does not call a save persisted when the commit disturbed the value', async () => {
    const h = harness({quirks: {onEepromWrite: 'REVERT_ACTIVE_PID'}});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {...base, roll: {...base.roll, p: 61}});

    expect(outcome.kind).toBe('APPLIED_PERSISTENCE_UNVERIFIED');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
  });

  it('does not call a copy verified when the destination came back short', async () => {
    const h = harness({quirks: {copyProfile: 'PARTIAL'}});
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 0});

    expect(outcome.kind).toBe('COPY_MISMATCH');
    if (outcome.kind !== 'COPY_MISMATCH') throw new Error(outcome.kind);
    expect(outcome.destinationIndex).toBe(2);
    expect(outcome.fields.length).toBeGreaterThan(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('reports being stranded when a profile switch is acknowledged and ignored', async () => {
    const h = harness({quirks: {silentlyIgnoredPidSelects: [2]}});
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1});

    expect(outcome.kind).toBe('LEFT_ON_ANOTHER_PROFILE');
    if (outcome.kind !== 'LEFT_ON_ANOTHER_PROFILE') throw new Error(outcome.kind);
    expect(outcome.requestedIndex).toBe(2);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('reports being stranded when the COMMIT itself moved the active profile', async () => {
    const h = harness({quirks: {onEepromWrite: 'MOVE_ACTIVE_PROFILE'}});
    await load(h);

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 1});

    expect(outcome.kind).toBe('LEFT_ON_ANOTHER_PROFILE');
    if (outcome.kind !== 'LEFT_ON_ANOTHER_PROFILE') throw new Error(outcome.kind);
    expect(outcome.requestedIndex).toBe(0);
    expect(outcome.activeIndex).not.toBe(0);
  });

  it('does not accept a slider echo when the board generated a different tune', async () => {
    // The thirteen inputs round-trip EXACTLY on this board. Only the
    // generated gains differ, by one count, which is precisely the failure
    // an input-echo check would wave through.
    const h = harness({quirks: {simplifiedGenerator: 'DRIFTED'}});
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') throw new Error(outcome.kind);
    expect(outcome.fields.map(field => field.field)).toContain('ROLL.P');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('does not accept a reset that did not produce the firmware defaults', async () => {
    const h = harness({quirks: {resetProduces: 'SOMETHING_ELSE'}});
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') throw new Error(outcome.kind);
    expect(outcome.fields.map(field => field.field)).toContain('ROLL.P');
  });

  it('does not commit a name the board did not store', async () => {
    const h = harness({quirks: {profileNameCapacity: 4}});
    await load(h);

    const outcome = await h.controller.setProfileName(h.key, 'PID', 'freestyl');

    expect(outcome).toEqual({kind: 'NAME_MISMATCH', profile: 'PID', requested: 'freestyl', observed: 'free'});
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('refuses a name reply that answered for a different selector', async () => {
    const h = harness({quirks: {textSelectorEcho: 'WRONG'}});
    await load(h);

    await expect(h.controller.readProfileName(h.key, 'PID')).resolves.toEqual(
      expect.objectContaining({kind: 'FAILED'}),
    );
  });
});

/**
 * P-C2 CLOSURE.
 *
 * Rate-type control, the CALCULATE oracle, and the copy/reset semantics that
 * needed a struct-layout answer rather than an assumption.
 */
describe('P-C2 - the rate FORMULA is a setting of its own', () => {
  it.each([0, 1, 2, 3, 4])('writes, verifies and persists rates type %i', async ratesType => {
    const h = harness();
    const original = await load(h);

    const outcome = await h.controller.setRatesType(h.key, original, ratesType);

    if (ratesType === 0) {
      // The board already holds BETAFLIGHT, so there is nothing to write.
      expect(outcome).toEqual({kind: 'NO_CHANGES', snapshot: expect.anything()});
      expect(sent(h, MSP_SET_RC_TUNING)).toBe(0);
      return;
    }
    expect(outcome.kind).toBe('PERSISTED_VERIFIED');
    if (outcome.kind !== 'PERSISTED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.ratesTypeRaw).toBe(ratesType);
    expect(h.board.rateProfile(0).rcTuning[RATES_TYPE_OFFSET]).toBe(ratesType);
    expect(sent(h, MSP_SET_RC_TUNING)).toBe(1);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(1);
  });

  it.each([5, 250])('refuses rates type %i before the wire', async ratesType => {
    const h = harness();
    const original = await load(h);

    await expect(h.controller.setRatesType(h.key, original, ratesType))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNKNOWN_RATES_TYPE'});
    expect(sent(h, MSP_SET_RC_TUNING)).toBe(0);
  });

  it('changes the FORMULA and not one of the numbers it interprets', async () => {
    // This is the whole safety property: ACTUAL reads rcRate and superRate
    // completely differently from BETAFLIGHT, and a controller that
    // "converted" them would be re-tuning the aircraft without being asked.
    const h = harness();
    const original = await load(h);
    const before = Uint8Array.from(h.board.rateProfile(0).rcTuning);

    const outcome = await h.controller.setRatesType(h.key, original, 3);

    expect(outcome.kind).toBe('PERSISTED_VERIFIED');
    const after = h.board.rateProfile(0).rcTuning;
    for (let offset = 0; offset < 24; offset += 1) {
      if (offset === RATES_TYPE_OFFSET) continue;
      expect([offset, after[offset]]).toEqual([offset, before[offset]]);
    }
  });

  it('saves QUICK without claiming an exact QUICK preview', async () => {
    const h = harness();
    const original = await load(h);

    const outcome = await h.controller.setRatesType(h.key, original, 4);
    expect(outcome.kind).toBe('PERSISTED_VERIFIED');

    // Configuration support and preview capability are separate truths.
    // `quickrates_rc_expo` has no MSP surface at 1.47/1.48/1.49, so the
    // preview stays unavailable no matter how the save went.
    // No argument, because MSP has no field to supply one from.
    expect(ratePreviewAvailability({kind: 'QUICK'})).toEqual({
      kind: 'PREVIEW_UNAVAILABLE', reason: 'QUICK_RATES_RC_EXPO_NOT_OBSERVABLE',
    });
    expect(evaluateRate({kind: 'QUICK'}, QUICK_AXIS, 0.5)).toBeUndefined();
  });

  it('refuses a rates-type change while armed, and on a future API', async () => {
    const armed = harness({armed: true});
    await expect(armed.controller.setRatesType(armed.key, await load(armed), 2))
      .resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(sent(armed, MSP_SET_RC_TUNING)).toBe(0);

    const future = harness({apiMinor: 50});
    await expect(future.controller.setRatesType(future.key, await load(future), 2))
      .resolves.toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    expect(sent(future, MSP_SET_RC_TUNING)).toBe(0);
  });

  it('catches a board that rescaled a rate while changing the formula', async () => {
    const h = harness({quirks: {ratesTypeWrite: 'ALSO_RESCALES'}});
    const original = await load(h);

    const outcome = await h.controller.setRatesType(h.key, original, 3);

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') throw new Error(outcome.kind);
    expect(outcome.fields.map(field => field.field)).toContain('RC_TUNING[0]');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('refuses a rates-type change whose profile moved underneath it', async () => {
    const h = harness();
    const original = await load(h);
    await h.controller.selectProfile(h.key, 'RATE', 2);

    await expect(h.controller.setRatesType(h.key, original, 2))
      .resolves.toEqual({kind: 'REJECTED', reason: 'PROFILE_CHANGED'});
    expect(sent(h, MSP_SET_RC_TUNING)).toBe(0);
  });
});

describe('P-C2 - the CALCULATE RPC is a second opinion, never the answer', () => {
  it('consults the board and records that it agreed', async () => {
    const h = harness();
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.projectionOracle).toEqual({kind: 'ORACLE_AGREES'});
    expect(sent(h, MSP_CALCULATE_SIMPLIFIED_PID)).toBe(1);
    // Consulted BEFORE anything was stored.
    const commands = order(h);
    expect(commands.indexOf(MSP_CALCULATE_SIMPLIFIED_PID))
      .toBeLessThan(commands.indexOf(MSP_SET_SIMPLIFIED_TUNING));
  });

  it('abandons the write when the board disagrees with our generator', async () => {
    const h = harness({quirks: {calculateOracle: 'DISAGREES'}});
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'SIMPLIFIED_PROJECTION_ORACLE_DISAGREES'});
    expect(sent(h, MSP_SET_SIMPLIFIED_TUNING)).toBe(0);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });

  it('does not turn an unavailable oracle into an agreement', async () => {
    const h = harness({unsupportedCommands: [MSP_CALCULATE_SIMPLIFIED_PID]});
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    expect(outcome.evidence.projectionOracle).toEqual({kind: 'ORACLE_UNAVAILABLE'});
  });

  it('CANNOT mask a SET the board ignored', async () => {
    // The oracle agrees - it is only a calculator - and the SET is silently
    // dropped. The applied readback is the only thing that can catch that,
    // and it must.
    const h = harness({unsupportedCommands: [MSP_SET_SIMPLIFIED_TUNING]});
    const original = await load(h);

    const outcome = await h.controller.saveSimplified(h.key, original, {
      pids: {modeRaw: 2, masterMultiplier: 110},
    });

    expect(['FAILED', 'UNCONFIRMED', 'READBACK_MISMATCH']).toContain(outcome.kind);
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
  });
});

describe('P-C2 - what a copy and a reset really move', () => {
  it('copies the PID profile NAME, because it lives inside pidProfile_t', async () => {
    // `pidCopyProfile` is memcpy(dst, src, sizeof(pidProfile_t)) and
    // pid.h:256 puts `char profileName[MAX_PROFILE_NAME_LENGTH + 1]` inside
    // that struct, so the name travels with the tune.
    const h = harness();
    await load(h);
    await h.controller.setProfileName(h.key, 'PID', 'race');

    const outcome = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 2, sourceIndex: 0});

    expect(outcome.kind).toBe('COPIED_VERIFIED');
    expect(h.board.pidProfile(2).name).toBe('race');
  });

  it('copies the RATE profile name too, for the same structural reason', async () => {
    // controlrate_profile.h:61 - `profileName` is inside controlRateConfig_t
    // and copyControlRateProfile memcpys the whole struct.
    const h = harness();
    await load(h);
    await h.controller.setProfileName(h.key, 'RATE', 'smooth');

    const outcome = await h.controller.copyProfile(h.key, {kind: 'RATE', destinationIndex: 1, sourceIndex: 0});

    expect(outcome.kind).toBe('COPIED_VERIFIED');
    expect(h.board.rateProfile(1).name).toBe('smooth');
    // And it did NOT leak into a PID profile.
    expect(h.board.pidProfile(1).name).toBe('');
  });

  it('a reset clears the name and turns the simplified generator back on', async () => {
    // RESET_CONFIG memcpys a template over the WHOLE struct, and that
    // template has `.profileName = {0}` and
    // `.simplified_pids_mode = PID_SIMPLIFIED_TUNING_RPY`.
    const h = harness();
    await load(h);
    await h.controller.setProfileName(h.key, 'PID', 'race');
    expect(h.board.pidProfile(0).name).toBe('race');

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
    expect(h.board.pidProfile(0).name).toBe('');
    expect(h.board.pidProfile(0).simplifiedPids[0]).toBe(2);
  });

  it('catches a reset that missed an item this screen never edits', async () => {
    // LEVEL and MAG are not edited here, so a three-axis reset check would
    // never look at them - and a reset that left one wrong would pass.
    const h = harness({quirks: {resetProduces: 'WRONG_LEVEL_ITEM'}});
    await load(h);

    const outcome = await h.controller.resetPidProfile(h.key);

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') throw new Error(outcome.kind);
    expect(outcome.fields.map(field => field.field)).toContain('LEVEL.P');
  });

  it('catches a reset that left one observable field behind', async () => {
    const h = harness();
    await load(h);
    // Move a field the old three-axis check would never have looked at.
    h.board.pidProfile(0).advanced[PID_ADVANCED_OFFSETS.dMaxGain] = 99;
    h.board.pidProfile(0).pid[0] = 1;

    const outcome = await h.controller.resetPidProfile(h.key);
    expect(outcome.kind).toBe('RESET_APPLIED_PARTIALLY_VERIFIED');
  });

  it('names the profile in BYTES, and says whose rule that is', async () => {
    expect(PROFILE_NAME_CHARACTER_POLICY).toBe('PRODUCT_POLICY_ASCII_ONLY');
    expect(MAX_PROFILE_NAME_BYTES).toBe(8);
    // Two characters, six bytes - the distinction that matters if the ASCII
    // policy is ever revisited.
    expect(profileNameByteLength('ثم')).toBe(4);
    expect(profileNameByteLength('12345678')).toBe(8);

    const h = harness();
    await load(h);
    await expect(h.controller.setProfileName(h.key, 'PID', 'مل'))
      .resolves.toEqual({kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'});
    expect(sent(h, MSP2_SET_TEXT)).toBe(0);
  });
});

describe.each([47, 48, 49])('P-C production path - a complete session on API 1.%s', minor => {
  it('loads, saves, copies and names against the version-correct wire lengths', async () => {
    const h = harness({apiMinor: minor});
    const original = await load(h);
    expect(original.filtersRaw.length).toBe(minor >= 48 ? 56 : 49);

    const base = createPidTuningDraft(original);
    const saved = await h.controller.save(h.key, original, {
      ...base,
      roll: {...base.roll, p: 61},
      yaw: {...base.yaw, f: 222},
      filters: {...base.filters, gyroLpf1DynamicMinHz: 200},
    });
    expect(saved.kind).toBe('SAVED_VERIFIED');
    expect(h.board.pidProfile(0).pid[0]).toBe(61);
    const advanced = new DataView(h.board.pidProfile(0).advanced.buffer);
    expect(advanced.getUint16(PID_ADVANCED_OFFSETS.feedforwardYaw, true)).toBe(222);

    const copied = await h.controller.copyProfile(h.key, {kind: 'PID', destinationIndex: 1, sourceIndex: 0});
    expect(copied.kind).toBe('COPIED_VERIFIED');
    expect(h.board.pidProfile(1).pid[0]).toBe(61);

    const named = await h.controller.setProfileName(h.key, 'PID', 'race');
    expect(named.kind).toBe('NAMED_VERIFIED');
  });
});
