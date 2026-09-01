/**
 * THE REBOOT LIFECYCLE, INCLUDING THE PART THAT MUST NOT LOOP.
 *
 * The behaviour this file pins is a single decision made in one place:
 * when a session ends, was it OUR doing or a fault? Everything else in
 * the recovery - the redirect landing without `afterSessionLoss`, the
 * workspace auto-connecting, the CLI screen's three-stage message - hangs
 * off that one answer, so it is the thing worth proving exhaustively.
 */

import {
  FcRebootRecovery,
  FC_REBOOT_RECOVERY_TIMEOUT_MS,
} from './fcRebootRecovery';

const SESSION = 'session-under-test';

/** A recovery with a clock the test drives, so no scenario here waits. */
function recovery(timeoutMs = FC_REBOOT_RECOVERY_TIMEOUT_MS) {
  let clock = 1_000;
  const instance = new FcRebootRecovery({now: () => clock, timeoutMs});
  return {
    instance,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('an unexpected loss is never mistaken for a reboot we asked for', () => {
  it('reports a loss as unexpected when nothing was expected', () => {
    const {instance} = recovery();
    expect(instance.getPhase().kind).toBe('IDLE');
    expect(instance.noteSessionLost(SESSION)).toBe(false);
    expect(instance.getPhase().kind).toBe('IDLE');
  });

  it('reports a loss on a DIFFERENT session as unexpected', () => {
    // Two boards, one rebooting. Losing the other one is still a fault.
    const {instance} = recovery();
    instance.expectReboot(SESSION, 'CLI_SAVE');
    expect(instance.noteSessionLost('some-other-session')).toBe(false);
    expect(instance.getPhase().kind).toBe('EXPECTED');
  });

  /**
   * THE LOOP GUARD, and the reason the expectation is one-shot.
   *
   * The redirect omits `afterSessionLoss` - and therefore lets the
   * workspace reach for the hardware - only when the loss was expected.
   * If a single `save` could make TWO losses look expected, the app
   * would reopen the port, lose it again, reopen it again, forever. The
   * second loss must be a fault.
   */
  it('treats only the FIRST loss after a save as expected', () => {
    const {instance} = recovery();
    instance.expectReboot(SESSION, 'CLI_SAVE');
    expect(instance.noteSessionLost(SESSION)).toBe(true);
    expect(instance.noteSessionLost(SESSION)).toBe(false);
    expect(instance.noteSessionLost(SESSION)).toBe(false);
  });
});

describe('the happy path, end to end', () => {
  it('walks EXPECTED to RECOVERED and permits an automatic reconnect', () => {
    const {instance} = recovery();
    const seen: string[] = [];
    instance.subscribe(() => seen.push(instance.getPhase().kind));

    instance.expectReboot(SESSION, 'CLI_SAVE');
    expect(instance.shouldReconnectAutomatically()).toBe(false); // link is still up

    expect(instance.noteSessionLost(SESSION)).toBe(true);
    expect(instance.shouldReconnectAutomatically()).toBe(true);

    instance.noteReconnecting();
    instance.noteRecovered();

    expect(seen).toEqual([
      'EXPECTED',
      'WAITING_FOR_LINK',
      'RECONNECTING',
      'RECOVERED',
    ]);
    // And it is finished: nothing further should reconnect on its own.
    expect(instance.shouldReconnectAutomatically()).toBe(false);
  });

  it('goes back to IDLE on reset, so the next fault is a fault again', () => {
    const {instance} = recovery();
    instance.expectReboot(SESSION, 'CLI_SAVE');
    instance.noteSessionLost(SESSION);
    instance.noteRecovered();
    instance.reset();
    expect(instance.getPhase().kind).toBe('IDLE');
    expect(instance.noteSessionLost(SESSION)).toBe(false);
  });
});

describe('a board that does not come back is not waited for forever', () => {
  it('fails with TIMED_OUT rather than waiting indefinitely', () => {
    const {instance, advance} = recovery(5_000);
    instance.expectReboot(SESSION, 'CLI_SAVE');
    instance.noteSessionLost(SESSION);
    expect(instance.shouldReconnectAutomatically()).toBe(true);

    advance(5_001);
    expect(instance.shouldReconnectAutomatically()).toBe(false);
    expect(instance.getPhase()).toEqual({
      kind: 'FAILED',
      reason: 'CLI_SAVE',
      detail: 'TIMED_OUT',
    });
  });

  it('times out from EXPECTED too - a board that never even drops', () => {
    const {instance, advance} = recovery(5_000);
    instance.expectReboot(SESSION, 'CLI_SAVE');
    advance(5_001);
    instance.evaluateDeadline();
    expect(instance.getPhase()).toMatchObject({
      kind: 'FAILED',
      detail: 'TIMED_OUT',
    });
  });

  it('reports a failed reopen distinctly from a timeout', () => {
    const {instance} = recovery();
    instance.expectReboot(SESSION, 'CLI_SAVE');
    instance.noteSessionLost(SESSION);
    instance.noteReconnecting();
    instance.noteReopenFailed();
    expect(instance.getPhase()).toEqual({
      kind: 'FAILED',
      reason: 'CLI_SAVE',
      detail: 'REOPEN_FAILED',
    });
    // A failure must not keep asking the app to reconnect.
    expect(instance.shouldReconnectAutomatically()).toBe(false);
  });

  it('does not resurrect a finished lifecycle from a stray callback', () => {
    const {instance} = recovery();
    // Nothing was expected, so none of these may invent a phase.
    instance.noteReconnecting();
    instance.noteRecovered();
    instance.noteReopenFailed();
    expect(instance.getPhase().kind).toBe('IDLE');
  });
});

describe('subscribers see every transition and none that did not happen', () => {
  it('does not notify when a call changes nothing', () => {
    const {instance} = recovery();
    let notifications = 0;
    instance.subscribe(() => {
      notifications += 1;
    });
    instance.reset(); // already IDLE
    instance.noteSessionLost(SESSION); // nothing expected
    expect(notifications).toBe(0);
  });

  it('isolates a throwing subscriber from the others', () => {
    const {instance} = recovery();
    const reached: string[] = [];
    instance.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    instance.subscribe(() => reached.push(instance.getPhase().kind));
    instance.expectReboot(SESSION, 'CLI_SAVE');
    expect(reached).toEqual(['EXPECTED']);
  });
});
