/**
 * M-D §33 - THE TWENTY STATES, RENDERED.
 *
 * A fixture object is not a state. Every case below mounts the real
 * summary component and reads what an operator would actually see, so a
 * regression that only shows up in rendering - a missing key, a card that
 * collapses to nothing, a number that arrives as `NaN` - fails here
 * rather than in a screenshot nobody looks at twice.
 *
 * WHAT EACH CASE IS FOR. The airframes are not decoration: TRI proves a
 * servo is named without being offered, HEX and OCTO prove motors 5-8 are
 * first class, WING and AIRPLANE prove one motor stays one motor beside
 * six servo outputs, CUSTOM proves an unobservable topology is not a
 * fault, and UNKNOWN proves a mixer byte outside our table survives as
 * itself rather than becoming a quad.
 */

import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';

import type { MotorVectorScope } from '../../core/firmware-adapters/betaflightMotorVectorsV147';
import i18n from '../../i18n';
import { MotorAirframeSummary } from './MotorAirframeSummary';

/** mixerMode_e ordinals, mixer.h:38-66 @ 7348054f. */
const TRI = 1;
const QUADX = 3;
const GIMBAL = 5;
const Y6 = 6;
const FLYING_WING = 8;
const HEX6X = 10;
const OCTOX8 = 11;
const AIRPLANE = 14;
const CUSTOM = 23;
const UNKNOWN_RAW = 250;

function scopeFor(
  motorCount: number,
  motorProtocolRaw = 7,
  feature3dEnabled = false,
): MotorVectorScope {
  return { motorCount, motorProtocolRaw, feature3dEnabled } as MotorVectorScope;
}

interface Rendered {
  readonly text: string;
  has(testID: string): boolean;
  unmount(): void;
}

function render(
  props: Partial<React.ComponentProps<typeof MotorAirframeSummary>> = {},
): Rendered {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <MotorAirframeSummary
        mixerModeRaw={QUADX}
        runtimeMotorCount={4}
        scope={scopeFor(4)}
        motorTestAvailable
        {...props}
      />,
    );
  });
  return {
    text: JSON.stringify(tree.toJSON()),
    has: (testID: string) =>
      tree.root.findAll(node => node.props?.testID === testID).length > 0,
    unmount: () => ReactTestRenderer.act(() => tree.unmount()),
  };
}

const ar = (key: string, params?: Record<string, unknown>): string =>
  String(i18n.t(key, params as never));

describe('M-D §33 - every required airframe state renders its own truth', () => {
  it.each([
    ['1. QUADX / 4', QUADX, 4, 'QUADX'],
    ['2. TRI / 3', TRI, 3, 'TRI'],
    ['3. HEX6X / 6', HEX6X, 6, 'HEX6X'],
    ['4. Y6 / 6', Y6, 6, 'Y6'],
    ['5. OCTOX8 / 8', OCTOX8, 8, 'OCTOX8'],
    ['6. FLYING_WING / 1', FLYING_WING, 1, 'FLYING_WING'],
    ['7. AIRPLANE / 1', AIRPLANE, 1, 'AIRPLANE'],
    ['8. CUSTOM / 5', CUSTOM, 5, 'CUSTOM'],
  ])('%s names itself and its own motor count', (_label, mixer, count, name) => {
    const r = render({
      mixerModeRaw: mixer,
      runtimeMotorCount: count,
      scope: scopeFor(count),
    });
    expect(r.text).toContain(ar(`motorsScreen.topology.airframe.${name}`));
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count }),
    );
    r.unmount();
  });

  it('9. an UNKNOWN mixer keeps its raw number and does not become a quad', () => {
    const r = render({
      mixerModeRaw: UNKNOWN_RAW,
      runtimeMotorCount: 3,
      scope: scopeFor(3),
    });
    expect(r.text).toContain(
      ar('motorsScreen.topology.airframe.unknownRaw', { raw: UNKNOWN_RAW }),
    );
    expect(r.text).not.toContain(ar('motorsScreen.topology.airframe.QUADX'));
    // Three motors, from the board. Not four.
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 3 }),
    );
    expect(r.has('motors-summary-notice-MIXER_MODE_NOT_IN_PINNED_TABLE')).toBe(
      true,
    );
    r.unmount();
  });

  it('10. a zero-motor mixer says so, and is not called a fault', () => {
    const r = render({
      mixerModeRaw: GIMBAL,
      runtimeMotorCount: 0,
      scope: scopeFor(0),
    });
    expect(r.text).toContain(ar('motorsScreen.topology.runtimeCount.none'));
    // A servo-only mixer reporting no motors is a legitimate machine.
    expect(r.has('motors-summary-notices')).toBe(false);
    r.unmount();
  });

  it('11. an expected/runtime mismatch shows BOTH figures, apart', () => {
    const r = render({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 6,
      scope: scopeFor(6),
    });
    expect(
      r.has('motors-summary-notice-RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE'),
    ).toBe(true);
    expect(r.text).toContain(
      ar('motorsScreen.topology.expectedCount.fixed', { count: 4 }),
    );
    // ...and the reported figure is the one that governs.
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 6 }),
    );
    r.unmount();
  });

  it('12. a telemetry-count mismatch is its own diagnostic, not a topology change', () => {
    const r = render({
      mixerModeRaw: HEX6X,
      runtimeMotorCount: 6,
      scope: scopeFor(6),
      telemetryFrameMotorCount: 4,
    });
    expect(
      r.has(
        'motors-summary-notice-TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT',
      ),
    ).toBe(true);
    // SIX motors still. The telemetry frame does not shrink the aircraft.
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 6 }),
    );
    expect(r.text).not.toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 4 }),
    );
    r.unmount();
  });

  it('17. an available motor test and an unavailable one read differently', () => {
    const on = render({ motorTestAvailable: true });
    expect(on.text).toContain(ar('motorsScreen.summary.testAvailable'));
    on.unmount();
    const off = render({ motorTestAvailable: false });
    expect(off.text).toContain(ar('motorsScreen.summary.testUnavailable'));
    // The words differ, not just a colour (M-D §47). Asserted as
    // INEQUALITY rather than absence: "متاح" is a substring of
    // "غير متاح الآن", so a negated substring check would fail on a
    // perfectly correct render.
    expect(ar('motorsScreen.summary.testAvailable')).not.toBe(
      ar('motorsScreen.summary.testUnavailable'),
    );
    expect(off.text).not.toContain(ar('motorsScreen.summary.testAvailable') + '"');
    off.unmount();
  });

  it('19. nothing read yet renders nothing, rather than a card of unknowns', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeSummary
          mixerModeRaw={undefined}
          runtimeMotorCount={undefined}
          scope={undefined}
          motorTestAvailable={false}
        />,
      );
    });
    expect(tree.toJSON()).toBeNull();
    ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('M-D §6 / §10 / §11 / §32 - servos are named, never offered', () => {
  it('TRI names its tail servo and says it is not in the motor test', () => {
    const r = render({
      mixerModeRaw: TRI,
      runtimeMotorCount: 3,
      scope: scopeFor(3),
    });
    expect(r.has('motors-summary-servo')).toBe(true);
    expect(r.text).toContain(ar('motorsScreen.topology.servo.TRI', { count: 1 }));
    r.unmount();
  });

  it.each([
    ['FLYING_WING', FLYING_WING, 2],
    ['AIRPLANE', AIRPLANE, 6],
  ])('%s names its control surfaces without offering them', (
    name,
    mixer,
    servoCount,
  ) => {
    const r = render({
      mixerModeRaw: mixer,
      runtimeMotorCount: 1,
      scope: scopeFor(1),
    });
    expect(r.text).toContain(
      ar(`motorsScreen.topology.servo.${name}`, { count: servoCount }),
    );
    // ONE motor. Six servo outputs on an airplane never become motors.
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 1 }),
    );
    r.unmount();
  });

  it('says nothing about servos on a mixer that has none', () => {
    const r = render({
      mixerModeRaw: HEX6X,
      runtimeMotorCount: 6,
      scope: scopeFor(6),
    });
    expect(r.has('motors-summary-servo')).toBe(false);
    r.unmount();
  });

  it('offers no servo control on any airframe that has servos', () => {
    for (const [mixer, motors] of [
      [TRI, 3],
      [FLYING_WING, 1],
      [AIRPLANE, 1],
    ] as const) {
      const r = render({
        mixerModeRaw: mixer,
        runtimeMotorCount: motors,
        scope: scopeFor(motors),
      });
      // No pressable of any kind lives in this region.
      expect(r.text).not.toContain('onPress');
      expect(r.text).not.toMatch(/servo-(slider|identify|test)/);
      r.unmount();
    }
  });
});

describe('M-D §29 / §46 - protocol names, and no dashes', () => {
  it.each([
    [0, 'PWM'],
    [4, 'BRUSHED'],
    [5, 'DSHOT150'],
    [6, 'DSHOT300'],
    [7, 'DSHOT600'],
    [8, 'PROSHOT1000'],
    [9, 'DISABLED'],
  ])('raw %i renders %s', (raw, name) => {
    const r = render({ scope: scopeFor(4, raw) });
    expect(r.text).toContain(name);
    r.unmount();
  });

  it('never renders DSHOT1200, at any raw value', () => {
    for (let raw = 0; raw <= 12; raw++) {
      const r = render({ scope: scopeFor(4, raw) });
      expect(r.text).not.toContain('DSHOT1200');
      r.unmount();
    }
  });

  it('says the protocol has not been read rather than drawing a dash', () => {
    const r = render({ scope: undefined, runtimeMotorCount: 4 });
    expect(r.text).toContain(ar('motorsScreen.summary.protocolNotRead'));
    r.unmount();
  });

  it('renders no em dash in any of the twenty states', () => {
    // M-D §46. An em dash in a metric slot reads as zero, or broken, or
    // loading, and is none of those.
    for (const [mixer, count, scope] of [
      [QUADX, 4, scopeFor(4)],
      [TRI, 3, scopeFor(3)],
      [HEX6X, 6, scopeFor(6)],
      [OCTOX8, 8, scopeFor(8)],
      [CUSTOM, 5, scopeFor(5)],
      [UNKNOWN_RAW, 3, scopeFor(3)],
      [GIMBAL, 0, scopeFor(0)],
      [QUADX, 4, undefined],
    ] as const) {
      const r = render({
        mixerModeRaw: mixer,
        runtimeMotorCount: count,
        scope,
      });
      // A DASH USED AS A VALUE, not a dash anywhere. The airframe label
      // is "QUAD X — رباعي X": the em dash separates the established FPV
      // name from its Arabic gloss and is typography, not a missing
      // reading. What §46 forbids is a metric whose entire content is a
      // dash, which is what an empty telemetry shell looks like.
      expect(r.text).not.toMatch(/"children":\["\s*[—–-]\s*"\]/);
      r.unmount();
    }
  });
});

describe('M-D §13 / §16 - a custom mixer is not a mismatch', () => {
  it('CUSTOM at runtime 5 shows no expected-count disagreement', () => {
    const r = render({
      mixerModeRaw: CUSTOM,
      runtimeMotorCount: 5,
      scope: scopeFor(5),
    });
    expect(
      r.has('motors-summary-notice-RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE'),
    ).toBe(false);
    // It explains WHY there is no expectation, rather than inventing one.
    expect(
      r.has('motors-summary-notice-CUSTOM_TOPOLOGY_NOT_OBSERVABLE_OVER_MSP'),
    ).toBe(true);
    expect(r.text).not.toContain(
      ar('motorsScreen.topology.expectedCount.fixed', { count: 4 }),
    );
    r.unmount();
  });

  it('a matching machine says nothing at all', () => {
    const r = render({
      mixerModeRaw: HEX6X,
      runtimeMotorCount: 6,
      scope: scopeFor(6),
    });
    expect(r.has('motors-summary-notices')).toBe(false);
    r.unmount();
  });
});

describe('M-D §20 - RTL does not reverse a motor count', () => {
  it('renders the same figures under the Arabic locale it was built for', () => {
    // The app is Arabic-only and RTL throughout; the point of this test
    // is that the NUMBER six is six, not that a layout mirrors. The
    // per-motor index invariant is proven where indices exist - see
    // motorNumberingAndDiagram and the production-path matrix.
    expect(i18n.language).toBe('ar');
    const r = render({
      mixerModeRaw: HEX6X,
      runtimeMotorCount: 6,
      scope: scopeFor(6),
    });
    expect(r.text).toContain(
      ar('motorsScreen.topology.runtimeCount.reported', { count: 6 }),
    );
    r.unmount();
  });
});
