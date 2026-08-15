/**
 * FPV-ARBCON - the BROWSER root.
 *
 * This is the same application as App.tsx, not a web edition of it. It
 * renders the same Arabic screens, drives the same MSP core, and reuses
 * useSessionLossRedirect() - the one shared implementation of the
 * "tracked session died -> return to Connection" safety rule - rather
 * than carrying a second copy of it.
 */

import React, {Suspense} from 'react';
import {ActivityIndicator, I18nManager, StyleSheet, Text, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';

import './src/i18n';
import StartScreen from './src/ui/screens/StartScreen';
import {useSessionLossRedirect} from './src/navigation/useSessionLossRedirect';
import type {RootStackParamList} from './src/navigation/types';
import {WebAlertHost, installWebAlert} from './src/platforms/web/webAlert';
import {WebCompatibilityNotice} from './src/platforms/web/WebCompatibilityNotice';
import {PreviewNotice} from './src/platforms/web/PreviewNotice';
import {colors} from './src/ui/theme';

const IS_PREVIEW_BUILD = import.meta.env.VITE_FPV_ARBCON_PREVIEW === 'true';

if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

installWebAlert();

const Stack = createNativeStackNavigator<RootStackParamList>();

const UsbConnectionScreen = React.lazy(
  () => import('./src/ui/screens/UsbConnectionScreen'),
);
const MainTabsScreen = React.lazy(() => import('./src/ui/screens/MainTabsScreen'));
const FirmwareFlasherScreen = React.lazy(
  () => import('./src/ui/screens/FirmwareFlasherSimpleScreen'),
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
      {IS_PREVIEW_BUILD ? <PreviewNotice /> : null}
      <WebCompatibilityNotice />
      <View style={styles.navigator}>
        <NavigationContainer
          ref={navigationRef}
          onReady={onReady}
          onStateChange={onStateChange}
          documentTitle={{enabled: false}}>
          <Suspense fallback={<ScreenFallback />}>
            <Stack.Navigator
              initialRouteName="Start"
              screenOptions={{headerShown: false}}>
              <Stack.Screen name="Start" component={StartScreen} />
              <Stack.Screen name="Connection" component={UsbConnectionScreen} />
              <Stack.Screen name="Setup" component={MainTabsScreen} />
              <Stack.Screen name="FirmwareFlasher" component={FirmwareFlasherScreen} />
            </Stack.Navigator>
          </Suspense>
        </NavigationContainer>
      </View>
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
  },
});

export default App;
