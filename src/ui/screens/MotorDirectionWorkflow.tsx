/**
 * THE MOTOR-DIRECTION WORKFLOW - M-F3 §15-§19, one surface.
 *
 * THE DEFECT THIS CLOSES (P0-2, from the release review): the direction
 * "tool" was three fragments a thousand pixels apart - the spin control
 * lived in the workspace, the observation question inside a wizard
 * behind the technical-details disclosure, and the reverse form inside
 * an authoring disclosure - so pressing «اتجاه المحركات» opened a card
 * that could not actually DO the task. This component is the whole task
 * in operating order:
 *
 *   1  acknowledge props are OFF (nothing spins before that answer);
 *   2  pick a motor - every motor shows its session status;
 *   3  read the EXPECTED direction (same derivation as the drawing);
 *   4  spin it - THE workspace hold control renders here, re-parented,
 *      the same single command path with every gate intact;
 *   5  answer «هل يدور في الاتجاه الموضح؟» - yes marks the status,
 *      no marks NEEDS_REVERSE and opens the reverse form directly;
 *   6  a reverse ACK marks «تم عكسه ويحتاج إعادة فحص» - §17: an
 *      acknowledgement never verifies - and step 4 repeats until the
 *      operator's own answer confirms.
 *
 * WHAT THIS COMPONENT OWNS: the guided order and its wording. The
 * statuses are the screen's session state (core transition function
 * motorDirectionWorkflow.ts); the three truths and the reverse form are
 * the unchanged MotorDirectionSection embedded below; the spin control
 * is handed in as a node so there is exactly ONE hold path on the page.
 *
 * §19 - PROPS DIRECTION IS A DIFFERENT SETTING. The strip's «اتجاه
 * المراوح» edits the stored mixer flag; this workflow checks each ESC's
 * spin setting against reality. The note below the title says so, so
 * the two can never be mistaken for one control.
 */

import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {
  motorDirectionWorkflowStatusKey,
  type MotorDirectionWorkflowStatus,
} from '../../core/state/motorDirectionWorkflow';
import type {MotorIdentificationCapability} from '../../core/state/motorIdentificationCapability';
import type {MotorDirectionCommandCapability} from '../../core/state/motorDirectionCapability';
import type {MotorDirectionCommandRecord} from '../../core/state/motorDirectionCommandRecord';
import type {
  MotorRotationDirection,
  MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type {DshotEscDirection} from '../../core';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {MotorDirectionSection} from './MotorDirectionSection';
import {ToggleSwitch} from '../components/controls/ToggleSwitch';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

export interface MotorDirectionWorkflowProps {
  /** The session's own motor list - the workflow can only spin and mark
   * motors the flight controller reported. Empty = no session count. */
  readonly motorNumbers: readonly number[];
  readonly selectedMotor: number;
  readonly onSelectMotor: (motorNumber: number) => void;
  /** Per-motor session statuses; a missing entry is UNCHECKED. */
  readonly statuses: ReadonlyMap<number, MotorDirectionWorkflowStatus>;
  /** The operator's answer to the observation question. */
  readonly onAnswer: (motorNumber: number, correct: boolean) => void;
  readonly propsOffAcknowledged: boolean;
  readonly onAcknowledgePropsOff: (next: boolean) => void;
  /** THE workspace hold control, re-parented here while the workflow is
   * open. One element, one command path, every gate intact. */
  readonly spinControl: React.ReactNode;
  /* ---- passed through to the embedded three-truths section ---- */
  readonly operator: MotorTestOperatorPort | undefined;
  readonly identificationCapability: MotorIdentificationCapability;
  readonly commandCapability: MotorDirectionCommandCapability;
  readonly expectedRotation: MotorRotationDirection | undefined;
  readonly verification: MotorVerificationState;
  readonly commanded: MotorDirectionCommandRecord | undefined;
  readonly onCommandOutcome: (
    motorNumber: number,
    target: DshotEscDirection,
    status: 'ACKNOWLEDGED' | 'UNCONFIRMED',
  ) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly authoringRequestId?: number;
}

function statusTone(status: MotorDirectionWorkflowStatus): string {
  switch (status) {
    case 'CONFIRMED_CORRECT':
    case 'CONFIRMED_FINAL':
      return colors.success;
    case 'NEEDS_REVERSE':
      return colors.warning;
    case 'REVERSED_RECHECK':
      return colors.accentStrong;
    case 'UNCHECKED':
      return colors.textSecondary;
  }
}

export function MotorDirectionWorkflow({
  motorNumbers,
  selectedMotor,
  onSelectMotor,
  statuses,
  onAnswer,
  propsOffAcknowledged,
  onAcknowledgePropsOff,
  spinControl,
  operator,
  identificationCapability,
  commandCapability,
  expectedRotation,
  verification,
  commanded,
  onCommandOutcome,
  onDirtyChange,
  authoringRequestId,
}: MotorDirectionWorkflowProps): React.JSX.Element {
  const {t} = useTranslation();
  const selectedStatus = statuses.get(selectedMotor) ?? 'UNCHECKED';
  const selectedExists = motorNumbers.includes(selectedMotor);
  const questionReady = propsOffAcknowledged && selectedExists;

  return (
    <View style={styles.root} testID="motor-direction-workflow">
      {/* §19: this is the ESC setting per motor, NOT the strip's stored
          props flag. One sentence, always visible. */}
      <Text style={styles.distinctionNote} testID="motor-direction-vs-props">
        {t('motorsScreen.directionVsPropsNote')}
      </Text>

      {/* ---- step 1: props OFF, acknowledged ------------------------- */}
      <View style={styles.ackRow} testID="motor-direction-props-ack">
        <Text style={styles.ackText}>{t('motorsScreen.directionAckLabel')}</Text>
        <ToggleSwitch
          value={propsOffAcknowledged}
          onValueChange={onAcknowledgePropsOff}
          accessibilityLabel={t('motorsScreen.directionAckLabel')}
          testID="motor-direction-props-ack-toggle"
        />
      </View>
      {propsOffAcknowledged ? null : (
        <Text style={styles.ackRequired} testID="motor-direction-ack-required">
          {t('motorsScreen.directionAckRequired')}
        </Text>
      )}

      {/* ---- step 2: the motors, each wearing its session status ----- */}
      {motorNumbers.length === 0 ? (
        <Text style={styles.caption} testID="motor-direction-no-motors">
          {t('motorsScreen.directionNeedsSession')}
        </Text>
      ) : (
        <View style={styles.statusBlock}>
          <Text style={styles.statusHeading}>
            {t('motorsScreen.directionStatusHeading')}
          </Text>
          <View style={styles.statusRow}>
            {motorNumbers.map(motorNumber => {
              const status = statuses.get(motorNumber) ?? 'UNCHECKED';
              const selected = motorNumber === selectedMotor;
              return (
                <Pressable
                  key={motorNumber}
                  onPress={() => onSelectMotor(motorNumber)}
                  accessibilityRole="radio"
                  accessibilityState={{selected}}
                  accessibilityLabel={`M${motorNumber}، ${t(
                    `motorsScreen.${motorDirectionWorkflowStatusKey(status)}`,
                  )}`}
                  style={[
                    styles.statusChip,
                    selected && styles.statusChipSelected,
                  ]}
                  testID={`motor-direction-status-${motorNumber}`}
                >
                  <Text style={styles.statusChipMotor}>{`M${motorNumber}`}</Text>
                  <Text
                    style={[styles.statusChipState, {color: statusTone(status)}]}
                    testID={`motor-direction-status-${motorNumber}-state`}
                  >
                    {t(`motorsScreen.${motorDirectionWorkflowStatusKey(status)}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* The statuses are the operator's own session answers - the
              application reads no ESC direction (§17/§18). */}
          <Text style={styles.caption} testID="motor-direction-status-note">
            {t('motorsScreen.directionStatusSessionNote')}
          </Text>
        </View>
      )}

      {/* ---- steps 3 + reverse: the unchanged three-truths section --- */}
      <MotorDirectionSection
        selectedMotor={selectedMotor}
        operator={operator}
        identificationCapability={identificationCapability}
        commandCapability={commandCapability}
        expectedRotation={expectedRotation}
        verification={verification}
        commanded={commanded}
        onCommandOutcome={onCommandOutcome}
        onDirtyChange={onDirtyChange}
        authoringRequestId={authoringRequestId}
      />

      {/* ---- step 4: spin - THE hold control, in place --------------- */}
      {propsOffAcknowledged ? (
        <View style={styles.spinBlock} testID="motor-direction-spin">
          <Text style={styles.caption}>{t('motorsScreen.directionSpinHint')}</Text>
          {spinControl}
        </View>
      ) : null}

      {/* ---- step 5: the observation question ------------------------ */}
      {questionReady ? (
        <View style={styles.questionBlock} testID="motor-direction-question">
          <Text style={styles.questionText}>
            {expectedRotation !== undefined
              ? t('motorsScreen.directionQuestion', {motor: `M${selectedMotor}`})
              : t('motorsScreen.directionQuestionNoSource', {
                  motor: `M${selectedMotor}`,
                })}
          </Text>
          {selectedStatus === 'REVERSED_RECHECK' ? (
            <Text style={styles.recheckNote} testID="motor-direction-recheck">
              {t('motorsScreen.directionRecheckPrompt', {
                motor: `M${selectedMotor}`,
              })}
            </Text>
          ) : null}
          <View style={styles.answerRow}>
            <Pressable
              onPress={() => onAnswer(selectedMotor, true)}
              accessibilityRole="button"
              style={[styles.answerButton, styles.answerYes]}
              testID="motor-direction-answer-yes"
            >
              <Text style={styles.answerYesText}>
                {t('motorsScreen.directionAnswerYes')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onAnswer(selectedMotor, false)}
              accessibilityRole="button"
              style={[styles.answerButton, styles.answerNo]}
              testID="motor-direction-answer-no"
            >
              <Text style={styles.answerNoText}>
                {t('motorsScreen.directionAnswerNo')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {gap: spacing.sm},
  distinctionNote: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  ackText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'rtl',
    flexShrink: 1,
    maxWidth: PROSE_MEASURE,
  },
  ackRequired: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  statusBlock: {gap: spacing.xs},
  statusHeading: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  statusRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  statusChip: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  statusChipSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  statusChipMotor: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 13,
    lineHeight: 15,
  },
  statusChipState: {
    ...typography.caption,
    fontSize: 10,
    lineHeight: 13,
    writingDirection: 'rtl',
  },
  spinBlock: {gap: spacing.xs},
  questionBlock: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  questionText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  recheckNote: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  answerRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  answerButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  answerYes: {backgroundColor: colors.accentStrong},
  answerYesText: {...typography.label, color: colors.white, fontWeight: '700'},
  answerNo: {
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  answerNoText: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
  },
});
