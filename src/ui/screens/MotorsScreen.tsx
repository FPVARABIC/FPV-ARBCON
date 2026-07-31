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
 *   - It never creates a second session, authority, controller, queue or
 *     three-second timer. The controller owns the watchdog; a UI timer
 *     racing it could only ever disagree with it.
 *   - It re-derives NO safety condition. Battery, armed state, lease,
 *     authority, scope and capability are evaluated once, in the
 *     controller, and read here as `snapshot.activation` - the SAME
 *     evaluation `pulseMotor()` itself performs.
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
 * THE MANUAL ACKNOWLEDGEMENT IS SUPPLEMENTAL. It is volatile component
 * state, never persisted, and it can only ever ADD a condition on top of
 * the controller's own. It resets on blur, session change, detach, lock
 * and fault.
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
  confirmObservation,
  EMPTY_VERIFICATION_STATE,
  finalizeVerification,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorPhysicalPosition,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type { MotorTestVerificationReceipt } from '../../core/state/motorTestController';

/**
 * The intentional long-press delay. No accepted shared constant exists
 * (searched, not assumed), so it is defined once, here, and used by the
 * single Pressable below.
 */
export const MOTOR_TEST_LONG_PRESS_DELAY_MILLIS = 800;

/** MSP OUTPUT SLOTS. Not airframe positions, not rotation directions. */
export const MOTOR_TEST_OUTPUT_SLOTS: readonly number[] = Object.freeze([
  1, 2, 3, 4,
]);

/* ================================================================== *
 * THE MOTOR GLYPH LAYOUT.
 *
 * NAMING. This is `computeMotorGlyphLayout`, and the name is load-bearing:
 * it computes where a LABEL is drawn on screen. It builds no payload,
 * names no command, and its output can never be sent anywhere. A name like
 * "computeMotorFrame" reads at a call site like something that produces
 * wire data, and this must never be mistaken for that.
 *
 * WHAT WAS WRONG BEFORE. The cells were emitted in slot order (M1, M2, M3,
 * M4) into a 2-column wrapping grid, which put M2 (front-right) and M1
 * (rear-right) in the SAME top row - rotating the aircraft 90 degrees
 * against reality. The labels were right; the geometry was not.
 *
 * THE CORRECT RTL PLACEMENT:
 *
 *      top-right    = M2  front-right
 *      top-left     = M4  front-left
 *      bottom-right = M1  rear-right
 *      bottom-left  = M3  rear-left
 *
 * `row`/`side` are emitted as DATA rather than left implicit in array
 * order, so a test can assert the spatial claim directly instead of
 * inferring it from how flexbox happened to wrap.
 *
 * THE SLOT NUMBERS ARE THE SINGLE SOURCE OF TRUTH IN
 * `MOTOR_TEST_EXPECTED_CONFIGURATION`. This module derives from it and
 * never restates it - a second copy of the mapping is exactly how a
 * diagram and a payload come to disagree.
 * ================================================================== */

export type MotorGlyphRow = 'FRONT' | 'REAR';
export type MotorGlyphSide = 'RIGHT' | 'LEFT';

export interface MotorGlyphCell {
  /** MSP OUTPUT SLOT, 1..4 - the same number `pulseMotor()` takes. */
  readonly slot: number;
  readonly row: MotorGlyphRow;
  readonly side: MotorGlyphSide;
  readonly positionKey: string;
  readonly directionKey: string;
}

const POSITION_GEOMETRY: Record<
  MotorPhysicalPosition,
  { row: MotorGlyphRow; side: MotorGlyphSide; positionKey: string }
> = {
  FRONT_RIGHT: {
    row: 'FRONT',
    side: 'RIGHT',
    positionKey: 'positionFrontRight',
  },
  FRONT_LEFT: { row: 'FRONT', side: 'LEFT', positionKey: 'positionFrontLeft' },
  REAR_RIGHT: { row: 'REAR', side: 'RIGHT', positionKey: 'positionRearRight' },
  REAR_LEFT: { row: 'REAR', side: 'LEFT', positionKey: 'positionRearLeft' },
};

/**
 * Render order, RTL: within each row the RIGHT cell comes first, because
 * `flexDirection: 'row'` under the app's forceRTL lays the first child at
 * the right edge. Rows run front-then-rear, top to bottom.
 */
const GLYPH_ORDER: readonly MotorPhysicalPosition[] = Object.freeze([
  'FRONT_RIGHT',
  'FRONT_LEFT',
  'REAR_RIGHT',
  'REAR_LEFT',
]);

export function computeMotorGlyphLayout(): readonly MotorGlyphCell[] {
  return Object.freeze(
    GLYPH_ORDER.map(position => {
      const expected = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
        entry => entry.position === position,
      );
      if (expected === undefined) {
        // Unreachable while the accepted configuration covers all four
        // positions, which its own tests assert. Throwing beats drawing a
        // cell with no slot number on a motor diagram.
        throw new Error(`No expected mapping for position ${position}`);
      }
      const geometry = POSITION_GEOMETRY[position];
      return Object.freeze({
        slot: expected.motorNumber,
        row: geometry.row,
        side: geometry.side,
        positionKey: geometry.positionKey,
        directionKey:
          expected.direction === 'CW' ? 'directionCw' : 'directionCcw',
      });
    }),
  );
}

/** The two rendered rows, front first. */
export function motorGlyphRows(): readonly (readonly MotorGlyphCell[])[] {
  const cells = computeMotorGlyphLayout();
  return Object.freeze([
    cells.filter(cell => cell.row === 'FRONT'),
    cells.filter(cell => cell.row === 'REAR'),
  ]);
}

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
}

interface Acknowledgements {
  readonly propellers: boolean;
  readonly secured: boolean;
  readonly battery: boolean;
}

const NO_ACKNOWLEDGEMENTS: Acknowledgements = Object.freeze({
  propellers: false,
  secured: false,
  battery: false,
});

function allAcknowledged(value: Acknowledgements): boolean {
  return value.propellers && value.secured && value.battery;
}

export function MotorsScreenView({
  operator,
  onRequestLeave,
  bottomInset,
  bringUpFailure,
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
  const [acknowledgements, setAcknowledgements] =
    useState<Acknowledgements>(NO_ACKNOWLEDGEMENTS);

  /** Guards every asynchronous continuation. A callback that survives
   * unmount must never call setState. */
  const mountedRef = useRef(true);
  /** One continuous hold may activate at most once. Reset on release. */
  const holdActivatedRef = useRef(false);
  /** Read at CALL time, so a stale closure still sees live state - the
   * same reasoning UsbSerialDebugPanel's own mspActiveRef guard uses. */
  const operatorRef = useRef(operator);
  operatorRef.current = operator;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  // The manual acknowledgement is VOLATILE and supplemental. It resets the
  // moment the session stops being one an operator has vouched for: a
  // lock, a fault, a session replacement or the loss of the operator port
  // (blur/detach both surface here as a changed binding or a changed
  // machine state). It is never persisted anywhere.
  //
  // KEYED ON THE REDUCER, NOT ON THE PRESENTATION. It used to reset on the
  // LOCKED presentation, and a session that is merely re-reading the armed
  // state after a confirmed stop renders as LOCKED for the few
  // milliseconds that reading is in flight. So a perfectly normal release
  // wiped all three checkboxes, and testing four motors meant ticking
  // twelve. The reducer's own state is the honest boundary: `Locked` and
  // `Fault` are real session endings, `Ready` is not - however briefly its
  // gate happens to be closed.
  const machineName = snapshot?.machine?.name;
  useEffect(() => {
    if (
      operator === undefined ||
      machineName === undefined ||
      machineName === 'Locked' ||
      machineName === 'Fault'
    ) {
      setAcknowledgements(NO_ACKNOWLEDGEMENTS);
    }
  }, [operator, machineName]);

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

  const acknowledged = allAcknowledged(acknowledgements);
  // BOTH gates, and the controller's is the authoritative one. The manual
  // gate can only ever subtract permission, never add it.
  const canActivate = controllerAllows && acknowledged;

  const toggle = useCallback((key: keyof Acknowledgements) => {
    setAcknowledgements(current => ({ ...current, [key]: !current[key] }));
  }, []);

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
   * STEP 1 OF TWO DELIBERATE ACTIONS: start the session.
   *
   * WHY THIS CONTROL EXISTS AT ALL. `beginSession()` -> the controller's
   * `initializeSession()` is the ONLY thing that can start a session, and
   * nothing in this screen ever called it. Without it the controller has no
   * machine, `derivePresentation()` returns NO_SESSION forever, and the
   * hold control below stays `disabled` - so the screen looked alive and
   * responded to nothing. It had never been reachable in the project's
   * history because the old bench variant was blocked by design.
   *
   * WHY IT IS NOT AUTOMATIC. `beginSession()` acquires the exclusive lease,
   * pauses telemetry and establishes the arming restriction. None of that
   * may happen as a side effect of navigation - the operator asks for it.
   */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [beginning, setBeginning] = useState(false);
  const [beginFailed, setBeginFailed] = useState(false);
  /**
   * WHY EVERY PRESS IS COUNTED AND ANSWERED.
   *
   * On real hardware the operator pressed this button repeatedly and saw
   * NOTHING change - because both guards below used to `return` silently.
   * A control that refuses without saying so is indistinguishable from a
   * dead one, and it cost a hardware session to discover that.
   *
   * The counter exists so the refusal is unmissable even when the same
   * reason is ALREADY on screen: without it, the second press onto an
   * already-visible reason line looks exactly like no response at all.
   */
  const [refusal, setRefusal] = useState<'NONE' | 'NO_SESSION' | 'NEEDS_ACK'>(
    'NONE',
  );
  const [beginAttempts, setBeginAttempts] = useState(0);

  const handleBeginSession = useCallback(() => {
    setBeginAttempts(previous => previous + 1);
    const port = operatorRef.current;
    if (port === undefined) {
      // NEVER a silent return. This is the exact state the device was in.
      setRefusal('NO_SESSION');
      return;
    }
    // The SAME manual gate the hold control uses. Re-read at call time: a
    // gate that was open when this closure was created proves nothing now.
    if (!allAcknowledged(acknowledgements)) {
      setRefusal('NEEDS_ACK');
      return;
    }
    setRefusal('NONE');
    setBeginning(true);
    setBeginFailed(false);
    void port
      .beginSession()
      .then(snapshot => {
        if (!mountedRef.current) {
          return;
        }
        // NEVER silently inert. If the session did not reach a machine the
        // operator can act on, say so - the real blockReason list below is
        // published by the controller and renders itself.
        setBeginFailed(snapshot.machine === undefined);
      })
      .catch(() => {
        if (mountedRef.current) {
          setBeginFailed(true);
        }
      })
      .then(() => {
        if (mountedRef.current) {
          setBeginning(false);
        }
      });
  }, [acknowledgements]);

  const handleLongPress = useCallback(() => {
    if (holdActivatedRef.current) {
      return;
    }
    const port = operatorRef.current;
    if (port === undefined) {
      return;
    }
    // Re-read the authoritative gate at CALL time. A gate that was open
    // when this closure was created proves nothing about now.
    if (!port.getSnapshot().activation.allowed) {
      return;
    }
    if (!allAcknowledged(acknowledgements)) {
      return;
    }
    holdActivatedRef.current = true;
    port.pulseMotor(selectedSlot);
  }, [acknowledgements, selectedSlot]);

  /** Release AND responder termination land here. Both must stop. */
  const handlePressOut = useCallback(() => {
    const activated = holdActivatedRef.current;
    holdActivatedRef.current = false;
    // Stop whenever a command may be live - including the pre-ACK window,
    // where `mayBeLive` is already true because the controller latches it
    // at activation rather than at acknowledgement.
    if (activated || commandMayBeLive(operatorRef.current?.getSnapshot())) {
      stopNow('TOUCH_RELEASED');
    }
  }, [stopNow]);

  const handleStopPress = useCallback(() => {
    holdActivatedRef.current = false;
    stopNow('STOP_BUTTON_PRESSED');
  }, [stopNow]);

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
        port.requestStop('MOTOR_SELECTION_CHANGED');
      }
    }
    setSelectedSlot(slot);
  }, []);

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

  /**
   * One control, rendered at the point that matches the current flow:
   * beside the output selector once the session exists, or directly after
   * the Step-1 card before it exists. This prevents the optional reference
   * and verification report from pushing the primary action down the page.
   */
  const holdControl = (
    <Pressable
      onLongPress={handleLongPress}
      delayLongPress={MOTOR_TEST_LONG_PRESS_DELAY_MILLIS}
      onPressOut={handlePressOut}
      onResponderTerminate={(_event: GestureResponderEvent) =>
        handlePressOut()
      }
      disabled={!canActivate}
      accessibilityRole="button"
      accessibilityState={{ disabled: !canActivate }}
      style={[styles.holdButton, !canActivate && styles.holdButtonOff]}
      testID="motors-hold-button"
    >
      <Text
        style={[styles.holdStep, canActivate && styles.holdSupportingActive]}
      >
        {t('motorsScreen.holdHeading')}
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
      style={[
        styles.root,
        { paddingBottom: effectiveBottomInset },
      ]}
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

        {/* (1) Propeller removal - highest priority, text AND icon, never
            colour alone. */}
        <View style={styles.dangerBanner} testID="motors-propeller-warning">
          <Text style={styles.dangerIcon}>⚠</Text>
          <View style={styles.flexOne}>
            <Text style={styles.dangerTitle}>
              {t('motorsScreen.propellerWarning')}
            </Text>
            <Text style={styles.dangerBody}>
              {t('motorsScreen.propellerWarningDetail')}
            </Text>
          </View>
        </View>

        {/* (2) Volatile manual acknowledgement - supplemental only. */}
        <View style={styles.card} testID="motors-acknowledgements">
          <Text style={styles.sectionTitle}>
            {t('motorsScreen.acknowledgeHeading')}
          </Text>
          {(
            [
              ['propellers', 'ackPropellers'],
              ['secured', 'ackSecured'],
              ['battery', 'ackBattery'],
            ] as const
          ).map(([key, labelKey]) => (
            <Pressable
              key={key}
              onPress={() => toggle(key)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: acknowledgements[key] }}
              style={styles.checkRow}
              testID={`motors-ack-${key}`}
            >
              <Text
                style={[
                  styles.checkBox,
                  acknowledgements[key] && styles.checkBoxOn,
                ]}
              >
                {acknowledgements[key] ? '☑' : '☐'}
              </Text>
              <Text style={styles.checkLabel}>
                {t(`motorsScreen.${labelKey}`)}
              </Text>
            </Pressable>
          ))}
          {/* The battery scope is a HARD limit enforced by the controller,
              not a preference. Stated imperatively next to the checkbox
              that claims it, so "4S only" is never something the operator
              has to infer from a block reason after the fact. */}
          <Text
            style={styles.batteryWarning}
            testID="motors-battery-scope-warning"
          >
            {t('motorsScreen.batteryScopeWarning')}
          </Text>
          <Text style={styles.caption}>{t('motorsScreen.ackNotice')}</Text>
        </View>

        {/* (3) Authoritative status and blocking reasons. */}
        <View style={styles.card} testID="motors-status">
          <Text style={styles.sectionTitle}>
            {t('motorsScreen.statusHeading')}
          </Text>
          <Text
            style={[styles.statusText, { color: statusColor }]}
            testID={`motors-status-${presentation}`}
          >
            {statusText}
          </Text>
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
                    {JSON.stringify(snapshot?.motorScope ?? null)}
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

        {/* (4) The four selectable MSP output cards. */}
        <View style={styles.card} testID="motors-outputs">
          <Text style={styles.sectionTitle}>
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
                ]}
                testID={`motors-slot-${slot}`}
              >
                {/* Forced LTR so M1..M4 stay readable inside the RTL page. */}
                <Text style={styles.slotLabel}>{`M${slot}`}</Text>
                {selectedSlot === slot ? (
                  <Text style={styles.slotSelected}>
                    ✓ {t('motorsScreen.selected')}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>

        {presentation !== 'NO_SESSION' ? holdControl : null}

        {/* (5) The EXPECTED Quad X reference - labelled as expected, and
            laid out so the top of the diagram IS the front of the
            aircraft. */}
        <View style={styles.card} testID="motors-diagram">
          <Pressable
            onPress={() => setReferenceOpen(current => !current)}
            accessibilityRole="button"
            accessibilityState={{ expanded: referenceOpen }}
            style={styles.referenceHeader}
            testID="motors-diagram-toggle"
          >
            <View style={styles.flexOne}>
              <Text style={styles.sectionTitle}>
                {t('motorsScreen.diagramHeading')}
              </Text>
              <Text style={styles.caption}>
                {t('motorsScreen.diagramSummary')}
              </Text>
            </View>
            <View style={styles.referenceToggle}>
              <Text style={styles.referenceToggleText}>
                {t(
                  referenceOpen
                    ? 'motorsScreen.hideReference'
                    : 'motorsScreen.showReference',
                )}
              </Text>
              <Text style={styles.referenceToggleIcon}>
                {referenceOpen ? '⌃' : '⌄'}
              </Text>
            </View>
          </Pressable>

          <View
            style={!referenceOpen ? styles.hiddenDetails : undefined}
            accessibilityElementsHidden={!referenceOpen}
            importantForAccessibility={
              referenceOpen ? 'auto' : 'no-hide-descendants'
            }
            testID="motors-diagram-details"
          >
            {/* The front-of-aircraft indicator. Without it a square of four
              cells is orientation-ambiguous, and an operator comparing it
              to a drone facing the other way reads every position
              backwards. */}
            <View style={styles.frontIndicator} testID="motors-diagram-front">
              <Text style={styles.frontArrow}>▲</Text>
              <Text style={styles.frontLabel}>
                {t('motorsScreen.diagramFront')}
              </Text>
            </View>

            {motorGlyphRows().map(row => (
              <View key={row[0].row} style={styles.diagramRow}>
                {row.map(cell => (
                  <View
                    key={cell.slot}
                    style={[
                      styles.diagramCell,
                      selectedSlot === cell.slot && styles.diagramCellSelected,
                    ]}
                    testID={`motors-diagram-cell-${cell.row}-${cell.side}`}
                  >
                    {/* The slot number rendered here is the SAME number
                      handed to pulseMotor(), which the controller turns
                      into payload index slot-1. A test asserts that
                      identity end to end. */}
                    <Text
                      style={styles.slotLabel}
                      testID={`motors-diagram-slot-${cell.slot}`}
                    >
                      {`M${cell.slot}`}
                    </Text>
                    <Text style={styles.diagramText}>
                      {t(`motorsScreen.${cell.positionKey}`)}
                    </Text>
                    <Text style={styles.diagramText}>
                      {t(`motorsScreen.${cell.directionKey}`)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}

            <Text style={styles.caption} testID="motors-diagram-front-hint">
              {t('motorsScreen.diagramFrontHint')}
            </Text>
            <Text style={styles.caption} testID="motors-diagram-notice">
              {t('motorsScreen.diagramNotice')}
            </Text>
            {/* THE DIRECTIONS ARE NOT READ FROM THE FLIGHT CONTROLLER.
              Investigated rather than assumed: the only MSP field that
              looks related is MSP_MIXER_CONFIG's `yaw_motors_reversed`,
              and at BETAFLIGHT_2025_12_2 the firmware uses it in exactly
              one place - to flip the sign of the yaw PID term. It does not
              remap outputs and is not evidence of physical rotation or of
              props-out installation (see decodeMixerConfig.ts). There is
              therefore nothing to derive from, and the CW/CCW labels are
              stated as the Betaflight default rather than as this
              aircraft's configuration. */}
            {/* REVERSAL IS NOT OFFERED, AND THE SCREEN SAYS SO.
              Audited rather than assumed. Real per-motor reversal on this
              hardware means DShot special commands 20/21 followed by SAVE
              (12), carried by MSP2_SEND_DSHOT_COMMAND, or the BLHeli
              4-way passthrough interface. This build implements NEITHER -
              there is no DShot-command encoder and no passthrough client
              anywhere in it, and MSP_MIXER_CONFIG's `yaw_motors_reversed`
              is a yaw PID sign flip, not an output direction.

              And the readback matters as much as the write: at the pinned
              Betaflight tag NO MSP command reports an ESC's spin
              direction, so a DShot reversal could be SENT but never
              CONFIRMED - it would be a persistent write to ESC EEPROM
              whose result this app could not verify. Rather than offer
              that, or fake it by flipping a label, the screen states the
              limit and names the tool that does it properly. */}
            <Text
              style={styles.caption}
              testID="motors-direction-reversal-support"
            >
              {t('motorsScreen.directionReversalUnsupported')}
            </Text>
            <Text
              style={styles.caption}
              testID="motors-diagram-direction-source"
            >
              {t('motorsScreen.diagramDirectionSource')}
            </Text>
          </View>
        </View>

        {/* Phase 2I - the observation wizard. It CANNOT activate anything;
            a new output always needs a fresh long press below. */}
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
            // A normal completed report requires an attributable safe
            // teardown. Anything else keeps the fault presentation.
            safeTeardownConfirmed={
              presentation !== 'FAULT' &&
              (snapshot?.stopExecution.attributionAmbiguous !== true ||
                snapshot?.stopExecution.attributionResolvedByConfirmation ===
                  true)
            }
          />
        ) : null}

        {/* (5b) STEP 1 - START THE SESSION. Deliberately a separate,
            differently-shaped, differently-coloured control from the
            hold-to-test button: this one reserves the channel, it does not
            spin anything. Only offered while there is no machine yet.

            THE CARD IS NO LONGER HIDDEN WHEN `operator` IS UNDEFINED, and
            that is the whole point of this shape.

            WHAT WENT WRONG ON THE DEVICE. This card used to require
            `operator !== undefined` as well. `operator` is the port read
            out of the motor-test capability store, which the coordinator
            fills in `startTelemetry()` - a completely different condition
            from the three acknowledgements, and one the operator has no
            way to see or influence. On a real device the acknowledgements
            were all ticked, the status read "no active session", and this
            entire card was simply ABSENT: no control, no explanation, and
            nothing to distinguish "waiting for the link" from "this build
            shipped without the feature". Two evenings of investigation
            went into a symptom the screen could have named itself.

            So absence is replaced by a legible disabled state. The gate is
            unchanged in strength - `handleBeginSession` cannot run without
            an operator, because the Pressable stays `disabled` until one
            exists - but the reason is now on screen. A control that cannot
            act is still worth rendering when the alternative is a blank
            gap that looks like a missing feature. */}
        {presentation === 'NO_SESSION' ? (
          <View style={styles.card} testID="motors-begin-session-card">
            <Text style={styles.sectionTitle}>
              {t('motorsScreen.beginSessionHeading')}
            </Text>
            <Text style={styles.caption}>
              {t('motorsScreen.beginSessionHint')}
            </Text>
            {/* DISABLED ONLY WHILE A BEGIN IS ACTUALLY IN FLIGHT.
                It used to be disabled whenever there was no operator port or
                the acknowledgements were incomplete, which meant `onPress`
                never fired at all and the operator got no answer of any
                kind. Refusal now happens INSIDE `handleBeginSession`, where
                it can say why. That is not a weaker gate: the handler
                re-reads the port and the acknowledgements at call time and
                returns before touching `beginSession()`, exactly as the
                `disabled` prop did, and with no port there is nothing to
                call in the first place.

                `pressed` drives an immediate style change on touch-down -
                before any async result exists - so a tap is visibly
                registered even when the outcome takes a moment. */}
            <Pressable
              onPress={handleBeginSession}
              disabled={beginning}
              accessibilityRole="button"
              accessibilityState={{ disabled: beginning }}
              style={({ pressed }) => [
                styles.beginButton,
                (operator === undefined || !acknowledged || beginning) &&
                  styles.beginButtonOff,
                pressed && styles.beginButtonPressed,
              ]}
              testID="motors-begin-session"
            >
              <Text style={styles.beginLabel}>
                {beginning
                  ? t('motorsScreen.beginSessionBusy')
                  : t('motorsScreen.beginSession')}
              </Text>
            </Pressable>
            {/* Reuses the existing status string rather than adding a new
                one: it is already the exact truth here, and it is already
                in the shipped bundle. */}
            {operator === undefined ? (
              <Text style={styles.blockReason} testID="motors-begin-no-session">
                {t('motorsScreen.noSession')}
                {beginAttempts > 0 ? ` (${beginAttempts})` : ''}
              </Text>
            ) : null}
            {/* The ACTUAL cause, when bring-up threw. This is the line that
                is meant to end the guessing: previously a throw here left
                `operator` silently undefined and the screen said nothing at
                all. Rendered only in the blocked state, so a healthy session
                never shows developer text. */}
            {operator === undefined && bringUpFailure !== undefined ? (
              <Text style={styles.caption} testID="motors-begin-bringup-error">
                {bringUpFailure}
              </Text>
            ) : null}
            {operator !== undefined && !acknowledged ? (
              <Text
                style={
                  refusal === 'NEEDS_ACK' ? styles.blockReason : styles.caption
                }
                testID="motors-begin-needs-ack"
              >
                {t('motorsScreen.beginSessionNeedsAck')}
                {refusal === 'NEEDS_ACK' && beginAttempts > 0
                  ? ` (${beginAttempts})`
                  : ''}
              </Text>
            ) : null}
            {beginFailed ? (
              <Text style={styles.blockReason} testID="motors-begin-failed">
                {t('motorsScreen.beginSessionFailed')}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* (6) STEP 2 remains after Step 1 while no session exists. Once
            READY, the same element moves beside the output selector above. */}
        {presentation === 'NO_SESSION' ? holdControl : null}

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
    maxWidth: 760,
    alignSelf: 'center',
  },
  flexOne: { flex: 1 },
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
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    // M1..M4 are latin identifiers; forced LTR keeps them readable inside
    // the RTL page instead of being reordered around the digit.
    writingDirection: 'ltr',
  },
  slotSelected: { ...typography.caption, color: colors.accent },
  referenceHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  referenceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accentSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  referenceToggleText: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  referenceToggleIcon: {
    color: colors.accent,
    fontSize: 14,
  },
  hiddenDetails: {
    display: 'none',
  },
  frontIndicator: { alignItems: 'center', gap: spacing.xs },
  frontArrow: { fontSize: 18, color: colors.accent },
  frontLabel: {
    ...typography.caption,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  /* TWO EXPLICIT ROWS, never a wrapping grid. A wrap depends on measured
     cell widths to decide where the break falls, which is exactly how the
     aircraft came to be drawn rotated 90 degrees. Each row is rendered
     from its own data, front row first. */
  diagramRow: { flexDirection: 'row', gap: spacing.sm },
  diagramCell: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  diagramCellSelected: { borderColor: colors.accent, borderWidth: 2 },
  batteryWarning: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  diagramText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
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
}

export default function MotorsTab({
  sessionKey,
  navigation,
  subscribeTabBlur,
  bottomInset,
}: MotorsTabProps): React.JSX.Element {
  if (!sessionKey) {
    // No live session: the screen renders inert and blocked. That is the
    // correct presentation for a tab opened before a connection exists -
    // not an error, and not something to hide the tab over.
    return <MotorsScreenView operator={undefined} bottomInset={bottomInset} />;
  }
  return (
    <MotorsScreenBinding
      sessionKey={sessionKey}
      navigation={navigation}
      subscribeTabBlur={subscribeTabBlur}
      bottomInset={bottomInset}
      key={sessionKey.sessionId}
    />
  );
}

function MotorsScreenBinding({
  sessionKey,
  navigation,
  subscribeTabBlur,
  bottomInset,
}: {
  sessionKey: SetupUiSessionKey;
  navigation: MotorsHostNavigation;
  subscribeTabBlur: (listener: () => void) => () => void;
  bottomInset?: number;
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
      void operator.endSession();
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
    />
  );
}
