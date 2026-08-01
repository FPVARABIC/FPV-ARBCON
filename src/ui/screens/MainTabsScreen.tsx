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

import React, {useCallback, useRef, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {colors} from '../theme';
import BottomTabBar from '../components/navigation/BottomTabBar';
import SetupScreen from './SetupScreen';
import MotorsTab from './MotorsScreen';
import {INITIAL_MAIN_TAB, isTabSelectable, type MainTabKey} from '../../navigation/tabs';
import type {RootStackParamList} from '../../navigation/types';

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
  const subscribeTabBlur = useCallback((listener: () => void) => {
    tabBlurListeners.current.add(listener);
    return () => {
      tabBlurListeners.current.delete(listener);
    };
  }, []);

  const handleSelectTab = useCallback(
    (next: MainTabKey) => {
      if (next === activeTab || !isTabSelectable(next)) {
        return;
      }
      if (activeTab === 'MOTORS') {
        // FIRE BEFORE THE SWITCH. The listeners are notified while the
        // Motors screen is still the one in front of the operator, so the
        // bridge's stop obligation is registered against a screen that has
        // not yet been hidden. Iterated over a copy: a listener that
        // unsubscribes itself must not mutate the set mid-iteration.
        for (const listener of [...tabBlurListeners.current]) {
          listener();
        }
      }
      setMountedTabs(current =>
        current.includes(next) ? current : [...current, next],
      );
      setActiveTab(next);
    },
    [activeTab],
  );

  return (
    <View style={styles.root} testID="main-tabs">
      <View style={styles.content}>
        {mountedTabs.includes('SETUP') ? (
          <View
            style={activeTab === 'SETUP' ? styles.visible : styles.hidden}
            testID="main-tab-panel-SETUP">
            <SetupScreen {...props} />
          </View>
        ) : null}
        {mountedTabs.includes('MOTORS') ? (
          <View
            style={activeTab === 'MOTORS' ? styles.visible : styles.hidden}
            testID="main-tab-panel-MOTORS">
            <MotorsTab
              sessionKey={props.route.params?.sessionKey}
              navigation={props.navigation}
              subscribeTabBlur={subscribeTabBlur}
              // The tab bar below already consumes the bottom safe-area
              // inset; the screen must not add it a second time.
              bottomInset={0}
            />
          </View>
        ) : null}
      </View>
      <BottomTabBar activeTab={activeTab} onSelectTab={handleSelectTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {flex: 1},
  visible: {flex: 1},
  /* Hidden, NOT unmounted - see the Motors-bridge note in this file's
     header. `display: 'none'` removes it from layout entirely, so a hidden
     tab cannot occupy space or intercept touches. */
  hidden: {display: 'none'},
});
