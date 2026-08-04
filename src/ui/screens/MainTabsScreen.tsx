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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { colors } from '../theme';
import BottomTabBar from '../components/navigation/BottomTabBar';
import SideNavigationRail from '../components/navigation/SideNavigationRail';
import { isDesktopTier, resolveLayoutTier } from '../theme/layout';
import SetupScreen from './SetupScreen';
import MotorsTab from './MotorsScreen';
import type { MotorsDepartureGate } from './MotorsScreen';
import { MOTOR_DEPARTURE_BOUND_MILLIS } from '../../core/state/motorDepartureGate';
import type { MotorDepartureVerdict } from '../../core/state/motorDepartureGate';
import PortsScreen from './PortsScreen';
import GpsScreen from './GpsScreen';
import ConfigurationsScreen from './ConfigurationsScreen';
import {
  INITIAL_MAIN_TAB,
  isTabSelectable,
  type MainTabKey,
} from '../../navigation/tabs';
import type { RootStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

export default function MainTabsScreen(props: Props): React.JSX.Element {
  /**
   * DESKTOP GETS A RAIL, NOT A PHONE BAR. Exactly one navigation surface
   * is rendered for a given width, and switching between them changes
   * NOTHING about the tab panels: every panel stays mounted and hidden
   * with display:'none' exactly as before, so the motor-stop bridge is
   * never torn down. See this file's header for why that invariant is
   * load-bearing.
   */
  const { width, fontScale } = useWindowDimensions();
  const useSideRail = isDesktopTier(resolveLayoutTier(width, fontScale));
  const [activeTab, setActiveTab] = useState<MainTabKey>(INITIAL_MAIN_TAB);
  /** True only while a departure is waiting on the bounded stop result. */
  const [awaitingMotorStop, setAwaitingMotorStop] = useState(false);
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
  const reportConfigurationsDirty = useCallback(
    (dirty: boolean) => reportDirty('CONFIGURATIONS', dirty),
    [reportDirty],
  );

  const commitTabSwitch = useCallback((next: MainTabKey) => {
    setMountedTabs(current =>
      current.includes(next) ? current : [...current, next],
    );
    setActiveTab(next);
  }, []);

  /**
   * Registered by the Motors tab while it is mounted. Undefined means
   * Motors has no live session, so there is nothing to wait for.
   */
  const motorsDepartureGate = useRef<MotorsDepartureGate | undefined>(undefined);
  /**
   * Everything a pending departure owns, so unmount can cancel it.
   * Without this the bounded backstop fires into a torn-down tree - the
   * shell's own test caught exactly that.
   */
  const pendingDeparture = useRef<{
    unsubscribe?: () => void;
    timer?: ReturnType<typeof setTimeout>;
  }>({});
  useEffect(
    () => () => {
      pendingDeparture.current.unsubscribe?.();
      if (pendingDeparture.current.timer !== undefined) {
        clearTimeout(pendingDeparture.current.timer);
      }
      pendingDeparture.current = {};
    },
    [],
  );
  const registerDepartureGate = useCallback(
    (gate: MotorsDepartureGate | undefined) => {
      motorsDepartureGate.current = gate;
    },
    [],
  );

  const requestMotorStopForDeparture = useCallback((): boolean => {
    if (activeTab !== 'MOTORS') {
      return true;
    }
    try {
      // FIRE ON THE FIRST DEPARTURE TAP, even when a dirty-draft prompt is
      // about to keep the screen visible. The accepted bridge raises its
      // stop obligation synchronously while controller teardown continues
      // without blocking the UI. A later confirmation must not emit a
      // second blur merely to finish the visual tab switch.
      for (const listener of [...tabBlurListeners.current]) listener();
      return true;
    } catch {
      // A failed safety listener used to abort setActiveTab silently,
      // making the navigation look broken. Keep the operator in place and
      // explain why; never hide a potentially live motor surface.
      Alert.alert(
        'تعذر الانتقال بأمان',
        'لم يكتمل مسار إيقاف المحركات. استخدم زر الإيقاف الطارئ ثم أعد المحاولة.',
        [{ text: 'حسناً' }],
      );
      return false;
    }
  }, [activeTab]);

  /**
   * THE BOUNDED-CONFIRMATION DEPARTURE CONTRACT.
   *
   * Before this, the blur listeners fired (raising the stop obligation)
   * and the visual tab switch committed in the SAME synchronous turn -
   * only a listener THROWING could hold it, which is not how an
   * unconfirmed stop presents. An operator whose stop was never confirmed
   * was therefore moved off the Motors screen with no LiPo warning while
   * a command might still be live.
   *
   * The stop request is still issued FIRST and synchronously. Only the
   * NAVIGATION now waits, and only for the already-established bounded
   * result. Nothing here can delay, cancel or weaken the stop itself.
   */
  const performTabSwitch = useCallback(
    (next: MainTabKey) => {
      // Immediate, synchronous stop request - unchanged.
      if (!requestMotorStopForDeparture()) {
        return;
      }
      const gate = activeTab === 'MOTORS' ? motorsDepartureGate.current : undefined;
      if (gate === undefined) {
        commitTabSwitch(next);
        return;
      }
      // Already settled? Commit in the same turn, so the common safe case
      // is not made slower by this gate.
      const immediate = gate.evaluate(0);
      if (immediate === 'SAFE') {
        commitTabSwitch(next);
        return;
      }

      // THE SHELL owns the bound, because the shell owns navigation. The
      // Motors screen is guarded to create no timer beyond its heartbeat.
      const startedAt = Date.now();
      setAwaitingMotorStop(true);
      const settle = (verdict: MotorDepartureVerdict) => {
        const pending = pendingDeparture.current;
        pending.unsubscribe?.();
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        pendingDeparture.current = {};
        setAwaitingMotorStop(false);
        if (verdict === 'SAFE') {
          commitTabSwitch(next);
          return;
        }
        // Genuinely unconfirmed: stay on Motors and say why. Failing
        // closed is the only acceptable default here.
        Alert.alert(
          'لم يتأكد إيقاف المحركات',
          'لم يصل تأكيد إيقاف من متحكم الطيران خلال المهلة المحددة. افصل بطارية LiPo الآن قبل الاقتراب من الطائرة. تبقى شاشة المحركات ظاهرة حتى تتأكد بنفسك.',
          [{ text: 'حسناً' }],
        );
      };
      const check = () => {
        const verdict = gate.evaluate(Date.now() - startedAt);
        if (verdict !== 'PENDING') {
          settle(verdict);
        }
      };
      // Subscribe FIRST so a transition landing between here and the
      // immediate re-check cannot be missed.
      pendingDeparture.current = {
        unsubscribe: gate.subscribe(check),
        // A controller that publishes nothing further must still produce
        // a verdict rather than holding navigation forever.
        timer: setTimeout(
          () => settle('UNCONFIRMED'),
          MOTOR_DEPARTURE_BOUND_MILLIS,
        ),
      };
      check();
    },
    [activeTab, commitTabSwitch, requestMotorStopForDeparture],
  );

  const handleSelectTab = useCallback(
    (next: MainTabKey) => {
      if (next === activeTab || !isTabSelectable(next)) {
        return;
      }
      if (dirtyTabs.current.has(activeTab)) {
        // Motors must be made safe BEFORE asking what to do with an
        // unrelated configuration draft. The alert may remain open for an
        // arbitrary time; motor pulses must not remain live behind it.
        if (!requestMotorStopForDeparture()) {
          return;
        }
        Alert.alert(
          'تغييرات غير محفوظة',
          activeTab === 'MOTORS'
            ? 'تم إيقاف جلسة المحركات فوراً. لديك تغييرات لم تُحفظ؛ عُد لحفظها أو انتقل إلى الشاشة المطلوبة دون حفظ.'
            : 'لديك تغييرات لم تُحفظ. عُد لحفظها أو انتقل إلى الشاشة المطلوبة دون حفظ.',
          [
            { text: 'العودة للحفظ', style: 'cancel' },
            {
              text: 'الانتقال دون حفظ',
              onPress: () => commitTabSwitch(next),
            },
          ],
        );
        return;
      }
      performTabSwitch(next);
    },
    [
      activeTab,
      commitTabSwitch,
      performTabSwitch,
      requestMotorStopForDeparture,
    ],
  );

  return (
    <View
      style={[styles.root, useSideRail && styles.rootDesktop]}
      testID="main-tabs"
    >
      {useSideRail ? (
        <SideNavigationRail
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
        />
      ) : null}
      <View style={styles.content}>
        {mountedTabs.includes('SETUP') ? (
          <View
            style={activeTab === 'SETUP' ? styles.visible : styles.hidden}
            testID="main-tab-panel-SETUP"
          >
            <SetupScreen
              {...props}
              active={activeTab === 'SETUP'}
              onOpenGps={() => handleSelectTab('GPS')}
            />
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
              registerDepartureGate={registerDepartureGate}
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
        {mountedTabs.includes('CONFIGURATIONS') ? (
          <View
            style={
              activeTab === 'CONFIGURATIONS' ? styles.visible : styles.hidden
            }
            testID="main-tab-panel-CONFIGURATIONS"
          >
            <ConfigurationsScreen
              sessionKey={props.route.params?.sessionKey}
              active={activeTab === 'CONFIGURATIONS'}
              onOpenSetup={() => handleSelectTab('SETUP')}
              onOpenMotors={() => handleSelectTab('MOTORS')}
              onOpenPorts={() => handleSelectTab('PORTS')}
              onOpenGps={() => handleSelectTab('GPS')}
              onDirtyChange={reportConfigurationsDirty}
            />
          </View>
        ) : null}
      </View>
      {awaitingMotorStop ? (
        <View style={styles.awaitingStop} testID="main-tabs-awaiting-stop">
          <Text style={styles.awaitingStopText}>
            بانتظار تأكيد إيقاف المحركات قبل مغادرة الشاشة…
          </Text>
        </View>
      ) : null}
      {useSideRail ? null : (
        <BottomTabBar activeTab={activeTab} onSelectTab={handleSelectTab} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  /* The rail sits beside the workspace instead of below it. `row` under
     forceRTL puts the rail on the right, which is the reading start. */
  rootDesktop: { flexDirection: 'row' },
  awaitingStop: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: colors.accentSoft,
    borderTopWidth: 1,
    borderTopColor: colors.accentStrong,
  },
  awaitingStopText: {
    color: colors.accent,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  content: { flex: 1 },
  visible: { flex: 1 },
  /* Hidden, NOT unmounted - see the Motors-bridge note in this file's
     header. `display: 'none'` removes it from layout entirely, so a hidden
     tab cannot occupy space or intercept touches. */
  hidden: { display: 'none' },
});
