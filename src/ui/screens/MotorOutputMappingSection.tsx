/**
 * FC OUTPUT MAPPING - READ FIRST, AND READ FROM THE FLIGHT CONTROLLER.
 *
 * WHY THIS IS A CORE SECTION NOW. Reading which output drives which motor
 * needed ten steps: open a session, enable control, select a motor, hold
 * for 800ms, release, observe, open a disclosure at the bottom of the
 * page, confirm - four times - and only then press "prepare". Every one of
 * those steps exists to support a WRITE. None of them is needed to LOOK,
 * and requiring them made a readable firmware fact feel unavailable.
 *
 * SO THE TWO OPERATIONS ARE SEPARATED HERE:
 *
 *   READ  needs a session and a quiet link. Nothing else. No observation,
 *         no verification, no airframe template.
 *   WRITE needs everything it always needed, unchanged, and is reached
 *         through the same panel and the same controller transaction as
 *         before - full-vector payload, stale-base detection, disarmed
 *         proof, EEPROM write and readback all still live in the
 *         controller, not here.
 *
 * WHAT IS DISPLAYED. `values[i]` is the resource driven by LOGICAL MOTOR
 * i+1, exactly as the flight controller reported it. A failed read shows a
 * failure. It is never replaced by identity, by a template, or by the
 * motor number itself - a silent identity fallback would be
 * indistinguishable from a genuinely unmodified aircraft.
 *
 * M IS NOT AN OUTPUT NAME. The rows relate two different things; they do
 * not rename one to the other.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorVerificationState } from '../../core/state/motorVerificationModel';
import type { MotorIdentificationCapability } from '../../core/state/motorIdentificationCapability';
import {
  motorConfigurationController,
  type MotorOutputOrderLoadOutcome,
} from '../../platforms/react-native/protocol';
import {
  MotorOutputReorderPanel,
  type MotorOutputOrderControllerPort,
} from './MotorOutputReorderPanel';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

export interface MotorOutputMappingSectionProps {
  readonly sessionId: string | undefined;
  /** Logical motors this aircraft has. Rows are drawn for these only. */
  readonly motorCount: number | undefined;
  readonly verification: MotorVerificationState;
  readonly capability: MotorIdentificationCapability;
  readonly onEndMotorTestSession: () => Promise<void>;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /**
   * Set when a motor command may currently be live. A configuration read
   * shares the link with the test lease, so it waits rather than competing.
   */
  readonly blockedReason?: string;
  /** Lifts the read vector so the identity section can name one output. */
  readonly onValuesChange?: (values: readonly number[] | undefined) => void;
  readonly controller?: MotorOutputOrderControllerPort & {
    loadOutputOrder(sessionId: string): Promise<MotorOutputOrderLoadOutcome>;
  };
}

type Phase = 'IDLE' | 'LOADING' | 'LOADED' | 'ERROR';

export function MotorOutputMappingSection({
  sessionId,
  motorCount,
  verification,
  capability,
  onEndMotorTestSession,
  onDirtyChange,
  blockedReason,
  onValuesChange,
  controller = motorConfigurationController,
}: MotorOutputMappingSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [values, setValues] = useState<readonly number[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [editOpen, setEditOpen] = useState(false);

  // A vector read from one session says nothing about the next one.
  useEffect(() => {
    setPhase('IDLE');
    setValues(undefined);
    setError(undefined);
    setEditOpen(false);
    onValuesChange?.(undefined);
    // onValuesChange is intentionally omitted: it is a fresh closure on
    // every parent render, and including it would re-run this reset and
    // wipe a good read on any unrelated parent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const load = useCallback(async () => {
    if (sessionId === undefined || phase === 'LOADING' || blockedReason) {
      return;
    }
    setPhase('LOADING');
    setError(undefined);
    try {
      const outcome = await controller.loadOutputOrder(sessionId);
      if (outcome.kind === 'LOADED') {
        setValues(outcome.values);
        onValuesChange?.(outcome.values);
        setPhase('LOADED');
        return;
      }
      // NO SILENT FALLBACK. An unread mapping stays unread.
      setValues(undefined);
      onValuesChange?.(undefined);
      setError(
        outcome.kind === 'REJECTED'
          ? t('motorOutputReorder.rejected')
          : outcome.kind === 'SESSION_ENDED'
          ? t('motorOutputReorder.sessionEnded')
          : t('motorOutputReorder.failed'),
      );
      setPhase('ERROR');
    } catch {
      setValues(undefined);
      onValuesChange?.(undefined);
      setError(t('motorOutputReorder.failed'));
      setPhase('ERROR');
    }
  }, [blockedReason, controller, onValuesChange, phase, sessionId, t]);

  /** Rows are drawn for LOGICAL motors, not for the whole vector. */
  const rowCount =
    values === undefined
      ? 0
      : Math.min(
          values.length,
          motorCount !== undefined && motorCount > 0 ? motorCount : values.length,
        );
  const tailPreserved = values !== undefined && values.length > rowCount;

  /** Usable, or explained - never a silent grey control. */
  const disabledReason: string | undefined =
    blockedReason ??
    (sessionId === undefined
      ? t('motorsScreen.mappingBlockedNoSession')
      : phase === 'LOADING'
        ? t('motorsScreen.mappingReading')
        : undefined);

  return (
    <View style={styles.card} testID="motor-output-mapping-section">
      <Text style={styles.eyebrow}>{t('motorsScreen.mappingEyebrow')}</Text>
      <Text style={styles.title}>{t('motorsScreen.mappingTitle')}</Text>
      <Text style={styles.caption}>{t('motorsScreen.mappingSubtitle')}</Text>

      {sessionId === undefined ? (
        <Text style={styles.caption} testID="motor-output-mapping-no-session">
          {t('motorsScreen.mappingNeedsSession')}
        </Text>
      ) : null}

      {/* MEASURED DEFECT (browser probe, no motor session): this control
          rendered aria-disabled with pointer-events:none and NO reason
          anywhere - the operator saw a grey button that could not be
          pressed and said nothing. Reading the firmware's output order
          needs only a real configuration session and a quiet link, so the
          one state that genuinely blocks it now says so on the control
          itself. No new capability, no fallback mapping, no write. */}
      {disabledReason !== undefined ? (
        <Text style={styles.caption} testID="motor-output-mapping-blocked">
          {disabledReason}
        </Text>
      ) : null}

      {phase === 'LOADED' && values !== undefined ? (
        <View style={styles.rows} testID="motor-output-mapping-rows">
          {Array.from({ length: rowCount }, (_, index) => (
            <View
              key={index}
              style={styles.row}
              testID={`motor-output-row-M${index + 1}`}
            >
              <Text style={styles.rowMotor}>{`M${index + 1}`}</Text>
              <Text style={styles.rowRelation}>
                {t('motorsScreen.mappingRelation')}
              </Text>
              <Text
                style={styles.rowResource}
                testID={`motor-output-row-M${index + 1}-value`}
              >
                {t('motorOutputReorder.resource', {
                  value: values[index] + 1,
                })}
              </Text>
            </View>
          ))}
          {tailPreserved ? (
            <Text style={styles.caption} testID="motor-output-mapping-tail">
              {t('motorsScreen.mappingTailNote', {
                total: values.length,
                shown: rowCount,
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {phase === 'ERROR' && error !== undefined ? (
        <Text style={styles.error} testID="motor-output-mapping-error">
          {error}
        </Text>
      ) : null}

      {phase === 'LOADING' ? (
        <Text style={styles.progress} testID="motor-output-mapping-loading">
          {t('motorsScreen.mappingLoading')}
        </Text>
      ) : null}

      <Pressable
        onPress={load}
        disabled={sessionId === undefined || phase === 'LOADING' || !!blockedReason}
        accessibilityRole="button"
        accessibilityState={{
          disabled: sessionId === undefined || phase === 'LOADING' || !!blockedReason,
        }}
        style={[
          styles.primaryButton,
          (sessionId === undefined || phase === 'LOADING' || !!blockedReason) &&
            styles.buttonDisabled,
        ]}
        testID="motor-output-mapping-read"
      >
        <Text style={styles.primaryButtonText}>
          {phase === 'LOADED'
            ? t('motorsScreen.mappingReread')
            : t('motorsScreen.mappingRead')}
        </Text>
      </Pressable>

      {/* THE EDIT ENTRY, in the core section rather than behind Advanced.
          It opens the SAME panel and therefore the same controller
          transaction; nothing about the write path moved. */}
      {capability.kind === 'SUPPORTED' && sessionId !== undefined ? (
        <Pressable
          onPress={() => setEditOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: editOpen }}
          style={styles.secondaryButton}
          testID="motor-output-edit"
        >
          <Text style={styles.secondaryButtonText}>
            {t('motorsScreen.mappingEdit')}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.caption} testID="motor-output-edit-unavailable">
          {t('motorsScreen.mappingEditUnavailable')}
        </Text>
      )}

      {editOpen && capability.kind === 'SUPPORTED' && sessionId !== undefined ? (
        <MotorOutputReorderPanel
          sessionId={sessionId}
          verification={verification}
          onEndMotorTestSession={onEndMotorTestSession}
          onDirtyChange={onDirtyChange}
          controller={controller}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  rows: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  rowMotor: {
    ...typography.mono,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  rowRelation: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  rowResource: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
  error: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  progress: {
    ...typography.body,
    color: colors.accentStrong,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  primaryButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  primaryButtonText: {
    ...typography.label,
    color: colors.accentText,
    writingDirection: 'rtl'},
  buttonDisabled: { backgroundColor: colors.surfaceAlt },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    ...typography.label,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
});
