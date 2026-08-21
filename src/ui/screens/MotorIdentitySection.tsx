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

/**
 * THE MINI AIRCRAFT'S STAGE WIDTH.
 *
 * Deliberately smaller than any window-derived size, because this copy is
 * a CONTEXT MARKER standing next to the questions, not the picking
 * surface. It is not below the audited minimum, and it changes no touch
 * semantics: every motor node inside the diagram carries its own hard
 * 44x44 minimum, independent of the stage.
 */
const MINI_AIRFRAME_STAGE_WIDTH = 176;

/**
 * How wide this card must be before the context and the questions may sit
 * beside each other: the mini stage, the gap, and a question column wide
 * enough for the location buttons to stay on two rows.
 */
const VERIFY_SIDE_BY_SIDE_MIN_WIDTH = 560;

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
  /**
   * SIDE BY SIDE ONLY WHERE BOTH HALVES STILL FIT.
   *
   * THE WINDOW TIER ALONE IS NOT THE ANSWER. This section sits inside the
   * airframe column of the Motors workspace, which is roughly 46% of the
   * window on a desktop - so a 1920 window can still hand this card less
   * than 900px, and a 1366 window less than 600. The section therefore
   * asks how wide IT is; the tier only answers until the first layout
   * pass has happened.
   *
   * VERIFY_SIDE_BY_SIDE_MIN_WIDTH is the width at which the mini
   * aircraft, the compact facts beneath it and the question column each
   * still clear their own minimum. Below it they stack, which is the
   * phone case and is not a degradation: stacked still puts the aircraft
   * DIRECTLY above the first question.
   */
  const [sectionWidth, setSectionWidth] = useState(0);
  const verifySideBySide =
    sectionWidth > 0
      ? sectionWidth >= VERIFY_SIDE_BY_SIDE_MIN_WIDTH
      : isDesktopTier(tier);

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
  /* Same observation, same gate. An OBSERVED record carries BOTH, so a
     confirmed direction cannot exist without a confirmed position and
     neither can be back-filled from the template. */
  const confirmedDirection =
    entry?.observation?.kind === 'OBSERVED'
      ? entry.observation.direction
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

  /**
   * THE COMPACT MOTOR CONTEXT - four short chips, not a card of rows.
   *
   * It answers, in the order a person asks it while standing over the
   * aircraft: which motor am I addressing, where does the TEMPLATE say it
   * should be, which way does the TEMPLATE say it should turn, where did
   * I actually confirm it, and which flight-controller output drives it.
   *
   * EVERY EXPECTATION CARRIES ITS BADGE. The two template chips say
   * "expected" in words on the chip itself, and the confirmed chips say
   * "unconfirmed" until an observation has been recorded. Nothing here
   * can present a reference value as an observation, which is the whole
   * reason this block is not a table of bare values.
   */
  const chip = (
    label: string,
    value: string,
    badge: {label: string; tone: 'expected' | 'read' | 'confirmed' | 'unknown'} | undefined,
    testID: string,
    badgeTestID?: string,
    strong = false,
  ): React.JSX.Element => (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <View style={styles.chipValueGroup}>
        <Text
          style={strong ? styles.chipValueStrong : styles.chipValue}
          testID={testID}
        >
          {value}
        </Text>
        {badge !== undefined ? (
          <TruthBadge
            label={badge.label}
            tone={badge.tone}
            testID={badgeTestID}
          />
        ) : null}
      </View>
    </View>
  );

  const facts = (
    <View style={styles.factsBlock} testID="motor-identity-selected">
      {chip(
        t('motorsScreen.identityNumber'),
        `M${selectedSlot}`,
        undefined,
        'motor-identity-number',
        undefined,
        true,
      )}

      {/* EXPECTED - and only where a template legitimately applies. */}
      {quadSupported ? (
        <>
          {chip(
            t('motorsScreen.identityExpectedPosition'),
            expected === undefined
              ? '—'
              : t(`motorVerification.position.${expected.position}`),
            {label: t('motorsScreen.truthExpected'), tone: 'expected'},
            'motor-identity-expected',
          )}
          {/* THE EXPECTED SPIN DIRECTION, STATED AS AN EXPECTATION.
              It used to appear only as an arrow on the diagram, where an
              arrow beside a lit motor reads like a reading. Here it is a
              word, next to the badge that says the word is a reference. */}
          {chip(
            t('motorsScreen.identityExpectedDirection'),
            expected === undefined
              ? '—'
              : t(`motorVerification.direction.${expected.direction}`),
            {label: t('motorsScreen.truthExpected'), tone: 'expected'},
            'motor-identity-expected-direction',
            'motor-identity-expected-direction-badge',
          )}
        </>
      ) : (
        <Text
          style={styles.caption}
          testID="motors-selected-expected-unavailable"
        >
          {t('motorsScreen.selectedMotorExpectedUnavailable')}
        </Text>
      )}

      {/* CONFIRMED - the only position truth, and absent until earned. */}
      {chip(
        t('motorsScreen.identityConfirmedPosition'),
        confirmedPosition === undefined
          ? t('motorsScreen.identityUnconfirmed')
          : t(`motorVerification.position.${confirmedPosition}`),
        {
          label:
            confirmedPosition === undefined
              ? t('motorsScreen.truthUnconfirmed')
              : t('motorsScreen.truthConfirmed'),
          tone: confirmedPosition === undefined ? 'unknown' : 'confirmed',
        },
        'motor-identity-confirmed',
        'motor-identity-confirmed-badge',
      )}

      {/* THE OBSERVED SPIN DIRECTION. Read from the SAME observation as
          the confirmed position, so it can never be filled in from the
          template while the position is still unconfirmed. */}
      {chip(
        t('motorsScreen.identityConfirmedDirection'),
        confirmedDirection === undefined
          ? t('motorsScreen.identityUnconfirmed')
          : t(`motorVerification.direction.${confirmedDirection}`),
        {
          label:
            confirmedDirection === undefined
              ? t('motorsScreen.truthUnconfirmed')
              : t('motorsScreen.truthConfirmed'),
          tone: confirmedDirection === undefined ? 'unknown' : 'confirmed',
        },
        'motor-identity-confirmed-direction',
        'motor-identity-confirmed-direction-badge',
      )}

      {/* FC OUTPUT - firmware truth or nothing. */}
      {chip(
        t('motorsScreen.identityOutput'),
        selectedOutput === undefined
          ? t('motorsScreen.identityOutputUnavailable')
          : t('motorOutputReorder.resource', { value: selectedOutput + 1 }),
        selectedOutput === undefined
          ? undefined
          : {label: t('motorsScreen.truthRead'), tone: 'read'},
        'motor-identity-output',
      )}

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

  /** The context marker: the same aircraft, small, beside the questions. */
  const verifyMiniAircraft =
    active && quadSupported ? (
      <View style={styles.miniStage} testID="motor-verification-mini-diagram">
        <MotorAirframeDiagram
          entries={airframeEntries}
          selectedSlot={selectedSlot}
          liveSlot={liveSlot}
          liveActivity={liveActivity}
          verifiedSlots={verifiedSlots}
          onSelectSlot={onSelectSlot}
          motorCount={diagramMotorCount}
          stageWidthOverride={MINI_AIRFRAME_STAGE_WIDTH}
          compact
        />
      </View>
    ) : null;

  /**
   * WHAT COMES BEFORE THE QUESTIONS: which step this is, and the control
   * that produces something to answer about. Extracted so the narrow
   * layout can put it ABOVE the aircraft context and the wide layout can
   * put it beside it, without either copy of the tree differing in
   * behaviour.
   */
  const verifyPrelude = (
    <>
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
    </>
  );

  /**
   * EXACTLY ONE ACTIVE OBSERVATION FORM, and it belongs to the motor the
   * RECEIPT names - never to whatever happens to be selected. That binding
   * is the reason a pending answer cannot drift onto another motor, so
   * when the two differ the screen says so out loud instead of letting the
   * form look like it describes the selection.
   */
  const verifyQuestions = quadSupported ? (
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
    <View style={styles.unsupported} testID="motors-identification-unsupported">
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
  );

  return (
    <View
      style={styles.card}
      testID="motors-identity-section"
      onLayout={event => setSectionWidth(event.nativeEvent.layout.width)}
    >
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

      {map}

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

      {/* ================================================================
          THE VERIFICATION AREA, WITH THE AIRCRAFT STILL IN IT.

          THE DEFECT THIS CLOSES, reported from a real bench. A person taps
          M2 on the diagram, holds to spin it, then scrolls down to answer
          "where is it?" and "which way did it turn?" - and by the time
          they arrive the diagram is off screen. They are being asked a
          question about a picture they can no longer see, and the only
          thing still holding "M2" is their memory. MEASURED before this
          change, with M2 addressed and a receipt outstanding: at 390, 768
          and 1366 no airframe drawing of any kind shared the viewport with
          the location question.

          So the aircraft travels WITH the questions. Not the full diagram
          twice - a compact one, the selected motor lit, next to the short
          facts that name it.

          THE TWO ORDERS ARE DIFFERENT ON PURPOSE.

            wide    [ mini aircraft + facts ] | [ instruction, hold,
                                                 questions ]
                    the context sits beside the questions and stays put
                    while they are answered.

            narrow  instruction -> hold -> mini aircraft -> facts ->
                    questions
                    stacked, the context has to be the LAST thing before
                    the first question or the scroll puts it off screen
                    again. Putting the hold control above it is what makes
                    that possible: it is pressed BEFORE the questions
                    exist, so it does not need to be next to them.

          The mini diagram is a real selector, not a picture: changing
          motor mid-workflow no longer means scrolling back up. It carries
          the same expected/confirmed marks as the full one, so nothing
          here can present a template expectation as an observation. */}
      <View
        style={[styles.verifyArea, verifySideBySide && styles.verifyAreaWide]}
        testID="motor-verification-area"
      >
        {verifySideBySide ? null : verifyPrelude}

        <View
          style={[
            styles.verifyContext,
            verifySideBySide && styles.verifyContextWide,
          ]}
          testID="motor-verification-context"
        >
          {/* THE AIRCRAFT IS THE LAST THING BEFORE THE FIRST QUESTION.
              Stacked, whatever sits between the drawing and the question
              is exactly how far off screen the drawing goes - so the short
              facts go ABOVE it and the drawing goes directly against the
              questions. Side by side the pair is a block and reads better
              drawing-first. MEASURED at 390: facts-then-drawing puts the
              aircraft in the viewport with the question; drawing-then-
              facts does not. */}
          {verifySideBySide ? verifyMiniAircraft : facts}
          {verifySideBySide ? facts : verifyMiniAircraft}
        </View>

        <View
          style={[
            styles.verifyControls,
            verifySideBySide && styles.verifyControlsWide,
          ]}
          testID="motor-verification-controls"
        >
          {verifySideBySide ? verifyPrelude : null}
          {verifyQuestions}
        </View>
      </View>
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
  /* THE VERIFICATION AREA. One card region, two halves: the aircraft
     context and the questions about it. `alignItems: flex-start` in the
     wide case keeps the short context block from stretching to the
     height of the wizard. */
  verifyArea: { gap: spacing.sm },
  verifyAreaWide: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  verifyContext: { gap: spacing.xs },
  verifyContextWide: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: MINI_AIRFRAME_STAGE_WIDTH + spacing.md,
  },
  verifyControls: { gap: spacing.sm },
  verifyControlsWide: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  /* The mini stage is centred in its own column so the aircraft reads as
     a drawing rather than as a left-aligned block of shapes. */
  miniStage: { alignItems: 'center' },
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
  /* NOT A CARD ANY MORE. The selected-motor facts used to be a bordered
     panel with `space-between` rows, which in a 190px context column put
     the label and its value at opposite ends of a line too short to hold
     both. They are chips now: no outer border, a thin rule between them,
     and the label sits directly above its own value. */
  factsBlock: { gap: 2 },
  /* ONE LINE PER FACT WHERE IT FITS. Label, value and provenance badge
     on the same row, wrapping only when the column is genuinely too
     narrow to hold them - which is how five facts occupy roughly one
     fact's worth of the height a bordered row-per-line card needed. */
  chip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  chipLabel: {
    ...typography.caption,
    fontSize: 11,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  chipValueGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  chipValue: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
    maxWidth: PROSE_MEASURE,
  },
  chipValueStrong: {
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
