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

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorIdentificationCapability } from '../../core/state/motorIdentificationCapability';
import {
  confirmedCount,
  expectedFor,
  findPositionConflicts,
  summarizeMotorIdentification,
  type MotorIdentificationStatus,
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
import {PROSE_MEASURE, colors, isDesktopTier, radii, spacing, typography} from '../theme';
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
  // the map beside the selected-motor facts - never a stretched phone
  // card. Asked through the shared predicate rather than by listing tier
  // names: a NEW desktop tier must not silently collapse this back to
  // one column, which is exactly what happened when desktopUltra was
  // added and this read `tier === 'desktop' || tier === 'desktopWide'`.
  const twoColumn = isDesktopTier(tier);

  const [notesOpen, setNotesOpen] = useState(false);

  const quadSupported = capability.kind === 'SUPPORTED';
  /**
   * A COUNT WAS READ AND IT IS NOT THE MODEL'S. This is the case where an
   * identify action would be a lie, so the call to action is withdrawn.
   * A merely UNKNOWN count is NOT this case: nothing has been read yet,
   * the protected control explains its own blocked state, and hiding it
   * there would remove the surface that does the explaining.
   */
  const identificationOutOfScope =
    capability.kind === 'UNSUPPORTED' &&
    capability.reason === 'MOTOR_COUNT_MISMATCH';

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

  /**
   * THE COMPACT ALL-MOTOR SUMMARY. One row per logical motor, carrying its
   * identification status in words - so the other motors stay present
   * conceptually without four full observation forms on screen. Selecting
   * a row is addressing and nothing more: it issues no command, mints no
   * receipt, and confirms nothing.
   */
  const summaryRows = useMemo(
    () =>
      quadSupported
        ? summarizeMotorIdentification(verification, slots)
        : // The model describes ONE airframe. Where it does not describe
          // this one, no motor is outstanding - none was ever in scope, and
          // showing four of six as "not confirmed" would read as work left
          // to do rather than as a capability that does not exist.
          slots.map(motorNumber => ({
            motorNumber,
            status: 'NOT_APPLICABLE' as const,
          })),
    [quadSupported, slots, verification],
  );

  const statusLabel = (
    motorNumber: number,
    status: MotorIdentificationStatus,
  ): string => {
    // "Being identified" is a PRESENTATION state, not an evidence state:
    // an attributable attempt exists for this motor and is awaiting an
    // answer. It survives a correction, because the receipt does.
    if (
      status === 'UNCONFIRMED' &&
      receipt !== undefined &&
      receipt.motorNumber === motorNumber
    ) {
      return t('motorsScreen.identityStatusPending');
    }
    return t(`motorsScreen.identityStatus.${status}`);
  };

  const selectionRow = (
    <View style={styles.slotRow} testID="motor-identification-summary">
      {summaryRows.map(row => (
        <Pressable
          key={row.motorNumber}
          onPress={() => onSelectSlot(row.motorNumber)}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedSlot === row.motorNumber }}
          accessibilityLabel={`${t('motorsScreen.motorAccessibleName', {
            number: row.motorNumber,
          })} — ${statusLabel(row.motorNumber, row.status)}`}
          style={[
            styles.slotCard,
            selectedSlot === row.motorNumber && styles.slotCardSelected,
          ]}
          testID={`motor-identity-M${row.motorNumber}`}
        >
          <Text style={styles.slotLabel}>{`M${row.motorNumber}`}</Text>
          <Text
            style={[
              styles.slotMark,
              row.status === 'CONFIRMED' && styles.slotMarkConfirmed,
            ]}
            testID={`motor-identification-summary-M${row.motorNumber}`}
          >
            {statusLabel(row.motorNumber, row.status)}
          </Text>
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
      {/* CONCISE TRUTH, ALWAYS VISIBLE. The full paragraph says the same
          thing at four times the height and now lives under the single
          details toggle below - the CLAIM is never disclosed, only its
          elaboration. */}
      <Text style={styles.caption} testID="motors-numbering-notice">
        {t('motorsScreen.numberingNoticeShort')}
      </Text>
      {quadSupported ? (
        <>
          {/* The "expected, not confirmed" statement stays visible: it is
              the claim the whole template rests on. The longer reference
              prose sits behind a toggle IN PLACE - progressive disclosure
              inside the core section, not a move into Advanced. */}
          <Text style={styles.referenceNotice} testID="motors-diagram-notice">
            {t('motorsScreen.diagramNotice')}
          </Text>
          {/* STAYS VISIBLE, in its short form. The CLAIM - these arrows are
              expected, not read from the aircraft - is never behind a tap.
              What moves is the paragraph explaining which MSP field does
              not exist, which is elaboration, not the claim. */}
          <Text
            style={styles.caption}
            testID="motors-diagram-direction-source"
          >
            {t('motorsScreen.diagramDirectionSourceShort')}
          </Text>
          {/* ONE disclosure for this section, not one per paragraph. */}
          <Pressable
            onPress={() => setNotesOpen(open => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: notesOpen }}
            accessibilityLabel={t('motorsScreen.diagramNotes')}
            style={styles.notesToggle}
            testID="motors-diagram-notes-toggle"
          >
            <Text style={styles.notesToggleText}>
              {t('motorsScreen.detailsToggle')}
            </Text>
          </Pressable>
          {notesOpen ? (
            <View style={styles.notesBlock} testID="motors-diagram-notes">
              <Text style={styles.caption} testID="motors-numbering-detail">
                {t('motorsScreen.numberingNotice')}
              </Text>
              <Text style={styles.caption} testID="motors-direction-detail">
                {t('motorsScreen.diagramDirectionSource')}
              </Text>
              <Text style={styles.caption} testID="motors-diagram-front-hint">
                {t('motorsScreen.diagramFrontHint')}
              </Text>
            </View>
          ) : null}
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

      {/* ONE INSTRUCTION, FOR THE STEP ACTUALLY IN FRONT OF THE OPERATOR.
          Listing all four steps meant three of them were always noise. The
          wording follows the same evidence state the wizard reads, so the
          instruction and the question can never describe different steps. */}
      {!identificationOutOfScope ? (
        <View style={styles.stepsBlock} testID="motor-identification-steps">
          <Text style={styles.stepsTitle}>
            {t('motorsScreen.identifyHeading')}
          </Text>
          <Text style={styles.step} testID="motor-identification-instruction">
            {t(
              receipt === undefined
                ? 'motorsScreen.identifyInstructionSelect'
                : 'motorsScreen.identifyInstructionObserve',
            )}
          </Text>
        </View>
      ) : null}

      {/* NO IDENTIFY CALL TO ACTION WHERE IDENTIFICATION CANNOT HAPPEN.
          A protected hold offered on an airframe this model does not
          describe is a control that looks actionable and is not. It is
          replaced by the capability statement, and by a pointer to what
          IS still available - the numbered workspace above. */}
      {identificationOutOfScope ? (
        <View
          style={styles.unsupported}
          testID="motor-identification-unavailable"
        >
          <Text style={styles.unsupportedTitle}>
            {t('motorsScreen.identifyUnavailableTitle')}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.identifyUnavailableBody', {
              motor: `M${selectedSlot}`,
            })}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.identifyUnavailableRemains')}
          </Text>
        </View>
      ) : (
        <View testID="motor-identification-start">{holdControl}</View>
      )}

      {/* EXACTLY ONE ACTIVE OBSERVATION FORM, and it belongs to the motor
          the RECEIPT names - never to whatever happens to be selected.
          That binding is the reason a pending answer cannot drift onto
          another motor, so when the two differ the screen says so out loud
          instead of letting the form look like it describes the selection. */}
      {quadSupported ? (
        <View
          style={styles.activeBlock}
          testID={
            receipt === undefined
              ? 'motor-identification-active'
              : `motor-identification-active-M${receipt.motorNumber}`
          }
        >
          {receipt !== undefined && receipt.motorNumber !== selectedSlot ? (
            <View
              style={styles.pendingBanner}
              testID="motor-identification-pending-elsewhere"
            >
              <Text style={styles.pendingText}>
                {t('motorsScreen.identifyPendingElsewhere', {
                  pending: `M${receipt.motorNumber}`,
                  selected: `M${selectedSlot}`,
                })}
              </Text>
              <Pressable
                onPress={() => onSelectSlot(receipt.motorNumber)}
                accessibilityRole="button"
                style={styles.secondaryButton}
                testID="motor-identification-go-pending"
              >
                <Text style={styles.secondaryButtonText}>
                  {t('motorsScreen.identifyGoToPending', {
                    motor: `M${receipt.motorNumber}`,
                  })}
                </Text>
              </Pressable>
            </View>
          ) : null}
          <MotorVerificationWizard
            receipt={receipt}
            state={verification}
            onConfirm={onConfirm}
            onMultipleMotorsReported={onMultipleMotorsReported}
          />
        </View>
      ) : (
        <View
          style={styles.unsupported}
          testID="motors-identification-unsupported"
        >
          <Text style={styles.unsupportedTitle}>
            {t('motorsScreen.identificationQuadOnlyTitle')}
          </Text>
          <Text style={styles.caption}>
            {identificationOutOfScope
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
    writingDirection: 'rtl'},
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  referenceNotice: {
    ...typography.caption,
    color: colors.warning,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    backgroundColor: colors.surfaceAlt, maxWidth: PROSE_MEASURE},
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
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  slotMarkConfirmed: { color: colors.success, fontWeight: '700' },
  notesToggle: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  notesToggleText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  notesBlock: { gap: spacing.xs },
  activeBlock: { gap: spacing.xs },
  pendingBanner: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  pendingText: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
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
    flexShrink: 1, maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
  mismatch: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
  conflictBody: {
    ...typography.caption,
    color: colors.textPrimary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  stepsBlock: { gap: 2 },
  stepsTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
  step: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
