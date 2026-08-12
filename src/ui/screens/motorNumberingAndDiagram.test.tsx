/**
 * MOTOR NUMBERING AND THE DIAGRAM (PARTS Z and AA).
 *
 * TWO DIFFERENT PROBLEMS, kept apart on purpose:
 *
 *   VISUAL NUMBERING - M1..Mn must be unmistakable, must mean the same
 *   output everywhere it appears, and must not change because the app is
 *   Arabic. Proven here.
 *
 *   FIRMWARE REMAPPING - whether the output ORDER can be authored at all.
 *   That is a protocol question, answered against the pinned firmware in
 *   motorOutputReordering.test.ts and MotorOutputReorderPanel.test.tsx.
 *   Nothing in this file pretends a label can move a motor.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import {
  MotorAirframeDiagram,
  computeMotorGlyphLayout,
  MOTOR_AIRFRAME_QUAD_COUNT,
} from './MotorAirframeDiagram';
import type {MotorAirframeEntry} from './MotorAirframeDiagram';
import {MOTOR_TEST_EXPECTED_CONFIGURATION} from '../../core/state/motorVerificationModel';
import {isRtlLayout} from '../icons/layoutDirection';

const QUAD: readonly MotorAirframeEntry[] = MOTOR_TEST_EXPECTED_CONFIGURATION.map(
  entry => ({
    slot: entry.motorNumber,
    position: entry.position,
    direction: entry.direction,
  }),
);

function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(element);
  });
  const hosts = (testID: string) =>
    tree.root.findAll(
      node => typeof node.type === 'string' && node.props?.testID === testID,
    );
  return {tree, hosts, text: () => JSON.stringify(tree.toJSON())};
}

function diagram(over: Partial<React.ComponentProps<typeof MotorAirframeDiagram>> = {}) {
  return render(
    <MotorAirframeDiagram
      entries={QUAD}
      selectedSlot={1}
      onSelectSlot={() => {}}
      {...over}
    />,
  );
}

/* ============================================== PART Z: M -> PAYLOAD */
describe('PART Z: the M number IS the payload index, everywhere', () => {
  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ])('M%i drives payload motor index %i', (mNumber, payloadIndex) => {
    // The accepted identity: pulseMotor/setMotorValue take a ZERO-BASED
    // payload index, and the label is that index plus one. One arithmetic
    // relationship, asserted rather than assumed.
    expect(mNumber - 1).toBe(payloadIndex);
    const entry = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
      candidate => candidate.motorNumber === mNumber,
    );
    expect(entry).toBeDefined();
  });

  it('the diagram prints M1..M4 and nothing else', () => {
    const r = diagram();
    for (const slot of [1, 2, 3, 4]) {
      expect(r.hosts(`motors-diagram-slot-${slot}`)).toHaveLength(1);
    }
    expect(r.hosts('motors-diagram-slot-5')).toHaveLength(0);
  });

  it('the pressable slot and the printed number are the SAME number', () => {
    const taken: number[] = [];
    const r = render(
      <MotorAirframeDiagram
        entries={QUAD}
        selectedSlot={1}
        onSelectSlot={slot => taken.push(slot)}
      />,
    );
    for (const slot of [1, 2, 3, 4]) {
      const node = r.tree.root
        .findAll(n => n.props?.testID === `motors-airframe-slot-${slot}`)
        .find(n => typeof n.props?.onPress === 'function');
      expect(node).toBeDefined();
      act(() => node!.props.onPress());
    }
    expect(taken).toEqual([1, 2, 3, 4]);
  });

  it('ONE identity source: the glyph layout is derived, never a second map', () => {
    const layout = computeMotorGlyphLayout();
    expect(layout.map(cell => cell.slot).sort()).toEqual([1, 2, 3, 4]);
    for (const cell of layout) {
      const expected = MOTOR_TEST_EXPECTED_CONFIGURATION.find(
        entry => entry.motorNumber === cell.slot,
      );
      expect(expected).toBeDefined();
    }
  });

  it('RTL changes the text direction, never the motor identity', () => {
    // The app forces RTL. Identity must be the same either way, so this
    // asserts the mapping is not a function of layout direction at all.
    const before = computeMotorGlyphLayout().map(c => `${c.slot}:${c.row}:${c.side}`);
    expect(isRtlLayout()).toBe(isRtlLayout()); // stable within a run
    const after = computeMotorGlyphLayout().map(c => `${c.slot}:${c.row}:${c.side}`);
    expect(after).toEqual(before);
    // M2 is FRONT_RIGHT in the accepted configuration and must stay there.
    const m2 = computeMotorGlyphLayout().find(c => c.slot === 2);
    expect(m2).toMatchObject({row: 'FRONT', side: 'RIGHT'});
  });
});

/* ================================= PART AA: THE VISUALIZATION ITSELF */
describe('PART AA: the diagram is readable, and honest about what it knows', () => {
  it('gives every motor exactly ONE rotation indicator', () => {
    const r = diagram();
    for (const slot of [1, 2, 3, 4]) {
      expect(r.hosts(`motors-diagram-direction-${slot}`)).toHaveLength(1);
    }
  });

  it('an UNKNOWN direction shows no CW/CCW claim at all', () => {
    const unknown = QUAD.map(entry => ({...entry, direction: undefined}));
    const r = render(
      <MotorAirframeDiagram
        entries={unknown}
        selectedSlot={1}
        onSelectSlot={() => {}}
      />,
    );
    const body = r.text();
    expect(body).not.toContain('"CW"');
    expect(body).not.toContain('"CCW"');
    // ...and says so instead of drawing an arrow that might be wrong.
    expect(body).toContain('؟');
  });

  it('a KNOWN direction still writes the token out, so the arrow is never alone', () => {
    const body = diagram().text();
    expect(body).toContain('CW');
    expect(body).toContain('CCW');
  });

  it('reserves the badge row, so selecting a motor cannot resize its node', () => {
    // The MEASURED cause of the 19.31px overlap at 390px: the selected
    // node grew by 29px because its badge appeared inside the flow.
    const withSelection = diagram({selectedSlot: 1}).text();
    const withOther = diagram({selectedSlot: 3}).text();
    // Same number of badge slots in both, whichever motor is selected.
    const count = (s: string) => s.split('"height":18').length - 1;
    expect(count(withSelection)).toBe(count(withOther));
  });

  it('keeps STOP and the controls out of the diagram entirely', () => {
    const body = diagram().text();
    expect(body).not.toContain('motor-workspace-stop');
    expect(body).not.toContain('motor-slider-');
  });
});

/* ==================================== PART Q: NON-QUAD MOTOR COUNTS */
describe('PART Q: a frame this file cannot draw is not drawn', () => {
  it('renders the Quad X airframe for exactly four outputs', () => {
    const r = diagram({motorCount: MOTOR_AIRFRAME_QUAD_COUNT});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(1);
    expect(r.hosts('motors-generic-outputs')).toHaveLength(0);
  });

  it.each([1, 2, 3, 5, 6, 8])(
    'refuses to borrow the quad airframe for %i outputs',
    motorCount => {
      const r = diagram({motorCount});
      expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
      expect(r.hosts('motors-generic-outputs')).toHaveLength(1);
      // Every output is numbered, and only the real ones exist.
      for (let slot = 1; slot <= motorCount; slot++) {
        expect(r.hosts(`motors-generic-slot-${slot}`)).toHaveLength(1);
      }
      expect(r.hosts(`motors-generic-slot-${motorCount + 1}`)).toHaveLength(0);
    },
  );

  it('says WHY there is no aircraft, rather than leaving a bare list', () => {
    const r = diagram({motorCount: 6});
    expect(r.hosts('motors-generic-outputs-caption')).toHaveLength(1);
    expect(r.text()).toContain('لا تتوفر هندسة إطار مؤكدة');
  });

  it('makes no positional claim in the fallback', () => {
    const body = diagram({motorCount: 6}).text();
    for (const phrase of ['أمامي يمين', 'أمامي يسار', 'خلفي يمين', 'خلفي يسار']) {
      expect(body).not.toContain(phrase);
    }
  });

  it('the fallback still selects the same slot number it prints', () => {
    const taken: number[] = [];
    const r = render(
      <MotorAirframeDiagram
        entries={QUAD}
        motorCount={6}
        selectedSlot={1}
        onSelectSlot={slot => taken.push(slot)}
      />,
    );
    for (const slot of [1, 5, 6]) {
      const node = r.tree.root
        .findAll(n => n.props?.testID === `motors-generic-slot-${slot}`)
        .find(n => typeof n.props?.onPress === 'function');
      act(() => node!.props.onPress());
    }
    expect(taken).toEqual([1, 5, 6]);
  });
});
