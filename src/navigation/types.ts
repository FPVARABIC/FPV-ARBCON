/**
 * The app's entire STACK navigation surface: five routes.
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
 * 'FlightStyleGuide' is the directory of flight styles, and
 * 'FlightStyleCorner' is ONE style's own guide. They are two routes
 * rather than one screen with a mode, because they answer different
 * questions - "which of these am I flying?" and "how do I set this one
 * up?" - and because the corner must be addressable on its own. The
 * corner takes the style id as a parameter and renders that style ALONE:
 * a page that pooled two styles' numbers would be dangerous, not untidy,
 * since the same field takes opposite correct values on a 1S whoop and a
 * 6S racer.
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
  /**
   * `afterSessionLoss` says WHY the operator is on the disconnected
   * configurator, and it exists because the two arrivals mean opposite
   * things.
   *
   * Pressing "فتح إعدادات متحكم الطيران" IS a request to connect, so the
   * workspace opens an unambiguous board by itself. Being RETURNED here
   * by the session-loss redirect is the opposite: the link just died.
   * Auto-connecting on that arrival reopens the port, the dead session
   * ends again, the redirect fires again - an unbounded reconnect loop
   * that hammers the port and, on Android, re-raises the permission
   * dialog every cycle. Only the redirect sets this flag.
   */
  Setup:
    | {sessionKey?: SetupUiSessionKey; afterSessionLoss?: true}
    | undefined;
  FirmwareFlasher: undefined;
  FlightStyleGuide: undefined;
  /**
   * `styleId` is a plain string rather than the generated union so a
   * stale deep link cannot fail to typecheck; the screen resolves it and
   * says plainly when there is no such corner.
   */
  FlightStyleCorner: {styleId: string};
};
