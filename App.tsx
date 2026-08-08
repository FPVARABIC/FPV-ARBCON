/**
 * FPV-ARBCON
 *
 * @format
 */

import React from 'react';
import { I18nManager, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import './src/i18n';
// SINGLE-APP MERGE: the 'Setup' route now renders the main TAB SHELL
// (Setup / Motors / Ports / Receiver / PID), not the Setup screen alone.
// The route name is unchanged on purpose - see src/navigation/types.ts.
import {
  MainTabsScreen,
  StartScreen,
  UsbConnectionScreen,
} from './src/ui';
// The session-loss redirect (tracked sessionId -> reset to 'Connection'
// once its MSP ownership goes INACTIVE) now lives in ONE shared hook, so
// index.web.tsx's own root cannot drift from this one on a SAFETY rule.
// The full Pass 7.1 investigation notes moved with the code rather than
// being left behind here - see that file.
import { useSessionLossRedirect } from './src/navigation/useSessionLossRedirect';
import type { RootStackParamList } from './src/navigation/types';
import { colors } from './src/ui/theme';

if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Keep the firmware tool outside the connection/Motors module graph until
 * the operator explicitly opens it.  The flasher pulls in catalogue,
 * parsing and bootloader engines (including esptool); evaluating those at
 * application start would make an independent tool part of the critical
 * connection path for no user benefit.
 */
function getFirmwareFlasherScreen() {
  return require('./src/ui/screens/FirmwareFlasherScreen').default;
}

function App(): React.JSX.Element {
  const { navigationRef, onReady, onStateChange } = useSessionLossRedirect();

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={colors.backgroundRaised}
      />
      <NavigationContainer
        ref={navigationRef}
        onReady={onReady}
        onStateChange={onStateChange}>
        <Stack.Navigator initialRouteName="Start" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Start" component={StartScreen} />
          <Stack.Screen name="Connection" component={UsbConnectionScreen} />
          <Stack.Screen name="Setup" component={MainTabsScreen} />
          <Stack.Screen name="FirmwareFlasher" getComponent={getFirmwareFlasherScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundRaised,
  },
});

export default App;
