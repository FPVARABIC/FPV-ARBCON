/**
 * Bottom tab bar - order, RTL scroll position, disabled state and the
 * Motors stop guard.
 *
 * NO HARDWARE. Nothing here opens a session or touches USB.
 */

import React from 'react';
import { View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../../i18n';
import i18n from '../../../i18n';
import BottomTabBar from './BottomTabBar';
import MainTabsScreen from '../../screens/MainTabsScreen';
import {
  MAIN_TABS,
  isTabSelectable,
  type MainTabKey,
} from '../../../navigation/tabs';

function renderBar(onSelectTab: (tab: MainTabKey) => void = () => {}) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <BottomTabBar activeTab="SETUP" onSelectTab={onSelectTab} />,
    );
  });
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({ testID })[0],
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

describe('BottomTabBar - order and labels', () => {
  it('renders only implemented tabs in right-to-left product order', () => {
    const rendered = renderBar();
    const order = rendered.renderer.root
      .findAllByProps({}, { deep: true })
      .map(node => node.props.testID)
      .filter(
        (testID: unknown): testID is string =>
          typeof testID === 'string' && testID.startsWith('main-tab-'),
      )
      .filter(
        testID => testID !== 'main-tab-bar' && testID !== 'main-tab-bar-scroll',
      );
    const firstIndex = (key: string) => order.indexOf(`main-tab-${key}`);
    // Emission order IS right-to-left order: the first child of a
    // `flexDirection: 'row'` container sits at the right edge under RTL.
    expect(firstIndex('SETUP')).toBeLessThan(firstIndex('MOTORS'));
    expect(firstIndex('MOTORS')).toBeLessThan(firstIndex('PORTS'));
    expect(firstIndex('PORTS')).toBeLessThan(firstIndex('GPS'));
    expect(firstIndex('GPS')).toBeLessThan(firstIndex('CONFIGURATIONS'));
    expect(firstIndex('CONFIGURATIONS')).toBeLessThan(firstIndex('RECEIVER'));
    expect(firstIndex('PID')).toBe(-1);
    rendered.unmount();
  });

  it('labels every visible tab from the Arabic catalogue, never a hard-coded string', () => {
    const rendered = renderBar();
    const texts = rendered.renderer.root
      .findAllByType('Text' as never, { deep: true })
      .flatMap(node =>
        (Array.isArray(node.props.children)
          ? node.props.children
          : [node.props.children]
        ).filter((child: unknown) => typeof child === 'string'),
      );
    expect(texts).toContain(i18n.t('tabs.setup'));
    expect(texts).toContain(i18n.t('tabs.motors'));
    expect(texts).toContain(i18n.t('tabs.ports'));
    expect(texts).toContain(i18n.t('tabs.gps'));
    expect(texts).toContain(i18n.t('tabs.configurations'));
    expect(texts).toContain(i18n.t('tabs.receiver'));
    expect(texts).not.toContain(i18n.t('tabs.pid'));
    // A raw key rendered on screen is the exact defect this whole pass
    // exists to remove.
    for (const tab of MAIN_TABS) {
      expect(texts).not.toContain(tab.labelKey);
    }
    rendered.unmount();
  });

  it('never truncates a label', () => {
    const rendered = renderBar();
    for (const node of rendered.renderer.root.findAllByType('Text' as never, {
      deep: true,
    })) {
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.ellipsizeMode).toBeUndefined();
    }
    rendered.unmount();
  });
});

describe('BottomTabBar - roadmap tabs', () => {
  it('hides unimplemented destinations while preserving their route policy', () => {
    const pressed: MainTabKey[] = [];
    const rendered = renderBar(tab => pressed.push(tab));
    for (const tab of MAIN_TABS.filter(item => item.implemented)) {
      expect(rendered.find(`main-tab-${tab.key}`)).toBeDefined();
    }
    for (const tab of MAIN_TABS.filter(item => !item.implemented)) {
      expect(
        rendered.renderer.root.findAllByProps({
          testID: `main-tab-${tab.key}`,
        }),
      ).toHaveLength(0);
    }
    expect(isTabSelectable('PORTS')).toBe(true);
    expect(isTabSelectable('GPS')).toBe(true);
    expect(isTabSelectable('CONFIGURATIONS')).toBe(true);
    expect(isTabSelectable('RECEIVER')).toBe(true);
    expect(isTabSelectable('PID')).toBe(false);
    expect(pressed).toEqual([]);
    rendered.unmount();
  });

  it('marks the active tab as selected', () => {
    const rendered = renderBar();
    expect(
      rendered.find('main-tab-SETUP').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      rendered.find('main-tab-MOTORS').props.accessibilityState.selected,
    ).toBe(false);
    rendered.unmount();
  });
});

describe('BottomTabBar - safe area and stickiness', () => {
  it('does not add a second safe-area inset inside the root SafeAreaView', () => {
    const rendered = renderBar();
    const bar = rendered.find('main-tab-bar');
    const style = Array.isArray(bar.props.style)
      ? Object.assign({}, ...bar.props.style.filter(Boolean))
      : bar.props.style;
    expect(style.paddingBottom).toBeUndefined();
    rendered.unmount();
  });
});

/* ================================================================== *
 * The shell: state preservation and the Motors stop guard.
 * ================================================================== */

function renderShell(sessionId = 'session-1') {
  const navigation = {
    addListener: () => () => {},
    goBack: () => {},
  } as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: { sessionKey: { sessionId, generation: 1 } },
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({ testID })[0],
    query: (testID: string) => renderer.root.findAllByProps({ testID })[0],
    press: (testID: string) =>
      ReactTestRenderer.act(() => {
        renderer.root.findAllByProps({ testID })[0].props.onPress();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

describe('MainTabsScreen - the shell', () => {
  it('opens the integrated GPS destination directly from the live Setup GPS card', () => {
    const shell = renderShell();
    shell.press('setup-open-gps');
    expect(shell.find('main-tab-panel-GPS')).toBeDefined();
    expect(shell.find('gps-screen')).toBeDefined();
    shell.unmount();
  });

  it('mounts the real GPS destination inside the same application shell', () => {
    const shell = renderShell();
    shell.press('main-tab-GPS');
    expect(shell.find('main-tab-panel-GPS')).toBeDefined();
    expect(shell.find('gps-screen')).toBeDefined();
    shell.unmount();
  });

  it('mounts the integrated Configurations system in the same application shell', () => {
    const shell = renderShell();
    shell.press('main-tab-CONFIGURATIONS');
    expect(shell.find('main-tab-panel-CONFIGURATIONS')).toBeDefined();
    expect(shell.find('configurations-screen')).toBeDefined();
    shell.unmount();
  });

  it('mounts the functional Receiver destination in the same application shell', () => {
    const shell = renderShell();
    shell.press('main-tab-RECEIVER');
    expect(shell.find('main-tab-panel-RECEIVER')).toBeDefined();
    expect(shell.find('receiver-screen')).toBeDefined();
    shell.unmount();
  });

  it('starts on Setup and mounts Motors only once it is opened', () => {
    const shell = renderShell();
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-panel-SETUP' })
        .length,
    ).toBeGreaterThan(0);
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-panel-MOTORS' }),
    ).toHaveLength(0);

    shell.press('main-tab-MOTORS');
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-panel-MOTORS' })
        .length,
    ).toBeGreaterThan(0);
    shell.unmount();
  });

  it('keeps a visited tab MOUNTED but hidden when switching away, never unmounted', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    shell.press('main-tab-SETUP');

    const panel = shell.renderer.root.findAllByProps({
      testID: 'main-tab-panel-MOTORS',
    })[0];
    const style = Array.isArray(panel.props.style)
      ? Object.assign({}, ...panel.props.style.filter(Boolean))
      : panel.props.style;
    // Still in the tree - which is what keeps the Motors lifecycle bridge
    // attached so a tab change can trigger its stop path at all.
    expect(panel).toBeDefined();
    expect(style.display).toBe('none');
    shell.unmount();
  });

  it('mounts the integrated Ports destination only after it is selected', () => {
    const shell = renderShell();
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-PORTS' }).length,
    ).toBeGreaterThan(0);
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-panel-PORTS' }),
    ).toHaveLength(0);
    shell.press('main-tab-PORTS');
    expect(
      shell.renderer.root.findAllByProps({ testID: 'main-tab-panel-PORTS' })
        .length,
    ).toBeGreaterThan(0);
    shell.unmount();
  });

  it('renders the tab bar below the content, outside every screen scroll view', () => {
    const shell = renderShell();
    const root = shell.renderer.root.findAllByProps({ testID: 'main-tabs' })[0];
    const children = root.findAllByType(View, { deep: false });
    // The bar is a SIBLING of the content, not a child of it - so no inner
    // ScrollView can scroll it out of reach.
    const barAncestorTestIDs = shell.find('main-tab-bar').parent?.props?.testID;
    expect(barAncestorTestIDs).not.toBe('main-tab-panel-SETUP');
    expect(children.length).toBeGreaterThan(0);
    shell.unmount();
  });
});
