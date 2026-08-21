/**
 * THE FLASHER COULD NOT OPEN A PORT THIS APPLICATION WAS ALREADY HOLDING.
 *
 * =====================================================================
 * THE DEFECT, END TO END
 * =====================================================================
 *
 * A serial port is exclusive on every platform this application runs on.
 * The Web Serial transport refuses a second open outright:
 *
 *     NativeUsbSerialTransport.web.ts, openDevice()
 *       for (const session of sessionsById.values())
 *         if (session.port === port && !session.isClosed)
 *           fail('DEVICE_ALREADY_IN_USE', 'This port already has an open session.');
 *
 * and the Android module answers the same way:
 *
 *     UsbSerialTransportModule.kt
 *       promise.reject("DEVICE_ALREADY_IN_USE",
 *         "A session is already open (or opening) for device $deviceId.")
 *
 * That is correct behaviour. The defect was WHO held the port. This
 * application deliberately keeps a verified MSP session ALIVE when the
 * operator leaves the workspace - App.tsx's own note: "Android hardware
 * Back from the workspace returns HOME WITHOUT deactivating the still-
 * active MSP session", so re-entering adopts it instead of opening a
 * second port. Excellent for the workspace. Fatal for the flasher:
 *
 *     Home -> connect -> Setup            session S holds port P
 *     back to Home                        S deliberately stays ACTIVE
 *     open Firmware Flasher
 *     press detect                        openDevice(P) -> DEVICE_ALREADY_IN_USE
 *
 * and because the transport's message is English, the flasher's
 * operatorDetail() fell through to its category fallback and told the
 * operator to RE-PLUG THE CABLE. Re-plugging cannot help: the holder is
 * this same application, in this same process. Every retry failed the
 * same way, which is exactly the "it just says try again" report.
 *
 * =====================================================================
 * WHY THE FIX BELONGS HERE AND NOT IN A BUTTON HANDLER
 * =====================================================================
 *
 * The flasher is an EXCLUSIVE-ACCESS surface: it reboots boards into
 * bootloaders and rewrites their flash. It cannot share a port, and
 * every one of its entry points (auto-detect, reboot-to-bootloader,
 * verify-after-flash) needs the same guarantee. Putting the release in
 * one press handler would fix one button and leave the others.
 *
 * So this is a primitive, called from the ONE place all three go
 * through, and it does exactly what the operator would do by hand if
 * they knew what was wrong: close the sessions this application owns.
 *
 * ORDER MATTERS, and it is the order the intentional disconnect already
 * proved (setupSessionHost.tsx): stop the read loop, close the transport
 * session, and only then deactivate MSP ownership. Closing the transport
 * first is what actually frees the port; deactivating first would leave
 * a real open port behind an ownership record that says INACTIVE - which
 * is the zombie state, not a fix for it.
 *
 * NOTHING HERE TOUCHES A BOARD. Releasing a session writes no MSP
 * command, sends no reboot and changes no configuration. It closes a
 * handle this process owns.
 */

import type {UsbSerialTransportClient} from '../transport';
import type {MspSessionCoordinator} from './MspSessionCoordinator';
import {mspSessionCoordinator} from './MspSessionCoordinator';

export interface ReleasedSessionsOutcome {
  /** Session ids this call actually closed, in the order it closed them. */
  readonly released: readonly string[];
  /**
   * Ids whose transport close REJECTED. They are still deactivated -
   * ownership must not keep claiming a session whose transport is in an
   * unknown state - but the port may genuinely still be held, so a
   * caller that then fails to open must not blame the operator's cable.
   */
  readonly closeFailures: readonly string[];
}

/**
 * Closes every MSP session this application currently owns.
 *
 * Idempotent and safe to call when nothing is open: it returns an empty
 * outcome rather than throwing, so a caller can simply always call it
 * before taking exclusive access.
 */
export async function releaseApplicationOwnedSessions(
  client: UsbSerialTransportClient,
  coordinator: MspSessionCoordinator = mspSessionCoordinator,
): Promise<ReleasedSessionsOutcome> {
  const released: string[] = [];
  const closeFailures: string[] = [];

  for (const sessionId of coordinator.listSessionIds()) {
    let closed = true;
    // Best effort, in the proven order. stopReading can legitimately
    // reject on a session whose read loop never started; that is not a
    // reason to abandon the close that actually frees the port.
    await client.stopReading(sessionId).catch(() => undefined);
    try {
      await client.closeSession(sessionId);
    } catch {
      closed = false;
    }
    /* Deactivated WHETHER OR NOT the close confirmed. An ownership
       record for a session whose transport state is unknown is worse
       than none: every screen reading ownership would keep treating a
       dead link as live. The unconfirmed close is reported instead. */
    coordinator.deactivateMspSession(sessionId);
    released.push(sessionId);
    if (!closed) closeFailures.push(sessionId);
  }

  return Object.freeze({
    released: Object.freeze(released),
    closeFailures: Object.freeze(closeFailures),
  });
}
