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

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

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
  /**
   * AUTHORING IS CLOSED UNTIL ASKED FOR. The three truth rows are what an
   * operator reads; the Normal/Reverse form is what they occasionally do.
   * Measured at 360px, that form owned 562 of the section's 855 pixels at
   * rest and 718 of 1187 after a command - two thirds of the height for a
   * control nobody is using most of the time.
   */
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /**
   * The last outcome, kept HERE rather than in the panel, because the panel
   * unmounts when authoring collapses and a result an operator never saw
   * would be worse than no result at all. Presentation only: COMMANDED
   * evidence still lives in the session log, and a rejected command still
   * produces none.
   */
  const [lastResult, setLastResult] = useState<
    {motorNumber: number; message: string; danger: boolean} | undefined
  >(undefined);

  // A different motor is a different question. Nothing about the previous
  // one - open form, unsent target, last message - carries across.
  useEffect(() => {
    setAuthoringOpen(false);
    setLastResult(undefined);
  }, [selectedMotor, operator]);

  const handleOutcome = useCallback(
    (
      motorNumber: number,
      target: DshotEscDirection,
      status: 'ACKNOWLEDGED' | 'UNCONFIRMED' | 'REJECTED' | 'FAILED',
      message: string,
    ) => {
      setLastResult({
        motorNumber,
        message,
        danger: status !== 'ACKNOWLEDGED',
      });
      // Only an outcome that says something about the REQUEST becomes
      // session evidence. A rejection never happened.
      if (status === 'ACKNOWLEDGED' || status === 'UNCONFIRMED') {
        onCommandOutcome(motorNumber, target, status);
      }
      // Collapse on every settled outcome: the form has done its job, and
      // leaving it expanded is what made this section a screenful.
      setAuthoringOpen(false);
    },
    [onCommandOutcome],
  );

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
      {/* ONE HEADING THAT NAMES THE MOTOR. It used to be three stacked
          lines - an eyebrow, a title, and the motor number on its own -
          all saying the same thing the identification summary a few
          pixels above already says. */}
      <Text style={styles.title} testID="motor-direction-motor">
        {t('motorsScreen.directionTitleFor', {motor: `M${selectedMotor}`})}
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

      {/* THE TWO SAFETY TRUTHS, IN ONE LINE EACH AND NEVER BEHIND A TAP.
          The first is why COMMANDED can never become a current-state
          reading; the second is why COMMANDED and OBSERVED are never
          compared. Their longer explanations sit under the single details
          toggle below - the claims themselves do not.

          THIS ROUND TRIED TO SHOW THEM ONLY ALONGSIDE A COMMANDED VALUE,
          on the reasoning that a caveat about an absent reading explains
          nothing. `motorsDirectionTruth.test.tsx` refused it, by name:
          "the resting state is truth only - shows both safety truths with
          nothing opened". The claim an operator needs BEFORE sending a
          command is exactly the claim that the thing they are about to
          send can never be read back. It stays visible at rest. */}
      <Text style={styles.caption} testID="motor-direction-no-readback">
        {t('motorsScreen.directionNoReadback')}
      </Text>
      <Text style={styles.caption} testID="motor-direction-vocabulary">
        {t('motorsScreen.directionVocabularyShort')}
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

      {/* ONE details disclosure for the whole section. Opening it sends
          nothing and spins nothing. */}
      <Pressable
        onPress={() => setDetailsOpen(open => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        accessibilityLabel={t('motorsScreen.directionTitle')}
        style={styles.linkButton}
        testID="motor-direction-details-toggle"
      >
        <Text style={styles.linkText}>{t('motorsScreen.detailsToggle')}</Text>
      </Pressable>
      {detailsOpen ? (
        <View style={styles.detailsBlock} testID="motor-direction-details">
          <Text style={styles.caption}>
            {t('motorsScreen.directionVocabularyNote')}
          </Text>
          <Text style={styles.caption}>{t('escDirection.currentUnknown')}</Text>
          <Text style={styles.caption}>{t('escDirection.physicalCaveat')}</Text>
        </View>
      ) : null}

      {/* THE LAST OUTCOME, compactly, and it survives the form closing. */}
      {lastResult !== undefined &&
      lastResult.motorNumber === selectedMotor ? (
        <Text
          style={lastResult.danger ? styles.resultDanger : styles.resultGood}
          testID="motor-direction-result"
        >
          {lastResult.message}
        </Text>
      ) : null}

      {/* COMMAND CAPABILITY, always stated - never an inert control. */}
      {commandAvailable ? (
        authoringOpen ? (
          <View style={styles.authoringBlock} testID="motor-direction-authoring">
            <EscDirectionPanel
              selectedMotor={selectedMotor}
              operator={operator}
              onDirtyChange={onDirtyChange}
              onCommandOutcome={handleOutcome}
            />
            {/* Closing discards an UNSENT target, because the panel
                unmounts with it - reopening starts neutral. It cannot
                discard COMMANDED evidence, which lives in the session log
                rather than in the form. */}
            <Pressable
              onPress={() => setAuthoringOpen(false)}
              accessibilityRole="button"
              style={styles.secondaryButton}
              testID="motor-direction-authoring-cancel"
            >
              <Text style={styles.secondaryButtonText}>
                {t('motorsScreen.directionAuthoringCancel')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setAuthoringOpen(true)}
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            style={styles.primaryButton}
            testID="motor-direction-authoring-open"
          >
            <Text style={styles.primaryButtonText}>
              {t('motorsScreen.directionAuthoringOpen')}
            </Text>
          </Pressable>
        )
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
          confirmation - the operator decides when to verify, and the
          verification itself is the protected hold in the identity
          section above. Nothing here can spin a motor. */}
      {commanded !== undefined ? (
        <Text style={styles.verifyTitle} testID="motor-direction-verify">
          {t('motorsScreen.directionVerifyCompact')}
        </Text>
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
  title: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
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
    flexShrink: 1, maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
  mismatch: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  match: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
  authoringBlock: { gap: spacing.xs },
  detailsBlock: { gap: spacing.xs },
  linkButton: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  linkText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl'},
  primaryButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
  },
  primaryButtonText: {
    ...typography.label,
    color: colors.accentText,
    writingDirection: 'rtl'},
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    ...typography.label,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  resultGood: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  resultDanger: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  verifyTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
});
