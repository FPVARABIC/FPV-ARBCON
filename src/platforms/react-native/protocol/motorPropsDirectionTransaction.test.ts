/**
 * M-F3D §9-§15 - PROPS IN / OUT IS A REAL SAVABLE CONFIGURATION.
 *
 * =====================================================================
 * WHAT THE PREVIOUS ROUND PROVED, AND WHY IT WAS NOT ENOUGH
 * =====================================================================
 *
 * M-F3 photographed a board whose stored props setting was already
 * «للخارج (معكوس)» and showed that the screen renders it, with every
 * expected-rotation arrow flipped to match. That is a rendering proof.
 * The M-F3D review was right that it says nothing about whether an
 * operator can CHANGE the setting and have it survive: a screen that
 * paints whatever the board reports would pass it unchanged.
 *
 * This file answers the question that one could not, over a board whose
 * reads come from state its own writes mutated:
 *
 *   observed IN -> draft OUT -> save -> the BOARD holds OUT -> and a
 *   reload of the same board reports OUT.
 *
 * and then the same journey back, because an asymmetric handler that only
 * knows how to set the flag - never clear it - passes a one-way test.
 *
 * =====================================================================
 * THE TRANSACTION THIS ASSERTS, FROM THE FIRMWARE'S OWN LAYOUT
 * =====================================================================
 *
 * MSP_MIXER_CONFIG (42) GET, msp.c @ Betaflight 79065c96:
 *     u8 mixerMode, u8 yawMotorsReversed
 * MSP_SET_MIXER_CONFIG (43) SET: the same two bytes.
 *
 * So the props flag CANNOT be written without also writing the mixer
 * mode byte beside it - MSP has no way to set one field of a pair. That
 * is the whole reason §14 exists, and why the assertion below is on the
 * BYTE: a props save must carry the mixer mode it just read, unchanged,
 * and must never let a stale or defaulted mode ride along and silently
 * reconfigure the aircraft.
 *
 * =====================================================================
 * PROPS IS NOT MOTOR DIRECTION (§15)
 * =====================================================================
 *
 * yaw_motors_reversed is a FLIGHT CONTROLLER configuration field: it
 * tells the mixer which way the aircraft's motors are expected to turn,
 * and flipping it changes what the app EXPECTS - never what any ESC
 * does. Physically reversing a motor is MSP2_SEND_DSHOT_COMMAND to the
 * ESC, which lives in a different transaction, a different screen
 * section, and a different test file entirely
 * (motorsDirectionProductionPath.test.tsx). The final block here pins
 * that separation on the wire: a props save emits no DShot command.
 *
 * NOT hardware evidence. The board is a parameter store with RAM, EEPROM
 * and an armed flag; the byte layouts on both sides of this wire are this
 * app's own codecs, pinned against the firmware by the encode/decode
 * suites. What is proven here is the transaction.
 */

import {
  MSP2_SEND_DSHOT_COMMAND,
  MSP_EEPROM_WRITE,
  MSP_MIXER_CONFIG,
  MSP_SET_MIXER_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeMixerConfig} from '../../../core/protocol/msp/decoding/decodeMixerConfig';
import {
  createMotorConfigurationDraft,
  type MotorConfigurationSnapshot,
} from '../../../core/state/motorConfigurationModel';
import {MotorConfigurationController} from './MotorConfigurationController';
import {
  DRONE_SPECS,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

/**
 * Betaflight `mixerMode_e` QUAD+ (2), NOT QUADX (3).
 *
 * DELIBERATELY NOT THE COMMON ONE. The factory fixture ships QUADX, and
 * an assertion that a props save preserved "3" is satisfied by any
 * implementation that hard-codes the usual value - a mutant that writes a
 * constant QUADX passes a QUADX test without doing anything right. The
 * board below is therefore set to QUAD+, which is still a real four-motor
 * mixer, so the preserved byte can only come from the fresh read.
 */
const MIXER_QUADP = 2;

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no drone spec ${key}`);
  return found;
}

interface Rig {
  readonly board: VirtualFlightController;
  readonly session: VirtualSession;
  readonly motors: MotorConfigurationController;
}

function rig(label: string): Rig {
  const parameters = new Map(buildFactoryBoard(spec('FREESTYLE')));
  // See MIXER_QUADP: the board holds a mixer mode the code cannot guess.
  parameters.set(MSP_MIXER_CONFIG, Uint8Array.from([MIXER_QUADP, 0]));
  const board = new VirtualFlightController({parameters});
  const session = new VirtualSession({
    sessionId: `props-${label}`,
    board,
    apiMinor: 47,
  });
  return {board, session, motors: new MotorConfigurationController(session.options)};
}

async function loadOrThrow(
  {motors, session}: Rig,
  label: string,
): Promise<MotorConfigurationSnapshot> {
  const outcome = await motors.load(session.sessionId);
  if (outcome.kind !== 'LOADED') {
    throw new Error(
      `${label}: expected LOADED, got ${outcome.kind}` +
        ('reason' in outcome ? ` (${outcome.reason})` : ''),
    );
  }
  return outcome.snapshot;
}

/** What the BOARD holds in EEPROM, decoded - not what the app is carrying. */
function persistedMixer(board: VirtualFlightController) {
  const bytes = board.readPersisted(MSP_MIXER_CONFIG);
  if (bytes === undefined) throw new Error('board has no mixer config');
  return decodeMixerConfig(bytes);
}

/** Every payload of `command` this board was asked to accept, in order. */
function payloadsOf(board: VirtualFlightController, command: number): Uint8Array[] {
  return board.requests
    .filter(request => request.command === command)
    .map(request => request.payload);
}

/** Index of the first request for `command` at or after `from`. */
function indexOf(
  board: VirtualFlightController,
  command: number,
  from = 0,
): number {
  for (let index = from; index < board.requests.length; index += 1) {
    if (board.requests[index].command === command) return index;
  }
  return -1;
}

/* ==================================================================== *
 * §10/§11/§12 - IN -> OUT, THROUGH THE WHOLE TRANSACTION
 * ==================================================================== */

describe('M-F3D §11 - saving props out is a real, verified transaction', () => {
  it('changes ONLY the props flag, and the board then holds it', async () => {
    const harness = rig('in-to-out');
    const {board, session, motors} = harness;

    // The starting truth, read from the board rather than assumed.
    const before = await loadOrThrow(harness, 'initial load');
    expect(before.mixer.mixerModeRaw).toBe(MIXER_QUADP);
    expect(before.mixer.yawMotorsReversedConfigured).toBe(false);
    expect(persistedMixer(board).mixerModeRaw).toBe(MIXER_QUADP);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(false);

    // §10: nothing has been written yet. A draft is not a write.
    const draft = {
      ...createMotorConfigurationDraft(before),
      yawMotorsReversed: true,
    };
    expect(payloadsOf(board, MSP_SET_MIXER_CONFIG)).toHaveLength(0);

    const saveFrom = board.requests.length;
    const outcome = await motors.save(session.sessionId, before, draft);

    expect(
      outcome.kind === 'SAVED_VERIFIED'
        ? 'SAVED_VERIFIED'
        : `${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`,
    ).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') return;

    /* ---- §14: the mixer BYTE survived, byte for byte ---- */
    const writes = payloadsOf(board, MSP_SET_MIXER_CONFIG);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(MIXER_QUADP);
    expect(writes[0][1]).toBe(1);

    /* ---- §11: fresh read BEFORE the write, EEPROM AFTER it, and a
           readback after that ---- */
    const freshRead = indexOf(board, MSP_MIXER_CONFIG, saveFrom);
    const write = indexOf(board, MSP_SET_MIXER_CONFIG, saveFrom);
    const eeprom = indexOf(board, MSP_EEPROM_WRITE, saveFrom);
    const readback = indexOf(board, MSP_MIXER_CONFIG, eeprom);
    expect(freshRead).toBeGreaterThanOrEqual(saveFrom);
    expect(write).toBeGreaterThan(freshRead);
    expect(eeprom).toBeGreaterThan(write);
    expect(readback).toBeGreaterThan(eeprom);

    /* ---- §12: the BOARD holds props out, with the mixer untouched ---- */
    expect(persistedMixer(board).mixerModeRaw).toBe(MIXER_QUADP);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(true);
    // And the outcome the screen is handed says the same thing.
    expect(outcome.snapshot.mixer.yawMotorsReversedConfigured).toBe(true);
    expect(outcome.snapshot.mixer.mixerModeRaw).toBe(MIXER_QUADP);

    /* ---- §12: a FRESH load of the same board reports out ---- */
    const after = await loadOrThrow(harness, 'reload');
    expect(after.mixer.yawMotorsReversedConfigured).toBe(true);
    expect(after.mixer.mixerModeRaw).toBe(MIXER_QUADP);

    /* ---- §15: this was a flight-controller setting, not an ESC one ---- */
    expect(payloadsOf(board, MSP2_SEND_DSHOT_COMMAND)).toHaveLength(0);
  });

  it('survives the power cycle it claims to survive', async () => {
    const harness = rig('persistence');
    const {board, session, motors} = harness;
    const before = await loadOrThrow(harness, 'initial load');

    await motors.save(session.sessionId, before, {
      ...createMotorConfigurationDraft(before),
      yawMotorsReversed: true,
    });

    // EEPROM, not RAM: the board is power-cycled and asked again. A save
    // that only reached RAM reports the old value here.
    board.powerCycle();
    const after = await loadOrThrow(harness, 'after power cycle');
    expect(after.mixer.yawMotorsReversedConfigured).toBe(true);
    expect(after.mixer.mixerModeRaw).toBe(MIXER_QUADP);
  });
});

/* ==================================================================== *
 * §13 - AND BACK AGAIN, WHICH IS A DIFFERENT CODE PATH
 * ==================================================================== */

describe('M-F3D §13 - props out -> props in is equally real', () => {
  it('clears the flag it once set, and still preserves the mixer', async () => {
    const harness = rig('out-to-in');
    const {board, session, motors} = harness;

    // Get the board to props OUT first, the same way an operator would.
    const first = await loadOrThrow(harness, 'initial load');
    const toOut = await motors.save(session.sessionId, first, {
      ...createMotorConfigurationDraft(first),
      yawMotorsReversed: true,
    });
    expect(toOut.kind).toBe('SAVED_VERIFIED');
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(true);

    // Now back to IN. An asymmetric handler that can only set the flag
    // fails here and passes every one-way test.
    const outNow = await loadOrThrow(harness, 'load at OUT');
    expect(outNow.mixer.yawMotorsReversedConfigured).toBe(true);

    const backFrom = board.requests.length;
    const toIn = await motors.save(session.sessionId, outNow, {
      ...createMotorConfigurationDraft(outNow),
      yawMotorsReversed: false,
    });
    expect(
      toIn.kind === 'SAVED_VERIFIED'
        ? 'SAVED_VERIFIED'
        : `${toIn.kind}${'reason' in toIn ? ` (${toIn.reason})` : ''}`,
    ).toBe('SAVED_VERIFIED');

    const writes = payloadsOf(board, MSP_SET_MIXER_CONFIG).slice(1);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(MIXER_QUADP);
    expect(writes[0][1]).toBe(0);
    expect(persistedMixer(board).mixerModeRaw).toBe(MIXER_QUADP);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(false);

    // EEPROM was committed for this direction too, not only the first one.
    expect(indexOf(board, MSP_EEPROM_WRITE, backFrom)).toBeGreaterThan(backFrom);
    expect(payloadsOf(board, MSP2_SEND_DSHOT_COMMAND)).toHaveLength(0);
  });
});

/* ==================================================================== *
 * §11 - NO WRITE AT ALL WHEN NOTHING CHANGED
 * ==================================================================== */

describe('M-F3D §11 - a save with no change writes nothing', () => {
  it('emits no mixer write and no EEPROM commit', async () => {
    const harness = rig('no-change');
    const {board, session, motors} = harness;
    const before = await loadOrThrow(harness, 'initial load');

    const from = board.requests.length;
    const outcome = await motors.save(
      session.sessionId,
      before,
      createMotorConfigurationDraft(before),
    );

    expect(outcome.kind).toBe('NO_CHANGES');
    expect(indexOf(board, MSP_SET_MIXER_CONFIG, from)).toBe(-1);
    expect(indexOf(board, MSP_EEPROM_WRITE, from)).toBe(-1);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(false);
  });
});

/* ==================================================================== *
 * §11 - A STALE BASE IS REFUSED, NOT OVERWRITTEN
 * ==================================================================== */

describe('M-F3D §11 - the fresh read is a guard, not a formality', () => {
  it('refuses a save whose base no longer matches the board', async () => {
    const harness = rig('stale-base');
    const {board, session, motors} = harness;
    const before = await loadOrThrow(harness, 'initial load');

    // Someone else - another screen, the CLI, a second operator - changed
    // the same field after this editor loaded its base.
    const other = await motors.save(session.sessionId, before, {
      ...createMotorConfigurationDraft(before),
      yawMotorsReversed: true,
    });
    expect(other.kind).toBe('SAVED_VERIFIED');

    // The stale editor now tries to save ITS OWN change - a real change
    // against the base it loaded, so the no-change short circuit does not
    // answer first and the fresh read is what refuses it.
    const from = board.requests.length;
    const stale = await motors.save(session.sessionId, before, {
      ...createMotorConfigurationDraft(before),
      yawMotorsReversed: true,
    });

    expect(stale.kind).toBe('REJECTED');
    if (stale.kind === 'REJECTED') {
      expect(stale.reason).toBe('STALE_BASE');
    }
    // Refused BEFORE the wire: no write, no EEPROM, board unchanged.
    expect(indexOf(board, MSP_SET_MIXER_CONFIG, from)).toBe(-1);
    expect(indexOf(board, MSP_EEPROM_WRITE, from)).toBe(-1);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(true);
  });
});

/* ==================================================================== *
 * §11 - AND NOT WHILE THE AIRCRAFT IS ARMED
 * ==================================================================== */

describe('M-F3D §11 - an armed aircraft is not reconfigured', () => {
  it('refuses the props save and writes nothing', async () => {
    const harness = rig('armed');
    const {board, session, motors} = harness;
    const before = await loadOrThrow(harness, 'initial load');

    board.setArmed(true);
    const from = board.requests.length;
    const outcome = await motors.save(session.sessionId, before, {
      ...createMotorConfigurationDraft(before),
      yawMotorsReversed: true,
    });

    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind === 'REJECTED') {
      expect(outcome.reason).toBe('FC_ARMED');
    }
    expect(indexOf(board, MSP_SET_MIXER_CONFIG, from)).toBe(-1);
    expect(indexOf(board, MSP_EEPROM_WRITE, from)).toBe(-1);
    expect(persistedMixer(board).yawMotorsReversedConfigured).toBe(false);
  });
});
