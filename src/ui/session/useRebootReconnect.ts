/**
 * BRINGING THE BOARD BACK AFTER A REBOOT WE ASKED FOR.
 *
 * =====================================================================
 * WHY THIS EXISTS, AND WHY IT LIVES AT THE ROOT
 * =====================================================================
 *
 * A CLI `save` reboots the board on purpose. fcRebootRecovery records
 * that expectation and the root shows one blocking overlay while it
 * runs - but SOMETHING has to actually reopen the port, and for a while
 * nothing did.
 *
 * The driver used to be the connection workspace's auto-connect-on-entry:
 * the session-loss redirect sent the operator to that screen, and the
 * screen reached for the hardware. Deleting the standalone connection
 * screen deleted the driver with it, and the deletion was silent because
 * `shouldReconnectAutomatically()`, `noteReconnecting()` and
 * `noteReopenFailed()` simply stopped having callers. The result on real
 * hardware: save, overlay, forever.
 *
 * So the driver now lives where the overlay lives - the application
 * root. Whatever owns the blocking state owns getting out of it. The
 * root is always mounted, which is exactly the property the old
 * screen-bound driver lacked.
 *
 * =====================================================================
 * WHAT IT DOES, AND WHAT BOUNDS IT
 * =====================================================================
 *
 * While the lifecycle says WAITING_FOR_LINK it re-enumerates on a slow
 * poll until the board reappears, then opens it. The poll is NOT the
 * bound: fcRebootRecovery owns its own deadline timer, so every path out
 * of here is bounded even if the device never returns, returns silent,
 * or returns as a different port.
 *
 * On a terminal phase it tells the operator - one Arabic sentence on
 * Home with a retry - and resets the lifecycle so the NEXT unexpected
 * loss is read as the fault it is.
 */

import {useEffect, useRef} from 'react';

import {
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {connectionNotice} from './connectionNotice';
import {resolveConnectTarget} from './connectFlow';
import {openBoard} from './openBoard';

/**
 * How often to re-enumerate while waiting. A Betaflight reboot
 * re-enumerates in about two seconds, so this samples several times
 * before the board is expected and many times before the deadline -
 * without hammering the USB stack or, on Android, provoking anything.
 */
export const REBOOT_RESCAN_INTERVAL_MS = 700;

export function useRebootReconnect(
  client: UsbSerialTransportClient = usbSerialTransportClient,
): void {
  /** Guards against two overlapping open attempts from two ticks. */
  const openingRef = useRef(false);
  /** The session this recovery reopened and is still waiting on. */
  const reopenedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    };

    const attempt = async () => {
      if (openingRef.current) return;
      /* Re-read rather than trusting the tick that scheduled us: the
         phase can have moved on (recovered, timed out, reset) between
         the interval firing and this running. */
      if (!fcRebootRecovery.shouldReconnectAutomatically()) {
        stopPolling();
        return;
      }
      openingRef.current = true;
      try {
        /* SCANNING AND OPENING FAIL DIFFERENTLY, so they are caught
           separately. A board mid-reboot routinely makes enumeration
           throw for a tick - the USB stack is being re-entered
           underneath it - and calling that a terminal reopen failure
           would end a recovery that was about to succeed. A scan error
           is "not yet"; the lifecycle's deadline is what stops it from
           being "not ever". */
        let devices;
        try {
          devices = await client.listDevices();
        } catch {
          return;
        }
        if (!mountedRef.current) return;
        // Still ours to drive? The deadline may have fired during the scan.
        if (!fcRebootRecovery.shouldReconnectAutomatically()) return;
        const target = resolveConnectTarget(devices ?? [], null);
        if (target.kind === 'NONE') return; // Not back yet. Keep waiting.
        /* AMBIGUOUS is treated as "not yet" on purpose: a bench with two
           boards is a question for the operator, and a reboot recovery
           must never guess which one it just rebooted. The deadline ends
           it and Home asks properly. */
        if (target.kind !== 'ONE') return;
        fcRebootRecovery.noteReconnecting();
        reopenedRef.current = await openBoard(client, target.option);
        /* NOT recovered yet - see below. The lifecycle stays in
           RECONNECTING, with its deadline still running, until the board
           says what it is. */
        settleReopened();
      } catch {
        /* The device came back but would not open. That IS terminal -
           retrying a refusing port until the deadline tells the operator
           nothing and delays the truth. */
        if (mountedRef.current) fcRebootRecovery.noteReopenFailed();
      } finally {
        openingRef.current = false;
      }
    };

    /**
     * AN OPEN PORT IS NOT A RECOVERED FLIGHT CONTROLLER.
     *
     * A board can enumerate, accept the port, and then fail to identify
     * - or never answer at all. Declaring recovery at open time would
     * drop the deadline at exactly the moment the remaining wait becomes
     * unbounded, and the operator would be left on Home with no
     * workspace, no spinner and no explanation.
     *
     * So the recovery is only over when the session is VERIFIED, and
     * the lifecycle's own deadline covers identification too.
     */
    const settleReopened = () => {
      const sessionId = reopenedRef.current;
      if (sessionId === null) return;
      if (fcRebootRecovery.getPhase().kind !== 'RECONNECTING') return;
      const identification =
        mspSessionCoordinator.getIdentificationState(sessionId);
      if (identification.status === 'SUCCEEDED') {
        reopenedRef.current = null;
        fcRebootRecovery.noteRecovered();
        return;
      }
      if (
        identification.status === 'FAILED' ||
        mspSessionCoordinator.getOwnershipState(sessionId) === 'INACTIVE'
      ) {
        reopenedRef.current = null;
        fcRebootRecovery.noteReopenFailed();
      }
      // IDLE or RUNNING: keep waiting. The deadline is the bound.
    };

    const sync = () => {
      settleReopened();
      const phase = fcRebootRecovery.getPhase();
      if (phase.kind === 'WAITING_FOR_LINK') {
        if (interval === undefined) {
          interval = setInterval(() => {
            attempt().catch(() => undefined);
          }, REBOOT_RESCAN_INTERVAL_MS);
          // And one immediately, so a board that is already back does
          // not wait out a full interval for no reason.
          attempt().catch(() => undefined);
        }
        return;
      }

      stopPolling();

      /**
       * THE TERMINAL PHASES, AND WHY THEY ARE HANDLED HERE.
       *
       * The overlay simply stops rendering when the phase is no longer
       * pending - which is correct, and on its own would leave the
       * operator looking at Home with no idea what happened. A failed
       * recovery is news; a successful one is not.
       */
      if (phase.kind === 'FAILED') {
        reopenedRef.current = null;
        connectionNotice.raise('RECONNECT_FAILED');
        fcRebootRecovery.reset();
        return;
      }
      if (phase.kind === 'RECOVERED') {
        reopenedRef.current = null;
        // The wall opens the workspace off the coordinator's own state;
        // there is nothing to announce. Reset so the next loss is read
        // as the fault it would be.
        fcRebootRecovery.reset();
      }
    };

    /* Three feeds, one handler: the lifecycle itself, and the two
       coordinator signals that decide whether a reopened session became
       a real one. */
    const unsubscribes = [
      fcRebootRecovery.subscribe(sync),
      mspSessionCoordinator.subscribeIdentificationState(sync),
      mspSessionCoordinator.subscribeOwnershipState(sync),
    ];
    sync();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      stopPolling();
      reopenedRef.current = null;
    };
  }, [client]);
}
