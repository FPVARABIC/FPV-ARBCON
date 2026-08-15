import React from 'react'; import ReactTestRenderer from 'react-test-renderer'; import '../../i18n'; import SensorsScreen from './SensorsScreen'; describe('SensorsScreen', () => {it('renders real telemetry surfaces and calibration route', () => {const onOpenSetup = jest.fn(); let renderer!: ReactTestRenderer.ReactTestRenderer; ReactTestRenderer.act(() => {renderer = ReactTestRenderer.create(<SensorsScreen active={false} onOpenSetup={onOpenSetup} />);}); expect(renderer.root.findByProps({testID: 'sensors-screen'})).toBeDefined(); expect(renderer.root.findAllByProps({testID: 'sensor-trace-x'}).length).toBeGreaterThanOrEqual(3); ReactTestRenderer.act(() => renderer.root.findByProps({testID: 'sensors-open-setup'}).props.onPress()); expect(onOpenSetup).toHaveBeenCalledTimes(1); ReactTestRenderer.act(() => renderer.unmount());});});

/**
 * SENSORS FINAL UI CORRECTION - the trace is asserted as GEOMETRY, not
 * as a picture: sign must be position, the scale must be shared across
 * the three axes of one sensor, zero must be a real reference line, and
 * an absent sensor must render neither numbers nor traces.
 */
import {
  sharedTraceBound,
  tracePoints,
  traceY,
  TRACE_HEIGHT,
  VectorCard,
} from './SensorsScreen';

describe('sensor trace truth', () => {
  const CENTER = TRACE_HEIGHT / 2;

  it('maps sign to position: positive above the zero line, negative below, zero exactly on it', () => {
    expect(traceY(0, 100)).toBe(CENTER);
    expect(traceY(50, 100)).toBeLessThan(CENTER);
    expect(traceY(-50, 100)).toBeGreaterThan(CENTER);
    // Symmetric: +v and -v sit at mirrored distances from the line.
    expect(CENTER - traceY(50, 100)).toBeCloseTo(traceY(-50, 100) - CENTER);
    // The bound itself touches the padded extremes, clamped beyond.
    expect(traceY(100, 100)).toBe(traceY(150, 100));
  });

  it('shares ONE bound across all three axes so amplitudes keep their true proportion', () => {
    expect(sharedTraceBound([{ x: 10, y: -500, z: 2 }])).toBe(500);
    expect(sharedTraceBound([])).toBe(1);
    const bound = sharedTraceBound([
      { x: 100, y: -400, z: 0 },
      { x: -50, y: 200, z: 5 },
    ]);
    // X's 100 must render at a QUARTER of Y's 400 - not rescaled to
    // fill its own strip the way the old per-axis sparkline did.
    const yAmplitude = CENTER - traceY(400, bound);
    const xAmplitude = CENTER - traceY(100, bound);
    expect(xAmplitude / yAmplitude).toBeCloseTo(0.25);
  });

  it('emits one point per sample at sequential time positions', () => {
    const points = tracePoints(
      [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
      'x',
      1,
    );
    const xs = points.split(' ').map(pair => pair.split(',')[0]);
    expect(xs).toEqual(['0', '1', '2']);
  });

  it('renders traces, zero lines and the stated shared scale for a detected sensor', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <VectorCard
          id="gyro"
          title="الجيروسكوب"
          vector={{ x: 12, y: -300, z: 4 }}
          history={[
            { x: 10, y: -250, z: 3 },
            { x: 12, y: -300, z: 4 },
          ]}
          suffix="dps"
          detected
        />,
      );
    });
    for (const axis of ['x', 'y', 'z']) {
      expect(
        renderer.root.findAllByProps({ testID: `sensor-trace-${axis}` }).length,
      ).toBeGreaterThan(0);
      expect(
        renderer.root.findAllByProps({ testID: `sensor-trace-${axis}-zero` })
          .length,
      ).toBeGreaterThan(0);
    }
    const scale = renderer.root.findAllByProps({
      testID: 'sensor-card-gyro-scale',
    })[0];
    expect(JSON.stringify(scale.props.children)).toContain('±300 dps');
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('an absent sensor renders NO numbers and NO traces - only the explicit unavailable panel', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <VectorCard
          id="mag"
          title="البوصلة المغناطيسية"
          vector={{ x: 0, y: 0, z: 0 }}
          history={[
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
          ]}
          suffix="raw"
          detected={false}
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({ testID: 'sensor-card-mag-unavailable' })
        .length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ testID: 'sensor-trace-x' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'sensor-card-mag-scale' }),
    ).toHaveLength(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

describe('monitor-sharp trace presentation', () => {
  it('renders unsmoothed piecewise-linear traces: miter joins, butt caps, thin stroke, exact sample points', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    const history = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: -50, z: 25 },
      { x: -100, y: 50, z: -25 },
    ];
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <VectorCard
          id="gyro"
          title="الجيروسكوب"
          vector={history[2]}
          history={history}
          suffix="dps"
          detected
        />,
      );
    });
    const polylines = renderer.root.findAll(
      node =>
        node.props?.points !== undefined && node.props?.stroke !== undefined,
    );
    expect(polylines.length).toBeGreaterThanOrEqual(3);
    for (const line of polylines) {
      // Sharp corners, no rounding, no curve primitive: a polyline's
      // points attribute IS the raw sample geometry, one pair per
      // sample, nothing interpolated between them.
      expect(line.props.strokeLinejoin).toBe('miter');
      expect(line.props.strokeLinecap).toBe('butt');
      expect(line.props.strokeWidth).toBeLessThanOrEqual(1.5);
      expect(String(line.props.points).split(' ')).toHaveLength(
        history.length,
      );
    }
    // The exact mapping, verbatim - raw positions preserved.
    const bound = sharedTraceBound(history);
    const xLine = polylines.find(l =>
      String(l.props.points).startsWith(`0,${traceY(0, bound).toFixed(2)}`),
    );
    expect(xLine).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('draws the monitor reference structure: zero line plus ±half-scale hairlines per axis', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <VectorCard
          id="acc"
          title="مقياس التسارع"
          vector={{ x: 1, y: 2, z: 3 }}
          history={[
            { x: 1, y: 2, z: 3 },
            { x: -1, y: -2, z: -3 },
          ]}
          suffix="raw"
          detected
        />,
      );
    });
    for (const axis of ['x', 'y', 'z']) {
      for (const ref of ['zero', 'ref-pos', 'ref-neg']) {
        expect(
          renderer.root.findAllByProps({
            testID: `sensor-trace-${axis}-${ref}`,
          }).length,
        ).toBeGreaterThan(0);
      }
    }
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
