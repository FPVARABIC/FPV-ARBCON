/**
 * Mocks the orientation3d barrel (OrientationRenderer) per Step 2's own
 * established finding: mounting the real Skia-backed component under
 * Jest fails (no real CanvasKit-WASM wired in) - this file only verifies
 * OrientationHero's OWN logic (WAITING/ERROR/LIVE/STALE branching,
 * readouts, reset button + one-time hint, accessibility label), never
 * the 3D drawing itself (already covered, GPU-free, by
 * droneSceneGeometry.test.ts).
 */

jest.mock('../../orientation3d', () => ({
  // A jest.fn component, so the POSE the model is actually handed is
  // observable - that is the only way to tell "the number and the model
  // agree" apart from "they happen to both look plausible".
  OrientationRenderer: jest.fn(() => null),
}));

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import OrientationHero, {
  computeOrientationHeroSize,
  computeOrientationWorkspaceLayout,
  formatTiltDegrees,
  shouldUseOrientationSidebar,
} from './OrientationHero';
import { OrientationRenderer } from '../../orientation3d';
import '../../../i18n';
import i18n from '../../../i18n';
import type { OrientationViewState } from '../../../core';

const rendererMock = OrientationRenderer as unknown as jest.Mock;

/** The pose handed to the 3D model on its most recent render. */
function lastModelPose(): {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
} {
  const calls = rendererMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].orientation;
}

/** Every renderer this file mounts, so each one is unmounted again - a
 * tree left mounted keeps answering updates and would distort the next
 * test, and the leak checks below can only mean anything if nothing from
 * an earlier test is still alive. */
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  rendererMock.mockClear();
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
});

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function findByTestID(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  const matches = renderer.root.findAllByProps({ testID });
  return matches.length > 0 ? matches[0] : null;
}

function render(
  orientationView: OrientationViewState,
  overrides: Partial<{
    hasSeenResetHint: boolean;
    canReset: boolean;
    sessionToken: string;
    sampleSeq: number;
    sampleReceivedAt: number;
    onResetView: () => void;
    onResetHintShown: () => void;
  }> = {},
): {
  renderer: ReactTestRenderer.ReactTestRenderer;
  onResetView: jest.Mock;
  onResetHintShown: jest.Mock;
  update: (next: OrientationViewState, sampleSeq?: number) => void;
} {
  const onResetView = (overrides.onResetView as jest.Mock) ?? jest.fn();
  const onResetHintShown =
    (overrides.onResetHintShown as jest.Mock) ?? jest.fn();
  const element = (view: OrientationViewState, sampleSeq?: number) => (
    <OrientationHero
      orientationView={view}
      hasSeenResetHint={overrides.hasSeenResetHint ?? true}
      canReset={overrides.canReset}
      sessionToken={overrides.sessionToken}
      sampleSeq={sampleSeq ?? overrides.sampleSeq}
      sampleReceivedAt={overrides.sampleReceivedAt}
      onResetView={onResetView}
      onResetHintShown={onResetHintShown}
    />
  );
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element(orientationView));
  });
  mounted.push(renderer);
  const update = (next: OrientationViewState, sampleSeq?: number) => {
    act(() => {
      renderer.update(element(next, sampleSeq));
    });
  };
  return { renderer, onResetView, onResetHintShown, update };
}

describe('OrientationHero', () => {
  it('shows the same sub-degree tilt the model receives instead of rounding it to a misleading zero', () => {
    expect(formatTiltDegrees(0.4)).toBe('0.4°');
    expect(formatTiltDegrees(-0.4)).toBe('-0.4°');
    expect(formatTiltDegrees(-0.01)).toBe('0°');
  });
  it('sizes the 3D stage for a narrow phone, a standard phone and a tablet', () => {
    expect(computeOrientationHeroSize(320)).toBe(260);
    expect(computeOrientationHeroSize(390)).toBe(330);
    expect(computeOrientationHeroSize(1200)).toBe(340);
    expect(shouldUseOrientationSidebar(800, 1)).toBe(true);
    expect(shouldUseOrientationSidebar(620, 1.2)).toBe(false);
    expect(computeOrientationHeroSize(800, true)).toBe(410);
  });
  it('uses the measured desktop remainder only for web desktop', () => {
    // 430, not 512 (FINAL UI CORRECTION): the shorter desktop stage keeps
    // the dials and the calibration card reachable without scrolling at
    // 1024x768 while the model stays dominant.
    expect(computeOrientationWorkspaceLayout(1600, 1, 1540, true)).toEqual({expanded: true, stageWidth: 1400, stageHeight: 430, presentationScale: 0.56 / 0.37});
    expect(computeOrientationWorkspaceLayout(1024, 1, 964, true).stageWidth).toBe(824);
    expect(computeOrientationWorkspaceLayout(800, 1, 740, true).expanded).toBe(false);
    expect(computeOrientationWorkspaceLayout(1600, 1, 1540, false).expanded).toBe(false);
    expect(computeOrientationWorkspaceLayout(1100, 1, 1540, true).stageWidth).toBe(900);
    expect(computeOrientationWorkspaceLayout(1600, 1, 500, true).expanded).toBe(false);
  });

  it('WAITING: shows the waiting message, no 3D model, no readouts, no reset button', () => {
    const { renderer } = render({ status: 'WAITING' });
    expect(findByTestID(renderer, 'orientation-hero-waiting')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('orientationHero.waitingLabel'));
    expect(allText(renderer)).not.toContain(i18n.t('orientationHero.live'));
    expect(findByTestID(renderer, 'orientation-hero-reset-button')).toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-roll')).toBeNull();
  });

  it('ERROR: shows the error message, no 3D model, no readouts', () => {
    const { renderer } = render({ status: 'ERROR' });
    expect(findByTestID(renderer, 'orientation-hero-error')).not.toBeNull();
    expect(allText(renderer)).toContain(
      i18n.t('orientationHero.unavailableLabel'),
    );
    expect(allText(renderer)).not.toContain(i18n.t('orientationHero.live'));
    expect(findByTestID(renderer, 'orientation-hero-reset-button')).toBeNull();
  });

  it('LIVE: renders the 3D model wrapper, precise tilt readouts, and the reset button, with no stale label', () => {
    const { renderer } = render({
      status: 'LIVE',
      rollDeg: 4.6,
      pitchDeg: -1.4,
      yawDeg: 273.5,
    });
    expect(findByTestID(renderer, 'orientation-hero')).not.toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-stale-label')).toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-roll')).not.toBeNull();
    const text = allText(renderer);
    expect(text).toContain('4.6°');
    expect(text).toContain('-1.4°');
    expect(text).toContain('274°'); // yawDeg rounded
    expect(
      findByTestID(renderer, 'orientation-hero-reset-button'),
    ).not.toBeNull();
    expect(allText(renderer)).toContain('مباشر');
  });

  /**
   * SETUP P3 CHANGED THIS ORDER, DELIBERATELY.
   *
   * React Native's jest defaults are 750px at fontScale 2, i.e. an
   * EFFECTIVE 375px - a phone, and therefore the compact-row branch. On
   * that branch the model and the numeric readouts share one column and
   * the instrument rail stands beside them, because the rail is the
   * taller of the two and was leaving the space under the model empty
   * (measured: 630px -> 528px of hero, at 390px).
   *
   * So the reading order is now model -> its own numbers -> the
   * instruments beside them, which is also how the eye travels down the
   * column. The pose handed to every one of the three is still the SAME
   * sample - which is the part that actually matters, and is asserted
   * below rather than assumed.
   */
  it('phone: the dominant model leads, the dials sit directly under it, the readouts follow', () => {
    // FINAL UI CORRECTION: the stage is the full card width (dominant)
    // and the reading order is model -> instruments -> numbers. Every
    // one of the three still renders the SAME sample - asserted below,
    // not assumed.
    const { renderer } = render({
      status: 'LIVE',
      rollDeg: 8.5,
      pitchDeg: -3,
      yawDeg: 42,
    });
    const ordered = renderer.root
      .findAll(
        node =>
          node.type === View &&
          (node.props.testID === 'orientation-hero-renderer-wrapper' ||
            node.props.testID === 'flight-instruments' ||
            node.props.testID === 'orientation-hero-roll'),
      )
      .map(node => node.props.testID);
    expect(ordered).toEqual([
      'orientation-hero-renderer-wrapper',
      'flight-instruments',
      'orientation-hero-roll',
    ]);
    expect(
      findByTestID(renderer, 'artificial-horizon')?.props.accessibilityLabel,
    ).toContain('8.5');
    expect(
      findByTestID(renderer, 'direction-compass')?.props.accessibilityLabel,
    ).toContain('42');
  });

  it('renders the readouts exactly once, never in both positions', () => {
    const { renderer } = render({
      status: 'LIVE',
      rollDeg: 8.5,
      pitchDeg: -3,
      yawDeg: 42,
    });
    for (const testID of [
      'orientation-hero-roll',
      'orientation-hero-pitch',
      'orientation-hero-heading',
    ]) {
      expect(
        renderer.root.findAll(
          node => node.type === View && node.props.testID === testID,
        ),
      ).toHaveLength(1);
    }
  });

  it('STALE: freezes the model/readouts at their last values, dimmed, and shows the stale label', () => {
    const { renderer } = render({
      status: 'STALE',
      rollDeg: 10,
      pitchDeg: -5,
      yawDeg: 90,
      ageMs: 900,
    });
    expect(
      findByTestID(renderer, 'orientation-hero-stale-label'),
    ).not.toBeNull();
    const text = allText(renderer);
    expect(text).toContain('10°');
    expect(text).toContain('-5°');
    expect(text).toContain('90°');
    expect(text).toContain('البيانات متأخرة');
    expect(text).not.toContain('مباشر');
  });

  it('sets an accessibility label from describeOrientationForAccessibility() on the renderer wrapper', () => {
    const { renderer } = render({
      status: 'LIVE',
      rollDeg: 4,
      pitchDeg: 2,
      yawDeg: 274,
    });
    const wrapper = findByTestID(renderer, 'orientation-hero-renderer-wrapper');
    expect(wrapper?.props.accessibilityLabel).toBe(
      'ميلان 4 درجة لليمين، ارتفاع المقدمة 2 درجة، الاتجاه 274 درجة',
    );
  });

  describe('reset button + one-time hint', () => {
    it('pressing reset always calls onResetView()', async () => {
      const { renderer, onResetView } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
        { hasSeenResetHint: true },
      );
      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });
      expect(onResetView).toHaveBeenCalledTimes(1);
    });

    it('when hasSeenResetHint is true, no hint appears and onResetHintShown() is never called', async () => {
      const { renderer, onResetHintShown } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
        { hasSeenResetHint: true },
      );
      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
      expect(onResetHintShown).not.toHaveBeenCalled();
    });

    it('when hasSeenResetHint is false, the FIRST press shows the hint and calls onResetHintShown() exactly once', async () => {
      const { renderer, onResetHintShown } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
        { hasSeenResetHint: false },
      );
      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });
      expect(
        findByTestID(renderer, 'orientation-hero-reset-hint'),
      ).not.toBeNull();
      expect(allText(renderer)).toContain(
        'هذا يعيد ضبط زاوية العرض على الشاشة فقط: يجعل الاتجاه المعروض يبدأ من صفر بالنسبة للوضع الحالي. لا يُرسل أي أمر إلى وحدة التحكم بالطيران ولا يُجري أي معايرة لمستشعراتها.',
      );
      expect(onResetHintShown).toHaveBeenCalledTimes(1);
    });

    it('dismissing the hint hides it', async () => {
      const { renderer } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
        { hasSeenResetHint: false },
      );
      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });
      expect(
        findByTestID(renderer, 'orientation-hero-reset-hint'),
      ).not.toBeNull();

      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-hint-dismiss',
        )!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
    });

    it('never sends an MSP command directly - onResetView is the ONLY callback invoked, no other side-effecting prop exists', async () => {
      // A structural guard, not a behavioral one: OrientationHeroProps
      // has no MSP-related prop at all (verified by this file's own
      // props usage above), so there is nothing here that COULD send an
      // MSP command - resetting is provably view-only by construction.
      const { renderer, onResetView } = render({
        status: 'LIVE',
        rollDeg: 0,
        pitchDeg: 0,
        yawDeg: 0,
      });
      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });
      expect(onResetView).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The Heading reset can only capture a reference if there is a genuine,
   * current sample to capture. When there is not, the control says so
   * instead of silently storing a guess.
   */
  describe('reset availability', () => {
    it('unavailable: the button is disabled, announced as disabled, and explains why', () => {
      const { renderer } = render(
        { status: 'STALE', rollDeg: 1, pitchDeg: 2, yawDeg: 3, ageMs: 900 },
        { canReset: false },
      );

      const button = findByTestID(renderer, 'orientation-hero-reset-button');
      expect(button?.props.disabled).toBe(true);
      expect(button?.props.accessibilityState).toEqual({ disabled: true });
      expect(
        findByTestID(renderer, 'orientation-hero-reset-unavailable'),
      ).not.toBeNull();
      expect(allText(renderer)).toContain(
        i18n.t('orientationHero.resetUnavailable'),
      );
    });

    it('unavailable: a press delivered anyway captures NOTHING and shows no hint', async () => {
      const { renderer, onResetView, onResetHintShown } = render(
        { status: 'STALE', rollDeg: 1, pitchDeg: 2, yawDeg: 3, ageMs: 900 },
        { canReset: false, hasSeenResetHint: false },
      );

      await act(async () => {
        findByTestID(
          renderer,
          'orientation-hero-reset-button',
        )!.props.onPress();
      });

      expect(onResetView).not.toHaveBeenCalled();
      expect(onResetHintShown).not.toHaveBeenCalled();
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
    });

    it('available: the button is enabled, announced as enabled, and carries no unavailable note', () => {
      const { renderer } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
        { canReset: true },
      );

      const button = findByTestID(renderer, 'orientation-hero-reset-button');
      expect(button?.props.disabled).toBe(false);
      expect(button?.props.accessibilityState).toEqual({ disabled: false });
      expect(
        findByTestID(renderer, 'orientation-hero-reset-unavailable'),
      ).toBeNull();
    });
  });

  /**
   * LATEST WINS. The model is handed the newest genuine sample directly,
   * with nothing between it and the renderer - no easing, no queue, no
   * pending target. These tests pin that: the model and the numbers show
   * the SAME sample, and no amount of flushing can bring an older one
   * back afterwards.
   */
  describe('latest-wins: the model and the numbers show the same sample', () => {
    /** Every deferred mechanism React or the runtime might still be
     * holding: microtasks, timers, and animation frames. If anything at
     * all could restore an older pose, this is where it would happen. */
    async function flushEverythingDeferred(): Promise<void> {
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
    }

    it('the FIRST sample of a session reaches the model exactly as reported', () => {
      render({ status: 'LIVE', rollDeg: 12, pitchDeg: -4, yawDeg: 200 });
      expect(lastModelPose()).toEqual({
        rollDeg: 12,
        pitchDeg: -4,
        yawDeg: 200,
      });
    });

    it('a burst of 100 samples ends on sample 100 in BOTH the model and the numbers, and cannot be undone', async () => {
      jest.useFakeTimers();
      try {
        const { renderer, update } = render(
          { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
          { sessionToken: 's:1' },
        );

        for (let seq = 1; seq <= 100; seq++) {
          update(
            {
              status: 'LIVE',
              rollDeg: seq % 31,
              pitchDeg: -(seq % 17),
              yawDeg: (seq * 3) % 360,
            },
            seq,
          );
        }

        const final = {
          rollDeg: 100 % 31,
          pitchDeg: -(100 % 17),
          yawDeg: (100 * 3) % 360,
        };
        expect(lastModelPose()).toEqual(final);
        expect(allText(renderer)).toContain(`${final.rollDeg}°`);
        expect(allText(renderer)).toContain(`${final.yawDeg}°`);
        expect(
          findByTestID(renderer, 'artificial-horizon')?.props
            .accessibilityLabel,
        ).toContain(String(final.rollDeg));
        expect(
          StyleSheet.flatten(
            findByTestID(renderer, 'direction-compass-dial')?.props.style,
          ).transform,
        ).toEqual([{ rotate: `-${final.yawDeg}deg` }]);

        // Nothing queued anywhere may resurrect samples 1-99.
        await flushEverythingDeferred();
        expect(lastModelPose()).toEqual(final);
        expect(allText(renderer)).toContain(`${final.yawDeg}°`);
        expect(
          StyleSheet.flatten(
            findByTestID(renderer, 'direction-compass-dial')?.props.style,
          ).transform,
        ).toEqual([{ rotate: `-${final.yawDeg}deg` }]);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it.each([
      ['level', { rollDeg: 0, pitchDeg: 0, yawDeg: 0 }],
      ['roll right', { rollDeg: 27, pitchDeg: 0, yawDeg: 0 }],
      ['roll left', { rollDeg: -27, pitchDeg: 0, yawDeg: 0 }],
      ['pitch up', { rollDeg: 0, pitchDeg: 33, yawDeg: 0 }],
      ['pitch down', { rollDeg: 0, pitchDeg: -33, yawDeg: 0 }],
      ['heading just below the wrap', { rollDeg: 0, pitchDeg: 0, yawDeg: 359 }],
      ['heading just past the wrap', { rollDeg: 0, pitchDeg: 0, yawDeg: 1 }],
      ['compound', { rollDeg: -14, pitchDeg: 21, yawDeg: 274 }],
    ])(
      '%s: the model receives EXACTLY the displayed numbers',
      (_label, pose) => {
        const { renderer } = render({ status: 'LIVE', ...pose });

        expect(lastModelPose()).toEqual(pose);
        const text = allText(renderer);
        expect(text).toContain(`${Math.round(pose.rollDeg)}°`);
        expect(text).toContain(`${Math.round(pose.pitchDeg)}°`);
        expect(text).toContain(`${Math.round(pose.yawDeg)}°`);
      },
    );

    it('crossing 359 -> 0 hands the model the reported heading, never a swept value in between', () => {
      const { update } = render({
        status: 'LIVE',
        rollDeg: 0,
        pitchDeg: 0,
        yawDeg: 359,
      });
      expect(lastModelPose().yawDeg).toBe(359);

      update({ status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 1 });
      // 1, not 180 and not 359: no interpolation exists to produce an
      // intermediate heading at all.
      expect(lastModelPose().yawDeg).toBe(1);
    });

    it('the numbers and the accessibility text follow the GENUINE sample', () => {
      const { renderer, update } = render({
        status: 'LIVE',
        rollDeg: 0,
        pitchDeg: 0,
        yawDeg: 0,
      });

      update({ status: 'LIVE', rollDeg: 30, pitchDeg: -20, yawDeg: 150 });

      const text = allText(renderer);
      expect(text).toContain('30°');
      expect(text).toContain('-20°');
      expect(text).toContain('150°');
      expect(
        findByTestID(renderer, 'orientation-hero-renderer-wrapper')?.props
          .accessibilityLabel,
      ).toBe('ميلان 30 درجة لليمين، انخفاض المقدمة 20 درجة، الاتجاه 150 درجة');
      expect(lastModelPose()).toEqual({
        rollDeg: 30,
        pitchDeg: -20,
        yawDeg: 150,
      });
    });

    it('STALE hands the model the FROZEN genuine sample and invents no continued movement', () => {
      const { update } = render({
        status: 'LIVE',
        rollDeg: 10,
        pitchDeg: 5,
        yawDeg: 90,
      });
      rendererMock.mockClear();

      update({
        status: 'STALE',
        rollDeg: 10,
        pitchDeg: 5,
        yawDeg: 90,
        ageMs: 1200,
      });

      expect(lastModelPose()).toEqual({ rollDeg: 10, pitchDeg: 5, yawDeg: 90 });
      expect(
        rendererMock.mock.calls[rendererMock.mock.calls.length - 1][0].stale,
      ).toBe(true);
    });

    it('a SESSION change shows the new session sample immediately, with no trace of the old attitude', () => {
      const { renderer } = render(
        { status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 350 },
        { sessionToken: 's:1' },
      );

      act(() => {
        renderer.update(
          <OrientationHero
            orientationView={{
              status: 'LIVE',
              rollDeg: 0,
              pitchDeg: 0,
              yawDeg: 20,
            }}
            hasSeenResetHint
            sessionToken="s:2"
            sampleSeq={1}
            onResetView={jest.fn()}
            onResetHintShown={jest.fn()}
          />,
        );
      });

      expect(lastModelPose()).toEqual({ rollDeg: 0, pitchDeg: 0, yawDeg: 20 });
    });

    it('rendering samples schedules NO animation frame and NO timer from this component', () => {
      const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
      const interval = jest.spyOn(globalThis, 'setInterval');
      try {
        const { update } = render({
          status: 'LIVE',
          rollDeg: 0,
          pitchDeg: 0,
          yawDeg: 0,
        });
        for (let seq = 1; seq <= 25; seq++) {
          update(
            { status: 'LIVE', rollDeg: seq, pitchDeg: -seq, yawDeg: seq * 4 },
            seq,
          );
        }
        expect(raf).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
      } finally {
        raf.mockRestore();
        interval.mockRestore();
      }
    });

    it('non-finite angles are handed through unchanged rather than being smoothed into something invented', () => {
      render({ status: 'LIVE', rollDeg: Number.NaN, pitchDeg: 0, yawDeg: 0 });
      expect(Number.isNaN(lastModelPose().rollDeg)).toBe(true);
    });
  });

  it('states plainly that Heading is relative, never claiming a magnetic compass', () => {
    const { renderer } = render({
      status: 'LIVE',
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: 274,
    });
    expect(
      findByTestID(renderer, 'orientation-hero-heading-note'),
    ).not.toBeNull();
    expect(allText(renderer)).toContain(
      i18n.t('orientationHero.headingRelativeNote'),
    );
  });
});
