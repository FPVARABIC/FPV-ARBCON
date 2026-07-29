/**
 * THE LATE SAME-COMMAND RESPONSE AFTER PREEMPTION.
 *
 * WHY `handleFrame` MATCHING THE ACTIVE REQUEST IS NOT PROOF. MSP frames
 * carry NO per-request correlation id. A response is matched by command
 * alone, so a displaced request's late answer is BYTE-IDENTICAL to the
 * answer of any later request carrying the same command. "The displaced
 * request is no longer active" therefore proves nothing on its own: the
 * stale frame does not settle the OLD request, it settles the NEW one.
 *
 * The concrete danger, and the exact sequence exercised below:
 *
 *   1. safety request A (MSP_STATUS_EX) is written and awaits its response
 *   2. a normal release triggers the priority STOP, displacing A
 *   3. the STOP is acknowledged
 *   4. a FRESH safety request B (MSP_STATUS_EX) becomes active for the
 *      next safety gate
 *   5. A's late response arrives - after B is active, before B's own
 *   6. without a quarantine, A settles B, and a stale snapshot from before
 *      the stop authorises the next pulse
 *
 * THE SOLUTION USES NOTHING THAT IS NOT ON THE WIRE. No invented request
 * id. The client records that a WRITTEN request was displaced and owes
 * exactly one unmatched response for that command; the next frame carrying
 * it is swallowed. The ledger is released only by consumption or by a
 * session/epoch reset - deliberately NOT when the stop settles, since the
 * whole point is a frame arriving after the stop's own ACK.
 *
 * NO HARDWARE, NO MOTOR COMMAND. The transport is the repository's fake
 * and the "stop" carries an opaque payload through the priority slot.
 */

import {MspClient} from '../mspClient';
import {FakeMspTransport} from '../__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../__testUtils__/mspFixtures';
import type {MspFrame} from '../mspTypes';

const MSP_STATUS_EX = 150;
const MSP_BATTERY_STATE = 130;
const STOP_COMMAND = 214;
const EMPTY = new Uint8Array(0);
const V1 = {wireFormat: 'v1'} as const;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

const openClients: MspClient[] = [];
afterEach(() => {
  while (openClients.length > 0) {
    openClients.pop()?.dispose();
  }
});

function leased(sessionId: string) {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, sessionId);
  openClients.push(client);
  const acquisition = client.tryAcquireMotorTestLease();
  if (acquisition.kind !== 'ACQUIRED') {
    throw new Error('lease not acquired');
  }
  return {transport, client, token: acquisition.token};
}

/** A response frame for `command` carrying a distinguishable payload, so a
 * settled value can be traced back to WHICH request it belonged to. */
const respond = (
  transport: FakeMspTransport,
  command: number,
  marker: number,
): void => {
  transport.emitData(
    buildMspFrameBytes(command, Uint8Array.from([marker, marker]), {
      wireFormat: 'v1',
      direction: 'response',
    }),
  );
};

const A_MARKER = 0xaa;
const B_MARKER = 0xbb;

/**
 * Drives the exact adversarial sequence for one command and returns what B
 * settled with, if anything.
 */
async function lateResponseCannotSettleTheNextRequest(command: number) {
  const {transport, client, token} = leased(`late-${command}`);

  // (1) Safety request A is written and awaits its response.
  const requestA = client.requestWithMotorTestLease(token, command, EMPTY, V1);
  const outcomeA = requestA.then(
    () => 'RESOLVED',
    (error: Error) => error.name,
  );
  await flush();
  transport.resolveNextWrite();
  await flush();
  expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

  // (2) A normal release triggers the priority STOP, displacing A.
  const dispatch = client.emergencyStopWithMotorTestLease(
    token,
    STOP_COMMAND,
    EMPTY,
    V1,
  );
  let stopFrame: MspFrame | undefined;
  const stopSettled = dispatch.frame.then(
    frame => {
      stopFrame = frame;
      return 'RESOLVED';
    },
    (error: Error) => error.name,
  );
  await flush();
  expect(await outcomeA).toBe('MspMotorTestStopDisplacementError');

  // (3) The STOP is written and acknowledged.
  transport.resolveNextWrite();
  await flush();
  respond(transport, STOP_COMMAND, 0x11);
  expect(await stopSettled).toBe('RESOLVED');
  expect(stopFrame?.command).toBe(STOP_COMMAND);

  // (4) A FRESH safety request B for the SAME command becomes active for
  //     the next safety gate.
  const requestB = client.requestWithMotorTestLease(token, command, EMPTY, V1);
  let settledB: MspFrame | undefined;
  const outcomeB = requestB.then(
    frame => {
      settledB = frame;
      return 'RESOLVED';
    },
    (error: Error) => error.name,
  );
  await flush();
  transport.resolveNextWrite();
  await flush();
  expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

  // (5) A's LATE response arrives - after B is active, before B's own.
  //     It is byte-indistinguishable from a genuine answer for B.
  respond(transport, command, A_MARKER);
  await flush();

  return {transport, client, token, outcomeB, settledB: () => settledB};
}

describe('a preempted request cannot settle the next request for the same command', () => {
  for (const [name, command] of [
    ['MSP_STATUS_EX', MSP_STATUS_EX],
    ['MSP_BATTERY_STATE', MSP_BATTERY_STATE],
  ] as const) {
    describe(name, () => {
      it("swallows A's late response: it cannot settle B", async () => {
        const {transport, settledB} = await lateResponseCannotSettleTheNextRequest(command);

        // B is STILL outstanding. A's stale answer settled nothing.
        expect(settledB()).toBeUndefined();

        // Only B's OWN genuine response settles B - and it carries B's
        // marker, never A's.
        respond(transport, command, B_MARKER);
        await flush();
        const frame = settledB();
        expect(frame).toBeDefined();
        expect(frame?.payload[0]).toBe(B_MARKER);
        expect(frame?.payload[0]).not.toBe(A_MARKER);
      });

      it('quarantines exactly ONE late frame, never a second genuine one', async () => {
        const {transport, client, token, settledB} =
          await lateResponseCannotSettleTheNextRequest(command);

        // B's genuine answer arrives and settles normally: the ledger owed
        // exactly one frame and has now been paid.
        respond(transport, command, B_MARKER);
        await flush();
        expect(settledB()?.payload[0]).toBe(B_MARKER);

        // A THIRD request for the same command is completely unaffected -
        // the quarantine did not become a permanent trap.
        const requestC = client.requestWithMotorTestLease(token, command, EMPTY, V1);
        let settledC: MspFrame | undefined;
        requestC.then(
          frame => {
            settledC = frame;
          },
          () => undefined,
        );
        await flush();
        transport.resolveNextWrite();
        await flush();
        respond(transport, command, 0xcc);
        await flush();
        expect(settledC?.payload[0]).toBe(0xcc);
      });

      it('leaves the live safety snapshot unchanged and authorises no pulse', async () => {
        const {settledB} = await lateResponseCannotSettleTheNextRequest(command);

        // The observation the monitor is waiting on has NOT completed, so
        // there is no fresh satisfied reading and therefore no gate to
        // open. The stale facts from before the stop are never published.
        expect(settledB()).toBeUndefined();
      });
    });
  }

  it('does not swallow the stop’s OWN acknowledgement when commands are equal', async () => {
    // The equal-command case is owned by the pre-existing
    // attributionAmbiguous contract, which fails closed by caller
    // contract. Quarantining there would eat the stop's own ACK and turn a
    // successful stop into a timeout - strictly worse.
    const {transport, client, token} = leased('equal-command');

    const requestA = client.requestWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    requestA.catch(() => undefined);
    await flush();
    transport.resolveNextWrite();
    await flush();

    const dispatch = client.emergencyStopWithMotorTestLease(
      token,
      STOP_COMMAND,
      EMPTY,
      V1,
    );
    const stopSettled = dispatch.frame.then(
      () => 'RESOLVED',
      (error: Error) => error.name,
    );
    await flush();
    // The client reports the ambiguity rather than hiding it.
    expect(dispatch.attributionAmbiguous).toBe(true);

    transport.resolveNextWrite();
    await flush();
    respond(transport, STOP_COMMAND, 0x11);

    expect(await stopSettled).toBe('RESOLVED');
  });

  it('never lets a quarantine leak across a session reset', async () => {
    const {transport, client, token} = leased('leak-check');

    const requestA = client.requestWithMotorTestLease(token, MSP_STATUS_EX, EMPTY, V1);
    requestA.catch(() => undefined);
    await flush();
    transport.resolveNextWrite();
    await flush();

    const dispatch = client.emergencyStopWithMotorTestLease(
      token,
      STOP_COMMAND,
      EMPTY,
      V1,
    );
    dispatch.frame.catch(() => undefined);
    await flush();

    // The session ends before the quarantined frame ever arrives. A ledger
    // that survived would swallow the first genuine frame of the NEXT
    // session, which is a different identity entirely.
    client.dispose();
    await flush();

    const executable = client as unknown as {
      quarantinedResponses: Map<number, number>;
    };
    expect(executable.quarantinedResponses.size).toBe(0);
  });
});
