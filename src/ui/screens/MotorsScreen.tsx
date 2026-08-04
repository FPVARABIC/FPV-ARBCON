/**
 * Phase 2H - the real Arabic motor-test screen.
 *
 * WHAT THIS FILE IS. A presentation and gesture layer over the accepted
 * controller, reached through the ONE official binding. It renders state
 * and forwards intent. It is not, and must never become, a safety
 * authority.
 *
 * WHAT IT STRUCTURALLY CANNOT DO - by construction, not by convention:
 *   - It never imports or calls `writeBytes`, a transport, an `MspClient`,
 *     a lease, an encoder or a motor vector.
 *   - It never names command 214, 1050 or 1000, and never builds a
 *     payload. The only motor-shaped value it handles is an output slot
 *     number, 1..4, which it hands to the controller unchanged.
 *   - It never creates a second session, authority, controller or queue.
 *     Its only timer is a touch-owner heartbeat: it cannot start a motor
 *     and merely renews the controller's short fail-safe while the same
 *     Pressable still owns the gesture.
 *   - It re-derives NO safety condition. Armed state, lease, authority,
 *     scope and capability are evaluated once, in the controller, and read
 *     here as `snapshot.activation` - the SAME evaluation `pulseMotor()`
 *     itself performs. Battery suitability is an explicit bench warning and
 *     is never presented as an automatic controller fact.
 *
 * WHY `Ready` IS NOT THE GATE. Phase 2G established that a locking safety
 * event arriving while idle leaves the accepted reducer in `Ready` - it
 * correctly refuses to manufacture stop traffic for an activation that
 * never began - while activation must nonetheless be barred. So this
 * screen gates on `activation.allowed`, never on the reducer state alone.
 *
 * WHAT AN ACKNOWLEDGEMENT MEANS HERE. An MSP ACK proves the flight
 * controller received and processed a command. It never proves a motor
 * turned, at what speed, in which direction, or that any motor stopped.
 * No string in this file claims otherwise, and a test asserts it.
 *
 * Bench warnings are always visible, but there is no checkbox ritual and
 * no separate "start session" ceremony. The first intentional long press
 * lazily prepares the protected session; a release during that preparation
 * starts nothing.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../theme';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
} from '../../core/state/motorTestController';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import { mspSessionCoordinator } from '../../platforms/react-native/protocol';
import type { SetupUiSessionKey } from '../../platforms/react-native/protocol';
import { createMotorTestLifecycleBridge } from '../../platforms/react-native/lifecycle/motorTestLifecycleBridge';
import {
  readMotorTestCapability,
  subscribeMotorTestCapabilityOpened,
} from '../../platforms/react-native/protocol/motorTestCapability';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { AppState, BackHandler } from 'react-native';
import {
  MotorVerificationWizard,
  MotorTestReport,
} from './MotorVerificationWizard';
import {
  abortVerificationAsUnsafe,
  beginVerification,
  confirmedCount,
  confirmObservation,
  EMPTY_VERIFICATION_STATE,
  expectedFor,
  finalizeVerification,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type { MotorTestVerificationReceipt } from '../../core/state/motorTestController';
import { MotorAirframeDiagram } from './MotorAirframeDiagram';
import { MotorConfigurationSummary } from './MotorConfigurationSummary';
import { MotorConfigurationPanel } from './MotorConfigurationPanel';
import { MotorDiagnosticsPanel } from './MotorDiagnosticsPanel';
import { MotorOutputReorderPanel } from './MotorOutputReorderPanel';
import { EscDirectionPanel } from './EscDirectionPanel';

// Kept as public exports for the payload-identity and screen contract tests.
// Their implementation lives with the diagram so slot geometry has one
// source of truth.
export {
  computeMotorGlyphLayout,
  motorGlyphRows,
} from './MotorAirframeDiagram';

/**
 * The intentional long-press delay. No accepted shared constant exists
 * (searched, not assumed), so it is defined once, here, and used by the
 * single Pressable below.
 */
export const MOTOR_TEST_LONG_PRESS_DELAY_MILLIS = 800;
export const MOTOR_TEST_HOLD_HEARTBEAT_INTERVAL_MILLIS = 300;

/** MSP OUTPUT SLOTS. Not airframe positions, not rotation directions. */
export const MOTOR_TEST_OUTPUT_SLOTS: readonly number[] = Object.freeze([
  1, 2, 3, 4,
]);

/**
 * How the screen presents the controller. Derived ONLY from the snapshot -
 * never from a local flag, and never from whether a Promise happens to be
 * outstanding.
 */
export type MotorsScreenPresentation =
  | 'NO_SESSION'
  | 'CHECKING'
  | 'LOCKED'
  /**
   * The reducer is back in `Ready` after a confirmed stop, and the
   * controller is taking one fresh armed-state reading before it will arm
   * the control again.
   *
   * DISTINCT FROM `LOCKED` ON PURPOSE. Nothing went wrong here, and a
   * session that is simply re-checking is not a session that needs
   * operator action. Calling it locked also had a concrete cost: the
   * manual acknowledgement reset was keyed on LOCKED, so every normal
   * release wiped all three checkboxes and made the operator re-tick them
   * before touching the next motor.
   */
  | 'VERIFYING'
  | 'READY'
  /** A command was submitted and no attributable response has arrived. It
   * may already be live, so this is stop-dominant. */
  | 'SUBMITTED_AWAITING_RESPONSE'
  /** The FC acknowledged reception. NOT a claim of rotation. */
  | 'ACKNOWLEDGED'
  | 'STOPPING'
  | 'FAULT';

/**
 * ROOT CAUSES FIRST, CONSEQUENCES LAST. The screen shows exactly one of
 * these - the first that is present - and keeps the whole array behind the
 * collapsed developer diagnostics.
 *
 * The ordering is a statement about WHAT THE OPERATOR SHOULD DO, and each
 * position is deliberate:
 *
 *   FC_ARMED first, always. It is the most dangerous state the flight
 *     controller can report and it has an unambiguous instruction. It also
 *     forces REQUIRES_NEW_CONNECTION into the list alongside it (an armed
 *     reading locks the session), and being told to reconnect instead of
 *     being told the aircraft is armed would be a serious regression.
 *
 *   ARMED_STATE_UNKNOWN_OR_STALE next, for the same reason one step
 *     weaker: a monitoring failure also locks and faults the session, so
 *     it too arrives paired with REQUIRES_NEW_CONNECTION and must outrank
 *     it.
 *
 *   Firmware identity/compatibility next. A decoded configuration cannot
 *     authorize writes until its firmware family and API adapter match.
 *
 *   MOTOR_3D_ENABLED before MOTOR_SCOPE_UNSUPPORTED, because 3D is a
 *     single named setting the operator can turn off, while "unsupported
 *     scope" covers motor count and protocol.
 *
 *   REQUIRES_NEW_CONNECTION before CONTROLLER_LINK_UNAVAILABLE, because a
 *     terminal fault always drags a dead link along with it and the fault
 *     is the actionable half.
 *
 *   CONTROLLER_LINK_UNAVAILABLE last. It is what EVERY teardown produces,
 *     so it is only ever the story when nothing else is present.
 */
export const CAUSAL_BLOCK_REASON_ORDER: readonly MotorTestActivationBlockReason[] =
  Object.freeze([
    'FC_ARMED',
    'ARMED_STATE_UNKNOWN_OR_STALE',
    'FIRMWARE_IDENTITY_UNAVAILABLE',
    'FIRMWARE_UNSUPPORTED',
    'MOTOR_3D_ENABLED',
    'MOTOR_SCOPE_UNSUPPORTED',
    'PULSE_OR_STOP_IN_PROGRESS',
    'REQUIRES_NEW_CONNECTION',
    'CONTROLLER_LINK_UNAVAILABLE',
  ]);

export function derivePresentation(
  snapshot: MotorTestControllerSnapshot | undefined,
): MotorsScreenPresentation {
  if (snapshot === undefined || snapshot.machine === undefined) {
    return 'NO_SESSION';
  }
  switch (snapshot.machine.name) {
    case 'Checking':
      return 'CHECKING';
    case 'Locked':
      return 'LOCKED';
    case 'Ready': {
      // R1: `Ready` is the REDUCER's state, not a statement that anything
      // may be started. When the authoritative gate refuses activation,
      // presenting an actionable READY would tell the operator something
      // untrue.
      if (snapshot.activation.allowed) {
        return 'READY';
      }
      // WHICH KIND OF "not yet" IS THIS? A session whose ONLY outstanding
      // reason is that the armed state has not been re-read is mid-cycle,
      // not broken - it is the few milliseconds after a confirmed stop
      // while the fresh observation is in flight. Anything else, including
      // anything terminal, is a genuine lock.
      const onlyReason =
        snapshot.activation.reasons.length === 1
          ? snapshot.activation.reasons[0]
          : undefined;
      return onlyReason === 'ARMED_STATE_UNKNOWN_OR_STALE'
        ? 'VERIFYING'
        : 'LOCKED';
    }
    case 'Starting':
      return 'SUBMITTED_AWAITING_RESPONSE';
    case 'Pulsing':
      // The accepted reducer enters Pulsing at the WRITE CALL, before any
      // acknowledgement, because that is when the command may be live.
      // Presenting both the same way would claim something unproven.
      return snapshot.machine.startAcknowledged
        ? 'ACKNOWLEDGED'
        : 'SUBMITTED_AWAITING_RESPONSE';
    case 'Stopping':
      return 'STOPPING';
    case 'Fault':
      return 'FAULT';
    default:
      return 'NO_SESSION';
  }
}

/**
 * Whether a motor command may currently be live, and therefore whether a
 * release, cancellation or Stop press must reach the controller. Read from
 * the controller's own latched record, never from a local flag.
 */
export function commandMayBeLive(
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  return snapshot?.pulse.mayHaveReachedFc === true;
}

/**
 * Whether the operator must be told to disconnect the LiPo RIGHT NOW.
 *
 * THE DEFECT THIS CLOSES, from the device. The red banner was driven by
 * the FAULT presentation alone, so ANY fault printed "stop could not be
 * confirmed - disconnect the LiPo". A monitoring read displaced by the
 * app's own stop faulted the session, and an operator whose motor had in
 * fact been stopped cleanly was told to pull the battery. Crying wolf on
 * a safe stop is not a conservative default - it teaches people to ignore
 * the one message that must never be ignored.
 *
 * The instruction now requires BOTH halves of the thing it claims:
 *   - a motor command may actually have reached the flight controller, and
 *   - the stop that should have ended it is genuinely unconfirmed.
 *
 * A stop is confirmed when it was acknowledged AND its attribution is
 * settled - either it was never ambiguous, or the ambiguity was resolved
 * by a second all-stop whose acknowledgement could not have belonged to
 * the displaced pulse. Anything else - failed, rejected, timed out, never
 * attempted, or ambiguous and unresolved - is unconfirmed and keeps the
 * banner. So does a fault that arrives while a stop is still in flight.
 */
export function stopIsGenuinelyUnconfirmed(
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  if (!commandMayBeLive(snapshot) || snapshot === undefined) {
    return false;
  }
  const stop = snapshot.stopExecution;
  const attributionSettled =
    !stop.attributionAmbiguous || stop.attributionResolvedByConfirmation;
  const confirmed =
    stop.outcome?.kind === 'ACKNOWLEDGED' &&
    stop.commandAcknowledged &&
    attributionSettled;
  return !confirmed;
}

export interface MotorsScreenViewProps {
  /** The operator facade from the ONE official binding. Undefined when no
   * official session is active - the screen then renders inert. */
  readonly operator: MotorTestOperatorPort | undefined;
  /** Fires when the operator asks to leave. Navigation itself is owned by
   * the lifecycle bridge and the route, never by this component. */
  readonly onRequestLeave?: () => void;
  /**
   * The first session bring-up step that threw, verbatim, or undefined when
   * nothing threw.
   *
   * SHOWN ONLY ALONGSIDE THE BLOCKED NO-SESSION STATE, and shown UNTRANSLATED
   * on purpose: it is a developer-facing cause string, not operator copy, and
   * inventing Arabic for an arbitrary runtime error would be worse than
   * showing the real text. Nothing branches on it - it is display only.
   */
  readonly bringUpFailure?: string;
  /**
   * Additional bottom spacing supplied by a future host. The application
   * root already owns the device safe area, so this screen must never add
   * the same system inset a second time.
   */
  readonly bottomInset?: number;
  /** Canonical session id for the independent settings transaction. The
   * presentation-only tests omit it, so no configuration I/O can start from
   * an unbound view. */
  readonly sessionId?: string;
  readonly onConfigurationDirtyChange?: (dirty: boolean) => void;
}

export function MotorsScreenView({
  operator,
  onRequestLeave,
  bottomInset,
  bringUpFailure,
  sessionId,
  onConfigurationDirtyChange,
}: MotorsScreenViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const effectiveBottomInset = bottomInset ?? 0;

  // The snapshot is the ONLY source of controller truth. `useState` plus an
  // explicit subscription rather than useSyncExternalStore: the controller
  // returns a frozen object that is referentially stable between
  // publishes, which is exactly the contract a plain subscribe/setState
  // mirror needs, and it keeps the unmount guard below explicit.
  const [snapshot, setSnapshot] = useState<
    MotorTestControllerSnapshot | undefined
  >(() => operator?.getSnapshot());
  const [selectedSlot, setSelectedSlot] = useState(1);
  /**
   * Phase 2I - VOLATILE, MEMORY-ONLY verification data, bound to one exact
   * session by reference. Never persisted, exported, uploaded or shared,
   * and reset outright whenever the bound session is not the current one.
   */
  const [verification, setVerification] = useState<MotorVerificationState>(
    EMPTY_VERIFICATION_STATE,
  );
  const [advancedVerificationOpen, setAdvancedVerificationOpen] =
    useState(false);
  const [motorConfigurationDirty, setMotorConfigurationDirty] = useState(false);
  const [outputOrderDirty, setOutputOrderDirty] = useState(false);
  const [escDirectionDirty, setEscDirectionDirty] = useState(false);
  useEffect(() => {
    onConfigurationDirtyChange?.(
      motorConfigurationDirty || outputOrderDirty || escDirectionDirty,
    );
    return () => onConfigurationDirtyChange?.(false);
  }, [
    escDirectionDirty,
    motorConfigurationDirty,
    onConfigurationDirtyChange,
    outputOrderDirty,
  ]);
  /** Guards every asynchronous continuation. A callback that survives
   * unmount must never call setState. */
  const mountedRef = useRef(true);
  /** One continuous hold may activate at most once. Reset on release. */
  const holdActivatedRef = useRef(false);
  /** True only while the primary Pressable still owns the original touch. */
  const holdOwnedRef = useRef(false);
  /**
   * The same fact as holdOwnedRef, but RENDERED.
   *
   * THE FIELD BUG THIS EXISTS FOR: submitting a pulse makes
   * evaluateActivation() report PULSE_OR_STOP_IN_PROGRESS, so
   * `activation.allowed` goes false the instant the motor starts. The
   * hold control's `disabled` prop was derived from that, which meant
   * `disabled` flipped to true WHILE THE FINGER WAS STILL DOWN.
   * react-native-web terminates the active responder when a Pressable
   * becomes disabled, which fires onResponderTerminate -> handlePressOut
   * -> stopNow('TOUCH_RELEASED'). The motor moved briefly and stopped,
   * exactly as the operator reported.
   *
   * Rendering ownership lets the control stay enabled for the duration of
   * a gesture it already owns. This weakens nothing: pulseMotor()
   * re-evaluates the real gate at CALL time (this file's controller
   * documents that a button which rendered enabled is not evidence), and
   * every release, cancel, blur and background still routes through
   * stopNow.
   */
  const [holdOwned, setHoldOwned] = useState(false);
  /** Unique identity for that exact gesture. A later short touch must never
   * inherit an earlier gesture's pending session-preparation continuation. */
  const holdGestureRef = useRef<object | undefined>(undefined);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  /** Read at CALL time, so a stale closure still sees live state - the
   * same reasoning UsbSerialDebugPanel's own mspActiveRef guard uses. */
  const operatorRef = useRef(operator);
  operatorRef.current = operator;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      holdOwnedRef.current = false;
      holdGestureRef.current = undefined;
      if (heartbeatTimerRef.current !== undefined) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (operator === undefined) {
      setSnapshot(undefined);
      return;
    }
    // Read once on (re)binding, then on every publish. A binding swap is a
    // NEW official session; the previous session's snapshot must never
    // survive into it.
    setSnapshot(operator.getSnapshot());
    const unsubscribe = operator.subscribe(() => {
      if (!mountedRef.current) {
        return;
      }
      setSnapshot(operator.getSnapshot());
    });
    return unsubscribe;
  }, [operator]);

  const presentation = derivePresentation(snapshot);
  const receipt = snapshot?.verificationReceipt;
  const mayBeLive = commandMayBeLive(snapshot);
  const stopUnconfirmed = stopIsGenuinelyUnconfirmed(snapshot);
  const controllerAllows = snapshot?.activation.allowed === true;
  const blockReasons = snapshot?.activation.reasons ?? [];

  /**
   * CAUSAL ORDER, most-primary first. `evaluateActivation()` emits its
   * reasons in evaluation order, which is not the same thing: a torn-down
   * session lists its consequences alongside whatever actually caused it.
   * This picks the first reason that is a CAUSE rather than an effect, so
   * the operator is told what to do about the aircraft or the cable, not
   * what the controller's internals look like afterwards.
   */
  const primaryBlockReason = CAUSAL_BLOCK_REASON_ORDER.find(reason =>
    blockReasons.includes(reason),
  );
  const requiresNewConnection =
    snapshot?.phase === 'CLOSED' ||
    (snapshot?.outcome.kind === 'FAILED_CLOSED' &&
      snapshot.outcome.requiresNewSession) ||
    (snapshot?.outcome.kind === 'BLOCKED' &&
      snapshot.outcome.requiresNewSession);

  /**
   * Binds verification to the CURRENT official session, and clears it for
   * a genuinely new one. Reference identity on the authority token, so a
   * replacement session can never inherit an old session's observations
   * and an old callback can never mutate the replacement's data.
   */
  useEffect(() => {
    const token = snapshot?.verificationReceipt?.sessionToken;
    if (token === undefined) {
      return;
    }
    setVerification(current =>
      current.sessionToken === token ? current : beginVerification(token),
    );
  }, [snapshot?.verificationReceipt?.sessionToken]);

  /**
   * Software evidence that failed is unsafe, never merely incomplete. A
   * fault marks every unobserved output UNSAFE_OR_AMBIGUOUS so a report
   * can never present it as "not finished yet".
   */
  useEffect(() => {
    if (presentation === 'FAULT') {
      setVerification(current =>
        current.sessionToken === undefined || current.aborted
          ? current
          : abortVerificationAsUnsafe(current),
      );
    }
  }, [presentation]);

  const handleConfirmObservation = useCallback(
    (
      confirmedReceipt: MotorTestVerificationReceipt,
      observation: MotorObservation,
    ) => {
      setVerification(current => {
        const result = confirmObservation(
          current,
          confirmedReceipt,
          observation,
        );
        // A rejected confirmation - stale session, finalized, aborted, or
        // an output already confirmed - changes nothing at all.
        return result.kind === 'ACCEPTED' ? result.state : current;
      });
    },
    [],
  );

  /** The user saw more than one motor move: stop testing and tear down
   * through the ACCEPTED route. This is NOT converted into a controller
   * fault - the controller observed nothing wrong, a person did. */
  const handleMultipleMotors = useCallback(() => {
    operatorRef.current?.requestStop('STOP_BUTTON_PRESSED');
    setVerification(current => finalizeVerification(current));
  }, []);

  const canActivate = controllerAllows;

  /**
   * THE ONE STOP ROUTE. Every release, cancellation and Stop press goes
   * through here. Synchronous, and it awaits nothing before asking the
   * controller - the controller registers the emergency stop inside this
   * very call.
   */
  const stopNow = useCallback(
    (trigger: 'TOUCH_RELEASED' | 'STOP_BUTTON_PRESSED') => {
      const port = operatorRef.current;
      if (port === undefined) {
        return;
      }
      // Repeated callbacks are expected and safe: the controller joins
      // concurrent triggers onto one stop episode and one transport write.
      port.requestStop(trigger);
    },
    [],
  );

  /**
   * Session preparation is LAZY: navigation and settings remain read-only,
   * and the first intentional long press is the explicit operator action
   * that starts setup. If the finger leaves before setup resolves, no pulse
   * is submitted.
   */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [beginning, setBeginning] = useState(false);
  const [beginFailed, setBeginFailed] = useState(false);
  const holdGateBlocked =
    operator === undefined ||
    requiresNewConnection ||
    (!beginning && snapshot?.machine !== undefined && !canActivate);
  // See holdOwned's own declaration: disabling mid-gesture is what
  // terminated the responder and stopped a held motor in the field.
  const holdDisabled = holdGateBlocked && !holdOwned;
  /** Read at CALL time by handlePressIn, so ownership can only ever be
   * taken for a press the gate actually admitted. Ownership PROTECTS a
   * gesture the gate accepted; it must never CREATE one. */
  const holdGateBlockedRef = useRef(holdGateBlocked);
  holdGateBlockedRef.current = holdGateBlocked;
  /** Ends the exclusive test session before the optional output-reorder
   * transaction, which deliberately owns a separate interlock. */
  const handleEndSessionForConfiguration = useCallback(async () => {
    const port = operatorRef.current;
    if (port === undefined) {
      throw new Error('Motor-test operator is unavailable.');
    }
    await port.endSession();
  }, []);

  const clearHoldHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== undefined) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = undefined;
    }
  }, []);

  const startHoldHeartbeat = useCallback(
    (port: MotorTestOperatorPort) => {
      clearHoldHeartbeat();
      heartbeatTimerRef.current = setInterval(() => {
        if (!holdOwnedRef.current || !holdActivatedRef.current) {
          clearHoldHeartbeat();
          return;
        }
        if (port.renewPulseHold() !== 'RENEWED') {
          clearHoldHeartbeat();
        }
      }, MOTOR_TEST_HOLD_HEARTBEAT_INTERVAL_MILLIS);
    },
    [clearHoldHeartbeat],
  );

  const handlePressIn = useCallback(() => {
    if (holdGateBlockedRef.current) {
      // A press that the gate never admitted takes no ownership, so it
      // cannot keep the control enabled for itself.
      return;
    }
    holdOwnedRef.current = true;
    setHoldOwned(true);
    holdGestureRef.current = {};
    holdActivatedRef.current = false;
    clearHoldHeartbeat();
  }, [clearHoldHeartbeat]);

  const handleLongPress = useCallback(() => {
    if (holdActivatedRef.current) {
      return;
    }
    const gesture = holdGestureRef.current;
    if (gesture === undefined) {
      return;
    }
    const port = operatorRef.current;
    if (port === undefined) {
      return;
    }
    const activateIfStillOwned = () => {
      const current = port.getSnapshot();
      if (!mountedRef.current) {
        return;
      }
      if (
        !holdOwnedRef.current ||
        holdGestureRef.current !== gesture ||
        !current.activation.allowed
      ) {
        setBeginFailed(current.machine === undefined);
        return;
      }
      holdActivatedRef.current = true;
      if (port.pulseMotor(selectedSlot) === 'ACCEPTED') {
        startHoldHeartbeat(port);
      } else {
        holdActivatedRef.current = false;
      }
    };

    const current = port.getSnapshot();
    if (current.machine === undefined) {
      setBeginning(true);
      setBeginFailed(false);
      port
        .beginSession()
        .then(() => activateIfStillOwned())
        .catch(() => {
          if (mountedRef.current) {
            setBeginFailed(true);
          }
        })
        .finally(() => {
          if (mountedRef.current) {
            setBeginning(false);
          }
        });
      return;
    }
    activateIfStillOwned();
  }, [selectedSlot, startHoldHeartbeat]);

  /** Release AND responder termination land here. Both must stop. */
  const handlePressOut = useCallback(() => {
    holdOwnedRef.current = false;
    setHoldOwned(false);
    holdGestureRef.current = undefined;
    clearHoldHeartbeat();
    const activated = holdActivatedRef.current;
    holdActivatedRef.current = false;
    // Stop whenever a command may be live - including the pre-ACK window,
    // where `mayBeLive` is already true because the controller latches it
    // at activation rather than at acknowledgement.
    if (activated || commandMayBeLive(operatorRef.current?.getSnapshot())) {
      stopNow('TOUCH_RELEASED');
    }
  }, [clearHoldHeartbeat, stopNow]);

  const handleStopPress = useCallback(() => {
    holdOwnedRef.current = false;
    setHoldOwned(false);
    holdGestureRef.current = undefined;
    clearHoldHeartbeat();
    holdActivatedRef.current = false;
    stopNow('STOP_BUTTON_PRESSED');
  }, [clearHoldHeartbeat, stopNow]);

  /**
   * Selecting a different output while something may be live STOPS the
   * current episode and does NOT start the new one. The controller
   * enforces this too; the screen simply must not pretend otherwise.
   */
  const handleSelectSlot = useCallback((slot: number) => {
    const port = operatorRef.current;
    if (port !== undefined && commandMayBeLive(port.getSnapshot())) {
      const machine = port.getSnapshot().machine?.name;
      if (machine === 'Starting' || machine === 'Pulsing') {
        holdActivatedRef.current = false;
        holdOwnedRef.current = false;
        setHoldOwned(false);
        holdGestureRef.current = undefined;
        clearHoldHeartbeat();
        port.requestStop('MOTOR_SELECTION_CHANGED');
      }
    }
    setSelectedSlot(slot);
  }, [clearHoldHeartbeat]);

  const statusText = useMemo(() => {
    switch (presentation) {
      case 'CHECKING':
        return t('motorsScreen.statusChecking');
      case 'LOCKED':
        return t('motorsScreen.statusLocked');
      case 'VERIFYING':
        return t('motorsScreen.statusVerifying');
      case 'READY':
        return t('motorsScreen.statusReady');
      case 'SUBMITTED_AWAITING_RESPONSE':
        return t('motorsScreen.statusSubmitted');
      case 'ACKNOWLEDGED':
        return t('motorsScreen.statusAcknowledged');
      case 'STOPPING':
        return t('motorsScreen.statusStopping');
      case 'FAULT':
        return t('motorsScreen.statusFault');
      default:
        return t('motorsScreen.noSession');
    }
  }, [presentation, t]);

  const statusColor =
    presentation === 'FAULT'
      ? colors.error
      : presentation === 'READY'
      ? colors.success
      : presentation === 'LOCKED'
      ? colors.warning
      : colors.textSecondary;

  const selectedExpected = expectedFor(selectedSlot);
  const verifiedSlots = verification.entries
    .filter(entry => entry.observation !== undefined)
    .map(entry => entry.motorNumber);
  const liveSlot =
    presentation === 'SUBMITTED_AWAITING_RESPONSE' ||
    presentation === 'ACKNOWLEDGED' ||
    presentation === 'STOPPING'
      ? snapshot?.pulse.motorNumber
      : undefined;
  const airframeEntries = MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
    slot: entry.motorNumber,
    position: entry.position,
    direction: entry.direction,
  }));

  /** One primary control beside the selected output. Its first long press
   * prepares the protected session lazily, so no second action competes
   * with it. */
  const holdControl = (
    <Pressable
      onPressIn={handlePressIn}
      onLongPress={handleLongPress}
      delayLongPress={MOTOR_TEST_LONG_PRESS_DELAY_MILLIS}
      onPressOut={handlePressOut}
      onResponderTerminate={(_event: GestureResponderEvent) => handlePressOut()}
      disabled={holdDisabled}
      accessibilityRole="button"
      accessibilityState={{
        disabled: holdDisabled,
        busy: beginning,
      }}
      style={[
        styles.holdButton,
        holdDisabled && styles.holdButtonOff,
      ]}
      testID="motors-hold-button"
    >
      <Text
        style={[styles.holdStep, canActivate && styles.holdSupportingActive]}
      >
        {beginning
          ? t('motorsScreen.beginSessionBusy')
          : t('motorsScreen.holdHeading')}
      </Text>
      <Text style={[styles.holdLabel, !canActivate && styles.holdLabelOff]}>
        {t('motorsScreen.holdToTest', { slot: `M${selectedSlot}` })}
      </Text>
      <Text
        style={[styles.caption, canActivate && styles.holdSupportingActive]}
      >
        {t('motorsScreen.holdHint')}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={[styles.root, { paddingBottom: effectiveBottomInset }]}
      testID="motors-screen"
    >
      {/* Scrollable body. The emergency Stop control below is deliberately
          OUTSIDE this ScrollView so it can never be scrolled out of reach,
          and the body's bottom padding keeps it from being covered. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.screenHeader}>
          <Text style={styles.eyebrow}>{t('motorsScreen.eyebrow')}</Text>
          <Text style={styles.title} testID="motors-title">
            {t('motorsScreen.title')}
          </Text>
          <Text style={styles.screenSubtitle}>
            {t('motorsScreen.subtitle')}
          </Text>
        </View>

        {/* One compact bench notice, not a confirmation ritual. Propeller
            removal stays first, with text AND icon rather than colour alone. */}
        <View style={styles.dangerBanner} testID="motors-propeller-warning">
          <Text style={styles.dangerIcon}>⚠</Text>
          <View
            style={[styles.flexOne, styles.safetyNoticeCopy]}
            testID="motors-acknowledgements"
          >
            <Text style={styles.dangerTitle}>
              {t('motorsScreen.propellerWarning')}
            </Text>
            <Text style={styles.dangerBody}>
              {t('motorsScreen.propellerWarningDetail')}
            </Text>
            <Text style={styles.checkLabel}>• {t('motorsScreen.ackSecured')}</Text>
            <Text style={styles.checkLabel}>• {t('motorsScreen.ackBattery')}</Text>
            <Text
              style={styles.batteryWarning}
              testID="motors-battery-scope-warning"
            >
              {t('motorsScreen.batteryScopeWarning')}
            </Text>
            <Text style={styles.caption}>{t('motorsScreen.ackNotice')}</Text>
          </View>
        </View>

        {beginFailed || (operator === undefined && bringUpFailure !== undefined) ? (
          <View style={styles.card} testID="motors-begin-failed">
            <Text style={styles.blockReason}>
              {t('motorsScreen.beginSessionFailed')}
            </Text>
            {bringUpFailure !== undefined ? (
              <Text
                style={styles.caption}
                testID="motors-begin-bringup-error"
              >
                {bringUpFailure}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Compact authoritative status. The first causal reason remains
            operator-facing; the full internal state stays collapsed. */}
        <View style={styles.statusCard} testID="motors-status">
          <View style={styles.statusRow}>
            <View
              style={[styles.statusDot, { backgroundColor: statusColor }]}
            />
            <View style={styles.flexOne}>
              <Text style={styles.statusHeading}>
                {t('motorsScreen.statusHeading')}
              </Text>
              <Text
                style={[styles.statusText, { color: statusColor }]}
                testID={`motors-status-${presentation}`}
              >
                {statusText}
              </Text>
            </View>
          </View>
          {presentation === 'ACKNOWLEDGED' ? (
            <Text style={styles.caption} testID="motors-ack-notice">
              {t('motorsScreen.statusAcknowledgedNotice')}
            </Text>
          ) : null}
          {/* THE FIRST CAUSAL FAILURE, AND ONLY THAT.
              A blocked session used to print all twelve reasons as a
              bulleted list, so a single failure that tore the session down
              presented as six independent hardware faults - the old
              SETUP_NOT_READY, MACHINE_NOT_READY, ARMING_RESTRICTION_NOT_CURRENT
              and AUTHORITY_STALE were CONSEQUENCES of teardown, not separate
              things wrong with the aircraft. The reason set is now seven
              operator-facing causes and only the first is shown; the full
              array stays available under diagnostics, and the controller's
              internal protections remain strictly stronger than what is
              displayed. */}
          {primaryBlockReason !== undefined ? (
            <View style={styles.blockList} testID="motors-block-reasons">
              <Text style={styles.blockHeading}>
                {t('motorsScreen.blockedHeading')}
              </Text>
              <Text
                style={styles.blockReason}
                testID={`motors-block-${primaryBlockReason}`}
              >
                {t(`motorsScreen.blockReason.${primaryBlockReason}`)}
              </Text>
              {/* Terminal state is the one case with a concrete operator
                  action attached, so it is stated as an instruction rather
                  than left as a diagnosis. */}
              {requiresNewConnection ? (
                <Text
                  style={styles.blockReason}
                  testID="motors-requires-new-connection"
                >
                  {t('motorsScreen.requiresNewConnection')}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* DEVELOPER DIAGNOSTICS - collapsed by default, never shown to
              the operator unless asked for. Everything the old list dumped
              on screen lives here, plus the terminal outcome, setup step
              and teardown report that were previously invisible. */}
          {blockReasons.length > 0 || snapshot !== undefined ? (
            <View>
              <Pressable
                onPress={() => setDiagnosticsOpen(current => !current)}
                accessibilityRole="button"
                accessibilityState={{ expanded: diagnosticsOpen }}
                style={styles.diagnosticsToggle}
                testID="motors-diagnostics-toggle"
              >
                <Text style={styles.caption}>
                  {t('motorsScreen.diagnosticsToggle')}
                </Text>
              </Pressable>
              {diagnosticsOpen ? (
                <View testID="motors-diagnostics">
                  {blockReasons.map(
                    (reason: MotorTestActivationBlockReason) => (
                      <Text
                        key={reason}
                        style={styles.caption}
                        testID={`motors-diagnostic-${reason}`}
                      >
                        • {reason}
                      </Text>
                    ),
                  )}
                  {/* COMPLETE TECHNICAL STATE, behind the toggle. The
                      operator-facing reason set is deliberately narrow, so
                      everything the gate actually consulted has to be
                      readable somewhere - this is that somewhere. */}
                  <Text
                    style={styles.caption}
                    testID="motors-diagnostic-outcome"
                  >
                    outcome: {snapshot?.outcome.kind ?? 'NONE'} | setupStep:{' '}
                    {snapshot?.setupStep ?? 'NONE'} | phase:{' '}
                    {snapshot?.phase ?? 'NONE'} | machine:{' '}
                    {String(snapshot?.machine?.name)} | teardownComplete:{' '}
                    {String(snapshot?.teardown?.complete)}
                  </Text>
                  {/* The decoded scope is serialized WHOLE rather than
                      field by field. Naming its fields here would put
                      safety-relevant identifiers in this file even though
                      nothing branches on them, and the containment test
                      above rightly refuses that - a screen that can spell
                      a safety field is one edit away from deciding on it.
                      Serializing keeps every value visible and keeps this
                      component unable to read any of them. */}
                  <Text
                    style={styles.caption}
                    testID="motors-diagnostic-evidence"
                  >
                    armedState: {snapshot?.armedStateEvidence ?? 'NONE'} |
                    telemetryHeld: {String(snapshot?.telemetryHeld)} | scope:{' '}
                    {JSON.stringify(snapshot?.motorScope ?? null)} | firmware:{' '}
                    {JSON.stringify(snapshot?.firmwareCompatibility ?? null)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* (7) Fault. TWO DIFFERENT MESSAGES, because they mean two very
            different things to somebody standing next to an aircraft.

            The LiPo instruction is reserved for a stop that is genuinely
            unconfirmed while a command may be live - see
            stopIsGenuinelyUnconfirmed(). Every other fault ends the
            session and needs a reconnect, which is worth saying plainly,
            but it is NOT a reason to tell somebody to pull a battery. */}
        {presentation === 'FAULT' ? (
          stopUnconfirmed ? (
            <View style={styles.faultBanner} testID="motors-fault-banner">
              <Text style={styles.dangerIcon}>⛔</Text>
              <View style={styles.flexOne}>
                <Text style={styles.faultText} testID="motors-emergency-text">
                  {t('motorsScreen.emergencyDisconnect')}
                </Text>
                <Text
                  style={styles.dangerBody}
                  testID="motors-new-session-text"
                >
                  {t('motorsScreen.emergencyNewSession')}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.card} testID="motors-fault-notice">
              <Text
                style={styles.blockHeading}
                testID="motors-fault-session-text"
              >
                {t('motorsScreen.faultSessionEnded')}
              </Text>
              <Text style={styles.caption} testID="motors-fault-no-lipo-text">
                {t('motorsScreen.faultNoBatteryAction')}
              </Text>
            </View>
          )
        ) : null}

        {/* The primary workspace. Selection, real FC facts, airframe
            reference and the hold action stay together so the operator
            never has to translate between separate cards. */}
        <View style={styles.benchCard} testID="motors-workspace">
          <View style={styles.benchHeadingRow}>
            <View style={styles.flexOne}>
              <Text style={styles.sectionTitle}>
                {t('motorsScreen.workspaceHeading')}
              </Text>
              <Text style={styles.caption}>
                {t('motorsScreen.workspaceSubtitle')}
              </Text>
            </View>
            <View style={styles.progressBadge} testID="motors-progress">
              <Text style={styles.progressText}>
                {t('motorsScreen.verificationProgress', {
                  done: confirmedCount(verification),
                  total: MOTOR_TEST_OUTPUT_SLOTS.length,
                })}
              </Text>
            </View>
          </View>

          <MotorConfigurationSummary scope={snapshot?.motorScope} />

          <View style={styles.outputSection} testID="motors-outputs">
            <Text style={styles.miniHeading}>
              {t('motorsScreen.outputsHeading')}
            </Text>
            <View style={styles.slotRow}>
              {MOTOR_TEST_OUTPUT_SLOTS.map(slot => (
                <Pressable
                  key={slot}
                  onPress={() => handleSelectSlot(slot)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedSlot === slot }}
                  style={[
                    styles.slotCard,
                    selectedSlot === slot && styles.slotCardSelected,
                    liveSlot === slot && styles.slotCardLive,
                  ]}
                  testID={`motors-slot-${slot}`}
                >
                  <Text
                    style={[
                      styles.slotLabel,
                      liveSlot === slot && styles.slotLabelLive,
                    ]}
                  >
                    {`M${slot}`}
                  </Text>
                  {selectedSlot === slot ? (
                    <Text style={styles.slotSelected}>
                      ✓ {t('motorsScreen.selected')}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.airframeSection} testID="motors-diagram">
            <View style={styles.airframeHeading}>
              <Text style={styles.miniHeading}>
                {t('motorsScreen.diagramHeading')}
              </Text>
              <Text style={styles.caption}>
                {t('motorsScreen.diagramSummary')}
              </Text>
            </View>
            <MotorAirframeDiagram
              entries={airframeEntries}
              selectedSlot={selectedSlot}
              liveSlot={liveSlot}
              verifiedSlots={verifiedSlots}
              onSelectSlot={handleSelectSlot}
            />
            <Text style={styles.caption} testID="motors-diagram-front-hint">
              {t('motorsScreen.diagramFrontHint')}
            </Text>
            <Text style={styles.referenceNotice} testID="motors-diagram-notice">
              {t('motorsScreen.diagramNotice')}
            </Text>
            <Text
              style={styles.caption}
              testID="motors-diagram-direction-source"
            >
              {t('motorsScreen.diagramDirectionSource')}
            </Text>
          </View>

          <View
            style={styles.selectedMotorPanel}
            testID="motors-selected-summary"
          >
            <View style={styles.selectedMotorBadge}>
              <Text style={styles.selectedMotorSlot}>{`M${selectedSlot}`}</Text>
            </View>
            <View style={styles.flexOne}>
              <Text style={styles.miniHeading}>
                {t('motorsScreen.selectedMotorHeading')}
              </Text>
              <Text style={styles.caption}>
                {t('motorsScreen.selectedMotorExpected', {
                  position:
                    selectedExpected === undefined
                      ? '—'
                      : t(
                          `motorVerification.position.${selectedExpected.position}`,
                        ),
                  direction:
                    selectedExpected === undefined
                      ? '—'
                      : t(
                          `motorVerification.direction.${selectedExpected.direction}`,
                        ),
                })}
              </Text>
            </View>
          </View>

          {holdControl}
          <EscDirectionPanel
            selectedMotor={selectedSlot}
            operator={operator}
            onDirtyChange={setEscDirectionDirty}
          />
        </View>

        {/* Outside a test lease monitoring uses the canonical scheduler.
            While the lease is held it performs fixed read-only requests
            through that SAME serialized lease, without bypassing pulse or
            stop ownership. */}
        {sessionId !== undefined ? (
          <MotorDiagnosticsPanel
            sessionId={sessionId}
            operator={operator}
            activeMotorTest={
              snapshot?.phase === 'ACTIVE' && snapshot.outcome.kind === 'READY'
            }
            motorTestDiagnostics={snapshot?.diagnostics}
            support={snapshot?.motorDiagnosticsSupport}
          />
        ) : null}

        {/* Persistent configuration is a separate transaction from bench
            testing. It owns no motor pulse path and is deliberately bound to
            the canonical session id rather than to the MotorTest operator. */}
        {sessionId !== undefined ? (
          <MotorConfigurationPanel
            sessionId={sessionId}
            onDirtyChange={setMotorConfigurationDirty}
          />
        ) : null}

        <Pressable
          onPress={() => setAdvancedVerificationOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{expanded: advancedVerificationOpen}}
          style={styles.card}
          testID="motors-advanced-verification-toggle"
        >
          <Text style={styles.sectionTitle}>
            {t('motorsScreen.advancedVerification')}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.advancedVerificationHint')}
          </Text>
        </Pressable>

        {advancedVerificationOpen ? (
          <View style={styles.advancedStack} testID="motors-advanced-verification">
            {receipt !== undefined || verification.sessionToken !== undefined ? (
              <MotorVerificationWizard
                receipt={receipt}
                state={verification}
                onConfirm={handleConfirmObservation}
                onMultipleMotorsReported={handleMultipleMotors}
              />
            ) : null}
            {verification.sessionToken !== undefined ? (
              <MotorTestReport
                state={verification}
                safeTeardownConfirmed={
                  presentation !== 'FAULT' &&
                  (snapshot?.stopExecution.attributionAmbiguous !== true ||
                    snapshot?.stopExecution.attributionResolvedByConfirmation ===
                      true)
                }
              />
            ) : null}
            {verification.sessionToken !== undefined && sessionId !== undefined ? (
              <MotorOutputReorderPanel
                sessionId={sessionId}
                verification={verification}
                onEndMotorTestSession={handleEndSessionForConfiguration}
                onDirtyChange={setOutputOrderDirty}
              />
            ) : null}
          </View>
        ) : null}

        {onRequestLeave !== undefined ? (
          <Pressable
            onPress={onRequestLeave}
            accessibilityRole="button"
            style={styles.leaveButton}
            testID="motors-leave"
          >
            <Text style={styles.leaveLabel}>{t('motorsScreen.title')}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* (8) The emergency Stop control. OUTSIDE the ScrollView, always
          mounted, and NEVER disabled for a transient UI or Promise state -
          the one moment it looks busy is exactly when it matters most. */}
      <Pressable
        onPress={handleStopPress}
        accessibilityRole="button"
        accessibilityState={{ disabled: false }}
        style={[
          styles.stopButton,
          { marginBottom: effectiveBottomInset + spacing.md },
        ]}
        testID="motors-stop-button"
      >
        <Text style={styles.stopIcon}>⏹</Text>
        <Text style={styles.stopLabel}>{t('motorsScreen.stop')}</Text>
      </Pressable>

      {mayBeLive ? (
        <View style={styles.liveStrip} testID="motors-command-may-be-live" />
      ) : null}
    </View>
  );
}

/** Minimum touch target, matching SafetyStrip's own accessibility note. */
const MIN_TOUCH_TARGET = 44;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
  },
  flexOne: { flex: 1 },
  advancedStack: { gap: spacing.md },
  screenHeader: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  title: {
    ...typography.display,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  screenSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  dangerBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: '#2C1D22',
    borderColor: colors.error,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  dangerIcon: { fontSize: 22, color: colors.error },
  dangerTitle: {
    ...typography.sectionTitle,
    color: colors.error,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  dangerBody: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  safetyNoticeCopy: { gap: spacing.xs },
  faultBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: '#2C1D22',
    borderColor: colors.error,
    borderWidth: 2,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  faultText: {
    ...typography.title,
    color: colors.error,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 3,
  },
  sessionCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  sessionStepBadge: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
    borderWidth: 1,
  },
  sessionStepNumber: {
    ...typography.sectionTitle,
    color: colors.accent,
  },
  sessionContent: { flex: 1, gap: spacing.sm },
  statusCard: {
    gap: spacing.sm,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusHeading: {
    ...typography.caption,
    color: colors.textMuted,
    writingDirection: 'rtl',
  },
  benchCard: {
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 4,
  },
  benchHeadingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  progressBadge: {
    maxWidth: 126,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  progressText: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  outputSection: { gap: spacing.sm },
  miniHeading: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  statusText: { ...typography.body, writingDirection: 'rtl', flexShrink: 1 },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  blockList: { gap: spacing.xs },
  diagnosticsToggle: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  blockHeading: {
    ...typography.caption,
    color: colors.warning,
    writingDirection: 'rtl',
  },
  blockReason: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
  },
  checkBox: { fontSize: 20, color: colors.textSecondary },
  checkBoxOn: { color: colors.success },
  checkLabel: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  slotRow: { flexDirection: 'row', gap: spacing.sm },
  slotCard: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  slotCardSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  slotCardLive: {
    borderColor: colors.warning,
    backgroundColor: '#342A17',
  },
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    // M1..M4 are latin identifiers; forced LTR keeps them readable inside
    // the RTL page instead of being reordered around the digit.
    writingDirection: 'ltr',
  },
  slotLabelLive: { color: colors.warning },
  slotSelected: { ...typography.caption, color: colors.accent },
  airframeSection: {
    gap: spacing.sm,
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    paddingTop: spacing.lg,
  },
  airframeHeading: { gap: 2 },
  referenceNotice: {
    ...typography.caption,
    color: colors.warning,
    writingDirection: 'rtl',
  },
  selectedMotorPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  selectedMotorBadge: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
    borderWidth: 2,
  },
  selectedMotorSlot: {
    ...typography.title,
    color: colors.accent,
    writingDirection: 'ltr',
  },
  batteryWarning: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  directionNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  directionIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
  },
  directionIconText: { fontSize: 22, color: colors.accent },
  beginButton: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    /* OUTLINED, not filled: the hold-to-test control is a large filled
       surface. An operator must never mistake one for the other. */
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  beginButtonOff: { borderColor: colors.disabled },
  /** Touch-down feedback. Instant, and independent of any async outcome. */
  beginButtonPressed: { borderColor: colors.textPrimary, opacity: 0.7 },
  beginLabel: {
    ...typography.sectionTitle,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  holdStep: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  holdButton: {
    minHeight: MIN_TOUCH_TARGET + spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  holdButtonOff: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.disabled,
    opacity: 0.6,
  },
  holdLabel: {
    ...typography.sectionTitle,
    color: colors.accentText,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  holdLabelOff: {
    color: colors.textPrimary,
  },
  holdSupportingActive: {
    color: colors.accentText,
  },
  leaveButton: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' },
  leaveLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    width: '90%',
    maxWidth: 724,
    alignSelf: 'center',
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
    backgroundColor: colors.error,
    borderRadius: radii.lg,
    padding: spacing.md,
    shadowColor: colors.error,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
    elevation: 4,
  },
  stopIcon: { fontSize: 22, color: colors.textPrimary },
  stopLabel: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  liveStrip: { height: 3, backgroundColor: colors.warning },
});

/* ================================================================== *
 * The tab container.
 *
 * This is where the screen is BOUND to the one official session, and
 * where the accepted lifecycle bridge owns every navigation, back, tab
 * and AppState trigger. The view above stays a pure presentation/gesture
 * layer and never learns that navigation exists.
 *
 * SINGLE-APP MERGE: Motors used to be its own stack route, registered
 * only when the build-variant seam supplied a component. It is now a TAB
 * inside the main shell, so this container takes the shell's navigation
 * object (for `beforeRemove`, which still covers leaving the whole route
 * and Android Back) plus a tab blur source. It owns and creates neither.
 * ================================================================== */

type MotorsHostNavigation = NativeStackScreenProps<
  RootStackParamList,
  'Setup'
>['navigation'];

export interface MotorsTabProps {
  readonly sessionKey: SetupUiSessionKey | undefined;
  readonly navigation: MotorsHostNavigation;
  /**
   * Fires when the operator switches AWAY from the Motors tab.
   *
   * THE SAME PATH, NOT A PARALLEL ONE. This is handed to the accepted
   * lifecycle bridge as its `addBlurListener` source, so a tab change is
   * treated exactly as a navigation blur already was - one bridge, one
   * whitelist, one stop obligation. There is deliberately no second
   * stop/release route wired into tab switching.
   */
  readonly subscribeTabBlur: (listener: () => void) => () => void;
  readonly bottomInset?: number;
  readonly onConfigurationDirtyChange?: (dirty: boolean) => void;
}

export default function MotorsTab({
  sessionKey,
  navigation,
  subscribeTabBlur,
  bottomInset,
  onConfigurationDirtyChange,
}: MotorsTabProps): React.JSX.Element {
  if (!sessionKey) {
    // No live session: the screen renders inert and blocked. That is the
    // correct presentation for a tab opened before a connection exists -
    // not an error, and not something to hide the tab over.
    return (
      <MotorsScreenView
        operator={undefined}
        bottomInset={bottomInset}
        onConfigurationDirtyChange={onConfigurationDirtyChange}
      />
    );
  }
  return (
    <MotorsScreenBinding
      sessionKey={sessionKey}
      navigation={navigation}
      subscribeTabBlur={subscribeTabBlur}
      bottomInset={bottomInset}
      onConfigurationDirtyChange={onConfigurationDirtyChange}
      key={sessionKey.sessionId}
    />
  );
}

function MotorsScreenBinding({
  sessionKey,
  navigation,
  subscribeTabBlur,
  bottomInset,
  onConfigurationDirtyChange,
}: {
  sessionKey: SetupUiSessionKey;
  navigation: MotorsHostNavigation;
  subscribeTabBlur: (listener: () => void) => () => void;
  bottomInset?: number;
  onConfigurationDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  /**
   * EXACTLY ONE binding owns the current official session. The capability
   * is resolved from the coordinator by sessionId, and the operator port
   * is the SAME sealed facade over the SAME single controller the
   * coordinator already owns - `operatorPort()` constructs at most one
   * controller per capability and returns it forever after. No second
   * client, transport, lease, queue, authority or encoder is created
   * anywhere in this file.
   *
   * The route container keys this component on `sessionKey.sessionId`, so
   * a session replacement REMOUNTS rather than re-parameterizing: a stale
   * screen's state, refs and effects are torn down before the replacement
   * mounts, and none of its callbacks can reach the new session.
   */
  /**
   * The operator facade for this session, resolved as soon as one exists.
   *
   * THE DEFECT THIS CLOSES. The capability is created in the coordinator's
   * `startTelemetry()`, in the continuation of `client.startReading()`.
   * Navigation to the post-connection route happens earlier, when ownership
   * goes ACTIVE, so this panel can mount while no capability exists yet.
   *
   * This used to be a `useMemo` keyed on `sessionKey.sessionId` - a value
   * that never changes for the life of the mounted panel. Under stack
   * navigation the screen remounted per navigation, so a read that came
   * back `undefined` could not persist. Under the tab shell the panel
   * mounts once and is kept alive with `display: 'none'`, so `undefined`
   * became PERMANENT: blocked presentation forever, hold control `disabled`
   * forever, pressing it doing nothing at all.
   *
   * State plus a store subscription rather than a memo with an epoch
   * dependency: `react-hooks/exhaustive-deps` correctly rejects that epoch
   * as unnecessary, and a dependency the linter wants removed is a fix that
   * silently un-fixes itself the first time someone tidies the warning.
   */
  const [operator, setOperator] = useState<MotorTestOperatorPort | undefined>(
    undefined,
  );
  useEffect(() => {
    /** Resolves at most ONE operator port for this session, ever. */
    const resolve = (): boolean => {
      const capability = readMotorTestCapability(sessionKey.sessionId);
      if (capability === undefined) {
        return false;
      }
      setOperator(
        existing =>
          existing ??
          capability.operatorPort(
            {
              readCurrentIdentity: () =>
                mspSessionCoordinator.getMotorTestSessionIdentity(
                  sessionKey.sessionId,
                ),
              readFirmwareIdentification: () =>
                mspSessionCoordinator.getIdentificationState(
                  sessionKey.sessionId,
                ),
              subscribeFirmwareIdentification: listener =>
                mspSessionCoordinator.subscribeIdentificationState(listener),
              subscribeSessionInvalidated: listener =>
                mspSessionCoordinator.subscribeMotorTestSessionInvalidated(
                  sessionKey.sessionId,
                  listener,
                ),
            },
            () => Date.now(),
          ),
      );
      return true;
    };
    // Checked BEFORE subscribing, so a capability that appeared between
    // render and effect is not missed.
    if (resolve()) {
      return;
    }
    return subscribeMotorTestCapabilityOpened(sessionKey.sessionId, () => {
      resolve();
    });
  }, [sessionKey.sessionId]);

  /**
   * The ACCEPTED lifecycle bridge owns every lifecycle trigger. This
   * component registers no competing listener of its own: `sources` below
   * hands the bridge React Navigation's and React Native's real APIs and
   * then stays out of the way.
   *
   * `beforeRemove` + `preventDefault()` is React Navigation 7's own
   * supported hold mechanism, and it is what covers BOTH a programmatic
   * removal and Android Back (classic and committed predictive) once the
   * native-stack screen is focused - a single mechanism rather than an
   * invented lifecycle.
   */
  useEffect(() => {
    if (operator === undefined) {
      return;
    }
    let replayed = false;
    const bridge = createMotorTestLifecycleBridge({
      controller: {
        getSnapshot: () => operator.getSnapshot(),
        requestStop: trigger => operator.requestStop(trigger),
      },
      sources: {
        addBackHandler: listener =>
          BackHandler.addEventListener('hardwareBackPress', listener),
        addAppStateListener: listener =>
          AppState.addEventListener('change', status => {
            listener(status as never);
          }),
        // TWO SOURCES, ONE LISTENER, ONE PATH. A stack blur (the shell
        // route losing focus) and a tab blur (the operator switching away
        // from Motors) mean the same thing to the bridge: this screen is
        // no longer in front of the operator while a command may be live.
        // Both are subscribed here and both reach the bridge's existing
        // blur handling - no parallel stop route is introduced for tabs.
        addBlurListener: listener => {
          const unsubscribeStackBlur = navigation.addListener('blur', listener);
          const unsubscribeTabBlur = subscribeTabBlur(listener);
          return () => {
            unsubscribeStackBlur();
            unsubscribeTabBlur();
          };
        },
        addBeforeRemoveListener: listener =>
          navigation.addListener('beforeRemove', listener),
      },
      replayNavigation: () => {
        // EXACTLY ONCE. The bridge already promises at most one call for a
        // decided-safe outcome; this guard makes a duplicated dispatch
        // impossible even if a future source double-fires, and prevents
        // the replayed goBack() from re-entering beforeRemove recursively.
        if (replayed) {
          return;
        }
        replayed = true;
        navigation.goBack();
      },
    });
    bridge.attach();

    // The release subscription. Deliberately NOT inside the bridge: the
    // bridge's contract is "request a whitelisted stop", and widening it to
    // own session teardown would make one object responsible for two
    // different safety obligations. This screen owns the second one, at the
    // one seam where leaving is observable.
    /**
     * WAIT FOR THE SESSION TO SETTLE, THEN RELEASE - AND ONLY IF THE STOP
     * PATH IS NOT ALREADY DOING IT.
     *
     * Both halves of that sentence were measured, not reasoned about, and
     * each replaced a wrong earlier version of this function.
     *
     * (1) NOT GUARDED ON `machine`. The first attempt returned early when
     *     `machine === undefined`. But `initializeSession()` takes the
     *     exclusive lease and the telemetry pause DURING setup, before the
     *     machine exists, so that guard leaked the likeliest operator
     *     window - the second between pressing begin and reaching Ready.
     *
     * (2) NOT AN IMMEDIATE, UNCONDITIONAL `endSession()` either. That
     *     version fixed the two settled cases and broke the unsettled one.
     *     Tearing down while a lease-guarded setup request is still in
     *     flight cannot work: `MspClient.releaseMotorTestLease` refuses
     *     while `active`/`queue` is non-empty and answers
     *     LEASE_WORK_UNSETTLED (mspClient.ts:1292), the controller
     *     correctly treats unresolved ownership as a reason to KEEP
     *     telemetry paused (motorTestController.ts:3219), and nothing ever
     *     retries. The measured result was a session wedged for good:
     *     phase CLOSED, machine Fault, lease held, telemetry paused
     *     forever. Left to itself the same departure ended
     *     CLOSED/Locked with leaseRelease RELEASED, because the bridge's
     *     `requestStop` drives the controller's OWN teardown, which
     *     releases at a point where its own in-flight work has settled.
     *
     * KNOWN GAP, recorded in docs/ARCHITECTURE.md ("Known gaps - future
     * hardening") rather than fixed here: the missing piece is a
     * retry-on-settle inside `MspClient` itself, which would hold for every
     * future caller instead of only for the one that remembered to wait.
     * That file is frozen for this work and changing it needs its own
     * approval, so this screen waits instead.
     *
     * So the rule is: the controller's own stop path knows when releasing
     * is possible and an outside caller does not. Defer to it whenever it
     * is acting, and only step in for the states it leaves alone - a
     * session sitting at Ready, or one still setting up that will reach
     * Ready after the operator has already gone.
     *
     * This delays no stop and weakens no gate. A pulse in flight is the
     * bridge's business and is unaffected: `requestStop` still fires
     * synchronously on blur, exactly as before. All this decides is who
     * hands back the lease afterwards, and when.
     */
    /** Settled = the controller is no longer mid-exchange, so a release can
     * actually resolve. `Checking` and "no machine yet" are the unsettled
     * setup states; `Pulsing`/`Stopping` belong to the stop path. */
    const isSettledForRelease = (
      snapshot: MotorTestControllerSnapshot,
    ): boolean => {
      const name = snapshot.machine?.name;
      return name === 'Ready' || name === 'Locked' || name === 'Fault';
    };

    let releasePending = false;
    let unsubscribeSettled: (() => void) | undefined;
    const stopWaiting = () => {
      unsubscribeSettled?.();
      unsubscribeSettled = undefined;
      releasePending = false;
    };

    const releaseIfStillHeld = () => {
      const snapshot = operator.getSnapshot();
      // Already closing or closed: the stop path owns this teardown, and
      // `endSession()` on top of it is the race that wedged the lease.
      if (snapshot.phase === 'CLOSING' || snapshot.phase === 'CLOSED') {
        stopWaiting();
        return;
      }
      if (!isSettledForRelease(snapshot)) {
        return;
      }
      stopWaiting();
      // Idempotent: returns the one stored teardown promise however many
      // times blur fires.
      operator.endSession().catch(() => undefined);
    };

    const releaseOnLeave = () => {
      // `IDLE` is the only phase in which nothing has been acquired and
      // there is genuinely nothing to release.
      if (operator.getSnapshot().phase === 'IDLE') {
        return;
      }
      if (releasePending) {
        return;
      }
      releasePending = true;
      // Subscribe FIRST, so a transition that lands between this call and
      // the subscription cannot be missed, then evaluate immediately for
      // the already-settled case.
      unsubscribeSettled = operator.subscribe(releaseIfStillHeld);
      releaseIfStillHeld();
    };
    const unsubscribeRelease = subscribeTabBlur(releaseOnLeave);
    const unsubscribeStackRelease = navigation.addListener(
      'blur',
      releaseOnLeave,
    );

    return () => {
      stopWaiting();
      unsubscribeRelease();
      unsubscribeStackRelease();
      bridge.detach();
    };
  }, [operator, navigation, subscribeTabBlur]);

  /**
   * REAL STATE, PUSHED - not a render-time read.
   *
   * WHAT THE FIRST VERSION GOT WRONG, and what it cost. This used to read
   * `getSessionBringUpFailure()` during render, on the reasoning that the
   * operator's next interaction would re-render the tree anyway. On real
   * hardware that reasoning failed exactly as it deserved to: the
   * acknowledgements had ALREADY been ticked before bring-up failed, so no
   * further re-render ever happened, and the cause stayed invisible while
   * the operator pressed a button that appeared to do nothing. "It shows up
   * on the next interaction" is not a property you get to assume when the
   * interactions have already happened.
   *
   * Same shape as the capability subscription below: read once immediately,
   * so a failure recorded before this effect ran is not missed, then
   * subscribe for one recorded later. No timer, no polling.
   */
  const [bringUpFailure, setBringUpFailure] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    const read = () => {
      const failure = mspSessionCoordinator.getSessionBringUpFailure(
        sessionKey.sessionId,
      );
      if (failure !== undefined) {
        setBringUpFailure(failure);
      }
    };
    read();
    return mspSessionCoordinator.subscribeSessionBringUpFailure(
      sessionKey.sessionId,
      read,
    );
  }, [sessionKey.sessionId]);
  return (
    <MotorsScreenView
      operator={operator}
      bottomInset={bottomInset}
      bringUpFailure={bringUpFailure}
      sessionId={sessionKey.sessionId}
      onConfigurationDirtyChange={onConfigurationDirtyChange}
    />
  );
}
