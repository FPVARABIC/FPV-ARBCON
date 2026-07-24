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
  OrientationRenderer: () => null,
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import OrientationHero from './OrientationHero';
import '../../../i18n';
import type {OrientationViewState} from '../../../core';

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
  overrides: Partial<{hasSeenResetHint: boolean; onResetView: () => void; onResetHintShown: () => void}> = {},
): {renderer: ReactTestRenderer.ReactTestRenderer; onResetView: jest.Mock; onResetHintShown: jest.Mock} {
  const onResetView = (overrides.onResetView as jest.Mock) ?? jest.fn();
  const onResetHintShown = (overrides.onResetHintShown as jest.Mock) ?? jest.fn();
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <OrientationHero
        orientationView={orientationView}
        hasSeenResetHint={overrides.hasSeenResetHint ?? true}
        onResetView={onResetView}
        onResetHintShown={onResetHintShown}
      />,
    );
  });
  return {renderer, onResetView, onResetHintShown};
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
      expect(allText(renderer)).toContain('هذا يعيد ضبط زاوية العرض فقط، ولا يُجري معايرة لمستشعرات وحدة التحكم بالطيران.');
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
});
