/**
 * FPV-ARBCON - the BROWSER root.
 *
 * This is the same application as App.tsx, not a web edition of it. It
 * renders the same Arabic screens, drives the same MSP core, and reuses
 * useSessionLossRedirect() - the one shared implementation of the
 * "tracked session died -> return to Home" safety rule - rather than
 * carrying a second copy of it.
 *
 * THE THREE THINGS THAT LEGITIMATELY DIFFER HERE, and why:
 *
 * 1. LAZY ROUTES. On Android, Metro ships one bundle and `getComponent`
 *    is enough to keep the flasher out of the connection path. A browser
 *    downloads what it is given, so MainTabs and the Firmware Flasher are
 *    React.lazy() chunks: opening the app fetches the Start screen and
 *    the shared core, not the entire configurator plus esptool.
 *    `getComponent` cannot express this - it must return a component
 *    synchronously - so these are lazy() + <Suspense>. There is no
 *    connection chunk at all: connecting is a service Home drives rather
 *    than a screen anyone navigates to, so it ships with Home, and the
 *    fifteen configuration screens arrive only once there is a board to
 *    configure.
 *
 * 1c. THE HARD CONNECTION WALL IS NOT PLATFORM-SPECIFIC. The `Setup`
 *    route - the configuration workspace and every screen in it - is
 *    registered here on exactly the same predicate App.tsx uses, from
 *    exactly the same hook. A browser is the platform where an
 *    unregistered route matters MOST: a registered one could be reached
 *    by a typed URL, a bookmark or a restored history entry. Registering
 *    it unconditionally here while Android walls it off would have been
 *    the drift this file's whole preamble exists to prevent.
 *
 * 1b. THE PERSISTENT BRAND CHROME. The official logo lives in a slim
 *    always-visible strip above the navigator - the browser top chrome
 *    the product brief calls for. Android deliberately renders no such
 *    strip; its logo lives on the Start screen (see BrandTopChrome.tsx).
 *
 * 2. THE ALERT HOST. react-native-web's Alert.alert is a no-op; see
 *    webAlert.tsx for the full list of safety decisions that silently
 *    stop working without this. Installed before the first render so an
 *    alert raised during a screen's initial render is not lost.
 *
 * 3. THE COMPATIBILITY NOTICE. Rendered above the navigator, and only
 *    when a capability is genuinely absent.
 *
 * SafeAreaView is deliberately absent: it exists for notches and system
 * bars. The web shell handles its own viewport, and react-native-web's
 * StatusBar is a no-op, so both are omitted rather than rendered as
 * decoration that does nothing.
 */

import React, {Suspense} from 'react';
import {ActivityIndicator, I18nManager, StyleSheet, Text, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {useBrowserBackIntegration} from './src/navigation/useBrowserBackIntegration.web';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';

import './src/i18n';
// Imported from its own module rather than the './src/ui' barrel: that
// barrel statically re-exports MainTabsScreen, so importing through it
// would pull the entire configurator into the entry chunk and defeat
// every lazy() boundary below.
import StartScreen from './src/ui/screens/StartScreen';
import BrandTopChrome from './src/ui/brand/BrandTopChrome';
import {useSessionLossRedirect} from './src/navigation/useSessionLossRedirect';
import {
  configurationWorkspaceUnlocked,
  RebootOverlay,
  useVerifiedFcConnection,
} from './src/ui/session';
import type {RootStackParamList} from './src/navigation/types';
import {WebAlertHost, installWebAlert} from './src/platforms/web/webAlert';
import {WebCompatibilityNotice} from './src/platforms/web/WebCompatibilityNotice';
import {colors} from './src/ui/theme';

/**
 * True only in the GitHub Pages preview build, which sets
 * VITE_FPV_ARBCON_PREVIEW=true.
 *
 * `import.meta.env` is a Vite construct, which is why this read lives in
 * this file: App.web.tsx is only ever compiled by Vite, never by Jest.
 *
 * IT NO LONGER RENDERS ANYTHING. A yellow "unverified preview" strip used
 * to sit above every route, and it was the first thing an operator saw on
 * every screen - build provenance occupying the top of a flight-controller
 * tool. Build status is a DEVELOPER fact, so it is now a developer
 * diagnostic: emitted once to the console, where a developer looking for
 * it will find it, and nowhere in the product surface.
 */
const IS_PREVIEW_BUILD = import.meta.env.VITE_FPV_ARBCON_PREVIEW === 'true';

if (IS_PREVIEW_BUILD) {
  console.info(
    '[FPV-ARBCON] Preview build. Connection paths are real and unmodified; ' +
      'hardware behaviour still requires confirmation on a physical board.',
  );
}

// The shared screens are written for a genuinely RTL layout (see
// src/navigation/tabs.ts on tab order). react-native-web reads this the
// same way React Native does, and index.html carries dir="rtl" so the
// document itself agrees before the first paint.
if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

// Module scope, not an effect: a screen that alerts during its very first
// render must find the real implementation already installed.
installWebAlert();

const Stack = createNativeStackNavigator<RootStackParamList>();

const MainTabsScreen = React.lazy(() => import('./src/ui/screens/MainTabsScreen'));
// The default flasher route is the compact simple workflow; the full
// legacy surface stays reachable from its own «متقدم» control for recovery
// and specialist cases (the simple screen renders it embedded).
const FirmwareFlasherScreen = React.lazy(
  () => import('./src/ui/screens/FirmwareFlasherSimpleScreen'),
);
// The guide carries every step capture of every corner - megabytes of
// PNG - so it is its own chunk and downloads only when opened.
const FlightStyleGuideScreen = React.lazy(
  () => import('./src/ui/screens/FlightStyleGuideScreen'),
);
const FlightStyleCornerScreen = React.lazy(
  () => import('./src/ui/screens/FlightStyleCornerScreen'),
);

function ScreenFallback(): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <View style={styles.fallback} testID="web-screen-fallback">
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.fallbackText}>{t('webPlatform.loading')}</Text>
    </View>
  );
}

function App(): React.JSX.Element {
  const {navigationRef, onReady, onStateChange} = useSessionLossRedirect();
  // Browser Back navigates the app instead of doing nothing - see the
  // hook's own note on why this is history-depth mirroring rather than
  // path linking.
  useBrowserBackIntegration(navigationRef);

  /**
   * THE WALL. See App.tsx for the full reasoning - it is one predicate,
   * one hook, and deliberately identical on both roots.
   *
   * What it buys specifically here: browser Back, a refresh, a typed URL
   * and a restored history entry all resolve against the navigator's
   * REGISTERED routes. While this says locked there is no `Setup` route
   * to resolve to, so none of them can produce a configuration screen -
   * not even for the single frame a runtime guard would need in order to
   * notice and redirect.
   */
  const connection = useVerifiedFcConnection();
  const workspaceUnlocked = configurationWorkspaceUnlocked(connection);
  const sessionKey =
    connection.kind === 'CONNECTED' ? connection.sessionKey : undefined;

  /**
   * Opening the workspace is a NAVIGATION, and one place decides it, so
   * there is no window in which two of them disagree.
   */
  React.useEffect(() => {
    if (!workspaceUnlocked || sessionKey === undefined) return;
    const navigator = navigationRef.current;
    if (navigator === null || !navigator.isReady()) return;
    if (navigator.getCurrentRoute()?.name === 'Setup') return;
    navigator.reset({
      index: 1,
      routes: [{name: 'Start'}, {name: 'Setup', params: {sessionKey}}],
    });
  }, [navigationRef, sessionKey, workspaceUnlocked]);

  return (
    <View style={styles.container}>
      {/* No build-status strip here. The compatibility notice stays: it
          reports a capability the browser genuinely lacks, which changes
          what the operator can do, unlike which build they are running. */}
      <WebCompatibilityNotice />
      <BrandTopChrome />
      <View style={styles.navigator}>
        <NavigationContainer
          ref={navigationRef}
          onReady={onReady}
          onStateChange={onStateChange}
          // Found by loading the real production build in Chromium: React
          // Navigation's web integration overwrites document.title with the
          // ROUTE NAME on every navigation, so the browser tab read "Start",
          // then "Connection". Those names are internal English identifiers
          // (see src/navigation/types.ts, where the 'Setup' route actually
          // renders the whole tab shell) - exactly the wrong thing to show
          // as the window title of an Arabic-first product. Disabled so the
          // curated Arabic <title> in index.html stands.
          documentTitle={{enabled: false}}>
          {/* One Suspense boundary around the navigator, not one per
              screen: a per-screen boundary remounts its fallback on every
              navigation even for an already-downloaded chunk. */}
          <Suspense fallback={<ScreenFallback />}>
            <Stack.Navigator
              initialRouteName="Start"
              screenOptions={{headerShown: false}}>
              <Stack.Screen name="Start" component={StartScreen} />
              {workspaceUnlocked ? (
                <Stack.Screen name="Setup" component={MainTabsScreen} />
              ) : null}
              <Stack.Screen
                name="FirmwareFlasher"
                component={FirmwareFlasherScreen}
              />
              <Stack.Screen
                name="FlightStyleGuide"
                component={FlightStyleGuideScreen}
              />
              <Stack.Screen
                name="FlightStyleCorner"
                component={FlightStyleCornerScreen}
              />
            </Stack.Navigator>
          </Suspense>
        </NavigationContainer>
      </View>
      {/* A reboot we asked for is a STATE, not a destination. Outside
          the navigator on purpose: not a route, not a history entry, and
          nothing a refresh or Back can bring back. */}
      <RebootOverlay connection={connection} />
      {/* Last child, so it paints above the navigator without needing a
          portal - a dialog must survive navigation happening underneath. */}
      <WebAlertHost />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundRaised,
  },
  navigator: {
    flex: 1,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: colors.backgroundRaised,
  },
  fallbackText: {
    fontFamily: 'Cairo',
    fontSize: 14,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});

export default App;
