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
import {
  configurationWorkspaceUnlocked,
  RebootOverlay,
  useRebootReconnect,
  useVerifiedFcConnection,
} from './src/ui/session';
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

/**
 * The guide screens carry every step capture of every corner, so they stay
 * out of the start-up module graph until the operator asks for them.
 */
function getFlightStyleGuideScreen() {
  return require('./src/ui/screens/FlightStyleGuideScreen').default;
}

function getFlightStyleCornerScreen() {
  return require('./src/ui/screens/FlightStyleCornerScreen').default;
}

function App(): React.JSX.Element {
  const { navigationRef, onReady, onStateChange } = useSessionLossRedirect();
  /**
   * THE HARD WALL, and it is a wall rather than a lock.
   *
   * `Setup` - the configuration workspace, its tab shell and all fifteen
   * screens - is REGISTERED IN THE NAVIGATOR ONLY while a flight
   * controller is verified. Not disabled, not gated, not wrapped in a
   * notice: absent. Nothing else in this file needs to defend it,
   * because a route that is not registered:
   *
   *   - cannot be navigated to, by us or by anything else;
   *   - cannot be entered by a direct URL or a deep link, on web the
   *     linking layer simply has no match for the path;
   *   - cannot be restored from a saved navigation state;
   *   - cannot render "for one frame before a guard notices", because
   *     there is no component to mount and no frame to render it in.
   *
   * WHERE A LOCKED APPLICATION LIVES: Home, and nowhere else. There is
   * no connection route to fall back to and no connection screen to be
   * stranded on - connecting is something Home DOES (see StartScreen and
   * useDirectConnect), not a place this navigator can send anybody. So
   * the locked application is exactly Home plus the two public
   * destinations, and a board going away mid-session unmounts the
   * workspace and leaves the operator on Home - not on Motors with a
   * disconnected message, and not on a page whose only purpose is to
   * say "not connected".
   *
   * The controller-level guards stay exactly as they are. They are the
   * inner safety layer against a stale operation; this is the outer one
   * against a stale APPLICATION.
   */
  const connection = useVerifiedFcConnection();
  /**
   * THE WAY OUT OF THE OVERLAY, and it lives here because the overlay
   * does. A CLI save reboots the board; something has to reopen it, and
   * whatever owns a blocking state owns ending it. See
   * useRebootReconnect - every path out is bounded by the lifecycle's
   * own deadline, including the one where the board never returns.
   */
  useRebootReconnect();
  const workspaceUnlocked = configurationWorkspaceUnlocked(connection);
  const sessionKey =
    connection.kind === 'CONNECTED' ? connection.sessionKey : undefined;

  /**
   * Opening the workspace is a NAVIGATION, and it belongs here rather
   * than in the connect screen: one place decides that the wall has
   * come down, so there is no window in which two of them disagree.
   */
  React.useEffect(() => {
    if (!workspaceUnlocked || sessionKey === undefined) return;
    const navigator = navigationRef.current;
    if (navigator === null || !navigator.isReady()) return;
    const current = navigator.getCurrentRoute()?.name;
    if (current === 'Setup') return;
    navigator.reset({
      index: 1,
      routes: [{ name: 'Start' }, { name: 'Setup', params: { sessionKey } }],
    });
  }, [navigationRef, sessionKey, workspaceUnlocked]);

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
          {workspaceUnlocked ? (
            <Stack.Screen name="Setup" component={MainTabsScreen} />
          ) : null}
          <Stack.Screen name="FirmwareFlasher" getComponent={getFirmwareFlasherScreen} />
          <Stack.Screen name="FlightStyleGuide" getComponent={getFlightStyleGuideScreen} />
          <Stack.Screen name="FlightStyleCorner" getComponent={getFlightStyleCornerScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* A reboot we asked for is a STATE, not a destination - see
          RebootOverlay. Outside the navigator on purpose: it must not be
          a route, a history entry, or something a refresh can restore. */}
      <RebootOverlay connection={connection} />
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
