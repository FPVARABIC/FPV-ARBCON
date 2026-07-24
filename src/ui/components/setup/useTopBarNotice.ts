/**
 * Pass 7.4, Step 4 - the ONE place persistent per-notice-id activation-
 * time tracking lives, per this pass's own architectural finding:
 * deriveTopBarNotice() (connectionIndicator.ts) is a pure function of
 * only current-moment inputs and structurally cannot know "was this
 * notice already active a moment ago" on its own - something above it
 * must hold that memory across renders. A useRef-backed map here is
 * that "something", mirroring this project's own established precedent
 * for where mutable state legitimately lives above an otherwise-pure
 * derivation (MspTelemetryScheduler is a class holding mutable state
 * that its own pure getValue() reads; here, the equivalent holder is a
 * ref inside the one hook that owns this concern).
 *
 * STATED TRADEOFF: a useRef does NOT survive TopSystemBar unmounting
 * and remounting (unlike SetupUiSessionStore, Pass 7.1's own session-
 * scoped storage, which would survive that). Deliberately NOT used here
 * anyway: the worst case of a remount is a still-active notice's
 * tracked age resetting to "just activated" - it cannot cause a WRONG
 * notice to be picked, and cannot reintroduce flicker WITHIN one mount
 * (which is what the anti-flicker guarantee actually protects against).
 * Setup screen is not expected to remount while displayed. If that
 * assumption changes, moving this into SetupUiSessionStore is a small,
 * well-contained follow-up - not a reason to add that complexity now.
 *
 * SAFE TO MUTATE activationRef.current DURING RENDER, not inside a
 * useEffect - investigated explicitly (not assumed): updateNoticeActivationTimestamps()
 * (connectionIndicator.ts) is proven idempotent under repeated
 * invocation with its own prior output fed back in, which is exactly
 * what happens under React StrictMode's dev-mode double-render (refs
 * are NOT reset between the two invocations). See that function's own
 * doc comment for the full trace. This is the same narrow, React-
 * documented "track a value across renders via a conditional ref write
 * during render, read back in the same pass" pattern used for
 * usePrevious()-style hooks - not the general "side effect during
 * render" React's rules actually warn against (an API call, a
 * subscription - something whose invocation COUNT is externally
 * observable). Using a useEffect instead would be WORSE here: an effect
 * cannot affect the JSX already computed in the same render pass, so a
 * freshly-appearing notice would need a forced second render before its
 * real timestamp took effect, trading a proven-safe direct approach for
 * genuine added complexity with no correctness benefit.
 */

import {useRef} from 'react';

import {deriveTopBarNotice, listTopBarNoticeCandidateIds, updateNoticeActivationTimestamps} from './connectionIndicator';
import type {MspIdentificationState, MspSessionOwnershipState} from '../../../platforms/react-native/protocol';
import type {MspClientState, SetupNotice} from '../../../core';

/**
 * Takes ALREADY-RESOLVED ownership/recovery/identification state, rather
 * than calling useMspOwnershipState()/useMspIdentificationState()/
 * useMspRecoveryState() itself - TopSystemBar.tsx already needs these
 * three for its own rendering (the connection indicator, board name,
 * firmware label) and calls them once; this hook reuses those same
 * values instead of subscribing to the same three axes a second time.
 */
export function useTopBarNotice(
  ownership: MspSessionOwnershipState,
  recovery: MspClientState | undefined,
  identification: MspIdentificationState,
): SetupNotice | undefined {
  const activationRef = useRef<Map<string, number>>(new Map());

  const candidateIds = listTopBarNoticeCandidateIds(ownership, recovery, identification);
  activationRef.current = updateNoticeActivationTimestamps(activationRef.current, candidateIds, Date.now());

  return deriveTopBarNotice(ownership, recovery, identification, activationRef.current);
}
