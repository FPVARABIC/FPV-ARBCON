import {useEffect} from 'react';
import type {NavigationContainerRef} from '@react-navigation/native';

import type {RootStackParamList} from './types';

/**
 * BROWSER BACK, MADE REAL.
 *
 * The navigator ran with no `linking` configuration, so React Navigation
 * never touched the History API: pressing the browser's Back button did
 * nothing at all, and an operator who opened the flight-controller
 * workspace had no way out except reloading the page. That is a
 * navigation trap, and it is the browser's most-used control.
 *
 * WHY NOT `linking`. Path-based linking would put real URLs like
 * `/setup` in the address bar, and this app is deployed under a project
 * base path on static hosting with no SPA rewrite - reloading such a URL
 * would 404. So instead of inventing addressable routes, this keeps the
 * URL exactly as it is and mirrors the navigation stack's DEPTH into
 * history entries:
 *
 *   going deeper  -> push one entry (same URL)
 *   browser Back  -> pop the navigator instead, and immediately restore
 *                    the entry, so there is always one left to consume
 *
 * The result is that Back and the in-app back control do the same thing.
 * At the root the listener stands aside, so leaving the page is still
 * the browser's own correct behaviour.
 */
export function useBrowserBackIntegration(
  navigationRef: React.RefObject<NavigationContainerRef<RootStackParamList> | null>,
): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.history === 'undefined') {
      return;
    }

    let depth = 0;

    const onPopState = () => {
      const navigation = navigationRef.current;
      if (navigation?.canGoBack() === true) {
        // Consume this Back inside the app, and put an entry back so the
        // next Back has something to consume too.
        navigation.goBack();
        window.history.pushState(null, '', window.location.href);
      }
    };

    const onState = () => {
      const navigation = navigationRef.current;
      const nextDepth = navigation?.getRootState()?.index ?? 0;
      // Only a genuinely DEEPER stack adds an entry: a session handoff
      // uses setParams, which must not grow the browser's history.
      if (nextDepth > depth) {
        window.history.pushState(null, '', window.location.href);
      }
      depth = nextDepth;
    };

    window.addEventListener('popstate', onPopState);
    const unsubscribe = navigationRef.current?.addListener('state', onState);
    // Seed from wherever the navigator already is.
    depth = navigationRef.current?.getRootState()?.index ?? 0;

    return () => {
      window.removeEventListener('popstate', onPopState);
      unsubscribe?.();
    };
  }, [navigationRef]);
}
