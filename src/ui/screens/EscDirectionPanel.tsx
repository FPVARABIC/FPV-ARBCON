/**
 * ESC SPIN DIRECTION - A WRITE-ONLY SETTING, PRESENTED AS ONE.
 *
 * THE DEFECT THIS FILE NOW REFUSES TO REPEAT. The panel used to open with
 * NORMAL already selected. Nothing had read NORMAL from anywhere: the
 * audited firmware has no command that reports ESC spin direction at all -
 * `MSP2_SEND_DSHOT_COMMAND` carries commands outward and returns no
 * direction, the setting is saved inside the ESC rather than in flight
 * controller configuration, and a search of the pinned firmware's MSP
 * surface for a spin-direction read finds nothing. A preselected NORMAL was
 * therefore a default wearing the clothes of a reading, on a control whose
 * whole job is to change which way a propeller turns.
 *
 * THE THREE CONCEPTS, KEPT APART ON SCREEN:
 *   EXPECTED  - what an airframe reference says. Not shown here.
 *   COMMANDED - what THIS session asked the ESC to become, after an
 *               acknowledgement. Session memory, never a reading, and
 *               deliberately discarded when the selected output changes.
 *   OBSERVED  - what a person saw. Only the verification workflow collects
 *               it, and nothing here may stand in for it.
 *
 * WHAT AN ACKNOWLEDGEMENT MEANS. The flight controller accepted and
 * processed the request. It is not proof that the ESC applied it, that the
 * motor turns that way, or that anything was verified physically.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { DshotEscDirection } from '../../core';
import type { MotorTestEscDirectionOutcome } from '../../core/state/motorTestController';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../theme';

export interface EscDirectionPanelProps {
  readonly selectedMotor: number;
  readonly operator: MotorTestOperatorPort | undefined;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

function resultText(
  t: (key: string) => string,
  outcome: MotorTestEscDirectionOutcome,
): { text: string; danger: boolean } {
  switch (outcome.kind) {
    case 'ACKNOWLEDGED':
      return { text: t('escDirection.acknowledged'), danger: false };
    case 'UNCONFIRMED':
      return { text: t('escDirection.unconfirmed'), danger: true };
    case 'REJECTED':
      return {
        text:
          outcome.reason === 'UNSUPPORTED'
            ? t('escDirection.unsupported')
            : t('escDirection.rejected'),
        danger: true,
      };
  }
}

export function EscDirectionPanel({
  selectedMotor,
  operator,
  onDirtyChange,
}: EscDirectionPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  /**
   * UNDEFINED IS THE HONEST INITIAL STATE, and it is undefined rather than
   * a sentinel value so the type system refuses a silent default: there is
   * no readable current direction, so neither option may start selected.
   * The operator picks a COMMAND TARGET; nothing here reports a state.
   */
  const [direction, setDirection] = useState<DshotEscDirection | undefined>(
    undefined,
  );
  /** COMMANDED, and only after an acknowledgement. Session memory. */
  const [commanded, setCommanded] = useState<DshotEscDirection | undefined>(
    undefined,
  );
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { text: string; danger: boolean } | undefined
  >();
  const operationRef = useRef<object | undefined>(undefined);
  const selectedMotorRef = useRef(selectedMotor);
  selectedMotorRef.current = selectedMotor;
  const available = operator?.getSnapshot().activation.allowed === true;

  useEffect(() => {
    onDirtyChange?.(reviewing);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, reviewing]);

  // Direction is a per-output operation. Changing the selected output or
  // replacing the session invalidates every pending presentation result:
  // an acknowledgement for M1 must never be rendered under an M2 heading.
  useEffect(() => {
    operationRef.current = undefined;
    // Back to UNKNOWN, not back to a default. A target chosen for M1 is not
    // a statement about M2, and a command acknowledged for M1 is not one
    // either - both are discarded rather than carried across outputs.
    setDirection(undefined);
    setCommanded(undefined);
    setReviewing(false);
    setBusy(false);
    setResult(undefined);
  }, [operator, selectedMotor]);

  const apply = useCallback(async () => {
    if (
      !reviewing ||
      busy ||
      !available ||
      operator === undefined ||
      // No target, no command. The gate is here as well as on the button so
      // an undefined direction can never reach the encoder.
      direction === undefined
    ) {
      return;
    }
    const operation = {};
    operationRef.current = operation;
    const targetMotor = selectedMotor;
    setBusy(true);
    setResult(undefined);
    try {
      const outcome = await operator.setEscDirection(targetMotor, direction);
      if (
        operationRef.current !== operation ||
        selectedMotorRef.current !== targetMotor
      ) {
        return;
      }
      setResult(resultText(t, outcome));
      // COMMANDED is recorded ONLY on an acknowledgement, and it records
      // what was asked for - not what the ESC now is, which remains
      // unreadable, and not what the motor does, which needs human eyes.
      if (outcome.kind === 'ACKNOWLEDGED') {
        setCommanded(direction);
      }
      setReviewing(false);
    } catch {
      if (
        operationRef.current === operation &&
        selectedMotorRef.current === targetMotor
      ) {
        setResult({ text: t('escDirection.failed'), danger: true });
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = undefined;
        setBusy(false);
      }
    }
  }, [
    busy,
    direction,
    available,
    operator,
    reviewing,
    selectedMotor,
    t,
  ]);

  return (
    <View style={styles.root} testID="esc-direction-panel">
      <Text style={styles.eyebrow}>{t('escDirection.eyebrow')}</Text>
      <Text style={styles.title}>{t('escDirection.title')}</Text>
      <Text style={styles.caption}>{t('escDirection.subtitle')}</Text>
      <Text style={styles.warning}>{t('escDirection.physicalCaveat')}</Text>

      <Text style={styles.sectionTitle} testID="esc-direction-selected-motor">
        {t('escDirection.motor')}: {`M${selectedMotor}`}
      </Text>

      {/* THE CURRENT DIRECTION IS NOT AVAILABLE, and the panel says so
          before it offers anything. This block is unconditional: there is
          no firmware state that could ever fill it in. */}
      <View style={styles.unknownBlock} testID="esc-direction-current-unknown">
        <Text style={styles.sectionTitle}>
          {t('escDirection.currentUnknownTitle')}
        </Text>
        <Text style={styles.caption}>{t('escDirection.currentUnknown')}</Text>
      </View>

      <Text style={styles.sectionTitle}>{t('escDirection.target')}</Text>
      <View style={styles.optionRow}>
        {(['NORMAL', 'REVERSED'] as const).map(value => (
          <Pressable
            key={value}
            onPress={() => {
              if (!busy) {
                setDirection(value);
                setReviewing(false);
                setResult(undefined);
              }
            }}
            disabled={busy}
            accessibilityRole="radio"
            // Neither option is selected until the operator selects one.
            accessibilityState={{ selected: direction === value }}
            style={[
              styles.directionOption,
              direction === value && styles.optionSelected,
            ]}
            testID={`esc-direction-${value.toLowerCase()}`}
          >
            <Text style={styles.optionText}>
              {value === 'NORMAL'
                ? t('escDirection.normal')
                : t('escDirection.reversed')}
            </Text>
          </Pressable>
        ))}
      </View>

      {direction === undefined ? (
        <Text style={styles.caption} testID="esc-direction-no-target">
          {t('escDirection.targetNotSelected')}
        </Text>
      ) : null}

      {reviewing && direction !== undefined ? (
        <View style={styles.confirmation} testID="esc-direction-confirmation">
          <Text style={styles.sectionTitle}>
            {t('escDirection.confirmTitle', {
              motor: selectedMotor,
              direction:
                direction === 'NORMAL'
                  ? t('escDirection.normal')
                  : t('escDirection.reversed'),
            })}
          </Text>
          <Text style={styles.caption}>{t('escDirection.confirmBody')}</Text>
          <Pressable
            onPress={apply}
            disabled={busy}
            accessibilityRole="button"
            style={styles.dangerButton}
            testID="esc-direction-apply"
          >
            <Text style={styles.dangerButtonText}>
              {busy ? t('escDirection.sending') : t('escDirection.confirm')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => setReviewing(true)}
          disabled={!available || busy || direction === undefined}
          accessibilityRole="button"
          accessibilityState={{
            disabled: !available || busy || direction === undefined,
          }}
          style={[
            styles.primaryButton,
            (!available || busy || direction === undefined) &&
              styles.optionDisabled,
          ]}
          testID="esc-direction-review"
        >
          <Text style={styles.primaryButtonText}>
            {t('escDirection.review')}
          </Text>
        </Pressable>
      )}

      {/* COMMANDED, never "current". Rendered under its own heading so it
          cannot be read as a direction that was looked up. */}
      {commanded !== undefined ? (
        <View style={styles.commandedBlock} testID="esc-direction-commanded">
          <Text style={styles.sectionTitle}>
            {t('escDirection.commandedTitle')}
          </Text>
          <Text style={styles.caption}>
            {t('escDirection.commandedBody', {
              motor: selectedMotor,
              direction:
                commanded === 'NORMAL'
                  ? t('escDirection.normal')
                  : t('escDirection.reversed'),
            })}
          </Text>
        </View>
      ) : null}

      {!available ? (
        <Text style={styles.caption} testID="esc-direction-needs-observation">
          {t('escDirection.needsReadySession')}
        </Text>
      ) : null}
      {result !== undefined ? (
        <Text
          style={result.danger ? styles.resultDanger : styles.resultGood}
          testID="esc-direction-result"
        >
          {result.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
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
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  warning: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  sectionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    minWidth: 56,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
  },
  directionOption: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  optionDisabled: { opacity: 0.4 },
  optionText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  confirmation: {
    gap: spacing.sm,
    padding: spacing.md,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  unknownBlock: {
    gap: spacing.xs,
    padding: spacing.md,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  commandedBlock: {
    gap: spacing.xs,
    padding: spacing.md,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    padding: spacing.md,
  },
  primaryButtonText: {
    ...typography.body,
    color: colors.background,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  dangerButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.warning,
    padding: spacing.md,
  },
  dangerButtonText: {
    ...typography.body,
    color: colors.background,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  resultDanger: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  resultGood: {
    ...typography.body,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});
