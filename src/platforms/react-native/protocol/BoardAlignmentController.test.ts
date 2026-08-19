/**
 * BOARD ALIGNMENT, END TO END.
 *
 * The codec tests prove the bytes. This file proves the thing that
 * actually protects an operator: that the app never reports a mounting
 * angle as saved unless the board said so, and never writes one to an
 * aircraft that might be armed.
 *
 * Each case below is a way the feature could lie, written as the lie it
 * prevents:
 *
 *   NO_CHANGES         "saved!" after touching nothing - and a wasted
 *                      EEPROM erase cycle to go with it
 *   STALE_BASE         overwriting a value the board changed after the
 *                      screen was drawn
 *   FC_ARMED           writing mounting angles to a spinning aircraft
 *   FAILED             an outright refusal shown as success
 *   UNCONFIRMED        an unknown outcome shown as either success or
 *                      failure, when the honest answer is "unknown"
 *   SAVED_UNVERIFIED   a readback mismatch swallowed as success
 *   DISCONNECTED       a reply from before a reconnect credited to the
 *                      session on screen now
 *
 * AND ONE LIE OF OMISSION, which is the subtlest of them: reporting
 * "saved" for angles the board has STORED but is not yet FLYING on.
 * initBoardAlignment() runs only at boot (fc/init.c:713), so the restart
 * is part of the save, not a nicety - and the tests below assert its
 * position in the sequence, not merely that it happened.
 */

import type {
  MspClientState,
  MspRequestOptions,
} from '../../../core/protocol/mspClient';
import type {MspFrame} from '../../../core/protocol/mspTypes';
import type {MspTelemetryScheduler} from '../../../core/protocol/telemetry';
import {
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_BOXIDS,
  MSP_EEPROM_WRITE,
  MSP_REBOOT,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {encodeBoardAlignment} from '../../../core/protocol/msp/encoding/encodeBoardAlignment';
import type {MspBoardAlignmentSnapshot} from '../../../core/state/boardAlignmentModel';
import type {
  MspIdentificationState,
  MspSessionOwnershipState,
} from './MspSessionCoordinator';
import {
  BoardAlignmentController,
  type BoardAlignmentSessionCoordinator,
} from './BoardAlignmentController';

type Script = {payload: Uint8Array} | {reject: unknown};
const EMPTY = new Uint8Array(0);
const key = {sessionId: 'board-alignment-fc', generation: 7} as const;

const NEUTRAL: MspBoardAlignmentSnapshot = {
  rollDegrees: 0,
  pitchDegrees: 0,
  yawDegrees: 0,
};
/** A board mounted a quarter turn clockwise with a small roll trim. */
const ROTATED: MspBoardAlignmentSnapshot = {
  rollDegrees: 2,
  pitchDegrees: 0,
  yawDegrees: 90,
};

class FakeClient {
  readonly calls: Array<{
    command: number;
    payload: Uint8Array;
    options: MspRequestOptions;
  }> = [];
  private readonly scripts = new Map<number, Script[]>();
  private epoch = 1;
  getEpoch() {
    return this.epoch;
  }
  /** A timeout is a link event, not just a failed call: the real client
   *  bumps its epoch when it recovers, and the controller's ownership
   *  guards must survive that. */
  bumpEpoch() {
    this.epoch += 1;
  }
  enqueue(command: number, ...scripts: Script[]) {
    this.scripts.set(command, [
      ...(this.scripts.get(command) ?? []),
      ...scripts,
    ]);
  }
  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    const script = this.scripts.get(command)?.shift();
    if (script !== undefined && 'reject' in script) {
      if (
        typeof script.reject === 'object' &&
        script.reject !== null &&
        'code' in script.reject &&
        script.reject.code === 'MSP_TIMEOUT'
      ) {
        this.epoch += 1;
      }
      throw script.reject;
    }
    return {
      protocolVersion: 'v1',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload: script?.payload ?? EMPTY,
    };
  }
}

function statusPayload(armed: boolean): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0, 0, 0, armed ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29, 0, 0, 0, 0,
    0,
  ]);
}

function identification(
  minor = 47,
  identifier = 'BTFL',
): MspIdentificationState {
  return {
    status: 'SUCCEEDED',
    identity: {
      firmware: {
        identifier,
        knownFamily: identifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV',
      },
      apiVersion: {
        mspProtocolVersion: 0,
        apiVersionMajor: 1,
        apiVersionMinor: minor,
      },
      board: {},
    },
  } as MspIdentificationState;
}

function scheduler(): MspTelemetryScheduler {
  return {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
}

function harness(options: {minor?: number; motorTest?: boolean} = {}) {
  const client = new FakeClient();
  const telemetry = scheduler();
  const state = {
    identification: identification(options.minor ?? 47),
    generation: 7 as number,
    ownership: 'ACTIVE' as MspSessionOwnershipState,
    recovery: 'READY' as MspClientState,
    activeClient: client as FakeClient | undefined,
  };
  const coordinator: BoardAlignmentSessionCoordinator = {
    getOwnershipState: () => state.ownership,
    getIdentificationState: () => state.identification,
    getSessionKey: sessionId => ({sessionId, generation: state.generation}),
    getActiveMspClient: () => state.activeClient,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => state.recovery,
  };
  const controller = new BoardAlignmentController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    isMotorTestActive: () => options.motorTest === true,
  });
  return {client, telemetry, state, controller};
}

/** Queue one reply for the read command. */
function enqueueRead(client: FakeClient, snapshot: MspBoardAlignmentSnapshot) {
  client.enqueue(MSP_BOARD_ALIGNMENT_CONFIG, {
    payload: encodeBoardAlignment(snapshot),
  });
}

/** The disarmed-proof pair the save path asks for before any write. */
function enqueueDisarmed(client: FakeClient, armed = false) {
  client.enqueue(MSP_BOXIDS, {payload: Uint8Array.from([0])});
  client.enqueue(MSP_STATUS_EX, {payload: statusPayload(armed)});
}

async function loadOriginal(
  h: ReturnType<typeof harness>,
  snapshot: MspBoardAlignmentSnapshot = NEUTRAL,
): Promise<MspBoardAlignmentSnapshot> {
  enqueueRead(h.client, snapshot);
  const outcome = await h.controller.load(key);
  if (outcome.kind !== 'LOADED') {
    throw new Error(`Expected LOADED, got ${outcome.kind}`);
  }
  return outcome.snapshot;
}

const commandsOf = (h: ReturnType<typeof harness>) =>
  h.client.calls.map(call => call.command);

describe('BoardAlignmentController', () => {
  it('reads the three angles from the board under one pause lease', async () => {
    const h = harness();
    const snapshot = await loadOriginal(h, ROTATED);
    expect(snapshot).toEqual(ROTATED);
    expect(commandsOf(h)).toEqual([MSP_BOARD_ALIGNMENT_CONFIG]);
    expect(h.telemetry.acquirePauseLease).toHaveBeenCalledTimes(1);
  });

  it('fails closed for another firmware family and an active motor test', async () => {
    const foreign = harness();
    foreign.state.identification = identification(47, 'INAV');
    await expect(foreign.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(foreign.client.calls).toEqual([]);

    const motor = harness({motorTest: true});
    await expect(motor.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'MOTOR_TEST_ACTIVE',
    });
    expect(motor.client.calls).toEqual([]);
  });

  it('puts nothing on the wire when no angle was edited', async () => {
    const h = harness();
    const original = await loadOriginal(h, ROTATED);
    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'NO_CHANGES', snapshot: original});
    // Not even the fresh re-read: a save with nothing to save is not an
    // exchange with the board at all.
    expect(commandsOf(h)).toEqual([MSP_BOARD_ALIGNMENT_CONFIG]);
  });

  it('refuses an out-of-range or fractional draft before touching the link', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    for (const draft of [
      {rollDegrees: 361, pitchDegrees: 0, yawDegrees: 0},
      {rollDegrees: 0, pitchDegrees: -181, yawDegrees: 0},
      {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 1.5},
    ]) {
      await expect(h.controller.save(key, original, draft)).resolves.toEqual({
        kind: 'REJECTED',
        reason: 'INVALID_CONFIGURATION',
      });
    }
    expect(commandsOf(h)).toEqual([MSP_BOARD_ALIGNMENT_CONFIG]);
  });

  it('writes once, persists once, then verifies the readback', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL); // fresh base
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client, ROTATED); // readback
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});

    await expect(h.controller.save(key, original, {...ROTATED})).resolves.toEqual(
      {kind: 'SAVED_VERIFIED', snapshot: ROTATED, rebootAcknowledged: true},
    );

    const commands = commandsOf(h);
    expect(
      commands.filter(c => c === MSP_SET_BOARD_ALIGNMENT_CONFIG),
    ).toHaveLength(1);
    expect(commands.filter(c => c === MSP_EEPROM_WRITE)).toHaveLength(1);
    // Armed proof strictly before the write; persist strictly after it.
    expect(commands.indexOf(MSP_STATUS_EX)).toBeLessThan(
      commands.indexOf(MSP_SET_BOARD_ALIGNMENT_CONFIG),
    );
    expect(commands.indexOf(MSP_SET_BOARD_ALIGNMENT_CONFIG)).toBeLessThan(
      commands.indexOf(MSP_EEPROM_WRITE),
    );
    // Persist, then PROVE, then restart. Rebooting before the readback
    // would leave the comparison talking to a board that is rebooting.
    expect(commands.indexOf(MSP_EEPROM_WRITE)).toBeLessThan(
      commands.lastIndexOf(MSP_BOARD_ALIGNMENT_CONFIG),
    );
    expect(commands.at(-1)).toBe(MSP_REBOOT);
    // The frame carried all three angles, as MSP 39 requires.
    const write = h.client.calls.find(
      c => c.command === MSP_SET_BOARD_ALIGNMENT_CONFIG,
    );
    expect(write?.payload).toEqual(encodeBoardAlignment(ROTATED));
    expect(write?.options.wireFormat).toBe('v1');
  });

  it('saves negative angles as the operator entered them', async () => {
    // The whole reason the decoder reads signed: a -90 roll must survive
    // the round trip rather than come back as 65446 and be refused.
    const negative = {rollDegrees: -90, pitchDegrees: -45, yawDegrees: 180};
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client, negative);
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});

    await expect(h.controller.save(key, original, negative)).resolves.toEqual({
      kind: 'SAVED_VERIFIED',
      snapshot: negative,
      rebootAcknowledged: true,
    });
  });

  it('rejects a stale base before asking for armed proof or writing', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 45});

    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});

    const commands = commandsOf(h);
    expect(commands).not.toContain(MSP_SET_BOARD_ALIGNMENT_CONFIG);
    expect(commands).not.toContain(MSP_STATUS_EX);
    expect(commands).not.toContain(MSP_EEPROM_WRITE);
  });

  it('never writes when the fresh status proves ARMED', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client, true);

    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});

    const commands = commandsOf(h);
    expect(commands).not.toContain(MSP_SET_BOARD_ALIGNMENT_CONFIG);
    expect(commands).not.toContain(MSP_EEPROM_WRITE);
  });

  it('reports an outright refusal as failure and never persists it', async () => {
    // MSP_REMOTE_ERROR is the board answering "no". The frame provably
    // did not take effect, so this is a clean failure - not UNCONFIRMED,
    // and above all not a save followed by an EEPROM write.
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {
      reject: {code: 'MSP_REMOTE_ERROR'},
    });

    const outcome = await h.controller.save(key, original, {...ROTATED});
    expect(outcome.kind).toBe('FAILED');
    expect(commandsOf(h)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('reports an ambiguous write as UNCONFIRMED, never retries it, never persists', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {
      reject: {code: 'MSP_TIMEOUT'},
    });

    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'UNCONFIRMED', stage: 'BOARD_ALIGNMENT'});

    expect(
      h.client.calls.filter(c => c.command === MSP_SET_BOARD_ALIGNMENT_CONFIG),
    ).toHaveLength(1);
    expect(commandsOf(h)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('reports an ambiguous EEPROM write as UNCONFIRMED at the EEPROM stage', async () => {
    // The angles may well be live in RAM; whether they survive a reboot
    // is genuinely unknown, and the stage says which half is in doubt.
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {reject: {code: 'MSP_TIMEOUT'}});

    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'UNCONFIRMED', stage: 'EEPROM'});

    expect(
      h.client.calls.filter(c => c.command === MSP_EEPROM_WRITE),
    ).toHaveLength(1);
  });

  it('downgrades to SAVED_UNVERIFIED when the readback disagrees', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    // The board reports a different yaw than the one we just wrote.
    enqueueRead(h.client, {...ROTATED, yawDegrees: 89});
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});

    const outcome = await h.controller.save(key, original, {...ROTATED});
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
  });

  it('downgrades to SAVED_UNVERIFIED when the readback itself fails', async () => {
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    h.client.enqueue(MSP_BOARD_ALIGNMENT_CONFIG, {
      reject: new Error('link went quiet'),
    });
    h.client.enqueue(MSP_REBOOT, {payload: EMPTY});

    const outcome = await h.controller.save(key, original, {...ROTATED});
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
  });

  it('refuses to act for a session that has since reconnected', async () => {
    // A new physical generation means the board on screen is not the
    // board on the wire. Both load and save must refuse rather than
    // credit this session's reply to the previous one.
    const h = harness();
    const original = await loadOriginal(h);
    h.state.generation = 8;

    await expect(h.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'DISCONNECTED',
    });
    await expect(
      h.controller.save(key, original, {...ROTATED}),
    ).resolves.toEqual({kind: 'REJECTED', reason: 'DISCONNECTED'});
    expect(commandsOf(h)).toEqual([MSP_BOARD_ALIGNMENT_CONFIG]);
  });

  it('refuses while the link is recovering or the session is gone', async () => {
    const recovering = harness();
    recovering.state.recovery = 'RESTARTING_READER';
    await expect(recovering.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'LINK_RECOVERING',
    });

    const released = harness();
    released.state.ownership = 'INACTIVE';
    await expect(released.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'DISCONNECTED',
    });

    const gone = harness();
    gone.state.activeClient = undefined;
    await expect(gone.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'DISCONNECTED',
    });
  });

  it('reloads cleanly after a reconnect, showing what the new board reports', async () => {
    const h = harness();
    await loadOriginal(h, NEUTRAL);
    // Reconnect: new generation, new epoch, a differently mounted board.
    h.state.generation = 9;
    h.client.bumpEpoch();
    const reconnected = {sessionId: key.sessionId, generation: 9} as const;
    enqueueRead(h.client, ROTATED);
    await expect(h.controller.load(reconnected)).resolves.toEqual({
      kind: 'LOADED',
      snapshot: ROTATED,
    });
  });

  it('treats a link that vanishes on the restart request as the restart', async () => {
    // The angles are already persisted and already proven by readback at
    // this point. A board that stops answering because it is rebooting
    // is the requested outcome, so the save stays SAVED_VERIFIED - with
    // rebootAcknowledged false, which is the honest record of what we
    // actually saw.
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    enqueueDisarmed(h.client);
    h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
    h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
    enqueueRead(h.client, ROTATED);
    h.client.enqueue(MSP_REBOOT, {reject: {code: 'MSP_TIMEOUT'}});

    await expect(h.controller.save(key, original, {...ROTATED})).resolves.toEqual(
      {kind: 'SAVED_VERIFIED', snapshot: ROTATED, rebootAcknowledged: false},
    );
  });

  it('rejects an ARMED-state answer it cannot trust', async () => {
    // Byte 6 set to a flag we cannot resolve to ARMED or DISARMED must
    // stop the write, not be assumed safe.
    const h = harness();
    const original = await loadOriginal(h);
    enqueueRead(h.client, NEUTRAL);
    h.client.enqueue(MSP_BOXIDS, {payload: EMPTY});
    h.client.enqueue(MSP_STATUS_EX, {payload: statusPayload(false)});

    const outcome = await h.controller.save(key, original, {...ROTATED});
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'ARMED_STATE_UNKNOWN'});
    expect(commandsOf(h)).not.toContain(MSP_SET_BOARD_ALIGNMENT_CONFIG);
  });
});

/**
 * API 1.47, 1.48 AND 1.49 - a full save at each, not just admission.
 *
 * Neither the firmware handler (msp.c) nor betaflight-configurator's
 * parser branches on API version for command 38 or 39, so the payload is
 * the same on all three. This asserts that claim end to end rather than
 * trusting the reading: if a version gate were ever introduced here, the
 * 1.48 and 1.49 rows would stop producing an identical frame.
 */
describe('board alignment across API versions', () => {
  it.each([47, 48, 49])(
    'reads and saves identically on API 1.%i',
    async minor => {
      const h = harness({minor});
      const original = await loadOriginal(h, NEUTRAL);
      enqueueRead(h.client, NEUTRAL);
      enqueueDisarmed(h.client);
      h.client.enqueue(MSP_SET_BOARD_ALIGNMENT_CONFIG, {payload: EMPTY});
      h.client.enqueue(MSP_EEPROM_WRITE, {payload: EMPTY});
      enqueueRead(h.client, ROTATED);
      h.client.enqueue(MSP_REBOOT, {payload: EMPTY});

      await expect(
        h.controller.save(key, original, {...ROTATED}),
      ).resolves.toEqual({
        kind: 'SAVED_VERIFIED',
        snapshot: ROTATED,
        rebootAcknowledged: true,
      });

      const write = h.client.calls.find(
        c => c.command === MSP_SET_BOARD_ALIGNMENT_CONFIG,
      );
      expect(write?.payload).toEqual(
        Uint8Array.from([2, 0, 0, 0, 90, 0]), // roll 2, pitch 0, yaw 90
      );
    },
  );

  it('refuses API 1.46, which is below the verified configuration floor', async () => {
    const h = harness({minor: 46});
    await expect(h.controller.load(key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(h.client.calls).toEqual([]);
  });
});
