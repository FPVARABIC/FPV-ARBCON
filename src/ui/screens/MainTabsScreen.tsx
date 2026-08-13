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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import ReceiverScreen from './ReceiverScreen';
import PidTuningScreen from './PidTuningScreen';
import ModesScreen from './ModesScreen';
import FailsafeScreen from './FailsafeScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import OsdScreen from './OsdScreen';
import VideoTransmitterScreen from './VideoTransmitterScreen';
import SensorsScreen from './SensorsScreen';
import PresetsScreen from './PresetsScreen';
import CliScreen from './CliScreen';
import {
  INITIAL_MAIN_TAB,
  isTabSelectable,
  type MainTabKey,
} from '../../navigation/tabs';
import type { RootStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

/**
 * ONE MOUNTED TAB, RENDERED ONLY WHEN ITS OWN INPUTS CHANGE.
 *
 * THE DEFECT THIS FIXES, measured rather than assumed. Every panel was
 * inline JSX in the shell's own return, so `setActiveTab` re-rendered the
 * shell and React re-rendered EVERY mounted screen with it - including the
 * ones sitting behind `display:'none'`. The instrumented shell recorded
 * one tab tap costing 7 full screen renders after 7 tabs had been visited,
 * and the cost grows with every tab the operator has ever opened: with all
 * 15 mounted, one tap re-renders 15 screens, among them a 2,600-line
 * Motors tree and a live Receiver workspace. That is the reported
 * "moving from one screen to another feels sluggish", and it gets worse
 * the longer a session runs, which is exactly how it was described.
 *
 * WHAT THIS DOES NOT CHANGE. Panels are still MOUNTED and hidden, never
 * unmounted - the Motors lifecycle bridge stays attached and every
 * screen's own state (scroll position, drafts, volatile verification
 * observations) survives a tab switch exactly as before. This is a
 * rendering fix, not a navigation rewrite.
 *
 * WHY `screenProps` MUST BE STABLE. React.memo compares props shallowly,
 * so a fresh object literal per render would defeat it silently. Every
 * call site below builds its props with `useMemo` over the real inputs;
 * the two panels involved in a switch re-render because their `active`
 * genuinely changed, and no others do.
 */
const TabPanel = React.memo(function TabPanelContent({
  tabKey,
  active,
  Screen,
  screenProps,
}: {
  readonly tabKey: MainTabKey;
  readonly active: boolean;
  readonly Screen: React.ComponentType<never>;
  readonly screenProps: Record<string, unknown>;
}): React.JSX.Element {
  const Component = Screen as React.ComponentType<Record<string, unknown>>;
  return (
    <View
      style={active ? styles.visible : styles.hidden}
      testID={`main-tab-panel-${tabKey}`}
    >
      <Component {...screenProps} active={active} />
    </View>
  );
});

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
  const [rawCliBusy, setRawCliBusy] = useState(false);
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
  const reportReceiverDirty = useCallback(
    (dirty: boolean) => reportDirty('RECEIVER', dirty),
    [reportDirty],
  );
  const reportPidDirty = useCallback(
    (dirty: boolean) => reportDirty('PID', dirty),
    [reportDirty],
  );
  const reportModesDirty = useCallback(
    (dirty: boolean) => reportDirty('MODES', dirty),
    [reportDirty],
  );
  const reportFailsafeDirty = useCallback(
    (dirty: boolean) => reportDirty('FAILSAFE', dirty),
    [reportDirty],
  );
  const reportPowerDirty = useCallback(
    (dirty: boolean) => reportDirty('POWER', dirty),
    [reportDirty],
  );
  const reportOsdDirty = useCallback(
    (dirty: boolean) => reportDirty('OSD', dirty),
    [reportDirty],
  );
  const reportVtxDirty = useCallback(
    (dirty: boolean) => reportDirty('VTX', dirty),
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
  const motorsDepartureGate = useRef<MotorsDepartureGate | undefined>(
    undefined,
  );
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
    (next: MainTabKey, stopAlreadyRequested = false) => {
      // Immediate, synchronous stop request - unchanged.
      if (!stopAlreadyRequested && !requestMotorStopForDeparture()) {
        return;
      }
      const gate =
        activeTab === 'MOTORS' ? motorsDepartureGate.current : undefined;
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
      let settled = false;
      setAwaitingMotorStop(true);
      const settle = (verdict: MotorDepartureVerdict) => {
        // A controller publication and the timeout can become runnable in
        // the same event-loop turn. Only the first verdict owns navigation
        // and the warning; a late duplicate must be inert.
        if (settled) {
          return;
        }
        settled = true;
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
      if (
        awaitingMotorStop ||
        rawCliBusy ||
        next === activeTab ||
        !isTabSelectable(next)
      ) {
        if (rawCliBusy) {
          Alert.alert(
            'جلسة CLI نشطة',
            'احفظ أو ألغِ الجلسة من الشاشة الحالية قبل الانتقال.',
          );
        }
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
            ? 'طُلِب إيقاف جلسة المحركات فوراً. لديك تغييرات لم تُحفظ؛ عُد لحفظها أو انتقل بعد تأكيد الإيقاف دون حفظ.'
            : 'لديك تغييرات لم تُحفظ. عُد لحفظها أو انتقل إلى الشاشة المطلوبة دون حفظ.',
          [
            { text: 'العودة للحفظ', style: 'cancel' },
            {
              text: 'الانتقال دون حفظ',
              // The stop request was already sent before opening this
              // prompt. Reuse the SAME bounded result path as an ordinary
              // departure without emitting a second motor command.
              onPress: () => performTabSwitch(next, activeTab === 'MOTORS'),
            },
          ],
        );
        return;
      }
      performTabSwitch(next);
    },
    [
      activeTab,
      awaitingMotorStop,
      performTabSwitch,
      rawCliBusy,
      requestMotorStopForDeparture,
    ],
  );

  /**
   * A STABLE `onOpenX` FOR EVERY SCREEN.
   *
   * `handleSelectTab` legitimately closes over `activeTab`,
   * `awaitingMotorStop` and `rawCliBusy`, so its identity changes on every
   * tab switch. Passing it into the memoised prop objects rebuilt all of
   * them and silently defeated TabPanel's memo - measured: the switch cost
   * stayed at 7 renders with the memo apparently "applied".
   *
   * The ref indirection gives the screens ONE function identity for the
   * life of the shell while every call still runs the CURRENT logic,
   * including the motor departure gate and the dirty-draft prompt. No
   * behaviour is captured stale, because nothing is captured at all.
   */
  const selectTabRef = useRef(handleSelectTab);
  selectTabRef.current = handleSelectTab;
  const selectTab = useCallback(
    (next: MainTabKey) => selectTabRef.current(next),
    [],
  );

  /**
   * STABLE PROP OBJECTS - the half of the memoisation that is easy to get
   * silently wrong. React.memo compares shallowly, so a literal rebuilt
   * every render would make TabPanel re-render anyway and the fix would
   * look applied while changing nothing.
   */
  const sessionKey = props.route.params?.sessionKey;

  /* SETUP P2: Setup's summary cards navigate to the screens that OWN the
   * configuration they summarize. The shell supplies plain callbacks, so
   * Setup imports no navigator internals and gains no owner authority. */
  const setupProps = useMemo(
    () => ({
      ...props,
      onOpenGps: () => selectTab('GPS'),
      onOpenReceiver: () => selectTab('RECEIVER'),
      onOpenPower: () => selectTab('POWER'),
      onOpenSensors: () => selectTab('SENSORS'),
    }),
    [props, selectTab],
  );
  const motorsProps = useMemo(
    () => ({
      sessionKey,
      navigation: props.navigation,
      subscribeTabBlur,
      registerDepartureGate,
      onConfigurationDirtyChange: reportMotorsDirty,
      // The tab bar below already consumes the bottom safe-area inset;
      // the screen must not add it a second time.
      bottomInset: 0,
    }),
    [props.navigation, registerDepartureGate, reportMotorsDirty, sessionKey, subscribeTabBlur],
  );
  const portsProps = useMemo(
    () => ({
      sessionKey,
      onDirtyChange: reportPortsDirty,
      onOpenGps: () => selectTab('GPS'),
    }),
    [reportPortsDirty, selectTab, sessionKey],
  );
  const gpsProps = useMemo(
    () => ({
      sessionKey,
      onOpenPorts: () => selectTab('PORTS'),
      onDirtyChange: reportGpsDirty,
    }),
    [reportGpsDirty, selectTab, sessionKey],
  );
  const configurationsProps = useMemo(
    () => ({
      sessionKey,
      onOpenSetup: () => selectTab('SETUP'),
      onOpenMotors: () => selectTab('MOTORS'),
      onOpenPorts: () => selectTab('PORTS'),
      onOpenGps: () => selectTab('GPS'),
      onDirtyChange: reportConfigurationsDirty,
    }),
    [reportConfigurationsDirty, selectTab, sessionKey],
  );
  const receiverProps = useMemo(
    () => ({
      sessionKey,
      onOpenPorts: () => selectTab('PORTS'),
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportReceiverDirty,
    }),
    [reportReceiverDirty, selectTab, sessionKey],
  );
  const pidProps = useMemo(
    () => ({
      sessionKey,
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportPidDirty,
    }),
    [reportPidDirty, selectTab, sessionKey],
  );
  const modesProps = useMemo(
    () => ({
      sessionKey,
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportModesDirty,
    }),
    [reportModesDirty, selectTab, sessionKey],
  );
  const failsafeProps = useMemo(
    () => ({
      sessionKey,
      onOpenReceiver: () => selectTab('RECEIVER'),
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportFailsafeDirty,
    }),
    [reportFailsafeDirty, selectTab, sessionKey],
  );
  const powerProps = useMemo(
    () => ({
      sessionKey,
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportPowerDirty,
    }),
    [reportPowerDirty, selectTab, sessionKey],
  );
  const osdProps = useMemo(
    () => ({
      sessionKey,
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportOsdDirty,
    }),
    [reportOsdDirty, selectTab, sessionKey],
  );
  const vtxProps = useMemo(
    () => ({
      sessionKey,
      onOpenMotors: () => selectTab('MOTORS'),
      onDirtyChange: reportVtxDirty,
    }),
    [reportVtxDirty, selectTab, sessionKey],
  );
  const sensorsProps = useMemo(
    () => ({
      sessionKey,
      onOpenSetup: () => selectTab('SETUP'),
    }),
    [selectTab, sessionKey],
  );
  const presetsProps = useMemo(
    () => ({
      sessionKey,
      onCliBusyChange: setRawCliBusy,
    }),
    [sessionKey],
  );
  const cliProps = useMemo(
    () => ({
      sessionKey,
      onCliBusyChange: setRawCliBusy,
    }),
    [sessionKey],
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
          <TabPanel
            tabKey="SETUP"
            active={activeTab === 'SETUP'}
            Screen={SetupScreen as never}
            screenProps={setupProps}
          />
        ) : null}
        {mountedTabs.includes('MOTORS') ? (
          <TabPanel
            tabKey="MOTORS"
            active={activeTab === 'MOTORS'}
            Screen={MotorsTab as never}
            screenProps={motorsProps}
          />
        ) : null}
        {mountedTabs.includes('PORTS') ? (
          <TabPanel
            tabKey="PORTS"
            active={activeTab === 'PORTS'}
            Screen={PortsScreen as never}
            screenProps={portsProps}
          />
        ) : null}
        {mountedTabs.includes('GPS') ? (
          <TabPanel
            tabKey="GPS"
            active={activeTab === 'GPS'}
            Screen={GpsScreen as never}
            screenProps={gpsProps}
          />
        ) : null}
        {mountedTabs.includes('CONFIGURATIONS') ? (
          <TabPanel
            tabKey="CONFIGURATIONS"
            active={activeTab === 'CONFIGURATIONS'}
            Screen={ConfigurationsScreen as never}
            screenProps={configurationsProps}
          />
        ) : null}
        {mountedTabs.includes('RECEIVER') ? (
          <TabPanel
            tabKey="RECEIVER"
            active={activeTab === 'RECEIVER'}
            Screen={ReceiverScreen as never}
            screenProps={receiverProps}
          />
        ) : null}
        {mountedTabs.includes('PID') ? (
          <TabPanel
            tabKey="PID"
            active={activeTab === 'PID'}
            Screen={PidTuningScreen as never}
            screenProps={pidProps}
          />
        ) : null}
        {mountedTabs.includes('MODES') ? (
          <TabPanel
            tabKey="MODES"
            active={activeTab === 'MODES'}
            Screen={ModesScreen as never}
            screenProps={modesProps}
          />
        ) : null}
        {mountedTabs.includes('FAILSAFE') ? (
          <TabPanel
            tabKey="FAILSAFE"
            active={activeTab === 'FAILSAFE'}
            Screen={FailsafeScreen as never}
            screenProps={failsafeProps}
          />
        ) : null}
        {mountedTabs.includes('POWER') ? (
          <TabPanel
            tabKey="POWER"
            active={activeTab === 'POWER'}
            Screen={PowerBatteryScreen as never}
            screenProps={powerProps}
          />
        ) : null}
        {mountedTabs.includes('OSD') ? (
          <TabPanel
            tabKey="OSD"
            active={activeTab === 'OSD'}
            Screen={OsdScreen as never}
            screenProps={osdProps}
          />
        ) : null}
        {mountedTabs.includes('VTX') ? (
          <TabPanel
            tabKey="VTX"
            active={activeTab === 'VTX'}
            Screen={VideoTransmitterScreen as never}
            screenProps={vtxProps}
          />
        ) : null}
        {mountedTabs.includes('SENSORS') ? (
          <TabPanel
            tabKey="SENSORS"
            active={activeTab === 'SENSORS'}
            Screen={SensorsScreen as never}
            screenProps={sensorsProps}
          />
        ) : null}
        {mountedTabs.includes('PRESETS') ? (
          <TabPanel
            tabKey="PRESETS"
            active={activeTab === 'PRESETS'}
            Screen={PresetsScreen as never}
            screenProps={presetsProps}
          />
        ) : null}
        {mountedTabs.includes('CLI') ? (
          <TabPanel
            tabKey="CLI"
            active={activeTab === 'CLI'}
            Screen={CliScreen as never}
            screenProps={cliProps}
          />
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
    color: colors.accentStrong,
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
