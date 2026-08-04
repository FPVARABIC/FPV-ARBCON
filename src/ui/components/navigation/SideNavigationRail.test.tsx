/**
 * The desktop navigation rail. The operator reported the post-connection
 * screens as "a mobile phone interface inside a desktop monitor"; these
 * pin that the rail is the SAME navigation, not a second one with its own
 * rules.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import SideNavigationRail from './SideNavigationRail';
import BottomTabBar from './BottomTabBar';
import '../../../i18n';
import i18n from '../../../i18n';
import { MAIN_TABS, type MainTabKey } from '../../../navigation/tabs';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
});

function renderRail(
  onSelectTab: (tab: MainTabKey) => void = () => undefined,
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <SideNavigationRail activeTab="SETUP" onSelectTab={onSelectTab} />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

describe('SideNavigationRail', () => {
  it('offers exactly the implemented destinations, in the same product order as the bottom bar', () => {
    const rail = renderRail();
    const railKeys = rail.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => String(node.props.testID))
      .filter(id => /^main-rail-[A-Z_]+$/.test(id))
      .map(id => id.replace('main-rail-', ''));

    let bar!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      bar = ReactTestRenderer.create(
        <BottomTabBar activeTab="SETUP" onSelectTab={() => undefined} />,
      );
    });
    mounted.push(bar);
    const barKeys = bar.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => String(node.props.testID))
      .filter(id => /^main-tab-[A-Z_]+$/.test(id))
      .map(id => id.replace('main-tab-', ''));

    expect(railKeys).toEqual(barKeys);
    // ...and never exposes an unimplemented destination.
    const unimplemented = MAIN_TABS.filter(tab => !tab.implemented).map(
      tab => tab.key,
    );
    for (const key of unimplemented) {
      expect(railKeys).not.toContain(key);
    }
  });

  it('reports a press and nothing else', () => {
    const onSelectTab = jest.fn();
    const rail = renderRail(onSelectTab);
    act(() => {
      rail.root
        .findAll(node => node.props?.testID === 'main-rail-PORTS', {
          deep: false,
        })[0]
        .props.onPress();
    });
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith('PORTS');
  });

  it('marks the active destination for assistive technology, not by colour alone', () => {
    const rail = renderRail();
    const active = rail.root.findAll(
      node => node.props?.testID === 'main-rail-SETUP',
      { deep: false },
    )[0];
    expect(active.props.accessibilityRole).toBe('tab');
    expect(active.props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
  });

  it('renders the destination labels in Arabic', () => {
    const rail = renderRail();
    const text = rail.root
      .findAllByType(Text)
      .map(node => String(node.props.children))
      .join(' ');
    for (const tab of MAIN_TABS.filter(candidate => candidate.implemented)) {
      expect(text).toContain(i18n.t(tab.labelKey));
    }
  });
});
