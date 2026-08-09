/**
 * THE SESSION-LOSS REDIRECT, as one hook shared by every platform entry.
 *
 * This logic used to live inline in App.tsx, which was correct while
 * Android was the only entry point. It is not correct now: index.web.tsx
 * mounts its own root (App.web.tsx) so the Start screen can stay in the
 * entry chunk while Connection/MainTabs/FirmwareFlasher load lazily, and a
 * second copy of "redirect when the tracked MSP session dies" would be a
 * second copy of a SAFETY rule. A Web build whose redirect drifted from
 * Android's would leave the operator sitting on a Motors or GPS tab whose
 * session is already gone - exactly the state this rule exists to prevent.
 *
 * Nothing here is platform-specific: it is react-navigation state plus the
 * existing useMspOwnershipState() hook. Both entries pass the returned
 * ref/onReady/onStateChange straight to their own NavigationContainer.
 *
 * The comments below are the original App.tsx investigation notes, kept
 * verbatim with the code they describe rather than left behind on a file
 * that no longer contains the logic.
 */

import {useCallback, useEffect, useState} from 'react';
import {useNavigationContainerRef} from '@react-navigation/native';

import {useMspOwnershipState} from '../platforms/react-native/protocol';
import type {RootStackParamList} from './types';

export type SessionLossRedirect = {
  /**
   * Pass 7.1: useNavigationContainerRef() (not the module-level
   * createNavigationContainerRef() react-navigation's own docs show for
   * navigating from OUTSIDE any component - see
   * https://reactnavigation.org/docs/navigating-without-navigation-prop/)
   * - nothing outside the root component ever needs this ref, so it is
   * scoped to that component's own lifecycle via this hook instead of
   * persisting as a singleton across every mount/unmount (relevant for
   * App.test.tsx, which mounts a fresh <App/> per test).
   */
  readonly navigationRef: ReturnType<
    typeof useNavigationContainerRef<RootStackParamList>
  >;
  /** Wire to NavigationContainer's `onReady`. */
  readonly onReady: () => void;
  /** Wire to NavigationContainer's `onStateChange`. */
  readonly onStateChange: () => void;
};

export function useSessionLossRedirect(): SessionLossRedirect {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  // Pass 7.1 - ROOT REDIRECT LISTENER DATA FLOW (reported per task
  // instructions, not left unspecified):
  //
  // trackedSessionId lives here, as plain root-level useState. It is
  // set/cleared from exactly one place: handleNavigationStateChange below,
  // itself only ever invoked by NavigationContainer's own onStateChange
  // prop, which React Navigation fires after EVERY navigation state change
  // (a navigate(), goBack(), or reset() call anywhere in the tree,
  // including UsbConnectionScreen's own navigation.navigate('Setup',
  // {sessionKey}) call in handleConnect()). Deliberately NOT threaded down
  // as a callback prop into UsbConnectionScreen: onStateChange is
  // react-navigation's own supported mechanism for "know the current route
  // from outside the navigator", so this stays correct for ANY future
  // navigation to 'Setup' (or away from it), not just that one call site,
  // without UsbConnectionScreen needing to know this tracking exists at
  // all.
  //
  //  - Landing on 'Setup' (name === 'Setup'): trackedSessionId is set to
  //    that route's own sessionKey.sessionId - always the CURRENT
  //    navigation's own params, never stale.
  //  - Landing back on 'Connection' (via hardware Back, or this listener's
  //    own reset() below): trackedSessionId is cleared. Without this, a
  //    manual Back off 'Setup' (which must NOT deactivate the session -
  //    see SetupScreen/App.test.tsx) would leave a stale tracked id
  //    watched forever; a later, unrelated deactivate from the Connection
  //    screen would then trigger an unnecessary extra reset().
  //
  // trackedOwnershipState below is the existing, reactive
  // useMspOwnershipState() hook (Pass 6.4b), watching whichever sessionId
  // is currently tracked (or '' - reported INACTIVE - when nothing is).
  // The effect below is the actual redirect: the ONLY place that ever
  // calls navigationRef.reset().
  const [trackedSessionId, setTrackedSessionId] = useState<string | null>(null);

  const onStateChange = useCallback(() => {
    const currentRoute = navigationRef.getCurrentRoute();
    if (currentRoute?.name === 'Setup') {
      // Defense-in-depth (mspClient.ts/RNMspTransport.ts precedent): the
      // only call site today (UsbConnectionScreen.tsx) always supplies
      // sessionKey, TypeScript-enforced - but `as` below is a compile-time
      // assertion only, and nothing at runtime guarantees a future
      // linking config or another call site can't reach 'Setup' without
      // it. If params are genuinely absent/malformed, this is not really
      // "on Setup" as far as tracking is concerned - skip silently rather
      // than throw uncaught inside a React-invoked callback.
      const params = currentRoute.params as
        | RootStackParamList['Setup']
        | undefined;
      if (params?.sessionKey) {
        setTrackedSessionId(params.sessionKey.sessionId);
      }
    } else if (
      currentRoute?.name === 'Connection' ||
      currentRoute?.name === 'Start'
    ) {
      setTrackedSessionId(null);
    }
  }, [navigationRef]);

  // Pass 7.1 BUGFIX - NAVIGATION-NOT-READY RACE: investigated whether
  // including navigationRef in the effect's own dependency array (below)
  // is enough, on its own, to force the effect to re-run once
  // navigationRef.isReady() later flips true. It is NOT: navigationRef is
  // the SAME stable object for the root component's entire lifetime
  // (useNavigationContainerRef() never returns a new one), so React's
  // dependency comparison (Object.is) never sees it change - isReady()
  // flipping true internally is not, by itself, a React state change and
  // triggers no re-render/re-run at all. A reactive trigger is required,
  // so this uses NavigationContainer's own onReady prop (fired exactly
  // once, when the navigator's initial state has genuinely resolved) to
  // set real React state - THAT state change is what the effect below
  // depends on and re-runs from.
  const [isNavigationReady, setIsNavigationReady] = useState(false);
  const onReady = useCallback(() => {
    setIsNavigationReady(true);
  }, []);

  const trackedOwnershipState = useMspOwnershipState(trackedSessionId ?? '');

  useEffect(() => {
    if (trackedSessionId === null || trackedOwnershipState !== 'INACTIVE') {
      return;
    }
    if (!isNavigationReady) {
      // Do NOT clear trackedSessionId here - the redirect has not actually
      // happened yet. Leaving it set is what lets this same branch run
      // again (and this time actually redirect) once isNavigationReady
      // itself flips true and re-triggers this effect - clearing it here
      // would permanently block that retry via the guard above, silently
      // dropping the redirect for good.
      return;
    }
    // The tracked session (physically detached, or deactivated some other
    // way) is gone while 'Setup' - or wherever it was navigated to from -
    // still has it in view. Clearing trackedSessionId here (not just
    // resetting the stack) is what stops this effect from firing again on
    // its own next run - see the note above. Safe to call reset()
    // unconditionally now: onReady having already fired is exactly
    // react-navigation's own contract for "the ref is safe to use
    // imperatively" - no separate navigationRef.isReady() check needed
    // (and deliberately not kept as a second, independent source of truth
    // that could disagree with isNavigationReady).
    setTrackedSessionId(null);
    navigationRef.reset({index: 0, routes: [{name: 'Connection'}]});
  }, [
    navigationRef,
    trackedSessionId,
    trackedOwnershipState,
    isNavigationReady,
  ]);

  return {navigationRef, onReady, onStateChange};
}
