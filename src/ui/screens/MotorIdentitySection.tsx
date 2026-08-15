/**
 * MOTOR IDENTITY - THE CORE WORKFLOW, NOT AN ADVANCED ONE.
 *
 * WHAT THIS ANSWERS, WITHOUT OPENING A DISCLOSURE. Which motor am I
 * addressing? Where did I physically observe it? Which flight controller
 * output drives it? What has actually been confirmed?
 *
 * FOUR KINDS OF STATEMENT, KEPT APART BY CONSTRUCTION. The screen used to
 * put a template expectation and an operator observation in the same
 * sentence, which is how "the app says M2 is front-right" becomes
 * something a person believes about their aircraft.
 *
 *   LOGICAL NUMBER    M1..MN. What `pulseMotor` and the sliders address.
 *                     Carries no claim about where the motor sits.
 *   EXPECTED POSITION An airframe TEMPLATE. Shown only where the template
 *                     applies at all, and always marked as expectation.
 *   CONFIRMED POSITION What a person saw and then explicitly confirmed.
 *                     The only position truth in the system.
 *   FC OUTPUT         Read from the flight controller, or absent. Never
 *                     inferred from the logical number, and never from a
 *                     template.
 *
 * WHAT THIS COMPONENT CANNOT DO. It holds no controller, no session, no
 * transport and no timer; it cannot pulse, stop, reorder, write a mixer or
 * send a direction command. The protected hold control is passed in as a
 * node and remains the one command mechanism. Selection is inert by
 * design: tapping a motor on the map changes which motor is ADDRESSED and
 * nothing else.
 *
 * PULSE NEVER CONFIRMS POSITION. A receipt proves the flight controller
 * accepted and stopped a command. Which motor a person saw move is not in
 * it, cannot be derived from it, and is asked for explicitly below.
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorIdentificationCapability } from '../../core/state/motorIdentificationCapability';
import {
  confirmedCount,
  expectedFor,
  findPositionConflicts,
  type MotorObservation,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type { MotorTestVerificationReceipt } from '../../core/state/motorTestController';
import { MotorAirframeDiagram } from './MotorAirframeDiagram';
import type {
  MotorAirframeEntry,
  MotorSlotActivity,
} from './MotorAirframeDiagram';
import { MotorVerificationWizard } from './MotorVerificationWizard';
import { colors, radii, spacing, typography } from '../theme';
import { resolveLayoutTier } from '../theme/layout';

export interface MotorIdentitySectionProps {
  /** Logical motors this aircraft actually has, 1..N. Never a constant. */
  readonly slots: readonly number[];
  readonly selectedSlot: number;
  readonly onSelectSlot: (slot: number) => void;
  /** Whether the shipped Quad-X template may be applied at all. */
  readonly capability: MotorIdentificationCapability;
  readonly airframeEntries: readonly MotorAirframeEntry[];
  readonly diagramMotorCount: number;
  /** True once a session exists; the diagram does no work otherwise. */
  readonly active: boolean;
  readonly liveSlot?: number;
  readonly liveActivity?: MotorSlotActivity;
  readonly verification: MotorVerificationState;
  readonly receipt: MotorTestVerificationReceipt | undefined;
  readonly onConfirm: (
    receipt: MotorTestVerificationReceipt,
    observation: MotorObservation,
  ) => void;
  readonly onMultipleMotorsReported?: () => void;
  /** Withdraws ONE confirmed observation. Commands nothing. */
  readonly onClearObservation: (motorNumber: number) => void;
  /**
   * The flight-controller output vector, exactly as read. Undefined means
   * "not read", which is rendered as unavailable rather than as identity.
   */
  readonly outputOrder: readonly number[] | undefined;
  /** The protected hold control, owned by the screen. */
  readonly holdControl: React.ReactNode;
}

/** A restrained provenance mark. Text, never colour alone. */
function TruthBadge({
  label,
  tone,
  testID,
}: {
  readonly label: string;
  readonly tone: 'expected' | 'read' | 'confirmed' | 'unknown';
  readonly testID?: string;
}): React.JSX.Element {
  return (
    <View style={[styles.badge, badgeTone[tone]]} testID={testID}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function MotorIdentitySection({
  slots,
  selectedSlot,
  onSelectSlot,
  capability,
  airframeEntries,
  diagramMotorCount,
  active,
  liveSlot,
  liveActivity,
  verification,
  receipt,
  onConfirm,
  onMultipleMotorsReported,
  onClearObservation,
  outputOrder,
  holdControl,
}: MotorIdentitySectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const { width, fontScale } = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  // Two columns only where the extra width buys parallel information -
  // the map beside the selected-motor facts - never a stretched phone card.
  const twoColumn = tier === 'desktop' || tier === 'desktopWide';

  const quadSupported = capability.kind === 'SUPPORTED';

  const entry = verification.entries.find(e => e.motorNumber === selectedSlot);
  const confirmedPosition =
    entry?.observation?.kind === 'OBSERVED'
      ? entry.observation.position
      : undefined;
  const expected = quadSupported ? expectedFor(selectedSlot) : undefined;
  const mismatch =
    expected !== undefined &&
    confirmedPosition !== undefined &&
    confirmedPosition !== expected.position;

  const conflicts = useMemo(
    () => findPositionConflicts(verification),
    [verification],
  );

  /**
   * THE OUTPUT FOR THIS LOGICAL MOTOR, read from the flight controller.
   * `outputOrder[i]` is the resource driven by logical motor i+1, so the
   * lookup is by index and nothing else - not by template, not by
   * position, not by assuming identity.
   */
  const selectedOutput =
    outputOrder !== undefined && selectedSlot - 1 < outputOrder.length
      ? outputOrder[selectedSlot - 1]
      : undefined;

  const confirmed = confirmedCount(verification);
  const verifiedSlots = verification.entries
    .filter(e => e.observation !== undefined)
    .map(e => e.motorNumber);

  const selectionRow = (
    <View style={styles.slotRow} testID="motor-identity-slots">
      {slots.map(slot => (
        <Pressable
          key={slot}
          onPress={() => onSelectSlot(slot)}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedSlot === slot }}
          accessibilityLabel={t('motorsScreen.motorAccessibleName', {
            number: slot,
          })}
          style={[
            styles.slotCard,
            selectedSlot === slot && styles.slotCardSelected,
          ]}
          testID={`motor-identity-M${slot}`}
        >
          <Text style={styles.slotLabel}>{`M${slot}`}</Text>
          {verifiedSlots.includes(slot) ? (
            <Text style={styles.slotMark}>
              {t('motorsScreen.identityConfirmedShort')}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );

  const map = (
    /* testID kept from the bench card this block moved out of: the
       diagram's geometry contract is asserted through it. */
    <View style={styles.mapBlock} testID="motors-diagram">
      {active ? (
        <MotorAirframeDiagram
          entries={airframeEntries}
          selectedSlot={selectedSlot}
          liveSlot={liveSlot}
          liveActivity={liveActivity}
          verifiedSlots={verifiedSlots}
          onSelectSlot={onSelectSlot}
          motorCount={diagramMotorCount}
        />
      ) : null}
      {/* The numbered list is the only selector that is always correct,
          whatever the airframe, so it is present alongside the map rather
          than instead of it. */}
      {selectionRow}
      <Text style={styles.caption} testID="motors-numbering-notice">
        {t('motorsScreen.numberingNotice')}
      </Text>
      {quadSupported ? (
        <>
          <Text style={styles.caption} testID="motors-diagram-front-hint">
            {t('motorsScreen.diagramFrontHint')}
          </Text>
          <Text style={styles.referenceNotice} testID="motors-diagram-notice">
            {t('motorsScreen.diagramNotice')}
          </Text>
          <Text style={styles.caption} testID="motors-diagram-direction-source">
            {t('motorsScreen.diagramDirectionSource')}
          </Text>
        </>
      ) : null}
    </View>
  );

  const facts = (
    <View style={styles.factsBlock} testID="motor-identity-selected">
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>{t('motorsScreen.identityNumber')}</Text>
        <Text style={styles.factValueStrong} testID="motor-identity-number">
          {`M${selectedSlot}`}
        </Text>
      </View>

      {/* EXPECTED - and only where a template legitimately applies. */}
      {quadSupported ? (
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>
            {t('motorsScreen.identityExpectedPosition')}
          </Text>
          <View style={styles.factValueGroup}>
            <Text style={styles.factValue} testID="motor-identity-expected">
              {expected === undefined
                ? '—'
                : t(`motorVerification.position.${expected.position}`)}
            </Text>
            <TruthBadge
              label={t('motorsScreen.truthExpected')}
              tone="expected"
            />
          </View>
        </View>
      ) : (
        <Text
          style={styles.caption}
          testID="motors-selected-expected-unavailable"
        >
          {t('motorsScreen.selectedMotorExpectedUnavailable')}
        </Text>
      )}

      {/* CONFIRMED - the only position truth, and absent until earned. */}
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>
          {t('motorsScreen.identityConfirmedPosition')}
        </Text>
        <View style={styles.factValueGroup}>
          <Text style={styles.factValue} testID="motor-identity-confirmed">
            {confirmedPosition === undefined
              ? t('motorsScreen.identityUnconfirmed')
              : t(`motorVerification.position.${confirmedPosition}`)}
          </Text>
          <TruthBadge
            label={
              confirmedPosition === undefined
                ? t('motorsScreen.truthUnconfirmed')
                : t('motorsScreen.truthConfirmed')
            }
            tone={confirmedPosition === undefined ? 'unknown' : 'confirmed'}
            testID="motor-identity-confirmed-badge"
          />
        </View>
      </View>

      {/* FC OUTPUT - firmware truth or nothing. */}
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>{t('motorsScreen.identityOutput')}</Text>
        <View style={styles.factValueGroup}>
          <Text style={styles.factValue} testID="motor-identity-output">
            {selectedOutput === undefined
              ? t('motorsScreen.identityOutputUnavailable')
              : t('motorOutputReorder.resource', { value: selectedOutput + 1 })}
          </Text>
          {selectedOutput !== undefined ? (
            <TruthBadge label={t('motorsScreen.truthRead')} tone="read" />
          ) : null}
        </View>
      </View>

      {mismatch ? (
        <Text style={styles.mismatch} testID="motor-identity-mismatch">
          {t('motorsScreen.identityMismatch')}
        </Text>
      ) : null}

      {/* CORRECTION. Withdraws one observation and nothing else - no
          command, no mapping change, no mixer, no direction. */}
      {entry !== undefined && entry.outcome !== 'UNTESTED' ? (
        <Pressable
          onPress={() => onClearObservation(selectedSlot)}
          accessibilityRole="button"
          style={styles.secondaryButton}
          testID="motor-identity-clear"
        >
          <Text style={styles.secondaryButtonText}>
            {t('motorsScreen.identityClear')}
          </Text>
        </Pressable>
      ) : null}
      {entry !== undefined && entry.outcome !== 'UNTESTED' ? (
        <Text style={styles.caption} testID="motor-identity-clear-note">
          {t('motorsScreen.identityClearNote')}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.card} testID="motors-identity-section">
      <Text style={styles.eyebrow}>{t('motorsScreen.identityEyebrow')}</Text>
      <Text style={styles.title}>{t('motorsScreen.identityTitle')}</Text>

      {/* HONEST COUNTS ONLY. No percentages, no "system verified". */}
      <View style={styles.summaryRow} testID="motors-identity-summary">
        <Text style={styles.summaryItem} testID="motors-identity-summary-count">
          {t('motorsScreen.summaryMotors', { count: slots.length })}
        </Text>
        <Text
          style={styles.summaryItem}
          testID="motors-identity-summary-confirmed"
        >
          {quadSupported
            ? t('motorsScreen.summaryConfirmed', {
                done: confirmed,
                total: verification.entries.length,
              })
            : t('motorsScreen.summaryConfirmedUnavailable')}
        </Text>
        <Text
          style={styles.summaryItem}
          testID="motors-identity-summary-outputs"
        >
          {outputOrder === undefined
            ? t('motorsScreen.summaryOutputsUnread')
            : t('motorsScreen.summaryOutputsRead')}
        </Text>
      </View>

      <View style={twoColumn ? styles.columns : styles.stack}>
        <View style={twoColumn ? styles.column : undefined}>{map}</View>
        <View style={twoColumn ? styles.column : undefined}>{facts}</View>
      </View>

      {conflicts.length > 0 ? (
        <View style={styles.conflictBlock} testID="motor-identity-conflicts">
          <Text style={styles.conflictTitle}>
            {t('motorsScreen.identityConflictTitle')}
          </Text>
          {conflicts.map(conflict => (
            <Text
              key={conflict.position}
              style={styles.conflictBody}
              testID={`motor-identity-conflict-${conflict.position}`}
            >
              {t('motorsScreen.identityConflictBody', {
                position: t(`motorVerification.position.${conflict.position}`),
                motors: conflict.motorNumbers.map(n => `M${n}`).join('، '),
              })}
            </Text>
          ))}
        </View>
      ) : null}

      {/* THE IDENTIFICATION WORKFLOW, in the order a person performs it. */}
      <View style={styles.stepsBlock} testID="motor-identification-steps">
        <Text style={styles.stepsTitle}>
          {t('motorsScreen.identifyHeading')}
        </Text>
        {[1, 2, 3, 4].map(step => (
          <Text key={step} style={styles.step}>
            {t(`motorsScreen.identifyStep.${step}`)}
          </Text>
        ))}
      </View>

      <View testID="motor-identification-start">{holdControl}</View>

      {/* Only an operator observation may confirm a position, so the
          wizard is the ONLY writer of confirmed truth on this screen. */}
      {quadSupported ? (
        <MotorVerificationWizard
          receipt={receipt}
          state={verification}
          onConfirm={onConfirm}
          onMultipleMotorsReported={onMultipleMotorsReported}
        />
      ) : (
        <View
          style={styles.unsupported}
          testID="motors-identification-unsupported"
        >
          <Text style={styles.unsupportedTitle}>
            {t('motorsScreen.identificationQuadOnlyTitle')}
          </Text>
          <Text style={styles.caption}>
            {capability.kind === 'UNSUPPORTED' &&
            capability.reason === 'MOTOR_COUNT_MISMATCH'
              ? t('motorsScreen.identificationQuadOnlyBody', {
                  count: capability.motorCount,
                })
              : t('motorsScreen.identificationCountUnknownBody')}
          </Text>
        </View>
      )}
    </View>
  );
}

const badgeTone = StyleSheet.create({
  expected: { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  read: { borderColor: colors.info, backgroundColor: colors.surfaceRaised },
  confirmed: {
    borderColor: colors.success,
    backgroundColor: colors.surfaceRaised,
  },
  unknown: { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
});

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
  referenceNotice: {
    ...typography.caption,
    color: colors.warning,
    writingDirection: 'rtl',
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  summaryItem: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  stack: { gap: spacing.md },
  columns: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  column: { flex: 1, minWidth: 0 },
  mapBlock: { gap: spacing.xs },
  slotRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  slotCard: {
    minWidth: 64,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  slotCardSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  slotLabel: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  slotMark: {
    ...typography.caption,
    fontSize: 11,
    color: colors.success,
    writingDirection: 'rtl',
  },
  factsBlock: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  factLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  factValueGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  factValue: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
  },
  factValueStrong: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
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
    writingDirection: 'rtl',
  },
  conflictBlock: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  conflictTitle: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  conflictBody: {
    ...typography.caption,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  stepsBlock: { gap: 2 },
  stepsTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  step: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  unsupported: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  unsupportedTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});
