/**
 * THE MOTORS DOCK IS A SIBLING, NOT AN OVERLAY. PINNED.
 *
 * WHAT WAS ACTUALLY WRONG, and it is not what two rounds of notes said.
 * The stop bar was reported as "covering the motor list" and was treated
 * as a floating dock: one round added a bottom padding equal to the
 * dock's measured height so the list would "end above it". Chromium says
 * otherwise. The dock is `position: relative, flex: 0 0 auto` and the
 * scroll view beside it is `flex: 1`, so the column gives the dock its
 * height FIRST and the scroll viewport ENDS where the dock begins. It
 * could not have covered anything, and the reserved padding covered
 * nothing - it cost 88px of dead scroll on every phone width instead.
 *
 * WHAT THE OPERATOR SAW, then, was the list's clipped edge running
 * straight into a red button with no rule between them: a row merely
 * SCROLLED OFF reading as a row COVERED. The fix is a hairline, not a
 * layout change.
 *
 * WHY THIS FILE PINS STRUCTURE RATHER THAN PIXELS. Jest has no layout
 * engine. The real measurement runs in Chromium against the local
 * `.dev-preview` QA build (gitignored, like the rest of that harness):
 * clipped rectangles plus `elementFromPoint` hit tests, 9 motor states
 * across 7 widths, which is the only place a collision claim can
 * honestly be made. What jest CAN hold is the invariant that makes the
 * collision impossible in the first place: the dock must never become
 * absolutely positioned, and the scroll body must never go back to
 * reserving space for it. Break either and the browser check is the
 * thing that would have to catch it.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {ScrollView, StyleSheet} from 'react-native';

import '../../i18n';
import {MotorsScreenView} from './MotorsScreen';

function render() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    // No operator: the inert state still renders the dock, which is the
    // point - the stop control is reachable even with no session.
    renderer = ReactTestRenderer.create(<MotorsScreenView operator={undefined} />);
  });
  return renderer;
}

function flattenedStyle(testID: string): Record<string, unknown> {
  const renderer = render();
  const node = renderer.root.findAll(
    candidate => candidate.props?.testID === testID,
  )[0];
  expect(node).toBeDefined();
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

describe('the stop dock cannot become an overlay', () => {
  it('is not absolutely positioned', () => {
    // An absolute dock is the ONE change that would re-create a genuine
    // overlap, because it would leave the scroll view sized as if the
    // dock were not there.
    const style = flattenedStyle('motors-session-dock');
    expect(style.position).toBeUndefined();
  });

  it('draws a rule where the scrolling surface ends', () => {
    // The whole visible fix. Without it the clipped list edge and the red
    // button share a boundary with nothing between them.
    const style = flattenedStyle('motors-session-dock');
    expect(style.borderTopWidth).toBe(1);
    expect(style.borderTopColor).toBeDefined();
  });

  it('keeps the sticky stop in flow too', () => {
    const renderer = render();
    for (const node of renderer.root.findAll(
      candidate => candidate.props?.testID === 'motors-sticky-stop',
    )) {
      const style = (StyleSheet.flatten(node.props.style) ?? {}) as Record<
        string,
        unknown
      >;
      expect(style.position).toBeUndefined();
    }
  });
});

describe('the scroll body reserves no space for it', () => {
  it('pads its bottom no more than its sides', () => {
    // The dead-space regression, stated as a rule. `paddingBottom` used to
    // be `spacing.xxl * 4`, and then a measured dock height; both reserved
    // room for an overlay that does not exist. Even padding is correct
    // because the viewport already ends above the dock.
    const renderer = render();
    const scroll = renderer.root.findAllByType(ScrollView)[0];
    expect(scroll).toBeDefined();
    const content = (StyleSheet.flatten(scroll.props.contentContainerStyle) ??
      {}) as Record<string, number | undefined>;
    const padding = content.padding ?? 0;
    const bottom = content.paddingBottom ?? padding;
    expect(bottom).toBeLessThanOrEqual(padding);
  });

  it('renders the dock AFTER the scroll view, so the column orders them', () => {
    // Sibling order is what makes `flex: 1` on the scroll view mean
    // "whatever the dock did not take". Reversed, the dock would be
    // pushed off the bottom of the screen instead.
    const renderer = render();
    const ids: string[] = [];
    const walk = (node: ReactTestRenderer.ReactTestInstance): void => {
      const testID = node.props?.testID;
      if (typeof testID === 'string') ids.push(testID);
      node.children.forEach(child => {
        if (typeof child !== 'string') walk(child);
      });
    };
    walk(renderer.root);
    const dock = ids.indexOf('motors-session-dock');
    const title = ids.indexOf('motors-title');
    expect(dock).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(-1);
    expect(dock).toBeGreaterThan(title);
  });
});
