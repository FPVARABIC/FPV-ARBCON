jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * THE OVERLAY THAT NEVER LEFT.
 *
 * =====================================================================
 * WHAT WAS REPORTED, FROM REAL HARDWARE
 * =====================================================================
 *
 * Open CLI, press save, the board reboots, the CLI window closes, the
 * root overlay appears saying "جارٍ إعادة تشغيل متحكم الطيران وإعادة
 * الاتصال…" - and stays there. Forever. The only way out was reloading
 * the page.
 *
 * =====================================================================
 * WHY, TRACED END TO END
 * =====================================================================
 *
 * FcRebootRecovery recorded a DEADLINE but owned no CLOCK. `expired()`
 * was only ever consulted by `evaluateDeadline()`, and
 * `evaluateDeadline()` had no production caller at all - its doc comment
 * said "called on every tick the shell already performs", and no such
 * tick existed. Nothing was scheduled to fire at the deadline, so the
 * deadline could pass without anything noticing.
 *
 * And the thing that used to drive the reconnect - the connection
 * workspace's auto-connect on arrival - was deleted along with the
 * standalone connection screen. `shouldReconnectAutomatically()`,
 * `noteReconnecting()` and `noteReopenFailed()` were left with no
 * production caller either.
 *
 * So after `save`: EXPECTED -> (session dies) -> WAITING_FOR_LINK ->
 * nothing. No reconnect attempt, no deadline evaluation, no terminal
 * state. `rebootInFlight()` reports true for WAITING_FOR_LINK, so the
 * root overlay renders and never stops.
 *
 * These tests hold the fix at BOTH ends: the lifecycle ends on its own
 * clock, and something actually tries to bring the board back.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import '../../i18n';
import {
  FcRebootRecovery,
  FC_REBOOT_RECOVERY_TIMEOUT_MS,
} from '../../platforms/react-native/protocol/fcRebootRecovery';

describe('the reboot lifecycle ends on its own clock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * THE REPRODUCTION. Nothing is called after the loss - exactly the
   * field report - and the phase must still reach a terminal state.
   */
  it('reaches FAILED after the deadline with NOBODY polling it', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    expect(recovery.getPhase().kind).toBe('WAITING_FOR_LINK');

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);

    const phase = recovery.getPhase();
    expect(phase.kind).toBe('FAILED');
    if (phase.kind !== 'FAILED') throw new Error('unreachable');
    expect(phase.detail).toBe('TIMED_OUT');
  });

  it('tells its subscribers when the deadline fires, without being asked', () => {
    const recovery = new FcRebootRecovery();
    const seen: string[] = [];
    recovery.subscribe(() => seen.push(recovery.getPhase().kind));
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    seen.length = 0;

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);

    expect(seen).toContain('FAILED');
  });

  /** A board that never comes back at all - no detach, no return. */
  it('times out from EXPECTED when the link never even drops', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);

    expect(recovery.getPhase().kind).toBe('FAILED');
  });

  /** A device that reappears but whose session will not open. */
  it('times out from RECONNECTING when the reopen never finishes', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    recovery.noteReconnecting();
    expect(recovery.getPhase().kind).toBe('RECONNECTING');

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);

    expect(recovery.getPhase().kind).toBe('FAILED');
  });

  /**
   * SUCCESS MUST DISARM THE CLOCK. A recovered session that then gets a
   * late timeout would put a working application back into a failure it
   * has already left.
   */
  it('cannot be timed out after it has recovered', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    recovery.noteRecovered();

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS * 5);

    expect(recovery.getPhase().kind).toBe('RECOVERED');
  });

  it('cannot be timed out after an explicit reopen failure', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    recovery.noteReopenFailed();
    const before = recovery.getPhase();

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS * 5);

    expect(recovery.getPhase()).toBe(before);
  });

  it('cannot be timed out after being reset', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    recovery.noteSessionLost('usb-1');
    recovery.reset();

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS * 5);

    expect(recovery.getPhase().kind).toBe('IDLE');
  });

  /**
   * A SECOND SAVE RE-ARMS RATHER THAN STACKING. Two live timers would
   * mean the first one firing could fail a recovery the second one is
   * still legitimately running.
   */
  it('re-arms on a second expectation instead of stacking timers', () => {
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS - 100);
    recovery.expectReboot('usb-2', 'CLI_SAVE');

    // The FIRST deadline would have fired here; the second must not have.
    jest.advanceTimersByTime(200);
    expect(recovery.getPhase().kind).toBe('EXPECTED');

    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS);
    expect(recovery.getPhase().kind).toBe('FAILED');
  });

  /** Nothing may be left running once the lifecycle is over. */
  it('leaves no pending timer behind in any terminal state', () => {
    for (const finish of [
      (r: FcRebootRecovery) => r.noteRecovered(),
      (r: FcRebootRecovery) => r.noteReopenFailed(),
      (r: FcRebootRecovery) => r.reset(),
    ]) {
      jest.clearAllTimers();
      const recovery = new FcRebootRecovery();
      recovery.expectReboot('usb-1', 'CLI_SAVE');
      recovery.noteSessionLost('usb-1');
      finish(recovery);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it('leaves no pending timer behind after timing out', () => {
    jest.clearAllTimers();
    const recovery = new FcRebootRecovery();
    recovery.expectReboot('usb-1', 'CLI_SAVE');
    jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);
    expect(recovery.getPhase().kind).toBe('FAILED');
    expect(jest.getTimerCount()).toBe(0);
  });
});

/**
 * THE FIELD REPORT, END TO END, THROUGH THE REAL APPLICATION.
 *
 * The unit tests above prove the lifecycle now ends itself. This proves
 * the thing the operator actually saw: after a CLI save with a board
 * that never comes back, the overlay is gone, the workspace is not
 * mounted, Home is, and there is a retry to press. No refresh.
 */
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {connectionNotice} from './connectionNotice';
import App from '../../../App';

describe('cli save cannot leave the reboot recovery overlay indefinitely', () => {
  let listeners: Array<() => void> = [];

  beforeEach(() => {
    jest.useFakeTimers();
    listeners = [];
    jest.restoreAllMocks();
    connectionNotice.clear();
    fcRebootRecovery.reset();
    const remember = (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    };
    jest
      .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
      .mockImplementation(remember as never);
    jest
      .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
      .mockImplementation(remember as never);
    // NO BOARD, ever. This is scenario C: the reboot happens and the
    // flight controller never comes back.
    jest.spyOn(mspSessionCoordinator, 'listSessionIds').mockImplementation(() => []);
    jest
      .spyOn(mspSessionCoordinator, 'getOwnershipState')
      .mockImplementation(() => 'INACTIVE');
    jest
      .spyOn(mspSessionCoordinator, 'getSessionKey')
      .mockImplementation(() => undefined);
    jest
      .spyOn(mspSessionCoordinator, 'getIdentificationState')
      .mockImplementation(() => ({status: 'IDLE'}) as never);
  });

  afterEach(() => {
    fcRebootRecovery.reset();
    connectionNotice.clear();
    jest.useRealTimers();
  });

  it('ends in Home with a retry once the deadline passes, without a refresh', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<App />);
    });
    const has = (testID: string) =>
      renderer.root.findAllByProps({testID}).length > 0;

    // The CLI save: the expectation is recorded, then the board goes.
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-1');
      for (const listener of [...listeners]) listener();
    });
    expect(has('reboot-overlay')).toBe(true);

    // The board never returns. Time passes - and nothing else happens.
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 2_000);
    });

    // THE OVERLAY IS GONE.
    expect(has('reboot-overlay')).toBe(false);
    // The lifecycle is terminal, not stuck mid-flight.
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    // No stale session survived it.
    expect(mspSessionCoordinator.listSessionIds()).toEqual([]);
    // The configuration workspace is not mounted; Home is.
    expect(has('main-tabs')).toBe(false);
    expect(has('start-screen')).toBe(true);
    // And the operator is told why, with something to press.
    expect(has('home-reconnect-failed')).toBe(true);
    expect(has('home-reconnect-retry')).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  /** The overlay must not outlive its own reason under any ordering. */
  it('never renders the overlay once the lifecycle is terminal', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<App />);
    });
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      for (const listener of [...listeners]) listener();
    });
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);
    });
    expect(renderer.root.findAllByProps({testID: 'reboot-overlay'}).length).toBe(0);

    // A late, duplicate loss notification for the dead session must not
    // resurrect it.
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost('usb-1');
      for (const listener of [...listeners]) listener();
    });
    expect(renderer.root.findAllByProps({testID: 'reboot-overlay'}).length).toBe(0);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
