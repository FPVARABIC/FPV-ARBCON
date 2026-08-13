/**
 * SETUP P3 - the yaw instrument may not claim to be a compass.
 *
 * WHAT P0 PROVED. The dial is driven by MSP_ATTITUDE's yaw, offset by
 * the operator's own "reset view" capture. Betaflight reports that yaw
 * from the attitude estimator; on a board with no magnetometer - the
 * normal case for an FPV quad - it is gyro-integrated heading, which
 * drifts and has no fixed relationship to magnetic north at all. Even
 * WITH a mag, the number this app displays has had an arbitrary operator
 * reference subtracted from it, so it is a RELATIVE rotation by
 * construction.
 *
 * WHAT THE INSTRUMENT USED TO SAY. A cardinal rose (N/E/S/W) with the N
 * picked out in red - the exact visual vocabulary of a magnetic compass,
 * plus an Arabic title that began with the word "بوصلة" (compass). The
 * pixels claimed a magnetic bearing the data cannot support.
 *
 * These tests pin the correction so it cannot regress quietly: no
 * cardinal letters at any yaw, degree graduations instead, no red north
 * needle, Cairo everywhere, and a caveat that names the reference. They
 * also pin the ROTATION SEMANTICS at the four quarter turns, because
 * "the letters are gone" would be a hollow fix if the dial spun the
 * wrong way.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import FlightInstruments from './FlightInstruments';
import { fonts } from '../../theme';
import '../../../i18n';
import i18n from '../../../i18n';

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

function texts(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

const LIVE = { status: 'LIVE', stageWidth: 330 } as const;
/** Every quarter turn, plus a value between two of them. */
const YAWS = [0, 90, 180, 270, 275] as const;

describe('the yaw dial makes no magnetic claim', () => {
  it.each(YAWS)('shows no cardinal letters at yaw %d', yaw => {
    const renderer = render({ ...LIVE, headingDeg: yaw });
    const rendered = texts(renderer);
    for (const cardinal of ['N', 'E', 'S', 'W', 'ش', 'ق', 'ج', 'غ']) {
      expect(rendered).not.toContain(cardinal);
    }
  });

  it('graduates the dial in degrees at the quarter turns', () => {
    const renderer = render({ ...LIVE, headingDeg: 0 });
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['0°', '90°', '180°', '270°']),
    );
  });

  it('renders every graduation in Cairo', () => {
    // P0 measured the four cardinal letters as the ONLY non-Cairo text
    // nodes on the whole Setup surface: their style set size, weight and
    // colour but never a family, so they silently inherited the platform
    // default. The replacement style sets it explicitly.
    const renderer = render({ ...LIVE, headingDeg: 0 });
    const marks = renderer.root
      .findAllByType(Text)
      .filter(node => /^\d+°$/.test(String(node.props.children)));
    expect(marks.length).toBeGreaterThanOrEqual(4);
    for (const mark of marks) {
      expect(StyleSheet.flatten(mark.props.style).fontFamily).toBe(
        fonts.family,
      );
    }
  });

  it('paints no north needle: every graduation shares one colour', () => {
    const renderer = render({ ...LIVE, headingDeg: 0 });
    const colours = new Set(
      renderer.root
        .findAllByType(Text)
        .filter(node => /^\d+°$/.test(String(node.props.children)))
        .map(node => StyleSheet.flatten(node.props.style).color),
    );
    expect(colours.size).toBe(1);
  });

  it('titles the instrument as a relative direction, not a compass', () => {
    const renderer = render({ ...LIVE, headingDeg: 42 });
    const title = i18n.t('flightInstruments.compass');
    expect(texts(renderer)).toContain(title);
    expect(title).not.toContain('بوصلة');
  });

  it('states in words that this is not a magnetic bearing', () => {
    // The caveat lives once, on the hero's own note line (P3 removed the
    // duplicate under the dials), so this asserts the STRING is honest
    // rather than where it is painted.
    const note = i18n.t('flightInstruments.relativeNote');
    expect(note).toContain('نسبي');
    expect(note).toContain('مغناطيسي');
  });
});

describe('the yaw dial rotates correctly', () => {
  /** The dial carries the card; a heading of H must put H under the
   * fixed lubber line, which means rotating the card by -H. */
  it.each(YAWS)('counter-rotates the card by the heading at yaw %d', yaw => {
    const renderer = render({ ...LIVE, headingDeg: yaw });
    const dial = renderer.root.findByProps({
      testID: 'direction-compass-dial',
    });
    // `${-0}` is "0", not "-0", so zero is spelled without the sign.
    expect(StyleSheet.flatten(dial.props.style).transform).toEqual([
      { rotate: `${-yaw}deg` },
    ]);
  });

  it.each([
    [0, '000°'],
    [90, '090°'],
    [180, '180°'],
    [270, '270°'],
  ])('reads yaw %d as %s', (yaw, expected) => {
    const renderer = render({ ...LIVE, headingDeg: yaw });
    expect(texts(renderer)).toContain(expected);
  });

  it('normalizes a negative yaw the same way the readout does', () => {
    const renderer = render({ ...LIVE, headingDeg: -90 });
    const dial = renderer.root.findByProps({
      testID: 'direction-compass-dial',
    });
    expect(StyleSheet.flatten(dial.props.style).transform).toEqual([
      { rotate: '-270deg' },
    ]);
    expect(texts(renderer)).toContain('270°');
  });

  it('names the reference in the accessibility label at every quarter turn', () => {
    for (const yaw of [0, 90, 180, 270]) {
      const renderer = render({ ...LIVE, headingDeg: yaw });
      const label = renderer.root.findByProps({ testID: 'direction-compass' })
        .props.accessibilityLabel;
      expect(label).toContain(String(yaw));
      expect(label).toContain('النسبي');
      expect(label).not.toContain('بوصلة');
    }
  });
});

describe('the instrument panel no longer duplicates the hero', () => {
  it('carries no status pill and no second section title', () => {
    const renderer = render({ ...LIVE, headingDeg: 10 });
    const rendered = texts(renderer);
    expect(rendered).not.toContain('مباشر');
    expect(rendered).not.toContain(i18n.t('flightInstruments.title'));
    expect(rendered).not.toContain(i18n.t('flightInstruments.eyebrow'));
  });

  it('renders exactly the two instrument faces and nothing else', () => {
    const renderer = render({ ...LIVE, headingDeg: 10 });
    const faces = renderer.root
      .findAll(
        node =>
          node.type === View &&
          (node.props.testID === 'artificial-horizon' ||
            node.props.testID === 'direction-compass'),
      )
      .map(node => node.props.testID);
    expect(faces).toEqual(['artificial-horizon', 'direction-compass']);
  });
});
