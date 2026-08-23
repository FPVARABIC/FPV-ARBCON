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
  MSP_SELECT_SETTING,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_TUNING,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  MSP_COPY_PROFILE,
  MSP_SET_RESET_CURR_PID,
  MSP_SET_SIMPLIFIED_TUNING,
  MSP_SIMPLIFIED_TUNING,
} from '../../../core/protocol/msp/commands/pidProfileCommands';
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

  it('reports the cross-subsystem truths a filter write moved, and still saves', async () => {
    const h = harness({filterWriteSideEffects: 'SOURCE_PREDICTED'});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {
      ...base,
      // Dynamic gyro LPF1 is ACTIVE on this board, so the min/max pair is
      // the editable one; moving the static Hz underneath an active dynamic
      // filter is refused by the draft rules and stays refused.
      filters: {...base.filters, gyroLpf1DynamicMinHz: 200},
    });

    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error(outcome.kind);
    const changed = outcome.evidence.sideEffects?.changes.map(entry => entry.truth) ?? [];
    expect(changed).toContain('PID_PROCESS_DENOM');
    expect(changed).toContain('MOTOR_PROTOCOL');
    expect(outcome.evidence.sideEffects?.unexpected).toEqual([]);
  });

  it('refuses to commit when a filter write moved something the source does not predict', async () => {
    const h = harness({filterWriteSideEffects: 'UNPREDICTED_EXTRA'});
    const original = await load(h);
    const base = createPidTuningDraft(original);

    const outcome = await h.controller.save(h.key, original, {
      ...base,
      filters: {...base.filters, gyroLpf1DynamicMinHz: 200},
    });

    expect(outcome.kind).toBe('UNEXPECTED_CROSS_SUBSYSTEM_CHANGE');
    if (outcome.kind !== 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE') throw new Error(outcome.kind);
    expect(outcome.sideEffects.unexpected.map(entry => entry.truth)).toContain('MOTOR_PWM_RATE');
    expect(sent(h, MSP_EEPROM_WRITE)).toBe(0);
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

    expect(outcome.kind).toBe('RESET_APPLIED_NOT_PERSISTED');
    if (outcome.kind !== 'RESET_APPLIED_NOT_PERSISTED') throw new Error(outcome.kind);
    expect(outcome.persists).toBe(false);
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
