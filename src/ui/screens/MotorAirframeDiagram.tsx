/**
 * The airframe map for the Motors workspace.
 *
 * WHAT IT DRAWS, AND FOR WHICH AIRCRAFT. It asks
 * `authoredAirframeLayout(mixerModeRaw, motorNumbers)` where this
 * aircraft's motors sit, and draws the frame with each motor in its place.
 * M-E authored seventeen layouts, so the hex, octo, Y and tail families
 * now get an aircraft instead of a paragraph. Where no layout exists - a
 * custom mixer, an unread one, a hex whose own table puts two motors at
 * the origin - it draws a NUMBERED LIST and says so in one sentence. That
 * is a correct answer, not a degraded one: a picture of the wrong aircraft
 * is worse than no picture.
 *
 * IT IS A TOOL, NOT AN ILLUSTRATION. M-E measured the previous version at
 * 462px on a 900px desktop viewport and 401px on a 390px phone - half the
 * screen, for four circles - which pushed the Motor Test controls 1288px
 * down the phone page. The stage is now DERIVED from the geometry it has
 * to show: `computeAirframeStageWidth` returns the smallest square in
 * which every motor node keeps a 44px touch target and 46px of clearance
 * from its neighbours, bounded to 180px. A quad needs 128px, an octo 168px,
 * and nothing needs more. Growing it further adds no information.
 *
 * WHAT IT NEVER DRAWS: A ROTATION. There is no MSP field at API 1.47 that
 * reports which way a motor actually spins, and a mixer mode does not
 * determine it. Authored layouts carry no direction field, this component
 * cannot be handed one, and the caption says so once in words. The
 * expected props-out reference still exists in the VERIFICATION wizard,
 * where comparing it against what a person actually saw is the whole
 * point - but the operational map, which an operator reads WHILE a motor
 * is turning, claims nothing about rotation.
 *
 * COAXIAL AIRCRAFT ARE DRAWN AS COAXIAL. A Y6 is not a flat hexacopter
 * and an X8 is not a flat octocopter; they carry two rotors per arm. Those
 * arms render as ONE node bearing both motor numbers with an upper/lower
 * mark, because eight independently-tappable 44px targets do not fit in a
 * compact stage and spreading them around a circle would draw an aircraft
 * that does not exist. Pressing the node moves between the two motors on
 * that arm, and both are also selectable from the numbered rows.
 *
 * A view-only geometry layer: the slot handed to onSelectSlot is the same
 * number printed on the node, and no value here can reach a motor command
 * or relax a safety gate. Position is an EXPECTED reference transcribed
 * from the firmware mixer table, never a measurement from the aircraft -
 * an MSP acknowledgement proves reception, not rotation.
 *
 * MEANING NEVER DEPENDS ON COLOUR. The node carries a coloured dot so the
 * eye can find the live motor; WHAT is happening to it is stated in Arabic
 * words on the line below the stage, naming the motor. That line replaced
 * a six-entry colour key printed on every render whether or not any state
 * was active.
 */

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../theme';
import {
  authoredAirframeLayout,
  stationOf,
  verificationPositionOf,
} from '../../core/state/motorAirframeLayout';
import type {
  AirframeLayout,
  AirframeStation,
  MotorAirframePlacement,
} from '../../core/state/motorAirframeLayout';
import {
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  MOTOR_TEST_EXPECTED_MIXER_MODE,
} from '../../core/state/motorVerificationModel';
import type {MotorPhysicalPosition} from '../../core/state/motorVerificationModel';

/**
 * What the diagram may say about one output right now. SUBMITTED /
 * ACKNOWLEDGED / STOPPING mirror the controller's own published pulse
 * record. UNSAFE means the app cannot describe the output truthfully (a
 * fault, or a stop it could not confirm).
 */
export type MotorSlotActivity = 'SUBMITTED' | 'ACKNOWLEDGED' | 'STOPPING' | 'UNSAFE';

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
   * `undefined` means the mixer has not been read, and an unread mixer is
   * drawn as a numbered list - see motorAirframeLayout.ts for which
   * mixers have artwork and which are deliberately without it.
   */
  readonly mixerModeRaw: number | undefined;
  /**
   * The motor numbers the flight controller actually reported, 1..N.
   *
   * REQUIRED, AND WITH NO DEFAULT ON PURPOSE. An empty array means
   * "nothing has been read", and renders as nothing.
   */
  readonly motorNumbers: readonly number[];
  /**
   * Force a stage size instead of deriving one from the geometry.
   *
   * PRESENTATION ONLY - it changes no geometry, no slot order, no
   * numbering and no touch semantics. It exists because this diagram can
   * be rendered twice on one screen, and a derived size cannot express
   * "the small one".
   */
  readonly stageWidthOverride?: number;
  /**
   * THE SECOND COPY. Drops the title, the caption and the legend - each of
   * which is already on screen, unchanged, on the diagram this one
   * accompanies. What it KEEPS is everything that carries information
   * about THIS aircraft: the FRONT marker, the frame, and the selectable
   * nodes with their M-numbers and state badges.
   */
  readonly compact?: boolean;
}

/** Every node is a real touch target on every device. */
const NODE_SIZE = 44;
/** Clearance demanded between two node centres, over and above nothing:
 *  two 44px targets whose centres are 46px apart do not overlap enough to
 *  mis-hit at a glance. */
const NODE_CLEARANCE = 46;
/**
 * The smallest and largest square the stage may occupy.
 *
 * The ceiling is the whole point of M-E §0-§3: past this the drawing stops
 * carrying more information and starts being a large picture of some
 * circles, and the controls it exists to serve go below the fold.
 */
export const MOTOR_AIRFRAME_STAGE_MIN_WIDTH = 132;
export const MOTOR_AIRFRAME_STAGE_MAX_WIDTH = 180;
export const MOTOR_AIRFRAME_STAGE_ASPECT_RATIO = 1;

/** One motor node's place in the stage, in normalised -1..1 space. */
interface DiagramNode {
  /** The motors this node stands for. More than one means a coaxial arm. */
  readonly slots: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly station: AirframeStation;
}

/**
 * Collapses a layout into the nodes that will actually be drawn, with the
 * coordinates normalised so the outermost motor touches the stage edge.
 *
 * Motors sharing a station are one node: see the coaxial note in the file
 * header. Slot order within a node is ascending, so pressing it walks the
 * arm from the upper rotor down.
 */
export function computeDiagramNodes(layout: AirframeLayout): readonly DiagramNode[] {
  const extent = layout.placements.reduce(
    (widest, placement) =>
      Math.max(widest, Math.abs(placement.x), Math.abs(placement.y)),
    0,
  );
  const scale = extent === 0 ? 1 : 1 / extent;
  const byStation = new Map<string, MotorAirframePlacement[]>();
  for (const placement of layout.placements) {
    const key = `${placement.x.toFixed(4)},${placement.y.toFixed(4)}`;
    const bucket = byStation.get(key);
    if (bucket === undefined) {
      byStation.set(key, [placement]);
    } else {
      bucket.push(placement);
    }
  }
  return Object.freeze(
    [...byStation.values()].map(bucket => {
      const [first] = bucket;
      return Object.freeze({
        slots: Object.freeze(
          [...bucket]
            .sort((left, right) => left.motorNumber - right.motorNumber)
            .map(placement => placement.motorNumber),
        ),
        x: first.x * scale,
        y: first.y * scale,
        station: stationOf(first),
      });
    }),
  );
}

/**
 * The smallest stage in which this layout's nodes keep their touch targets
 * and their clearance, bounded to the compact ceiling.
 *
 * A node at normalised (x, y) is drawn at pixel offset (x, y) * (stage -
 * NODE_SIZE) / 2 from the centre, so two nodes a normalised distance `d`
 * apart are `d * (stage - NODE_SIZE) / 2` pixels apart. Requiring that to
 * be at least NODE_CLEARANCE gives the stage directly. A single-node
 * layout - a wing, an aeroplane - has no pair to separate and takes the
 * floor.
 */
export function computeAirframeStageWidth(layout: AirframeLayout): number {
  const nodes = computeDiagramNodes(layout);
  let closest = Number.POSITIVE_INFINITY;
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      const dx = nodes[left].x - nodes[right].x;
      const dy = nodes[left].y - nodes[right].y;
      closest = Math.min(closest, Math.hypot(dx, dy));
    }
  }
  if (!Number.isFinite(closest) || closest === 0) {
    return MOTOR_AIRFRAME_STAGE_MIN_WIDTH;
  }
  const required = NODE_SIZE + (2 * NODE_CLEARANCE) / closest;
  return Math.round(
    Math.min(
      MOTOR_AIRFRAME_STAGE_MAX_WIDTH,
      Math.max(MOTOR_AIRFRAME_STAGE_MIN_WIDTH, required),
    ),
  );
}

/* ---------------------------------------------------------------- *
 * The Quad X glyph layout, still used by the payload-identity suite.
 * ---------------------------------------------------------------- */

export type MotorGlyphRow = 'FRONT' | 'REAR';
export type MotorGlyphSide = 'RIGHT' | 'LEFT';

export interface MotorGlyphCell {
  /** MSP output slot - the same number pulseMotor receives. */
  readonly slot: number;
  readonly row: MotorGlyphRow;
  readonly side: MotorGlyphSide;
  readonly positionKey: string;
  readonly directionKey: string;
}

const POSITION_GEOMETRY: Record<
  MotorPhysicalPosition,
  {row: MotorGlyphRow; side: MotorGlyphSide}
> = {
  FRONT_RIGHT: {row: 'FRONT', side: 'RIGHT'},
  FRONT_LEFT: {row: 'FRONT', side: 'LEFT'},
  REAR_RIGHT: {row: 'REAR', side: 'RIGHT'},
  REAR_LEFT: {row: 'REAR', side: 'LEFT'},
};

// Emission order is explicit and mirrors the accepted identity test: right
// first, left second.
const VISUAL_POSITION_ORDER: readonly MotorPhysicalPosition[] = Object.freeze([
  'FRONT_RIGHT',
  'FRONT_LEFT',
  'REAR_RIGHT',
  'REAR_LEFT',
]);

export function positionKey(position: MotorPhysicalPosition): string {
  switch (position) {
    case 'FRONT_LEFT':
      return 'positionFrontLeft';
    case 'FRONT_RIGHT':
      return 'positionFrontRight';
    case 'REAR_LEFT':
      return 'positionRearLeft';
    default:
      return 'positionRearRight';
  }
}

function directionKey(direction: 'CW' | 'CCW'): string {
  return direction === 'CW' ? 'directionCw' : 'directionCcw';
}

/**
 * The tested label geometry used by the payload-identity suite. It derives
 * from the shipped Quad X expectation and the visual order above; there is
 * no second slot mapping anywhere.
 */
export function computeMotorGlyphLayout(): readonly MotorGlyphCell[] {
  return Object.freeze(
    VISUAL_POSITION_ORDER.map(position => {
      const expected = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
        candidate => candidate.position === position,
      );
      if (expected === undefined) {
        throw new Error(`No expected mapping for ${position}`);
      }
      const geometry = POSITION_GEOMETRY[position];
      return Object.freeze({
        slot: expected.motorNumber,
        row: geometry.row,
        side: geometry.side,
        positionKey: positionKey(position),
        directionKey: directionKey(expected.direction),
      });
    }),
  );
}

/**
 * The Quad X glyph cells grouped into their two physical rows.
 *
 * PHYSICAL, NOT TEXTUAL. Right comes before left in each row because that
 * is the emission order, and the value returned does not consult the
 * layout direction - which is the property its test asserts: an Arabic
 * interface must not move motor 1 to the other side of the aircraft.
 */
export function motorGlyphRows(): readonly (readonly MotorGlyphCell[])[] {
  const cells = computeMotorGlyphLayout();
  return Object.freeze([
    Object.freeze(cells.filter(cell => cell.row === 'FRONT')),
    Object.freeze(cells.filter(cell => cell.row === 'REAR')),
  ]);
}

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */

function activityLabelKey(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
      return 'motorsScreen.slotStateSubmitted';
    case 'ACKNOWLEDGED':
      return 'motorsScreen.slotStateAcknowledged';
    case 'STOPPING':
      return 'motorsScreen.slotStateStopping';
    default:
      return 'motorsScreen.slotStateUnsafe';
  }
}

function activityColor(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
      return colors.accentStrong;
    case 'ACKNOWLEDGED':
      return colors.success;
    case 'STOPPING':
      return colors.warning;
    default:
      return colors.error;
  }
}

/** The i18n key naming a station, exhaustively. Exported so the words
 *  under the aircraft and the words spoken by a node cannot drift apart. */
export function stationKey(station: AirframeStation): string {
  switch (station) {
    case 'FRONT':
      return 'stationFront';
    case 'FRONT_LEFT':
      return 'stationFrontLeft';
    case 'FRONT_RIGHT':
      return 'stationFrontRight';
    case 'MIDFRONT_LEFT':
      return 'stationMidFrontLeft';
    case 'MIDFRONT_RIGHT':
      return 'stationMidFrontRight';
    case 'LEFT':
      return 'stationLeft';
    case 'RIGHT':
      return 'stationRight';
    case 'MIDREAR_LEFT':
      return 'stationMidRearLeft';
    case 'MIDREAR_RIGHT':
      return 'stationMidRearRight';
    case 'REAR':
      return 'stationRear';
    case 'REAR_LEFT':
      return 'stationRearLeft';
    case 'REAR_RIGHT':
      return 'stationRearRight';
    default:
      return 'stationCentre';
  }
}

/** A rotor: a hub and two blades, and deliberately nothing that turns. */
function RotorGlyph({size, active}: {size: number; active: boolean}): React.JSX.Element {
  const blade = Math.round(size * 0.86);
  const thickness = Math.max(2, Math.round(size * 0.16));
  const hub = Math.max(4, Math.round(size * 0.3));
  return (
    <View style={[styles.rotor, {width: size, height: size}, active && styles.rotorActive]}>
      <View
        style={[
          styles.blade,
          {width: blade, height: thickness, transform: [{rotate: '32deg'}]},
        ]}
      />
      <View
        style={[
          styles.blade,
          {width: blade, height: thickness, transform: [{rotate: '-32deg'}]},
        ]}
      />
      <View style={[styles.hub, {width: hub, height: hub, borderRadius: hub / 2}]} />
    </View>
  );
}

/**
 * The body under the motors.
 *
 * ROTARY draws one arm per node from the hub outwards, so a Y reads as a Y
 * and a plus reads as a plus. WING and PLANE draw a silhouette instead,
 * because a single centre motor with no arms would otherwise be a dot in
 * an empty square and say nothing about the aircraft.
 */
function Silhouette({
  layout,
  nodes,
  stage,
}: {
  layout: AirframeLayout;
  nodes: readonly DiagramNode[];
  stage: number;
}): React.JSX.Element {
  const reach = (stage - NODE_SIZE) / 2;
  const hub = Math.round(stage * 0.17);
  if (layout.silhouette === 'ROTARY') {
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="motors-diagram-body">
        {nodes.map(node => {
          const length = Math.hypot(node.x, node.y) * reach;
          if (length < 1) {
            return null;
          }
          const angle = (Math.atan2(node.y, node.x) * 180) / Math.PI;
          return (
            <View
              key={`arm-${node.slots.join('-')}`}
              style={[
                styles.arm,
                {
                  width: length,
                  left: stage / 2,
                  top: stage / 2 - 1.5,
                  transform: [{rotate: `${angle}deg`}],
                },
              ]}
            />
          );
        })}
        <View
          style={[
            styles.hubBody,
            {
              width: hub,
              height: hub,
              borderRadius: Math.round(hub / 3),
              left: (stage - hub) / 2,
              top: (stage - hub) / 2,
            },
          ]}
        />
      </View>
    );
  }
  /*
   * FIXED-WING SILHOUETTES.
   *
   * A single-motor mixer table gives { roll 0, pitch 0, yaw 0 }: the motor
   * has NO MOMENT ARM, which is all the firmware says about it. It does
   * not say where the propeller is, so the node stays at the origin and
   * the airframe is drawn AROUND it - nose forward of the node, wing and
   * tail behind it. That reads as an aircraft without claiming a
   * placement the source does not contain.
   */
  const bar = (
    key: string,
    width: number,
    height: number,
    top: number,
    rotate?: string,
    left?: number,
  ): React.JSX.Element => (
    <View
      key={key}
      style={[
        styles.wing,
        {
          width,
          height,
          top,
          left: left ?? (stage - width) / 2,
          ...(rotate === undefined
            ? {}
            : {transform: [{rotate}], transformOrigin: 'left center'}),
        },
      ]}
    />
  );

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="motors-diagram-body">
      {layout.silhouette === 'WING'
        ? [
            /* Two swept panels from a nose apex, closed by a trailing
               edge: a delta, not a rectangle. */
            bar('wing-r', stage * 0.5, stage * 0.13, stage * 0.2, '38deg', stage / 2),
            bar('wing-l', stage * 0.5, stage * 0.13, stage * 0.2, '142deg', stage / 2),
            bar('wing-te', stage * 0.66, stage * 0.11, stage * 0.72),
          ]
        : [
            /* Fuselage running BACK from the node, then the main wing and
               the tailplane behind it. */
            bar('fuselage', stage * 0.1, stage * 0.44, stage * 0.5),
            bar('wing-main', stage * 0.72, stage * 0.11, stage * 0.62),
            bar('tailplane', stage * 0.3, stage * 0.08, stage * 0.86),
          ]}
    </View>
  );
}

function MotorNode({
  node,
  stage,
  selectedSlot,
  liveSlot,
  liveActivity,
  verifiedSlots,
  onSelectSlot,
}: {
  node: DiagramNode;
  stage: number;
  selectedSlot: number;
  liveSlot: number | undefined;
  liveActivity: MotorSlotActivity | undefined;
  verifiedSlots: readonly number[];
  onSelectSlot: (slot: number) => void;
}): React.JSX.Element {
  const {t} = useTranslation();
  const reach = (stage - NODE_SIZE) / 2;
  const left = stage / 2 + node.x * reach - NODE_SIZE / 2;
  const top = stage / 2 + node.y * reach - NODE_SIZE / 2;
  const selectedHere = node.slots.includes(selectedSlot);
  const liveHere = liveSlot !== undefined && node.slots.includes(liveSlot);
  const verifiedHere = node.slots.some(slot => verifiedSlots.includes(slot));
  const activity = liveHere ? liveActivity : undefined;
  const badge =
    activity !== undefined
      ? {text: t(activityLabelKey(activity)), color: activityColor(activity)}
      : verifiedHere
      ? {text: t('motorsScreen.slotStateObserved'), color: colors.success}
      : undefined;

  /* Pressing a coaxial arm walks to the next motor on it, so both rotors
   * are reachable from the drawing without either needing its own target.
   * A single-motor node simply selects that motor. */
  const nextSlot = (): number => {
    if (node.slots.length === 1) {
      return node.slots[0];
    }
    const at = node.slots.indexOf(selectedSlot);
    return node.slots[(at + 1) % node.slots.length];
  };

  const spokenStation = t(`motorsScreen.${stationKey(node.station)}`);
  const spokenSlots = node.slots
    .map((slot, index) =>
      node.slots.length === 1
        ? `M${slot}`
        : `M${slot} ${t(
            index === 0 ? 'motorsScreen.deckUpper' : 'motorsScreen.deckLower',
          )}`,
    )
    .join('، ');

  return (
    <Pressable
      onPress={() => onSelectSlot(nextSlot())}
      accessibilityRole="radio"
      accessibilityState={{selected: selectedHere}}
      // The station IS spoken: a screen-reader user cannot see where the
      // node sits on the frame. The ROTATION is not - not even as
      // "unknown". Nothing supplies one, and the caption says once, in
      // words, that rotation is not read.
      accessibilityLabel={`${spokenSlots}، ${spokenStation}${
        badge === undefined ? '' : `، ${badge.text}`
      }`}
      style={[
        styles.motorNode,
        {left, top, width: NODE_SIZE, height: NODE_SIZE},
        selectedHere && styles.motorNodeSelected,
        verifiedHere && styles.motorNodeVerified,
        activity !== undefined && styles.motorNodeLive,
        activity !== undefined && {borderColor: activityColor(activity)},
      ]}
      testID={`motors-airframe-slot-${node.slots[0]}`}
    >
      {/* A COAXIAL ARM LOOKS LIKE TWO DISCS, because it is two rotors.
          The numbers already say "M1 /5" and the caption says it in
          words; this is the third channel, for the operator who reads the
          shape before either. */}
      {node.slots.length > 1 ? (
        <View pointerEvents="none" style={styles.stackRing} />
      ) : null}
      <RotorGlyph size={Math.round(NODE_SIZE * 0.42)} active={activity !== undefined} />
      {/* ONE Text, with the numbers nested inside it.
          A row of two Texts was laid out right-to-left by the Arabic
          interface, so a coaxial arm carrying motors 1 and 5 printed
          "/5M1". Motor NUMBERING is not a writing system: the composite
          is forced left-to-right here, exactly as the node's position is
          computed from its coordinate and not from the locale. */}
      <Text style={styles.slotRow} numberOfLines={1}>
        {node.slots.map((slot, index) => (
          <Text
            key={slot}
            style={[
              node.slots.length > 1 ? styles.slotStacked : styles.slot,
              slot === selectedSlot && styles.slotSelected,
            ]}
            testID={`motors-diagram-slot-${slot}`}
          >
            {index === 0 ? `M${slot}` : `\u2009/${slot}`}
          </Text>
        ))}
      </Text>
      {badge === undefined ? null : (
        <View
          style={[styles.stateDot, {backgroundColor: badge.color}]}
          testID={`motors-diagram-state-${node.slots[0]}`}
        />
      )}
    </Pressable>
  );
}

/**
 * NOT A DEGRADED MODE, AND NOT A SECOND SELECTOR.
 *
 * Where there is no authored layout, this block says so in one sentence
 * and draws no aircraft. It renders an EXPLANATION, never a selector:
 * selection belongs to the numbered motor rows, on every airframe.
 */
function GenericMotorOutputs(): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <View style={styles.genericRoot} testID="motors-generic-outputs">
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
  mixerModeRaw,
  motorNumbers,
  stageWidthOverride,
  compact = false,
}: MotorAirframeDiagramProps): React.JSX.Element | null {
  const {t} = useTranslation();
  const {width: windowWidth} = useWindowDimensions();
  /**
   * THE BOX THIS DRAWING IS ACTUALLY IN, not the window it is on.
   *
   * The defect this measurement exists for: the stage used to be sized
   * from the window tier, and the column it lives in on a desktop is
   * roughly 40% of that - so a 1366 window asked for a 400px drawing and
   * handed it a 188px column to paint in. The window is still consulted
   * as a second ceiling, because a container can be measured as wider
   * than the viewport before the first layout pass settles.
   */
  const [boxWidth, setBoxWidth] = useState(0);
  const layout = authoredAirframeLayout(mixerModeRaw, motorNumbers);
  if (layout === undefined) {
    return <GenericMotorOutputs />;
  }
  const nodes = computeDiagramNodes(layout);
  const derived = computeAirframeStageWidth(layout);
  /* The only reason the window is consulted at all: a very narrow device
     must not be given a stage wider than its content column. It can shrink
     the compact stage; it can never grow it. */
  const roomy = Number.isFinite(windowWidth)
    ? Math.max(MOTOR_AIRFRAME_STAGE_MIN_WIDTH, windowWidth - 96)
    : derived;
  const inBox = boxWidth > 0 ? boxWidth : Number.POSITIVE_INFINITY;
  const stage = Math.round(
    Math.max(
      MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
      Math.min(stageWidthOverride ?? derived, roomy, inBox),
    ),
  );

  /* The one live or observed motor, named in words. Computed here rather
     than inside a node so it reads "M3: مُرسل" once instead of once per
     rotor. */
  const liveText =
    liveSlot !== undefined && liveActivity !== undefined
      ? `M${liveSlot} · ${t(activityLabelKey(liveActivity))}`
      : verifiedSlots.length > 0
      ? `${verifiedSlots.map(slot => `M${slot}`).join('، ')} · ${t(
          'motorsScreen.slotStateObserved',
        )}`
      : undefined;

  return (
    <View
      style={styles.root}
      testID="motors-airframe-diagram"
      onLayout={event => setBoxWidth(event.nativeEvent.layout.width)}
    >
      {compact ? null : (
        <Text style={styles.title} testID="motors-diagram-title">
          {t('motorsScreen.diagramTitle')}
        </Text>
      )}
      {/* THE FRONT MARKER IS NOT OPTIONAL. Every layout gets it, above the
          stage where it cannot be mistaken for a motor, and it stays the
          same size on every device so it is still readable at 390px. */}
      <View style={styles.frontMarker} testID="motors-diagram-front">
        <Text style={styles.frontArrow}>↑</Text>
        <Text style={styles.frontText}>{t('motorsScreen.diagramFront')}</Text>
      </View>
      <View
        style={[styles.stage, {width: stage, height: stage}]}
        testID="motors-airframe-stage"
      >
        <Silhouette layout={layout} nodes={nodes} stage={stage} />
        {nodes.map(node => (
          <MotorNode
            key={node.slots.join('-')}
            node={node}
            stage={stage}
            selectedSlot={selectedSlot}
            liveSlot={liveSlot}
            liveActivity={liveActivity}
            verifiedSlots={verifiedSlots}
            onSelectSlot={onSelectSlot}
          />
        ))}
      </View>
      {/* THE AIRFRAME'S SERVOS, NAMED AND NEVER OFFERED.
          It used to be a badge pinned inside the stage at the tail, which
          on a tricopter is exactly where motor 1 is - the two overlapped
          and the badge lost. It is a chip under the aircraft now, with a
          square glyph rather than a rotor, so a servo cannot be mistaken
          for a motor at a glance. It is informational: this application
          never writes a servo, and no servo appears in the motor list. */}
      {layout.servoRole === undefined ? null : (
        <View style={styles.servoMark} testID="motors-diagram-servo">
          <View style={styles.servoGlyph} />
          <Text style={styles.servoText}>
            {t(`motorsScreen.servoRole.${layout.servoRole}`)}
          </Text>
        </View>
      )}
      {/* MEANING NEVER DEPENDS ON COLOUR.
          The node carries a coloured dot so the eye can find WHICH motor
          is live at a glance; WHAT is happening to it is stated here, in
          Arabic words, naming the motor. This replaced a six-entry colour
          legend that was printed on every render whether or not any state
          was active - furniture that explained the palette instead of
          reporting the aircraft. One line, always about a real motor. */}
      {liveText === undefined ? null : (
        <Text style={styles.liveState} testID="motors-diagram-live-state">
          {liveText}
        </Text>
      )}
      {compact || layout.servoRole === undefined ? null : (
        <Text style={styles.caption} testID="motors-diagram-servo-note">
          {t(`motorsScreen.servoNote.${layout.servoRole}`)}
        </Text>
      )}
      {compact ? null : (
        <Text style={styles.caption} testID="motors-diagram-caption">
          {t(
            layout.coaxial
              ? 'motorsScreen.diagramCaptionCoaxial'
              : 'motorsScreen.diagramCaption',
          )}
        </Text>
      )}
    </View>
  );
}

/** Whether the shipped Quad X expectation describes this mixer. Exported
 *  so callers can ask without importing the verification model. */
export function isVerificationModelAirframe(mixerModeRaw: number | undefined): boolean {
  return mixerModeRaw === MOTOR_TEST_EXPECTED_MIXER_MODE;
}

/** Re-exported so a caller with a placement can name its corner without
 *  reaching past this module into core. */
export {verificationPositionOf};

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  genericRoot: {
    paddingVertical: spacing.xs,
  },
  title: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  frontMarker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  frontArrow: {
    ...typography.label,
    color: colors.accentStrong,
    fontWeight: '700',
    fontSize: 15,
    lineHeight: 17,
  },
  frontText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600',
    fontSize: 12,
    lineHeight: 16,
  },
  stage: {
    position: 'relative',
    alignSelf: 'center',
    /* The floor above can exceed a very narrow container for one frame,
       before onLayout has reported it. This keeps the drawing inside its
       box in that frame rather than painting over its neighbours. */
    maxWidth: '100%',
  },
  arm: {
    position: 'absolute',
    height: 3,
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    transformOrigin: 'left center',
  },
  hubBody: {
    position: 'absolute',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  wing: {
    position: 'absolute',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.sm,
  },
  fuselage: {
    position: 'absolute',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.pill,
  },
  motorNode: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  motorNodeSelected: {
    borderColor: colors.accentStrong,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  motorNodeVerified: {
    borderColor: colors.success,
  },
  motorNodeLive: {
    borderWidth: 2,
  },
  stackRing: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    left: -4,
    right: -4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rotor: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rotorActive: {
    opacity: 1,
  },
  blade: {
    position: 'absolute',
    backgroundColor: colors.textMuted,
    borderRadius: 2,
  },
  hub: {
    backgroundColor: colors.textSecondary,
  },
  slotRow: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 14,
    writingDirection: 'ltr',
    textAlign: 'center',
  },
  slot: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 14,
  },
  slotStacked: {
    fontSize: 10,
    lineHeight: 12,
  },
  slotSelected: {
    color: colors.accentStrong,
  },
  stateDot: {
    position: 'absolute',
    top: 3,
    insetInlineEnd: 3,
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  servoMark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  servoGlyph: {
    width: 12,
    height: 5,
    borderRadius: 1,
    backgroundColor: colors.textSecondary,
  },
  servoText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 13,
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  liveState: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
    textAlign: 'center',
  },
});
