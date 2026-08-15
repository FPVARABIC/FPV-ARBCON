/**
 * MOTOR DIRECTION - THREE SOURCES, THREE SENTENCES, NEVER MERGED.
 *
 *   EXPECTED   the airframe template's clockwise/anticlockwise for this
 *              motor. An app constant, shown only where the template
 *              applies, and never a claim about this aircraft.
 *   COMMANDED  the ESC setting this session asked for and the flight
 *              controller accepted. Not a readback: the audited MSP
 *              surface has no command that reports ESC spin direction.
 *   OBSERVED   what a person watched the motor do. The only physical
 *              truth, and it comes from the identification workflow's
 *              existing observation - never from anything here.
 *
 * WHY NO COMPARISON BETWEEN COMMANDED AND THE OTHER TWO. Normal/Reverse
 * select which of an ESC's two stored directions is active; which
 * physical rotation that produces also depends on how the motor's three
 * phases are wired. So "commanded Reverse" and "observed clockwise" are
 * statements in two different vocabularies, and a tick mark between them
 * would be invented. Expected and observed are BOTH clockwise/
 * anticlockwise, so those two - and only those two - are compared.
 *
 * WHAT AN ACKNOWLEDGEMENT MEANS. The flight controller accepted and
 * processed the request. It is not proof the ESC applied it, not proof
 * the motor now turns that way, and it never touches the observation.
 * After a command this section OFFERS verification; it never performs it,
 * and it never spins a motor.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorIdentificationCapability } from '../../core/state/motorIdentificationCapability';
import type { MotorDirectionCommandCapability } from '../../core/state/motorDirectionCapability';
import type { MotorDirectionCommandRecord } from '../../core/state/motorDirectionCommandRecord';
import {
  expectedFor,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type { DshotEscDirection } from '../../core';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import { EscDirectionPanel } from './EscDirectionPanel';
import { colors, radii, spacing, typography } from '../theme';

export interface MotorDirectionSectionProps {
  readonly selectedMotor: number;
  readonly operator: MotorTestOperatorPort | undefined;
  /** Whether the airframe TEMPLATE applies to this aircraft at all. */
  readonly identificationCapability: MotorIdentificationCapability;
  /** Whether a direction COMMAND may be sent - a different question. */
  readonly commandCapability: MotorDirectionCommandCapability;
  readonly verification: MotorVerificationState;
  /** The last command this session sent for the selected motor. */
  readonly commanded: MotorDirectionCommandRecord | undefined;
  readonly onCommandOutcome: (
    motorNumber: number,
    target: DshotEscDirection,
    status: 'ACKNOWLEDGED' | 'UNCONFIRMED',
  ) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

function SourceRow({
  label,
  value,
  badge,
  testID,
  strong,
}: {
  readonly label: string;
  readonly value: string;
  readonly badge?: string;
  readonly testID: string;
  readonly strong?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueGroup}>
        <Text
          style={[styles.rowValue, strong === true && styles.rowValueStrong]}
          testID={testID}
        >
          {value}
        </Text>
        {badge !== undefined ? (
          <View style={styles.badge} testID={`${testID}-badge`}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function MotorDirectionSection({
  selectedMotor,
  operator,
  identificationCapability,
  commandCapability,
  verification,
  commanded,
  onCommandOutcome,
  onDirtyChange,
}: MotorDirectionSectionProps): React.JSX.Element {
  const { t } = useTranslation();

  const templateApplies = identificationCapability.kind === 'SUPPORTED';
  const expected = templateApplies ? expectedFor(selectedMotor) : undefined;

  const entry = verification.entries.find(e => e.motorNumber === selectedMotor);
  const observedDirection =
    entry?.observation?.kind === 'OBSERVED'
      ? entry.observation.direction
      : undefined;
  /** "I could not tell" is an ANSWER, and it is not an unanswered state. */
  const observationUncertain =
    entry?.observation?.kind === 'DIRECTION_UNCERTAIN' ||
    entry?.observation?.kind === 'POSITION_UNCERTAIN';

  /**
   * The ONLY comparison this file makes. Both sides speak
   * clockwise/anticlockwise, so the statement means something.
   */
  const directionMismatch =
    expected !== undefined &&
    observedDirection !== undefined &&
    observedDirection !== expected.direction;
  const directionMatch =
    expected !== undefined &&
    observedDirection !== undefined &&
    observedDirection === expected.direction;

  const commandAvailable = commandCapability.kind === 'AVAILABLE';

  return (
    <View style={styles.card} testID="motor-direction-section">
      <Text style={styles.eyebrow}>{t('motorsScreen.directionEyebrow')}</Text>
      <Text style={styles.title}>{t('motorsScreen.directionTitle')}</Text>
      <Text style={styles.motor} testID="motor-direction-motor">
        {`M${selectedMotor}`}
      </Text>

      {/* THREE ROWS, THREE SOURCES. Each names where it came from. */}
      <SourceRow
        label={t('motorsScreen.directionExpectedLabel')}
        value={
          expected === undefined
            ? t('motorsScreen.directionExpectedUnavailable')
            : t(`motorVerification.direction.${expected.direction}`)
        }
        badge={expected === undefined ? undefined : t('motorsScreen.truthExpected')}
        testID="motor-direction-expected"
      />
      <SourceRow
        label={t('motorsScreen.directionCommandedLabel')}
        value={
          commanded === undefined
            ? t('motorsScreen.directionCommandedNone')
            : t(
                commanded.status === 'ACKNOWLEDGED'
                  ? 'motorsScreen.directionCommandedValue'
                  : 'motorsScreen.directionCommandedUnconfirmed',
                {
                  target: t(
                    commanded.target === 'NORMAL'
                      ? 'escDirection.normal'
                      : 'escDirection.reversed',
                  ),
                },
              )
        }
        badge={
          commanded === undefined
            ? undefined
            : t('motorsScreen.truthCommanded')
        }
        testID="motor-direction-commanded"
      />
      <SourceRow
        label={t('motorsScreen.directionObservedLabel')}
        value={
          observedDirection !== undefined
            ? t(`motorVerification.direction.${observedDirection}`)
            : observationUncertain
              ? t('motorsScreen.directionObservedUncertain')
              : t('motorsScreen.directionObservedNone')
        }
        badge={
          observedDirection !== undefined
            ? t('motorsScreen.truthObserved')
            : undefined
        }
        testID="motor-direction-observed"
        strong={observedDirection !== undefined}
      />

      {/* THE VOCABULARY WARNING, always visible, because it is the reason
          two of these three rows are never compared. */}
      <Text style={styles.caption} testID="motor-direction-vocabulary">
        {t('motorsScreen.directionVocabularyNote')}
      </Text>

      {directionMismatch ? (
        <Text style={styles.mismatch} testID="motor-direction-mismatch">
          {t('motorsScreen.directionMismatch')}
        </Text>
      ) : null}
      {directionMatch ? (
        <Text style={styles.match} testID="motor-direction-match">
          {t('motorsScreen.directionMatch')}
        </Text>
      ) : null}

      {/* COMMAND AUTHORING. One workflow, the existing one, with its own
          UNKNOWN-by-default target and explicit two-step send. */}
      {commandAvailable ? (
        <EscDirectionPanel
          selectedMotor={selectedMotor}
          operator={operator}
          onDirtyChange={onDirtyChange}
          onCommandOutcome={onCommandOutcome}
        />
      ) : (
        <View style={styles.unavailable} testID="motor-direction-unavailable">
          <Text style={styles.unavailableTitle}>
            {t('motorsScreen.directionCommandUnavailable')}
          </Text>
          <Text
            style={styles.caption}
            testID="motor-direction-unavailable-reason"
          >
            {t(
              `motorsScreen.directionBlocked.${
                commandCapability.kind === 'UNAVAILABLE'
                  ? commandCapability.reason
                  : 'NOT_READY'
              }`,
            )}
          </Text>
          {/* Expected and observed stay above even here: a blocked command
              does not make the other two truths less informative. */}
        </View>
      )}

      {/* OFFERED, NEVER PERFORMED. No pulse, no authority change, no
          confirmation - the operator decides when to verify. */}
      {commanded !== undefined ? (
        <View style={styles.verifyBlock} testID="motor-direction-verify">
          <Text style={styles.verifyTitle}>
            {t('motorsScreen.directionVerifyTitle')}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.directionVerifyBody')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'rtl',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  motor: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  rowLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  rowValueGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  rowValue: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  rowValueStrong: { fontWeight: '700' },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  badgeText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  mismatch: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  match: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  unavailable: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  unavailableTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  verifyBlock: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  verifyTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});
