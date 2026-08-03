/**
 * THE MAIN TAB SHELL.
 *
 * Registered as the 'Setup' stack route - deliberately keeping that route
 * name. 'Setup' is the post-connection destination the whole connect flow
 * (and App.tsx's own session-loss redirect listener) already targets, and
 * renaming it would have changed the redirect contract as a side effect of
 * adding a tab bar. The shell simply becomes what that route renders.
 *
 * WHAT IT OWNS: which tab is showing, and nothing else.
 *
 * WHAT IT DOES NOT OWN, AND MUST NOT: the MSP session. Switching tabs
 * mounts and unmounts nothing that touches the port.
 * `MspSessionCoordinator` owns the client, the transport and the telemetry
 * scheduler; this component never calls open, close, activate, deactivate,
 * start or stop on any of them. A tab change is a render change.
 *
 * STATE PRESERVATION. A tab is mounted the first time it is opened and
 * stays mounted afterwards, hidden with `display: 'none'` rather than
 * unmounted. Two reasons, both load-bearing:
 *   1. A screen's own state (Setup's scroll position and Motors' volatile
 *      verification observations) survives a tab
 *      switch instead of being silently discarded.
 *   2. The Motors lifecycle bridge STAYS ATTACHED. An unmount would tear
 *      the bridge down without any stop being requested, which is the one
 *      teardown order that must never happen while a lease may be held.
 *
 * THE MOTORS GUARD. Leaving the Motors tab fires the tab-blur source that
 * the accepted lifecycle bridge consumes as `addBlurListener` - the same
 * path blur, background and back-navigation already take. This file
 * contains no stop call, no release call and no controller reference; it
 * fires one event and the bridge decides everything else.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { colors } from '../theme';
import BottomTabBar from '../components/navigation/BottomTabBar';
import SetupScreen from './SetupScreen';
import MotorsTab from './MotorsScreen';
import PortsScreen from './PortsScreen';
import GpsScreen from './GpsScreen';
import {
  INITIAL_MAIN_TAB,
  isTabSelectable,
  type MainTabKey,
} from '../../navigation/tabs';
import type { RootStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

export default function MainTabsScreen(props: Props): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<MainTabKey>(INITIAL_MAIN_TAB);
  /** Tabs that have been opened at least once, and are therefore mounted
   * from here on. The initial tab counts as opened. */
  const [mountedTabs, setMountedTabs] = useState<readonly MainTabKey[]>([
    INITIAL_MAIN_TAB,
  ]);

  /**
   * The tab-blur source handed to the Motors container.
   *
   * A ref-held Set rather than component state: subscribing must not
   * re-render, and the emit below must see the CURRENT listener set even
   * when called from a stale closure.
   */
  const tabBlurListeners = useRef(new Set<() => void>());
  const dirtyTabs = useRef(new Set<MainTabKey>());
  const subscribeTabBlur = useCallback((listener: () => void) => {
    tabBlurListeners.current.add(listener);
    return () => {
      tabBlurListeners.current.delete(listener);
    };
  }, []);

  const reportDirty = useCallback((tab: MainTabKey, dirty: boolean) => {
    if (dirty) dirtyTabs.current.add(tab);
    else dirtyTabs.current.delete(tab);
  }, []);
  const reportMotorsDirty = useCallback(
    (dirty: boolean) => reportDirty('MOTORS', dirty),
    [reportDirty],
  );
  const reportPortsDirty = useCallback(
    (dirty: boolean) => reportDirty('PORTS', dirty),
    [reportDirty],
  );
  const reportGpsDirty = useCallback(
    (dirty: boolean) => reportDirty('GPS', dirty),
    [reportDirty],
  );

  const performTabSwitch = useCallback(
    (next: MainTabKey) => {
      if (activeTab === 'MOTORS') {
        try {
          // FIRE BEFORE THE SWITCH. The listeners are notified while the
          // Motors screen is still visible, so its accepted stop/release
          // path gets first ownership of departure.
          for (const listener of [...tabBlurListeners.current]) listener();
        } catch {
          // A failed safety listener used to abort setActiveTab silently,
          // making the navigation look broken. Keep the operator in place
          // and explain why; never hide a potentially live motor surface.
          Alert.alert(
            'تعذر الانتقال بأمان',
            'لم يكتمل مسار إيقاف المحركات. استخدم زر الإيقاف الطارئ ثم أعد المحاولة.',
            [{ text: 'حسناً' }],
          );
          return;
        }
      }
      setMountedTabs(current =>
        current.includes(next) ? current : [...current, next],
      );
      setActiveTab(next);
    },
    [activeTab],
  );

  const handleSelectTab = useCallback(
    (next: MainTabKey) => {
      if (next === activeTab || !isTabSelectable(next)) {
        return;
      }
      if (dirtyTabs.current.has(activeTab)) {
        Alert.alert(
          'تغييرات غير محفوظة',
          'لديك مسودة لم تُحفظ. ابقَ في الشاشة للحفظ، أو انتقل مؤقتاً؛ ستبقى المسودة في هذه الشاشة ما دام التطبيق مفتوحاً.',
          [
            { text: 'البقاء للحفظ', style: 'cancel' },
            {
              text: 'الانتقال مؤقتاً',
              onPress: () => performTabSwitch(next),
            },
          ],
        );
        return;
      }
      performTabSwitch(next);
    },
    [activeTab, performTabSwitch],
  );

  return (
    <View style={styles.root} testID="main-tabs">
      <View style={styles.content}>
        {mountedTabs.includes('SETUP') ? (
          <View
            style={activeTab === 'SETUP' ? styles.visible : styles.hidden}
            testID="main-tab-panel-SETUP"
          >
            <SetupScreen {...props} onOpenGps={() => handleSelectTab('GPS')} />
          </View>
        ) : null}
        {mountedTabs.includes('MOTORS') ? (
          <View
            style={activeTab === 'MOTORS' ? styles.visible : styles.hidden}
            testID="main-tab-panel-MOTORS"
          >
            <MotorsTab
              sessionKey={props.route.params?.sessionKey}
              navigation={props.navigation}
              subscribeTabBlur={subscribeTabBlur}
              onConfigurationDirtyChange={reportMotorsDirty}
              // The tab bar below already consumes the bottom safe-area
              // inset; the screen must not add it a second time.
              bottomInset={0}
            />
          </View>
        ) : null}
        {mountedTabs.includes('PORTS') ? (
          <View
            style={activeTab === 'PORTS' ? styles.visible : styles.hidden}
            testID="main-tab-panel-PORTS"
          >
            <PortsScreen
              sessionKey={props.route.params?.sessionKey}
              onDirtyChange={reportPortsDirty}
              onOpenGps={() => handleSelectTab('GPS')}
            />
          </View>
        ) : null}
        {mountedTabs.includes('GPS') ? (
          <View
            style={activeTab === 'GPS' ? styles.visible : styles.hidden}
            testID="main-tab-panel-GPS"
          >
            <GpsScreen
              sessionKey={props.route.params?.sessionKey}
              active={activeTab === 'GPS'}
              onOpenPorts={() => handleSelectTab('PORTS')}
              onDirtyChange={reportGpsDirty}
            />
          </View>
        ) : null}
      </View>
      <BottomTabBar activeTab={activeTab} onSelectTab={handleSelectTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
  visible: { flex: 1 },
  /* Hidden, NOT unmounted - see the Motors-bridge note in this file's
     header. `display: 'none'` removes it from layout entirely, so a hidden
     tab cannot occupy space or intercept touches. */
  hidden: { display: 'none' },
});
