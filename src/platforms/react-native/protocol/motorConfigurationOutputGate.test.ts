/**
 * THE PRODUCTION BINDING, NOT THE TEST SEAM.
 *
 * MotorConfigurationController takes an injectable predicate, so every
 * existing gate test keeps passing whichever predicate is wired underneath -
 * they stub it directly. That is exactly why they could not catch the defect
 * this change fixes, and why they cannot prove it is fixed either.
 *
 * The defect: the DEFAULT binding was isMotorTestSessionActive, which answers
 * "does a motor-test session exist?". A session sitting open with every motor
 * at rest is exactly as safe as no session, but configuration was refused all
 * the same, so the operator had to close the session, leave Motors, and come
 * back to change something that concerns motors.
 *
 * These tests exercise the real default path - the capability store lookup -
 * so a future edit that re-points it at session existence fails here.
 */

import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  isMotorOutputEngagedForSession,
  motorOutputEngagementForSession,
  openMotorTestCapability,
  readMotorTestCapability,
} from './motorTestCapability';
import {evaluateMotorOutputEngagement} from '../../../core/state/motorOutputEngagement';
import type {MspClient} from '../../../core/protocol/mspClient';
import type {MotorTestControllerSnapshot} from '../../../core/state/motorTestController';

describe('the configuration gate asks about motor output, not about sessions', () => {
  it('is bound to the engagement predicate, not to session existence', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'MotorConfigurationController.ts'),
      'utf8',
    );

    // The default the controller actually constructs itself with.
    expect(source).toContain(
      'const defaultMotorOutputEngaged = isMotorOutputEngagedForSession;',
    );
    // And the old question is gone from the EXECUTABLE code - not merely
    // shadowed by a differently named seam. Comments may still name it,
    // because explaining what this replaced is the point of those comments.
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(executable).not.toContain('isMotorTestSessionActive');
  });

  it('re-checks at WRITE time, not only at admission', () => {
    // The operator can start a motor between opening the editor and pressing
    // save, so one check at load would be a window, not a gate.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'MotorConfigurationController.ts'),
      'utf8',
    );
    const checks = source.match(/this\.isMotorOutputEngaged\(sessionId\)/g);
    expect(checks?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('the session-id lookup fails closed', () => {
  it('an unknown session reports ENGAGED, never "no session so it is fine"', () => {
    // This is the disconnect / torn-down / reconnected-with-fresh-controller
    // case. Absent evidence is not evidence of safety, and a reconnect must
    // not launder an unknown state into a safe one.
    expect(isMotorOutputEngagedForSession('no-such-session')).toBe(true);
    expect(motorOutputEngagementForSession('no-such-session')).toEqual({
      engagement: 'ENGAGED',
      reason: 'NO_SNAPSHOT',
    });
  });
});

/**
 * THE REGRESSION THIS SUITE EXISTS FOR, SECOND TIME ROUND.
 *
 * Making the gate fail closed introduced a worse defect than the one it
 * fixed. The lookup collapsed two different states into "no snapshot":
 *
 *   - no capability at all (torn down, disconnected)          -> ENGAGED, right
 *   - a capability that never BUILT a motor-test controller   -> ENGAGED, wrong
 *
 * The second is the ordinary path. The coordinator opens a capability for
 * every identified session, but the controller inside it is lazy - it is
 * constructed the first time a bench session is actually started. So an
 * operator who connected a board and went straight to motor configuration,
 * having never touched the test bench, was refused with "stop the motors"
 * when no motor had ever been commanded and there was nothing to stop.
 *
 * The tests above could not see it: two read the source text, and the third
 * calls evaluateMotorOutputEngagement() directly with a hand-built snapshot,
 * which is the layer BELOW the lookup where the defect lived. These go
 * through the real registry.
 */
describe('a connected board with no bench session is not "motors running"', () => {
  const SESSION = 'gate-probe-session';
  const client = {request: jest.fn(), getEpoch: () => 1} as unknown as MspClient;

  afterEach(() => closeMotorTestCapability(SESSION));

  it('an open capability that never started a bench is AT REST', () => {
    openMotorTestCapability(SESSION, client, createMotorTestTelemetryRegistry());
    // Precondition, so this cannot pass by the controller quietly existing:
    // no controller means no port, and the controller is the only thing that
    // can emit MSP_SET_MOTOR.
    expect(readMotorTestCapability(SESSION)?.lifecycleStopPort()).toBeUndefined();

    expect(motorOutputEngagementForSession(SESSION)).toEqual({
      engagement: 'AT_REST',
      reason: 'NEVER_INITIATED',
    });
    expect(isMotorOutputEngagedForSession(SESSION)).toBe(false);
  });

  it('a CLOSED capability still in the registry stays ENGAGED', () => {
    // close() clears the controller as well as the session, so a closed
    // binding looks exactly like one that never initialised. Production
    // deregisters before closing, but close() is on the public facade and
    // this must not depend on call ordering elsewhere: after a real motor
    // test, "no controller" must never read as proof of rest.
    openMotorTestCapability(SESSION, client, createMotorTestTelemetryRegistry());
    readMotorTestCapability(SESSION)?.close();

    expect(readMotorTestCapability(SESSION)).toBeDefined();
    expect(motorOutputEngagementForSession(SESSION)).toEqual({
      engagement: 'ENGAGED',
      reason: 'NO_SNAPSHOT',
    });
    expect(isMotorOutputEngagedForSession(SESSION)).toBe(true);
  });

  it('the boolean and the verdict can never disagree', () => {
    // They were written independently once, which is how a gate could block
    // for one reason while the screen explained another.
    openMotorTestCapability(SESSION, client, createMotorTestTelemetryRegistry());
    for (const session of [SESSION, 'no-such-session']) {
      expect(isMotorOutputEngagedForSession(session)).toBe(
        motorOutputEngagementForSession(session).engagement === 'ENGAGED',
      );
    }
  });
});

describe('what an OPEN session at rest is allowed to do', () => {
  /** Only the fields the predicate reads. */
  function atRest(): MotorTestControllerSnapshot {
    return {
      // Neither liveness latch set: the session provably never commanded.
      outputMayBeLive: false,
      stopExecution: {commandDispatched: false, commandAcknowledged: false},
    } as unknown as MotorTestControllerSnapshot;
  }

  it('an open session that never commanded a motor is AT REST', () => {
    // The whole point: this state used to block configuration purely because
    // a session object existed.
    expect(evaluateMotorOutputEngagement(atRest())).toEqual({
      engagement: 'AT_REST',
      reason: 'NEVER_COMMANDED',
    });
  });

  it('the same session becomes ENGAGED the moment a command may be live', () => {
    const commanded = {
      ...atRest(),
      outputMayBeLive: true,
    } as MotorTestControllerSnapshot;
    expect(evaluateMotorOutputEngagement(commanded).engagement).toBe('ENGAGED');
  });
});
