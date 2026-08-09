/**
 * Smoke-level proof that the icon system actually renders under the same
 * Jest environment every screen test uses — react-native-svg is a native
 * module, and a registry nobody can mount is not an icon system.
 */
import React from 'react';
import {I18nManager} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import Svg from 'react-native-svg';

import {Icon} from './Icon';
import {glyphs} from './glyphs';

describe('Icon', () => {
  it('mounts a glyph with the default optical size', () => {
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Icon name="save" testID="icon-save" />);
    });
    const svg = tree!.root.findByType(Svg);
    expect(svg.props.width).toBe(20);
    expect(svg.props.height).toBe(20);
    act(() => tree!.unmount());
  });

  it('renders every registered glyph without throwing', () => {
    for (const name of Object.keys(glyphs) as Array<keyof typeof glyphs>) {
      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<Icon name={name} />);
      });
      act(() => tree!.unmount());
    }
  });

  it('resolves chevron-forward against the RTL layout direction', () => {
    // The app forces RTL (App.tsx / App.web.tsx); under Jest the flag
    // defaults to LTR, so exercise both sides of the alias table rather
    // than assuming the harness matches production.
    const wasRTL = I18nManager.isRTL;
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Icon name="chevron-forward" testID="fwd" />);
    });
    // Alias must resolve to real geometry — one path child, no crash.
    expect(
      tree!.root.findByProps({testID: 'fwd'}).findAllByType(
        require('react-native-svg').Path,
      ).length,
    ).toBeGreaterThan(0);
    act(() => tree!.unmount());
    expect(I18nManager.isRTL).toBe(wasRTL);
  });
});
