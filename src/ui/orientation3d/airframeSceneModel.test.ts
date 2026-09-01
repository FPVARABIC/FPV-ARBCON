/**
 * M-F3F P0-B - ONE AIRFRAME TRUTH, AND WHAT IT REFUSES TO SAY.
 *
 * THE CROSS-SCREEN INVARIANT IS THE POINT (§30). Motors draws its
 * aircraft from `authoredAirframeLayout`; Setup draws its 3D model from
 * this adapter, which reads THE SAME function. The last describe block
 * asserts that directly - not "both look right" but "both come from one
 * table" - because a second table is exactly how the two screens ended
 * up describing the same aircraft differently in the first place.
 *
 * The rest of the file is about the refusals. §17 forbids normalising an
 * unknown aircraft to a quad, and the only way to keep that honest is to
 * check that the unknown cases really do produce NOTHING rather than
 * something plausible.
 */

import {sceneAirframeFor, sceneAirframeFromLayout} from './airframeSceneModel';
import {
  authoredAirframeLayout,
  MIXERS_WITH_AUTHORED_LAYOUT,
} from '../../core/state/motorAirframeLayout';
import type {ObservedAirframe} from '../../core/state/observedAirframeTruth';

/** Betaflight mixerMode_e, from the pinned firmware's mixer.h. */
const MIXER_TRI = 1;
const MIXER_QUADX = 3;
const MIXER_Y6 = 6;
const MIXER_OCTOX8 = 11;
const MIXER_AIRPLANE = 14;
const MIXER_CUSTOM = 23;

const observed = (
  mixerModeRaw: number,
  motorCount: number | undefined,
): ObservedAirframe => ({mixerModeRaw, motorCount, sessionId: 'session-1'});

describe('sceneAirframeFor - what the board reported', () => {
  it('a QUAD X reported with four motors is four rotors on one plane', () => {
    const airframe = sceneAirframeFor(observed(MIXER_QUADX, 4));
    expect(airframe?.rotors).toHaveLength(4);
    expect(airframe?.silhouette).toBe('ROTARY');
    expect(airframe?.rotors.every(rotor => rotor.deck === 'SINGLE')).toBe(true);
  });

  it('a Y6 keeps its coaxial decks - three stations, two rotors each', () => {
    const airframe = sceneAirframeFor(observed(MIXER_Y6, 6));
    expect(airframe?.rotors).toHaveLength(6);
    const upper = airframe?.rotors.filter(rotor => rotor.deck === 'UPPER') ?? [];
    const lower = airframe?.rotors.filter(rotor => rotor.deck === 'LOWER') ?? [];
    expect(upper).toHaveLength(3);
    expect(lower).toHaveLength(3);
    // Each upper rotor shares a station with exactly one lower rotor.
    for (const top of upper) {
      const below = lower.filter(rotor => rotor.x === top.x && rotor.y === top.y);
      expect(below).toHaveLength(1);
    }
  });

  it('an X8 is four stations of two, not eight separate arms', () => {
    const airframe = sceneAirframeFor(observed(MIXER_OCTOX8, 8));
    const stations = new Set(
      (airframe?.rotors ?? []).map(rotor => `${rotor.x}:${rotor.y}`),
    );
    expect(airframe?.rotors).toHaveLength(8);
    expect(stations.size).toBe(4);
  });

  it('an aeroplane is a PLANE silhouette with one rotor', () => {
    const airframe = sceneAirframeFor(observed(MIXER_AIRPLANE, 1));
    expect(airframe?.silhouette).toBe('PLANE');
    expect(airframe?.rotors).toHaveLength(1);
  });
});

describe('M-F3F §17 - the refusals, and none of them is a quadcopter', () => {
  it('nothing observed yields no aircraft', () => {
    expect(sceneAirframeFor(undefined)).toBeUndefined();
  });

  it('a CUSTOM mixer has no authored layout, and is NOT normalised to a quad', () => {
    expect(sceneAirframeFor(observed(MIXER_CUSTOM, 4))).toBeUndefined();
  });

  it('a mixer this project has never transcribed yields no aircraft', () => {
    const unknownMixer = 99;
    expect(MIXERS_WITH_AUTHORED_LAYOUT).not.toContain(unknownMixer);
    expect(sceneAirframeFor(observed(unknownMixer, 4))).toBeUndefined();
  });

  it('a board that reports NO runtime motor count yields no aircraft', () => {
    /* The mixer alone is not enough: a mixer stored without the restart
       mixerInit() needs leaves the mixer byte and the running motor
       count disagreeing, which is precisely when a confident drawing is
       most wrong. */
    expect(sceneAirframeFor(observed(MIXER_Y6, undefined))).toBeUndefined();
  });

  it('a count that CONTRADICTS the mixer yields no aircraft - in either direction', () => {
    // A tricopter mixer with eight motors, and an X8 with three.
    expect(sceneAirframeFor(observed(MIXER_TRI, 8))).toBeUndefined();
    expect(sceneAirframeFor(observed(MIXER_OCTOX8, 3))).toBeUndefined();
    // And the honest pairing still resolves, so the check above is not
    // simply refusing everything.
    expect(sceneAirframeFor(observed(MIXER_TRI, 3))).toBeDefined();
    expect(sceneAirframeFor(observed(MIXER_OCTOX8, 8))).toBeDefined();
  });
});

describe('M-F3F §30 - Motors and Setup describe ONE aircraft', () => {
  it('every authored airframe reaches the 3D model with the SAME placements the diagram draws', () => {
    let checked = 0;
    for (const mixerModeRaw of MIXERS_WITH_AUTHORED_LAYOUT) {
      /* The layout for this mixer, at its own motor count - found by
         asking the table itself rather than by keeping a second list of
         counts here, which would be the very duplication this test
         exists to forbid. */
      const layout = (() => {
        for (let count = 1; count <= 8; count += 1) {
          const candidate = authoredAirframeLayout(
            mixerModeRaw,
            Array.from({length: count}, (_unused, index) => index + 1),
          );
          if (candidate !== undefined) return {candidate, count};
        }
        return undefined;
      })();
      expect(layout).toBeDefined();
      if (layout === undefined) continue;
      const scene = sceneAirframeFor(observed(mixerModeRaw, layout.count));
      expect(scene).toBeDefined();
      // Same count, same coordinates, same decks, same body shape.
      expect(scene?.rotors).toHaveLength(layout.candidate.placements.length);
      layout.candidate.placements.forEach((placement, index) => {
        expect(scene?.rotors[index]).toEqual({
          x: placement.x,
          y: placement.y,
          deck: placement.deck,
        });
      });
      expect(scene?.silhouette).toBe(layout.candidate.silhouette);
      checked += 1;
    }
    // Not a vacuous loop: the authored table is not empty.
    expect(checked).toBe(MIXERS_WITH_AUTHORED_LAYOUT.length);
    expect(checked).toBeGreaterThan(10);
  });

  it('the layout-to-scene mapping adds nothing and drops nothing', () => {
    const layout = authoredAirframeLayout(MIXER_Y6, [1, 2, 3, 4, 5, 6]);
    expect(layout).toBeDefined();
    const scene = sceneAirframeFromLayout(layout!);
    expect(scene.rotors.map(rotor => rotor.x)).toEqual(
      layout!.placements.map(placement => placement.x),
    );
    expect(scene.rotors.map(rotor => rotor.y)).toEqual(
      layout!.placements.map(placement => placement.y),
    );
    expect(scene.rotors.map(rotor => rotor.deck)).toEqual(
      layout!.placements.map(placement => placement.deck),
    );
  });
});
