/**
 * THE SESSION-LOSS REDIRECT, as one hook shared by every platform entry.
 *
 * This logic used to live inline in App.tsx, which was correct while
 * Android was the only entry point. It is not correct now: index.web.tsx
 * mounts its own root (App.web.tsx) so the Start screen can stay in the
 * entry chunk while MainTabs/FirmwareFlasher load lazily, and a
 * second copy of "redirect when the tracked MSP session dies" would be a
 * second copy of a SAFETY rule. A Web build whose redirect drifted from
 * Android's would leave the operator sitting on a Motors or GPS tab whose
 * session is already gone - exactly the state this rule exists to prevent.
 *
 * WHERE THE REDIRECT LANDS - changed with the entry-flow cleanup. The
 * standalone 'Connection' route is gone; the connection workspace now
 * lives INSIDE the Setup tab whenever the 'Setup' route has no
 * sessionKey params (see SetupScreen.tsx). So a dead tracked session
 * resets the stack to Start -> Setup-with-no-params: the operator stays
 * in the configurator, sees its honest disconnected posture with the
 * real connection workspace, and hardware Back still leads Home. The
 * SAFETY property is unchanged - no screen is ever left holding a
 * sessionKey whose MSP ownership is INACTIVE, because the reset remounts
 * the whole shell without one.
 *
 * Nothing here is platform-specific: it is react-navigation state plus the
 * existing useMspOwnershipState() hook. Both entries pass the returned
 * ref/onReady/onStateChange straight to their own NavigationContainer.
 *
 * The comments below are the original App.tsx investigation notes, kept
 * with the code they describe rather than left behind on a file that no
 * longer contains the logic, updated only where the 'Connection' route
 * they referenced no longer exists.
 */

import {useCallback, useEffect, useState} from 'react';
import {useNavigationContainerRef} from '@react-navigation/native';

import {useMspOwnershipState} from '../platforms/react-native/protocol';
import {fcRebootRecovery} from '../platforms/react-native/protocol/fcRebootRecovery';
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
  // (a navigate(), goBack(), reset() or setParams() call anywhere in the
  // tree - including SetupScreen's own navigation.setParams({sessionKey})
  // the moment the embedded connection workspace establishes a session).
  // Deliberately NOT threaded down as a callback prop into that
  // workspace: onStateChange is react-navigation's own supported
  // mechanism for "know the current route from outside the navigator",
  // so this stays correct for ANY way 'Setup' gains or loses a
  // sessionKey, not just today's one call site.
  //
  //  - 'Setup' WITH sessionKey params: trackedSessionId is set to that
  //    route's own sessionKey.sessionId - always the CURRENT
  //    navigation's own params, never stale.
  //  - 'Setup' WITHOUT params (the disconnected configurator - a
  //    first-class state now, see navigation/types.ts) and 'Start':
  //    trackedSessionId is cleared. Without this, a manual Back off a
  //    connected 'Setup' (which must NOT deactivate the session - see
  //    App.test.tsx) would leave a stale tracked id watched forever; a
  //    later, unrelated deactivate would then trigger an unnecessary
  //    extra reset().
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
      // params type is `... | undefined` and the runtime shape is not
      // guaranteed by the compile-time assertion below, so both branches
      // handle absence gracefully rather than throw uncaught inside a
      // React-invoked callback.
      const params = currentRoute.params as
        | RootStackParamList['Setup']
        | undefined;
      // The same truth check the connect workspace applies: a key with no
      // sessionId names no session, so tracking it would watch the
      // ownership of `undefined` - reported INACTIVE - and fire the
      // redirect below against a session that never existed.
      if (
        typeof params?.sessionKey?.sessionId === 'string' &&
        params.sessionKey.sessionId.length > 0
      ) {
        setTrackedSessionId(params.sessionKey.sessionId);
      } else {
        // The disconnected configurator: nothing to watch. Clearing here
        // (not just on 'Start') matters because the redirect below lands
        // exactly on this state - a stale id surviving that landing
        // would re-fire the reset on the next unrelated INACTIVE report.
        setTrackedSessionId(null);
      }
    } else if (currentRoute?.name === 'Start') {
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

  // THE LOSS IS RECORDED SEPARATELY FROM THE SESSION IT CAME FROM, and
  // that separation is the whole fix for the race this pass re-opened.
  //
  // The original Pass 7.1 bug was "the redirect cleared trackedSessionId
  // before checking readiness, so its own re-entry guard blocked the
  // retry". Keeping the id set instead was enough while 'Setup' stayed
  // registered no matter what. It is NOT enough now: the hard connection
  // wall (App.tsx) unregisters the whole configuration workspace the
  // instant the board goes, react-navigation drops that route from its
  // state, and onStateChange above sees 'Start' and clears
  // trackedSessionId - wiping the pending redirect a second way, before
  // onReady ever fires.
  //
  // So a detected loss becomes its own piece of state. Nothing that
  // happens to the navigation state afterwards can erase it; it survives
  // until the navigator is actually drivable and the reset has run.
  const [pendingReturn, setPendingReturn] = useState<{
    readonly expected: boolean;
  } | null>(null);

  const trackedOwnershipState = useMspOwnershipState(trackedSessionId ?? '');

  useEffect(() => {
    if (trackedSessionId === null || trackedOwnershipState !== 'INACTIVE') {
      return;
    }
    // The tracked session (physically detached, or deactivated some other
    // way) is gone while 'Setup' - or wherever it was navigated to from -
    // still has it in view. Recorded here, at the moment it happens,
    // whether or not the navigator can be driven yet.
    //
    // WAS THIS LOSS OURS?
    //
    // A session can end for two completely different reasons and the
    // right response is not the same for both:
    //
    //   the cable came out, the board browned out, the link desynced
    //       -> a FAULT. Land the operator on the connection workspace
    //          and let them decide. Reaching for the hardware here is
    //          how a reconnect loop starts: reopen the port, the link
    //          dies again, this reset runs again, forever.
    //
    //   WE asked the board to reboot - a CLI `save`
    //       -> NOT a fault. The application caused it, knows which board
    //          is coming back, and told the operator it would happen.
    //          Making them press Connect after pressing Save is the
    //          defect this branch exists to close: it is what left
    //          Motors, PID, Ports and every other screen holding a
    //          session id that no longer named anything.
    //
    // The expectation is ONE-SHOT and deadline-bounded (see
    // fcRebootRecovery.ts), so the loop the comment above warns about
    // still cannot happen: the second loss in a row is never expected.
    // It is answered HERE rather than at reset() time because the
    // deadline runs from the loss, not from whenever navigation happens
    // to become ready.
    const expected = fcRebootRecovery.noteSessionLost(trackedSessionId);
    // Clearing the id is what stops this effect from firing again on its
    // own next run. Safe now: the loss it detected is already recorded
    // in pendingReturn, which the guard below - not this id - drives.
    setTrackedSessionId(null);
    setPendingReturn({expected});
  }, [trackedSessionId, trackedOwnershipState]);

  useEffect(() => {
    if (pendingReturn === null || !isNavigationReady) {
      // Not ready yet: hold the pending return exactly as it is. This is
      // the branch the Pass 7.1 bugfix exists for - it must leave the
      // record intact so that isNavigationReady flipping true re-runs
      // this effect and completes the redirect, instead of silently
      // dropping it for good.
      return;
    }
    // Safe to call reset() unconditionally: onReady having already fired
    // is exactly react-navigation's own contract for "the ref is safe to
    // use imperatively" - no separate navigationRef.isReady() check
    // needed (and deliberately not kept as a second, independent source
    // of truth that could disagree with isNavigationReady).
    //
    // Two routes, index 1: the operator lands on the connection
    // workspace with Start underneath, so hardware Back still leads Home
    // instead of exiting the app. Resetting to a bare [Connect] would
    // have made Back an app exit; resetting to [Start] alone would have
    // thrown the operator out of the tool they were using.
    setPendingReturn(null);
    navigationRef.reset({
      index: 1,
      routes: [
        {name: 'Start'},
        // `afterSessionLoss` records that the operator was RETURNED here
        // rather than arriving by choice, and suppresses auto-connect.
        // An expected reboot omits it precisely so the workspace does
        // reconnect on its own.
        // 'Connect' rather than 'Setup': losing the board removes the
        // configuration workspace from the navigator entirely (App.tsx),
        // so there is no Setup route left to return to. The operator
        // lands on the connection workspace, not on Motors with a
        // disconnected message.
        {
          name: 'Connect',
          params: pendingReturn.expected ? {} : {afterSessionLoss: true},
        },
      ],
    });
  }, [navigationRef, pendingReturn, isNavigationReady]);

  return {navigationRef, onReady, onStateChange};
}
