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
// ENTRY CLEANUP: the standalone 'Connection' route is gone. Start opens
// the shell DIRECTLY; the USB connection workspace renders inside the
// Setup tab whenever the route has no sessionKey (SetupScreen.tsx).
import {
  MainTabsScreen,
  StartScreen,
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
 * the operator explicitly opens it. The default route is now the compact
 * workflow; the full legacy surface remains reachable from its "متقدم"
 * control for recovery and specialist cases.
 */
function getFirmwareFlasherScreen() {
  return require('./src/ui/screens/FirmwareFlasherSimpleScreen').default;
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
