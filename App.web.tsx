/**
 * FPV-ARBCON - the BROWSER root.
 *
 * This is the same application as App.tsx, not a web edition of it. It
 * renders the same Arabic screens, drives the same MSP core, and reuses
 * useSessionLossRedirect() - the one shared implementation of the
 * "tracked session died -> return to Connection" safety rule - rather
 * than carrying a second copy of it.
 *
 * THE THREE THINGS THAT LEGITIMATELY DIFFER HERE, and why:
 *
 * 1. LAZY ROUTES. On Android, Metro ships one bundle and `getComponent`
 *    is enough to keep the flasher out of the connection path. A browser
 *    downloads what it is given, so Connection, MainTabs and the Firmware
 *    Flasher are React.lazy() chunks: opening the app fetches the Start
 *    screen and the shared core, not the entire configurator plus
 *    esptool. `getComponent` cannot express this - it must return a
 *    component synchronously - so these are lazy() + <Suspense>.
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
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';

import './src/i18n';
// Imported from its own module rather than the './src/ui' barrel: that
// barrel statically re-exports MainTabsScreen and UsbConnectionScreen, so
// importing through it would pull the entire configurator into the entry
// chunk and defeat every lazy() boundary below.
import StartScreen from './src/ui/screens/StartScreen';
import {useSessionLossRedirect} from './src/navigation/useSessionLossRedirect';
import type {RootStackParamList} from './src/navigation/types';
import {WebAlertHost, installWebAlert} from './src/platforms/web/webAlert';
import {WebCompatibilityNotice} from './src/platforms/web/WebCompatibilityNotice';
import {PreviewNotice} from './src/platforms/web/PreviewNotice';
import {colors} from './src/ui/theme';

/**
 * True only in the GitHub Pages preview build, which sets
 * VITE_FPV_ARBCON_PREVIEW=true. This is the ONLY place the flag is read -
 * PreviewNotice itself takes no flag, so it stays a plain, testable
 * component and the build-time condition stays in one place.
 *
 * `import.meta.env` is a Vite construct, which is why this read lives in
 * this file: App.web.tsx is only ever compiled by Vite, never by Jest.
 */
const IS_PREVIEW_BUILD = import.meta.env.VITE_FPV_ARBCON_PREVIEW === 'true';

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

const UsbConnectionScreen = React.lazy(
  () => import('./src/ui/screens/UsbConnectionScreen'),
);
const MainTabsScreen = React.lazy(() => import('./src/ui/screens/MainTabsScreen'));
const FirmwareFlasherScreen = React.lazy(
  () => import('./src/ui/screens/FirmwareFlasherScreen'),
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

  return (
    <View style={styles.container}>
      {/* Above the compatibility notice: "this build is unverified" is
          the first thing a preview visitor must read. Purely a label -
          see PreviewNotice for why it changes no behaviour. */}
      {IS_PREVIEW_BUILD ? <PreviewNotice /> : null}
      <WebCompatibilityNotice />
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
              <Stack.Screen name="Connection" component={UsbConnectionScreen} />
              <Stack.Screen name="Setup" component={MainTabsScreen} />
              <Stack.Screen
                name="FirmwareFlasher"
                component={FirmwareFlasherScreen}
              />
            </Stack.Navigator>
          </Suspense>
        </NavigationContainer>
      </View>
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
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});

export default App;
