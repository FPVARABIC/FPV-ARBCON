/**
 * M-E §19 - THIS APPLICATION'S OWN AIRFRAME LAYOUTS.
 *
 * WHAT A LAYOUT IS FOR. A pilot who knows only "my drone is a hexacopter"
 * must be able to look at the screen, see a hexacopter, and point at the
 * motor they want to test. Until M-E only two mixers had a drawing and
 * every other aircraft - including the whole hex and octo families - was
 * answered with a numbered list and a paragraph explaining why. The list
 * was honest. It was also not an aircraft.
 *
 * WHERE THE POSITIONS COME FROM, AND WHY THEY ARE NOT INVENTED.
 *
 * mixer_init.c @ 7348054f gives every mixer a table of per-motor mixing
 * coefficients { throttle, roll, pitch, yaw }. The roll and pitch entries
 * ARE the motor's moment arms about those two axes, so they are a direct
 * statement of where on the airframe the motor sits:
 *
 *     x =  -roll      +1 is the right-hand side
 *     y =  +pitch     +1 is the tail
 *
 * The sign convention is fixed by the firmware's own comments rather than
 * assumed. mixerQuadP[] (line 97) labels { roll 0, pitch +1 } as REAR and
 * { roll -1, pitch 0 } as RIGHT, and every other table in the file agrees.
 * Each layout below quotes the table it was read from, and a test derives
 * the station names again and checks them against those comments.
 *
 * A LAYOUT DESCRIBES PLACES, AND NOTHING ELSE.
 *
 *  - IT CARRIES NO ROTATION DIRECTION. Not CW, not CCW, not props-out.
 *    Actual propeller rotation is not readable as authoritative truth over
 *    MSP and a mixer mode does not determine it. There is no field for it
 *    and a test enforces that. The yaw coefficient is deliberately NOT
 *    read here, in either direction, for exactly that reason.
 *  - IT CARRIES NO PHYSICAL PIN. Which timer output drives which motor is
 *    the output-reordering question, answered elsewhere.
 *  - NOTHING HERE IS COPIED. No Betaflight SVG, GLTF, stylesheet, image or
 *    coordinate set was consulted or reused. The only thing read from the
 *    reference implementation is the arithmetic quoted above, which is
 *    firmware rather than artwork.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY. Six modes the firmware knows are
 * NOT authored here because their tables do not say where the motors are:
 *
 *   HEX6H         its RIGHT and LEFT motors are { roll 0, pitch 0 } - two
 *                 motors at the origin, no arm, no position (line 136).
 *   DUALCOPTER    both motors { roll 0, pitch 0 } (line 231).
 *   SINGLECOPTER  mixers[21] has a NULL motor table.
 *   HELI_120 /    a single centre motor, but a helicopter is not a motor
 *   HELI_90       map and no rotorcraft silhouette has been authored.
 *   CUSTOM*       the rows live in customMotorMixer and are CLI-only.
 *
 * Those fall back to the numbered presentation, which is a correct answer
 * rather than a degraded one. Adding a mixer here means authoring and
 * checking a layout, never relaxing a condition.
 */

import type {MotorPhysicalPosition} from './motorVerificationModel';

/**
 * Where a motor sits on the planform, looking down with the nose up.
 *
 * DERIVED from the placement's coordinates by `stationOf` below, never
 * stored, so a station and the position it is drawn at cannot drift apart.
 * The vocabulary is finer than a quad needs because an OCTOFLATX carries
 * two motors down each side and both would otherwise be "front left".
 */
export type AirframeStation =
  | 'FRONT'
  | 'FRONT_LEFT'
  | 'FRONT_RIGHT'
  | 'MIDFRONT_LEFT'
  | 'MIDFRONT_RIGHT'
  | 'LEFT'
  | 'RIGHT'
  | 'MIDREAR_LEFT'
  | 'MIDREAR_RIGHT'
  | 'REAR'
  | 'REAR_LEFT'
  | 'REAR_RIGHT'
  | 'CENTRE';

/**
 * Which rotor of a coaxial pair.
 *
 * A Y6 is not a flat hexacopter and an X8 is not a flat octocopter: they
 * carry two motors on each arm, one above the other. The firmware says so
 * in the only way it can - the UNDER_ prefix on the lower motor's comment
 * - and drawing six or eight separate arms would be a lie about the
 * aircraft. SINGLE means the station carries one motor.
 */
export type AirframeDeck = 'SINGLE' | 'UPPER' | 'LOWER';

/** What the airframe's non-motor actuators do, where the firmware's mixer
 *  table says it has any. Informational only: this application never
 *  commands a servo, and a servo is never offered as a motor. */
export type AirframeServoRole =
  | 'TAIL_YAW'
  | 'ROTOR_TILT'
  | 'ELEVONS'
  | 'CONTROL_SURFACES';

/** How to draw the body under the motors. */
export type AirframeSilhouette = 'ROTARY' | 'WING' | 'PLANE';

/** One motor's place on the frame. Deliberately not named a "node": it is
 *  a claim about an aircraft, not about a drawing. */
export interface MotorAirframePlacement {
  /** MSP output slot, 1-based. Never reordered for a right-to-left
   *  interface - see motorAirframeRtl in the diagram's own tests. */
  readonly motorNumber: number;
  /** -1 is the left-hand side, +1 the right. Equals -roll. */
  readonly x: number;
  /** -1 is the nose, +1 the tail. Equals +pitch. */
  readonly y: number;
  readonly deck: AirframeDeck;
}

export interface AirframeLayout {
  readonly placements: readonly MotorAirframePlacement[];
  readonly silhouette: AirframeSilhouette;
  /** Absent where mixers[mode].useServo is false. */
  readonly servoRole?: AirframeServoRole;
  /** True where any station carries two motors. */
  readonly coaxial: boolean;
}

const place = (
  motorNumber: number,
  x: number,
  y: number,
  deck: AirframeDeck = 'SINGLE',
): MotorAirframePlacement => Object.freeze({motorNumber, x, y, deck});

const layout = (
  placements: readonly MotorAirframePlacement[],
  silhouette: AirframeSilhouette,
  servoRole?: AirframeServoRole,
): AirframeLayout =>
  Object.freeze({
    placements: Object.freeze(placements),
    silhouette,
    ...(servoRole === undefined ? {} : {servoRole}),
    coaxial: placements.some(candidate => candidate.deck !== 'SINGLE'),
  });

/* Mixer ids, from mixerMode_e (mixer.h @ 7348054f). Spelled out here so a
 * reader of this table does not have to hold the enum in their head. */
const TRI = 1;
const QUADP = 2;
const QUADX = 3;
const BICOPTER = 4;
const Y6 = 6;
const HEX6 = 7;
const FLYING_WING = 8;
const Y4 = 9;
const HEX6X = 10;
const OCTOX8 = 11;
const OCTOFLATP = 12;
const OCTOFLATX = 13;
const AIRPLANE = 14;
const VTAIL4 = 17;
const ATAIL4 = 22;
const QUADX_1234 = 26;
const OCTOX8P = 27;

/**
 * The layouts this project has authored and checked, by mixer id.
 *
 * Each entry names the firmware table it was read from. The comment beside
 * each motor is the firmware's OWN label for that row, kept so the derived
 * station can be checked against it rather than trusted.
 */
const AUTHORED: ReadonlyMap<number, AirframeLayout> = new Map<number, AirframeLayout>([
  [
    // mixerTricopter[] - mixer_init.c:91-95. The tail servo yaws the
    // aircraft; it is drawn, and it is never a motor.
    TRI,
    layout(
      [
        place(1, 0, 1.333333), //  REAR
        place(2, 1, -0.666667), //  RIGHT  - forward of the centre of mass
        place(3, -1, -0.666667), //  LEFT
      ],
      'ROTARY',
      'TAIL_YAW',
    ),
  ],
  [
    // mixerQuadP[] - mixer_init.c:97-102.
    QUADP,
    layout(
      [
        place(1, 0, 1), //  REAR
        place(2, 1, 0), //  RIGHT
        place(3, -1, 0), //  LEFT
        place(4, 0, -1), //  FRONT
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerQuadX[] - mixer_init.c:84-89.
    QUADX,
    layout(
      [
        place(1, 1, 1), //  REAR_R
        place(2, 1, -1), //  FRONT_R
        place(3, -1, 1), //  REAR_L
        place(4, -1, -1), //  FRONT_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerBicopter[] - mixer_init.c:105-108. Two tilting rotors.
    BICOPTER,
    layout(
      [
        place(1, -1, 0), //  LEFT
        place(2, 1, 0), //  RIGHT
      ],
      'ROTARY',
      'ROTOR_TILT',
    ),
  ],
  [
    // mixerY6[] - mixer_init.c:148-155. Three arms, two rotors each.
    Y6,
    layout(
      [
        place(1, 0, 1.333333, 'UPPER'), //  REAR
        place(2, 1, -0.666667, 'UPPER'), //  RIGHT
        place(3, -1, -0.666667, 'UPPER'), //  LEFT
        place(4, 0, 1.333333, 'LOWER'), //  UNDER_REAR
        place(5, 1, -0.666667, 'LOWER'), //  UNDER_RIGHT
        place(6, -1, -0.666667, 'LOWER'), //  UNDER_LEFT
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerHex6P[] - mixer_init.c:140-147. The "+" hex: two arms on the
    // centreline, four at sixty degrees.
    HEX6,
    layout(
      [
        place(1, 0.866025, 0.5), //  REAR_R
        place(2, 0.866025, -0.5), //  FRONT_R
        place(3, -0.866025, 0.5), //  REAR_L
        place(4, -0.866025, -0.5), //  FRONT_L
        place(5, 0, -1), //  FRONT
        place(6, 0, 1), //  REAR
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerSingleProp[] - mixer_init.c:239-241, via mixers[8]. One motor,
    // no moment arm, and two elevon servos this application never writes.
    FLYING_WING,
    layout([place(1, 0, 0)], 'WING', 'ELEVONS'),
  ],
  [
    // mixerY4[] - mixer_init.c:113-118. Two front arms and a coaxial tail.
    Y4,
    layout(
      [
        place(1, 0, 1, 'UPPER'), //  REAR_TOP
        place(2, 1, -1), //  FRONT_R
        place(3, 0, 1, 'LOWER'), //  REAR_BOTTOM
        place(4, -1, -1), //  FRONT_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerHex6X[] - mixer_init.c:121-128.
    HEX6X,
    layout(
      [
        place(1, 0.5, 0.866025), //  REAR_R
        place(2, 0.5, -0.866025), //  FRONT_R
        place(3, -0.5, 0.866025), //  REAR_L
        place(4, -0.5, -0.866025), //  FRONT_L
        place(5, 1, 0), //  RIGHT
        place(6, -1, 0), //  LEFT
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerOctoX8[] - mixer_init.c:166-175. Four arms, two rotors each.
    OCTOX8,
    layout(
      [
        place(1, 1, 1, 'UPPER'), //  REAR_R
        place(2, 1, -1, 'UPPER'), //  FRONT_R
        place(3, -1, 1, 'UPPER'), //  REAR_L
        place(4, -1, -1, 'UPPER'), //  FRONT_L
        place(5, 1, 1, 'LOWER'), //  UNDER_REAR_R
        place(6, 1, -1, 'LOWER'), //  UNDER_FRONT_R
        place(7, -1, 1, 'LOWER'), //  UNDER_REAR_L
        place(8, -1, -1, 'LOWER'), //  UNDER_FRONT_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerOctoFlatP[] - mixer_init.c:188-197. Eight arms in one plane.
    OCTOFLATP,
    layout(
      [
        place(1, -0.707107, -0.707107), //  FRONT_L
        place(2, 0.707107, -0.707107), //  FRONT_R
        place(3, 0.707107, 0.707107), //  REAR_R
        place(4, -0.707107, 0.707107), //  REAR_L
        place(5, 0, -1), //  FRONT
        place(6, 1, 0), //  RIGHT
        place(7, 0, 1), //  REAR
        place(8, -1, 0), //  LEFT
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerOctoFlatX[] - mixer_init.c:199-208. Eight arms in one plane,
    // rotated so that two sit down each side rather than on the axes.
    OCTOFLATX,
    layout(
      [
        place(1, -1, -0.414178), //  MIDFRONT_L
        place(2, 0.414178, -1), //  FRONT_R
        place(3, 1, 0.414178), //  MIDREAR_R
        place(4, -0.414178, 1), //  REAR_L
        place(5, -0.414178, -1), //  FRONT_L
        place(6, 1, -0.414178), //  MIDFRONT_R
        place(7, 0.414178, 1), //  REAR_R
        place(8, -1, 0.414178), //  MIDREAR_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerSingleProp[] via mixers[14]. One motor and six control-surface
    // servo channels this application never writes.
    AIRPLANE,
    layout([place(1, 0, 0)], 'PLANE', 'CONTROL_SURFACES'),
  ],
  [
    // mixerVtail4[] - mixer_init.c:216-221. The rear pair is swept back
    // and canted; the planform positions are still the four corners, and
    // the asymmetric pitch arms below are the firmware's own numbers.
    VTAIL4,
    layout(
      [
        place(1, 0.58, 0.58), //  REAR_R
        place(2, 0.46, -0.39), //  FRONT_R
        place(3, -0.58, 0.58), //  REAR_L
        place(4, -0.46, -0.39), //  FRONT_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerAtail4[] - mixer_init.c:223-228.
    ATAIL4,
    layout(
      [
        place(1, 0.58, 0.58), //  REAR_R
        place(2, 0.46, -0.39), //  FRONT_R
        place(3, -0.58, 0.58), //  REAR_L
        place(4, -0.46, -0.39), //  FRONT_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerQuadX1234[] - mixer_init.c:243-248. NOT the QUADX row above
    // with the numbers shuffled by an editor: it is the firmware's own
    // second table, and it exists precisely because some builds number
    // their arms clockwise from the front left. Motor 1 is at the BACK
    // RIGHT on a QUADX and at the FRONT LEFT here.
    QUADX_1234,
    layout(
      [
        place(1, -1, -1), //  FRONT_L
        place(2, 1, -1), //  FRONT_R
        place(3, 1, 1), //  REAR_R
        place(4, -1, 1), //  REAR_L
      ],
      'ROTARY',
    ),
  ],
  [
    // mixerOctoX8P[] - mixer_init.c:177-186. A "+" X8: four arms on the
    // axes, two rotors each.
    OCTOX8P,
    layout(
      [
        place(1, 0, 1, 'UPPER'), //  REAR
        place(2, 1, 0, 'UPPER'), //  RIGHT
        place(3, -1, 0, 'UPPER'), //  LEFT
        place(4, 0, -1, 'UPPER'), //  FRONT
        place(5, 0, 1, 'LOWER'), //  UNDER_REAR
        place(6, 1, 0, 'LOWER'), //  UNDER_RIGHT
        place(7, -1, 0, 'LOWER'), //  UNDER_LEFT
        place(8, 0, -1, 'LOWER'), //  UNDER_FRONT
      ],
      'ROTARY',
    ),
  ],
]);

/**
 * The station a placement occupies, from its coordinates alone.
 *
 * Sector boundaries are chosen so that every authored layout resolves to
 * distinct (station, deck) pairs and so that the firmware's own labels are
 * reproduced where they are positional. The two boundaries that matter:
 * a HEX6 arm sits at exactly 60 degrees and must read FRONT_RIGHT rather
 * than MIDFRONT_RIGHT, and an OCTOFLATX carries motors at 22.5 and 67.5
 * degrees which must not collapse to the same name.
 */
export function stationOf(placement: MotorAirframePlacement): AirframeStation {
  const {x, y} = placement;
  if (x === 0 && y === 0) {
    return 'CENTRE';
  }
  // Bearing from the nose, positive towards the right-hand side.
  const bearing = (Math.atan2(x, -y) * 180) / Math.PI;
  const magnitude = Math.abs(bearing);
  const side = bearing >= 0 ? 'RIGHT' : 'LEFT';
  if (magnitude < 15) {
    return 'FRONT';
  }
  if (magnitude >= 165) {
    return 'REAR';
  }
  if (magnitude <= 60) {
    return side === 'RIGHT' ? 'FRONT_RIGHT' : 'FRONT_LEFT';
  }
  if (magnitude < 82.5) {
    return side === 'RIGHT' ? 'MIDFRONT_RIGHT' : 'MIDFRONT_LEFT';
  }
  if (magnitude < 97.5) {
    return side;
  }
  if (magnitude < 120) {
    return side === 'RIGHT' ? 'MIDREAR_RIGHT' : 'MIDREAR_LEFT';
  }
  return side === 'RIGHT' ? 'REAR_RIGHT' : 'REAR_LEFT';
}

/**
 * The four-corner position vocabulary the Quad X verification model speaks,
 * for a placement that has one.
 *
 * Returns undefined for any station outside those four corners and for
 * either half of a coaxial pair, because "front left" does not identify a
 * motor when two of them are stacked there.
 */
export function verificationPositionOf(
  placement: MotorAirframePlacement,
): MotorPhysicalPosition | undefined {
  if (placement.deck !== 'SINGLE') {
    return undefined;
  }
  switch (stationOf(placement)) {
    case 'FRONT_LEFT':
      return 'FRONT_LEFT';
    case 'FRONT_RIGHT':
      return 'FRONT_RIGHT';
    case 'REAR_LEFT':
      return 'REAR_LEFT';
    case 'REAR_RIGHT':
      return 'REAR_RIGHT';
    default:
      return undefined;
  }
}

/**
 * The authored layout for a mixer, IF it matches the aircraft in front of
 * us.
 *
 * Returns undefined - meaning "draw a numbered list" - when:
 *   - the mixer id is unknown or has no authored layout;
 *   - the runtime motor count is not yet known;
 *   - the running firmware reported a DIFFERENT number of motors than the
 *     layout describes. A six-place drawing cannot represent a machine
 *     that reported eight, and the mixer byte is not the authority on that
 *     count - MSP_MOTOR_CONFIG is.
 *
 * The last condition is the one that matters in practice: a mixer changed
 * without the reboot mixerInit() needs leaves the mixer byte and the motor
 * count disagreeing, and the drawing is the wrong thing to trust.
 */
export function authoredAirframeLayout(
  mixerModeRaw: number | undefined,
  motorNumbers: readonly number[],
): AirframeLayout | undefined {
  if (mixerModeRaw === undefined || motorNumbers.length === 0) {
    return undefined;
  }
  const found = AUTHORED.get(mixerModeRaw);
  if (found === undefined || found.placements.length !== motorNumbers.length) {
    return undefined;
  }
  // The layout describes motors 1..N; the caller's list must be the same
  // set. A mismatch means one of the two was built from something other
  // than the runtime count, and drawing either would be a guess.
  const expected = found.placements.map(placement => placement.motorNumber).join(',');
  if (expected !== [...motorNumbers].join(',')) {
    return undefined;
  }
  return found;
}

/** Whether a mixer has an authored layout at all, independent of any
 *  particular aircraft. Used by tests and by the presentation layer's
 *  own gate; callers deciding what to DRAW should use
 *  authoredAirframeLayout, which also checks the count. */
export function mixerHasAuthoredLayout(mixerModeRaw: number | undefined): boolean {
  return mixerModeRaw !== undefined && AUTHORED.has(mixerModeRaw);
}

/** Every mixer id this file draws. Exported so the reference model's own
 *  claim can be checked against the artwork that actually exists, rather
 *  than the two lists drifting apart. */
export const MIXERS_WITH_AUTHORED_LAYOUT: readonly number[] = Object.freeze(
  [...AUTHORED.keys()].sort((left, right) => left - right),
);
