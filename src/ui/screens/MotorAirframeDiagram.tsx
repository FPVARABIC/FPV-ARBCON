/**
 * The airframe map for the Motors workspace.
 *
 * WHAT IT DRAWS, AND FOR WHICH AIRCRAFT. It asks
 * `authoredAirframeLayout(mixerModeRaw, motorNumbers)` where this
 * aircraft's motors sit. When this project has authored and checked a
 * layout for that mixer, it draws the frame with each motor in its place.
 * When it has not - a hex, a V-tail, an unread mixer - it draws a
 * NUMBERED LIST instead and says why. That is a correct answer, not a
 * degraded one: a picture of the wrong aircraft is worse than no picture.
 *
 * WHAT IT NEVER DRAWS: A ROTATION. There is no MSP field at API 1.47 that
 * reports which way a motor actually spins, and a mixer mode does not
 * determine it. Authored layouts therefore carry no direction field, this
 * component cannot be handed one, and the caption says so once in words.
 * The expected props-out reference still exists in the VERIFICATION
 * wizard, where comparing it against what a person actually saw is the
 * whole point - but the operational map, which an operator reads WHILE a
 * motor is turning, claims nothing about rotation.
 *
 * A view-only geometry layer: the slot handed to onSelectSlot is the same
 * number printed on the node, and no value here can reach a motor command
 * or relax a safety gate. Position is an EXPECTED reference transcribed
 * from the firmware mixer table, never a measurement from the aircraft -
 * an MSP acknowledgement proves reception, not rotation.
 *
 * SIZING. The stage used to be capped at 156px on every screen, which a
 * real operator reported as unreadable: not recognisably an X frame,
 * front unclear, M1-M4 unclear. It now scales with the viewport through
 * the shared layout tiers, and every internal dimension derives from the
 * stage size rather than being hard-coded, so the frame, the rotors and
 * the numbers grow together. MOTOR_AIRFRAME_STAGE_MIN_WIDTH keeps the
 * narrowest phone case at the previously-audited touch-target size.
 *
 * MEANING NEVER DEPENDS ON COLOUR: every state also carries an Arabic
 * text badge on the node itself and a matching legend entry.
 */

import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type {
  MotorPhysicalPosition,
  MotorRotationDirection,
} from '../../core/state/motorVerificationModel';
import { MOTOR_TEST_EXPECTED_CONFIGURATION } from '../../core/state/motorVerificationModel';
import {PROSE_MEASURE, colors, fonts, radii, spacing, typography} from '../theme';
import { Icon } from '../icons';
import { isRtlLayout } from '../icons/layoutDirection';
import { resolveLayoutTier } from '../theme/layout';
import { authoredAirframeLayout } from '../../core/state/motorAirframeLayout';

export interface MotorAirframeEntry {
  readonly slot: number;
  readonly position: MotorPhysicalPosition;
  /**
   * THERE IS NO DIRECTION FIELD, AND THAT IS THE POINT.
   *
   * There is no MSP field at API 1.47 that reports which way a motor
   * actually spins; auditing the pinned firmware again for M-D did not
   * turn one up. This interface used to carry an optional direction so a
   * caller without one could pass undefined and get an explicit unknown
   * mark - but every caller is now an authored layout, authored layouts
   * carry no direction (motorAirframeLayout.ts), and the "unknown mark"
   * had become a question mark under all four motors of every aircraft.
   *
   * Removing the field makes §25 STRUCTURAL rather than a matter of
   * caller discipline: this component cannot be handed a rotation to
   * draw, so it cannot draw one. The expected props-out reference still
   * exists in the verification wizard, where comparing it against what a
   * human actually saw is the entire purpose.
   */
}

/**
 * What the diagram may say about one output right now. SUBMITTED /
 * ACKNOWLEDGED / STOPPING mirror the controller's own published pulse
 * record. UNSAFE means the app cannot describe the output truthfully (a
 * fault, or a stop it could not confirm).
 */
export type MotorSlotActivity =
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'STOPPING'
  | 'UNSAFE';

export interface MotorAirframeDiagramProps {
  readonly selectedSlot: number;
  readonly liveSlot?: number;
  /** The controller's current verdict for `liveSlot`. */
  readonly liveActivity?: MotorSlotActivity;
  readonly verifiedSlots?: readonly number[];
  readonly onSelectSlot: (slot: number) => void;
  /**
   * MSP_MIXER_CONFIG offset 0, raw - WHICH AIRFRAME THIS IS.
   *
   * PART Q found that this file drew its one Quad X aircraft for every
   * build, so a hex or octo was shown four motors with M1-M4 on positions
   * the frame does not have. That was answered by gating on the motor
   * COUNT, which fixed the hex and left a subtler version behind: four
   * motors is not four corners. QUADP, Y4, VTAIL4 and ATAIL4 all report
   * four and are not X frames, and QUADX_1234 is an X whose motor 1 sits
   * where the Quad X drawing puts motor 4.
   *
   * The airframe is therefore asked for directly. `undefined` means the
   * mixer has not been read, and an unread mixer is drawn as a numbered
   * list - see motorAirframeLayout.ts for which mixers have artwork.
   */
  readonly mixerModeRaw: number | undefined;
  /**
   * The motor numbers the flight controller actually reported, 1..N.
   *
   * REQUIRED, AND WITH NO DEFAULT ON PURPOSE. This prop replaced
   * `motorCount?: number`, whose default value was four - so a caller that
   * simply had not read the count yet got a four-motor aircraft rather
   * than an error or an empty state. An empty array here means "nothing
   * has been read", and renders as nothing.
   */
  readonly motorNumbers: readonly number[];
  /**
   * Force a stage size instead of deriving one from the window.
   *
   * PRESENTATION ONLY - it changes no geometry, no slot order, no
   * numbering and no touch semantics; every arm angle and every label is
   * computed from `scale = stageWidth / 260` exactly as before. It exists
   * because this diagram is now rendered TWICE on the same screen: full
   * size where the operator picks a motor, and small again beside the
   * identification questions so the aircraft is still on screen while
   * they are answering them. A window-derived size cannot express "the
   * small one".
   */
  readonly stageWidthOverride?: number;
  /**
   * THE SECOND COPY, BESIDE THE QUESTIONS. Drops the title, the caption
   * and the six-item legend - every one of which is already on screen,
   * unchanged, on the full-size diagram this one accompanies. What it
   * KEEPS is everything that carries information about THIS aircraft: the
   * FRONT marker, the frame, and the four selectable nodes with their
   * M-numbers, direction tokens and state badges.
   *
   * PRESENTATION ONLY, like stageWidthOverride. No slot, number, order,
   * selection or touch semantic differs between the two copies.
   */
  readonly compact?: boolean;
}

/**
 * The smallest stage, kept from the previously-audited phone layout so a
 * narrow device still gets real 44dp touch targets.
 */
export const MOTOR_AIRFRAME_STAGE_MIN_WIDTH = 156;
/** Back-compatible alias for the historical constant name. */
export const MOTOR_AIRFRAME_STAGE_MAX_WIDTH = MOTOR_AIRFRAME_STAGE_MIN_WIDTH;
export const MOTOR_AIRFRAME_STAGE_ASPECT_RATIO = 1;

/**
 * How wide the stage may be for a given viewport. A Quad X only reads as
 * a Quad X when the arms are long enough to separate the rotors, so the
 * desktop tiers get a genuinely large diagram rather than a phone glyph
 * centred in a monitor.
 */
export function computeAirframeStageWidth(
  windowWidth: number,
  fontScale = 1,
): number {
  const tier = resolveLayoutTier(windowWidth, fontScale);
  const byTier =
    /* desktopUltra shares desktopWide's size on purpose. The diagram is
       a DIAGRAM, not a poster: past ~460px it stops carrying more
       information and starts being a large picture of four circles. The
       extra room on a very large monitor goes to the columns beside it,
       which is what the wider envelope is for. */
    tier === 'desktopUltra' || tier === 'desktopWide'
      ? 460
      : tier === 'desktop'
      ? 400
      : tier === 'wide'
      ? 330
      : tier === 'tablet'
      ? 280
      : 210;
  const available = Number.isFinite(windowWidth)
    ? Math.max(0, windowWidth - 48)
    : byTier;
  return Math.max(
    MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
    Math.min(byTier, Math.max(MOTOR_AIRFRAME_STAGE_MIN_WIDTH, available)),
  );
}

// Emission order is explicit and mirrors the accepted identity test: right
// first, left second. The row itself has an explicit RTL direction, so right
// remains on the physical right regardless of the host device's locale.
const VISUAL_POSITION_ORDER: readonly MotorPhysicalPosition[] = Object.freeze([
  'FRONT_RIGHT',
  'FRONT_LEFT',
  'REAR_RIGHT',
  'REAR_LEFT',
]);

export function orderAirframeEntries(
  entries: readonly MotorAirframeEntry[],
): readonly MotorAirframeEntry[] {
  return Object.freeze(
    VISUAL_POSITION_ORDER.map(position => {
      const entry = entries.find(candidate => candidate.position === position);
      if (entry === undefined) {
        throw new Error(`Missing motor reference for ${position}`);
      }
      return entry;
    }),
  );
}

export type MotorGlyphRow = 'FRONT' | 'REAR';
export type MotorGlyphSide = 'RIGHT' | 'LEFT';

export interface MotorGlyphCell {
  /** MSP output slot, 1..4 - the same number pulseMotor receives. */
  readonly slot: number;
  readonly row: MotorGlyphRow;
  readonly side: MotorGlyphSide;
  readonly positionKey: string;
  readonly directionKey: string;
}

const POSITION_GEOMETRY: Record<
  MotorPhysicalPosition,
  { row: MotorGlyphRow; side: MotorGlyphSide }
> = {
  FRONT_RIGHT: { row: 'FRONT', side: 'RIGHT' },
  FRONT_LEFT: { row: 'FRONT', side: 'LEFT' },
  REAR_RIGHT: { row: 'REAR', side: 'RIGHT' },
  REAR_LEFT: { row: 'REAR', side: 'LEFT' },
};

/**
 * The tested label geometry used by both the rendered diagram and the
 * payload-identity suite. It derives from the accepted configuration and
 * the same visual order as the component; there is no second slot mapping.
 */
export function computeMotorGlyphLayout(): readonly MotorGlyphCell[] {
  const entries = orderAirframeEntries(
    MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
      slot: entry.motorNumber,
      position: entry.position,
    })),
  );
  return Object.freeze(
    entries.map(entry => {
      const geometry = POSITION_GEOMETRY[entry.position];
      // The direction comes from the EXPECTED CONFIGURATION directly, not
      // through MotorAirframeEntry - the drawing's entry type carries no
      // direction at all (see §25 above), and this identity helper
      // describes the verification model rather than the drawing. Every
      // entry in that constant has one, so the lookup cannot miss.
      const expected = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
        candidate => candidate.motorNumber === entry.slot,
      );
      if (expected === undefined) {
        throw new Error(`No expected mapping for motor ${entry.slot}`);
      }
      return Object.freeze({
        slot: entry.slot,
        row: geometry.row,
        side: geometry.side,
        positionKey: positionKey(entry.position),
        directionKey: directionKey(expected.direction),
      });
    }),
  );
}

export function motorGlyphRows(): readonly (readonly MotorGlyphCell[])[] {
  const cells = computeMotorGlyphLayout();
  return Object.freeze([
    cells.filter(cell => cell.row === 'FRONT'),
    cells.filter(cell => cell.row === 'REAR'),
  ]);
}

function positionKey(position: MotorPhysicalPosition): string {
  switch (position) {
    case 'FRONT_LEFT':
      return 'positionFrontLeft';
    case 'FRONT_RIGHT':
      return 'positionFrontRight';
    case 'REAR_LEFT':
      return 'positionRearLeft';
    case 'REAR_RIGHT':
      return 'positionRearRight';
  }
}

function directionKey(direction: MotorRotationDirection): string {
  return direction === 'CW' ? 'directionCw' : 'directionCcw';
}

function activityLabelKey(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
      return 'motorsScreen.slotStateSubmitted';
    case 'ACKNOWLEDGED':
      return 'motorsScreen.slotStateAcknowledged';
    case 'STOPPING':
      return 'motorsScreen.slotStateStopping';
    case 'UNSAFE':
      return 'motorsScreen.slotStateUnsafe';
  }
}

function activityColor(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
    case 'ACKNOWLEDGED':
      return colors.warning;
    case 'STOPPING':
      return colors.info;
    case 'UNSAFE':
      return colors.error;
  }
}

function cellTestId(position: MotorPhysicalPosition): string {
  return `motors-diagram-cell-${position.replace('_', '-')}`;
}

/**
 * ONE motor: a disc with two blades and a hub. That is the whole glyph.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT LEFT. A rotation arrow sat on a ring
 * outside the disc, and where no direction was supplied a
 * `circle-question-mark` icon took its place. Since M-D no caller can
 * supply a direction at all - authored layouts carry motor number and
 * position, nothing else - so the question-mark branch was the ONLY
 * branch: four question marks orbiting every aircraft, on every airframe,
 * for ever. That is not a disclosure, it is decoration that reads as an
 * error state.
 *
 * The fact those marks stood for is now stated once, in words, in the
 * caption under the map: rotation direction is not reported by the flight
 * controller and is not shown here.
 *
 * The ring VIEW stays. It reserves the same box the arrow used to need, so
 * removing the arrow does not resize a node and re-open the measured
 * row-collision this drawing was tuned to avoid.
 */
function RotorGlyph({
  scale,
  active,
}: {
  scale: number;
  active: boolean;
}): React.JSX.Element {
  const size = Math.round(30 * scale);
  const bladeLength = Math.round(size * 0.86);
  const bladeThickness = Math.max(3, Math.round(size * 0.13));
  const hub = Math.max(6, Math.round(size * 0.26));
  /** The reserved ring. 1.55x the disc; see the note above on why it
   *  outlived the arrow it was sized for. */
  const ring = Math.round(size * 1.55);
  return (
    <View style={[styles.rotorRing, { width: ring, height: ring }]}>
      <View
        style={[
          styles.rotor,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: Math.max(1, Math.round(size * 0.06)),
          },
          active && styles.rotorActive,
        ]}
      >
        <View
          style={[
            styles.blade,
            { width: bladeLength, height: bladeThickness, transform: [{ rotate: '32deg' }] },
          ]}
        />
        <View
          style={[
            styles.blade,
            { width: bladeLength, height: bladeThickness, transform: [{ rotate: '-32deg' }] },
          ]}
        />
        <View
          style={[styles.hub, { width: hub, height: hub, borderRadius: hub / 2 }]}
        />
      </View>
    </View>
  );
}

function MotorNode({
  entry,
  selected,
  activity,
  verified,
  scale,
  onSelect,
}: {
  entry: MotorAirframeEntry;
  selected: boolean;
  activity: MotorSlotActivity | undefined;
  verified: boolean;
  scale: number;
  onSelect: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const slotFont = Math.max(14, Math.round(17 * scale));
  const tokenFont = Math.max(11, Math.round(12 * scale));
  const badge =
    activity !== undefined
      ? { text: t(activityLabelKey(activity)), color: activityColor(activity) }
      : verified
      ? { text: t('motorsScreen.slotStateObserved'), color: colors.success }
      : selected
      ? { text: t('motorsScreen.slotStateSelected'), color: colors.accentStrong }
      : undefined;
  return (
    <View style={styles.motorCell} testID={cellTestId(entry.position)}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        // The position IS spoken, even though it left the visible node: a
        // screen-reader user cannot see where the mark sits on the frame.
        // The position IS spoken. The ROTATION is not - not even as
        // "unknown". Nothing supplies one, so speaking its absence four
        // times per screen is noise, and the map's own caption says once
        // that rotation is not reported.
        accessibilityLabel={`${`M${entry.slot}`}، ${t(
          `motorsScreen.${positionKey(entry.position)}`,
        )}${badge !== undefined ? `، ${badge.text}` : ''}`}
        style={[
          styles.motorNode,
          { padding: Math.round(5 * scale) },
          selected && styles.motorNodeSelected,
          verified && styles.motorNodeVerified,
          activity !== undefined && {
            borderColor: activityColor(activity),
            borderWidth: 2,
          },
        ]}
        testID={`motors-airframe-slot-${entry.slot}`}
      >
        <RotorGlyph scale={scale} active={activity !== undefined} />
        {/* ONE label row, and now ONE thing in it: the M-number.
            The Arabic position phrase left this row earlier - it was the
            widest and tallest thing in the node and repeated what the
            node's own place on the frame already says, and it is still
            spoken by the accessibility label above.
            THE ROTATION TOKEN LEFT IT IN M-D. Authored layouts carry no
            direction (see motorAirframeLayout.ts), so the token had
            exactly one value left - a bare "؟" printed under every motor
            on every airframe. A question mark standing where a value
            belongs is not a disclosure, it is four pieces of furniture
            that say nothing. The claim it stood for is made once, in
            words, in the caption below the map. */}
        <View style={styles.labelRow}>
          <Text
            style={[styles.slot, { fontSize: slotFont, lineHeight: slotFont + 2 }]}
            testID={`motors-diagram-slot-${entry.slot}`}
          >
            {`M${entry.slot}`}
          </Text>
        </View>
        {/* A RESERVED badge row, always present.
            Measured before this pass: the selected node grew from 95px to
            124px at 390px because the badge appeared inside it, and the
            two rows then overlapped by 19.31px - an overlap that came and
            went as the operator selected different motors. A fixed slot
            makes every node the same height in every state. */}
        <View
          style={[
            styles.badgeSlot,
            { height: Math.max(16, Math.round(18 * scale)) },
          ]}
        >
          {badge !== undefined ? (
            <View
              style={[styles.stateBadge, { borderColor: badge.color }]}
              testID={`motors-diagram-state-${entry.slot}`}
            >
              <Text
                style={[
                  styles.stateBadgeText,
                  { color: badge.color, fontSize: tokenFont },
                ]}
                numberOfLines={1}
              >
                {badge.text}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/**
 * NOT A DEGRADED MODE, AND NOT A SECOND SELECTOR.
 *
 * WHERE THERE IS NO AUTHORED LAYOUT, THIS BLOCK SAYS SO. No aircraft, no
 * claimed positions, no rotation - and it names the reason rather than
 * leaving a silent gap. For every airframe this project has not authored
 * artwork for, saying so IS the right answer; a picture of the wrong
 * aircraft is worse than no picture.
 *
 * IT USED TO REPEAT THE MOTOR SELECTOR, AND THAT WAS THE DEFECT.
 * MEASURED FROM A 1366 SCREENSHOT on a three-motor build: the identity
 * section's chip row printed M1 M2 M3, and 140px below it this block
 * printed M1 M2 M3 again - six interactive chips for three motors, both
 * rows doing exactly the same thing. The identity section's selector is
 * unconditional and is deliberately "the only selector that is always
 * correct, whatever the airframe", so this one was the copy.
 *
 * The component therefore renders a MAP or an EXPLANATION, never a
 * selector. Selection belongs to the row above it, on every airframe.
 */
function GenericMotorOutputs(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <View style={styles.root} testID="motors-generic-outputs">
      <Text style={styles.diagramTitle}>
        {t('motorsScreen.layoutGenericHeading')}
      </Text>
      <Text style={styles.caption} testID="motors-generic-outputs-caption">
        {t('motorsScreen.layoutGenericCaption')}
      </Text>
    </View>
  );
}

export function MotorAirframeDiagram({
  selectedSlot,
  liveSlot,
  liveActivity,
  verifiedSlots = [],
  onSelectSlot,
  stageWidthOverride,
  compact = false,
  mixerModeRaw,
  motorNumbers,
}: MotorAirframeDiagramProps): React.JSX.Element {
  const { t } = useTranslation();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  /**
   * THE DRAWING IS SIZED BY ITS CONTAINER, NOT BY THE WINDOW.
   *
   * THE DEFECT THIS CLOSES. `computeAirframeStageWidth` reads the WINDOW,
   * so on a 1366 desktop it returned a 400px stage - and then the stage
   * was mounted in a 188px column, centred, and spilled 106px out of each
   * side straight across the verification controls beside it. Measured in
   * Chromium: `stage rect 1041,120 400x400` inside `diagram rect
   * 1147,-3 188x717`. Five interactive controls had a non-zero
   * intersection with the drawing at 1280, 1366, 1440 and 1920.
   *
   * A window breakpoint cannot know this. Only the container can. So the
   * stage is now the SMALLER of what the viewport tier allows and what
   * the box it actually landed in can hold, and `maxWidth: '100%'` on the
   * stage is the second lock: even before the first layout pass, and even
   * if a future parent shrinks without remounting, the drawing cannot be
   * wider than the space it was given.
   */
  const [containerWidth, setContainerWidth] = useState(0);
  const byViewport =
    stageWidthOverride ?? computeAirframeStageWidth(windowWidth, fontScale);
  const stageWidth =
    containerWidth > 0
      ? Math.max(
          MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
          Math.min(byViewport, Math.floor(containerWidth)),
        )
      : byViewport;
  // Every internal dimension is a multiple of this, so the whole diagram
  // grows as one drawing instead of a big box around small glyphs.
  const scale = stageWidth / 260;

  /**
   * M-D §20 / §21 / §22 - THE GATE USED TO BE THE MOTOR COUNT.
   *
   * `motorCount !== 4` sent everything except a four-motor aircraft to the
   * numbered list, and drew everything WITH four motors as a Quad X. Five
   * mixers were being drawn wrong: QUADP is a plus frame, Y4 has a coaxial
   * tail, VTAIL4 and ATAIL4 have angled rear arms, and QUADX_1234 is a
   * real X whose motor NUMBERING differs - its motor 1 is at the front
   * left where the Quad X drawing puts motor 4.
   *
   * The question is not how many motors there are. It is whether this
   * project has authored and checked a layout for THIS mixer, at THIS
   * motor count. authoredAirframeLayout answers exactly that, and answers
   * undefined generously - an unknown mixer, an unread count, or a count
   * that disagrees with the layout all fall through to the numbered list.
   */
  const layout = authoredAirframeLayout(mixerModeRaw, motorNumbers);
  if (layout === undefined) {
    return <GenericMotorOutputs />;
  }

  /**
   * NO DIRECTION IS SUPPLIED, AND THAT IS THE POINT (M-D §25).
   *
   * The layout maps a motor number to a place on the frame and carries no
   * rotation at all, so every node renders its explicit unknown mark
   * rather than an arrow. M-A established that actual propeller rotation
   * is not readable as authoritative truth over MSP; an arrow here would
   * be a guess drawn in the same ink as a measurement.
   */
  const ordered = orderAirframeEntries(
    layout.map(placement => ({
      slot: placement.motorNumber,
      position: placement.position,
    })),
  );
  /**
   * PHYSICAL PLACEMENT, COMPUTED - not delegated to a style property.
   *
   * orderAirframeEntries emits RIGHT-then-LEFT (its own contract, tested,
   * untouched). A plain flex row paints index 0 at the reading-start
   * edge: the RIGHT edge under RTL, the LEFT edge under LTR. So the
   * paint order is simply reversed for LTR, and FRONT_RIGHT lands on the
   * operator's right either way.
   *
   * WHY NOT `direction: 'ltr'` + row-reverse, which this file tried
   * first: react-native-web SILENTLY DROPS the React Native `direction`
   * style. Measured in a real browser - the rendered row still computed
   * `direction: rtl`, row-reverse inverted it, and the aircraft was drawn
   * MIRRORED (M2 "أمامي يمين" appeared on the left). A style the platform
   * ignores cannot carry a safety guarantee, and a unit test that asserts
   * the style OBJECT rather than the rendered box will not catch it.
   *
   * This changes no motor data: same entries, same slots, same mapping.
   */
  const paintOrder = (pair: readonly MotorAirframeEntry[]) =>
    isRtlLayout() ? pair : [...pair].reverse();
  const front = paintOrder(ordered.slice(0, 2));
  const rear = paintOrder(ordered.slice(2, 4));

  const renderNode = (entry: MotorAirframeEntry) => (
    <MotorNode
      key={entry.slot}
      entry={entry}
      selected={entry.slot === selectedSlot}
      activity={entry.slot === liveSlot ? liveActivity : undefined}
      verified={verifiedSlots.includes(entry.slot)}
      scale={scale}
      onSelect={() => onSelectSlot(entry.slot)}
    />
  );

  /**
   * WHICH LEGEND ENTRIES DESCRIBE SOMETHING THAT IS ACTUALLY DRAWN.
   * Derived from the same props the nodes are drawn from, so the key can
   * never describe a colour the map is not using.
   */
  const presentLegend: readonly {key: string; color: string}[] = [
    {key: 'motorsScreen.legendSelected', color: colors.accent, present: true},
    {
      key: 'motorsScreen.legendSubmitted',
      color: colors.warning,
      present: liveActivity === 'SUBMITTED',
    },
    {
      key: 'motorsScreen.legendAcknowledged',
      color: colors.warning,
      present: liveActivity === 'ACKNOWLEDGED',
    },
    {
      key: 'motorsScreen.legendStopping',
      color: colors.info,
      present: liveActivity === 'STOPPING',
    },
    {
      key: 'motorsScreen.legendObserved',
      color: colors.success,
      present: verifiedSlots.length > 0,
    },
    {
      key: 'motorsScreen.legendUnsafe',
      color: colors.error,
      present: liveActivity === 'UNSAFE',
    },
  ]
    .filter(item => item.present)
    .map(({key, color}) => ({key, color}));

  const armThickness = Math.max(6, Math.round(stageWidth * 0.045));

  return (
    <View
      style={styles.root}
      testID="motors-airframe-diagram"
      onLayout={event => setContainerWidth(event.nativeEvent.layout.width)}
    >
      {compact ? null : (
        <Text style={styles.diagramTitle}>{t('motorsScreen.diagramTitle')}</Text>
      )}

      <View style={styles.frontMarker} testID="motors-diagram-front">
        <Icon
          name="chevron-up"
          size={Math.round(22 * scale)}
          color={colors.accentStrong}
          strokeWidth={2.5}
        />
        <Text
          style={[
            styles.frontText,
            { fontSize: Math.max(12, Math.round(15 * scale)) },
          ]}
        >
          {t('motorsScreen.diagramFront')}
        </Text>
      </View>

      <View
        style={[styles.stage, { width: stageWidth, height: stageWidth }]}
        testID="motors-airframe-stage"
      >
        <View
          style={[
            styles.arm,
            { height: armThickness, marginTop: -armThickness / 2 },
            styles.armForward,
          ]}
        />
        <View
          style={[
            styles.arm,
            { height: armThickness, marginTop: -armThickness / 2 },
            styles.armBackward,
          ]}
        />
        <View style={styles.body}>
          <View
            style={[
              styles.bodyNose,
              {
                top: -Math.round(12 * scale),
                borderLeftWidth: Math.round(10 * scale),
                borderRightWidth: Math.round(10 * scale),
                borderBottomWidth: Math.round(14 * scale),
              },
            ]}
          />
          <View style={styles.bodyPlate} />
          <View style={styles.bodyCore} />
          <View style={styles.tailMark} />
        </View>

        <View style={[styles.motorRow, styles.frontRow]}>
          {front.map(renderNode)}
        </View>
        <View style={[styles.motorRow, styles.rearRow]}>
          {rear.map(renderNode)}
        </View>
      </View>

      {compact ? null : (
        <Text style={styles.caption}>{t('motorsScreen.diagramCaption')}</Text>
      )}

      {/* THE KEY DESCRIBES WHAT IS ON THE MAP, NOT EVERY MAP THERE COULD
          BE. Six states were printed at all times - selected, command
          sent, controller acknowledged, stopping, observed, unsafe - so
          before touching anything an operator read five keys for colours
          that were not on the drawing. Only the states actually present
          are listed now; the complete key stays one tap away under the
          reference notes below the map, where nothing is lost. */}
      {compact || presentLegend.length === 0 ? null : (
        <View style={styles.legend} testID="motors-diagram-legend">
          {presentLegend.map(item => (
            <LegendItem key={item.key} color={item.color} label={t(item.key)} />
          ))}
        </View>
      )}
    </View>
  );
}

function LegendItem({
  color,
  label,
}: {
  color: string;
  label: string;
}): React.JSX.Element {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, alignItems: 'center' },
  diagramTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  frontMarker: { alignItems: 'center', gap: 1 },
  frontText: {
    // fontFamily is explicit because the SIZE is applied inline at render
    // time; spreading a token would be overridden, and omitting the family
    // dropped this label to the system font (measured in a browser).
    fontFamily: fonts.family,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  stage: {
    alignSelf: 'center',
    /* THE SECOND LOCK. The measured clamp above sets the real size; this
       guarantees the drawing can never paint outside the box it was
       given, including on the very first frame before onLayout has
       fired. */
    maxWidth: '100%',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#F7FAF9',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  arm: {
    position: 'absolute',
    left: '12%',
    top: '50%',
    width: '76%',
    borderRadius: radii.pill,
    backgroundColor: '#BBD8D4',
    borderColor: colors.border,
    borderWidth: 1,
  },
  armForward: { transform: [{ rotate: '45deg' }] },
  armBackward: { transform: [{ rotate: '-45deg' }] },
  body: {
    position: 'absolute',
    left: '36%',
    top: '36%',
    width: '28%',
    height: '28%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderColor: colors.accent,
    borderWidth: 1,
    backgroundColor: '#D9EFEB',
  },
  bodyNose: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.accent,
  },
  bodyPlate: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '16%',
    bottom: '14%',
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bodyCore: {
    width: '40%',
    height: '44%',
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentStrong,
    borderWidth: 1,
  },
  tailMark: {
    position: 'absolute',
    bottom: 3,
    width: '30%',
    height: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
  },
  motorRow: {
    position: 'absolute',
    /* PART M - BREATHING ROOM, sized from the measurement rather than
       guessed. Pulling the rows in from 2% to 6% moves each node ~8px off
       the stage edge at 390px and, with the node now ~40px shorter and
       height-stable, leaves a real gap between the front and rear rows
       instead of the measured 19.31px overlap. */
    left: '6%',
    right: '6%',
    /**
     * A plain row. The PHYSICAL placement is decided in the component
     * (see paintOrder), not by this style: react-native-web drops the
     * React Native `direction` property, so no style here can pin the
     * aircraft's left and right.
     */
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  frontRow: { top: '3%' },
  rearRow: { bottom: '3%' },
  motorCell: { alignItems: 'center' },
  motorNode: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  /* The arrow's own radius. `justifyContent: flex-start` puts the arrow at
     the top of the ring and the disc is centred inside by the absolute
     rule below, so the two never share pixels. */
  rotorRing: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    /* A technical row: M-number then CW/CCW, in that order, in every
       locale. Physical identity is not a reading direction. */
    direction: 'ltr',
  },
  /* Reserved whether or not a badge exists - see MotorNode. */
  badgeSlot: { justifyContent: 'center', alignItems: 'center' },
  motorNodeSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  motorNodeVerified: { borderColor: colors.success },
  rotor: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.textSecondary,
    backgroundColor: colors.backgroundRaised,
  },
  rotorActive: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  blade: {
    position: 'absolute',
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
  },
  hub: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.background,
    borderWidth: 1,
  },
  slot: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  position: {
    // Arabic prose ("أمامي يمين"), sized inline - so the family must be
    // named here or it falls back to the system font.
    fontFamily: fonts.family,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  stateBadge: {
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    backgroundColor: colors.background,
  },
  stateBadgeText: {
    fontFamily: fonts.family,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
    maxWidth: 460,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  genericGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  genericCellActive: { borderWidth: 2 },
  genericSlotText: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
    fontSize: 16,
    lineHeight: 20,
  },
  genericBadgeText: {
    fontFamily: fonts.family,
    fontWeight: '700',
    writingDirection: 'rtl',
    fontSize: 11,
  },
  genericCell: {
    minWidth: 64,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
