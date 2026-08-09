/**
 * @jest-environment jsdom
 *
 * THE PREVIEW BANNER.
 *
 * Two things are worth holding in place, and only two.
 *
 * First, the exact wording. The banner exists so nobody mistakes an
 * unverified preview for an approved release, and "REQUIRES HARDWARE
 * TEST" is the phrase the rest of this branch's documentation and commit
 * history uses for precisely that state. A softened or paraphrased
 * version would break that link.
 *
 * Second - and this is the one that actually matters - the banner must
 * remain a LABEL. It renders text and nothing else: no capability probe,
 * no transport, no device list, no timer. A preview that quietly degraded
 * the real connection path would be worse than no preview at all, because
 * it would suggest the hardware paths are broken when they are merely
 * untested.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {PreviewNotice} from './PreviewNotice';
import '../../i18n';

function render(): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<PreviewNotice />);
  });
  return tree;
}

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('PreviewNotice', () => {
  it('states the REQUIRES HARDWARE TEST status verbatim', () => {
    const tree = render();

    expect(textOf(tree)).toContain(
      'نسخة معاينة — مسارات العتاد ما زالت REQUIRES HARDWARE TEST',
    );
    act(() => tree.unmount());
  });

  it('says plainly that the real connection is NOT disabled', () => {
    // Without this line the banner reads as "this build does not work",
    // which is the opposite of the truth: the transport is real and a
    // board can genuinely be connected.
    const tree = render();

    expect(textOf(tree)).toContain('لم يُعطَّل');
    act(() => tree.unmount());
  });

  it('promises no demo devices and no synthetic telemetry', () => {
    const tree = render();

    expect(textOf(tree)).toContain('لا توجد أجهزة تجريبية ولا telemetry مصطنعة');
    act(() => tree.unmount());
  });

  it('renders text only - it cannot touch any transport', () => {
    // A structural guard, not a stylistic one. The rendered tree must
    // contain no pressable, no input and no switch: a banner with an
    // action is a banner that could disable something.
    const tree = render();
    const rendered = tree.root;

    expect(rendered.findAll(node => typeof node.props?.onPress === 'function')).toHaveLength(0);
    expect(rendered.findAll(node => typeof node.props?.onValueChange === 'function')).toHaveLength(0);
    expect(rendered.findAll(node => typeof node.props?.onChangeText === 'function')).toHaveLength(0);
    act(() => tree.unmount());
  });
});
