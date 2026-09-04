/**
 * TIME DOES NOT RUN RIGHT TO LEFT.
 *
 * =====================================================================
 * THE CONFUSION THIS EXISTS TO RULE OUT
 * =====================================================================
 *
 * This application is Arabic-first: rows, chips, navigation and prose
 * all run right to left, and they should. A sensor trace does not. Left
 * is older and right is newer on every oscilloscope, in every writing
 * direction, and an operator reading a gyro trace is reading a shape -
 * a spike settling, a drift growing - not a sentence.
 *
 * Mirror it with the layout and the shape reverses. A vibration that was
 * dying away now looks like one that is building; the operator lands to
 * fix a mount that was fine, or flies one that is not. `traceX` says so
 * in its own comment - "Left is older, right is newer, in every writing
 * direction" - and this is the test that holds it to that.
 *
 * =====================================================================
 * WHAT IS MEASURED, AND WHAT IS NOT
 * =====================================================================
 *
 * `rtlPhysicalTruth` proves the Sensors screen's NAMES do not change
 * with the layout. It says nothing about the ORDER of the samples, which
 * is a different claim and the one that carries the meaning here.
 *
 * So a deterministic four-sample window is fed in - T1, T2, T3, T4, with
 * values chosen so that every sample is distinguishable from every other
 * - and the polyline is read out of the rendered tree in both layouts:
 *
 *   - the same points, in the same order, at the same coordinates;
 *   - x increasing with time, so the newest sample is on the right;
 *   - each index mapping to the value it was given.
 *
 * This is a test about coordinates and order, not about pixels: jsdom
 * has no layout engine, and the polyline is SVG user space, which is
 * exactly where the claim lives.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {I18nManager} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {
  TraceCard,
  tracePoints,
  traceX,
  sharedTraceBound,
} from './SensorsScreen';

jest.setTimeout(120000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/**
 * FOUR SAMPLES, IN TIME ORDER, EVERY NUMBER DISTINCT.
 *
 * T1 is the oldest. The x values climb and the y values fall, so a
 * reversed window is not merely a different array - it is a different
 * SHAPE, which is what an operator actually reads.
 */
const T1 = {x: 10, y: 400, z: 1};
const T2 = {x: 120, y: 300, z: 2};
const T3 = {x: 230, y: 200, z: 3};
const T4 = {x: 340, y: 100, z: 4};
const WINDOW = [T1, T2, T3, T4] as const;

const MEASURED_WIDTH = 600;

/** Every polyline the card drew, by its `points` attribute. */
function polylinesOf(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(
      node => typeof (node.props as any)?.points === 'string',
      {deep: true},
    )
    .map(node => String((node.props as any).points))
    .filter(points => points.length > 0);
}

async function renderTrace(
  rtl: boolean,
): Promise<{polylines: string[]; text: string}> {
  const previous = I18nManager.isRTL;
  Object.defineProperty(I18nManager, 'isRTL', {
    value: rtl,
    configurable: true,
    writable: true,
  });
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <TraceCard
          family="GYRO"
          samples={[...WINDOW]}
          title="الجيروسكوب"
          unit="dps"
          t={((key: string) => key) as never}
        />,
      );
    });
    /* The plot measures itself through onLayout; without a width there
       is no honest place to put a point and the polyline is empty on
       purpose. So the measurement is delivered, exactly as the layout
       engine would. */
    const plot = tree.root.findAll(
      node => typeof (node.props as any)?.onLayout === 'function',
      {deep: true},
    )[0];
    if (plot !== undefined) {
      await act(async () => {
        (plot.props as any).onLayout({
          nativeEvent: {layout: {width: MEASURED_WIDTH, height: 120}},
        });
        await Promise.resolve();
      });
    }
    const polylines = polylinesOf(tree);
    const text = JSON.stringify(tree.toJSON());
    await act(async () => tree.unmount());
    return {polylines, text};
  } finally {
    Object.defineProperty(I18nManager, 'isRTL', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

describe('a sensor trace reads the same way in both layouts', () => {
  it('the plot really drew something to compare', async () => {
    /* THE SUBJECT EXISTS. Every assertion below would hold vacuously
       over an empty plot. */
    const ltr = await renderTrace(false);
    expect(ltr.polylines.length).toBeGreaterThan(0);
    expect(ltr.polylines[0].split(' ').length).toBe(WINDOW.length);
  });

  it('the polyline is identical, point for point, in RTL and LTR', async () => {
    const ltr = await renderTrace(false);
    const rtl = await renderTrace(true);
    expect({layout: 'rtl', polylines: rtl.polylines}).toEqual({
      layout: 'rtl',
      polylines: ltr.polylines,
    });
  });

  it('x increases with time, so the newest sample is on the right', async () => {
    const {polylines} = await renderTrace(true);
    for (const line of polylines) {
      const xs = line.split(' ').map(point => Number(point.split(',')[0]));
      const ascending = xs.every(
        (value, index) => index === 0 || value > xs[index - 1],
      );
      expect({points: xs.length, ascendingInTime: ascending}).toEqual({
        points: xs.length,
        ascendingInTime: true,
      });
      /* And the last sample sits at the right-hand edge of the measured
         plot, which is what "newest" means on a scope. */
      expect(xs[xs.length - 1]).toBe(MEASURED_WIDTH);
    }
  });

  it('sample index maps to the value it was given, in both layouts', async () => {
    /* Read straight out of the production geometry, so this is the map
       the screen itself uses rather than a re-derivation. */
    const bound = sharedTraceBound([...WINDOW]);
    for (const rtl of [false, true]) {
      const previous = I18nManager.isRTL;
      Object.defineProperty(I18nManager, 'isRTL', {
        value: rtl,
        configurable: true,
        writable: true,
      });
      try {
        const points = tracePoints([...WINDOW], 'x', bound, MEASURED_WIDTH)
          .split(' ')
          .map(point => point.split(',').map(Number));
        expect({rtl, count: points.length}).toEqual({rtl, count: WINDOW.length});
        points.forEach(([x], index) => {
          expect({rtl, index, x}).toEqual({
            rtl,
            index,
            x: Number(traceX(index, WINDOW.length, MEASURED_WIDTH).toFixed(2)),
          });
        });
        /* The ORDER of the values, which is the chronology itself. */
        const ys = points.map(([, y]) => y);
        const climbing = WINDOW.map(sample => sample.x);
        expect({
          rtl,
          valuesFollowTheSampleOrder: ys.every(
            (value, index) =>
              index === 0 ||
              (climbing[index] > climbing[index - 1]
                ? value < ys[index - 1]
                : value > ys[index - 1]),
          ),
        }).toEqual({rtl, valuesFollowTheSampleOrder: true});
      } finally {
        Object.defineProperty(I18nManager, 'isRTL', {
          value: previous,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('the detector would see a reversed window', () => {
    /* NEGATIVE CONTROL. If the samples were mirrored, the polyline the
       oracle above compares really would differ - so a pass means
       something. */
    const bound = sharedTraceBound([...WINDOW]);
    const forward = tracePoints([...WINDOW], 'x', bound, MEASURED_WIDTH);
    const reversed = tracePoints(
      [...WINDOW].reverse(),
      'x',
      bound,
      MEASURED_WIDTH,
    );
    expect(reversed).not.toBe(forward);
  });
});
