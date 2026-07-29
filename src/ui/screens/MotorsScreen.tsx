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
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../theme';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';
import {createMotorTestLifecycleBridge} from '../../platforms/react-native/lifecycle/motorTestLifecycleBridge';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../navigation/types';
import {AppState, BackHandler} from 'react-native';
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
  type MotorObservation,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type {MotorTestVerificationReceipt} from '../../core/state/motorTestController';

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

/**
 * The EXPECTED Betaflight Quad X / props-out reference, shown so the
 * operator knows what to look for. Software has confirmed none of it: no
 * test in this repository establishes wiring, physical frame position or
 * rotation direction, and Phase 2I is where the operator's own physical
 * observations are collected.
 */
export const EXPECTED_QUAD_X_REFERENCE: readonly {
  readonly slot: number;
  readonly positionKey: string;
  readonly directionKey: string;
}[] = Object.freeze([
  Object.freeze({
    slot: 1,
    positionKey: 'positionRearRight',
    directionKey: 'directionCcw',
  }),
  Object.freeze({
    slot: 2,
    positionKey: 'positionFrontRight',
    directionKey: 'directionCw',
  }),
  Object.freeze({
    slot: 3,
    positionKey: 'positionRearLeft',
    directionKey: 'directionCw',
  }),
  Object.freeze({
    slot: 4,
    positionKey: 'positionFrontLeft',
    directionKey: 'directionCcw',
  }),
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
  | 'READY'
  /** A command was submitted and no attributable response has arrived. It
   * may already be live, so this is stop-dominant. */
  | 'SUBMITTED_AWAITING_RESPONSE'
  /** The FC acknowledged reception. NOT a claim of rotation. */
  | 'ACKNOWLEDGED'
  | 'STOPPING'
  | 'FAULT';

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
    case 'Ready':
      // R1: `Ready` is the REDUCER's state, not a statement that anything
      // may be started. When the authoritative gate refuses activation -
      // notably while no continuous safety monitor exists - presenting an
      // actionable READY would tell the operator something untrue. Locked
      // is the honest presentation.
      return snapshot.activation.allowed ? 'READY' : 'LOCKED';
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

export interface MotorsScreenViewProps {
  /** The operator facade from the ONE official binding. Undefined when no
   * official session is active - the screen then renders inert. */
  readonly operator: MotorTestOperatorPort | undefined;
  /** Fires when the operator asks to leave. Navigation itself is owned by
   * the lifecycle bridge and the route, never by this component. */
  readonly onRequestLeave?: () => void;
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
}: MotorsScreenViewProps): React.JSX.Element {
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();

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
  const controllerAllows = snapshot?.activation.allowed === true;
  const blockReasons = snapshot?.activation.reasons ?? [];

  // The manual acknowledgement is VOLATILE and supplemental. It resets the
  // moment the session stops being one an operator has vouched for: a
  // lock, a fault, a session replacement or the loss of the operator port
  // (blur/detach both surface here as a changed binding or a changed
  // machine state). It is never persisted anywhere.
  useEffect(() => {
    if (
      operator === undefined ||
      presentation === 'LOCKED' ||
      presentation === 'FAULT' ||
      presentation === 'NO_SESSION'
    ) {
      setAcknowledgements(NO_ACKNOWLEDGEMENTS);
    }
  }, [operator, presentation]);

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
        const result = confirmObservation(current, confirmedReceipt, observation);
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
    setAcknowledgements(current => ({...current, [key]: !current[key]}));
  }, []);

  /**
   * THE ONE STOP ROUTE. Every release, cancellation and Stop press goes
   * through here. Synchronous, and it awaits nothing before asking the
   * controller - the controller registers the emergency stop inside this
   * very call.
   */
  const stopNow = useCallback((trigger: 'TOUCH_RELEASED' | 'STOP_BUTTON_PRESSED') => {
    const port = operatorRef.current;
    if (port === undefined) {
      return;
    }
    // Repeated callbacks are expected and safe: the controller joins
    // concurrent triggers onto one stop episode and one transport write.
    port.requestStop(trigger);
  }, []);

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
  const handleSelectSlot = useCallback(
    (slot: number) => {
      const port = operatorRef.current;
      if (port !== undefined && commandMayBeLive(port.getSnapshot())) {
        const machine = port.getSnapshot().machine?.name;
        if (machine === 'Starting' || machine === 'Pulsing') {
          holdActivatedRef.current = false;
          port.requestStop('MOTOR_SELECTION_CHANGED');
        }
      }
      setSelectedSlot(slot);
    },
    [],
  );

  const statusText = useMemo(() => {
    switch (presentation) {
      case 'CHECKING':
        return t('motorsScreen.statusChecking');
      case 'LOCKED':
        return t('motorsScreen.statusLocked');
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

  return (
    <View
      style={[
        styles.root,
        {paddingTop: insets.top, paddingBottom: insets.bottom},
      ]}
      testID="motors-screen">
      {/* Scrollable body. The emergency Stop control below is deliberately
          OUTSIDE this ScrollView so it can never be scrolled out of reach,
          and the body's bottom padding keeps it from being covered. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title} testID="motors-title">
          {t('motorsScreen.title')}
        </Text>

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
              accessibilityState={{checked: acknowledgements[key]}}
              style={styles.checkRow}
              testID={`motors-ack-${key}`}>
              <Text
                style={[
                  styles.checkBox,
                  acknowledgements[key] && styles.checkBoxOn,
                ]}>
                {acknowledgements[key] ? '☑' : '☐'}
              </Text>
              <Text style={styles.checkLabel}>{t(`motorsScreen.${labelKey}`)}</Text>
            </Pressable>
          ))}
          <Text style={styles.caption}>{t('motorsScreen.ackNotice')}</Text>
        </View>

        {/* (3) Authoritative status and blocking reasons. */}
        <View style={styles.card} testID="motors-status">
          <Text style={styles.sectionTitle}>
            {t('motorsScreen.statusHeading')}
          </Text>
          <Text
            style={[styles.statusText, {color: statusColor}]}
            testID={`motors-status-${presentation}`}>
            {statusText}
          </Text>
          {presentation === 'ACKNOWLEDGED' ? (
            <Text style={styles.caption} testID="motors-ack-notice">
              {t('motorsScreen.statusAcknowledgedNotice')}
            </Text>
          ) : null}
          {blockReasons.length > 0 ? (
            <View style={styles.blockList} testID="motors-block-reasons">
              <Text style={styles.blockHeading}>
                {t('motorsScreen.blockedHeading')}
              </Text>
              {blockReasons.map((reason: MotorTestActivationBlockReason) => (
                <Text
                  key={reason}
                  style={styles.blockReason}
                  testID={`motors-block-${reason}`}>
                  • {t(`motorsScreen.blockReason.${reason}`)}
                </Text>
              ))}
            </View>
          ) : null}
        </View>

        {/* (7) Fault: the emergency instruction, prominently. */}
        {presentation === 'FAULT' ? (
          <View style={styles.faultBanner} testID="motors-fault-banner">
            <Text style={styles.dangerIcon}>⛔</Text>
            <View style={styles.flexOne}>
              <Text style={styles.faultText} testID="motors-emergency-text">
                {t('motorsScreen.emergencyDisconnect')}
              </Text>
              <Text style={styles.dangerBody} testID="motors-new-session-text">
                {t('motorsScreen.emergencyNewSession')}
              </Text>
            </View>
          </View>
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
                accessibilityState={{selected: selectedSlot === slot}}
                style={[
                  styles.slotCard,
                  selectedSlot === slot && styles.slotCardSelected,
                ]}
                testID={`motors-slot-${slot}`}>
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

        {/* (5) The EXPECTED Quad X reference - labelled as expected. */}
        <View style={styles.card} testID="motors-diagram">
          <Text style={styles.sectionTitle}>
            {t('motorsScreen.diagramHeading')}
          </Text>
          <View style={styles.diagramGrid}>
            {EXPECTED_QUAD_X_REFERENCE.map(entry => (
              <View
                key={entry.slot}
                style={styles.diagramCell}
                testID={`motors-expected-${entry.slot}`}>
                <Text style={styles.slotLabel}>{`M${entry.slot}`}</Text>
                <Text style={styles.diagramText}>
                  {t(`motorsScreen.${entry.positionKey}`)}
                </Text>
                <Text style={styles.diagramText}>
                  {t(`motorsScreen.${entry.directionKey}`)}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.caption} testID="motors-diagram-notice">
            {t('motorsScreen.diagramNotice')}
          </Text>
        </View>

        {/* Phase 2I - the observation wizard. It CANNOT activate anything;
            a new output always needs a fresh long press below. */}
        <MotorVerificationWizard
          receipt={receipt}
          state={verification}
          onConfirm={handleConfirmObservation}
          onMultipleMotorsReported={handleMultipleMotors}
        />

        {verification.sessionToken !== undefined ? (
          <MotorTestReport
            state={verification}
            // A normal completed report requires an attributable safe
            // teardown. Anything else keeps the fault presentation.
            safeTeardownConfirmed={
              presentation !== 'FAULT' &&
              snapshot?.stopExecution.attributionAmbiguous !== true
            }
          />
        ) : null}

        {/* (6) The ONE deliberate long-press control. */}
        <Pressable
          onLongPress={handleLongPress}
          delayLongPress={MOTOR_TEST_LONG_PRESS_DELAY_MILLIS}
          onPressOut={handlePressOut}
          onResponderTerminate={(_event: GestureResponderEvent) =>
            handlePressOut()
          }
          disabled={!canActivate}
          accessibilityRole="button"
          accessibilityState={{disabled: !canActivate}}
          style={[styles.holdButton, !canActivate && styles.holdButtonOff]}
          testID="motors-hold-button">
          <Text style={styles.holdLabel}>
            {t('motorsScreen.holdToTest', {slot: `M${selectedSlot}`})}
          </Text>
          <Text style={styles.caption}>{t('motorsScreen.holdHint')}</Text>
        </Pressable>

        {onRequestLeave !== undefined ? (
          <Pressable
            onPress={onRequestLeave}
            accessibilityRole="button"
            style={styles.leaveButton}
            testID="motors-leave">
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
        accessibilityState={{disabled: false}}
        style={[styles.stopButton, {marginBottom: insets.bottom + spacing.md}]}
        testID="motors-stop-button">
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
  root: {flex: 1, backgroundColor: colors.background},
  scroll: {flex: 1},
  scrollContent: {padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md},
  flexOne: {flex: 1},
  title: {...typography.title, color: colors.textPrimary, writingDirection: 'rtl'},
  dangerBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.error,
    borderWidth: 2,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  dangerIcon: {fontSize: 22, color: colors.error},
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
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.error,
    borderWidth: 2,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  faultText: {
    ...typography.title,
    color: colors.error,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  statusText: {...typography.body, writingDirection: 'rtl', flexShrink: 1},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  blockList: {gap: spacing.xs},
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
  },
  checkBox: {fontSize: 20, color: colors.textSecondary},
  checkBoxOn: {color: colors.success},
  checkLabel: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  slotRow: {flexDirection: 'row', gap: spacing.sm},
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
  slotCardSelected: {borderColor: colors.accent, borderWidth: 2},
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    // M1..M4 are latin identifiers; forced LTR keeps them readable inside
    // the RTL page instead of being reordered around the digit.
    writingDirection: 'ltr',
  },
  slotSelected: {...typography.caption, color: colors.accent},
  diagramGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  diagramCell: {
    minWidth: '45%',
    flexGrow: 1,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  diagramText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  holdButton: {
    minHeight: MIN_TOUCH_TARGET + spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  holdButtonOff: {borderColor: colors.disabled, opacity: 0.5},
  holdLabel: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  leaveButton: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center'},
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
    marginHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
    backgroundColor: colors.error,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  stopIcon: {fontSize: 22, color: colors.textPrimary},
  stopLabel: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  liveStrip: {height: 3, backgroundColor: colors.warning},
});


/* ================================================================== *
 * The route container.
 *
 * This is where the screen is BOUND to the one official session, and
 * where the accepted lifecycle bridge owns every navigation, back and
 * AppState trigger. The view above stays a pure presentation/gesture
 * layer and never learns that navigation exists.
 * ================================================================== */

type MotorsRouteProps = NativeStackScreenProps<RootStackParamList, 'Motors'>;

export default function MotorsScreenRoute({
  route,
  navigation,
}: MotorsRouteProps): React.JSX.Element {
  const sessionKey = route.params?.sessionKey;
  if (!sessionKey) {
    // Same defense-in-depth as SetupScreen: the typed call site always
    // supplies it, but a future linking config might not.
    return <MotorsScreenView operator={undefined} />;
  }
  return (
    <MotorsScreenBinding
      sessionKey={sessionKey}
      navigation={navigation}
      key={sessionKey.sessionId}
    />
  );
}

function MotorsScreenBinding({
  sessionKey,
  navigation,
}: {
  sessionKey: SetupUiSessionKey;
  navigation: MotorsRouteProps['navigation'];
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
  const operator = useMemo(() => {
    const capability = mspSessionCoordinator.getMotorTestSessionCapability(
      sessionKey.sessionId,
    );
    if (capability === undefined) {
      return undefined;
    }
    return capability.operatorPort(
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
    );
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
        addBlurListener: listener => navigation.addListener('blur', listener),
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
    return () => {
      bridge.detach();
    };
  }, [operator, navigation]);

  return <MotorsScreenView operator={operator} />;
}
