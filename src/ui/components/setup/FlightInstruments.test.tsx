import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import FlightInstruments, {
  computeFlightInstrumentSize,
  deriveArtificialHorizonTransform,
  isArtificialHorizonPitchOffScale,
  normalizeHeadingDegrees,
  normalizeRollDegrees,
  roundHeadingDegrees,
  shouldStackFlightInstruments,
} from './FlightInstruments';
import '../../../i18n';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
});

function render(
  props: React.ComponentProps<typeof FlightInstruments>,
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<FlightInstruments {...props} />);
  });
  mounted.push(renderer);
  return renderer;
}

function byTestID(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findByProps({ testID });
}

function findByTestID(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAllByProps({ testID })[0];
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

describe('FlightInstruments geometry', () => {
  it('fits two readable gauges inside the hero on narrow phones and tablets', () => {
    expect(computeFlightInstrumentSize(260)).toBe(112);
    expect(computeFlightInstrumentSize(330)).toBe(147);
    expect(computeFlightInstrumentSize(340)).toBe(152);
    expect(computeFlightInstrumentSize(1200)).toBe(156);
  });

  it('stacks the gauges when two readable faces cannot fit or text is enlarged', () => {
    expect(shouldStackFlightInstruments(260, 1)).toBe(false);
    expect(shouldStackFlightInstruments(259, 1)).toBe(true);
    expect(shouldStackFlightInstruments(330, 1.5)).toBe(true);
    expect(shouldStackFlightInstruments(330, Number.NaN)).toBe(false);
    expect(computeFlightInstrumentSize(180, true)).toBe(156);
    expect(computeFlightInstrumentSize(156, true, 0.8)).toBe(112);
  });

  it('normalizes compass headings and signed bank angles', () => {
    expect(normalizeHeadingDegrees(-10)).toBe(350);
    expect(normalizeHeadingDegrees(725)).toBe(5);
    expect(normalizeRollDegrees(350)).toBe(-10);
    expect(normalizeRollDegrees(190)).toBe(-170);
    expect(roundHeadingDegrees(359.6)).toBe(0);
  });

  it('moves the artificial horizon opposite bank and down for nose-up pitch', () => {
    expect(deriveArtificialHorizonTransform(25, 15, 140)).toEqual({
      rollDeg: -25,
      pitchOffsetPx: 19.6,
    });
    // Visual travel is bounded so extreme attitudes never expose the
    // edge of the larger sky/ground plane.
    expect(deriveArtificialHorizonTransform(-20, 80, 140)).toEqual({
      rollDeg: 20,
      pitchOffsetPx: 39.2,
    });
    expect(isArtificialHorizonPitchOffScale(30)).toBe(false);
    expect(isArtificialHorizonPitchOffScale(30.1)).toBe(true);
    expect(isArtificialHorizonPitchOffScale(-31)).toBe(true);
  });
});

describe('FlightInstruments rendering contract', () => {
  it('renders a clear live horizon and rotating relative compass from one pose', () => {
    const renderer = render({
      status: 'LIVE',
      stageWidth: 330,
      rollDeg: 12.5,
      pitchDeg: -6.5,
      headingDeg: 275,
    });

    expect(
      byTestID(renderer, 'artificial-horizon').props.accessibilityLabel,
    ).toBe('الأفق الاصطناعي، الدوران 12.5 درجة، الميل -6.5 درجة');
    // SETUP P3: the word "بوصلة" (compass) is gone from this label on
    // purpose. Screen-reader users were being told this instrument was a
    // compass; it is the FC's yaw offset from the operator's own reset
    // point, so the label now names the reference instead of implying a
    // magnetic one.
    expect(
      byTestID(renderer, 'direction-compass').props.accessibilityLabel,
    ).toBe('الاتجاه النسبي، 275 درجة من نقطة الضبط الحالية');
    const horizonTransform = StyleSheet.flatten(
      byTestID(renderer, 'artificial-horizon-moving-world').props.style,
    ).transform;
    expect(horizonTransform[0].translateY).toBeCloseTo(-8.918);
    expect(horizonTransform[1]).toEqual({ rotate: '-12.5deg' });
    // The enlarged moving plane covers the circular viewport even at the
    // worst combined bank/pitch corner; the older 1.8x plane did not.
    expect(
      StyleSheet.flatten(
        byTestID(renderer, 'artificial-horizon-moving-world').props.style,
      ).width,
    ).toBeCloseTo(147 * 2.1);
    expect(
      StyleSheet.flatten(
        byTestID(renderer, 'direction-compass-dial').props.style,
      ).transform,
    ).toEqual([{ rotate: '-275deg' }]);
    // The dial's own title is "الاتجاه النسبي" (relative direction), and
    // its graduations are degree numbers rather than N/E/S/W - see the
    // dedicated relative-direction suite below for why the cardinal rose
    // was removed rather than restyled.
    expect(allText(renderer)).toEqual(
      expect.arrayContaining(['الأفق الاصطناعي', 'الاتجاه النسبي', '275°']),
    );
  });

  it('marks pitch beyond the visual ladder instead of silently clamping it', () => {
    const renderer = render({
      status: 'LIVE',
      stageWidth: 330,
      pitchDeg: 42,
    });
    expect(
      byTestID(renderer, 'artificial-horizon-pitch-off-scale'),
    ).toBeDefined();
    expect(allText(renderer)).toContain('أعلى من +٣٠°');
  });

  it('uses a bounded stacked layout on very narrow or large-text screens', () => {
    const renderer = render({
      status: 'LIVE',
      stageWidth: 330,
      fontScale: 1.5,
    });
    expect(byTestID(renderer, 'flight-instruments-stacked')).toBeDefined();
    expect(
      renderer.root.findAllByProps({ testID: 'flight-instruments-row' }),
    ).toHaveLength(0);
  });

  it('renders two separate 20%-smaller sidebar cards with the compass above the horizon', () => {
    const renderer = render({
      status: 'LIVE',
      stageWidth: 156,
      layout: 'sidebar',
      sizeScale: 0.8,
      headingDeg: 45,
    });
    const stack = byTestID(renderer, 'flight-instruments-stacked');
    const faces = stack.findAll(
      node =>
        node.props.testID === 'direction-compass' ||
        node.props.testID === 'artificial-horizon',
    );
    expect([...new Set(faces.map(node => node.props.testID))]).toEqual([
      'direction-compass',
      'artificial-horizon',
    ]);
    expect(
      StyleSheet.flatten(byTestID(renderer, 'direction-compass').props.style)
        .width,
    ).toBe(112);
  });

  /**
   * SETUP P3: this component no longer SPEAKS about status.
   *
   * It used to carry its own eyebrow, title and status pill, and it
   * renders inside OrientationHero, which already has all three - P0
   * measured "مباشر" printed twice in one hero for exactly that reason.
   * One section, one state indicator, and the hero's badge is the
   * survivor because it speaks for the whole orientation section rather
   * than for two dials.
   *
   * The stale TRUTH is not lost, only de-duplicated: OrientationHero's
   * own test asserts both the STALE badge and the
   * `orientation-hero-stale-label` line. What this component must still
   * do is keep showing the last real numbers instead of blanking them,
   * and not raise the "unavailable" overlay - both asserted here.
   */
  it('keeps the last real values visible when stale, and claims no status of its own', () => {
    const renderer = render({
      status: 'STALE',
      stageWidth: 330,
      rollDeg: 1,
      pitchDeg: 2,
      headingDeg: 5,
    });
    expect(allText(renderer)).toContain('005°');
    expect(
      findByTestID(renderer, 'artificial-horizon-overlay'),
    ).toBeUndefined();
    expect(allText(renderer)).not.toContain('قراءة متأخرة');
    expect(allText(renderer)).not.toContain('مباشر');
  });

  it.each(['WAITING', 'ERROR'] as const)(
    '%s shows truthful unavailable faces without invented numeric readings',
    status => {
      const renderer = render({ status, stageWidth: 330 });
      expect(
        byTestID(renderer, 'flight-instruments').props.accessibilityState,
      ).toEqual({
        disabled: true,
      });
      expect(byTestID(renderer, 'artificial-horizon-overlay')).toBeDefined();
      expect(byTestID(renderer, 'direction-compass-overlay')).toBeDefined();
      expect(
        renderer.root.findAllByProps({ testID: 'direction-compass-value' }),
      ).toHaveLength(0);
      expect(allText(renderer)).not.toContain('000°');
    },
  );
});
