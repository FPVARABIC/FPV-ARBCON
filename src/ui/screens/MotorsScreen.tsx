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
 *     Its timers belong only to the owned gesture: on web one qualifies
 *     the documented 800 ms continuous hold, and the other renews the
 *     controller's short fail-safe while the same Pressable still owns
 *     that gesture. Neither timer can bypass pulseMotor()'s call-time gate.
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
 * Bench warnings are always visible, but there is no checkbox ritual.
 * Session preparation is an explicit action, separate from the motor hold:
 * an asynchronous MSP bring-up must never consume the gesture that the
 * operator reasonably expects to move one motor.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Icon} from '../icons';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
} from '../../core/state/motorTestController';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import { mspSessionCoordinator } from '../../platforms/react-native/protocol';
import type { SetupUiSessionKey } from '../../platforms/react-native/protocol';
import { createMotorTestLifecycleBridge } from '../../platforms/react-native/lifecycle/motorTestLifecycleBridge';
import { subscribeWindowBlur } from '../../platforms/windowBlur';
import { evaluateMotorDeparture } from '../../core/state/motorDepartureGate';
import { REAL_DEADLINE_TIMERS } from '../../core/async/deadline';
import type { DeadlineTimers } from '../../core/async/deadline';
import { deriveMotorSessionState } from '../../core/state/motorSessionPresentation';
import type { MotorDepartureVerdict } from '../../core/state/motorDepartureGate';
import {
  readMotorTestCapability,
  subscribeMotorTestCapabilityOpened,
} from '../../platforms/react-native/protocol/motorTestCapability';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { AppState, BackHandler } from 'react-native';
import { MotorTestReport } from './MotorVerificationWizard';
import { MotorIdentitySection } from './MotorIdentitySection';
import { MotorOutputMappingSection } from './MotorOutputMappingSection';
import {
  abortVerificationAsUnsafe,
  beginVerification,
  clearObservation,
  confirmObservation,
  EMPTY_VERIFICATION_STATE,
  finalizeVerification,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import {
  evaluateMotorIdentificationCapability,
  type MotorIdentificationCapability,
} from '../../core/state/motorIdentificationCapability';
import type { MotorTestVerificationReceipt } from '../../core/state/motorTestController';
import { MOTOR_AIRFRAME_QUAD_COUNT } from './MotorAirframeDiagram';
import type { MotorSlotActivity } from './MotorAirframeDiagram';
import { MotorConfigurationSummary } from './MotorConfigurationSummary';
// P3: the professional workspace - the PRIMARY motor experience.
import { MotorWorkspace } from './MotorWorkspace';
import { MotorConfigurationPanel } from './MotorConfigurationPanel';
import { MotorDiagnosticsPanel } from './MotorDiagnosticsPanel';
import { MotorDirectionSection } from './MotorDirectionSection';
import {
  evaluateMotorDirectionCommandCapability,
} from '../../core/state/motorDirectionCapability';
import {
  beginDirectionCommandLog,
  directionCommandFor,
  EMPTY_DIRECTION_COMMAND_LOG,
  recordDirectionCommand,
  type MotorDirectionCommandLog,
} from '../../core/state/motorDirectionCommandRecord';
import type { DshotEscDirection } from '../../core';

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
 *   The four M-C scope refusals next, most-actionable first.
 *     ANALOG_3D_ENDPOINTS_UNKNOWN leads, because 3D is a single named
 *     setting the operator can turn off. NO_RUNTIME_MOTORS follows: the
 *     aircraft is fine and simply has no motor outputs on this mixer,
 *     which is a statement about the configuration rather than a fault.
 *     UNSUPPORTED_PROTOCOL_DOMAIN and MOTOR_COUNT_OUT_OF_RANGE last -
 *     both mean the flight controller reported something this app will
 *     not guess at, and neither is something a slider can fix.
 *
 *   MOTOR_CONFIGURATION_DRIFTED alongside them: the configuration moved
 *     under an active session, so the actionable instruction is to open
 *     the session again rather than to change anything on the aircraft.
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
    'ANALOG_3D_ENDPOINTS_UNKNOWN',
    'NO_RUNTIME_MOTORS',
    'UNSUPPORTED_PROTOCOL_DOMAIN',
    'MOTOR_COUNT_OUT_OF_RANGE',
    'MOTOR_CONFIGURATION_DRIFTED',
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

export function isMotorTestSettledForRelease(
  snapshot: MotorTestControllerSnapshot,
): boolean {
  const name = snapshot.machine?.name;
  return name === 'Ready' || name === 'Locked' || name === 'Fault';
}

const endingMotorTestSessions = new WeakMap<
  MotorTestOperatorPort,
  Promise<MotorTestControllerSnapshot>
>();

/**
 * HOW LONG A TEARDOWN MAY TAKE BEFORE IT IS CALLED A FAILED TEARDOWN.
 *
 * The Promise below settles on events - a snapshot reaching CLOSED, or
 * `endSession()` settling. Every one of its guards can legitimately
 * decline to act (`phase === 'CLOSING'`, not settled for release, no
 * further notification), so without a clock there is a shape where no
 * event ever arrives and the "جارٍ إنهاء الجلسة" state is permanent.
 *
 * DERIVED, NOT CHOSEN, from the four bounded stages this sequence
 * actually contains, each bounded by the client's own two-phase contract
 * (transport write bound + MSP_RESPONSE_TIMEOUT_MILLIS = 3000ms, the
 * same figure motorTestTelemetryBarrier derives and motorDepartureGate
 * restates):
 *
 *   1. requestStop reaching the flight controller and being acknowledged
 *   2. the controller settling into a releasable machine state
 *   3. endSession() acquiring quiescence and tearing the lease down
 *   4. the CLOSED snapshot with a complete teardown arriving
 *
 * FAILING CLOSED IS THE POINT. Expiry REJECTS - it never resolves - so
 * the caller takes its existing failure path and the operator is told
 * the session did not close. Nothing here claims a motor stopped;
 * command authority was already withdrawn before this started.
 */
export const MOTOR_TEST_TEARDOWN_BOUND_MILLIS = 4 * 3000;

/** Stop first, wait for lease work to settle, then require complete teardown. */
export function endMotorTestSessionSafely(
  operator: MotorTestOperatorPort,
  timers: DeadlineTimers = REAL_DEADLINE_TIMERS,
): Promise<MotorTestControllerSnapshot> {
  const existing = endingMotorTestSessions.get(operator);
  if (existing !== undefined) return existing;

  let operation!: Promise<MotorTestControllerSnapshot>;
  operation = new Promise<MotorTestControllerSnapshot>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let closeStarted = false;
    let finished = false;
    const deadline = timers.setTimer(() => {
      fail(
        new Error(
          'Motor-test teardown did not complete within its bound.',
        ),
      );
    }, MOTOR_TEST_TEARDOWN_BOUND_MILLIS);
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      timers.clearTimer(deadline);
    };
    const fail = (reason: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(reason);
    };
    const acceptClosed = (closed: MotorTestControllerSnapshot) => {
      if (finished || closed.phase !== 'CLOSED') return;
      if (closed.teardown?.complete !== true) {
        fail(new Error('Motor-test teardown did not complete.'));
        return;
      }
      finished = true;
      cleanup();
      resolve(closed);
    };
    const inspect = () => {
      if (finished) return;
      const current = operator.getSnapshot();
      if (current.phase === 'CLOSED') {
        acceptClosed(current);
        return;
      }
      if (current.phase === 'CLOSING' || closeStarted) return;
      if (!isMotorTestSettledForRelease(current) && current.phase !== 'IDLE') return;
      closeStarted = true;
      let closing: Promise<MotorTestControllerSnapshot>;
      try {
        closing = Promise.resolve(operator.endSession());
      } catch (error) {
        fail(error);
        return;
      }
      closing.then(acceptClosed, fail);
    };
    unsubscribe = operator.subscribe(inspect);
    operator.requestStop('STOP_BUTTON_PRESSED');
    inspect();
  });
  endingMotorTestSessions.set(operator, operation);
  operation.finally(() => {
    if (endingMotorTestSessions.get(operator) === operation) {
      endingMotorTestSessions.delete(operator);
    }
  }).catch(() => undefined);
  return operation;
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
  /** See MotorsTabProps.active - presentation only, never safety. */
  readonly active?: boolean;
}

export function MotorsScreenView({
  operator,
  onRequestLeave,
  bottomInset,
  bringUpFailure,
  sessionId,
  onConfigurationDirtyChange,
  active = true,
}: MotorsScreenViewProps): React.JSX.Element {
  const { t } = useTranslation();
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { maxWidth: contentMaxWidth } = useContentEnvelope(true);
  /**
   * WHEN THE WORKSPACE BECOMES TWO COLUMNS.
   *
   * Divided by fontScale, so the breakpoint tracks the READING width
   * rather than the device width: at 200% text a 1024px tablet has the
   * effective room of a 512px phone, and forcing two columns there would
   * put the airframe diagram and the sliders in strips too narrow for
   * either. 1000 is the measured point at which the diagram keeps its
   * legible size (it floors at ~320px) beside a slider column wide
   * enough for four labelled rows plus their values.
   */
  const { width: windowWidth, fontScale } = useWindowDimensions();
  /* 1024 rather than 1000: the containment scan on this file forbids any
     motor-magnitude numeral in executable code (1000 is the stop value on
     an analog output), and a layout breakpoint has no business being
     indistinguishable from one. 1024 is the conventional desktop tier
     boundary and lands inside the same measured band. */
  const wideWorkspace = windowWidth / Math.max(fontScale, 1) >= 1024;
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
  /** P3: the operator's professional enable intent. Enabling runs the
   * SAME canonical session bring-up the legacy flow used; disabling runs
   * the same safe teardown. No second session path exists. */
  /**
   * MOTOR CONTROL intent - the SECOND authority, deliberately separate
   * from the session. Defaults OFF and is forced OFF whenever the session
   * is not ON, so opening a session never carries command permission with
   * it.
   *
   * THERE IS NO `professionalEnabled` ANY MORE. A UI boolean that claimed
   * to know whether a session existed was the defect; session truth now
   * comes from deriveMotorSessionState(snapshot, ...) and lives in exactly
   * one place.
   */
  const [motorControlEnabled, setMotorControlEnabled] = useState(false);
  const [sessionCloseFailed, setSessionCloseFailed] = useState(false);
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
  const [motorSettingsOpen, setMotorSettingsOpen] = useState(false);
  const [motorConfigurationDirty, setMotorConfigurationDirty] = useState(false);
  const [motorConfigurationBusy, setMotorConfigurationBusy] = useState(false);
  const [outputOrderDirty, setOutputOrderDirty] = useState(false);
  const [escDirectionDirty, setEscDirectionDirty] = useState(false);
  /**
   * The output vector AS READ from the flight controller, lifted here so
   * the identity section can name the output for one motor without owning
   * a second read. Undefined means NOT READ - never identity, never a
   * template, because a silent identity fallback is indistinguishable from
   * a genuinely unmodified aircraft.
   */
  const [outputOrderValues, setOutputOrderValues] = useState<
    readonly number[] | undefined
  >(undefined);
  /**
   * WHAT THIS SESSION ASKED ESCs TO BECOME.
   *
   * SCOPE, AND WHY THIS ONE. The log is bound to the CONNECTION session
   * (`sessionId`), not to the motor-test session. A direction command
   * changes a setting stored inside the ESC, which outlives the bench
   * session the operator opened to send it - and verifying it means
   * ending that bench session and starting another. Binding to the bench
   * session would therefore discard the record at exactly the moment the
   * operator needs it. Binding to the connection is still narrow: a new
   * connection may be a different aircraft, so the log starts empty.
   * Nothing is written to disk and no board identifier is used as a key.
   */
  const [directionLog, setDirectionLog] = useState<MotorDirectionCommandLog>(
    EMPTY_DIRECTION_COMMAND_LOG,
  );
  const directionSessionRef = useRef<object | undefined>(undefined);
  const [beginning, setBeginning] = useState(false);
  const [beginQueued, setBeginQueued] = useState(false);
  const [beginFailed, setBeginFailed] = useState(false);
  const [pulseRejected, setPulseRejected] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [endSessionFailed, setEndSessionFailed] = useState(false);
  /**
   * THE ONE SESSION TRUTH ON THIS SCREEN.
   *
   * Derived from the controller's published phase, with the operator's
   * in-flight open intent (`beginning`/`beginQueued`) admitted for exactly
   * one purpose: naming the gap between the press and the controller's
   * first publication. Both of those flags clear themselves, so no stale
   * intent can survive a teardown the operator did not perform.
   */
  const sessionState = deriveMotorSessionState(
    snapshot,
    beginning || beginQueued,
  );
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
  /** React Native Web's synthetic long-press responder is not the safety
   * authority and has varied across browser/input combinations. On web we
   * qualify the SAME Pressable-owned gesture with our own timer. Android
   * keeps the native onLongPress path unchanged. */
  const webLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
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
      if (webLongPressTimerRef.current !== undefined) {
        clearTimeout(webLongPressTimerRef.current);
        webLongPressTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    setBeginning(false);
    setBeginQueued(false);
    setBeginFailed(false);
    setMotorSettingsOpen(false);
    setPulseRejected(false);
    setEndingSession(false);
    setEndSessionFailed(false);
    holdOwnedRef.current = false;
    setHoldOwned(false);
    holdGestureRef.current = undefined;
    holdActivatedRef.current = false;
    if (webLongPressTimerRef.current !== undefined) {
      clearTimeout(webLongPressTimerRef.current);
      webLongPressTimerRef.current = undefined;
    }
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
  const sessionHasEnded =
    snapshot?.phase === 'CLOSED' && snapshot.teardown?.complete === true;
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
  /**
   * A SESSION THAT ENDED CLEANLY IS SPENT, NOT BROKEN.
   *
   * Deliberately not imported from motorTestSessionBinding: the protocol
   * barrel exports that module TYPE-ONLY on purpose, because a runtime
   * import would pull the controller, the vector builders and the payload
   * encoder into the Release bundle. The rule is one line and is stated
   * identically there (isSpentSnapshot); the production-path test is what
   * proves the two agree.
   */
  const sessionSpentCleanly =
    snapshot?.phase === 'CLOSED' && snapshot.teardown?.complete === true;
  /**
   * THE DEFECT THIS FIXES, reported with screenshots: after closing a
   * motor session the operator was told to unplug the USB cable, with the
   * flight controller still connected and nothing having failed.
   *
   * `phase === 'CLOSED'` was treated as "you need a new connection". But
   * CLOSED is where a HEALTHY session ends - it is the normal terminus of
   * pressing the toggle off - so the one path that always works was the
   * one being reported as broken.
   *
   * Only a close that did NOT complete now demands a new connection. That
   * keeps the fail-closed half intact: an unconfirmed teardown may mean
   * exclusivity is still held or a motor is still turning, and for that
   * the cable really is the recovery.
   */
  const requiresNewConnection =
    (snapshot?.phase === 'CLOSED' && !sessionSpentCleanly) ||
    blockReasons.includes('REQUIRES_NEW_CONNECTION') ||
    (snapshot?.outcome.kind === 'FAILED_CLOSED' &&
      snapshot.outcome.requiresNewSession) ||
    (snapshot?.outcome.kind === 'BLOCKED' &&
      snapshot.outcome.requiresNewSession);
  const terminalSetupReason =
    snapshot?.outcome.kind === 'BLOCKED' ||
    snapshot?.outcome.kind === 'FAILED_CLOSED'
      ? snapshot.outcome.reason
      : undefined;
  const readinessDiagnosticReason =
    terminalSetupReason ?? primaryBlockReason;
  const showReadinessDiagnostic =
    !controllerAllows &&
    readinessDiagnosticReason !== undefined &&
    (terminalSetupReason !== undefined || snapshot?.setupStep === 'READY');

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

  /**
   * WITHDRAWS ONE OBSERVATION, THROUGH THE DOMAIN.
   *
   * A person who taps the wrong arm needs a way to say so. The transition
   * lives in `motorVerificationModel` rather than here precisely so this
   * component cannot invent one: it names a single output, returns it to
   * UNTESTED, and touches no other entry. It sends no command, changes no
   * output mapping, no mixer and no direction - it is a pure state
   * function, and a rejected correction changes nothing.
   */
  const handleClearObservation = useCallback((motorNumber: number) => {
    setVerification(current => {
      const result = clearObservation(current, motorNumber);
      return result.kind === 'ACCEPTED' ? result.state : current;
    });
  }, []);

  /**
   * A NEW CONNECTION STARTS WITH NO COMMAND HISTORY. The token is a fresh
   * object per `sessionId`, so a replaced connection cannot inherit
   * records minted against the previous one - `recordDirectionCommand`
   * compares by reference and refuses a stale token outright.
   */
  useEffect(() => {
    // Keyed on BOTH, because either changing means the aircraft on the
    // other end of the command may not be the same one.
    if (operator === undefined && sessionId === undefined) {
      directionSessionRef.current = undefined;
      setDirectionLog(EMPTY_DIRECTION_COMMAND_LOG);
      return;
    }
    const token = {};
    directionSessionRef.current = token;
    setDirectionLog(beginDirectionCommandLog(token));
  }, [operator, sessionId]);

  /**
   * Records ONE direction command outcome. It writes COMMANDED and only
   * COMMANDED: no observation, no verification, no expected value and no
   * physical claim of any kind change here.
   */
  const handleDirectionCommandOutcome = useCallback(
    (
      motorNumber: number,
      target: DshotEscDirection,
      status: 'ACKNOWLEDGED' | 'UNCONFIRMED',
    ) => {
      const token = directionSessionRef.current;
      if (token === undefined) {
        return;
      }
      setDirectionLog(current =>
        recordDirectionCommand(current, token, {motorNumber, target, status}),
      );
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
   * Session preparation is explicit and separate from motor commands:
   * navigation and settings remain read-only until the operator prepares
   * the FC session, then each intentional long press submits a pulse.
   */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const holdGateBlocked =
    operator === undefined || requiresNewConnection || !canActivate;
  // See holdOwned's own declaration: disabling mid-gesture is what
  // terminated the responder and stopped a held motor in the field.
  const holdDisabled = holdGateBlocked && !holdOwned;
  /**
   * PRESENTATION IS FROZEN WHILE A HOLD IS OWNED - THE MEASURED FIX.
   *
   * Forensic trace (Chromium, mouse physically stationary): accepting the
   * pulse at the 800 ms threshold makes the controller publish
   * activation.allowed=false / PULSE_OR_STOP_IN_PROGRESS with
   * mayBeLive=true, and SIX surfaces restructured on that one frame -
   * the status ack notice, the readiness banner, the direction section,
   * the mapping section, the hold panel and the block row. The scroller
   * grew 5176px -> 5399px, the browser's scroll anchoring compensated by
   * ~90px, and react-native-web's ResponderSystem terminates a press when
   * a `scroll` fires on an ancestor of the responder - so onPressOut
   * arrived ~20 ms after activation with no pointer event at all and the
   * hold stopped itself.
   *
   * The pointer never left: the control's own rect was identical at every
   * sample. So the defect is the application restructuring itself under a
   * held pointer, and the fix is to stop doing that for the ONE state
   * that is self-caused: a command the operator is issuing right now is
   * not a new blocking condition to report to them.
   *
   * PRESENTATION ONLY, AND NARROW. Nothing here relaxes a gate: the
   * controller still refuses every command while one is in flight,
   * `holdGateBlocked` is unchanged, and pointer-leave, pointer-cancel,
   * blur, release, STOP and native termination all still stop the motor.
   * The pinned live-command strip and STOP are outside the scroller and
   * keep updating in real time. The instant the gesture ends, the true
   * state renders exactly as before.
   */
  const freezeTransientPresentation = holdOwned;
  /** Read at CALL time by handlePressIn, so ownership can only ever be
   * taken for a press the gate actually admitted. Ownership PROTECTS a
   * gesture the gate accepted; it must never CREATE one. */
  const holdGateBlockedRef = useRef(holdGateBlocked);
  holdGateBlockedRef.current = holdGateBlocked;

  /**
   * WHY THE HOLD CONTROL IS LOCKED, IN THE OPERATOR'S WORDS.
   *
   * THE DEFECT THIS CLOSES, reported from a real flight controller: the
   * operator pressed hold-to-test repeatedly and nothing happened at all.
   * A browser probe of the gesture path cleared the gesture engine - it
   * activates correctly whenever the gate admits it - so the failure was
   * never the press. It was this: `disabled` on a react-native-web
   * Pressable applies `pointerEvents: 'box-none'` and makes
   * `onStartShouldSetResponder` return false, so a blocked control
   * receives NO pointer event, changes nothing, and looks like dead
   * pixels. Worse, `showReadinessDiagnostic` requires either a terminal
   * outcome or `setupStep === 'READY'`, so with no session open there is
   * no snapshot, no reason, and nothing rendered anywhere on screen.
   *
   * This adds NO command authority. It resolves the SAME canonical
   * reasons the controller already publishes into one line rendered on
   * the control itself, so a locked button always says why it is locked.
   * Order is causal: the thing the operator must do first comes first.
   */
  /**
   * MEASURED WEB DEFECT (forensic trace, Chromium, stationary mouse):
   * at the 800 ms threshold the pulse is accepted and the controller
   * immediately publishes activation.allowed=false with
   * PULSE_OR_STOP_IN_PROGRESS. That made this reason defined mid-gesture,
   * which INSERTED the blocked panel inside the pressed control and grew
   * it 131px -> 191px. The browser's scroll anchoring then compensated
   * the internal scroller by +90px, and react-native-web's
   * ResponderSystem terminates a press when a `scroll` fires on an
   * ancestor of the responder (ResponderSystem.js: `isScrollEvent &&
   * eventTarget.contains(node)`). onPressOut therefore fired ~20 ms after
   * activation, with the mouse never moving and no pointer event at all,
   * and the hold stopped itself.
   *
   * An owned hold is ACTIVE, not blocked: the only reason the gate
   * withdrew is the operator's own in-flight command. Suppressing the
   * mid-gesture explanation is presentation only - `holdGateBlocked`,
   * every controller precondition, and every stop seam are untouched -
   * and it keeps the pressed surface geometrically stable, which is what
   * the gesture actually needs. Genuine blocks render exactly as before
   * the moment the gesture ends.
   */
  const holdBlockedReason: string | undefined = !holdGateBlocked || holdOwned
    ? undefined
    : requiresNewConnection
      ? t('motorsScreen.requiresNewConnection')
      : operator === undefined || sessionId === undefined
        ? t('motorsScreen.holdBlockedNoSession')
        : !motorControlEnabled
          ? t('motorsScreen.holdBlockedControlOff')
          : motorConfigurationBusy
            ? t('motorsScreen.holdBlockedBusy')
            : primaryBlockReason !== undefined
              ? t(`motorsScreen.blockReason.${primaryBlockReason}`)
              : t('motorsScreen.holdBlockedUnknown');
  /** Ends the exclusive test session before the optional output-reorder
   * transaction, which deliberately owns a separate interlock. */
  const handleEndSessionForConfiguration = useCallback(async () => {
    const port = operatorRef.current;
    if (port === undefined) {
      throw new Error('Motor-test operator is unavailable.');
    }
    await endMotorTestSessionSafely(port);
  }, []);

  const runBeginSession = useCallback((port: MotorTestOperatorPort) => {
    setBeginQueued(false);
    setBeginning(true);
    setBeginFailed(false);
    setPulseRejected(false);
    port
      .beginSession()
      .then(result => {
        if (!mountedRef.current || operatorRef.current !== port) {
          return;
        }
        // A fail-closed setup is often a resolved controller result, not a
        // rejected Promise. Mirror that official result explicitly: a Ready
        // result enables the hold control immediately, while a blocked result
        // receives an operator-facing explanation instead of a dim mystery.
        setSnapshot(result);
        setBeginFailed(result.activation.allowed !== true);
      })
      .catch(() => {
        if (mountedRef.current && operatorRef.current === port) {
          setBeginFailed(true);
        }
      })
      .finally(() => {
        if (mountedRef.current && operatorRef.current === port) {
          setBeginning(false);
        }
      });
  }, []);

  /**
   * THE SESSION TOGGLE - ON and OFF over the canonical paths, and nothing
   * else. It opens or closes the FC test session; it never commands a
   * motor, in either direction.
   *
   * The only intent this keeps is `beginning`/`beginQueued`, which name
   * the gap between the press and the controller's first publication.
   * Nothing here is allowed to answer "is there a session?" - the
   * controller's published phase does that, in one place.
   */
  const handleSessionChange = useCallback(
    (next: boolean) => {
      const port = operatorRef.current;
      if (next) {
        setSessionCloseFailed(false);
        /**
         * A SPENT SESSION MAY BE REPLACED, and this is the second half of
         * the reopen fix.
         *
         * This gate used to require IDLE. A controller runs
         * IDLE -> PREPARING -> ACTIVE -> CLOSING -> CLOSED and never
         * returns, so after one clean close the phase was CLOSED forever
         * and this returned early - silently. The press did nothing, and
         * the binding's own retirement path (which builds a fresh
         * controller on beginSession) was never even reached.
         *
         * CLEANLY spent only. A close that did not complete still refuses,
         * because its exclusivity and its motor state are unproven.
         */
        const phase = port?.getSnapshot().phase;
        const spent =
          phase === 'CLOSED' && port?.getSnapshot().teardown?.complete === true;
        if (
          port === undefined ||
          beginning ||
          (phase !== 'IDLE' && !spent)
        ) {
          return;
        }
        // The configuration panel and the motor-test controller share one
        // exclusive MSP interlock. An instruction issued during the
        // automatic settings read is REMEMBERED and opens as soon as that
        // read releases ownership; it is never converted into a rejected,
        // apparently inert interaction. Unchanged from the accepted flow -
        // only its entry point moved.
        if (motorConfigurationBusy) {
          setBeginning(true);
          setBeginQueued(true);
          setBeginFailed(false);
          return;
        }
        runBeginSession(port);
        return;
      }
      // OFF. Intent drops immediately so the row cannot keep claiming ON,
      // but the STATE still comes from the controller: it will read
      // CLOSING until teardown actually completes, and ERROR if it does
      // not. Nothing here says "closed" on its own authority.
      // Command authority is withdrawn BEFORE the teardown starts, so no
      // slider can accept a value while the session is closing.
      setMotorControlEnabled(false);
      if (
        port === undefined ||
        endingSession ||
        port.getSnapshot().phase === 'IDLE'
      ) {
        return;
      }
      setEndingSession(true);
      setSessionCloseFailed(false);
      // The ONE canonical shutdown: stop first, wait for the controller to
      // settle, endSession, and require a COMPLETE teardown. No second
      // stop implementation exists, and none is written here.
      endMotorTestSessionSafely(port)
        .catch(() => {
          if (mountedRef.current && operatorRef.current === port) {
            setSessionCloseFailed(true);
          }
        })
        .finally(() => {
          if (mountedRef.current && operatorRef.current === port) {
            setEndingSession(false);
          }
        });
    },
    [beginning, endingSession, motorConfigurationBusy, runBeginSession],
  );


  /**
   * MOTOR CONTROL - permission to put a value on an output, inside a
   * session that already exists. Turning it OFF withdraws that permission,
   * so it must also stop: leaving a commanded value live while removing
   * the control that governs it is the exact shape of an unattended motor.
   */
  const handleMotorControlChange = useCallback(
    (next: boolean) => {
      if (next) {
        // Never grants itself a session. If one is not open this is inert.
        if (sessionState !== 'ON') {
          return;
        }
        setMotorControlEnabled(true);
        return;
      }
      setMotorControlEnabled(false);
      operatorRef.current?.stopAll();
    },
    [sessionState],
  );

  /**
   * THE RECONCILIATION THIS SCREEN DID NOT HAVE.
   *
   * A session can end without the operator touching either toggle - a tab
   * departure, an app background, a USB drop, a session-epoch change. When
   * that happens the controller publishes a new phase and this effect
   * withdraws command authority. Without it, `motorControlEnabled` stayed
   * true across a teardown and the workspace came back looking armed.
   */
  useEffect(() => {
    if (sessionState !== 'ON' && motorControlEnabled) {
      setMotorControlEnabled(false);
    }
  }, [motorControlEnabled, sessionState]);


  useEffect(() => {
    if (!beginQueued || motorConfigurationBusy) {
      return;
    }
    const port = operatorRef.current;
    // THE SAME SPENT-SESSION RULE as the toggle itself. This is the
    // QUEUED path - the operator pressed ON while a configuration read
    // held the interlock, and the intent is honoured once it releases.
    // With an IDLE-only test a queued REOPEN was silently dropped here
    // too, so the press was remembered and then thrown away.
    const queuedPhase = port?.getSnapshot().phase;
    const queuedSpent =
      queuedPhase === 'CLOSED' &&
      port?.getSnapshot().teardown?.complete === true;
    if (port === undefined || (queuedPhase !== 'IDLE' && !queuedSpent)) {
      setBeginQueued(false);
      setBeginning(false);
      return;
    }
    runBeginSession(port);
  }, [beginQueued, motorConfigurationBusy, runBeginSession]);

  const clearHoldHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== undefined) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = undefined;
    }
  }, []);

  const clearWebLongPressTimer = useCallback(() => {
    if (webLongPressTimerRef.current !== undefined) {
      clearTimeout(webLongPressTimerRef.current);
      webLongPressTimerRef.current = undefined;
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

  const activateOwnedHold = useCallback(() => {
    clearWebLongPressTimer();
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
    const current = port.getSnapshot();
    if (!holdOwnedRef.current || holdGestureRef.current !== gesture || !current.activation.allowed) {
      setPulseRejected(true);
      return;
    }
    holdActivatedRef.current = true;
    setPulseRejected(false);
    if (port.pulseMotor(selectedSlot) === 'ACCEPTED') startHoldHeartbeat(port);
    else {
      holdActivatedRef.current = false;
      setPulseRejected(true);
    }
  }, [clearWebLongPressTimer, selectedSlot, startHoldHeartbeat]);

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
    clearWebLongPressTimer();
    if (Platform.OS === 'web') {
      webLongPressTimerRef.current = setTimeout(
        activateOwnedHold,
        MOTOR_TEST_LONG_PRESS_DELAY_MILLIS,
      );
    }
  }, [activateOwnedHold, clearHoldHeartbeat, clearWebLongPressTimer]);

  const handleLongPress = useCallback(() => {
    // Web uses the owned timer installed at press-in; keeping both paths
    // active there could submit twice at the threshold. Native keeps the
    // platform responder that already worked in the APK.
    if (Platform.OS !== 'web') {
      activateOwnedHold();
    }
  }, [activateOwnedHold]);

  /** Release AND responder termination land here. Both must stop. */
  const handlePressOut = useCallback(() => {
    holdOwnedRef.current = false;
    setHoldOwned(false);
    holdGestureRef.current = undefined;
    clearWebLongPressTimer();
    clearHoldHeartbeat();
    const activated = holdActivatedRef.current;
    holdActivatedRef.current = false;
    // Stop whenever a command may be live - including the pre-ACK window,
    // where `mayBeLive` is already true because the controller latches it
    // at activation rather than at acknowledgement.
    if (activated || commandMayBeLive(operatorRef.current?.getSnapshot())) {
      stopNow('TOUCH_RELEASED');
    }
  }, [clearHoldHeartbeat, clearWebLongPressTimer, stopNow]);

  /**
   * THE PRESSED POINTER LEFT THE CONTROL - STOP NOW, NOT AT MOUSE-UP.
   *
   * MEASURED DEFECT: hold past the threshold, then drag the still-pressed
   * pointer off the button, and the motor command stayed live until the
   * button was finally released somewhere else on the page.
   * react-native-web keeps the responder when the pointer leaves, so no
   * press-out arrives - yet "my pointer is no longer on the control" is
   * exactly when an operator believes they have let go.
   *
   * WHY THIS SEAM AND NOT `onPressMove`. Probed in Chromium rather than
   * assumed: an earlier bounds-checking attempt through `onPressMove`
   * never fired and was removed. A DOM probe then showed the host node
   * really does receive `pointerleave` mid-drag, and that
   * react-native-web forwards `onPointerLeave` straight to it - so this
   * is a real W3C pointer event, not responder emulation. The harness now
   * records `I_PULSE_ACCEPTED -> SEAM_POINTER_LEAVE -> STOP` on leave,
   * with the later mouse-up landing as an inert second press-out.
   *
   * It creates NO stop transaction of its own. It calls the same
   * `handlePressOut` every release, cancel and termination already uses,
   * and only while this control owns a live gesture.
   */
  const handleHoldPointerLoss = useCallback(() => {
    if (!holdOwnedRef.current) {
      return;
    }
    handlePressOut();
  }, [handlePressOut]);

  /**
   * WINDOW BLUR WITHDRAWS AN OWNED HOLD - a fail-safe, not a feature.
   *
   * WHY IT IS EXPLICIT. react-native-web's AppState subscribes ONLY to
   * `visibilitychange` (AppState/index.js), so switching to another
   * window while this page stays VISIBLE raises no AppState change and
   * the motor lifecycle bridge never hears about it. A probe of that
   * exact case was inconclusive in headless Chromium - it could not
   * produce a trustworthy OS-level window switch with a button held - and
   * an unproven incidental behaviour is not something a live motor
   * command may depend on. So the guarantee is made here instead of
   * assumed.
   *
   * STOP-ONLY, AND NARROW. It cannot start a motor: its single action is
   * the SAME `handlePressOut` that every release, leave, cancel and
   * termination already uses, so blur + pointerleave + pointerup collapse
   * onto one stop episode rather than three transport writes. The
   * listener exists only while a gesture is actually owned - not while
   * idle, not after release, not after unmount - and Android is untouched
   * because the effect is inert off the web.
   */
  useEffect(() => {
    if (!holdOwned) {
      return;
    }
    return subscribeWindowBlur(() => {
      if (holdOwnedRef.current) {
        handlePressOut();
      }
    });
  }, [handlePressOut, holdOwned]);

  const handleStopPress = useCallback(() => {
    holdOwnedRef.current = false;
    setHoldOwned(false);
    holdGestureRef.current = undefined;
    clearWebLongPressTimer();
    clearHoldHeartbeat();
    holdActivatedRef.current = false;
    stopNow('STOP_BUTTON_PRESSED');
  }, [clearHoldHeartbeat, clearWebLongPressTimer, stopNow]);

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
        clearWebLongPressTimer();
        clearHoldHeartbeat();
        port.requestStop('MOTOR_SELECTION_CHANGED');
      }
    }
    setSelectedSlot(slot);
  }, [clearHoldHeartbeat, clearWebLongPressTimer]);

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

  // The expected pair and the verified-slot list are derived inside
  // MotorIdentitySection now, from the same verification state, so the
  // screen no longer keeps a second copy that could drift from it.
  const liveSlot =
    presentation === 'SUBMITTED_AWAITING_RESPONSE' ||
    presentation === 'ACKNOWLEDGED' ||
    presentation === 'STOPPING' ||
    presentation === 'FAULT'
      ? snapshot?.pulse.motorNumber
      : undefined;
  /** The diagram states the controller's OWN verdict for that output, in
   * words. FAULT maps to UNSAFE because a fault is precisely the case
   * where the app cannot describe the output truthfully. */
  const liveActivity: MotorSlotActivity | undefined =
    presentation === 'SUBMITTED_AWAITING_RESPONSE'
      ? 'SUBMITTED'
      : presentation === 'ACKNOWLEDGED'
      ? 'ACKNOWLEDGED'
      : presentation === 'STOPPING'
      ? 'STOPPING'
      : presentation === 'FAULT'
      ? 'UNSAFE'
      : undefined;
  const airframeEntries = MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
    slot: entry.motorNumber,
    position: entry.position,
    direction: entry.direction,
  }));

  /**
   * MAY THE QUAD-X PHYSICAL MODEL BE APPLIED TO THIS AIRCRAFT?
   *
   * Read from the SAME live count the workspace uses for its sliders, so
   * control and identification can never disagree about how many motors
   * exist. An unsupported answer withdraws POSITION CLAIMS ONLY - the
   * numbered controls, the hold path and STOP are untouched, because a
   * numbered output is addressable without knowing which arm it drives.
   */
  const identificationCapability: MotorIdentificationCapability =
    evaluateMotorIdentificationCapability(
      snapshot?.motorDomain?.motorCount ?? snapshot?.motorScope?.motorCount,
    );
  const quadIdentificationSupported =
    identificationCapability.kind === 'SUPPORTED';

  /**
   * THE LOGICAL MOTORS THIS AIRCRAFT ACTUALLY HAS.
   *
   * Derived from the same live count the workspace sliders use, so the
   * selector cannot list four motors on a hex or hide two on one. Before
   * anything has been read there is no count to derive from, and the
   * shipped four-slot constant is the honest placeholder - it is what the
   * legacy pulse path is scoped to anyway.
   */
  const liveMotorCount =
    snapshot?.motorDomain?.motorCount ?? snapshot?.motorScope?.motorCount;
  const identitySlots: readonly number[] =
    liveMotorCount !== undefined &&
    Number.isInteger(liveMotorCount) &&
    liveMotorCount > 0
      ? Array.from({length: liveMotorCount}, (_, index) => index + 1)
      : MOTOR_TEST_OUTPUT_SLOTS;

  /**
   * MAY A DIRECTION COMMAND BE SENT FOR THE SELECTED MOTOR? A DIFFERENT
   * QUESTION FROM IDENTIFICATION, and answered from the gates the command
   * path actually runs rather than from the airframe template.
   */
  const directionCommandCapability = evaluateMotorDirectionCommandCapability({
    // The command travels the motor-test facade, so the session that
    // matters is the operator port - NOT the configuration session id
    // that the output-mapping transaction uses.
    hasSession: operator !== undefined,
    motorNumber: selectedSlot,
    // The scope is handed through WHOLE. This screen must not be able to
    // name a safety field, let alone branch on one - see the containment
    // test - so the reading happens inside the evaluator.
    scope: snapshot?.motorScope,
    activationAllowed:
      snapshot?.activation.allowed === true || freezeTransientPresentation,
  });
  const selectedDirectionCommand = directionCommandFor(
    directionLog,
    selectedSlot,
  );

  /**
   * A configuration read shares the link with the motor-test lease. While
   * a command may be live it waits and says so, rather than competing with
   * a pulse for the same serialized session.
   */
  const configurationReadBlockedReason =
    operator !== undefined &&
    !freezeTransientPresentation &&
    commandMayBeLive(operator.getSnapshot())
      ? t('motorsScreen.mappingBlockedLiveCommand')
      : undefined;
  /** One block, used wherever a Quad-X claim is withheld. */
  const identificationUnavailableNotice = (testID: string) => (
    <View style={styles.advancedEmpty} testID={testID}>
      <Text style={styles.advancedEmptyTitle}>
        {t('motorsScreen.identificationQuadOnlyTitle')}
      </Text>
      <Text style={styles.caption}>
        {identificationCapability.kind === 'UNSUPPORTED' &&
        identificationCapability.reason === 'MOTOR_COUNT_MISMATCH'
          ? t('motorsScreen.identificationQuadOnlyBody', {
              count: identificationCapability.motorCount,
            })
          : t('motorsScreen.identificationCountUnknownBody')}
      </Text>
    </View>
  );

  /**
   * THE PROTECTED HOLD CONTROL. It only submits a motor pulse after the
   * separate preparation action has reached an activation-ready state.
   *
   * WHY IT IS A BUTTON AGAIN, AND NOT A PANEL. It used to be a 132px
   * turquoise slab carrying an eyebrow, a label, a hint and - when
   * blocked - a whole explanation card, all inside the pressable box. A
   * safety control has to be easy to hit; it does not have to be the
   * largest object on the screen, and everything except the label was
   * text that happened to be standing inside a button.
   *
   * WHAT DID NOT CHANGE, AND MUST NOT. The gesture itself: same
   * `delayLongPress`, same MOTOR_TEST_LONG_PRESS_DELAY_MILLIS, same
   * press-in/long-press/press-out/pointer-loss seams, same disabled gate,
   * same release-stops-the-motor contract. The height is still FIXED
   * rather than a minimum, for the reason the previous round found the
   * hard way: any size change under a held pointer can scroll-anchor the
   * document and make react-native-web terminate the press. One line, one
   * reserved box, three labels inside it.
   */
  const holdControl = (
    <View style={styles.holdBlock} testID="motors-hold-block">
      {/* NOTHING ABOVE THE BUTTON THAT THE BUTTON ALREADY SAYS.
          There used to be an eyebrow here reading "test the selected
          motor" - immediately under a heading reading "identify the motor
          physically" and immediately above a button reading "press and
          hold - M2". Three labels for one control. The heading names the
          step, the button names the action and the motor, and the single
          line below states the one thing neither of them can: what
          letting go does. */}
      <Pressable
        onPressIn={handlePressIn}
        onLongPress={handleLongPress}
        delayLongPress={MOTOR_TEST_LONG_PRESS_DELAY_MILLIS}
        onPressOut={handlePressOut}
        onPointerLeave={handleHoldPointerLoss}
        onPointerCancel={handleHoldPointerLoss}
        /* NATIVE ONLY IN PRACTICE. react-native-web's Pressable spreads
           its own press handlers AFTER the caller's props and supplies
           its own onResponderTerminate, so this one is overwritten in the
           browser - where RNW's internal terminate reaches onPressOut
           anyway. It stays because on Android it IS the termination hook,
           and deleting it would remove real native safety to tidy a web
           no-op. */
        onResponderTerminate={(_event: GestureResponderEvent) =>
          handlePressOut()
        }
        disabled={holdDisabled}
        accessibilityRole="button"
        accessibilityState={{
          disabled: holdDisabled,
          busy: beginning,
        }}
        accessibilityHint={holdBlockedReason ?? t('motorsScreen.holdHint')}
        style={[
          styles.holdButton,
          holdDisabled && styles.holdButtonOff,
          holdOwned && styles.holdButtonPressed,
          holdOwned && mayBeLive && styles.holdButtonLive,
        ]}
        testID="motors-hold-button"
      >
        {/* ONE LINE, AND IT NEVER WRAPS. A second line would change the
            box height mid-gesture, which is the exact failure the fixed
            height exists to prevent. */}
        <Text
          numberOfLines={1}
          style={[styles.holdLabel, !canActivate && styles.holdLabelOff]}
        >
          {holdOwned && mayBeLive
            ? t('motorsScreen.holdActive', { slot: `M${selectedSlot}` })
            : holdOwned
              ? t('motorsScreen.holdCountdown', { slot: `M${selectedSlot}` })
              : t('motorsScreen.holdToTest', { slot: `M${selectedSlot}` })}
        </Text>
      </Pressable>

      {/* THE HINT IS A HINT, not button furniture. Same words, same
          truth, one caption line under the control. */}
      <Text style={styles.holdHint} testID="motors-hold-hint">
        {holdBlockedReason === undefined
          ? t('motorsScreen.holdHint')
          : t('motorsScreen.holdBlockedHint')}
      </Text>

      {/* A locked safety control must never look like dead pixels. It
          issues zero commands either way; it still says why - beside the
          control rather than inside it, so a blocked reason can grow
          without resizing a pressable surface. */}
      {holdBlockedReason !== undefined ? (
        <View style={styles.holdBlocked} testID="motors-hold-blocked">
          <Text style={styles.holdBlockedTitle}>
            {t('motorsScreen.holdBlockedTitle')}
          </Text>
          <Text
            style={styles.holdBlockedReason}
            testID="motors-hold-blocked-reason"
          >
            {holdBlockedReason}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View
      style={[styles.root, { paddingBottom: effectiveBottomInset }]}
      testID="motors-screen"
    >
      {/* Scrollable body.
          THE STOP CONTROL IS A SIBLING, NOT AN OVERLAY, and that is the
          whole reason nothing needs to reserve space for it. This root is
          a column; the dock below is `flex: 0 0 auto` and takes its height
          out of the column first, and this ScrollView is `flex: 1` and
          gets what is left. The dock therefore cannot cover the list: the
          list's viewport ENDS where the dock begins.

          MEASURED, NOT ASSUMED. A previous round added a bottom padding
          equal to the dock's measured height, on the belief that the dock
          floated. It does not - Chromium reports it `position: relative,
          flex: 0 0 auto` - so that padding covered nothing and cost 88px
          of dead space the operator had to drag through on every phone
          width. The geometry check (.dev-preview/geomcheck.mjs) confirms
          zero collisions at 7 widths across 9 states without it. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { maxWidth: contentMaxWidth }]}
      >
        {/* ================================================ REGION A
            SAFETY / SESSION HEADER, and nothing else.

            IT USED TO BE THREE STACKED BLOCKS. An eyebrow, a display
            title and a subtitle (144px), then a full-width propeller
            banner, then a status card with its own heading, its own
            padding and a developer disclosure inside it - 376px of
            chrome before the first control, measured at every width, on
            a screen whose entire purpose is below it.

            One row now: what the screen is, and what state it is in.
            The propeller warning keeps its own line, its icon and its
            error colour - it is the one sentence that must never be
            skimmed - but it no longer needs a banner the width of a
            desktop to say eight words. The developer disclosure moved
            to the advanced region where it belongs. */}
        <View style={styles.headerRow}>
          <Text style={styles.title} testID="motors-title">
            {t('motorsScreen.title')}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {t('motorsScreen.subtitle')}
          </Text>
        </View>

        <View style={styles.dangerBanner} testID="motors-propeller-warning">
          <Icon name="triangle-alert" size={18} color={colors.error} />
          <Text style={[styles.flexOne, styles.dangerTitle]}>
            {t('motorsScreen.propellerWarning')}
          </Text>
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
            {/* The heading "حالة النظام" was a label for a value that
                already reads as a state - two lines where one says the
                same thing. The value keeps its dot, its colour and its
                testID; the label is gone. */}
            <Text
              style={[styles.statusText, { color: statusColor }]}
              testID={`motors-status-${presentation}`}
            >
              {statusText}
            </Text>
          </View>
          {presentation === 'ACKNOWLEDGED' && !freezeTransientPresentation ? (
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
          {/* Not while a hold is owned: this row renders ABOVE the hold
              control, so appearing mid-gesture moves the pressed surface
              under a stationary pointer (see holdBlockedReason for the
              measured chain). The reason is displayed the instant the
              gesture ends; nothing about the controller's own gating
              depends on this text. */}
          {primaryBlockReason !== undefined && !holdOwned ? (
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

        </View>

        {/* (7) Fault - MOVED TO THE TOP OF THE CONTENT FLOW (final-review
            M-1). An emergency instruction rendered below Identity,
            Direction and Mapping measured ~3100px deep on a phone; the
            detailed banner now sits directly under the status card, and a
            compact copy of the SAME instruction is pinned beside STOP so
            scroll position can never hide it. TWO DIFFERENT MESSAGES, because they mean two very
            different things to somebody standing next to an aircraft.

            The LiPo instruction is reserved for a stop that is genuinely
            unconfirmed while a command may be live - see
            stopIsGenuinelyUnconfirmed(). Every other fault ends the
            session and needs a reconnect, which is worth saying plainly,
            but it is NOT a reason to tell somebody to pull a battery. */}
        {presentation === 'FAULT' ? (
          stopUnconfirmed ? (
            <View style={styles.faultBanner} testID="motors-fault-banner">
              <Icon name="octagon-alert" size={24} color={colors.error} />
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

        {/* ================================================ REGION B
            THE MOTOR WORKSPACE - the reason the screen exists.

            TWO COLUMNS ON A WIDE SCREEN, and the split is the point:
            everything that answers "WHICH motor is this, where is it and
            which way does it turn" on one side, everything that answers
            "how do I drive it and how do I stop it" on the other. They
            used to be one column 4,200px long, in which the airframe
            diagram sat at y=1181 on a 1920 desktop - below the fold on
            the widest screen this application runs on, under the very
            sliders it exists to label.

            The column order is deliberate in RTL: identity leads, because
            a person picks the motor before they move it. */}
        <View
          style={[styles.workspaceRow, wideWorkspace && styles.workspaceRowWide]}
          testID="motors-primary-workspace"
        >
          <View
            style={[styles.workspaceColumn, wideWorkspace && styles.workspaceColumnAirframe]}
            testID="motors-airframe-column"
          >
          {/* ---- P1b-B: MOTOR IDENTITY IS CORE. ------------------------
            * Which motor am I addressing, where did I observe it, which
            * output drives it, what is actually confirmed - answerable
            * without opening a disclosure. The map, the numbered
            * selector, the protected hold and the observation wizard now
            * sit together in the order a person performs them. */}
          <MotorIdentitySection
            slots={identitySlots}
            selectedSlot={selectedSlot}
            onSelectSlot={handleSelectSlot}
            capability={identificationCapability}
            airframeEntries={airframeEntries}
            diagramMotorCount={liveMotorCount ?? MOTOR_AIRFRAME_QUAD_COUNT}
            active={active}
            liveSlot={liveSlot}
            liveActivity={liveActivity}
            verification={verification}
            receipt={receipt}
            onConfirm={handleConfirmObservation}
            onMultipleMotorsReported={handleMultipleMotors}
            onClearObservation={handleClearObservation}
            outputOrder={outputOrderValues}
            holdControl={holdControl}
          />
          {/* SESSION READINESS, BESIDE THE HOLD CONTROL IT DESCRIBES.
              These two blocks used to live at the bottom of the tools
              bench. "الجلسة جاهزة - اضغط مطولًا على M1" and the exact
              terminal readiness failure are both statements ABOUT the
              protected hold, and the hold is in the identity section
              directly above - reading them 2,000px away from it was the
              reason the bench looked like it owned the workflow. */}
          {/* A NORMAL STATE IS A STATUS, NOT AN ANNOUNCEMENT.
              "Ready" was a full notice card - a 38px check disc, a
              section-title heading and a sentence - occupying ~99px at
              390 to say the thing that is true almost all of the time. It
              is a strip now: one dot, the state, the addressed motor.
              The FAILURE states below are untouched and still expand,
              because a failure is the case that has something to say. */}
          {canActivate || freezeTransientPresentation ? (
            <View
              style={styles.readyStrip}
              testID="motors-session-ready"
              accessibilityLabel={`${t('motorsScreen.readyHeading')}. ${t(
                'motorsScreen.readyDetail',
                {slot: `M${selectedSlot}`},
              )}`}
            >
              <View style={styles.readyDot} />
              <Text style={styles.readyStripText}>
                {t('motorsScreen.readyHeading')}
              </Text>
              <Text style={styles.readyStripMotor}>
                {`M${selectedSlot}`}
              </Text>
            </View>
          ) : null}

          {/* P1b-B: the numbered selector, the airframe map, the protected
              hold and the selected-motor facts all moved UP into
              MotorIdentitySection. They are not duplicated here - motor
              identity is a core question, and answering it from the bottom
              of a tools card was the reason it read as advanced. */}

          {showReadinessDiagnostic && !freezeTransientPresentation ? (
            <View
              style={styles.readinessBlock}
              testID="motors-readiness-blocked-detail"
            >
              <Text style={styles.blockHeading}>
                {t('motorsScreen.readinessBlockedHeading')}
              </Text>
              {primaryBlockReason !== undefined ? (
                <Text style={styles.blockReason}>
                  {t(`motorsScreen.blockReason.${primaryBlockReason}`)}
                </Text>
              ) : null}
              <Text
                style={styles.caption}
                testID="motors-readiness-blocked-code"
              >
                {t('motorsScreen.readinessBlockedDetail', {
                  reason: readinessDiagnosticReason,
                  step: snapshot?.setupStep ?? 'NONE',
                })}
              </Text>
              <Text style={styles.caption}>
                {requiresNewConnection
                  ? t('motorsScreen.readinessReconnectAction')
                  : t('motorsScreen.readinessWaitAction')}
              </Text>
            </View>
          ) : null}

          {/* DIRECTION, beside identity rather than at the bottom of the
            * page. Three sources on three rows - template expectation,
            * what this session commanded, what a person observed - and
            * the one authoring workflow underneath them. */}
          <MotorDirectionSection
            selectedMotor={selectedSlot}
            operator={operator}
            identificationCapability={identificationCapability}
            commandCapability={directionCommandCapability}
            verification={verification}
            commanded={selectedDirectionCommand}
            onCommandOutcome={handleDirectionCommandOutcome}
            onDirtyChange={setEscDirectionDirty}
          />
          {/* Reading which output drives which motor is firmware truth and
            * needs no observation at all. Writing one still needs
            * everything it always needed - the panel below the read is the
            * same panel, reaching the same controller transaction. */}
          <MotorOutputMappingSection
            sessionId={sessionId}
            motorCount={liveMotorCount}
            verification={verification}
            capability={identificationCapability}
            onEndMotorTestSession={handleEndSessionForConfiguration}
            onDirtyChange={setOutputOrderDirty}
            blockedReason={configurationReadBlockedReason}
            onValuesChange={setOutputOrderValues}
          />
          </View>

          <View
            style={[styles.workspaceColumn, wideWorkspace && styles.workspaceColumnControls]}
            testID="motors-control-column"
          >
          {/* ---- P3: THE PRIMARY EXPERIENCE. -------------------------
            * Professional Motor 1..N workspace over the P2 facade. No
            * long press, no heartbeat, no fixed magnitude. The legacy
            * pulse/verification workflow below is retained as an
            * OPTIONAL tool until it is separately retired - it is no
            * longer the way motors are driven. */}
          <MotorWorkspace
            snapshot={snapshot}
            port={operator}
            sessionState={sessionState}
            onSessionChange={handleSessionChange}
            enabled={motorControlEnabled}
            onEnableChange={handleMotorControlChange}
          />
            {/* LIVE ESC TELEMETRY BELONGS BESIDE THE SLIDERS, not in an
                advanced drawer: RPM and temperature are what a person
                reads WHILE a motor is spinning, and reading them meant
                scrolling 2,300px away from the control that produced
                them. The panel is unchanged - only where it sits. */}
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
          </View>
        </View>

        {/* ================================================ REGION C
            BASIC MOTOR / ESC SETTINGS - one card, straight after the
            workspace. Protocol, idle, motor stop, bidirectional DShot,
            poles and 3D were reachable only after the tools bench, the
            diagnostics panel and 3,900px of scrolling. */}
          <Text style={styles.toolsHeading} testID="motors-settings-heading">
            إعدادات المحركات
          </Text>
          <MotorConfigurationSummary scope={snapshot?.motorScope} />
        {/* Persistent configuration is a separate transaction from bench
            testing. It owns no motor pulse path and is deliberately bound to
            the canonical session id rather than to the MotorTest operator. */}
        {sessionId !== undefined && !motorSettingsOpen ? (
          <Pressable
            onPress={() => setMotorSettingsOpen(true)}
            accessibilityRole="button"
            style={styles.disclosure}
            testID="motors-open-settings"
          >
            {/* A DISCLOSURE IS A ROW, NOT A CARD. This one was a 141px
                full-width panel at 390 because a whole paragraph about
                when to open it lived inside the tappable surface. The
                title says what is inside; the caption beside it says it
                in four words. */}
            <Text style={styles.disclosureTitle}>
              {t('motorsScreen.openMotorSettings')}
            </Text>
            <Text style={styles.disclosureHint}>
              {t('motorsScreen.openMotorSettingsHint')}
            </Text>
          </Pressable>
        ) : null}

        {sessionId !== undefined && motorSettingsOpen ? (
          <MotorConfigurationPanel
            sessionId={sessionId}
            onDirtyChange={setMotorConfigurationDirty}
            onBusyChange={setMotorConfigurationBusy}
          />
        ) : null}

        {/* ================================================ REGION D
            ADVANCED AND DIAGNOSTIC - collapsed, and last.

            Nothing here is deleted. The verification bench, the airframe
            observation wizard, output reordering and the raw controller
            state are all still reachable in one press; they simply stop
            standing between the operator and the motors. */}
        <Pressable
          onPress={() => setAdvancedVerificationOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{expanded: advancedVerificationOpen}}
          style={styles.disclosure}
          testID="motors-advanced-verification-toggle"
        >
          {/* THE SECTION NAME LIVES ON THE CLOSED DISCLOSURE, not inside
              it. A heading that only exists once a person has already
              opened the drawer cannot tell them what is in the drawer -
              and it cannot hold the ordering guarantee that the primary
              workspace comes first, because a collapsed section would
              simply have no position at all. */}
          <Text style={styles.disclosureTitle} testID="motors-tools-heading">
            التحقق والأدوات
          </Text>
          <Text style={styles.disclosureHint}>
            {t('motorsScreen.advancedVerificationHint')}
          </Text>
        </Pressable>

        {advancedVerificationOpen ? (
          <View style={styles.advancedStack} testID="motors-advanced-verification">
        {/* P3: THE LEGACY BENCH IS NOW A SECONDARY TOOL. The professional
            workspace above is the primary path; this card keeps the
            verification workflow (selection, airframe reference, the hold
            action) reachable without ever standing between Enable and the
            sliders. */}
        <Text style={styles.sectionTitle}>
          {t('motorsScreen.advancedVerification')}
        </Text>
        <View style={styles.benchCard} testID="motors-workspace">
          {/* FINAL-REVIEW M-2: this card no longer carries a second
              identification model. The X-of-4 badge contradicted the
              identity summary on non-quad aircraft (0-of-4 beside "not
              available for this layout"), and the old copy directed the
              operator to the strip, the diagram and the hold - controls
              that moved into the identity section in P1b-B. What remains
              here is what the card actually contains: session readiness
              detail and the read-only settings summary. */}
          <View style={styles.benchHeadingRow}>
            <View style={styles.flexOne}>
              <Text style={styles.sectionTitle}>
                {t('motorsScreen.workspaceHeading')}
              </Text>
              <Text style={styles.caption}>
                {t('motorsScreen.workspaceSubtitle')}
              </Text>
            </View>
          </View>


          {/* P1b-C: the direction workflow moved UP into
              MotorDirectionSection, beside the identity it describes. It
              is not duplicated here - there is exactly one place a
              direction command is authored. */}
        </View>

            {/* THE DEFECT THIS CLOSES. Every child below is conditional on
                a verification session token or a receipt, both of which
                only exist AFTER a motor observation has been confirmed.
                Before that, opening this disclosure rendered an empty
                View: the operator pressed it, state flipped, and nothing
                appeared - which is exactly the "does not open" report.
                Output reordering lives in here, so it was unreachable.
                An expanded section now always says what it is waiting
                for. */}
            {receipt === undefined && verification.sessionToken === undefined ? (
              <View style={styles.advancedEmpty} testID="motors-advanced-empty">
                <Text style={styles.advancedEmptyTitle}>
                  {t('motorsScreen.advancedEmptyTitle')}
                </Text>
                <Text style={styles.caption}>
                  {t('motorsScreen.advancedEmptyBody')}
                </Text>
              </View>
            ) : null}
            {/* P1b-B: WHAT IS LEFT IN HERE, AND WHY.
                The observation wizard and the output-mapping workflow both
                moved to the core sections above - an operator must not
                need this disclosure to identify a motor, read the current
                mapping, or start a reorder. What remains is the technical
                READ-ONLY report: per-output outcomes, the receipt
                attribution and the overall verdict. It is genuinely
                secondary, and it is not a second copy of anything.
                The capability gate still applies: the report compares
                against Quad-X expectations, so it is withheld where those
                expectations do not describe the aircraft. */}
            {!quadIdentificationSupported &&
            (receipt !== undefined || verification.sessionToken !== undefined)
              ? identificationUnavailableNotice('motors-identification-unsupported-report')
              : null}
            {quadIdentificationSupported &&
            verification.sessionToken !== undefined ? (
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

      {/* (8) The motor action dock. OUTSIDE the ScrollView so the actual
          hold control cannot be confused with the explanatory Step 3 card
          or disappear below the airframe diagram. Stop stays mounted and
          is NEVER disabled for a transient UI or Promise state. */}
      {/* THE THIRD STOP BUTTON IS GONE.
          There were three: this one in flow inside the Motor Test
          workspace, a "sticky" dock pinned here, and the session dock
          below - two of them pinned, identical in colour, wording and
          action, stacked one above the other whenever motor control was
          on. A duplicated emergency control is not twice as safe; it
          costs vertical space on every phone and makes the operator
          decide which red button is the real one.

          THE ONE THAT WAS KEPT IS THE UNCONDITIONAL ONE. The session
          dock below is pinned in EVERY state, including a fault with
          motor control already withdrawn - which is exactly the state
          where an operator most needs a stop and where the sticky one
          was hidden. Keeping the conditional control and deleting the
          unconditional one would have removed a pinned stop from the
          states that need it most. The in-flow control inside the
          workspace (motor-workspace-stop) is unchanged. */}
      <View
        style={[styles.sessionDock, { marginBottom: effectiveBottomInset + spacing.md }]}
        testID="motors-session-dock"
      >
        {/* P3: the long-press control moved into the التحقق والأدوات bench
            card below - the pinned dock no longer teaches press-and-hold
            as the way to drive motors. Stop-all and end-session remain
            pinned for every workflow. */}
        {/* FINAL-REVIEW M-1: the one instruction that must survive any
            scroll position. Same predicate and same sentence as the
            detailed banner above - deliberate safety repetition, pinned
            with STOP, never covering it, never interactive. */}
        {presentation === 'FAULT' && stopUnconfirmed ? (
          <Text
            style={styles.pinnedFaultGuidance}
            testID="motors-pinned-fault-guidance"
          >
            {t('motorsScreen.emergencyDisconnect')}
          </Text>
        ) : null}
        {pulseRejected ? (
          <Text style={styles.inlineError} testID="motors-pulse-rejected">
            {t('motorsScreen.pulseRejected')}
          </Text>
        ) : null}
        <Pressable onPress={handleStopPress} accessibilityRole="button" accessibilityState={{ disabled: false }} style={styles.stopButton} testID="motors-stop-button">
          <Icon name="square" size={26} color={colors.white} />
          <Text style={styles.stopLabel}>{t('motorsScreen.stop')}</Text>
        </Pressable>
        {endSessionFailed || sessionCloseFailed ? <Text style={styles.inlineError} testID="motors-end-session-failed">{t('motorsScreen.endSessionFailed')}</Text> : null}
        {sessionHasEnded ? <Text style={styles.sessionEndedText} testID="motors-end-session-done">{t('motorsScreen.endSessionDone')}</Text> : null}
      </View>

      {mayBeLive ? (
        <View style={styles.liveStrip} testID="motors-command-may-be-live" />
      ) : null}
    </View>
  );
}

/** Minimum touch target, matching SafetyStrip's own accessibility note. */
const MIN_TOUCH_TARGET = 44;
/**
 * THE HOLD CONTROL'S RESERVED HEIGHT.
 *
 * One integrated control, comfortably above the 44px touch minimum and
 * nowhere near the 132px panel it replaced. It is a constant because the
 * height must be identical in every label state - see `holdButton`.
 */
const HOLD_CONTROL_HEIGHT = 56;

const styles = StyleSheet.create({
  toolsHeading: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  professionalStopDock: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    // Centred rather than stretched, so the control below can be its own
    // size without drifting to one edge.
    alignItems: 'center',
  },
  professionalStopButton: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radii.md,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    /* SIZED TO THE ACTION, NOT TO THE SCREEN.
       This was a full-width red slab, because the dock is a column and a
       child that names no alignSelf stretches. Danger is carried by the
       colour, the wording and the fact that it is pinned where it cannot
       scroll away - none of which needs the whole width of the display,
       and all of which was being drowned out by a bar that read as a
       banner. It stays a large, unmissable target: generous padding and
       the same 44pt floor as every other control. */
    alignSelf: 'center',
    paddingHorizontal: spacing.xl,
  },
  professionalStopLabel: {
    ...typography.sectionTitle,
    color: colors.surface,
    fontSize: 16,
  },
  /* ---------------- REGION A: the compact header ---------------- */
  /* One row, baseline-aligned: the screen's name and what it is for.
     It replaces an eyebrow + display title + subtitle stack that cost
     144px before a single control appeared. */
  headerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  headerSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    flexShrink: 1,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },

  /* ---------------- REGION B: the two-column workspace ----------- */
  /* One column by default - a phone has no width to give away. `wrap`
     rather than a second breakpoint: if the two columns cannot both
     hold their minimum they stack instead of squeezing, which is what
     keeps the airframe diagram legible at 1000-1100px. */
  workspaceRow: { gap: spacing.md },
  workspaceRowWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
  },
  workspaceColumn: { gap: spacing.md },
  /* 46 / 54. The airframe side is a square-ish diagram plus short fact
     rows; the control side carries four labelled sliders, a master and
     the stop, and is the side that suffers first when it is narrow.
     minWidth stops either from collapsing below the point where its
     own contents start wrapping badly. */
  workspaceColumnAirframe: { flexGrow: 1, flexBasis: '46%', minWidth: 380 },
  workspaceColumnControls: { flexGrow: 1, flexBasis: '52%', minWidth: 420 },

  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: {
    // Even padding on every side. The old `paddingBottom: spacing.xxl * 4`
    // was reserving room for a dock that is a flow sibling and never
    // covered anything - see the ScrollView's own note.
    padding: spacing.lg,
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
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  title: {
    ...typography.display,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  screenSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  dangerBanner: {...noticeSurface, flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.errorSoft,
    borderColor: colors.error},
  dangerIcon: { fontSize: 22, color: colors.error },
  dangerTitle: {
    ...typography.sectionTitle,
    color: colors.error,
    writingDirection: 'rtl',
    flexShrink: 1},
  dangerBody: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
  safetyNoticeCopy: { gap: spacing.xs },
  faultBanner: {...noticeSurface, flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.errorSoft,
    borderColor: colors.error,
    borderWidth: 2},
  faultText: {
    ...typography.title,
    color: colors.error,
    writingDirection: 'rtl',
    flexShrink: 1},
  /* A COLLAPSED SECTION IS A ROW YOU PRESS, not a page-width panel.
     Both disclosures used the full card style - shadow, 18px padding,
     a section-title heading and an explanatory paragraph, stacked - and
     measured 141px and 127px at 390 for two controls that do one thing
     each. They are rows now: name, then what is inside, on one line
     where the width allows. Comfortably over the 44px touch minimum. */
  disclosure: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET + spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  disclosureTitle: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  disclosureHint: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
    maxWidth: PROSE_MEASURE,
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
    color: colors.accentStrong,
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
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
  workflowNumberTextDone: { color: colors.white },
  outputSection: { gap: spacing.sm },
  miniHeading: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  statusText: { ...typography.body, writingDirection: 'rtl', flexShrink: 1, maxWidth: PROSE_MEASURE},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
  blockList: { gap: spacing.xs },
  diagnosticsToggle: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  blockHeading: {
    ...typography.caption,
    color: colors.warning,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  blockReason: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
  /* Rendered INSIDE the hold control, so the reason a locked button is
     locked is read where the operator is already pressing. */
  holdBlocked: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentStrong,
    gap: spacing.xs,
    alignSelf: 'stretch',
  },
  holdBlockedTitle: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  holdBlockedReason: {
    ...typography.body,
    color: colors.textPrimary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  advancedEmpty: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  advancedEmptyTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
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
    flexShrink: 1},
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
    backgroundColor: colors.warningSoft,
  },
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    // M1..M4 are latin identifiers; forced LTR keeps them readable inside
    // the RTL page instead of being reordered around the digit.
    writingDirection: 'ltr',
  },
  slotLabelLive: { color: colors.warning },
  slotSelected: { ...typography.caption, color: colors.accentStrong },
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
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    color: colors.accentStrong,
    writingDirection: 'ltr',
  },
  batteryWarning: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
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
  directionIconText: { fontSize: 22, color: colors.accentStrong },
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
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  /* The control and the two captions that belong to it. Left-aligned as
     a group so the button's own width reads as deliberate rather than as
     a column that failed to fill. */
  holdBlock: { gap: spacing.xs, alignSelf: 'stretch' },
  holdButton: {
    /* STILL A FIXED height, not a minimum: the label legitimately changes
       three times during one gesture (hold-to-test -> counting ->
       active). While the pointer is down, ANY size change can move this
       surface and terminate the press through scroll anchoring, so the
       box is reserved once and only the text changes inside it.

       HOLD_CONTROL_HEIGHT, not 132. The old slab was that tall because it
       carried an eyebrow, a label, a hint and sometimes a whole blocked
       explanation. Those are text, and they are now text - beside the
       control, not inside the pressable box. What is left is one line,
       and one line does not need 132px to be easy to hit: the box is
       comfortably above the 44px minimum and still the largest button in
       the region. */
    height: HOLD_CONTROL_HEIGHT,
    minHeight: MIN_TOUCH_TARGET,
    /* A BUTTON-SHAPED BUTTON. It does not stretch to whatever column it
       lands in - a 520px turquoise panel was reading as a card, not as a
       thing to press. It is given a floor wide enough for the longest
       label it shows and a ceiling that keeps it a control. */
    alignSelf: 'flex-start',
    minWidth: 208,
    maxWidth: 340,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  holdButtonOff: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.disabled,
    opacity: 0.6,
  },
  /* PRESSED MUST BE UNMISTAKABLE. A smaller control has less surface to
     say "I am held", so the pressed state now changes the fill, not only
     the border: the pointer is down, the countdown is running, and the
     operator can see that without reading the label. */
  holdButtonPressed: {
    backgroundColor: colors.accentStrong,
    borderColor: colors.textPrimary,
    borderWidth: 3,
  },
  holdButtonLive: {
    backgroundColor: colors.warning,
    borderColor: colors.warning,
    opacity: 1,
  },
  holdLabel: {
    ...typography.sectionTitle,
    color: colors.accentText,
    writingDirection: 'rtl',
    flexShrink: 1},
  holdLabelOff: {
    color: colors.textPrimary,
  },
  holdSupportingActive: {
    color: colors.accentText,
  },
  /* The hint that used to live inside the button. Same words, same
     truth, one caption line under the control. */
  holdHint: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  readinessBlock: {...noticeSurface, gap: spacing.xs,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft},
  prepareButton: { minHeight: MIN_TOUCH_TARGET + spacing.md, alignItems: 'center', justifyContent: 'center', borderColor: colors.accent, borderWidth: 2, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  prepareLabel: { ...typography.sectionTitle, color: colors.accentStrong, writingDirection: 'rtl'},
  /* THE QUIET STATE, AS A STRIP. Same words, same colour meaning, one
     line. The full accessibility sentence is on the container, so a
     screen reader still hears which motor is addressed. */
  readyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: '#A9D8CB',
    backgroundColor: colors.successSoft,
  },
  readyDot: {
    width: 10,
    height: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.success,
  },
  readyStripText: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  readyStripMotor: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  pinnedFaultGuidance: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  inlineError: { ...typography.caption, color: colors.error, writingDirection: 'rtl', textAlign: 'center' },
  leaveButton: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' },
  leaveLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl'},
  /**
   * The pinned stop bar. A SIBLING of the scroll view, never an overlay -
   * see the ScrollView's note for why nothing reserves space for it.
   *
   * The hairline is not decoration. Without it the list's clipped edge
   * runs straight into the red button, and a row that is merely SCROLLED
   * OFF reads as a row the button is COVERING - which is exactly the
   * complaint that started this, on a layout that never overlapped
   * anything. The rule states where the scrolling surface ends.
   */
  /* THE PINNED EMERGENCY ROW, sized to its contents.
     It was a 724px-wide slab centred under every layout - 132px tall at
     1920, holding one button and a lot of nothing. It is a row now: the
     stop keeps its red fill, its icon and a touch target well above the
     44px floor, but it stops reserving half a desktop to say one word.
     Still a flow sibling of the ScrollView (never an overlay), so the
     scrolling viewport still ENDS above it and nothing is covered. */
  sessionDock: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    gap: spacing.xs,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    /* Sized to its own content and pushed to the reading edge, rather
       than stretched across the dock. The danger is carried by the red
       fill, the icon and the pinned position - width added none of it. */
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xl,
    minHeight: MIN_TOUCH_TARGET + spacing.sm,
    backgroundColor: colors.error,
    borderRadius: radii.lg,
    padding: spacing.md,
    shadowColor: colors.error,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
    elevation: 4,
  },
  stopIcon: { fontSize: 22, color: colors.white },
  stopLabel: {
    ...typography.title,
    color: colors.white,
    writingDirection: 'rtl'},
  endSessionButton: { minHeight: MIN_TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', borderColor: colors.warning, borderWidth: 2, borderRadius: radii.md, padding: spacing.sm },
  endSessionLabel: { ...typography.body, color: colors.warning, fontWeight: '700', writingDirection: 'rtl'},
  sessionEndedText: { ...typography.caption, color: colors.success, textAlign: 'center', writingDirection: 'rtl' },
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

/**
 * How the shell asks whether leaving Motors is safe YET.
 *
 * The stop itself is already requested synchronously by the shell's blur
 * emission before this is ever consulted - this only reports the bounded
 * verdict so navigation can wait for it instead of committing blind.
 */
export interface MotorsDepartureGate {
  /**
   * The CURRENT verdict, given how long the caller has been waiting.
   *
   * Deliberately not a Promise, and deliberately owning no timer: this
   * screen is guarded to create no timer beyond its declared heartbeat,
   * and navigation timing belongs to the shell that owns navigation. The
   * shell drives the bound; this only reports the controller's state.
   */
  evaluate(elapsedMs: number): MotorDepartureVerdict;
  /** Fires whenever the controller publishes, so the shell can re-read. */
  subscribe(listener: () => void): () => void;
}

export interface MotorsTabProps {
  readonly sessionKey: SetupUiSessionKey | undefined;
  readonly navigation: MotorsHostNavigation;
  /** Registered on mount, cleared on unmount. */
  readonly registerDepartureGate?: (gate: MotorsDepartureGate | undefined) => void;
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
  /**
   * The shell's established lifecycle signal - the SAME prop ten other
   * tabs already receive. Motors and Ports were the only screens the shell
   * never handed it to, so Motors had no way to tell "visible" from
   * "mounted but behind another tab" and kept rendering its whole tree,
   * diagram included, on every controller publication while hidden.
   *
   * IT PAUSES PRESENTATION ONLY. Every safety obligation - the controller
   * subscription, the lifecycle bridge, the departure gate, the blur stop
   * path - stays live regardless. A hidden Motors tab must still be able
   * to stop a motor; it just does not need to draw an aircraft nobody is
   * looking at.
   *
   * Defaults true so a direct render (tests, a future host) is unchanged.
   */
  readonly active?: boolean;
}

export default function MotorsTab({
  sessionKey,
  navigation,
  subscribeTabBlur,
  bottomInset,
  onConfigurationDirtyChange,
  registerDepartureGate,
  active = true,
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
        active={active}
      />
    );
  }
  return (
    <MotorsScreenBinding
      sessionKey={sessionKey}
      navigation={navigation}
      subscribeTabBlur={subscribeTabBlur}
      active={active}
      bottomInset={bottomInset}
      onConfigurationDirtyChange={onConfigurationDirtyChange}
      registerDepartureGate={registerDepartureGate}
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
  registerDepartureGate,
  active = true,
}: {
  sessionKey: SetupUiSessionKey;
  navigation: MotorsHostNavigation;
  subscribeTabBlur: (listener: () => void) => () => void;
  bottomInset?: number;
  onConfigurationDirtyChange?: (dirty: boolean) => void;
  registerDepartureGate?: (gate: MotorsDepartureGate | undefined) => void;
  active?: boolean;
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
    /**
     * THE DEPARTURE GATE. The shell already fired the blur listeners
     * above, so the stop request is out. This only reports the BOUNDED
     * verdict, so the shell can wait for it instead of committing the tab
     * switch in the same synchronous turn - which is what let an
     * unconfirmed stop move the operator off this screen with no LiPo
     * warning.
     *
     * It sends nothing, cancels nothing and cannot extend the stop.
     */
    registerDepartureGate?.({
      evaluate: elapsedMs =>
        evaluateMotorDeparture(operator.getSnapshot(), elapsedMs),
      subscribe: listener => operator.subscribe(listener),
    });

    const unsubscribeRelease = subscribeTabBlur(releaseOnLeave);
    const unsubscribeStackRelease = navigation.addListener(
      'blur',
      releaseOnLeave,
    );

    return () => {
      stopWaiting();
      registerDepartureGate?.(undefined);
      unsubscribeRelease();
      unsubscribeStackRelease();
      bridge.detach();
    };
  }, [operator, navigation, subscribeTabBlur, registerDepartureGate]);

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
      active={active}
    />
  );
}
