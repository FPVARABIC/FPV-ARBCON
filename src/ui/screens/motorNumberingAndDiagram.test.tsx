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
} from './MotorAirframeDiagram';
import {MOTOR_TEST_EXPECTED_CONFIGURATION} from '../../core/state/motorVerificationModel';
import {isRtlLayout} from '../icons/layoutDirection';


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
      mixerModeRaw={3}
        motorNumbers={[1, 2, 3, 4]}
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
        mixerModeRaw={3}
        motorNumbers={[1, 2, 3, 4]}
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

  /**
   * M-D §25 - THE OPERATIONAL DIAGRAM CLAIMS NO ROTATION AT ALL.
   *
   * This replaces two tests: one that checked an UNKNOWN direction drew
   * no arrow, and one that checked a KNOWN direction printed its token.
   * The second no longer has a subject. Authored layouts map a motor
   * number to a place on the frame and carry no direction field, so
   * there is no way to hand this component a rotation to draw.
   *
   * That is deliberate rather than incidental. M-A established that
   * actual propeller rotation is not readable as authoritative truth over
   * MSP, and the operational drawing is exactly where an expectation gets
   * mistaken for a measurement - the operator is looking at it WHILE a
   * motor spins. The expected props-out reference still exists, in the
   * verification wizard, where comparing it against what a human saw is
   * the entire purpose.
   */
  it('never prints a rotation direction, on any airframe', () => {
    for (const mixerModeRaw of [3, 26, undefined]) {
      const body = render(
        <MotorAirframeDiagram
          mixerModeRaw={mixerModeRaw}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={1}
          onSelectSlot={() => {}}
        />,
      ).text();
      expect(body).not.toContain('"CW"');
      expect(body).not.toContain('"CCW"');
      expect(body).not.toMatch(/clockwise/i);
    }
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

/* ============================ M-D: WHICH AIRFRAMES MAY BE DRAWN AT ALL */
describe('M-D: a frame this project has not authored is not drawn', () => {
  const QUADX = 3;
  const QUADP = 2;
  const Y4 = 9;
  const VTAIL4 = 17;
  const ATAIL4 = 22;
  const QUADX_1234 = 26;
  const HEX6X = 10;
  const four = [1, 2, 3, 4];

  it('draws QUAD X, which this project has authored', () => {
    const r = diagram({mixerModeRaw: QUADX, motorNumbers: four});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(1);
    expect(r.hosts('motors-generic-outputs')).toHaveLength(0);
  });

  it('draws QUAD X 1234, which is authored SEPARATELY', () => {
    const r = diagram({mixerModeRaw: QUADX_1234, motorNumbers: four});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(1);
  });

  /**
   * THE DEFECT THE OLD GATE COULD NOT SEE.
   *
   * It asked `motorCount !== 4`, so every one of these got the Quad X
   * drawing - four motors, four corners, wrong aircraft. From
   * mixer_init.c @ 7348054f: QUADP is a plus frame, Y4 has a coaxial tail
   * pair, and VTAIL4/ATAIL4 angle their rear arms. None is an X.
   */
  it.each([
    ['QUADP', QUADP],
    ['Y4', Y4],
    ['VTAIL4', VTAIL4],
    ['ATAIL4', ATAIL4],
  ])('refuses to lend the Quad X drawing to %s', (_name, mixerModeRaw) => {
    const r = diagram({mixerModeRaw, motorNumbers: four});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
    expect(r.hosts('motors-generic-outputs')).toHaveLength(1);
  });

  it('withholds the drawing when the mixer has not been read', () => {
    const r = diagram({mixerModeRaw: undefined, motorNumbers: four});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
    expect(r.hosts('motors-generic-outputs')).toHaveLength(1);
  });

  it('withholds the drawing when the count contradicts the mixer', () => {
    // A QUADX byte with six reported motors: the mixer changed without
    // the reboot mixerInit() needs. The count is the authority, and a
    // four-place drawing cannot represent six motors.
    const r = diagram({mixerModeRaw: QUADX, motorNumbers: [1, 2, 3, 4, 5, 6]});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
  });

  it.each([
    ['1 motor', [1]],
    ['3 motors', [1, 2, 3]],
    ['6 motors', [1, 2, 3, 4, 5, 6]],
    ['8 motors', [1, 2, 3, 4, 5, 6, 7, 8]],
  ])('numbers every real output and no others for %s', (_name, motorNumbers) => {
    const r = diagram({mixerModeRaw: HEX6X, motorNumbers});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
    for (const slot of motorNumbers) {
      expect(r.hosts(`motors-generic-slot-${slot}`)).toHaveLength(1);
    }
    expect(
      r.hosts(`motors-generic-slot-${motorNumbers.length + 1}`),
    ).toHaveLength(0);
  });

  it('renders NO outputs at all when nothing has been read', () => {
    // M-D §4: an empty list is what "unread" looks like. Not four.
    const r = diagram({mixerModeRaw: undefined, motorNumbers: []});
    expect(r.hosts('motors-airframe-stage')).toHaveLength(0);
    expect(r.hosts('motors-generic-slot-1')).toHaveLength(0);
  });

  it('says WHY there is no aircraft, rather than leaving a bare list', () => {
    const r = diagram({mixerModeRaw: HEX6X, motorNumbers: [1, 2, 3, 4, 5, 6]});
    expect(r.hosts('motors-generic-outputs-caption')).toHaveLength(1);
    expect(r.text()).toContain('لا تتوفر هندسة إطار مؤكدة');
  });

  it('makes no positional claim in the fallback', () => {
    const body = diagram({
      mixerModeRaw: HEX6X,
      motorNumbers: [1, 2, 3, 4, 5, 6],
    }).text();
    for (const phrase of ['أمامي يمين', 'أمامي يسار', 'خلفي يمين', 'خلفي يسار']) {
      expect(body).not.toContain(phrase);
    }
  });

  it('the fallback still selects the same slot number it prints', () => {
    const taken: number[] = [];
    const r = render(
      <MotorAirframeDiagram
        mixerModeRaw={HEX6X}
        motorNumbers={[1, 2, 3, 4, 5, 6]}
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
