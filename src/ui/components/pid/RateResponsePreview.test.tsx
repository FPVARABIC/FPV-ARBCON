/**
 * A picture of a rate curve can be wrong in two ways that matter.
 *
 * It can DOMINATE - the Motors diagram once pushed every control it existed
 * to explain below the fold - so the height budget is asserted here rather
 * than left to a stylesheet nobody re-reads.
 *
 * And it can LIE - by drawing one of QUICK's two possible shapes, by
 * mirroring the stick axis under RTL so left stick reads as right, or by
 * looking like telemetry. Each of those has a test.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {
  RATES_TYPE_BETAFLIGHT, RATES_TYPE_QUICK, classifyRatesType,
  maximumSetpointDegPerSec, type RateAxisSettings,
} from '../../../core/state/rateFormulaEngine';
import RateResponsePreview, {
  PREVIEW_AXES, PREVIEW_MAX_HEIGHT, PREVIEW_MIN_HEIGHT, PREVIEW_VIEWPORT_SHARE,
  previewHeightFor,
} from './RateResponsePreview';

const AXIS: RateAxisSettings = Object.freeze({rcRate: 100, superRate: 70, expo: 0, rateLimit: 1998});
const AXES = Object.freeze({roll: AXIS, pitch: AXIS, yaw: {...AXIS, superRate: 50}});

function render(typeRaw: number, axes: typeof AXES = AXES) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <RateResponsePreview
        type={classifyRatesType(typeRaw)}
        axes={axes}
        selectedAxis="roll"
        onSelectAxis={jest.fn()}
      />,
    );
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
    .join('\n');
}

describe('the height budget', () => {
  it('never grows past the ceiling on a tall desktop viewport', () => {
    expect(previewHeightFor(2160)).toBe(PREVIEW_MAX_HEIGHT);
  });

  it('never shrinks below the floor on a short one', () => {
    expect(previewHeightFor(200)).toBe(PREVIEW_MIN_HEIGHT);
  });

  it('takes a fixed share of the viewport in between', () => {
    const viewport = 700;
    expect(previewHeightFor(viewport)).toBe(Math.round(viewport * PREVIEW_VIEWPORT_SHARE));
    // The chart on a 390x844 phone must stay a fraction of the screen, so
    // the axis fields it supports are not a viewport away.
    expect(previewHeightFor(844)).toBeLessThan(844 / 4);
  });
});

describe('an exact curve', () => {
  it('draws the chart and the peak the engine reports', () => {
    const renderer = render(RATES_TYPE_BETAFLIGHT);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-chart'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-curve'}).length).toBeGreaterThan(0);
    const expected = Math.round(maximumSetpointDegPerSec(classifyRatesType(RATES_TYPE_BETAFLIGHT), AXIS) ?? 0);
    expect(textOf(renderer)).toContain(String(expected));
    act(() => renderer.unmount());
  });

  it('calls itself a calculation and never a live reading', () => {
    const renderer = render(RATES_TYPE_BETAFLIGHT);
    const text = textOf(renderer);
    expect(text).toContain('معاينة');
    expect(text).toContain('ليس قراءة حيّة');
    expect(text).not.toContain('مباشر');
    act(() => renderer.unmount());
  });

  it('offers the axes in a fixed Roll/Pitch/Yaw order that RTL does not reorder', () => {
    expect(PREVIEW_AXES.map(axis => axis.key)).toEqual(['roll', 'pitch', 'yaw']);
    const renderer = render(RATES_TYPE_BETAFLIGHT);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-axis'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('maps the stick from -1 on the left to +1 on the right, unmirrored', () => {
    // The horizontal axis is a signed number line. Reversing it under a
    // right-to-left layout would make a left stick input read as a right one.
    const renderer = render(RATES_TYPE_BETAFLIGHT);
    const curve = renderer.root.findAllByProps({testID: 'pid-rate-preview-curve'})
      .find(node => typeof node.props.points === 'string');
    const points = String(curve?.props.points).split(' ').map(pair => pair.split(',').map(Number));
    expect(points[0][0]).toBeCloseTo(0, 5);
    expect(points[points.length - 1][0]).toBeGreaterThan(points[0][0]);
    // Y is inverted in SVG space, so a positive rate at full right stick has
    // to sit ABOVE the centre line.
    expect(points[points.length - 1][1]).toBeLessThan(points[Math.floor(points.length / 2)][1]);
    act(() => renderer.unmount());
  });

  it('says when the rate profile limit is cutting the curve short', () => {
    const clipped = {...AXES, roll: {...AXIS, rateLimit: 200}};
    const renderer = render(RATES_TYPE_BETAFLIGHT, clipped);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-clipped'}).length).toBeGreaterThan(0);
    expect(textOf(renderer)).toContain('200');
    act(() => renderer.unmount());
  });

  it('gives the chart a textual alternative rather than an unlabelled image', () => {
    const renderer = render(RATES_TYPE_BETAFLIGHT);
    const chart = renderer.root.findAllByProps({testID: 'pid-rate-preview-chart'})
      .find(node => typeof node.props.accessibilityLabel === 'string');
    expect(chart?.props.accessibilityLabel).toContain('Roll');
    expect(chart?.props.accessibilityLabel).toContain('درجة/ثانية');
    act(() => renderer.unmount());
  });
});

describe('when no exact curve exists', () => {
  it('draws nothing for QUICK instead of picking one of its two branches', () => {
    const renderer = render(RATES_TYPE_QUICK);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-unavailable'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-chart'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-curve'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('keeps QUICK configurable, and says so', () => {
    // The missing preview is a display limit, not a write limit: a QUICK
    // rate profile saves like any other.
    expect(textOf(render(RATES_TYPE_QUICK))).toContain('حفظه');
  });

  it('refuses an unrecognised formula and shows its raw value', () => {
    const renderer = render(13);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-unavailable'}).length).toBeGreaterThan(0);
    expect(textOf(renderer)).toContain('13');
    act(() => renderer.unmount());
  });
});
