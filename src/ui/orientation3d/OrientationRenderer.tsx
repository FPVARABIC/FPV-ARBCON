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
import type {
  DroneOrientationDeg,
  DroneSceneAirframe,
  DroneScenePrimitive,
} from './droneSceneGeometry';
import {orientationLatencyTracker} from './orientationLatencyDebugLog';
import type {OrientationLatencySampleIdentity} from './orientationLatencyDebugLog';
// The colour/opacity/outline table is SHARED with the browser's SVG
// renderer (OrientationRenderer.web.tsx). It used to live in this file;
// it moved out the moment a second renderer existed, because the
// front-blue/rear-red split is how the operator reads which way the
// aircraft is pointing and two copies of that mapping is two chances for
// the platforms to disagree about which end is the front.
import {
  OUTLINE_STROKE_WIDTH,
  appearanceFor,
  effectiveOpacity,
} from './orientationAppearance';

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
  presentationScale?: number;
  /**
   * THE AIRCRAFT THIS BOARD ACTUALLY IS - M-F3F P0-B.
   *
   * Passed in, never assumed. `undefined` renders the orientation model
   * with NO rotors rather than a stand-in quadcopter (§17), which is the
   * defect this prop exists to end: a Y6, a tricopter and a flying wing
   * were all drawn as an X quad on the screen an operator uses to decide
   * how the flight controller is mounted.
   */
  airframe?: DroneSceneAirframe;
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
function buildDrawables(
  orientation: DroneOrientationDeg,
  width: number,
  height: number,
  presentationScale: number,
  airframe: DroneSceneAirframe | undefined,
) {
  const scene = computeDroneScene(orientation, {width, height}, presentationScale, airframe);
  return scene.primitives.map(primitive => ({
    path: toSkPath(primitive.points),
    ...appearanceFor(primitive.material),
  }));
}

export function OrientationRenderer({
  orientation,
  width,
  height,
  stale = false,
  sampleIdentity,
  presentationScale = 1,
  airframe,
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
    () =>
      buildDrawables({rollDeg, pitchDeg, yawDeg}, width, height, presentationScale, airframe),
    [rollDeg, pitchDeg, yawDeg, width, height, presentationScale, airframe],
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
          const opacity = effectiveOpacity(drawable.baseOpacity, stale);
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
