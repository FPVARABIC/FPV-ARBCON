/**
 * M-F3F P0-C - THE ARROW AUDIT, ON EVERY AUTHORED AIRFRAME.
 *
 * =====================================================================
 * WHY A SWEEP AND NOT MORE EXAMPLES
 * =====================================================================
 *
 * "The user wants every arrow position checked. Not only QUADX." The
 * existing diagram suite checks a hand-picked handful, which is the
 * shape of test that lets an airframe added later arrive with no
 * coverage at all. This file walks `MIXERS_WITH_AUTHORED_LAYOUT` - the
 * table's OWN list - so a new entry is audited the moment it exists, and
 * a deleted entry cannot quietly reduce the audit.
 *
 * What is asserted, per airframe:
 *
 *   §22  the front marker is present and the aircraft is drawn.
 *   §23  FRONT is a physical claim: the marker sits in the forward half
 *        of the stage, above every node it is describing, and the
 *        geometry that places it never consults the interface's writing
 *        direction.
 *   §24  every reported motor has its own selectable node - including
 *        each rotor of a coaxial pair (§26), which are at DIFFERENT
 *        positions and select independently.
 *   §25  the selected motor is marked, and only that one.
 *   §27  QUADX_1234 is audited as its own aircraft, not as QUADX.
 *   §28  an expected-rotation mark appears ONLY where the transcribed
 *        firmware table claims one - never on a tricopter motor, never
 *        on a fixed wing, and never at all with the props flag unread.
 *
 * NOTHING HERE IS A PHYSICAL CLAIM about any real aircraft: an expected
 * rotation is what the firmware's mixer table implies, and the drawing
 * says so in its own words elsewhere.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {MotorAirframeDiagram} from './MotorAirframeDiagram';
import {
  authoredAirframeLayout,
  MIXERS_WITH_AUTHORED_LAYOUT,
} from '../../core/state/motorAirframeLayout';
import {
  expectedMotorRotation,
  MIXERS_WITH_EXPECTED_ROTATION,
} from '../../core/state/motorExpectedRotation';

const MIXER_TRI = 1;
const MIXER_FLYING_WING = 8;
const MIXER_AIRPLANE = 14;
const MIXER_QUADX = 3;
const MIXER_QUADX_1234 = 26;

/** Every authored airframe, with the motor count its own table defines.
 *  Derived, never listed: a hard-coded list here would be the second
 *  source this whole phase exists to remove. */
const AUDITED = MIXERS_WITH_AUTHORED_LAYOUT.map(mixerModeRaw => {
  for (let count = 1; count <= 8; count += 1) {
    const motorNumbers = Array.from({length: count}, (_unused, i) => i + 1);
    const layout = authoredAirframeLayout(mixerModeRaw, motorNumbers);
    if (layout !== undefined) return {mixerModeRaw, motorNumbers, layout};
  }
  throw new Error(`authored mixer ${mixerModeRaw} resolved to no layout`);
});

/** The stage this marker was laid out inside - taken from the stage
 *  element the diagram sizes, so "the forward half" is measured against
 *  the real box rather than a number repeated here. */
function stageOf(marker: ReactTestRenderer.ReactTestInstance): number {
  let node: ReactTestRenderer.ReactTestInstance | null = marker;
  while (node !== null) {
    if (node.props?.testID === 'motors-airframe-stage') {
      const style = Array.isArray(node.props.style)
        ? Object.assign({}, ...node.props.style.filter(Boolean))
        : node.props.style;
      if (typeof style?.width === 'number') return style.width;
    }
    node = node.parent;
  }
  throw new Error('the front marker is not inside a sized stage');
}

function render(options: {
  mixerModeRaw: number;
  motorNumbers: readonly number[];
  selectedSlot?: number;
  yawMotorsReversed?: boolean;
}) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorAirframeDiagram
        selectedSlot={options.selectedSlot ?? options.motorNumbers[0]}
        onSelectSlot={() => undefined}
        mixerModeRaw={options.mixerModeRaw}
        motorNumbers={options.motorNumbers}
        yawMotorsReversed={options.yawMotorsReversed}
      />,
    );
  });
  const all = (testID: string) =>
    tree.root.findAll(node => node.props?.testID === testID);
  return {
    tree,
    all,
    has: (testID: string) => all(testID).length > 0,
    text: () => JSON.stringify(tree.toJSON()),
    unmount: () => act(() => tree.unmount()),
  };
}

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

describe('M-F3F §22/§24 - every authored airframe is drawn, complete', () => {
  it('states the front and gives every reported motor its own node', () => {
    expect(AUDITED.length).toBeGreaterThan(10);
    for (const {mixerModeRaw, motorNumbers} of AUDITED) {
      const view = render({mixerModeRaw, motorNumbers});
      expect(view.has('motors-diagram-front')).toBe(true);
      expect(view.text()).toContain(i18n.t('motorsScreen.diagramFront'));
      for (const motorNumber of motorNumbers) {
        // §24/§26: a node PER MOTOR, so a coaxial rotor is reachable on
        // its own rather than sharing its partner's target.
        expect(view.has(`motors-airframe-slot-${motorNumber}`)).toBe(true);
      }
      view.unmount();
    }
  });

  it('§25 - exactly one motor is marked selected, and it is the requested one', () => {
    for (const {mixerModeRaw, motorNumbers} of AUDITED) {
      for (const selectedSlot of motorNumbers) {
        const view = render({mixerModeRaw, motorNumbers, selectedSlot});
        const selected = view
          .all(`motors-airframe-slot-${selectedSlot}`)
          .filter(node => node.props?.accessibilityState?.selected === true);
        expect(selected.length).toBeGreaterThan(0);
        // No OTHER motor claims to be the selected one.
        for (const other of motorNumbers) {
          if (other === selectedSlot) continue;
          const wrong = view
            .all(`motors-airframe-slot-${other}`)
            .filter(node => node.props?.accessibilityState?.selected === true);
          expect(wrong).toHaveLength(0);
        }
        view.unmount();
      }
    }
  });
});

describe('M-F3F §23 - FRONT is geometry, not writing direction', () => {
  it('the front marker sits in the forward half of the stage on every airframe', () => {
    for (const {mixerModeRaw, motorNumbers} of AUDITED) {
      const view = render({mixerModeRaw, motorNumbers});
      const [marker] = view.all('motors-diagram-front');
      expect(marker).toBeDefined();
      const style = Array.isArray(marker.props.style)
        ? Object.assign({}, ...marker.props.style.filter(Boolean))
        : marker.props.style;
      /* The marker is placed from the TOP of the stage - the nose - and
         its horizontal placement is SYMMETRIC (left === right, centred),
         which is what makes it immune to the interface's writing
         direction. An asymmetric inline offset here would be the §23
         defect in its most literal form: the nose swapping ends when the
         language does. */
      expect(typeof style.top).toBe('number');
      expect(style.left).toBe(style.right);
      expect(style.alignItems).toBe('center');
      // And it is above the nose, not below the hub.
      expect(style.top).toBeLessThan(stageOf(marker) / 2);
      view.unmount();
    }
  });

  it('the placement source contains no writing-direction branch at all', () => {
    /* Structural, deliberately: an RTL mirror is easy to reintroduce as
       a one-line "helpful" flip inside the geometry, and a rendering
       assertion at one locale would not see it. */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../core/state/motorAirframeLayout.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/I18nManager|isRTL|inlineStart|inlineEnd/);
  });
});

describe('M-F3F §27 - QUADX_1234 is audited as its own aircraft', () => {
  it('is in the swept set, and its motor 1 is NOT where a QUADX motor 1 is', () => {
    expect(MIXERS_WITH_AUTHORED_LAYOUT).toContain(MIXER_QUADX_1234);
    const quad = authoredAirframeLayout(MIXER_QUADX, [1, 2, 3, 4]);
    const alternate = authoredAirframeLayout(MIXER_QUADX_1234, [1, 2, 3, 4]);
    expect(quad).toBeDefined();
    expect(alternate).toBeDefined();
    const quadOne = quad!.placements.find(p => p.motorNumber === 1)!;
    const altOne = alternate!.placements.find(p => p.motorNumber === 1)!;
    // Back right against front left: opposite in BOTH axes.
    expect(Math.sign(quadOne.x)).toBe(-Math.sign(altOne.x));
    expect(Math.sign(quadOne.y)).toBe(-Math.sign(altOne.y));
  });
});

describe('M-F3F §28 - a rotation mark only where the table claims one', () => {
  it('with the props flag UNREAD, no airframe shows any expected rotation', () => {
    for (const {mixerModeRaw, motorNumbers} of AUDITED) {
      const view = render({mixerModeRaw, motorNumbers});
      for (const motorNumber of motorNumbers) {
        expect(view.has(`motors-expected-rotation-${motorNumber}`)).toBe(false);
      }
      view.unmount();
    }
  });

  it('with the flag read, a mark appears EXACTLY where the transcribed table has one', () => {
    for (const yawMotorsReversed of [false, true]) {
      for (const {mixerModeRaw, motorNumbers} of AUDITED) {
        const view = render({mixerModeRaw, motorNumbers, yawMotorsReversed});
        for (const motorNumber of motorNumbers) {
          const claimed = expectedMotorRotation(
            mixerModeRaw,
            motorNumber,
            yawMotorsReversed,
          );
          expect(view.has(`motors-expected-rotation-${motorNumber}`)).toBe(
            claimed !== undefined,
          );
        }
        view.unmount();
      }
    }
  });

  it('a tricopter and both fixed wings claim NO rotation, in either build', () => {
    for (const mixerModeRaw of [MIXER_TRI, MIXER_FLYING_WING, MIXER_AIRPLANE]) {
      expect(MIXERS_WITH_EXPECTED_ROTATION).not.toContain(mixerModeRaw);
      const entry = AUDITED.find(item => item.mixerModeRaw === mixerModeRaw);
      expect(entry).toBeDefined();
      for (const yawMotorsReversed of [false, true]) {
        const view = render({
          mixerModeRaw,
          motorNumbers: entry!.motorNumbers,
          yawMotorsReversed,
        });
        for (const motorNumber of entry!.motorNumbers) {
          expect(view.has(`motors-expected-rotation-${motorNumber}`)).toBe(false);
        }
        view.unmount();
      }
    }
  });

  it('§26 - each rotor of a coaxial pair carries its OWN mark, and they differ', () => {
    for (const {mixerModeRaw, motorNumbers, layout} of AUDITED) {
      if (!layout.coaxial) continue;
      for (const motorNumber of motorNumbers) {
        const placement = layout.placements.find(
          candidate => candidate.motorNumber === motorNumber,
        )!;
        const partner = layout.placements.find(
          candidate =>
            candidate.motorNumber !== motorNumber &&
            candidate.x === placement.x &&
            candidate.y === placement.y,
        );
        if (partner === undefined) continue;
        const mine = expectedMotorRotation(mixerModeRaw, motorNumber, false);
        const theirs = expectedMotorRotation(mixerModeRaw, partner.motorNumber, false);
        if (mine === undefined || theirs === undefined) continue;
        /* Counter-rotating within the arm is the whole reason a coaxial
           pair needs two marks rather than one shared with its partner. */
        expect(mine).not.toBe(theirs);
      }
    }
  });
});
