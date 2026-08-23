/**
 * M-D §20 / §21 / §24 - THE AUTHORED LAYOUTS, CHECKED AGAINST THE SOURCE
 * THEY CLAIM TO COME FROM.
 *
 * The mappings below are re-stated here by hand from mixer_init.c @
 * 7348054f rather than imported, so this file and the module under test
 * are two independent transcriptions of the same firmware tables. A typo
 * in one does not silently agree with the other.
 */

import {
  MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT,
  mixerHasAuthoredPositionalLayout,
} from '../firmware-adapters/betaflightMixerReferenceV147';
import {
  authoredAirframeLayout,
  mixerHasAuthoredLayout,
  MIXERS_WITH_AUTHORED_LAYOUT,
} from './motorAirframeLayout';

const QUADX = 3;
const QUADX_1234 = 26;
const FOUR = [1, 2, 3, 4];

/** mixerQuadX[] - mixer_init.c:84-89, read in motor-output order. */
const QUADX_FROM_FIRMWARE = [
  {motorNumber: 1, position: 'REAR_RIGHT'},
  {motorNumber: 2, position: 'FRONT_RIGHT'},
  {motorNumber: 3, position: 'REAR_LEFT'},
  {motorNumber: 4, position: 'FRONT_LEFT'},
];

/** mixerQuadX1234[] - mixer_init.c:243-248, read in motor-output order. */
const QUADX_1234_FROM_FIRMWARE = [
  {motorNumber: 1, position: 'FRONT_LEFT'},
  {motorNumber: 2, position: 'FRONT_RIGHT'},
  {motorNumber: 3, position: 'REAR_RIGHT'},
  {motorNumber: 4, position: 'REAR_LEFT'},
];

describe('M-D §20 - QUADX and QUADX_1234 are different aircraft', () => {
  it('places QUAD X exactly as the firmware table does', () => {
    expect(authoredAirframeLayout(QUADX, FOUR)).toEqual(QUADX_FROM_FIRMWARE);
  });

  it('places QUAD X 1234 exactly as ITS firmware table does', () => {
    expect(authoredAirframeLayout(QUADX_1234, FOUR)).toEqual(
      QUADX_1234_FROM_FIRMWARE,
    );
  });

  it('does not give the two the same assignment', () => {
    // The single assertion that would have caught reusing one layout for
    // both: motor 1 is at opposite corners of the aircraft.
    const x = authoredAirframeLayout(QUADX, FOUR);
    const x1234 = authoredAirframeLayout(QUADX_1234, FOUR);
    expect(x).not.toEqual(x1234);
    expect(x?.[0].position).toBe('REAR_RIGHT');
    expect(x1234?.[0].position).toBe('FRONT_LEFT');
  });

  it('covers all four corners exactly once, on both', () => {
    for (const mixer of [QUADX, QUADX_1234]) {
      const positions = authoredAirframeLayout(mixer, FOUR)?.map(
        placement => placement.position,
      );
      expect(new Set(positions).size).toBe(4);
    }
  });
});

describe('M-D §21 / §22 - everything else falls back', () => {
  it.each([
    ['TRI', 1],
    ['QUADP', 2],
    ['BICOPTER', 4],
    ['Y6', 6],
    ['FLYING_WING', 8],
    ['Y4', 9],
    ['HEX6X', 10],
    ['OCTOX8', 11],
    ['AIRPLANE', 14],
    ['VTAIL4', 17],
    ['ATAIL4', 22],
    ['CUSTOM', 23],
    ['OCTOX8P', 27],
    ['UNKNOWN 250', 250],
  ])('%s has no authored layout', (_name, mixerModeRaw) => {
    expect(mixerHasAuthoredLayout(mixerModeRaw)).toBe(false);
    expect(authoredAirframeLayout(mixerModeRaw, FOUR)).toBeUndefined();
  });

  it('draws nothing for a mixer that has not been read', () => {
    expect(authoredAirframeLayout(undefined, FOUR)).toBeUndefined();
    expect(mixerHasAuthoredLayout(undefined)).toBe(false);
  });

  it('draws nothing when no motor count has been read', () => {
    expect(authoredAirframeLayout(QUADX, [])).toBeUndefined();
  });

  it('withdraws the drawing when the reported count contradicts it', () => {
    // A QUADX byte with six motors: the mixer was changed without the
    // reboot mixerInit() needs. MSP_MOTOR_CONFIG is the authority, so the
    // four-place drawing is the thing that has to go.
    expect(authoredAirframeLayout(QUADX, [1, 2, 3, 4, 5, 6])).toBeUndefined();
    expect(authoredAirframeLayout(QUADX, [1, 2, 3])).toBeUndefined();
  });

  it('withdraws the drawing when the motor NUMBERS are not 1..N', () => {
    // A caller that built its list from something other than the runtime
    // count. Rather than draw three of four places, draw none.
    expect(authoredAirframeLayout(QUADX, [1, 2, 3, 5])).toBeUndefined();
    expect(authoredAirframeLayout(QUADX, [4, 3, 2, 1])).toBeUndefined();
  });
});

describe('M-D §25 - no layout carries a rotation direction', () => {
  it('exposes no direction field on any placement', () => {
    for (const mixer of MIXERS_WITH_AUTHORED_LAYOUT) {
      for (const placement of authoredAirframeLayout(mixer, FOUR) ?? []) {
        expect(Object.keys(placement).sort()).toEqual([
          'motorNumber',
          'position',
        ]);
      }
    }
  });

  it('serialises with no rotation vocabulary anywhere', () => {
    const serialised = JSON.stringify(
      MIXERS_WITH_AUTHORED_LAYOUT.map(mixer =>
        authoredAirframeLayout(mixer, FOUR),
      ),
    );
    expect(serialised).not.toMatch(/\bcw\b|\bccw\b|clockwise|direction|rotation|prop/i);
  });
});

describe('M-D §24 - the artwork and the reference model agree', () => {
  it('claims an authored layout for exactly the mixers that have one', () => {
    // M-B's MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT is a claim ABOUT this
    // file. When it was written, the artwork it claimed for QUADX_1234
    // did not exist - the diagram had one Quad X drawing and reused it.
    // These two lists are now checked against each other so the claim
    // cannot outrun the drawing again.
    expect([...MIXERS_WITH_AUTHORED_LAYOUT]).toEqual([
      ...MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT,
    ]);
  });

  it('agrees mixer by mixer, not just as a set', () => {
    for (const mixerModeRaw of [...Array(28).keys()]) {
      expect(mixerHasAuthoredLayout(mixerModeRaw)).toBe(
        mixerHasAuthoredPositionalLayout(mixerModeRaw),
      );
    }
  });

  it('keeps the authored list short enough to be checkable by hand', () => {
    // Not a style rule. Every entry here is a claim about where a motor
    // physically is, and every claim has to be verified against the
    // firmware by a person. Growth is meant to be deliberate.
    expect(MIXERS_WITH_AUTHORED_LAYOUT.length).toBe(2);
  });
});
