/**
 * Pass 7.4, Step 2 - the "Renderer Interface" isolation boundary between
 * the Orientation View Model (Step 1, src/core/state/orientationViewModel.ts)
 * and the actual 3D drawing library (Skia - see OrientationRenderer.tsx in
 * this same directory).
 *
 * This file is deliberately ZERO React/RN/Skia dependency - real rotation
 * matrices (fixed yaw -> pitch -> roll composition, per
 * orientationViewModel.ts's own documented contract), a real perspective
 * camera projection, and the approved visual-prototype geometry (hub,
 * arms, motors, prop rings, nose arrow) all live here as plain functions
 * of numbers, in/out. This is what lets Step 6's tests validate the 3D
 * transform math (rotation correctness, front/rear color assignment, arm
 * geometry, depth-sort order, and specifically that yaw genuinely rotates
 * the model - the approved prototype's own camera-angle workaround
 * dropped yaw as a bug, and this pass must not repeat it) with ordinary
 * Jest, no GPU/WebGL context required. OrientationRenderer.tsx (the
 * "Actual 3D Library" stage) is a thin, deliberately dumb consumer of
 * computeDroneScene()'s output - it contains no orientation math of its
 * own, only Skia draw calls, which is why it does not need its own unit
 * tests (see Step 6's own note on this).
 *
 * COORDINATE SYSTEM (local/body space, chosen and internally consistent -
 * documented here since nothing forces a particular convention):
 *   +X = forward (nose direction when roll=pitch=yaw=0)
 *   +Y = up
 *   +Z = right
 *
 * ROTATION CONVENTION (matches orientationViewModel.ts's own documented
 * contract: SEMANTIC orientation order is intrinsic yaw -> pitch -> roll,
 * standard aerospace Tait-Bryan ZYX - yaw about the body's up axis first,
 * then pitch about the RESULTING right axis, then roll about the
 * RESULTING forward axis. For active rotations of column vectors about
 * FIXED axes, that intrinsic sequence is equivalent to the matrix product
 *
 *     p' = R_yaw * R_pitch * R_roll * p
 *
 * i.e. the NESTED FUNCTION-APPLICATION order rotateYaw(rotatePitch(
 * rotateRoll(p))) - ROLL is applied first (innermost), then pitch, then
 * yaw last (outermost). Note the reversal: intrinsic order yaw-first
 * corresponds to fixed-axis application roll-first; Pass 7.5 corrected
 * rotateBodyPoint(), which previously nested the fixed-axis calls in the
 * OPPOSITE order (roll outermost = intrinsic roll->pitch->yaw), producing
 * wrong compound poses while leaving every single-axis pose identical.
 * Per-axis positive-angle signs (unchanged by that correction):
 *   - positive roll  = right side down   (rotates Y toward -Z... see rollMatrix)
 *   - positive pitch = nose up           (rotates X toward +Y)
 *   - positive yaw   = nose swings right, viewed from above (rotates X toward +Z)
 */

export type Vec3 = {x: number; y: number; z: number};
export type Vec2 = {x: number; y: number};

export type DroneOrientationDeg = {rollDeg: number; pitchDeg: number; yawDeg: number};

export type DroneSceneMaterial =
  | 'HUB'
  | 'STANDOFF'
  | 'ARM'
  | 'MOTOR_FRONT'
  | 'MOTOR_REAR'
  | 'PROP_RING_FRONT'
  | 'PROP_DISC_FRONT'
  | 'PROP_RING_REAR'
  | 'PROP_DISC_REAR'
  | 'ARROW'
  /** The world-fixed level reference (horizon grid). Deliberately NOT
   * rotated with the body - it is the thing the body is judged against. */
  | 'LEVEL_GRID';

/** Every shape in this scene - hub plates, standoffs, arms, motor
 * circles, prop rings/discs, the arrow's two pieces - is built and
 * projected as a flat polygon (circles included, approximated as
 * CIRCLE_SEGMENT_COUNT-sided regular polygons - see circleAt()/
 * ringAroundOrigin() below). Deliberately a single-variant type rather
 * than a POLYGON/CIRCLE/LINE union: no primitive needs a dedicated
 * circle or line renderer this pass, and a union with branches nothing
 * ever constructs is exactly the kind of speculative surface this
 * codebase avoids building ahead of a real need. */
export type DroneScenePrimitive = {kind: 'POLYGON'; material: DroneSceneMaterial; points: Vec2[]; depth: number};

export type DroneScene = {
  /** Already sorted back-to-front (farthest first, nearest last) - a
   * consumer draws this array in order and gets correct painter's-
   * algorithm occlusion for free, with no sorting of its own to do. */
  primitives: DroneScenePrimitive[];
};

// ---- Body-space geometry constants (arbitrary but self-consistent units) ----

const HUB_BOTTOM_RADIUS = 0.5;
const HUB_TOP_RADIUS = 0.35;
const HUB_BOTTOM_Y = 0;
const HUB_TOP_Y = 0.12;
const STANDOFF_RADIUS = 0.28;
const STANDOFF_HALF_WIDTH = 0.02;

/** The hub's own outer edge, for the arm-length formula below - the
 * WIDER (bottom) plate, since that is what the arms visually meet. */
const HUB_EDGE_RADIUS = HUB_BOTTOM_RADIUS;
const MOTOR_RADIUS_FROM_CENTER = 1.6;
const ARM_Y = 0.06;
const ARM_HALF_WIDTH = 0.035;

const MOTOR_BASE_RADIUS = 0.09;
const MOTOR_BELL_RADIUS = 0.065;
const MOTOR_BASE_Y = ARM_Y;
const MOTOR_BELL_Y = ARM_Y + 0.06;

const PROP_RADIUS = 0.55;
const PROP_Y = MOTOR_BELL_Y + 0.02;

const ARROW_Y = 0.34;
const ARROW_SHAFT_LENGTH = 0.55;
const ARROW_SHAFT_HALF_WIDTH = 0.07;
const ARROW_HEAD_LENGTH = 0.4;
const ARROW_HEAD_HALF_WIDTH = 0.22;

/**
 * =====================================================================
 * M-F3F P0-B - THE MODEL IS THE AIRCRAFT THE BOARD REPORTED.
 * =====================================================================
 *
 * WHAT USED TO BE HERE. A literal four-entry array at 45/135/225/315
 * degrees, named MOTOR_LAYOUT: an X-frame quadcopter, hard-coded. Every
 * board got it. A Y6 got it, a tricopter got it, a flying wing got it -
 * on the screen an operator opens FIRST and uses to decide which way the
 * flight controller is mounted. Two screens describing the same aircraft
 * differently is not cosmetic; the Setup model is the orientation
 * reference for a physical question.
 *
 * WHAT IS HERE NOW. Nothing. The rotors, the arms and the body shape are
 * PASSED IN, derived from what the board actually reported, and this
 * module still owns no opinion about what any mixer id means - see
 * airframeSceneModel.ts, which is the only place that reads the authored
 * layout table, and which the Motors diagram reads from too.
 *
 * AND WHEN NOTHING IS KNOWN, NOTHING IS DRAWN. `computeDroneScene` with
 * no airframe renders the hub, the nose arrow and the level grid, and no
 * rotors at all. An unrecognised aircraft NEVER becomes a quad (§17):
 * the orientation is still readable, and the shape claims nothing.
 */

/** One rotor's place on the aircraft, in the SAME planform coordinates
 *  the authored layout uses: x = -1 left .. +1 right, y = -1 nose .. +1
 *  tail. Not angles: a tricopter's tail arm is longer than its front
 *  pair, and an angle-plus-fixed-radius model cannot say so. */
export type DroneSceneRotor = {
  readonly x: number;
  readonly y: number;
  /** SINGLE, or which rotor of a coaxial pair. A Y6 has THREE arms and
   *  six motors; drawing six arms would be a lie about the aircraft. */
  readonly deck: 'SINGLE' | 'UPPER' | 'LOWER';
};

/** How to draw the body under the rotors. Same vocabulary as the Motors
 *  diagram's silhouette, for the same reason: one interpretation. */
export type DroneSceneSilhouette = 'ROTARY' | 'WING' | 'PLANE';

export type DroneSceneAirframe = {
  readonly rotors: readonly DroneSceneRotor[];
  readonly silhouette: DroneSceneSilhouette;
};

/** Vertical separation between the two rotors of a coaxial station -
 *  half above the arm, half below, so an X8 reads as four arms carrying
 *  eight motors rather than as eight arms. */
const COAXIAL_DECK_LIFT = 0.17;

/** Fixed-wing planform, sized to the same half-span as a rotary frame so
 *  one aircraft does not appear twice the size of another (§38/§39). */
const WING_HALF_SPAN = 1.55;
const WING_NOSE_X = 0.95;
const WING_TAIL_X = -0.85;
const WING_TIP_TAIL_X = -1.0;
const WING_ROOT_TAIL_X = -0.35;
const PLANE_FUSELAGE_NOSE_X = 1.5;
const PLANE_FUSELAGE_TAIL_X = -1.5;
const PLANE_FUSELAGE_HALF_WIDTH = 0.14;
const PLANE_WING_HALF_SPAN = 1.5;
const PLANE_WING_LEADING_X = 0.45;
const PLANE_WING_TRAILING_X = -0.05;
const PLANE_TAILPLANE_HALF_SPAN = 0.6;
const PLANE_TAILPLANE_LEADING_X = -1.05;
const PLANE_TAILPLANE_TRAILING_X = -1.35;
const PLANE_FIN_HEIGHT = 0.42;

// ---- Camera ----
//
// The previous 3/4 diagonal chase angle (azimuth -140, elevation 28) was
// the single biggest source of "the model looks tilted when the drone is
// level" reports: an off-axis azimuth skews the airframe diagonally
// across the viewport, and 28 degrees of downward tilt foreshortens the
// far arms enough that a genuinely level quad reads as banked. Both are
// pure PRESENTATION values - neither has ever fed the rotation math.
//
// Revised minimally rather than replaced: still a rear chase view, still
// never near-overhead, but now placed EXACTLY behind the tail (azimuth
// 180) so the airframe is left/right symmetric on screen, and lowered to
// 16 degrees so a level quad projects as a level, near-horizontal frame
// while the top surface (and the nose arrow) stay visible.
const CAMERA_AZIMUTH_DEG = 180; // directly behind the tail - no diagonal skew
const CAMERA_ELEVATION_DEG = 16; // gentle downward tilt; level reads as level
const CAMERA_DISTANCE = 6;
const FOCAL_LENGTH = 1.6;

/** The single presentation-scale knob for how large the
 * projected model appears inside the preview viewport. Purely
 * presentational: changes NOTHING about rotation math, camera
 * direction, geometry, or front identity.
 *
 * The model was first reduced to 0.322.  In the new tablet composition it
 * sits beside two compact instruments, so 0.370 restores 14.9% of linear
 * size without returning anywhere near the original 0.644 presentation.
 * The Canvas, world-fixed grid, MSP sample, pivot and camera stay intact. */
const MODEL_PIXEL_SCALE_FACTOR = 0.37;

const CIRCLE_SEGMENT_COUNT = 24;

/** Level-reference grid: a world-fixed horizontal lattice at the
 * airframe's own y=0 plane. It is what makes "level" verifiable by eye -
 * with no reference, a projected quad has nothing to be level RELATIVE
 * to. Kept sparse and outside the prop discs so it never competes with
 * the model itself. */
const GRID_HALF_EXTENT = 3.2;
const GRID_LINE_COUNT = 5; // lines per axis, including the two edges
const GRID_LINE_HALF_WIDTH = 0.012;
const GRID_Y = 0;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function rotateYaw(p: Vec3, yawRad: number): Vec3 {
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  return {x: p.x * cos - p.z * sin, y: p.y, z: p.x * sin + p.z * cos};
}

function rotatePitch(p: Vec3, pitchRad: number): Vec3 {
  const cos = Math.cos(pitchRad);
  const sin = Math.sin(pitchRad);
  return {x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, z: p.z};
}

function rotateRoll(p: Vec3, rollRad: number): Vec3 {
  const cos = Math.cos(rollRad);
  const sin = Math.sin(rollRad);
  return {x: p.x, y: p.y * cos - p.z * sin, z: p.y * sin + p.z * cos};
}

/** The one place the intrinsic yaw -> pitch -> roll contract (documented
 * above and in orientationViewModel.ts) is actually applied. As a matrix
 * expression this is p' = R_yaw * R_pitch * R_roll * p; as nested calls,
 * rotateRoll runs FIRST (innermost), then rotatePitch, then rotateYaw
 * last (outermost) - see the file-header ROTATION CONVENTION note for
 * why the intrinsic (semantic) order and the fixed-axis application
 * order are deliberately reversed relative to each other. */
export function rotateBodyPoint(p: Vec3, orientation: DroneOrientationDeg): Vec3 {
  const rolled = rotateRoll(p, degToRad(orientation.rollDeg));
  const pitched = rotatePitch(rolled, degToRad(orientation.pitchDeg));
  return rotateYaw(pitched, degToRad(orientation.yawDeg));
}

export type MotorFrameInfo = {
  /** Bearing from the nose, positive toward the right-hand side, in the
   * scene's own +X-forward/+Z-right frame. Derived from the placement,
   * not stored, so a bearing and the point it names cannot disagree. */
  angleDeg: number;
  /** FRONT OF THE AIRCRAFT, FROM ITS GEOMETRY (§23). local X > 0 is
   * forward - a property of the airframe, unaffected by the live
   * rotation applied later and by the interface's text direction. A
   * rotor exactly on the lateral axis, or at the centre, is neither. */
  isFront: boolean;
  /** Local (pre-rotation, unrotated body space), where the arm starts -
   * exactly on the hub's own outer edge, along the direction of this
   * rotor. Equals the rotor centre for a centre-mounted rotor, which is
   * how a single-prop aircraft ends up with no arm. */
  hubEdgeLocal: Vec3;
  /** Local (pre-rotation), the motor's own center - exactly where the
   * arm ends. */
  motorCenterLocal: Vec3;
  /** = |motorCenter - hubEdge| in the planform, per the approved
   * prototype spec: arms span EXACTLY from the hub's outer edge to the
   * motor center, nothing more, nothing less. Zero where there is no
   * arm to draw. */
  armLength: number;
  /** Which rotor of a coaxial station, carried through so the renderer
   *  can stack them and still draw ONE arm. */
  deck: DroneSceneRotor['deck'];
  /** The station's planform position, ROUNDED FOR IDENTITY, so the two
   *  rotors of a coaxial pair are recognisably the same station. */
  stationKey: string;
};

/**
 * The aircraft in body space, pre-rotation - the geometric invariants,
 * separated from camera and projection concerns so they can be checked
 * directly.
 *
 * THE OUTERMOST ROTOR ALWAYS LANDS AT THE SAME RADIUS. The authored
 * layout's coordinates are firmware mixer proportions, not millimetres,
 * so they are scaled as a set: every aircraft then occupies the same
 * footprint on screen and none appears twice the size of another
 * (§38/§39), while the RELATIVE geometry - a tricopter's longer tail
 * arm, a hex's sixty-degree spacing - is preserved exactly.
 */
export function computeMotorFrame(
  airframe: DroneSceneAirframe | undefined,
): MotorFrameInfo[] {
  if (airframe === undefined) return [];
  const rotors = airframe.rotors;
  const furthest = rotors.reduce(
    (largest, rotor) => Math.max(largest, Math.hypot(rotor.x, rotor.y)),
    0,
  );
  // A single centre-mounted rotor has no radius to normalise against.
  const scale = furthest === 0 ? 0 : MOTOR_RADIUS_FROM_CENTER / furthest;
  return rotors.map(rotor => {
    /* The planform's y is measured from the NOSE (-1) to the TAIL (+1);
       the scene's +X is forward. Hence the sign flip, and hence a front
       rotor genuinely has local X > 0. */
    const forward = -rotor.y * scale;
    const right = rotor.x * scale;
    const distance = Math.hypot(forward, right);
    const deckY =
      rotor.deck === 'UPPER'
        ? ARM_Y + COAXIAL_DECK_LIFT
        : rotor.deck === 'LOWER'
          ? ARM_Y - COAXIAL_DECK_LIFT
          : ARM_Y;
    const motorCenterLocal: Vec3 = {x: forward, y: deckY, z: right};
    const direction: Vec3 =
      distance === 0
        ? {x: 0, y: 0, z: 0}
        : {x: forward / distance, y: 0, z: right / distance};
    /* An arm exists only where the rotor is outside the hub. A rotor at
       or inside the hub edge gets no arm rather than a negative one. */
    const hasArm = distance > HUB_EDGE_RADIUS;
    const hubEdgeLocal: Vec3 = hasArm
      ? {x: direction.x * HUB_EDGE_RADIUS, y: deckY, z: direction.z * HUB_EDGE_RADIUS}
      : motorCenterLocal;
    return {
      angleDeg: (Math.atan2(right, forward) * 180) / Math.PI,
      isFront: forward > 0,
      hubEdgeLocal,
      motorCenterLocal,
      armLength: hasArm ? distance - HUB_EDGE_RADIUS : 0,
      deck: rotor.deck,
      stationKey: `${rotor.x.toFixed(4)}:${rotor.y.toFixed(4)}`,
    };
  });
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return {x: a.x + b.x, y: a.y + b.y, z: a.z + b.z};
}

function vecScale(a: Vec3, s: number): Vec3 {
  return {x: a.x * s, y: a.y * s, z: a.z * s};
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return {x: a.x - b.x, y: a.y - b.y, z: a.z - b.z};
}

function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x};
}

function vecNormalize(a: Vec3): Vec3 {
  const length = Math.sqrt(vecDot(a, a));
  return length === 0 ? a : vecScale(a, 1 / length);
}

type Camera = {position: Vec3; right: Vec3; up: Vec3; forward: Vec3};

function buildCamera(): Camera {
  const az = degToRad(CAMERA_AZIMUTH_DEG);
  const el = degToRad(CAMERA_ELEVATION_DEG);
  const direction: Vec3 = {x: Math.cos(az) * Math.cos(el), y: Math.sin(el), z: Math.sin(az) * Math.cos(el)};
  const position = vecScale(direction, CAMERA_DISTANCE);
  const forward = vecNormalize(vecScale(direction, -1)); // camera looks back toward the origin
  const worldUp: Vec3 = {x: 0, y: 1, z: 0};
  const right = vecNormalize(vecCross(forward, worldUp));
  const up = vecCross(right, forward);
  return {position, right, up, forward};
}

type ProjectedPoint = {screen: Vec2; depth: number};

/** Camera-space depth = distance in front of the camera along its own
 * forward axis - larger means farther away, used directly as the
 * painter's-algorithm sort key. */
function project(world: Vec3, camera: Camera, viewportMinDimension: number): ProjectedPoint {
  const relative = vecSub(world, camera.position);
  const camX = vecDot(relative, camera.right);
  const camY = vecDot(relative, camera.up);
  const camZ = vecDot(relative, camera.forward);

  const pixelScale = viewportMinDimension * MODEL_PIXEL_SCALE_FACTOR;
  const screenX = (camX / camZ) * FOCAL_LENGTH * pixelScale;
  // Screen Y increases downward; world up must decrease screen Y.
  const screenY = (-camY / camZ) * FOCAL_LENGTH * pixelScale;

  return {screen: {x: screenX, y: screenY}, depth: camZ};
}

function toViewport(p: Vec2, viewportWidth: number, viewportHeight: number): Vec2 {
  return {x: viewportWidth / 2 + p.x, y: viewportHeight / 2 + p.y};
}

/** A circle in the horizontal plane, centred on an arbitrary point.
 *  Replaces the angle-plus-fixed-radius helper, which could only place a
 *  circle on a ring of one radius - true for a quad, false for every
 *  airframe whose arms are not all the same length. */
function circleAt(centre: Vec3, ringRadius: number, y: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < CIRCLE_SEGMENT_COUNT; i++) {
    const t = (i / CIRCLE_SEGMENT_COUNT) * Math.PI * 2;
    points.push({
      x: centre.x + Math.cos(t) * ringRadius,
      y,
      z: centre.z + Math.sin(t) * ringRadius,
    });
  }
  return points;
}

/**
 * THE FIXED-WING BODIES.
 *
 * Original geometry, drawn from what the firmware's own mixer tables say
 * these aircraft are: mixerSingleProp with elevons (mixers[8], FLYING
 * WING) and mixerSingleProp with six control-surface channels
 * (mixers[14], AIRPLANE). Nothing here is traced from any other
 * application's artwork; they are the smallest set of flat panels that
 * read as a swept wing and as an aeroplane from this camera.
 *
 * NO CONTROL SURFACE IS ANIMATED and no rotation is implied (§28): the
 * panels are the airframe, not a claim about what it is doing.
 */
function fixedWingPanels(silhouette: DroneSceneSilhouette): Vec3[][] {
  if (silhouette === 'WING') {
    return [
      // One swept delta, nose forward, trailing edge cut back at the
      // tips - a single panel, because a flying wing is a single panel.
      [
        {x: WING_NOSE_X, y: ARM_Y, z: 0},
        {x: WING_TIP_TAIL_X, y: ARM_Y, z: WING_HALF_SPAN},
        {x: WING_ROOT_TAIL_X, y: ARM_Y, z: 0.28},
        {x: WING_TAIL_X, y: ARM_Y, z: 0},
        {x: WING_ROOT_TAIL_X, y: ARM_Y, z: -0.28},
        {x: WING_TIP_TAIL_X, y: ARM_Y, z: -WING_HALF_SPAN},
      ],
    ];
  }
  return [
    // Fuselage, nose to tail.
    [
      {x: PLANE_FUSELAGE_NOSE_X, y: ARM_Y, z: 0},
      {x: PLANE_FUSELAGE_NOSE_X - 0.35, y: ARM_Y, z: PLANE_FUSELAGE_HALF_WIDTH},
      {x: PLANE_FUSELAGE_TAIL_X, y: ARM_Y, z: PLANE_FUSELAGE_HALF_WIDTH * 0.5},
      {x: PLANE_FUSELAGE_TAIL_X, y: ARM_Y, z: -PLANE_FUSELAGE_HALF_WIDTH * 0.5},
      {x: PLANE_FUSELAGE_NOSE_X - 0.35, y: ARM_Y, z: -PLANE_FUSELAGE_HALF_WIDTH},
    ],
    // Main wing, slightly swept.
    [
      {x: PLANE_WING_LEADING_X, y: ARM_Y, z: -PLANE_WING_HALF_SPAN},
      {x: PLANE_WING_LEADING_X, y: ARM_Y, z: PLANE_WING_HALF_SPAN},
      {x: PLANE_WING_TRAILING_X - 0.12, y: ARM_Y, z: PLANE_WING_HALF_SPAN},
      {x: PLANE_WING_TRAILING_X, y: ARM_Y, z: 0},
      {x: PLANE_WING_TRAILING_X - 0.12, y: ARM_Y, z: -PLANE_WING_HALF_SPAN},
    ],
    // Tailplane.
    [
      {x: PLANE_TAILPLANE_LEADING_X, y: ARM_Y, z: -PLANE_TAILPLANE_HALF_SPAN},
      {x: PLANE_TAILPLANE_LEADING_X, y: ARM_Y, z: PLANE_TAILPLANE_HALF_SPAN},
      {x: PLANE_TAILPLANE_TRAILING_X, y: ARM_Y, z: PLANE_TAILPLANE_HALF_SPAN * 0.8},
      {x: PLANE_TAILPLANE_TRAILING_X, y: ARM_Y, z: -PLANE_TAILPLANE_HALF_SPAN * 0.8},
    ],
    // Vertical fin - the one panel standing OUT of the wing plane, which
    // is what makes roll unmistakable on an aeroplane.
    [
      {x: PLANE_TAILPLANE_LEADING_X + 0.1, y: ARM_Y, z: 0},
      {x: PLANE_TAILPLANE_TRAILING_X, y: ARM_Y, z: 0},
      {x: PLANE_TAILPLANE_TRAILING_X, y: ARM_Y + PLANE_FIN_HEIGHT, z: 0},
      {x: PLANE_TAILPLANE_LEADING_X + 0.45, y: ARM_Y + PLANE_FIN_HEIGHT, z: 0},
    ],
  ];
}

function ringAroundOrigin(radius: number, y: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < CIRCLE_SEGMENT_COUNT; i++) {
    const t = (i / CIRCLE_SEGMENT_COUNT) * Math.PI * 2;
    points.push({x: Math.cos(t) * radius, y, z: Math.sin(t) * radius});
  }
  return points;
}

/**
 * Computes the full drawable, depth-sorted, screen-space drone scene for
 * one orientation. viewportSize should be the actual render target's
 * pixel dimensions - primitives scale with viewportMinDimension so the
 * model fits sensibly regardless of screen size, matching the theme
 * layer's own convention of never hardcoding absolute pixel sizes.
 */
export function computeDroneScene(
  orientation: DroneOrientationDeg,
  viewportSize: {width: number; height: number},
  presentationScale = 1,
  /**
   * THE AIRCRAFT THE BOARD REPORTED, or nothing.
   *
   * `undefined` is a real answer and it is drawn as one: hub, nose arrow
   * and level grid, with NO rotors and NO arms. Nothing is invented to
   * fill the gap, and in particular nothing becomes a quadcopter (§17).
   */
  airframe?: DroneSceneAirframe,
): DroneScene {
  const camera = buildCamera();
  const viewportMinDimension = Math.min(viewportSize.width, viewportSize.height);

  const safePresentationScale = Number.isFinite(presentationScale) && presentationScale > 0 ? presentationScale : 1;
  const projectLocal = (local: Vec3): ProjectedPoint => {
    const world = rotateBodyPoint(local, orientation);
    const projected = project(world, camera, viewportMinDimension);
    return { ...projected, screen: { x: projected.screen.x * safePresentationScale, y: projected.screen.y * safePresentationScale } };
  };

  const projectPolygon = (localPoints: Vec3[]): {points: Vec2[]; depth: number} => {
    const projected = localPoints.map(projectLocal);
    const depth = projected.reduce((sum, p) => sum + p.depth, 0) / projected.length;
    const points = projected.map(p => toViewport(p.screen, viewportSize.width, viewportSize.height));
    return {points, depth};
  };

  const primitives: DroneScenePrimitive[] = [];

  // Level reference grid - projected WITHOUT rotateBodyPoint, because it
  // represents the world horizon the airframe is tilting against. If it
  // rotated with the body it would prove nothing.
  {
    const projectWorldPolygon = (worldPoints: Vec3[]): {points: Vec2[]; depth: number} => {
      const projected = worldPoints.map(point => project(point, camera, viewportMinDimension));
      const depth = projected.reduce((sum, p) => sum + p.depth, 0) / projected.length;
      return {points: projected.map(p => toViewport(p.screen, viewportSize.width, viewportSize.height)), depth};
    };
    for (let i = 0; i < GRID_LINE_COUNT; i++) {
      const t = (i / (GRID_LINE_COUNT - 1)) * 2 - 1;
      const offset = t * GRID_HALF_EXTENT;
      // Line running along +/-X at a fixed Z.
      const alongX: Vec3[] = [
        {x: -GRID_HALF_EXTENT, y: GRID_Y, z: offset - GRID_LINE_HALF_WIDTH},
        {x: GRID_HALF_EXTENT, y: GRID_Y, z: offset - GRID_LINE_HALF_WIDTH},
        {x: GRID_HALF_EXTENT, y: GRID_Y, z: offset + GRID_LINE_HALF_WIDTH},
        {x: -GRID_HALF_EXTENT, y: GRID_Y, z: offset + GRID_LINE_HALF_WIDTH},
      ];
      // Line running along +/-Z at a fixed X.
      const alongZ: Vec3[] = [
        {x: offset - GRID_LINE_HALF_WIDTH, y: GRID_Y, z: -GRID_HALF_EXTENT},
        {x: offset - GRID_LINE_HALF_WIDTH, y: GRID_Y, z: GRID_HALF_EXTENT},
        {x: offset + GRID_LINE_HALF_WIDTH, y: GRID_Y, z: GRID_HALF_EXTENT},
        {x: offset + GRID_LINE_HALF_WIDTH, y: GRID_Y, z: -GRID_HALF_EXTENT},
      ];
      for (const line of [alongX, alongZ]) {
        const {points, depth} = projectWorldPolygon(line);
        primitives.push({kind: 'POLYGON', material: 'LEVEL_GRID', points, depth});
      }
    }
  }

  const silhouette = airframe?.silhouette ?? 'ROTARY';

  if (silhouette === 'ROTARY') {
    // Hub bottom plate (wider).
    {
      const {points, depth} = projectPolygon(ringAroundOrigin(HUB_BOTTOM_RADIUS, HUB_BOTTOM_Y));
      primitives.push({kind: 'POLYGON', material: 'HUB', points, depth});
    }
    // Hub top plate (narrower).
    {
      const {points, depth} = projectPolygon(ringAroundOrigin(HUB_TOP_RADIUS, HUB_TOP_Y));
      primitives.push({kind: 'POLYGON', material: 'HUB', points, depth});
    }
    // 4 small standoffs between the plates.
    for (let i = 0; i < 4; i++) {
      const angle = degToRad(i * 90 + 45);
      const cx = Math.cos(angle) * STANDOFF_RADIUS;
      const cz = Math.sin(angle) * STANDOFF_RADIUS;
      const localQuad: Vec3[] = [
        {x: cx - STANDOFF_HALF_WIDTH, y: HUB_BOTTOM_Y, z: cz},
        {x: cx + STANDOFF_HALF_WIDTH, y: HUB_BOTTOM_Y, z: cz},
        {x: cx + STANDOFF_HALF_WIDTH, y: HUB_TOP_Y, z: cz},
        {x: cx - STANDOFF_HALF_WIDTH, y: HUB_TOP_Y, z: cz},
      ];
      const {points, depth} = projectPolygon(localQuad);
      primitives.push({kind: 'POLYGON', material: 'STANDOFF', points, depth});
    }
  } else {
    /* A FIXED WING IS NOT A HUB WITH ARMS (§14/§21). A flying wing gets
       a swept planform; an aeroplane gets a fuselage, a main wing, a
       tailplane and a fin. Both read as themselves at a glance, which is
       the entire point of the model on this screen, and neither is a
       renamed quadcopter. */
    for (const panel of fixedWingPanels(silhouette)) {
      const {points, depth} = projectPolygon(panel);
      primitives.push({kind: 'POLYGON', material: 'HUB', points, depth});
    }
  }

  const frame = computeMotorFrame(airframe);
  /* ONE ARM PER STATION. A Y6 carries two rotors on each of three arms;
     drawing an arm per rotor would claim six. */
  const armsDrawn = new Set<string>();

  for (const motor of frame) {
    if (motor.armLength > 0 && !armsDrawn.has(motor.stationKey)) {
      armsDrawn.add(motor.stationKey);
      const span = vecSub(motor.motorCenterLocal, motor.hubEdgeLocal);
      const length = Math.hypot(span.x, span.z);
      const dir: Vec3 =
        length === 0 ? {x: 1, y: 0, z: 0} : {x: span.x / length, y: 0, z: span.z / length};
      // The arm is a single member at the airframe's own arm height,
      // whatever deck the rotors on it sit at.
      const armStart: Vec3 = {x: motor.hubEdgeLocal.x, y: ARM_Y, z: motor.hubEdgeLocal.z};
      const armEnd: Vec3 = {x: motor.motorCenterLocal.x, y: ARM_Y, z: motor.motorCenterLocal.z};
      const perpendicular: Vec3 = {x: -dir.z, y: 0, z: dir.x};
      const armQuad: Vec3[] = [
        vecAdd(armStart, vecScale(perpendicular, ARM_HALF_WIDTH)),
        vecAdd(armEnd, vecScale(perpendicular, ARM_HALF_WIDTH)),
        vecAdd(armEnd, vecScale(perpendicular, -ARM_HALF_WIDTH)),
        vecAdd(armStart, vecScale(perpendicular, -ARM_HALF_WIDTH)),
      ];
      const arm = projectPolygon(armQuad);
      primitives.push({kind: 'POLYGON', material: 'ARM', points: arm.points, depth: arm.depth});
    }

    const motorMaterial: DroneSceneMaterial = motor.isFront ? 'MOTOR_FRONT' : 'MOTOR_REAR';
    const propRingMaterial: DroneSceneMaterial = motor.isFront ? 'PROP_RING_FRONT' : 'PROP_RING_REAR';
    const propDiscMaterial: DroneSceneMaterial = motor.isFront ? 'PROP_DISC_FRONT' : 'PROP_DISC_REAR';

    // Motor base + bell-cap - two stacked circles, the bell smaller and
    // slightly higher, per the approved prototype spec's "small bell-caps".
    // Both sit at the rotor's OWN deck height, which is what makes a
    // coaxial pair visibly a pair.
    const centre = motor.motorCenterLocal;
    const deckOffset = centre.y - ARM_Y;
    {
      const base = projectPolygon(
        circleAt(centre, MOTOR_BASE_RADIUS, MOTOR_BASE_Y + deckOffset),
      );
      primitives.push({kind: 'POLYGON', material: motorMaterial, points: base.points, depth: base.depth});
      const bell = projectPolygon(
        circleAt(centre, MOTOR_BELL_RADIUS, MOTOR_BELL_Y + deckOffset),
      );
      primitives.push({kind: 'POLYGON', material: motorMaterial, points: bell.points, depth: bell.depth});
    }

    // Propeller ring (outline) + faint translucent disc, per spec.
    {
      const ring = projectPolygon(circleAt(centre, PROP_RADIUS, PROP_Y + deckOffset));
      primitives.push({kind: 'POLYGON', material: propRingMaterial, points: ring.points, depth: ring.depth});
      primitives.push({kind: 'POLYGON', material: propDiscMaterial, points: ring.points, depth: ring.depth});
    }
  }

  // Nose arrow - flat shaft + wide triangular head, centered at (x=0,
  // z=0), lifted above the hub, pointing toward +X (nose). The SOLE nose
  // indicator (no camera wedge, no landing legs - both rejected in the
  // approved prototype spec).
  {
    const shaftLocal: Vec3[] = [
      {x: -ARROW_SHAFT_LENGTH / 2, y: ARROW_Y, z: -ARROW_SHAFT_HALF_WIDTH},
      {x: ARROW_SHAFT_LENGTH / 2, y: ARROW_Y, z: -ARROW_SHAFT_HALF_WIDTH},
      {x: ARROW_SHAFT_LENGTH / 2, y: ARROW_Y, z: ARROW_SHAFT_HALF_WIDTH},
      {x: -ARROW_SHAFT_LENGTH / 2, y: ARROW_Y, z: ARROW_SHAFT_HALF_WIDTH},
    ];
    const headBaseX = ARROW_SHAFT_LENGTH / 2;
    const headLocal: Vec3[] = [
      {x: headBaseX, y: ARROW_Y, z: -ARROW_HEAD_HALF_WIDTH},
      {x: headBaseX + ARROW_HEAD_LENGTH, y: ARROW_Y, z: 0},
      {x: headBaseX, y: ARROW_Y, z: ARROW_HEAD_HALF_WIDTH},
    ];
    const shaft = projectPolygon(shaftLocal);
    primitives.push({kind: 'POLYGON', material: 'ARROW', points: shaft.points, depth: shaft.depth});
    const head = projectPolygon(headLocal);
    primitives.push({kind: 'POLYGON', material: 'ARROW', points: head.points, depth: head.depth});
  }

  primitives.sort((a, b) => b.depth - a.depth);

  return {primitives};
}
