/**
 * PRESENTS A CONNECTED FLIGHT CONTROLLER TO THE CONNECTION GATE.
 *
 * MainTabsScreen refuses to mount a configuration screen unless the
 * coordinator reports a live, current, identified session - that is the
 * whole point of ui/session/flightControllerGate.ts, and it means a test
 * that renders the shell over an invented sessionKey now correctly gets
 * no panels at all.
 *
 * Files whose subject IS the gate assert that directly. Files whose
 * subject is something else - a tab bar, a Motors lifecycle, a payload
 * identity - call this so the shell is in the state an operator would
 * actually be looking at. The REAL gate logic still runs over these
 * values; only the hardware underneath is faked.
 *
 * USES jest.spyOn, NOT jest.mock, so it can live in a shared helper:
 * module mocks are hoisted per file and cannot be installed from a
 * function call.
 *
 * Call it INSIDE beforeEach, and after any jest.restoreAllMocks() in
 * that same hook - otherwise the restore tears these off again and every
 * test after the first sees a disconnected board.
 */

import {mspSessionCoordinator} from '../../../platforms/react-native/protocol';
import * as sessionState from '../../../platforms/react-native/protocol/useMspSessionState';

/** One frozen object, returned by reference: a fresh identification
 *  snapshot per call would re-render every useSyncExternalStore consumer
 *  and defeat the tab panels' memoisation. The real hook caches it for
 *  exactly this reason. */
const IDENTIFIED = Object.freeze({
  status: 'SUCCEEDED' as const,
  identity: Object.freeze({
    firmware: Object.freeze({identifier: 'BTFL', knownFamily: 'BETAFLIGHT'}),
    apiVersion: Object.freeze({
      mspProtocolVersion: 0,
      apiVersionMajor: 1,
      apiVersionMinor: 47,
    }),
    board: Object.freeze({}),
  }),
});

export function presentConnectedBoard(
  sessionId: string,
  generation = 1,
): void {
  jest
    .spyOn(sessionState, 'useMspOwnershipState')
    .mockImplementation(() => 'ACTIVE');
  jest
    .spyOn(sessionState, 'useMspIdentificationState')
    .mockImplementation(() => IDENTIFIED as never);
  /*
   * SOME CALLERS ALREADY MOCK THE COORDINATOR WHOLESALE, and an automock
   * has no getSessionKey to spy on - jest.spyOn throws "Property does not
   * exist in the provided object" rather than quietly doing nothing.
   * Defining it is the right answer there: the gate asks the coordinator
   * this question either way, and the test's own mock simply had no
   * answer for it yet.
   */
  const answer = (id: string) =>
    id === sessionId ? {sessionId, generation} : undefined;
  const coordinator = mspSessionCoordinator as unknown as Record<
    string,
    unknown
  >;
  if (typeof coordinator.getSessionKey === 'function') {
    jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockImplementation(answer);
  } else {
    coordinator.getSessionKey = jest.fn(answer);
  }
  /* The gate SUBSCRIBES as well as reads - useSyncExternalStore needs a
     subscribe that returns an unsubscribe. An automocked coordinator has
     neither, and a missing one throws at render rather than at setup. */
  if (typeof coordinator.subscribeOwnershipState !== 'function') {
    coordinator.subscribeOwnershipState = jest.fn(() => () => undefined);
  }
}
