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
 * WHAT IT DRAWS ABOUT ROTATION, AND WHAT IT NEVER CLAIMS - M-F2. Each
 * single-rotor node may carry an EXPECTED rotation arrow, derived in
 * motorExpectedRotation.ts from the firmware mixer table's yaw column and
 * the stored yaw_motors_reversed flag. That is a statement about the
 * CONFIGURATION - the same kind the positions make - and the caption says
 * so in words. The ACTUAL rotation of a propeller is still not readable
 * over MSP at API 1.47, is never claimed here, and is established only by
 * a person watching the aircraft in the verification workflow. Where the
 * mixer does not determine a direction (a tricopter's motors, a custom
 * mixer) or the flag is unread, no arrow renders - absence, not a guess.
 *
 * COAXIAL AIRCRAFT ARE DRAWN AS COAXIAL - AND EVERY MOTOR IS ITS OWN
 * NODE (M-F3 §24). A Y6 is not a flat hexacopter and an X8 is not a flat
 * octocopter; they carry two rotors per arm. Each rotor renders as its
 * own full-size disc: the UPPER at the arm tip, the LOWER pulled inward
 * along the same arm, visually under its partner. Six motors are six
 * targets and eight are eight - a merged "M1/4" disc was rejected in the
 * M-F3 release review because it made two independent motors one
 * ambiguous control. Both discs keep the full 44px touch target; the
 * stage clearance is computed per ARM, so the pair's deliberate
 * closeness does not inflate the drawing.
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
import {Icon} from '../icons';
import {expectedMotorRotation} from '../../core/state/motorExpectedRotation';
import {
  authoredAirframeLayout,
  stationOf,
  verificationPositionOf,
} from '../../core/state/motorAirframeLayout';
import type {
  AirframeDeck,
  AirframeLayout,
  AirframeStation,
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
   * MSP_MIXER_CONFIG offset 1 - the stored props-in / props-out flag.
   * Half of the expected-rotation answer: with it unread the arrows are
   * withheld entirely, because the flag flips every one of them.
   */
  readonly yawMotorsReversed?: boolean;
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
const NODE_CLEARANCE = 56;
/**
 * The smallest and largest square the stage may occupy.
 *
 * The ceiling is the whole point of M-E §0-§3: past this the drawing stops
 * carrying more information and starts being a large picture of some
 * circles, and the controls it exists to serve go below the fold.
 */
export const MOTOR_AIRFRAME_STAGE_MIN_WIDTH = 150;
export const MOTOR_AIRFRAME_STAGE_MAX_WIDTH = 240;
/** The phone ceiling. A 240px square on a 390px page is a third of the
 *  height above the controls; 190 keeps the model readable and the Motor
 *  Test reachable - the M-F2 §6 middle ground, measured not asserted. */
export const MOTOR_AIRFRAME_STAGE_MAX_WIDTH_COMPACT = 190;
/** Below this window width the compact ceiling applies. */
export const MOTOR_AIRFRAME_PHONE_WINDOW_WIDTH = 600;
export const MOTOR_AIRFRAME_STAGE_ASPECT_RATIO = 1;

/** One motor node's place in the stage, in normalised -1..1 space. */
interface DiagramNode {
  /** THE motor this node stands for. M-F3 §24/§26: every motor is its
   * own node - a coaxial pair is two nodes sharing an arm, never one
   * circle wearing two numbers. Kept as a one-element array so the many
   * callers that read `slots[0]` did not all have to move at once. */
  readonly slots: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly station: AirframeStation;
  /** SINGLE for a flat arm; UPPER/LOWER for the two rotors of a coaxial
   * arm, straight from the authored layout's firmware comments. */
  readonly deck: AirframeDeck;
  /** The arm this node sits on - both rotors of a coaxial pair share it.
   * Arms, not nodes, drive the silhouette and the clearance rule. */
  readonly armKey: string;
}

/**
 * Turns a layout into the nodes that will actually be drawn, with the
 * coordinates normalised so the outermost motor touches the stage edge.
 *
 * M-F3 §24/§26 - ONE NODE PER MOTOR, ALWAYS. The M-E compaction merged a
 * coaxial pair into one pressable circle labelled "M1/4"; the release
 * review rejected that outright: M4 must be selectable without selecting
 * M1, carry its own number and its own expected-rotation mark. The two
 * rotors still SHARE an arm (same authored x, y) - the stacked drawing
 * happens at render time from `deck`, never by merging identities.
 */
export function computeDiagramNodes(layout: AirframeLayout): readonly DiagramNode[] {
  const extent = layout.placements.reduce(
    (widest, placement) =>
      Math.max(widest, Math.abs(placement.x), Math.abs(placement.y)),
    0,
  );
  const scale = extent === 0 ? 1 : 1 / extent;
  return Object.freeze(
    [...layout.placements]
      .sort((left, right) => left.motorNumber - right.motorNumber)
      .map(placement =>
        Object.freeze({
          slots: Object.freeze([placement.motorNumber]),
          x: placement.x * scale,
          y: placement.y * scale,
          station: stationOf(placement),
          deck: placement.deck,
          armKey: `${placement.x.toFixed(4)},${placement.y.toFixed(4)}`,
        }),
      ),
  );
}

/** The arms of a layout: one entry per authored (x, y) station, shared by
 * both rotors of a coaxial pair. The silhouette draws these; the stage
 * clearance rule separates these - a coaxial pair is DELIBERATELY close,
 * so it must not inflate the stage the way two flat arms would. */
function armPositions(
  nodes: readonly DiagramNode[],
): readonly {readonly x: number; readonly y: number; readonly armKey: string}[] {
  const seen = new Map<string, {x: number; y: number; armKey: string}>();
  for (const node of nodes) {
    if (!seen.has(node.armKey)) {
      seen.set(node.armKey, {x: node.x, y: node.y, armKey: node.armKey});
    }
  }
  return Object.freeze([...seen.values()]);
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
  /* Clearance separates ARMS, never the two rotors of one coaxial arm:
     those are stacked on purpose, and measuring their (near-zero) spacing
     here would inflate the stage to push apart what belongs together. */
  const arms = armPositions(computeDiagramNodes(layout));
  let closest = Number.POSITIVE_INFINITY;
  for (let left = 0; left < arms.length; left += 1) {
    for (let right = left + 1; right < arms.length; right += 1) {
      const dx = arms[left].x - arms[right].x;
      const dy = arms[left].y - arms[right].y;
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
  /* M-F2 §5/§52: the body reads as a flight controller plate, not a dot.
     Sized from the stage so the 240px desktop model and the 190px phone
     model keep the same proportions. */
  const hub = Math.round(stage * 0.24);
  if (layout.silhouette === 'ROTARY') {
    /* One arm PER STATION: a coaxial pair shares its arm, so drawing per
       node would paint the same line twice. */
    const arms = armPositions(nodes);
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="motors-diagram-body">
        {arms.map(arm => {
          const length = Math.hypot(arm.x, arm.y) * reach;
          if (length < 1) {
            return null;
          }
          const angle = (Math.atan2(arm.y, arm.x) * 180) / Math.PI;
          return (
            <View
              key={`arm-${arm.armKey}`}
              style={[
                styles.arm,
                {
                  width: length,
                  left: stage / 2,
                  top: stage / 2 - 3,
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

/* M-F3 §21/§22 - THE FRONT BELONGS TO THE AIRCRAFT.
   A detached "المقدمة ↑" caption above the drawing was rejected in the
   release review: orientation is a property of the airframe, so the
   nose pointer is drawn FROM the body, along the aircraft's own
   forward axis. Positions are physical left/top - an RTL interface
   mirrors reading order, never which way this aircraft flies.

   IT PAINTS ABOVE THE MOTOR NODES. On a Y6 the two inward lower discs
   flank the hub top and were measured (Chromium, 240px stage) covering
   3.5px of each end of the nose word - enough to eat the outer glyphs.
   The word carries meaning and a disc edge is periphery, so the pointer
   is its own stage layer after the nodes, and the word sits on a small
   surface chip. It never overlaps any M-number or rotation mark; those
   live at the disc centres and outward corners. */
function NosePointer({
  layout,
  stage,
}: {
  layout: AirframeLayout;
  stage: number;
}): React.JSX.Element {
  const {t} = useTranslation();
  const hub = Math.round(stage * 0.24);
  const noseTip = layout.silhouette === 'ROTARY' ? (stage - hub) / 2 - stage * 0.14 : stage * 0.03;
  const noseBase = layout.silhouette === 'ROTARY' ? (stage - hub) / 2 + 2 : stage * 0.14;
  return (
    <View
      pointerEvents="none"
      style={[styles.frontPointer, {top: noseTip, height: Math.max(10, noseBase - noseTip)}]}
      testID="motors-diagram-front"
    >
      <View style={styles.frontHead} />
      <View style={[styles.frontShaft, {height: Math.max(4, noseBase - noseTip - 9)}]} />
      <Text style={styles.frontText}>{t('motorsScreen.diagramFront')}</Text>
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
  expectedRotation,
}: {
  node: DiagramNode;
  stage: number;
  selectedSlot: number;
  liveSlot: number | undefined;
  liveActivity: MotorSlotActivity | undefined;
  verifiedSlots: readonly number[];
  onSelectSlot: (slot: number) => void;
  /** The EXPECTED rotation for THIS rotor, if the mixer determines one.
   * Every motor is its own node now - a coaxial pair is two nodes on one
   * arm - so each rotor of a counter-rotating pair carries its own mark. */
  expectedRotation: 'CW' | 'CCW' | undefined;
}): React.JSX.Element {
  const {t} = useTranslation();
  const slot = node.slots[0];
  const reach = (stage - NODE_SIZE) / 2;
  /* A LOWER rotor sits under the UPPER one on the same arm. On a flat
   * drawing "under" is drawn as INWARD: the lower disc is pulled toward
   * the hub along its own arm by exactly one node size, so the two discs
   * TOUCH without overlapping - the §61 screenshot review caught the
   * previous 0.72 pull hiding the lower motor's number behind the upper
   * disc on a vertical arm. Touching still reads as one stacked pair;
   * both numbers stay fully legible; both stay full 44px targets. The
   * pull is a vector in frame geometry, so RTL cannot mirror it. */
  const armLength = Math.hypot(node.x, node.y);
  const inward = node.deck === 'LOWER' && armLength > 0 ? NODE_SIZE : 0;
  const dx = armLength > 0 ? (-node.x / armLength) * inward : 0;
  const dy = armLength > 0 ? (-node.y / armLength) * inward : 0;
  const left = stage / 2 + node.x * reach - NODE_SIZE / 2 + dx;
  const top = stage / 2 + node.y * reach - NODE_SIZE / 2 + dy;
  const selectedHere = slot === selectedSlot;
  const liveHere = liveSlot === slot;
  const verifiedHere = verifiedSlots.includes(slot);
  const activity = liveHere ? liveActivity : undefined;
  const badge =
    activity !== undefined
      ? {text: t(activityLabelKey(activity)), color: activityColor(activity)}
      : verifiedHere
      ? {text: t('motorsScreen.slotStateObserved'), color: colors.success}
      : undefined;

  const spokenStation = t(`motorsScreen.${stationKey(node.station)}`);
  const spokenDeck =
    node.deck === 'SINGLE'
      ? ''
      : ` ${t(
          node.deck === 'UPPER'
            ? 'motorsScreen.deckUpper'
            : 'motorsScreen.deckLower',
        )}`;
  const spokenRotation =
    expectedRotation === undefined
      ? ''
      : `، ${t('motorsScreen.expectedRotationLabel')}: ${t(
          expectedRotation === 'CW'
            ? 'motorsScreen.expectedRotationCw'
            : 'motorsScreen.expectedRotationCcw',
        )}`;

  return (
    <Pressable
      onPress={() => onSelectSlot(slot)}
      accessibilityRole="radio"
      accessibilityState={{selected: selectedHere}}
      // The station IS spoken: a screen-reader user cannot see where the
      // node sits on the frame - and on a coaxial arm the deck is part
      // of the position. Rotation is spoken only where a source
      // determines it; nothing invents one.
      accessibilityLabel={`M${slot}${spokenDeck}، ${spokenStation}${spokenRotation}${
        badge === undefined ? '' : `، ${badge.text}`
      }`}
      style={[
        styles.motorNode,
        {left, top, width: NODE_SIZE, height: NODE_SIZE},
        /* Draw order on a coaxial arm: the upper disc wins where the two
         * overlap, and selecting either lifts it above both. */
        {zIndex: (node.deck === 'LOWER' ? 1 : 2) + (selectedHere ? 2 : 0)},
        node.deck === 'LOWER' && styles.motorNodeLowerDeck,
        selectedHere && styles.motorNodeSelected,
        verifiedHere && styles.motorNodeVerified,
        activity !== undefined && styles.motorNodeLive,
        activity !== undefined && {borderColor: activityColor(activity)},
      ]}
      testID={`motors-airframe-slot-${slot}`}
    >
      <RotorGlyph size={Math.round(NODE_SIZE * 0.5)} active={activity !== undefined} />
      <Text style={styles.slotRow} numberOfLines={1}>
        <Text
          style={[styles.slot, selectedHere && styles.slotSelected]}
          testID={`motors-diagram-slot-${slot}`}
        >
          {`M${slot}`}
        </Text>
      </Text>
      {badge === undefined ? null : (
        <View
          style={[styles.stateDot, {backgroundColor: badge.color}]}
          testID={`motors-diagram-state-${slot}`}
        />
      )}
      {/* THE EXPECTED-ROTATION MARK - M-F2 §17, per motor since M-F3 §51.
          A physical claim about geometry, so it is positioned with
          physical offsets and its glyph is a raw (never RTL-aliased)
          icon: a clockwise arrow must render clockwise in an Arabic
          interface exactly as in any other. It states the CONFIGURED
          expectation; the caption under the stage says so in words. On a
          coaxial arm the two discs carry two independent marks in
          opposite corners, so neither covers the other. */}
      {expectedRotation === undefined ? null : (
        <View
          pointerEvents="none"
          style={
            node.deck === 'LOWER' ? styles.rotationMarkLower : styles.rotationMark
          }
          testID={`motors-expected-rotation-${slot}`}
          accessibilityElementsHidden
        >
          <Icon
            name={expectedRotation === 'CW' ? 'rotate-cw' : 'rotate-ccw'}
            size={14}
            strokeWidth={2.25}
            color={selectedHere ? colors.accentStrong : colors.textSecondary}
          />
        </View>
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
  yawMotorsReversed,
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
  /*
   * NOTHING READ IS NOT THE SAME AS NOTHING DRAWABLE - M-E2.
   *
   * `motorNumbers` is documented above as "an empty array means nothing
   * has been read, and renders as nothing", and for a long time it did
   * not: the layout lookup ran first, missed, and answered with the
   * generic caption - a sentence about "this Mixer" on a screen where no
   * mixer had been read either. On a desktop that paragraph then held a
   * 619px column open on its own.
   *
   * An empty list is the absence of a question, not the answer to one.
   * The session and arming notices above already explain why nothing has
   * been read; this component adds nothing and says nothing.
   */
  if (motorNumbers.length === 0) {
    return null;
  }
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
  /*
   * M-F2 §6/§29 - THE MODEL GROWS INTO ITS COLUMN, TO A CEILING.
   *
   * The M-E sizing took the smallest stage the geometry allowed, which on
   * a 1366 desktop put a 128px drawing in a 600px column - a model "too
   * small and almost useless", in the review's words. The two failure
   * modes bracket the rule: the OLD model filled the column and pushed
   * the controls below the fold; the M-E model minimised itself into
   * decoration. So the stage now FILLS the width it is actually given,
   * bounded by a ceiling per device class (240 desktop, 190 phone), and
   * never below the geometric minimum the touch targets need. The
   * override still pins a deliberate second copy small.
   */
  const ceiling =
    Number.isFinite(windowWidth) && windowWidth < MOTOR_AIRFRAME_PHONE_WINDOW_WIDTH
      ? MOTOR_AIRFRAME_STAGE_MAX_WIDTH_COMPACT
      : MOTOR_AIRFRAME_STAGE_MAX_WIDTH;
  const grown = Math.min(ceiling, roomy, inBox);
  const stage = Math.round(
    Math.max(
      MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
      derived,
      Math.min(stageWidthOverride ?? grown, roomy, inBox),
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
      {/* THE FRONT MARKER LIVES ON THE AIRCRAFT - M-F3 §21.
          It used to be a floating chip above the stage; a floating arrow
          near a drawing is furniture. The Silhouette now grows it out of
          the nose, so "front" is a property of the airframe geometry -
          and, like every position here, it is physical: RTL never
          mirrors it. */}
      <View
        style={[styles.stage, {width: stage, height: stage}]}
        testID="motors-airframe-stage"
      >
        <Silhouette layout={layout} nodes={nodes} stage={stage} />
        {nodes.map(node => (
          <MotorNode
            key={node.slots[0]}
            node={node}
            stage={stage}
            selectedSlot={selectedSlot}
            liveSlot={liveSlot}
            liveActivity={liveActivity}
            verifiedSlots={verifiedSlots}
            onSelectSlot={onSelectSlot}
            expectedRotation={expectedMotorRotation(
              mixerModeRaw,
              node.slots[0],
              yawMotorsReversed,
            )}
          />
        ))}
        <NosePointer layout={layout} stage={stage} />
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
  /* The nose pointer is part of the aircraft: an arrowhead and shaft
     growing forward out of the body, with the word under it. All
     physical positions - `left`/`right`, never `start`/`end` - because
     which way the aircraft flies is not a property of the script. */
  frontPointer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    /* Above every node deck (their zIndex tops out at 4): the nose word
       must never lose to a disc edge. pointerEvents stays 'none', so
       the discs under it remain fully tappable. */
    zIndex: 5,
  },
  frontHead: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.accentStrong,
  },
  frontShaft: {
    width: 2.5,
    borderRadius: 1,
    backgroundColor: colors.accentStrong,
  },
  frontText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600',
    fontSize: 10,
    lineHeight: 13,
    /* A small surface chip so the word stays readable where a coaxial
       lower disc passes beneath it. */
    backgroundColor: colors.surface,
    paddingHorizontal: 3,
    borderRadius: 4,
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
    height: 6,
    backgroundColor: colors.borderStrong,
    borderRadius: 3,
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
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  rotationMark: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    padding: 1,
  },
  /* The LOWER rotor of a coaxial pair keeps its mark in the OPPOSITE
     corner, so the two independent marks on one arm never cover each
     other. Physical offsets, like the mark above. */
  rotationMarkLower: {
    position: 'absolute',
    bottom: -8,
    left: -8,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    padding: 1,
  },
  /* A lower-deck disc reads as sitting UNDER its partner: softer border,
     the sunken surface tone - but the same size, because it is the same
     kind of thing and the same touch target. */
  motorNodeLowerDeck: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
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
    fontSize: 13,
    lineHeight: 15,
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
