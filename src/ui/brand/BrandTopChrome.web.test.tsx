/**
 * @jest-environment jsdom
 *
 * THE WEB BRAND POLICY, rendered through react-native-web the way the
 * browser build actually resolves it:
 *   - the persistent top chrome carries the real logo, exactly once;
 *   - the Start screen does NOT repeat it on web (SHOW_START_LOGO is a
 *     Platform seam - the chrome above already shows the mark, and two
 *     identical logos stacked within a hundred pixels is the duplicate
 *     the brief forbids);
 *   - the chrome logo announces the brand name for assistive tech.
 */

jest.mock('react-native', () => jest.requireActual('react-native-web'));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import BrandTopChrome from './BrandTopChrome';
import {BRAND_LOGO_LABEL} from './BrandLogo';
import StartScreen from '../screens/StartScreen';

function render(element: React.JSX.Element) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer;
}

describe('BrandTopChrome on web', () => {
  it('renders the persistent strip with exactly one labeled brand logo', () => {
    const renderer = render(<BrandTopChrome />);
    expect(
      renderer.root.findAllByProps({testID: 'brand-top-chrome'}).length,
    ).toBeGreaterThan(0);
    const labeled = renderer.root
      .findAllByProps({testID: 'brand-logo'})
      .filter(node => node.props.accessibilityLabel === BRAND_LOGO_LABEL);
    expect(labeled).toHaveLength(1);
    act(() => renderer.unmount());
  });
});

describe('StartScreen on web', () => {
  it('does not repeat the logo in its own content - the persistent chrome owns the brand mark here', () => {
    const navigation = {navigate: jest.fn()};
    const renderer = render(
      <StartScreen navigation={navigation as never} route={{} as never} />,
    );
    expect(
      renderer.root.findAllByProps({testID: 'start-brand-logo'}),
    ).toHaveLength(0);
    // The two direct actions are still the whole point of the screen.
    expect(
      renderer.root
        .findAllByProps({testID: 'start-configure'})
        .some(node => typeof node.props.onPress === 'function'),
    ).toBe(true);
    expect(
      renderer.root
        .findAllByProps({testID: 'start-firmware'})
        .some(node => typeof node.props.onPress === 'function'),
    ).toBe(true);
    act(() => renderer.unmount());
  });
});
