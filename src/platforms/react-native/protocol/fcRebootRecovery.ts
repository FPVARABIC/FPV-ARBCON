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
 * WHY A DEADLINE, AND WHY THIS MODULE OWNS THE CLOCK.
 *
 * A board that never comes back must not leave the app waiting forever
 * with a spinner. The wait is bounded and its expiry is an honest FAILED
 * with a reason, not a silent return to IDLE.
 *
 * THE DEADLINE USED TO BE PASSIVE, AND THAT WAS THE BUG. This module
 * recorded a deadline and left the CHECKING to somebody else:
 * `evaluateDeadline()` carried a comment saying it was "called on every
 * tick the shell already performs", and no such tick existed - it had no
 * production caller at all. So after a CLI save the phase reached
 * WAITING_FOR_LINK and stopped there, the root overlay rendered off that
 * phase, and the only way out was reloading the page. Reported from real
 * hardware, reproduced in rebootRecoveryLiveness.test.tsx.
 *
 * A deadline nobody is scheduled to check is not a deadline. So the
 * timer lives HERE, armed on every transition into a phase that can time
 * out and cleared on every transition out of one. Nothing has to
 * remember to poll, because there is nothing to poll.
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

/**
 * WHY THE APP ASKED THE BOARD TO RESTART.
 *
 * CLI_SAVE   the operator's own `save` in the CLI, where the FIRMWARE
 *            reboots and the app only records the expectation.
 * MIXER_SAVE a mixer/topology change from Motors. The pinned Betaflight
 *            Configurator does the same thing by default - MotorsTab.vue
 *            `const handleSave = (reboot = true)` then `saveAndReboot()`
 *            -> useReboot.js -> reinitializeConnection() - so the
 *            application owns the restart and the reconnect, and the
 *            operator never presses a second button.
 */
export type FcRebootReason = 'CLI_SAVE' | 'MIXER_SAVE';

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

/**
 * A subscriber, given the phase THAT NOTIFICATION IS ABOUT.
 *
 * WHY THE ARGUMENT EXISTS. Subscribers used to read `getPhase()` back,
 * and that is not always the phase they were woken for: the root's
 * `useRebootReconnect` handles FAILED by announcing it and immediately
 * calling `reset()`, which re-enters `set()` from inside the notify loop.
 * Every subscriber that had not run yet then read IDLE and never learned
 * that the recovery had failed - so Motors could not say «تم حفظ
 * الإعداد، لكن تعذر إعادة الاتصال بالمتحكم.» because, as far as it could
 * see, nothing had gone wrong.
 *
 * Passing the phase makes each notification self-describing and
 * order-independent. Callbacks that do not care may still be plain
 * `() => void`.
 */
type Listener = (phase: FcRebootRecoveryPhase) => void;

/**
 * A single frozen IDLE instance, so a subscriber comparing snapshots by
 * reference does not see a change where nothing changed.
 */
const IDLE: FcRebootRecoveryPhase = Object.freeze({kind: 'IDLE' as const});

/** The scheduler seam, so a test can drive the clock. */
export interface FcRebootRecoveryScheduler {
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface FcRebootRecoveryOptions {
  /** Injectable for tests; production uses the real clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly scheduler?: FcRebootRecoveryScheduler;
}

/** The phases that can still time out - the ones that arm the clock. */
function isPending(phase: FcRebootRecoveryPhase): boolean {
  return (
    phase.kind === 'EXPECTED' ||
    phase.kind === 'WAITING_FOR_LINK' ||
    phase.kind === 'RECONNECTING'
  );
}

export class FcRebootRecovery {
  private phase: FcRebootRecoveryPhase = IDLE;
  private deadline: number | undefined;
  private timer: unknown;
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly scheduler: FcRebootRecoveryScheduler;

  constructor(options: FcRebootRecoveryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? FC_REBOOT_RECOVERY_TIMEOUT_MS;
    this.scheduler = options.scheduler ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
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
    /* A second save RE-ARMS rather than stacking: two live timers would
       mean the first one firing could fail a recovery the second is
       still legitimately running. */
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

  /**
   * "LOOK FOR THE BOARD AGAIN" - the operator's own retry after a
   * recovery that ran out of time.
   *
   * This is the SAME lifecycle re-entered, not a second one: it lands in
   * WAITING_FOR_LINK with a fresh deadline, which is precisely the state
   * the root's `useRebootReconnect` already knows how to drive. Nothing
   * here opens a device, and NOTHING HERE RESENDS ANY CONFIGURATION -
   * the board was asked to reboot once and the write was committed once.
   *
   * Refused unless the lifecycle is IDLE or FAILED, so a retry pressed
   * while a recovery is still legitimately running cannot restart its
   * clock and hide a genuine timeout.
   */
  retryReconnect(sessionId: string, reason: FcRebootReason): boolean {
    if (this.phase.kind !== 'IDLE' && this.phase.kind !== 'FAILED') {
      return false;
    }
    this.deadline = this.now() + this.timeoutMs;
    this.set({kind: 'WAITING_FOR_LINK', sessionId, reason});
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
   * Fire the deadline verdict now, if it is due.
   *
   * The armed timer calls this; it stays public because a caller that
   * already knows time has passed (a resumed app, a test) may ask
   * directly. It is no longer the ONLY way the deadline is noticed,
   * which is the whole fix.
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

  /**
   * ONE TIMER, ALWAYS MATCHING THE PHASE.
   *
   * Re-armed on every entry into a phase that can time out and cleared
   * on every entry into one that cannot, so a terminal state can never
   * be revisited by a late firing and a pending state can never be
   * left without a way out.
   */
  private syncTimer(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!isPending(this.phase) || this.deadline === undefined) return;
    const remaining = Math.max(0, this.deadline - this.now());
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.evaluateDeadline();
    }, remaining);
  }

  private set(phase: FcRebootRecoveryPhase): void {
    this.phase = Object.isFrozen(phase) ? phase : Object.freeze(phase);
    // Before the listeners run: a subscriber that reads getPhase() must
    // never see a pending phase with no clock behind it.
    this.syncTimer();
    const notified = this.phase;
    for (const listener of Array.from(this.listeners)) {
      try {
        /* `notified`, not `this.phase`: a listener earlier in this loop
           may already have moved the lifecycle on (reset() after FAILED
           does exactly that), and every subscriber is owed the transition
           it was actually woken for. */
        listener(notified);
      } catch {
        /* subscriber isolation, same convention as the other stores */
      }
    }
  }
}

/** The app-wide instance. One lifecycle, not one per screen. */
export const fcRebootRecovery = new FcRebootRecovery();
