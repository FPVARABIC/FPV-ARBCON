/**
 * Phase 2I - the user-observation verification wizard and the read-only
 * report.
 *
 * WHAT THIS FILE CANNOT DO - structurally, not by convention:
 *   - It NEVER calls `pulseMotor`. It cannot start a motor, advance to the
 *     next output, or re-run one. Every new pulse requires a fresh,
 *     deliberate 800 ms long press on the Phase 2H control.
 *   - It never names command 214, 1050 or 1000, never encodes a payload,
 *     and never touches a transport, client, lease or vector.
 *   - It creates no session, controller, binding, authority or timer.
 *
 * WHAT IT COLLECTS. One deliberate PHYSICAL observation per eligible
 * receipt - what a person saw with their own eyes. The three evidence
 * sources stay visibly separate on screen: the EXPECTED configuration, the
 * SOFTWARE acknowledgement, and the USER's observation. They are never
 * merged into a single verdict.
 *
 * WHAT IT NEVER CLAIMS. That a motor rotated, that the expected motor
 * rotated, that the direction was correct, that anything mechanically
 * stopped, or that the aircraft is safe to arm or fly. Even four matching
 * observations report only that the OBSERVATIONS matched the expectation.
 */

import React, {useCallback, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../theme';
import type {MotorTestVerificationReceipt} from '../../core/state/motorTestController';
import {
  confirmedCount,
  deriveOverall,
  expectedFor,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorPhysicalPosition,
  type MotorRotationDirection,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';

const POSITIONS: readonly MotorPhysicalPosition[] = Object.freeze([
  'FRONT_LEFT',
  'FRONT_RIGHT',
  'REAR_LEFT',
  'REAR_RIGHT',
]);

const DIRECTIONS: readonly MotorRotationDirection[] = Object.freeze([
  'CW',
  'CCW',
]);

const EXCEPTIONS: readonly {
  readonly kind: MotorObservation['kind'];
  readonly labelKey: string;
}[] = Object.freeze([
  Object.freeze({kind: 'NO_MOVEMENT' as const, labelKey: 'noMovement'}),
  Object.freeze({kind: 'MULTIPLE_MOTORS' as const, labelKey: 'multipleMotors'}),
  Object.freeze({
    kind: 'POSITION_UNCERTAIN' as const,
    labelKey: 'positionUncertain',
  }),
  Object.freeze({
    kind: 'DIRECTION_UNCERTAIN' as const,
    labelKey: 'directionUncertain',
  }),
]);

export interface MotorVerificationWizardProps {
  /**
   * The ONLY way in. Undefined means no eligible completed attempt exists,
   * and the wizard says so instead of offering questions it cannot
   * attribute to anything.
   */
  readonly receipt: MotorTestVerificationReceipt | undefined;
  readonly state: MotorVerificationState;
  /** Applies a confirmed observation. The host owns the state. */
  readonly onConfirm: (
    receipt: MotorTestVerificationReceipt,
    observation: MotorObservation,
  ) => void;
  /** Raised when the user reports more than one motor moving: the host
   * must abort verification and run the accepted safe teardown route. */
  readonly onMultipleMotorsReported?: () => void;
}

export function MotorVerificationWizard({
  receipt,
  state,
  onConfirm,
  onMultipleMotorsReported,
}: MotorVerificationWizardProps): React.JSX.Element {
  const {t} = useTranslation();
  // Pre-confirmation selections are freely correctable. They become
  // immutable only at confirmation, which is why they live here and not
  // in the model.
  const [position, setPosition] = useState<MotorPhysicalPosition | undefined>();
  const [direction, setDirection] = useState<
    MotorRotationDirection | undefined
  >();

  const entry = useMemo(
    () =>
      receipt === undefined
        ? undefined
        : state.entries.find(e => e.motorNumber === receipt.motorNumber),
    [receipt, state.entries],
  );
  const alreadyConfirmed = entry !== undefined && entry.outcome !== 'UNTESTED';

  const confirm = useCallback(
    (observation: MotorObservation) => {
      if (receipt === undefined) {
        return;
      }
      onConfirm(receipt, observation);
      setPosition(undefined);
      setDirection(undefined);
      if (observation.kind === 'MULTIPLE_MOTORS') {
        onMultipleMotorsReported?.();
      }
    },
    [receipt, onConfirm, onMultipleMotorsReported],
  );

  if (receipt === undefined) {
    return (
      <View style={styles.card} testID="verification-no-receipt">
        <Text style={styles.sectionTitle}>{t('motorVerification.title')}</Text>
        <Text style={styles.body}>{t('motorVerification.noReceipt')}</Text>
      </View>
    );
  }

  const expected = expectedFor(receipt.motorNumber);
  const canConfirm = position !== undefined && direction !== undefined;

  return (
    <View style={styles.card} testID="verification-wizard">
      <Text style={styles.sectionTitle}>{t('motorVerification.title')}</Text>

      {/* Progress, explicitly WITHOUT implying automatic sequencing. */}
      <Text style={styles.caption} testID="verification-progress">
        {t('motorVerification.progress', {
          done: confirmedCount(state),
          total: MOTOR_TEST_EXPECTED_CONFIGURATION.length,
        })}
      </Text>
      <Text style={styles.caption}>{t('motorVerification.progressNotice')}</Text>

      {/* The disclaimer, prominently. */}
      <Text style={styles.disclaimer} testID="verification-disclaimer">
        {t('motorVerification.disclaimer')}
      </Text>

      {/* Evidence source (2): SOFTWARE - stated as reception only. */}
      <View style={styles.evidenceBlock} testID="verification-software-evidence">
        <Text style={styles.evidenceHeading}>
          {t('motorVerification.softwareHeading')}
        </Text>
        <Text style={styles.body}>{t('motorVerification.softwareAck')}</Text>
        <Text style={styles.caption}>
          {t('motorVerification.softwareNotClaim')}
        </Text>
      </View>

      {/* Evidence source (1): EXPECTED - visually distinct from observed. */}
      <View style={styles.evidenceBlock} testID="verification-expected">
        <Text style={styles.evidenceHeading}>
          {t('motorVerification.expectedHeading')}
        </Text>
        <View style={styles.row}>
          <Text style={styles.slotLabel}>{`M${receipt.motorNumber}`}</Text>
          <Text
            style={styles.body}
            accessibilityLabel={`${t('motorVerification.expectedHeading')}: ${t(
              `motorVerification.position.${expected?.position}`,
            )}`}>
            {t(`motorVerification.position.${expected?.position}`)}
          </Text>
          <Text style={styles.body}>
            {t(`motorVerification.direction.${expected?.direction}`)}
          </Text>
        </View>
      </View>

      {alreadyConfirmed ? (
        <Text style={styles.lockedText} testID="verification-locked">
          {t('motorVerification.confirmedLocked')}
        </Text>
      ) : (
        <View
          style={styles.evidenceBlock}
          testID="verification-questions"
          accessibilityLabel={t('motorVerification.observedHeading')}>
          <Text style={styles.evidenceHeading}>
            {t('motorVerification.observedHeading')}
          </Text>

          <Text style={styles.body}>
            {t('motorVerification.questionPosition')}
          </Text>
          <View style={styles.optionRow}>
            {POSITIONS.map(value => (
              <Pressable
                key={value}
                onPress={() => setPosition(value)}
                accessibilityRole="radio"
                accessibilityState={{selected: position === value}}
                style={[styles.option, position === value && styles.optionOn]}
                testID={`verification-position-${value}`}>
                <Text style={styles.optionLabel}>
                  {position === value ? '◉ ' : '○ '}
                  {t(`motorVerification.position.${value}`)}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.body}>
            {t('motorVerification.questionDirection')}
          </Text>
          <View style={styles.optionRow}>
            {DIRECTIONS.map(value => (
              <Pressable
                key={value}
                onPress={() => setDirection(value)}
                accessibilityRole="radio"
                accessibilityState={{selected: direction === value}}
                style={[styles.option, direction === value && styles.optionOn]}
                testID={`verification-direction-${value}`}>
                <Text style={styles.optionLabel}>
                  {direction === value ? '◉ ' : '○ '}
                  {t(`motorVerification.direction.${value}`)}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={() => {
              if (position !== undefined && direction !== undefined) {
                confirm({kind: 'OBSERVED', position, direction});
              }
            }}
            disabled={!canConfirm}
            accessibilityRole="button"
            accessibilityState={{disabled: !canConfirm}}
            style={[styles.confirmButton, !canConfirm && styles.confirmOff]}
            testID="verification-confirm">
            <Text style={styles.confirmLabel}>
              {t('motorVerification.confirm')}
            </Text>
          </Pressable>

          <Text style={styles.evidenceHeading}>
            {t('motorVerification.exceptionHeading')}
          </Text>
          {EXCEPTIONS.map(exception => (
            <Pressable
              key={exception.kind}
              onPress={() =>
                confirm({kind: exception.kind} as MotorObservation)
              }
              accessibilityRole="button"
              style={styles.option}
              testID={`verification-exception-${exception.kind}`}>
              <Text style={styles.optionLabel}>
                {t(`motorVerification.${exception.labelKey}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/* ================================================================== *
 * The read-only report
 * ================================================================== */

export interface MotorTestReportProps {
  readonly state: MotorVerificationState;
  /**
   * True only when the accepted safe final teardown completed with an
   * attributable software stop. When false, a NORMAL completed report is
   * never shown - the host keeps its fault presentation instead.
   */
  readonly safeTeardownConfirmed: boolean;
}

export function MotorTestReport({
  state,
  safeTeardownConfirmed,
}: MotorTestReportProps): React.JSX.Element {
  const {t} = useTranslation();
  const overall = deriveOverall(state);
  const effectiveOverall = safeTeardownConfirmed ? overall : 'UNSAFE_ABORTED';

  const headingKey =
    effectiveOverall === 'UNSAFE_ABORTED'
      ? 'overallUnsafe'
      : effectiveOverall === 'MISMATCH_DETECTED'
        ? 'overallMismatch'
        : effectiveOverall === 'INCOMPLETE'
          ? 'overallIncomplete'
          : 'overallMatch';

  return (
    <View style={styles.card} testID="motor-test-report">
      <Text style={styles.sectionTitle}>
        {t('motorVerification.reportTitle')}
      </Text>
      <Text style={styles.caption} testID="report-readonly-notice">
        {t('motorVerification.reportReadOnly')}
      </Text>
      <Text style={styles.disclaimer} testID="report-disclaimer">
        {t('motorVerification.disclaimer')}
      </Text>

      <Text
        style={[
          styles.overall,
          effectiveOverall === 'UNSAFE_ABORTED' && {color: colors.error},
        ]}
        testID={`report-overall-${effectiveOverall}`}>
        {t(`motorVerification.${headingKey}`)}
      </Text>

      {effectiveOverall === 'OBSERVATIONS_MATCH_EXPECTED' ? (
        // Never a bare "PASS". The qualification travels with the result.
        <Text style={styles.caveat} testID="report-match-caveat">
          {t('motorVerification.overallMatchCaveat')}
        </Text>
      ) : null}

      {state.entries.map(entry => {
        const expected = expectedFor(entry.motorNumber);
        return (
          <View
            key={entry.motorNumber}
            style={styles.reportRow}
            testID={`report-entry-${entry.motorNumber}`}>
            <Text style={styles.slotLabel}>{`M${entry.motorNumber}`}</Text>
            <View style={styles.flexOne}>
              <Text
                style={styles.caption}
                accessibilityLabel={t('motorVerification.expectedHeading')}>
                {t('motorVerification.expectedHeading')}:{' '}
                {t(`motorVerification.position.${expected?.position}`)} ·{' '}
                {t(`motorVerification.direction.${expected?.direction}`)}
              </Text>
              <Text
                style={styles.body}
                accessibilityLabel={t('motorVerification.observedHeading')}
                testID={`report-outcome-${entry.motorNumber}`}>
                {t('motorVerification.observedHeading')}:{' '}
                {t(`motorVerification.outcome.${entry.outcome}`)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  flexOne: {flex: 1},
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  body: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  disclaimer: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  caveat: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  evidenceBlock: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  evidenceHeading: {
    ...typography.caption,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  optionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  option: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
  },
  optionOn: {borderColor: colors.accent, borderWidth: 2},
  optionLabel: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  confirmButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  confirmOff: {borderColor: colors.disabled, opacity: 0.5},
  confirmLabel: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  lockedText: {
    ...typography.body,
    color: colors.success,
    writingDirection: 'rtl',
  },
  overall: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  reportRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.sm,
  },
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    // Latin identifiers stay LTR inside the RTL page.
    writingDirection: 'ltr',
  },
});

/** Default export matches repository screen-module convention. */
export default MotorVerificationWizard;
