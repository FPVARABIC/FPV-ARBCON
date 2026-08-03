/**
 * THE MOTORS TAB GUARD.
 *
 * THE CHAIN BEING CLOSED, and where each link is proven:
 *
 *   1. leaving the Motors tab fires the shell's tab-blur source
 *      -> THIS FILE, behaviourally.
 *   2. the Motors container hands that source to the accepted lifecycle
 *      bridge as its `addBlurListener`
 *      -> MotorsScreenRoute.test.tsx, structurally, plus the assertion
 *         that no parallel stop path exists.
 *   3. a blur raises the bridge's stop obligation
 *      -> motorTestLifecycleBridge.test.ts, already, unchanged.
 *
 * The Motors screen is replaced by a probe here ON PURPOSE: the real one
 * registers its blur listener only once a live capability exists, and this
 * file is about the SHELL's behaviour, not the controller's. The probe
 * consumes `subscribeTabBlur` with exactly the signature the real bridge
 * source uses, so a change to that contract breaks this test.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

const fires: string[] = [];
let unsubscribeCount = 0;
let mockReportMotorsDirty: ((dirty: boolean) => void) | undefined;
let mockThrowOnBlur = false;

jest.mock('./MotorsScreen', () => {
  const ReactModule = require('react');
  const {Text} = require('react-native');
  return {
    __esModule: true,
    default: function MotorsTabProbe({
      subscribeTabBlur,
      onConfigurationDirtyChange,
    }: {
      subscribeTabBlur: (listener: () => void) => () => void;
      onConfigurationDirtyChange?: (dirty: boolean) => void;
    }) {
      mockReportMotorsDirty = onConfigurationDirtyChange;
      ReactModule.useEffect(() => {
        const unsubscribe = subscribeTabBlur(() => {
          if (mockThrowOnBlur) throw new Error('safety stop failed');
          fires.push('blur');
        });
        return () => {
          unsubscribeCount += 1;
          unsubscribe();
          mockReportMotorsDirty = undefined;
        };
      }, [subscribeTabBlur]);
      return ReactModule.createElement(Text, {testID: 'motors-probe'}, 'probe');
    },
  };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {Alert} from 'react-native';

import '../../i18n';
import MainTabsScreen from './MainTabsScreen';

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: 'session-1', generation: 1}},
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  return {
    renderer,
    press: (testID: string) =>
      ReactTestRenderer.act(() => {
        renderer.root.findAllByProps({testID})[0].props.onPress();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

beforeEach(() => {
  fires.length = 0;
  unsubscribeCount = 0;
  mockReportMotorsDirty = undefined;
  mockThrowOnBlur = false;
  jest.restoreAllMocks();
});

describe('Leaving the Motors tab triggers the existing stop/release path', () => {
  it('fires the tab-blur source when switching AWAY from Motors', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(fires).toEqual([]);

    shell.press('main-tab-SETUP');
    expect(fires).toEqual(['blur']);
    shell.unmount();
  });

  it('does NOT fire when arriving at Motors, or on a repeat press of the active tab', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    shell.press('main-tab-MOTORS');
    expect(fires).toEqual([]);
    shell.unmount();
  });

  it('does not fire on tab changes that do not involve Motors', () => {
    const shell = renderShell();
    // Ports is a real, selectable screen in the same application. Moving
    // SETUP -> PORTS -> SETUP must not manufacture a Motors blur event.
    shell.press('main-tab-PORTS');
    shell.press('main-tab-SETUP');
    expect(fires).toEqual([]);
    shell.unmount();
  });

  it('keeps the Motors subscription alive across the switch - it is hidden, not unmounted', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    shell.press('main-tab-SETUP');
    // An unmount here would have torn the bridge down with no stop
    // requested at all, which is the one teardown order that must never
    // happen while a lease may be held.
    expect(unsubscribeCount).toBe(0);

    // And a second visit still fires on the way out - the listener was
    // never dropped and never double-registered.
    shell.press('main-tab-MOTORS');
    shell.press('main-tab-SETUP');
    expect(fires).toEqual(['blur', 'blur']);
    shell.unmount();
  });

  it('stops immediately on the first departure tap, then asks what to do with a draft', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const shell = renderShell();
    shell.press('main-tab-MOTORS');

    ReactTestRenderer.act(() => mockReportMotorsDirty?.(true));
    shell.press('main-tab-PORTS');

    // The safety blur is not postponed behind a modal that the operator
    // may leave open indefinitely.
    expect(fires).toEqual(['blur']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('تغييرات غير محفوظة');
    expect(alert.mock.calls[0][1]).toContain('تم إيقاف جلسة المحركات فوراً');

    const buttons = alert.mock.calls[0][2];
    ReactTestRenderer.act(() => buttons?.[1]?.onPress?.());
    // Confirming the already-safe departure changes presentation only; it
    // must not manufacture a second lifecycle event.
    expect(fires).toEqual(['blur']);
    const portsPanel = shell.renderer.root.findByProps({
      testID: 'main-tab-panel-PORTS',
    });
    expect(portsPanel.props.style).toEqual(expect.objectContaining({flex: 1}));
    shell.unmount();
  });

  it('stops Motors even when the operator stays to save the draft', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const shell = renderShell();
    shell.press('main-tab-MOTORS');

    ReactTestRenderer.act(() => mockReportMotorsDirty?.(true));
    shell.press('main-tab-PORTS');

    const buttons = alert.mock.calls[0][2];
    ReactTestRenderer.act(() => buttons?.[0]?.onPress?.());
    expect(fires).toEqual(['blur']);
    const motorsPanel = shell.renderer.root.findByProps({
      testID: 'main-tab-panel-MOTORS',
    });
    expect(motorsPanel.props.style).toEqual(expect.objectContaining({flex: 1}));
    shell.unmount();
  });

  it('stays on Motors and explains the failure if the safety blur path throws', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    mockThrowOnBlur = true;

    shell.press('main-tab-SETUP');

    expect(fires).toEqual([]);
    expect(alert).toHaveBeenCalledWith(
      'تعذر الانتقال بأمان',
      expect.stringContaining('الإيقاف الطارئ'),
      expect.any(Array),
    );
    const motorsPanel = shell.renderer.root.findByProps({
      testID: 'main-tab-panel-MOTORS',
    });
    expect(motorsPanel.props.style).toEqual(expect.objectContaining({flex: 1}));
    shell.unmount();
  });
});
