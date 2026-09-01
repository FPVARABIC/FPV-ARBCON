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
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

export interface EscDirectionPanelProps {
  readonly selectedMotor: number;
  readonly operator: MotorTestOperatorPort | undefined;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /**
   * Raises the outcome of ONE command so the host can keep the session's
   * COMMANDED record. It reports what was ASKED FOR and how the flight
   * controller answered - never a physical claim, and never an
   * observation. UNCONFIRMED is reported as such rather than dropped: an
   * outcome nobody knows is exactly the one an operator must be told.
   */
  readonly onCommandOutcome?: (
    motorNumber: number,
    target: DshotEscDirection,
    status: 'ACKNOWLEDGED' | 'UNCONFIRMED' | 'REJECTED' | 'FAILED',
    message: string,
  ) => void;
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
  onCommandOutcome,
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
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      const message = resultText(t, outcome);
      setResult(message);
      // EVERY outcome is raised so the host can show a compact result
      // even after this panel collapses. Only the two that say something
      // about the request itself become COMMANDED evidence there - a
      // rejected command never happened, and the host does not record it.
      if (outcome.kind === 'ACKNOWLEDGED') {
        setCommanded(direction);
      }
      onCommandOutcome?.(targetMotor, direction, outcome.kind, message.text);
      setReviewing(false);
    } catch {
      if (
        operationRef.current === operation &&
        selectedMotorRef.current === targetMotor
      ) {
        const failure = t('escDirection.failed');
        setResult({ text: failure, danger: true });
        onCommandOutcome?.(targetMotor, direction, 'FAILED', failure);
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
    onCommandOutcome,
    operator,
    reviewing,
    selectedMotor,
    t,
  ]);

  return (
    <View style={styles.root} testID="esc-direction-panel">
      {/* THE CURRENT DIRECTION IS NOT AVAILABLE, and this says so before
          anything is offered. Unconditional: there is no firmware state
          that could ever fill it in. The heading is the CLAIM and stays
          visible; the sentence explaining why sits under the one details
          toggle below, with the protocol scope. The eyebrow, title and
          selected-motor line are gone because MotorDirectionSection
          already names all three above this panel. */}
      <Text style={styles.sectionTitle} testID="esc-direction-selected-motor">
        {t('escDirection.motor')}: {`M${selectedMotor}`}
      </Text>

      <View style={styles.unknownBlock} testID="esc-direction-current-unknown">
        <Text style={styles.sectionTitle}>
          {t('escDirection.currentUnknownTitle')}
        </Text>
        {/* KEPT VISIBLE. This sentence is the P1b-A claim itself - the
            flight controller offers no reading - not an elaboration of
            it, so it does not go behind a tap. Only the protocol-scope
            paragraph does. */}
        <Text style={styles.caption}>{t('escDirection.currentUnknown')}</Text>
      </View>

      {/* SAFETY, NOT EXPLANATION: Normal/Reverse is an ESC setting and not
          a measure of clockwise or anticlockwise, and the physical result
          also depends on wiring. That stays on screen. */}
      <Text style={styles.warning}>{t('escDirection.physicalCaveat')}</Text>

      <Pressable
        onPress={() => setDetailsOpen(open => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        accessibilityLabel={t('escDirection.title')}
        style={styles.detailsToggle}
        testID="esc-direction-details-toggle"
      >
        <Text style={styles.detailsToggleText}>
          {t('motorsScreen.detailsToggle')}
        </Text>
      </Pressable>
      {detailsOpen ? (
        <View style={styles.notesBlock} testID="esc-direction-details">
          <Text style={styles.caption}>{t('escDirection.title')}</Text>
          <Text style={styles.caption}>{t('escDirection.subtitle')}</Text>
        </View>
      ) : null}

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

      {/* COMMANDED lives in MotorDirectionSection now, beside EXPECTED and
          OBSERVED, so the three sources are read together and this panel
          stays what it is: the place a command is authored. `commanded`
          is still tracked here only to keep the panel truthful when it is
          mounted on its own. */}
      {commanded !== undefined ? (
        <Text style={styles.caption} testID="esc-direction-commanded">
          {t('escDirection.commandedBody', {
            motor: selectedMotor,
            direction:
              commanded === 'NORMAL'
                ? t('escDirection.normal')
                : t('escDirection.reversed'),
          })}
        </Text>
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
    writingDirection: 'rtl'},
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  warning: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  sectionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
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
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    paddingVertical: spacing.xs,
  },
  notesBlock: { gap: spacing.xs },
  detailsToggle: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  detailsToggleText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  primaryButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
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
    writingDirection: 'rtl'},
  dangerButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
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
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  resultDanger: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  resultGood: {
    ...typography.body,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
