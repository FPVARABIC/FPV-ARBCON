/**
 * Phase 2E - the MOTOR-TEST LIFECYCLE / NAVIGATION STOP BRIDGE.
 *
 * WHAT THIS IS
 * ------------
 * The narrow adapter between the platform's lifecycle events and the
 * accepted controller's whitelist-only `requestStop`. It listens; it
 * decides which accepted trigger a platform event means; it records ONE
 * authority-bound stop obligation per authority. That is all.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * It constructs no MSP frame, names no command, owns no transport, no
 * client, no lease and no writer. Its only outbound call is
 * `controller.requestStop(<accepted trigger>)`. There is no path from any
 * listener here to a motor command, and none can be added without
 * changing the controller's own public surface.
 *
 * THE FOUR STATEMENTS, KEPT APART
 * -------------------------------
 *   1. stop requested          <- THIS is all Phase 2E represents
 *   2. stop execution attempted
 *   3. protocol ACK received
 *   4. physical stop confirmed
 * This bridge produces (1) and nothing else. `StopObligation.resolved`
 * means "the reducer accepted the request", never "a motor stopped".
 * Phase 2F owns executing and retrying; no field here may be read as
 * evidence of (2), (3) or (4).
 *
 * ANDROID BACK AND PREDICTIVE BACK
 * --------------------------------
 * Verified against the installed sources for THIS configuration (RN
 * 0.86.0, New Architecture on, targetSdk 36):
 *
 *   ReactActivity.java:29  "Due to enforced predictive back on targetSdk
 *                          36, 'onBackPressed()' is disabled by default."
 *   ReactActivity.java:31  mBackPressedCallback = OnBackPressedCallback(true)
 *   ReactActivity.java:63  getOnBackPressedDispatcher().addCallback(...)
 *   ReactActivity.java:36  handleOnBackPressed() -> onBackPressed()
 *   ReactActivity.java:116 mDelegate.onBackPressed()
 *   ReactDelegate.kt       bridgeless -> reactHost.onBackPressed()
 *   ReactHostImpl.kt:356   emitHardwareBackPressed()
 *   DeviceEventManagerModule.kt:40  emitDeviceEvent("hardwareBackPress")
 *   BackHandler.android.js:16       DEVICE_BACK_EVENT = 'hardwareBackPress'
 *
 * A COMMITTED predictive-back gesture and a classic back press therefore
 * converge on the SAME JavaScript event. This bridge takes exactly one
 * `BackHandler` subscription for it and reports the truthful shared
 * reason `ANDROID_BACK`. It does NOT synthesise `ANDROID_PREDICTIVE_BACK`
 * - that accepted reason stays reserved for a future native discriminator.
 *
 * This proves COMMITTED predictive back coverage only. It does not prove
 * gesture-start, gesture-progress, gesture-cancellation, or origin
 * discrimination, and nothing here claims otherwise.
 *
 * BLUR IS NOT PROOF THAT NAVIGATION WAITED. Observing `blur` means the
 * screen has already lost focus; the transition was not held for the
 * stop. Only the cancellable pre-removal path can hold it, and only where
 * the navigator actually offers one.
 */

import type {MotorTestController} from '../../../core/state/motorTestController';
import type {MotorTestStopTriggerReason} from '../../../core/state/motorTestStateMachine';

/* ------------------------------------------------------------------ *
 * Platform seams
 * ------------------------------------------------------------------ */

export type MotorTestAppStateStatus =
  | 'active'
  | 'background'
  | 'inactive'
  | 'extension'
  | 'unknown'
  | string;

export interface MotorTestSubscription {
  remove(): void;
}

/**
 * The narrow slice of the platform this bridge needs.
 *
 * Every member is a subscription; none can send anything. Supplied by the
 * hosting screen in a later phase, and by controlled doubles in tests -
 * the bridge's own logic is never reimplemented on either side.
 */
export interface MotorTestLifecycleSources {
  /** `BackHandler.addEventListener('hardwareBackPress', ...)`. The
   * listener's boolean return CONSUMES the event when true. */
  addBackHandler?(listener: () => boolean): MotorTestSubscription;
  /** `AppState.addEventListener('change', ...)`. */
  addAppStateListener?(
    listener: (status: MotorTestAppStateStatus) => void,
  ): MotorTestSubscription;
  /** React Navigation `navigation.addListener('blur', ...)`. */
  addBlurListener?(listener: () => void): () => void;
  /**
   * React Navigation `navigation.addListener('beforeRemove', ...)`. The
   * event object's `preventDefault()` is the only genuine way to hold a
   * transition; where the navigator does not provide one, removal cannot
   * be prevented and this bridge says so rather than pretending.
   */
  addBeforeRemoveListener?(
    listener: (event: {preventDefault?: () => void}) => void,
  ): () => void;
}

/* ------------------------------------------------------------------ *
 * Stop obligations
 * ------------------------------------------------------------------ */

export type MotorTestStopObligationOutcome =
  /** The reducer accepted the request. NOT a claim that a motor stopped. */
  | 'REQUEST_ACCEPTED'
  /** The controller refused the trigger. */
  | 'REQUEST_REJECTED'
  /** The controller was already closed. */
  | 'CONTROLLER_CLOSED'
  /** A listener or the controller threw. Fails closed. */
  | 'REQUEST_THREW';

/**
 * ONE obligation per authority.
 *
 * `triggers` accumulates every reason that joined it, in arrival order,
 * so a later trigger REINFORCES rather than replaces. There is no field
 * that could cancel or weaken an obligation, because no such operation
 * exists.
 */
export interface MotorTestStopObligation {
  /** The authority identity captured SYNCHRONOUSLY when the obligation
   * was created. Compared by reference. */
  readonly authority: object;
  readonly triggers: readonly MotorTestStopTriggerReason[];
  readonly outcomes: readonly MotorTestStopObligationOutcome[];
  /** True once at least one request was accepted by the reducer. This is
   * statement (1) only - never (2), (3) or (4). */
  readonly requestAccepted: boolean;
}

export interface MotorTestLifecycleSnapshot {
  readonly attached: boolean;
  /** The single live obligation, or undefined. */
  readonly obligation: MotorTestStopObligation | undefined;
  /** How many Back/removal events were consumed while an obligation was
   * unresolved. */
  readonly consumedNavigationEvents: number;
  /** How many times a held navigation was replayed. Capped at one. */
  readonly navigationReplays: number;
  /**
   * Permanently false in Phase 2E. No descriptor, reducer transition or
   * ACK proves a motor physically stopped, and nothing in this bridge may
   * be read as if it did.
   */
  readonly physicalStopConfirmed: false;
}

export interface MotorTestLifecycleBridgeOptions {
  readonly controller: MotorTestController;
  readonly sources: MotorTestLifecycleSources;
  /**
   * Called at most once, after a consumed navigation's obligation has a
   * decided outcome, to let the host replay the transition it held.
   * Never called on failure, cancellation, stale authority or an unknown
   * outcome - see `replayNavigation`.
   */
  readonly replayNavigation?: () => void;
}

export interface MotorTestLifecycleBridge {
  attach(): void;
  detach(): void;
  getSnapshot(): MotorTestLifecycleSnapshot;
  /** Test/host seam for delivering a platform event the sources did not
   * cover. Whitelist-only, exactly like the controller's own surface. */
  handleTrigger(trigger: MotorTestStopTriggerReason): void;
}

/** The accepted triggers this bridge is allowed to originate. Every entry
 * is an accepted `MotorTestStopTriggerReason`; `ANDROID_PREDICTIVE_BACK`
 * is deliberately ABSENT (see the header). */
export const MOTOR_TEST_LIFECYCLE_TRIGGERS: readonly MotorTestStopTriggerReason[] =
  Object.freeze([
    'NAVIGATION_BLURRED',
    'ANDROID_BACK',
    'APP_STATE_BACKGROUNDED',
  ] as const);

/**
 * The states in which a lifecycle trigger describes a POSSIBLY LIVE motor
 * command. Outside these, cleanup still happens but no claim is made.
 */
const LIVE_STATES: ReadonlySet<string> = new Set([
  'Starting',
  'Pulsing',
  'Stopping',
]);

interface MutableObligation {
  readonly authority: object;
  triggers: MotorTestStopTriggerReason[];
  outcomes: MotorTestStopObligationOutcome[];
  requestAccepted: boolean;
}

class LifecycleBridge implements MotorTestLifecycleBridge {
  private readonly controller: MotorTestController;
  private readonly sources: MotorTestLifecycleSources;
  private readonly replay: (() => void) | undefined;

  private attached = false;
  private obligation: MutableObligation | undefined;
  private consumed = 0;
  private replays = 0;
  private navigationHeld = false;
  private teardownFns: (() => void)[] = [];

  constructor(options: MotorTestLifecycleBridgeOptions) {
    this.controller = options.controller;
    this.sources = options.sources;
    this.replay = options.replayNavigation;
  }

  /* --- lifecycle -------------------------------------------------- */

  attach(): void {
    // Idempotent: a remount, a double-invoked effect under Strict Mode,
    // or a duplicated call must never produce two live subscriptions.
    if (this.attached) {
      return;
    }
    this.attached = true;
    const registered: (() => void)[] = [];
    try {
      const back = this.sources.addBackHandler?.(() => this.onBackPressed());
      if (back !== undefined) {
        registered.push(() => {
          back.remove();
        });
      }
      const appState = this.sources.addAppStateListener?.(status => {
        this.onAppStateChanged(status);
      });
      if (appState !== undefined) {
        registered.push(() => {
          appState.remove();
        });
      }
      const blur = this.sources.addBlurListener?.(() => {
        this.onBlur();
      });
      if (blur !== undefined) {
        registered.push(blur);
      }
      const beforeRemove = this.sources.addBeforeRemoveListener?.(event => {
        this.onBeforeRemove(event);
      });
      if (beforeRemove !== undefined) {
        registered.push(beforeRemove);
      }
    } catch (error) {
      // A registration that throws must roll back the ones already made,
      // so a partially attached bridge is never observable.
      for (const undo of registered.splice(0).reverse()) {
        try {
          undo();
        } catch {
          // one failure must not skip the rest
        }
      }
      this.attached = false;
      throw error;
    }
    this.teardownFns = registered;
  }

  detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
    // Reverse order, each guarded, so one throwing removal cannot leak
    // the others.
    for (const undo of this.teardownFns.splice(0).reverse()) {
      try {
        undo();
      } catch {
        // absorbed deliberately
      }
    }
  }

  getSnapshot(): MotorTestLifecycleSnapshot {
    return Object.freeze({
      attached: this.attached,
      obligation: this.obligation === undefined
        ? undefined
        : Object.freeze({
            authority: this.obligation.authority,
            triggers: Object.freeze([...this.obligation.triggers]),
            outcomes: Object.freeze([...this.obligation.outcomes]),
            requestAccepted: this.obligation.requestAccepted,
          }),
      consumedNavigationEvents: this.consumed,
      navigationReplays: this.replays,
      physicalStopConfirmed: false as const,
    });
  }

  /* --- the one entry point into the controller -------------------- */

  handleTrigger(trigger: MotorTestStopTriggerReason): void {
    // (1) Capture the authority SYNCHRONOUSLY, before anything is awaited
    // or any listener can interleave. `getSnapshot()` is a plain field
    // read on the controller, so this cannot yield.
    const snapshot = this.controller.getSnapshot();
    const authority = snapshot.machine?.authority;
    if (authority === undefined) {
      // No live motor authority (Checking before the lease, or already
      // torn down). Nothing to bind an obligation to, and inventing one
      // would claim a stop that has no session. Cleanup only.
      return;
    }

    // (2) Register the obligation BEFORE the request. A stale authority
    // never joins a newer one: a changed authority starts a new
    // obligation rather than reinforcing the old.
    if (this.obligation === undefined || this.obligation.authority !== authority) {
      this.obligation = {
        authority,
        triggers: [],
        outcomes: [],
        requestAccepted: false,
      };
    }
    const obligation = this.obligation;
    obligation.triggers.push(trigger);

    // (3) One request per trigger, joining the SAME obligation. There is
    // no second competing stop operation: `requestStop` is idempotent at
    // the reducer, and a repeat means "still required".
    let outcome: MotorTestStopObligationOutcome;
    try {
      const result = this.controller.requestStop(trigger);
      outcome =
        result === 'ACCEPTED'
          ? 'REQUEST_ACCEPTED'
          : result === 'CONTROLLER_CLOSED'
            ? 'CONTROLLER_CLOSED'
            : 'REQUEST_REJECTED';
    } catch {
      // Fails closed: recorded, never swallowed into an apparent success.
      outcome = 'REQUEST_THREW';
    }
    obligation.outcomes.push(outcome);
    if (outcome === 'REQUEST_ACCEPTED') {
      obligation.requestAccepted = true;
    }
  }

  /* --- sources ---------------------------------------------------- */

  /** Whether a lifecycle event currently describes a possibly-live
   * command, i.e. whether navigation must be held. */
  private hasUnresolvedLiveStop(): boolean {
    const state = this.controller.getSnapshot().machine;
    if (state === undefined) {
      return false;
    }
    if (LIVE_STATES.has(state.name)) {
      return true;
    }
    // Correction: a Fault whose activation may still be live keeps the
    // obligation alive. Fault stays terminal - this never recovers it -
    // but the stop must not be silently dropped just because the reducer
    // already faulted.
    return state.name === 'Fault' && state.startMayHaveReachedFc;
  }

  /**
   * The ONE Back subscription. Returning true consumes the event.
   *
   * Consumes while a matching-authority stop is unresolved, so the app
   * does not navigate away from a possibly-spinning motor. Returns false
   * otherwise, letting React Navigation or `exitApp()` proceed normally.
   */
  private onBackPressed(): boolean {
    try {
      const live = this.hasUnresolvedLiveStop();
      this.handleTrigger('ANDROID_BACK');
      if (live) {
        this.consumed += 1;
        this.navigationHeld = true;
        return true;
      }
      return false;
    } catch {
      // A throwing handler must fail CLOSED: consume rather than let a
      // transition proceed on an unknown state.
      this.consumed += 1;
      this.navigationHeld = true;
      return true;
    }
  }

  private onBeforeRemove(event: {preventDefault?: () => void}): void {
    try {
      const live = this.hasUnresolvedLiveStop();
      this.handleTrigger('ANDROID_BACK');
      if (!live) {
        return;
      }
      this.consumed += 1;
      this.navigationHeld = true;
      // Only a genuine preventDefault can hold the transition. Where the
      // navigator offers none, removal happens anyway and this bridge
      // does not pretend it was held.
      event.preventDefault?.();
    } catch {
      this.consumed += 1;
      this.navigationHeld = true;
      event.preventDefault?.();
    }
  }

  /** Blur still raises the obligation, but observing it is NOT proof that
   * navigation waited - the screen has already lost focus by then. */
  private onBlur(): void {
    this.handleTrigger('NAVIGATION_BLURRED');
  }

  private onAppStateChanged(status: MotorTestAppStateStatus): void {
    // `active` alone never fabricates a stop. Anything that is not a
    // recognised foreground state is treated as leaving the foreground -
    // a null or unknown status fails CLOSED rather than being ignored.
    if (status === 'active') {
      return;
    }
    this.handleTrigger('APP_STATE_BACKGROUNDED');
  }

  /**
   * Replays a held navigation AT MOST ONCE, and only when the obligation
   * reached a decided, accepted outcome under the SAME authority.
   *
   * Failure, rejection, a throw, a stale authority or an unknown result
   * is never converted into successful navigation. The flag is cleared
   * before the callback runs, so a replay that itself triggers navigation
   * cannot recurse.
   */
  releaseHeldNavigation(): boolean {
    if (!this.navigationHeld || this.replays > 0) {
      return false;
    }
    const obligation = this.obligation;
    if (obligation === undefined || !obligation.requestAccepted) {
      return false;
    }
    const current = this.controller.getSnapshot().machine?.authority;
    if (current !== obligation.authority) {
      // The session was replaced under us. Releasing now would publish a
      // stale success into a new session.
      return false;
    }
    this.navigationHeld = false;
    this.replays += 1;
    this.replay?.();
    return true;
  }
}

export interface MotorTestLifecycleBridgeHandle
  extends MotorTestLifecycleBridge {
  /** Attempts the single held-navigation replay. Returns whether it ran. */
  releaseHeldNavigation(): boolean;
}

/**
 * The production factory - the only way to build the bridge.
 *
 * Returns a frozen facade, so the capability surface is fixed at
 * construction: no controller, no sources and no internal counter is
 * reachable, and nothing can be added that could reach a writer.
 */
export function createMotorTestLifecycleBridge(
  options: MotorTestLifecycleBridgeOptions,
): MotorTestLifecycleBridgeHandle {
  const bridge = new LifecycleBridge(options);
  return Object.freeze({
    attach: () => {
      bridge.attach();
    },
    detach: () => {
      bridge.detach();
    },
    getSnapshot: () => bridge.getSnapshot(),
    handleTrigger: (trigger: MotorTestStopTriggerReason) => {
      bridge.handleTrigger(trigger);
    },
    releaseHeldNavigation: () => bridge.releaseHeldNavigation(),
  });
}
