/**
 * Empirical confirmation alongside connectionIndicator.test.ts's own
 * formal idempotence proof (updateNoticeActivationTimestamps's own
 * describe block) - actually exercises the hook under a real
 * <React.StrictMode> double-render, rather than resting on the proof
 * alone.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {useTopBarNotice} from './useTopBarNotice';
import type {MspIdentificationState, MspSessionOwnershipState} from '../../../platforms/react-native/protocol';
import type {MspClientState} from '../../../core';

const IDLE_IDENTIFICATION: MspIdentificationState = {status: 'IDLE'};

let capturedActivatedAtMs: number[] = [];

function Harness({ownership, recovery}: {ownership: MspSessionOwnershipState; recovery: MspClientState | undefined}) {
  const notice = useTopBarNotice(ownership, recovery, IDLE_IDENTIFICATION);
  capturedActivatedAtMs.push(notice?.activatedAtMs ?? -1);
  return null;
}

describe('useTopBarNotice under React.StrictMode (dev-mode double-render)', () => {
  beforeEach(() => {
    capturedActivatedAtMs = [];
  });

  it('a freshly-appearing notice gets a single, stable activatedAtMs - StrictMode\'s double-invoke does not sample two different Date.now() values into the committed result', () => {
    act(() => {
      ReactTestRenderer.create(
        <React.StrictMode>
          <Harness ownership="INACTIVE" recovery={undefined} />
        </React.StrictMode>,
      );
    });

    // StrictMode invokes the component function twice per commit in dev -
    // both captured pushes must agree on the SAME activatedAtMs, proving
    // the ref mutation converged rather than drifting between the two
    // invocations.
    expect(capturedActivatedAtMs.length).toBeGreaterThanOrEqual(2);
    const distinctValues = new Set(capturedActivatedAtMs);
    expect(distinctValues.size).toBe(1);
    expect(capturedActivatedAtMs[0]).toBeGreaterThan(0);
  });

  it('a notice that stays active across multiple real re-renders keeps the SAME activatedAtMs throughout - not re-stamped every render', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <React.StrictMode>
          <Harness ownership="INACTIVE" recovery={undefined} />
        </React.StrictMode>,
      );
    });
    const firstStamp = capturedActivatedAtMs[0];
    expect(firstStamp).toBeGreaterThan(0);

    // Force several more real re-renders with the SAME still-active
    // notice condition.
    for (let i = 0; i < 3; i++) {
      act(() => {
        renderer.update(
          <React.StrictMode>
            <Harness ownership="INACTIVE" recovery={undefined} />
          </React.StrictMode>,
        );
      });
    }

    const allStamps = new Set(capturedActivatedAtMs);
    expect(allStamps.size).toBe(1);
    expect([...allStamps][0]).toBe(firstStamp);
  });

  it('a genuine transition - the notice disappearing then a DIFFERENT notice appearing - gets its own new activatedAtMs, not the old one', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <React.StrictMode>
          <Harness ownership="INACTIVE" recovery={undefined} />
        </React.StrictMode>,
      );
    });
    const disconnectedStamp = capturedActivatedAtMs[0];

    act(() => {
      renderer.update(
        <React.StrictMode>
          <Harness ownership="ACTIVE" recovery="RECOVERY_FAILED" />
        </React.StrictMode>,
      );
    });

    const recoveryFailedStamps = capturedActivatedAtMs.slice(-2);
    expect(new Set(recoveryFailedStamps).size).toBe(1); // stable across this render's own double-invoke too
    expect(recoveryFailedStamps[0]).toBeGreaterThanOrEqual(disconnectedStamp); // a later, genuinely new activation
  });
});
