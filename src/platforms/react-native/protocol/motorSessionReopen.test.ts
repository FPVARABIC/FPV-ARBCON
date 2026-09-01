/**
 * OPEN -> CLOSE -> OPEN AGAIN.
 *
 * THE REPORTED DEFECT. Closing a motor-test session and trying to start
 * another did nothing: the toggle moved, and no session opened. The only
 * way back was to leave the Motors screen entirely.
 *
 * THE CAUSE, traced through three files that were each individually
 * correct:
 *
 *   1. a MotorTestController runs IDLE -> PREPARING -> ACTIVE -> CLOSING
 *      -> CLOSED and never returns to IDLE. CLOSED is terminal by design;
 *   2. the session binding built ONE controller and returned it "forever
 *      after", so after a close the capability still held the spent one;
 *   3. MotorsScreen starts a session only when the phase is IDLE.
 *
 * So the second press was refused by a gate reading a controller that
 * could never satisfy it again. Nothing threw, nothing logged, and the
 * screen looked exactly as it had a moment earlier.
 *
 * THE FIX, and the line it must not cross. A spent controller is retired
 * and replaced - but ONLY when its own teardown reported complete. A close
 * that failed, or one still in flight, keeps the existing controller so
 * its unresolved state goes on blocking. That distinction is the whole
 * safety argument: a controller whose stop was never confirmed may
 * correspond to a motor that is still turning, and swapping in a fresh
 * IDLE one would launder that into "nothing was ever commanded" for both
 * the start gate and the output-engagement predicate.
 */

import {isSpentController} from './motorTestSessionBinding';
import type {MotorTestControllerSnapshot} from '../../../core/state/motorTestController';

function controllerAt(
  snapshot: Partial<MotorTestControllerSnapshot>,
): {getSnapshot(): MotorTestControllerSnapshot} {
  return {
    getSnapshot: () => snapshot as MotorTestControllerSnapshot,
  };
}

describe('when a controller may be retired and replaced', () => {
  it('a cleanly closed session is spent, so the next open gets a fresh controller', () => {
    expect(
      isSpentController(
        controllerAt({phase: 'CLOSED', teardown: {complete: true} as never}),
      ),
    ).toBe(true);
  });

  it('a CLOSED controller whose teardown did NOT complete is kept', () => {
    // The dangerous case. Exclusivity may still be held and a motor may
    // still be turning; replacing this with a fresh controller would erase
    // the only evidence of it.
    expect(
      isSpentController(
        controllerAt({phase: 'CLOSED', teardown: {complete: false} as never}),
      ),
    ).toBe(false);
  });

  it('a CLOSED controller that never reported a teardown is kept', () => {
    expect(isSpentController(controllerAt({phase: 'CLOSED'}))).toBe(false);
  });

  it.each(['IDLE', 'PREPARING', 'ACTIVE', 'CLOSING'] as const)(
    'a %s controller is never retired',
    phase => {
      // Retiring a live controller would abandon a session that is running
      // - including one with a motor spinning.
      expect(
        isSpentController(
          controllerAt({phase, teardown: {complete: true} as never}),
        ),
      ).toBe(false);
    },
  );
});

/**
 * The wiring that makes the retirement reachable. A held facade is frozen
 * and kept for the life of the screen, so if it captured its controller
 * once, retiring one would leave every call - and every subscription -
 * pointed at the dead object. These read the shipped module, because that
 * capture is exactly what a double would hide.
 */
describe('a held operator port follows the live controller', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const source = fs
    .readFileSync(path.join(__dirname, 'motorTestSessionBinding.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('resolves the controller per call instead of capturing it', () => {
    // Every command and read goes through live(); none holds a reference.
    expect(source).toContain('live().pulseMotor');
    expect(source).toContain('live().stopAll');
    expect(source).toContain('live().requestStop');
    expect(source).toContain('live().close()');
    expect(source).toContain('getSnapshot: () => live().getSnapshot()');
  });

  it('starts a new session through the path that may replace a spent controller', () => {
    expect(source).toContain('forNewSession().initializeSession()');
  });

  it('holds subscriptions on the binding, so a swap does not orphan them', () => {
    // Subscribed once by the screen; the binding re-points its fan-out at
    // whichever controller is live.
    expect(source).toContain('this.listeners.add(listener)');
    expect(source).toContain('this.listeners.delete(listener)');
    expect(source).toContain('private attachFanOut');
    expect(source).toContain('this.attachFanOut(controller)');
  });

  it('drops the fan-out when the capability itself closes', () => {
    // A closing controller may still publish, and after this there is
    // nothing left for a listener to read.
    expect(source).toContain('this.listeners.clear()');
  });

  it('never lets a plain READ build a controller', () => {
    // live() falls back to ensureController only when none exists at all,
    // which cannot happen after operatorPort() has run. The standing rule
    // that a lifecycle listener must not create a controller is unchanged.
    expect(source).toContain('lifecycleStopPort()');
    expect(source).toMatch(/lifecycleStopPort\(\)[\s\S]{0,400}?return undefined;/);
  });
});
