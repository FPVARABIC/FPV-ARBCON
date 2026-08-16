/**
 * The app's entire STACK navigation surface: exactly three routes.
 *
 * 'Start' is the two-choice home. 'Setup' renders the main TAB SHELL
 * (MainTabsScreen) and is now reachable DIRECTLY from Start with NO
 * params: the shell opens in its honest disconnected posture and hosts
 * the real USB connection workspace inside the Setup tab
 * (SetupScreen.tsx), which re-parameterizes this same route in place via
 * navigation.setParams({sessionKey}) once a session is genuinely ACTIVE.
 * 'FirmwareFlasher' is the standalone flashing tool, also entered
 * directly from Start.
 *
 * THE 'Connection' ROUTE IS GONE - deliberately. It was a full-screen
 * stop between Home and the configurator whose only product purpose was
 * producing a sessionKey for navigate('Setup'). The screen component
 * (UsbConnectionScreen.tsx) survives with all of its transport safety
 * intact; it is now hosted INSIDE the Setup tab when no session exists,
 * so connecting is contextual rather than a separate navigation stop.
 * Nothing about USB permission, MSP activation or session ownership
 * changed - only where the surface renders.
 *
 * `Setup`'s params are `... | undefined` on purpose: undefined IS the
 * disconnected configurator, a first-class product state - not a
 * malformed navigation. The session-loss redirect
 * (useSessionLossRedirect.ts) resets to exactly that state when a
 * tracked session dies.
 *
 * Kept as its own module (not colocated with App.tsx) so both App.tsx
 * and any screen that needs to navigate/type its own route props can
 * import it without a circular dependency on App.tsx itself.
 */

import type {SetupUiSessionKey} from '../platforms/react-native/protocol';

export type RootStackParamList = {
  Start: undefined;
  Setup: {sessionKey: SetupUiSessionKey} | undefined;
  FirmwareFlasher: undefined;
};
