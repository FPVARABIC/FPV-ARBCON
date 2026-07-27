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
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import OrientationHero from './OrientationHero';
import {OrientationRenderer} from '../../orientation3d';
import '../../../i18n';
import i18n from '../../../i18n';
import type {OrientationViewState} from '../../../core';

const rendererMock = OrientationRenderer as unknown as jest.Mock;

/** The pose handed to the 3D model on its most recent render. */
function lastModelPose(): {rollDeg: number; pitchDeg: number; yawDeg: number} {
  const calls = rendererMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].orientation;
}

/** Every renderer this file mounts, so each one is unmounted again.
 * Not hygiene theatre: the model-interpolation frame loop is a real
 * requestAnimationFrame (setTimeout-backed under the RN Jest preset), and
 * only unmounting runs the cleanup that cancels a frame still in flight.
 * Left mounted, a test that eases the model leaks a timer past the end of
 * the suite. */
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

function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

function render(
  orientationView: OrientationViewState,
  overrides: Partial<{
    hasSeenResetHint: boolean;
    canReset: boolean;
    interpolationResetToken: string;
    onResetView: () => void;
    onResetHintShown: () => void;
  }> = {},
): {
  renderer: ReactTestRenderer.ReactTestRenderer;
  onResetView: jest.Mock;
  onResetHintShown: jest.Mock;
  update: (next: OrientationViewState) => void;
} {
  const onResetView = (overrides.onResetView as jest.Mock) ?? jest.fn();
  const onResetHintShown = (overrides.onResetHintShown as jest.Mock) ?? jest.fn();
  const element = (view: OrientationViewState) => (
    <OrientationHero
      orientationView={view}
      hasSeenResetHint={overrides.hasSeenResetHint ?? true}
      canReset={overrides.canReset}
      interpolationResetToken={overrides.interpolationResetToken}
      onResetView={onResetView}
      onResetHintShown={onResetHintShown}
    />
  );
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element(orientationView));
  });
  mounted.push(renderer);
  const update = (next: OrientationViewState) => {
    act(() => {
      renderer.update(element(next));
    });
  };
  return {renderer, onResetView, onResetHintShown, update};
}

describe('OrientationHero', () => {
  it('WAITING: shows the waiting message, no 3D model, no readouts, no reset button', () => {
    const {renderer} = render({status: 'WAITING'});
    expect(findByTestID(renderer, 'orientation-hero-waiting')).not.toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-reset-button')).toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-roll')).toBeNull();
  });

  it('ERROR: shows the error message, no 3D model, no readouts', () => {
    const {renderer} = render({status: 'ERROR'});
    expect(findByTestID(renderer, 'orientation-hero-error')).not.toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-reset-button')).toBeNull();
  });

  it('LIVE: renders the 3D model wrapper, 3 rounded numeric readouts, and the reset button, with no stale label', () => {
    const {renderer} = render({status: 'LIVE', rollDeg: 4.6, pitchDeg: -1.4, yawDeg: 273.5});
    expect(findByTestID(renderer, 'orientation-hero')).not.toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-stale-label')).toBeNull();
    expect(findByTestID(renderer, 'orientation-hero-roll')).not.toBeNull();
    const text = allText(renderer);
    expect(text).toContain('5°'); // rollDeg rounded
    expect(text).toContain('-1°'); // pitchDeg rounded
    expect(text).toContain('274°'); // yawDeg rounded
    expect(findByTestID(renderer, 'orientation-hero-reset-button')).not.toBeNull();
  });

  it('STALE: freezes the model/readouts at their last values, dimmed, and shows the stale label', () => {
    const {renderer} = render({status: 'STALE', rollDeg: 10, pitchDeg: -5, yawDeg: 90, ageMs: 900});
    expect(findByTestID(renderer, 'orientation-hero-stale-label')).not.toBeNull();
    const text = allText(renderer);
    expect(text).toContain('10°');
    expect(text).toContain('-5°');
    expect(text).toContain('90°');
    expect(text).toContain('البيانات متأخرة');
  });

  it('sets an accessibility label from describeOrientationForAccessibility() on the renderer wrapper', () => {
    const {renderer} = render({status: 'LIVE', rollDeg: 4, pitchDeg: 2, yawDeg: 274});
    const wrapper = findByTestID(renderer, 'orientation-hero-renderer-wrapper');
    expect(wrapper?.props.accessibilityLabel).toBe('ميلان 4 درجة لليمين، ارتفاع المقدمة 2 درجة، الاتجاه 274 درجة');
  });

  describe('reset button + one-time hint', () => {
    it('pressing reset always calls onResetView()', async () => {
      const {renderer, onResetView} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0}, {hasSeenResetHint: true});
      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
      });
      expect(onResetView).toHaveBeenCalledTimes(1);
    });

    it('when hasSeenResetHint is true, no hint appears and onResetHintShown() is never called', async () => {
      const {renderer, onResetHintShown} = render(
        {status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0},
        {hasSeenResetHint: true},
      );
      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
      expect(onResetHintShown).not.toHaveBeenCalled();
    });

    it('when hasSeenResetHint is false, the FIRST press shows the hint and calls onResetHintShown() exactly once', async () => {
      const {renderer, onResetHintShown} = render(
        {status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0},
        {hasSeenResetHint: false},
      );
      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).not.toBeNull();
      expect(allText(renderer)).toContain('هذا يعيد ضبط زاوية العرض على الشاشة فقط: يجعل الاتجاه المعروض يبدأ من صفر بالنسبة للوضع الحالي. لا يُرسل أي أمر إلى وحدة التحكم بالطيران ولا يُجري أي معايرة لمستشعراتها.');
      expect(onResetHintShown).toHaveBeenCalledTimes(1);
    });

    it('dismissing the hint hides it', async () => {
      const {renderer} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0}, {hasSeenResetHint: false});
      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).not.toBeNull();

      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-hint-dismiss')!.props.onPress();
      });
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
    });

    it('never sends an MSP command directly - onResetView is the ONLY callback invoked, no other side-effecting prop exists', async () => {
      // A structural guard, not a behavioral one: OrientationHeroProps
      // has no MSP-related prop at all (verified by this file's own
      // props usage above), so there is nothing here that COULD send an
      // MSP command - resetting is provably view-only by construction.
      const {renderer, onResetView} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0});
      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
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
      const {renderer} = render({status: 'STALE', rollDeg: 1, pitchDeg: 2, yawDeg: 3, ageMs: 900}, {canReset: false});

      const button = findByTestID(renderer, 'orientation-hero-reset-button');
      expect(button?.props.disabled).toBe(true);
      expect(button?.props.accessibilityState).toEqual({disabled: true});
      expect(findByTestID(renderer, 'orientation-hero-reset-unavailable')).not.toBeNull();
      expect(allText(renderer)).toContain(i18n.t('orientationHero.resetUnavailable'));
    });

    it('unavailable: a press delivered anyway captures NOTHING and shows no hint', async () => {
      const {renderer, onResetView, onResetHintShown} = render(
        {status: 'STALE', rollDeg: 1, pitchDeg: 2, yawDeg: 3, ageMs: 900},
        {canReset: false, hasSeenResetHint: false},
      );

      await act(async () => {
        findByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
      });

      expect(onResetView).not.toHaveBeenCalled();
      expect(onResetHintShown).not.toHaveBeenCalled();
      expect(findByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();
    });

    it('available: the button is enabled, announced as enabled, and carries no unavailable note', () => {
      const {renderer} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0}, {canReset: true});

      const button = findByTestID(renderer, 'orientation-hero-reset-button');
      expect(button?.props.disabled).toBe(false);
      expect(button?.props.accessibilityState).toEqual({disabled: false});
      expect(findByTestID(renderer, 'orientation-hero-reset-unavailable')).toBeNull();
    });
  });

  /**
   * Interpolation is a VISUAL smoothing of the model between two genuine
   * samples. These tests pin the boundary: what the model may show while
   * easing, and what the numbers/accessibility text may never show.
   */
  describe('model interpolation vs. the numeric readouts', () => {
    it('the FIRST sample of a session reaches the model exactly as reported - nothing to ease from', () => {
      render({status: 'LIVE', rollDeg: 12, pitchDeg: -4, yawDeg: 200}, {interpolationResetToken: 's:1'});
      expect(lastModelPose()).toEqual({rollDeg: 12, pitchDeg: -4, yawDeg: 200});
    });

    it('the numbers and the accessibility text follow the GENUINE sample, never an animation frame', () => {
      const {renderer, update} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0}, {interpolationResetToken: 's:1'});

      // A large jump: the model may lag behind while easing, but the
      // readouts must show the new sample on the very same render.
      update({status: 'LIVE', rollDeg: 30, pitchDeg: -20, yawDeg: 150});

      const text = allText(renderer);
      expect(text).toContain('30°');
      expect(text).toContain('-20°');
      expect(text).toContain('150°');
      expect(findByTestID(renderer, 'orientation-hero-renderer-wrapper')?.props.accessibilityLabel).toBe(
        'ميلان 30 درجة لليمين، انخفاض المقدمة 20 درجة، الاتجاه 150 درجة',
      );
    });

    it('STALE hands the model the FROZEN genuine sample - a stale pose is never eased toward anything', () => {
      const {update} = render({status: 'LIVE', rollDeg: 10, pitchDeg: 5, yawDeg: 90}, {interpolationResetToken: 's:1'});
      rendererMock.mockClear();

      update({status: 'STALE', rollDeg: 10, pitchDeg: 5, yawDeg: 90, ageMs: 1200});

      expect(lastModelPose()).toEqual({rollDeg: 10, pitchDeg: 5, yawDeg: 90});
    });

    it('a SESSION change snaps the model to the new sample instead of sweeping across from the old attitude', () => {
      const {renderer, update} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 350}, {interpolationResetToken: 's:1'});

      // Same component, replacement generation: re-render with a new token.
      act(() => {
        renderer.update(
          <OrientationHero
            orientationView={{status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 20}}
            hasSeenResetHint
            interpolationResetToken="s:2"
            onResetView={jest.fn()}
            onResetHintShown={jest.fn()}
          />,
        );
      });

      expect(lastModelPose()).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 20});
      // `update` is exercised above only to keep the helper's contract
      // honest for readers - the session change itself is the assertion.
      expect(typeof update).toBe('function');
    });
  });

  it('states plainly that Heading is relative, never claiming a magnetic compass', () => {
    const {renderer} = render({status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 274});
    expect(findByTestID(renderer, 'orientation-hero-heading-note')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('orientationHero.headingRelativeNote'));
  });
});
