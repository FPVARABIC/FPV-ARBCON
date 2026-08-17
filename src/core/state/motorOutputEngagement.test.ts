/**
 * EVERY AMBIGUOUS STATE MUST READ AS ENGAGED.
 *
 * This predicate decides whether Motors will let the operator change
 * configuration while a session is open. It replaces a gate that asked "does a
 * session exist?" - a question whose answer had nothing to do with whether a
 * propeller was turning.
 *
 * So the tests here are deliberately lopsided: there are exactly two ways to
 * reach AT_REST and every other arrangement of the same fields must reach
 * ENGAGED. A happy path that passes proves almost nothing; what matters is
 * that losing evidence, losing the link, or half-completing a stop all fail
 * closed.
 */

import {
  evaluateMotorOutputEngagement,
  isMotorOutputEngaged,
} from './motorOutputEngagement';
import type {MotorTestControllerSnapshot} from './motorTestController';

type Stop = MotorTestControllerSnapshot['stopExecution'];

const NO_STOP: Stop = {
  attempts: 0,
  commandDispatched: false,
  commandAcknowledged: false,
  physicalStopConfirmed: false,
  deferredBehindActiveWrite: false,
  attributionAmbiguous: false,
  attributionResolvedByConfirmation: false,
  wirePreemptionClaimed: false,
  submittedNextOnTransport: false,
  episodeId: 0,
  outcome: undefined,
};

/** Only the two fields this predicate reads; the rest is scenery. */
function snapshot(
  outputMayBeLive: boolean,
  stop: Partial<Stop> = {},
): MotorTestControllerSnapshot {
  return {
    outputMayBeLive,
    stopExecution: {...NO_STOP, ...stop},
  } as unknown as MotorTestControllerSnapshot;
}

describe('proof of rest', () => {
  it('a session that never commanded anything is AT REST', () => {
    // Both liveness latches unset. This is the codebase's own statement that
    // the session provably never commanded anything - and it is the state an
    // operator is in for most of a Motors visit.
    const verdict = evaluateMotorOutputEngagement(snapshot(false));
    expect(verdict).toEqual({engagement: 'AT_REST', reason: 'NEVER_COMMANDED'});
  });

  it('an acknowledged, unambiguous all-stop is AT REST', () => {
    const verdict = evaluateMotorOutputEngagement(
      snapshot(true, {commandDispatched: true, commandAcknowledged: true}),
    );
    expect(verdict).toEqual({engagement: 'AT_REST', reason: 'STOP_ACKNOWLEDGED'});
  });

  it('an ambiguous stop RESOLVED by a second confirmation is AT REST', () => {
    // The first frame is still never accepted as proof; something else
    // supplied it.
    expect(
      evaluateMotorOutputEngagement(
        snapshot(true, {
          commandDispatched: true,
          commandAcknowledged: true,
          attributionAmbiguous: true,
          attributionResolvedByConfirmation: true,
        }),
      ).engagement,
    ).toBe('AT_REST');
  });
});

describe('everything else is ENGAGED', () => {
  it('no snapshot at all - losing the evidence is not evidence of safety', () => {
    // A disconnect mid-pulse, a torn-down session, or a reconnect that built a
    // fresh controller with no history all land here. A reconnect must never
    // launder an unknown state into a safe one.
    expect(evaluateMotorOutputEngagement(undefined)).toEqual({
      engagement: 'ENGAGED',
      reason: 'NO_SNAPSHOT',
    });
  });

  it('a command may be live and no stop was ever dispatched', () => {
    expect(evaluateMotorOutputEngagement(snapshot(true))).toEqual({
      engagement: 'ENGAGED',
      reason: 'COMMAND_LIVE_NO_STOP',
    });
  });

  it('the stop was dispatched but never acknowledged', () => {
    // The command may have been lost on the way out - precisely when a motor
    // is most likely still spinning.
    expect(
      evaluateMotorOutputEngagement(
        snapshot(true, {commandDispatched: true, commandAcknowledged: false}),
      ),
    ).toEqual({engagement: 'ENGAGED', reason: 'STOP_UNACKNOWLEDGED'});
  });

  it('the acknowledgement may belong to a displaced frame', () => {
    expect(
      evaluateMotorOutputEngagement(
        snapshot(true, {
          commandDispatched: true,
          commandAcknowledged: true,
          attributionAmbiguous: true,
          attributionResolvedByConfirmation: false,
        }),
      ),
    ).toEqual({engagement: 'ENGAGED', reason: 'STOP_ATTRIBUTION_AMBIGUOUS'});
  });

  it.each(['FAILED', 'TIMED_OUT', 'REJECTED', 'ABORTED', 'LINK_LOST'])(
    'the stop reported outcome %s',
    kind => {
      expect(
        evaluateMotorOutputEngagement(
          snapshot(true, {
            commandDispatched: true,
            commandAcknowledged: true,
            outcome: {kind} as never,
          }),
        ),
      ).toEqual({engagement: 'ENGAGED', reason: 'STOP_FAILED'});
    },
  );

  it('a stop outcome kind this build has never seen still has to be acknowledged', () => {
    // A new outcome added upstream must not be readable as success by
    // omission. Unknown kind + unacknowledged is still ENGAGED.
    expect(
      evaluateMotorOutputEngagement(
        snapshot(true, {
          commandDispatched: true,
          commandAcknowledged: false,
          outcome: {kind: 'SOMETHING_NEW'} as never,
        }),
      ).engagement,
    ).toBe('ENGAGED');
  });

  it('PHYSICAL stop is never claimed, so it cannot be used as proof', () => {
    // physicalStopConfirmed is permanently false by design; a predicate that
    // waited for it would never release, and one that inferred rest without an
    // acknowledgement would be lying.
    const stopped = snapshot(true, {
      commandDispatched: true,
      commandAcknowledged: true,
    });
    expect(stopped.stopExecution.physicalStopConfirmed).toBe(false);
    expect(isMotorOutputEngaged(stopped)).toBe(false);
  });
});

describe('the boolean helper agrees with the verdict, always', () => {
  const cases: readonly (MotorTestControllerSnapshot | undefined)[] = [
    undefined,
    snapshot(false),
    snapshot(true),
    snapshot(true, {commandDispatched: true}),
    snapshot(true, {commandDispatched: true, commandAcknowledged: true}),
    snapshot(true, {
      commandDispatched: true,
      commandAcknowledged: true,
      attributionAmbiguous: true,
    }),
  ];

  it.each(cases.map((value, index) => [index, value] as const))(
    'case %i',
    (_index, value) => {
      expect(isMotorOutputEngaged(value)).toBe(
        evaluateMotorOutputEngagement(value).engagement === 'ENGAGED',
      );
    },
  );
});
