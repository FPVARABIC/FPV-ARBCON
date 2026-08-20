/**
 * THE ONE LIFECYCLE FOR "WE ASKED THE BOARD TO REBOOT".
 *
 * =====================================================================
 * THE DEFECT THIS EXISTS TO CLOSE
 * =====================================================================
 *
 * Reported from real use: open CLI, run commands, press save, and every
 * other screen becomes unusable. Motors reports an unknown session, no
 * motor-test session can be opened, and the other configuration screens
 * have nothing to read - while the application still looks connected.
 * The only way out was reloading the page or unplugging the cable.
 *
 * WHAT WAS ACTUALLY HAPPENING, traced end to end:
 *
 *  1. `save` makes Betaflight write EEPROM and REBOOT (cli.c: cliSave ->
 *     writeEEPROM + cliReboot). The USB device goes away.
 *  2. MspSessionCoordinator handles that correctly - the session entry is
 *     deleted, the motor-test capability is closed, ownership goes
 *     INACTIVE. (cliSessionLifecycle.test.ts proves this, against the
 *     real coordinator rather than a mock.)
 *  3. `useSessionLossRedirect` notices and resets the shell to the
 *     connection workspace - carrying `afterSessionLoss: true`, which
 *     DISABLES auto-connect, because a session that died unexpectedly
 *     should not have the app reach for the hardware on its own.
 *  4. So the operator lands on a screen waiting for them to press
 *     Connect, having pressed a button that they were told would save.
 *
 * Step 3 is right for an UNEXPECTED loss - a cable pulled out, a brown-
 * out, a board that crashed. It is wrong for the one case where the
 * application itself asked for the reboot and knows exactly when, why,
 * and which board is coming back.
 *
 * That distinction did not exist anywhere. This module is that
 * distinction, in one place, so no screen has to carry its own copy of it.
 *
 * =====================================================================
 * THE LIFECYCLE
 * =====================================================================
 *
 *   EXPECTED           save has been sent; the link is about to die
 *      |               and that is not a fault
 *      v
 *   WAITING_FOR_LINK   the session is gone, as predicted
 *      |
 *      v
 *   RECONNECTING       the device is back and a session is being opened
 *      |
 *      +--> RECOVERED  a live session exists again; every screen usable
 *      |
 *      +--> FAILED     the deadline passed, or reopening failed. The
 *                      operator is told plainly, and reconnects by hand.
 *
 * WHY A DEADLINE. A board that never comes back must not leave the app
 * waiting forever with a spinner. The wait is bounded and its expiry is
 * an honest FAILED with a reason, not a silent return to IDLE.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never opens a device
 * itself and never touches the coordinator. It owns the DECISION and the
 * phase; the connection workspace owns the hardware. Keeping those apart
 * is what stops this from becoming a second, competing connection path.
 */

/** How long the board is given to come back before this gives up. A
 *  Betaflight reboot re-enumerates in about two seconds; ten is generous
 *  without being an unbounded wait. */
export const FC_REBOOT_RECOVERY_TIMEOUT_MS = 10_000;

export type FcRebootReason = 'CLI_SAVE';

export type FcRebootRecoveryPhase =
  /** Nothing is expected; a session loss now is a genuine fault. */
  | {readonly kind: 'IDLE'}
  /** A reboot has been requested and the link has not dropped yet. */
  | {
      readonly kind: 'EXPECTED';
      readonly sessionId: string;
      readonly reason: FcRebootReason;
    }
  /** The link dropped, exactly as predicted. */
  | {
      readonly kind: 'WAITING_FOR_LINK';
      readonly sessionId: string;
      readonly reason: FcRebootReason;
    }
  /** A session is being opened for the board that came back. */
  | {readonly kind: 'RECONNECTING'; readonly reason: FcRebootReason}
  /** A live session exists again. */
  | {readonly kind: 'RECOVERED'; readonly reason: FcRebootReason}
  /** Give up, and say why. */
  | {
      readonly kind: 'FAILED';
      readonly reason: FcRebootReason;
      readonly detail: 'TIMED_OUT' | 'REOPEN_FAILED';
    };

type Listener = () => void;

/**
 * A single frozen IDLE instance, so a subscriber comparing snapshots by
 * reference does not see a change where nothing changed.
 */
const IDLE: FcRebootRecoveryPhase = Object.freeze({kind: 'IDLE' as const});

export interface FcRebootRecoveryOptions {
  /** Injectable for tests; production uses the real clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export class FcRebootRecovery {
  private phase: FcRebootRecoveryPhase = IDLE;
  private deadline: number | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: FcRebootRecoveryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? FC_REBOOT_RECOVERY_TIMEOUT_MS;
  }

  getPhase(): FcRebootRecoveryPhase {
    return this.phase;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * "We are about to make this board reboot."
   *
   * Called BEFORE the command goes out, not after, because the link can
   * die between the write and the next line of code - and a loss that
   * arrives before the expectation is recorded is indistinguishable from
   * a cable being pulled.
   */
  expectReboot(sessionId: string, reason: FcRebootReason): void {
    this.deadline = this.now() + this.timeoutMs;
    this.set({kind: 'EXPECTED', sessionId, reason});
  }

  /**
   * The session for `sessionId` has ended.
   *
   * Returns whether this loss was EXPECTED. That return value is the
   * whole point of the module: it is what lets the shell tell "the board
   * is rebooting because we asked it to" apart from "the cable came out",
   * and therefore whether to reach for the hardware again by itself.
   */
  noteSessionLost(sessionId: string): boolean {
    if (this.phase.kind !== 'EXPECTED' || this.phase.sessionId !== sessionId) {
      return false;
    }
    this.set({
      kind: 'WAITING_FOR_LINK',
      sessionId,
      reason: this.phase.reason,
    });
    return true;
  }

  /** True while the app should reconnect on its own rather than waiting
   *  for the operator to press Connect. */
  shouldReconnectAutomatically(): boolean {
    if (this.phase.kind !== 'WAITING_FOR_LINK') return false;
    if (this.expired()) {
      this.set({
        kind: 'FAILED',
        reason: this.phase.reason,
        detail: 'TIMED_OUT',
      });
      return false;
    }
    return true;
  }

  /** A device is present again and a session is being opened for it. */
  noteReconnecting(): void {
    if (this.phase.kind !== 'WAITING_FOR_LINK') return;
    this.set({kind: 'RECONNECTING', reason: this.phase.reason});
  }

  /** A live session exists again. */
  noteRecovered(): void {
    if (this.phase.kind === 'IDLE' || this.phase.kind === 'RECOVERED') return;
    this.deadline = undefined;
    this.set({kind: 'RECOVERED', reason: this.phase.reason});
  }

  /** Reopening was attempted and did not work. */
  noteReopenFailed(): void {
    if (this.phase.kind === 'IDLE') return;
    this.deadline = undefined;
    this.set({
      kind: 'FAILED',
      reason: this.phase.reason,
      detail: 'REOPEN_FAILED',
    });
  }

  /**
   * Called on every tick the shell already performs, so a board that
   * never comes back ends in FAILED rather than in a permanent wait.
   */
  evaluateDeadline(): void {
    if (
      (this.phase.kind === 'EXPECTED' ||
        this.phase.kind === 'WAITING_FOR_LINK' ||
        this.phase.kind === 'RECONNECTING') &&
      this.expired()
    ) {
      this.deadline = undefined;
      this.set({
        kind: 'FAILED',
        reason: this.phase.reason,
        detail: 'TIMED_OUT',
      });
    }
  }

  /** Back to "nothing is expected". Called once the operator has seen a
   *  terminal phase, so the next unexpected loss is treated as a fault. */
  reset(): void {
    if (this.phase.kind === 'IDLE') return;
    this.deadline = undefined;
    this.set(IDLE);
  }

  private expired(): boolean {
    return this.deadline !== undefined && this.now() >= this.deadline;
  }

  private set(phase: FcRebootRecoveryPhase): void {
    this.phase = Object.isFrozen(phase) ? phase : Object.freeze(phase);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        /* subscriber isolation, same convention as the other stores */
      }
    }
  }
}

/** The app-wide instance. One lifecycle, not one per screen. */
export const fcRebootRecovery = new FcRebootRecovery();
