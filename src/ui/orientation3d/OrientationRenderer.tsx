/**
 * Pass 7.4, Step 2 - the "Actual 3D Library" stage of the pipeline (MSP
 * Attitude -> Orientation View Model -> Renderer Interface -> Actual 3D
 * Library -> Setup UI). Deliberately a THIN, DUMB consumer of
 * droneSceneGeometry.ts's computeDroneScene() output: this file contains
 * no rotation math, no camera math, no geometry constants of its own -
 * only a material->color lookup and Skia draw calls. That is exactly why
 * this file does not need (and per this pass's own testing strategy,
 * does not get) its own unit tests - every piece of logic worth testing
 * already has GPU-free coverage in droneSceneGeometry.test.ts, and what
 * remains here (do these Skia primitives visually look right) can only
 * be verified by eye on a real device/simulator, not by Jest.
 *
 * @shopify/react-native-skia chosen per Step 0's own investigation
 * (react-native-webgl confirmed deprecated; expo-gl requires the full
 * Expo module system this project does not otherwise use). Skia itself
 * has no true 3D scene/camera system - the "3D" here is entirely
 * droneSceneGeometry.ts's own hand-rolled rotation + perspective
 * projection + painter's-algorithm depth sort; this component only
 * paints the resulting 2D polygons in the order it's given them.
 *
 * WHY THIS FILE HAS NO MOUNT TEST OF ITS OWN (actually attempted, not
 * just assumed): jest.config.js wires up @shopify/react-native-skia's
 * own official jestSetup.js mock (Canvas becomes a plain RN View, no
 * native module required), but that mock's Skia.Path API is itself built
 * from a real CanvasKit instance (`Mock(CanvasKit)` in the package's own
 * mock/index.ts) - without one, Skia.Path.Make() throws immediately
 * ("Cannot read properties of undefined (reading 'PathBuilder')"),
 * confirmed by actually running it, not inferred. Wiring a real
 * CanvasKit-WASM instance into Jest (the `canvaskit-wasm` package, async
 * WASM instantiation) is real additional complexity/fragility for a
 * component with no logic of its own to protect - exactly the case this
 * pass's own instruction carves out ("only the isolation boundary is
 * mandatory, library choice is Step 0's job"). Screen-level tests (Step
 * 5/6) should jest.mock() this module directly rather than attempt to
 * mount it for real - the isolation boundary (droneSceneGeometry.ts) is
 * what makes that safe to do.
 */

import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import {Canvas, Path, Skia} from '@shopify/react-native-skia';
import type {SkPath} from '@shopify/react-native-skia';

import {computeDroneScene} from './droneSceneGeometry';
import type {DroneOrientationDeg, DroneScenePrimitive, DroneSceneMaterial} from './droneSceneGeometry';
import {orientationLatencyTracker} from './orientationLatencyDebugLog';
import type {OrientationLatencySampleIdentity} from './orientationLatencyDebugLog';
import {colors} from '../theme';

/** Front motors/props BLUE, rear RED - the SOLE front/back color scheme
 * (per the approved prototype spec). Reuses the existing theme palette's
 * own accent/error colors rather than introducing new ones. */
const MATERIAL_COLOR: Record<DroneSceneMaterial, string> = {
  // FINAL-POLISH PASS: the central body read as a dark smudge against
  // the dark card, because surfaceAlt (#1C2128) is only two steps off
  // the background (#0E1116). Moved one step up the SAME neutral ramp
  // to border (#2A313C) - no new colour enters the palette, and the hub
  // still sits below the arms in the hierarchy.
  HUB: colors.border,
  STANDOFF: colors.border,
  // Arms are the shape that communicates the airframe's attitude, so
  // they move from textSecondary (#8B949E) to textPrimary (#E6EDF3) -
  // again an existing palette step, now clearly above the hub.
  ARM: colors.textPrimary,
  MOTOR_FRONT: colors.accent,
  MOTOR_REAR: colors.error,
  PROP_RING_FRONT: colors.accent,
  PROP_DISC_FRONT: colors.accent,
  PROP_RING_REAR: colors.error,
  PROP_DISC_REAR: colors.error,
  ARROW: colors.textPrimary,
  LEVEL_GRID: colors.border,
};

/** Faint translucent discs representing the propeller's swept area, per
 * the approved prototype spec - every other material is fully opaque. */
const TRANSLUCENT_MATERIALS = new Set<DroneSceneMaterial>(['PROP_DISC_FRONT', 'PROP_DISC_REAR', 'LEVEL_GRID']);
const TRANSLUCENT_OPACITY = 0.18;

/** FINAL-POLISH PASS: the level grid stays deliberately subordinate to
 * the drone. With the model 15% larger and the body/arms brighter, the
 * grid at the shared 0.18 would have competed with it, so it gets its
 * own slightly lower value. Still visible as a horizon, never a
 * co-equal element. */
const LEVEL_GRID_OPACITY = 0.14;

/** FINAL-POLISH PASS: a hairline stroke on the airframe's own outlines.
 * Fills alone leave the thin arms (ARM_HALF_WIDTH 0.035) and the nose
 * marker reading as slivers once anti-aliasing has had its way with
 * them; stroking the same path with its own colour thickens the silhou-
 * ette by a measured 1.2px total (0.6px each side) without adding any
 * geometry, glow, shadow or new colour. Deliberately NOT applied to the
 * prop discs (they are meant to be faint) or the level grid (it must
 * stay subordinate).
 *
 * The 0.6px half-width is included in the clipping matrix that sized
 * MODEL_PIXEL_SCALE_FACTOR - see that constant's own comment. */
const OUTLINE_STROKE_WIDTH = 1.2;
const OUTLINED_MATERIALS = new Set<DroneSceneMaterial>([
  'HUB',
  'ARM',
  'ARROW',
  'MOTOR_FRONT',
  'MOTOR_REAR',
  'PROP_RING_FRONT',
  'PROP_RING_REAR',
]);

/** STALE per Step 1's OrientationViewState - the model freezes at its
 * last LIVE pose and is dimmed here. The pose this component is given is
 * always a GENUINE sample: there is no animation, no interpolation and
 * no extrapolation anywhere on the Orientation model path, so a dimmed
 * model is showing the last real sample and nothing else. The
 * "البيانات متأخرة" text label itself is Region 2's own overlay, not
 * this renderer's job. */
const STALE_OPACITY_MULTIPLIER = 0.45;

function toSkPath(points: DroneScenePrimitive['points']): SkPath {
  const path = Skia.Path.Make();
  const [first, ...rest] = points;
  if (!first) {
    return path;
  }
  path.moveTo(first.x, first.y);
  for (const point of rest) {
    path.lineTo(point.x, point.y);
  }
  path.close();
  return path;
}

export type OrientationRendererProps = {
  orientation: DroneOrientationDeg;
  width: number;
  height: number;
  /** True while Region 2 is showing a STALE (frozen) reading. */
  stale?: boolean;
  /** Development-only diagnostics: which genuine sample this pose came
   * from. Never affects what is drawn - the pose alone decides that. */
  sampleIdentity?: OrientationLatencySampleIdentity;
};

/** One build per genuine pose, and the SkPaths built with it.
 *
 * BUILDING THE PATHS INSIDE THE MEMO IS THE POINT, not a tidy-up. Before
 * this pass the scene was memoized but `toSkPath()` ran inside the JSX
 * map, so every single render allocated a fresh SkPath for all 38
 * primitives (511 points) even when the pose had not changed. Combined
 * with the retired animation-frame loop - which re-rendered this
 * component at frame rate - that was ~2,280 SkPath allocations per
 * second for data arriving 4.5 times per second. */
function buildDrawables(orientation: DroneOrientationDeg, width: number, height: number) {
  const scene = computeDroneScene(orientation, {width, height});
  return scene.primitives.map(primitive => ({
    path: toSkPath(primitive.points),
    color: MATERIAL_COLOR[primitive.material],
    baseOpacity:
      primitive.material === 'LEVEL_GRID'
        ? LEVEL_GRID_OPACITY
        : TRANSLUCENT_MATERIALS.has(primitive.material)
          ? TRANSLUCENT_OPACITY
          : 1,
    outlined: OUTLINED_MATERIALS.has(primitive.material),
  }));
}

export function OrientationRenderer({
  orientation,
  width,
  height,
  stale = false,
  sampleIdentity,
}: OrientationRendererProps): React.JSX.Element {
  const {rollDeg, pitchDeg, yawDeg} = orientation;
  const sessionToken = sampleIdentity?.sessionToken;
  const sampleSeq = sampleIdentity?.sampleSeq;

  // Deliberately depends on the POSE, not on the sample identity: two
  // consecutive samples reporting an identical attitude must reuse the
  // built scene rather than rebuild an identical one. The diagnostics
  // stamp below is therefore taken on the render that first shows a
  // sample, whether or not that render had to build a new scene.
  const drawables = useMemo(
    () => buildDrawables({rollDeg, pitchDeg, yawDeg}, width, height),
    [rollDeg, pitchDeg, yawDeg, width, height],
  );

  if (sessionToken !== undefined && sampleSeq !== undefined) {
    const identity = {sessionToken, sampleSeq};
    orientationLatencyTracker.noteRendererSample(identity);
    orientationLatencyTracker.noteSceneBuilt(identity);
  }

  return (
    <View style={{width, height}} testID="orientation-renderer">
      {/* Unkeyed and never conditionally swapped: a key or a mount
          toggle tied to the sample would destroy and recreate the
          native surface on every attitude update. */}
      <Canvas style={StyleSheet.absoluteFill}>
        {drawables.map((drawable, index) => {
          const opacity = stale ? drawable.baseOpacity * STALE_OPACITY_MULTIPLIER : drawable.baseOpacity;
          // The scene is fully rebuilt in the same deterministic
          // primitive order every render (see computeDroneScene()'s own
          // doc comment), so a plain index is a stable, correct key here.
          // The optional outline is a SECOND draw of the SAME memoized
          // path object - no extra geometry is built for it.
          return (
            <React.Fragment key={index}>
              <Path path={drawable.path} color={drawable.color} opacity={opacity} />
              {drawable.outlined && (
                <Path
                  path={drawable.path}
                  color={drawable.color}
                  opacity={opacity}
                  style="stroke"
                  strokeWidth={OUTLINE_STROKE_WIDTH}
                  strokeJoin="round"
                  strokeCap="round"
                />
              )}
            </React.Fragment>
          );
        })}
      </Canvas>
    </View>
  );
}
