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
 * sign choices exactly - a point is rotated by applying, IN ORDER, the
 * yaw matrix, then the pitch matrix, then the roll matrix, each about the
 * ORIGINAL fixed body axes above; this fixed-axis "innermost-first"
 * matrix composition is the standard way to implement true intrinsic
 * yaw->pitch->roll body-axis composition):
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
  | 'ARROW';

/** Every shape in this scene - hub plates, standoffs, arms, motor
 * circles, prop rings/discs, the arrow's two pieces - is built and
 * projected as a flat polygon (circles included, approximated as
 * CIRCLE_SEGMENT_COUNT-sided regular polygons - see circleLocalPoints()/
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

/** X-frame quad motor layout: angles measured from +X (forward), toward
 * +Z (right). front = local X > 0, rear = local X < 0 - a property of
 * the physical airframe, unaffected by the live rotation applied below. */
const MOTOR_LAYOUT: Array<{angleDeg: number; isFront: boolean}> = [
  {angleDeg: 45, isFront: true}, // front-right
  {angleDeg: 135, isFront: false}, // rear-right
  {angleDeg: 225, isFront: false}, // rear-left
  {angleDeg: 315, isFront: true}, // front-left
];

// ---- Camera (3/4 diagonal chase angle - never near-overhead, per the
// approved prototype spec) ----

const CAMERA_AZIMUTH_DEG = -140; // behind the drone, offset to one side
const CAMERA_ELEVATION_DEG = 28; // moderate downward tilt
const CAMERA_DISTANCE = 6;
const FOCAL_LENGTH = 1.6;

const CIRCLE_SEGMENT_COUNT = 24;

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

/** The one place the fixed yaw -> pitch -> roll order (documented above
 * and in orientationViewModel.ts) is actually applied. */
export function rotateBodyPoint(p: Vec3, orientation: DroneOrientationDeg): Vec3 {
  const yawed = rotateYaw(p, degToRad(orientation.yawDeg));
  const pitched = rotatePitch(yawed, degToRad(orientation.pitchDeg));
  return rotateRoll(pitched, degToRad(orientation.rollDeg));
}

export type MotorFrameInfo = {
  angleDeg: number;
  isFront: boolean;
  /** Local (pre-rotation, unrotated body space), where the arm starts -
   * exactly on the hub's own outer edge. */
  hubEdgeLocal: Vec3;
  /** Local (pre-rotation), the motor's own center - exactly where the
   * arm ends. */
  motorCenterLocal: Vec3;
  /** = motorRadius - hubEdgeRadius, per the approved prototype spec:
   * arms span EXACTLY from the hub's outer edge to the motor center,
   * nothing more, nothing less. */
  armLength: number;
};

/** Orientation-independent (local/body space, pre-rotation) motor layout
 * - exported specifically so this geometric invariant (and the exact
 * unit-direction alignment between hubEdgeLocal and motorCenterLocal) can
 * be verified directly, and separately from camera/projection concerns. */
export function computeMotorFrame(): MotorFrameInfo[] {
  return MOTOR_LAYOUT.map(motor => {
    const angle = degToRad(motor.angleDeg);
    const dir: Vec3 = {x: Math.cos(angle), y: 0, z: Math.sin(angle)};
    return {
      angleDeg: motor.angleDeg,
      isFront: motor.isFront,
      hubEdgeLocal: vecScale(dir, HUB_EDGE_RADIUS),
      motorCenterLocal: vecScale(dir, MOTOR_RADIUS_FROM_CENTER),
      armLength: MOTOR_RADIUS_FROM_CENTER - HUB_EDGE_RADIUS,
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

  const pixelScale = viewportMinDimension * 0.16;
  const screenX = (camX / camZ) * FOCAL_LENGTH * pixelScale;
  // Screen Y increases downward; world up must decrease screen Y.
  const screenY = (-camY / camZ) * FOCAL_LENGTH * pixelScale;

  return {screen: {x: screenX, y: screenY}, depth: camZ};
}

function toViewport(p: Vec2, viewportWidth: number, viewportHeight: number): Vec2 {
  return {x: viewportWidth / 2 + p.x, y: viewportHeight / 2 + p.y};
}

function circleLocalPoints(centerAngleDeg: number, radiusFromCenter: number, ringRadius: number, y: number): Vec3[] {
  const centerAngle = degToRad(centerAngleDeg);
  const centerX = Math.cos(centerAngle) * radiusFromCenter;
  const centerZ = Math.sin(centerAngle) * radiusFromCenter;
  const points: Vec3[] = [];
  for (let i = 0; i < CIRCLE_SEGMENT_COUNT; i++) {
    const t = (i / CIRCLE_SEGMENT_COUNT) * Math.PI * 2;
    points.push({x: centerX + Math.cos(t) * ringRadius, y, z: centerZ + Math.sin(t) * ringRadius});
  }
  return points;
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
): DroneScene {
  const camera = buildCamera();
  const viewportMinDimension = Math.min(viewportSize.width, viewportSize.height);

  const projectLocal = (local: Vec3): ProjectedPoint => {
    const world = rotateBodyPoint(local, orientation);
    return project(world, camera, viewportMinDimension);
  };

  const projectPolygon = (localPoints: Vec3[]): {points: Vec2[]; depth: number} => {
    const projected = localPoints.map(projectLocal);
    const depth = projected.reduce((sum, p) => sum + p.depth, 0) / projected.length;
    const points = projected.map(p => toViewport(p.screen, viewportSize.width, viewportSize.height));
    return {points, depth};
  };

  const primitives: DroneScenePrimitive[] = [];

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

  for (const motor of computeMotorFrame()) {
    const angle = degToRad(motor.angleDeg);
    const dir: Vec3 = {x: Math.cos(angle), y: 0, z: Math.sin(angle)};

    // Arm: spans EXACTLY from the hub's outer edge to the motor center,
    // armLength = motorRadius - hubEdgeRadius (per the approved
    // prototype spec), along the exact unit direction toward this motor.
    const armStart = vecAdd(motor.hubEdgeLocal, {x: 0, y: ARM_Y, z: 0});
    const armEnd = vecAdd(motor.motorCenterLocal, {x: 0, y: ARM_Y, z: 0});
    const perpendicular: Vec3 = {x: -dir.z, y: 0, z: dir.x};
    const armQuad: Vec3[] = [
      vecAdd(armStart, vecScale(perpendicular, ARM_HALF_WIDTH)),
      vecAdd(armEnd, vecScale(perpendicular, ARM_HALF_WIDTH)),
      vecAdd(armEnd, vecScale(perpendicular, -ARM_HALF_WIDTH)),
      vecAdd(armStart, vecScale(perpendicular, -ARM_HALF_WIDTH)),
    ];
    const arm = projectPolygon(armQuad);
    primitives.push({kind: 'POLYGON', material: 'ARM', points: arm.points, depth: arm.depth});

    const motorMaterial: DroneSceneMaterial = motor.isFront ? 'MOTOR_FRONT' : 'MOTOR_REAR';
    const propRingMaterial: DroneSceneMaterial = motor.isFront ? 'PROP_RING_FRONT' : 'PROP_RING_REAR';
    const propDiscMaterial: DroneSceneMaterial = motor.isFront ? 'PROP_DISC_FRONT' : 'PROP_DISC_REAR';

    // Motor base + bell-cap - two stacked circles, the bell smaller and
    // slightly higher, per the approved prototype spec's "small bell-caps".
    {
      const base = projectPolygon(circleLocalPoints(motor.angleDeg, MOTOR_RADIUS_FROM_CENTER, MOTOR_BASE_RADIUS, MOTOR_BASE_Y));
      primitives.push({kind: 'POLYGON', material: motorMaterial, points: base.points, depth: base.depth});
      const bell = projectPolygon(circleLocalPoints(motor.angleDeg, MOTOR_RADIUS_FROM_CENTER, MOTOR_BELL_RADIUS, MOTOR_BELL_Y));
      primitives.push({kind: 'POLYGON', material: motorMaterial, points: bell.points, depth: bell.depth});
    }

    // Propeller ring (outline) + faint translucent disc, per spec.
    {
      const ring = projectPolygon(circleLocalPoints(motor.angleDeg, MOTOR_RADIUS_FROM_CENTER, PROP_RADIUS, PROP_Y));
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
