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
import {
  authoredAirframeLayout,
  stationOf,
} from '../../core/state/motorAirframeLayout';
import { MotorAirframeDiagram, stationKey } from './MotorAirframeDiagram';
import type {
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
  /** MSP_MIXER_CONFIG offset 0, raw, or undefined when unread. Decides
   *  whether an authored layout may be drawn at all. */
  readonly mixerModeRaw: number | undefined;
  /** The motor numbers the flight controller reported, 1..N. Empty when
   *  nothing has been read - never a placeholder quad. */
  readonly diagramMotorNumbers: readonly number[];
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
  /**
   * The protected hold control, owned by the screen.
   *
   * OPTIONAL SINCE M-E, AND USUALLY ABSENT. The identification action now
   * lives in the Motor Test workspace, beside the sliders that share its
   * command path, so this section renders the instruction and the
   * questions but no second copy of the button. Two hold controls on one
   * screen would only raise the question of which one is armed.
   */
  readonly holdControl?: React.ReactNode;
  /**
   * WHICH HALF OF THIS SECTION TO RENDER.
   *
   * M-E §11 / §44 split what used to be one card into the two different
   * jobs it was doing. 'MAP' is the aircraft an operator needs in the
   * FIRST VIEWPORT to pick a motor - the drawing, and the two lines that
   * name what is expected of the selected motor and what has actually
   * been observed about it. 'DETAIL' is the verification workflow: the
   * questions, the conflict report and the counts, which belong under the
   * technical details disclosure because they are a separate task.
   *
   * Both read the SAME selectedSlot and the same verification state -
   * this is a rendering split, not a second copy of anything.
   */
  readonly variant?: 'MAP' | 'DETAIL';
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
/**
 * THE TWO HALVES' REAL MINIMUMS, and the width at which both fit.
 *
 * `VERIFY_CONTEXT_MIN_WIDTH` is what the aircraft needs to still read as
 * a Quad X rather than as four circles in a strip.
 * `VERIFY_CONTROLS_MIN_WIDTH` is what the questions need to keep two
 * location buttons on a row.
 *
 * The threshold is their sum plus the gap between them, so the decision
 * is arithmetic on the space actually available rather than a viewport
 * breakpoint that cannot see this card's column at all. Below it the two
 * halves stack, at any viewport width.
 */
const VERIFY_CONTEXT_MIN_WIDTH = 240;
const VERIFY_CONTROLS_MIN_WIDTH = 320;
const VERIFY_SIDE_BY_SIDE_MIN_WIDTH =
  VERIFY_CONTEXT_MIN_WIDTH + VERIFY_CONTROLS_MIN_WIDTH + spacing.md;

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
  mixerModeRaw,
  diagramMotorNumbers,
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
  variant = 'DETAIL',
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
   * VERIFY_SIDE_BY_SIDE_MIN_WIDTH is the arithmetic sum of what the two
   * halves genuinely need plus the gap between them - not a viewport
   * breakpoint. A 1920 window can hand this card less than that, and when
   * it does the halves stack, which is the phone case and is not a
   * degradation: stacked still puts the aircraft directly above the
   * summary and the control that follows it.
   */
  const [sectionWidth, setSectionWidth] = useState(0);
  const verifySideBySide =
    sectionWidth > 0
      ? sectionWidth >= VERIFY_SIDE_BY_SIDE_MIN_WIDTH
      : isDesktopTier(tier);


  const [notesOpen, setNotesOpen] = useState(false);
  const quadSupported = capability.kind === 'SUPPORTED';
  /**
   * IS AN AIRCRAFT ACTUALLY BEING DRAWN?
   *
   * A DIFFERENT QUESTION FROM `quadSupported`, and M-E is the reason the
   * two had to separate. `quadSupported` asks whether the shipped Quad X
   * expectation describes this airframe - true for one mixer. This asks
   * whether there is a picture on screen with tappable motors on it -
   * true for seventeen. The numbered chip row is the selector exactly
   * when there is no picture to select from.
   */
  const drawnLayout = active
    ? authoredAirframeLayout(mixerModeRaw, diagramMotorNumbers)
    : undefined;
  const layoutDrawn = drawnLayout !== undefined;
  /**
   * THE AIRCRAFT WAS READ AND IT IS NOT THE MODEL'S AIRFRAME. This is the
   * case where an identify action would be a lie, so the call to action is
   * withdrawn. A merely UNREAD airframe or count is NOT this case: nothing
   * has been read yet, the protected control explains its own blocked
   * state, and hiding it there would remove the surface that does the
   * explaining.
   */
  const identificationOutOfScope =
    capability.kind === 'UNSUPPORTED' &&
    capability.reason === 'AIRFRAME_NOT_THE_MODEL';

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

  /**
   * THE SELECTOR - FOUR CHIPS, NOT FOUR CARDS.
   *
   * Every chip used to print its own status underneath: "M1 unconfirmed,
   * M2 unconfirmed, M3 unconfirmed, M4 unconfirmed", four times, directly
   * above a summary line that says the addressed motor is unconfirmed.
   * The status is still HERE - it is just no longer four copies of a word
   * the summary already carries.
   *
   * WHAT IS NOT LOST. Every state that SAYS something keeps its word:
   * confirmed, being identified now, answered without a position, not
   * applicable. Only the resting default - the one the summary line
   * beneath already states for the addressed motor - becomes a mark. And
   * every chip's accessibilityLabel still spells the full state out, so a
   * screen-reader user hears exactly what they heard before.
   */
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
          {/* The visible mark is carried only where it says something the
              summary does not: this output is already confirmed. The
              testID stays on the node that carries the state, so the
              existing status contracts still read it. */}
          <Text
            style={[
              styles.slotMark,
              row.status === 'CONFIRMED' && styles.slotMarkConfirmed,
            ]}
            testID={`motor-identification-summary-M${row.motorNumber}`}
          >
            {/* M-D §46: an unconfirmed slot shows NOTHING rather than a
                dash. The badge row's height is reserved either way, so
                the layout does not move - and an empty mark says "no
                result yet" without pretending to be a reading.
                NOT_APPLICABLE is blank for the same reason the rule at the
                top of this block already gives: it says nothing the block
                above does not. It is a property of the AIRFRAME, identical
                on every chip, so on an octo it printed the same sentence
                eight times under eight identical chips. The state itself
                is unchanged and is still spoken by the chip's
                accessibilityLabel. */}
            {(row.status === 'NOT_APPLICABLE' ||
              (row.status === 'UNCONFIRMED' &&
                !(
                  receipt !== undefined &&
                  receipt.motorNumber === row.motorNumber
                )))
              ? ''
              : statusLabel(row.motorNumber, row.status)}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  /**
   * THE AIRCRAFT, AND - WHERE THERE IS NO AIRCRAFT - THE NUMBERS.
   *
   * M-E §16: ONE SELECTOR PER AIRFRAME. The numbered chip row used to
   * render ABOVE the drawing on every airframe, so a Quad X operator was
   * offered four chips and four motor nodes that did exactly the same
   * thing, 140px apart. Where a layout is authored the drawing IS the
   * selector - each node is a real 44px target with a radio role - and
   * where none is, the chips are, unchanged. Never both.
   *
   * M-E §12: the four explanatory lines that used to stand between the
   * chips and the drawing are gone. They said, in our vocabulary, that
   * M-numbers are logical, that positions are expected rather than
   * measured, that rotation is not read, and offered a toggle to a
   * six-colour key. The drawing now states the one claim that matters in
   * its own caption, in one sentence, and the rest is in the technical
   * details section where an operator can go looking for it.
   */
  /**
   * THE REFERENCE CLAIMS, AND THE LONGER FORM BEHIND ONE TOGGLE.
   *
   * M-E §12 took these out of the FIRST VIEWPORT, where four explanatory
   * lines stood between the numbered chips and the drawing on a screen
   * whose job is to spin a motor. §44 is the other half of that
   * sentence: they are not deleted. Every claim is here, in the technical
   * details section, with the same short/long split it always had - the
   * CLAIM visible, its elaboration one press away.
   *
   * The one claim that never moved is the one an operator reads WHILE a
   * motor turns: that the positions are a reference from the mixer table
   * and that rotation is not read. That is the drawing's own caption, on
   * every airframe, with nothing opened.
   */
  const referenceNotes = (
    <View style={styles.notesArea} testID="motors-diagram-reference">
      <Text style={styles.caption} testID="motors-numbering-notice">
        {t('motorsScreen.numberingNoticeShort')}
      </Text>
      {quadSupported ? (
        <>
          <Text style={styles.referenceNotice} testID="motors-diagram-notice">
            {t('motorsScreen.diagramNotice')}
          </Text>
          <Text style={styles.caption} testID="motors-diagram-direction-source">
            {t('motorsScreen.diagramDirectionSourceShort')}
          </Text>
        </>
      ) : null}
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
    </View>
  );

  const map = (
    /* testID kept from the bench card this block moved out of: the
       diagram's geometry contract is asserted through it. */
    <View style={styles.mapBlock} testID="motors-diagram">
      {active ? (
        <MotorAirframeDiagram
          selectedSlot={selectedSlot}
          liveSlot={liveSlot}
          liveActivity={liveActivity}
          verifiedSlots={verifiedSlots}
          onSelectSlot={onSelectSlot}
          mixerModeRaw={mixerModeRaw}
          motorNumbers={diagramMotorNumbers}
        />
      ) : null}
      {/* M-E §16: ONE SELECTOR IN THE FIRST VIEWPORT. Where an aircraft
          is drawn, its nodes are the selector - each a 44px target with a
          radio role - so the numbered chips would be a second row asking
          the same question 140px below the first. Where nothing is drawn,
          the chips ARE the selector. Never both.
          The chips are unconditional in the DETAIL variant below: the
          verification workflow needs to move between motors while
          answering, and by then the drawing is in a different section of
          the page. */}
      {layoutDrawn ? null : selectionRow}
    </View>
  );

  /**
   * THE COMPACT MOTOR CONTEXT - two lines, not six rows.
   *
   * IT USED TO BE A LIST OF FACTS. Motor number, expected position,
   * expected direction, confirmed position, confirmed direction, output:
   * six labelled rows, each with its own label, value and badge, each on
   * its own line, for a total that dominated the space above the
   * questions. Every one of those facts is still here.
   *
   * THE SEMANTIC SPLIT IS UNTOUCHED, AND IT IS THE REASON FOR THE SHAPE.
   * Line one is the TEMPLATE: what a Quad X says M2 should be. Line two
   * is the OBSERVATION: what a person actually confirmed. They are two
   * different kinds of statement, so they are two different lines, each
   * carrying its own provenance badge - never merged, never inferred from
   * one another, and an em-dash where nothing has been observed rather
   * than a value borrowed from the row above.
   *
   * Screen readers get the long form: each line's accessibilityLabel
   * spells out "expected position ... expected direction ...", so the
   * compression is visual only.
   */
  /* M-D §46 - NO DASH SWEEP. These four were em dashes. A dash in a
     value slot reads as zero, or broken, or still loading, and is none
     of those: the expected pair is UNAVAILABLE for an airframe the
     Quad-X verification model does not describe, and the confirmed pair
     is simply NOT OBSERVED YET. Two different absences, now said. */
  const expectedPositionText =
    expected === undefined
      ? t('motorsScreen.valueNotAvailable')
      : t(`motorVerification.position.${expected.position}`);
  const expectedDirectionText =
    expected === undefined
      ? t('motorsScreen.valueNotAvailable')
      : t(`motorVerification.direction.${expected.direction}`);
  const confirmedPositionText =
    confirmedPosition === undefined
      ? t('motorsScreen.valueNotObserved')
      : t(`motorVerification.position.${confirmedPosition}`);
  const confirmedDirectionText =
    confirmedDirection === undefined
      ? t('motorsScreen.valueNotObserved')
      : t(`motorVerification.direction.${confirmedDirection}`);

  /**
   * THE ONE LINE THE MAP NEEDS - M-E §12.
   *
   * WHAT IT REPLACED, measured from a 390px screenshot of a hexacopter:
   * three lines under the drawing reading "M1 has no expected position
   * for this airframe", "actual: not observed yet - not observed yet"
   * with an "unconfirmed" badge, and "output: unavailable - not read
   * yet". Every one is true. Together they are our verification model
   * describing itself to somebody who wanted to spin a motor.
   *
   * WHERE THE POSITION COMES FROM NOW. The authored layout - the same
   * firmware mixer table the drawing beside it is placing motors from -
   * so a hexacopter reads "M1 - rear right" instead of "no expected
   * position". That is not a new claim: it is the claim the picture is
   * already making, in words, for the operator who wants it confirmed
   * and for the screen reader that cannot see the picture.
   *
   * The observation line appears only once there IS an observation. An
   * empty one said "not observed yet" on a screen where nothing had been
   * asked yet. The full six-fact form, the output line, the mismatch
   * notice and the correction control are all unchanged in the DETAIL
   * variant under technical details.
   */
  const drawnStation =
    drawnLayout?.placements.find(
      placement => placement.motorNumber === selectedSlot,
    );
  const mapFacts = (
    <View style={styles.mapFacts} testID="motor-identity-selected-brief">
      <Text style={styles.identityMotor} testID="motor-identity-number">
        {`M${selectedSlot}`}
      </Text>
      {drawnStation === undefined ? null : (
        <>
          <Text style={styles.identitySeparator}>·</Text>
          <Text style={styles.identityValue} testID="motor-identity-station">
            {t(`motorsScreen.${stationKey(stationOf(drawnStation))}`)}
          </Text>
        </>
      )}
      {confirmedPosition === undefined ? null : (
        <>
          <Text style={styles.identitySeparator}>·</Text>
          <Text style={styles.identityValue} testID="motor-identity-confirmed-brief">
            {confirmedPositionText}
          </Text>
          <TruthBadge
            label={t('motorsScreen.truthConfirmed')}
            tone="confirmed"
            testID="motor-identity-confirmed-brief-badge"
          />
        </>
      )}
    </View>
  );

  const facts = (
    <View style={styles.factsBlock} testID="motor-identity-selected">
      {/* LINE 1 - THE TEMPLATE. Marked "expected" on the line itself. */}
      {quadSupported ? (
        <View
          style={styles.identityLine}
          accessibilityLabel={`${t('motorsScreen.motorAccessibleName', {
            number: selectedSlot,
          })}. ${t('motorsScreen.identityExpectedPosition')}: ${
            expectedPositionText
          }. ${t('motorsScreen.identityExpectedDirection')}: ${
            expectedDirectionText
          }`}
        >
          <Text style={styles.identityMotor} testID="motor-identity-number">
            {`M${selectedSlot}`}
          </Text>
          <Text style={styles.identitySeparator}>·</Text>
          <Text style={styles.identityValue} testID="motor-identity-expected">
            {expectedPositionText}
          </Text>
          <Text style={styles.identitySeparator}>·</Text>
          <Text
            style={styles.identityValue}
            testID="motor-identity-expected-direction"
          >
            {expectedDirectionText}
          </Text>
          <TruthBadge
            label={t('motorsScreen.truthExpected')}
            tone="expected"
            testID="motor-identity-expected-direction-badge"
          />
        </View>
      ) : (
        <View style={styles.identityLine}>
          <Text style={styles.identityMotor} testID="motor-identity-number">
            {`M${selectedSlot}`}
          </Text>
          <Text
            style={styles.caption}
            testID="motors-selected-expected-unavailable"
          >
            {t('motorsScreen.selectedMotorExpectedUnavailable')}
          </Text>
        </View>
      )}

      {/* LINE 2 - THE OBSERVATION, and only what was actually observed. */}
      <View
        style={styles.identityLine}
        accessibilityLabel={`${t('motorsScreen.identityConfirmedPosition')}: ${
          confirmedPosition === undefined
            ? t('motorsScreen.identityUnconfirmed')
            : confirmedPositionText
        }. ${t('motorsScreen.identityConfirmedDirection')}: ${
          confirmedDirection === undefined
            ? t('motorsScreen.identityUnconfirmed')
            : confirmedDirectionText
        }`}
      >
        <Text style={styles.identityLabel}>
          {t('motorsScreen.identityActualLabel')}
        </Text>
        <Text style={styles.identityValue} testID="motor-identity-confirmed">
          {confirmedPositionText}
        </Text>
        <Text style={styles.identitySeparator}>·</Text>
        <Text
          style={styles.identityValue}
          testID="motor-identity-confirmed-direction"
        >
          {confirmedDirectionText}
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

      {/* THE FLIGHT-CONTROLLER OUTPUT, on the one line it needs. Read or
          absent - never inferred from the logical number. */}
      <Text style={styles.identityOutput} testID="motor-identity-output">
        {selectedOutput === undefined
          ? `${t('motorsScreen.identityOutput')}: ${t(
              'motorsScreen.identityOutputUnavailable',
            )}`
          : `${t('motorsScreen.identityOutput')}: ${t(
              'motorOutputReorder.resource',
              {value: selectedOutput + 1},
            )} · ${t('motorsScreen.truthRead')}`}
      </Text>

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
          accessibilityHint={t('motorsScreen.identityClearNote')}
          style={styles.secondaryButton}
          testID="motor-identity-clear"
        >
          <Text style={styles.secondaryButtonText}>
            {t('motorsScreen.identityClear')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

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
              // The count that was actually READ. It used to live in a
              // second card below this one, which said the same thing
              // twice; folding it in here keeps every fact and leaves one
              // block instead of two.
              count:
                capability.kind === 'UNSUPPORTED' &&
                capability.reason === 'AIRFRAME_NOT_THE_MODEL'
                  ? capability.motorCount
                  : slots.length,
            })}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.identifyUnavailableRemains')}
          </Text>
        </View>
      ) : holdControl === undefined ? null : (
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
  ) : identificationOutOfScope ? (
    /* SAID ONCE, NOT TWICE.
     *
     * MEASURED FROM A SCREENSHOT at 1366 on an unknown-mixer build: this
     * one column stated "identification does not apply to this airframe"
     * EIGHT times - a chip badge, a line beside the selected motor, three
     * per-chip marks, and two full cards whose titles and bodies said the
     * same thing one after the other. An operator on a hex or a V-tail met
     * a wall of apology where a hex or a V-tail should simply be a normal
     * aircraft with numbered motor control.
     *
     * The prelude above already renders the capability card - title, why,
     * and what remains available - exactly where the identify action would
     * have been, which is where the eye goes. The wizard's own copy of it
     * is the duplicate, so it is gone.
     *
     * THE OTHER unsupported reasons still land in the branch below: when
     * the airframe or the count has simply not been READ yet, the prelude
     * still shows the protected hold rather than a card, so this is the
     * only place that says anything. */
    null
  ) : (
    <View style={styles.unsupported} testID="motors-identification-unsupported">
      <Text style={styles.unsupportedTitle}>
        {t('motorsScreen.identificationQuadOnlyTitle')}
      </Text>
      <Text style={styles.caption}>
        {capability.kind === 'UNSUPPORTED' &&
        capability.reason === 'AIRFRAME_UNKNOWN'
          ? t('motorsScreen.identificationAirframeUnknownBody')
          : t('motorsScreen.identificationCountUnknownBody')}
      </Text>
    </View>
  );

  /**
   * THE MAP VARIANT - what the first viewport gets.
   *
   * No card chrome, no eyebrow, no heading, no counts: the aircraft, and
   * the two lines naming what is expected of the selected motor and what
   * has been observed about it. Measured before this split, the card
   * around these two blocks cost 1,880px on a 390px phone and put the
   * Motor Test controls a screen and a half below the fold.
   */
  if (variant === 'MAP') {
    return (
      <View style={styles.mapVariant} testID="motors-identity-map">
        {map}
        {mapFacts}
      </View>
    );
  }

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

          ONE ORDER, TWO SHAPES.

            wide    [ aircraft + summary ] | [ instruction, hold,
                                               questions ]
                    the context sits beside the questions and stays put
                    while they are answered.

            narrow  aircraft -> summary -> instruction -> hold ->
                    questions
                    the reading order of the actual job: see which motor,
                    read what is claimed about it, spin it, answer. The
                    previous round had to hoist the hold control above the
                    drawing to keep a SECOND, smaller drawing next to the
                    questions; compacting the questions removed both the
                    need and the duplicate.

          The mini diagram is a real selector, not a picture: changing
          motor mid-workflow no longer means scrolling back up. It carries
          the same expected/confirmed marks as the full one, so nothing
          here can present a template expectation as an observation. */}
      <View
        style={[styles.verifyArea, verifySideBySide && styles.verifyAreaWide]}
        testID="motor-verification-area"
      >
        <View
          style={[
            styles.verifyContext,
            verifySideBySide && styles.verifyContextWide,
          ]}
          testID="motor-verification-context"
        >
          {/* SUMMARY FIRST, THEN THE DRAWING, THEN THE ACTION.
              The two-line summary names what is addressed and what is
              only expected about it; the drawing shows where that motor
              sits; the protected hold comes straight after the drawing.
              Nothing wordy stands between the aircraft and the control
              that spins it - the selector and the reference notes are
              above the drawing, with the summary they belong to.

              ONE AIRCRAFT PER WORKFLOW. The round before last put a
              second, smaller copy next to the questions because the full
              one scrolled away. Compacting the questions removed the
              reason, and a duplicate only made the operator ask which of
              the two they were looking at. */}
          {/* THE AIRCRAFT IS NOT REPEATED HERE.
              It used to be, because the verification questions lived at
              the bottom of a 4,000px column and the drawing had scrolled
              away by the time an operator reached them. M-E moved the map
              into the first viewport and moved these questions under the
              technical details disclosure, so the two are no longer
              separated by the page - and a second aircraft would only
              raise the question of which one is being looked at.
              What IS here is the numbered row: this workflow's own
              selector, carrying each motor's evidence state, so an
              operator can move between motors without leaving it. */}
          {facts}
          {selectionRow}
          {referenceNotes}
        </View>

        <View
          style={[
            styles.verifyControls,
            verifySideBySide && styles.verifyControlsWide,
          ]}
          testID="motor-verification-controls"
        >
          {verifyPrelude}
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
  notesArea: {
    gap: 3,
  },
  mapFacts: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  mapVariant: {
    gap: spacing.xs,
  },
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
  /**
   * THE SUB-GRID, IN SHARES OF THE CARD - NOT IN A FIXED NUMBER.
   *
   * This basis used to be `MINI_AIRFRAME_STAGE_WIDTH + spacing.md`, a
   * literal 188px sized for the small second aircraft that the previous
   * round deleted. The full drawing then landed in it, was centred, and
   * spilled out of both sides across the verification controls. Measured
   * before this fix: 5-6 interactive controls intersecting the drawing at
   * 1280, 1366, 1440 and 1920.
   *
   * Shares, with real minimums on both halves, so neither can be squeezed
   * into a strip: the drawing keeps enough to read as a Quad X and the
   * question column keeps enough for two location buttons per row. If the
   * card cannot give both, `verifySideBySide` is false and they stack -
   * which is the primary hierarchy anyway.
   */
  verifyContextWide: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: '44%',
    minWidth: VERIFY_CONTEXT_MIN_WIDTH,
  },
  verifyControls: { gap: spacing.sm },
  verifyControlsWide: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '52%',
    minWidth: VERIFY_CONTROLS_MIN_WIDTH,
  },
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
  /* TWO LINES AND A CAPTION. No border, no fill, no per-row rule: this
     block sits inside the identification card and directly under the
     aircraft, and framing three lines was framing for its own sake. The
     six labelled rows it replaced are all still here - line one is the
     template, line two is the observation, and the caption is the
     flight-controller output. */
  factsBlock: { gap: spacing.xs },
  identityLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
  },
  identityMotor: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  identityLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  identitySeparator: {
    ...typography.caption,
    color: colors.textMuted,
  },
  identityValue: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1,
    maxWidth: PROSE_MEASURE,
  },
  identityOutput: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
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
