/**
 * WHAT COUNTS AS "THERE IS A FLIGHT CONTROLLER", exhaustively.
 *
 * The application's whole shape hangs off this verdict - App.tsx
 * registers the configuration workspace in the navigator only while it
 * says CONNECTED - so every way it can be wrong is asserted here, on the
 * pure resolver, rather than inferred from a rendered tree.
 */

import {
  configurationWorkspaceUnlocked,
  resolveVerifiedConnection,
  type CandidateSession,
} from './verifiedConnection';

const KEY = {sessionId: 'usb-1', generation: 3};
const SUCCEEDED = {
  status: 'SUCCEEDED' as const,
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

function session(over: Partial<CandidateSession> = {}): CandidateSession {
  return {
    sessionId: 'usb-1',
    ownership: 'ACTIVE',
    sessionKey: KEY,
    identification: SUCCEEDED as never,
    ...over,
  };
}

const resolve = (
  sessions: readonly CandidateSession[],
  rebootInFlight = false,
) => resolveVerifiedConnection({sessions, rebootInFlight});

describe('the workspace unlocks on four facts and nothing less', () => {
  it('unlocks on a live, keyed, identified session', () => {
    expect(resolve([session()])).toEqual({kind: 'CONNECTED', sessionKey: KEY});
    expect(configurationWorkspaceUnlocked(resolve([session()]))).toBe(true);
  });

  it('stays locked with no sessions at all', () => {
    expect(resolve([])).toEqual({kind: 'DISCONNECTED'});
    expect(configurationWorkspaceUnlocked(resolve([]))).toBe(false);
  });

  it.each(['INACTIVE', 'ACTIVATING', 'CLOSING'] as const)(
    'stays locked while ownership is %s',
    ownership => {
      expect(resolve([session({ownership})]).kind).toBe('DISCONNECTED');
    },
  );

  it('stays locked when the coordinator has no key for the session', () => {
    expect(resolve([session({sessionKey: undefined})]).kind).toBe(
      'DISCONNECTED',
    );
  });

  /**
   * PRESSING CONNECT IS NOT CONNECTING. A link can be open and owned
   * while the board has not said what it is - and a configuration
   * screen has nothing honest to render for a board it cannot name.
   */
  it.each([{status: 'IDLE'}, {status: 'RUNNING'}] as const)(
    'reports IDENTIFYING, not CONNECTED, while identification is %p',
    identification => {
      const verdict = resolve([session({identification})]);
      expect(verdict.kind).toBe('IDENTIFYING');
      expect(configurationWorkspaceUnlocked(verdict)).toBe(false);
    },
  );

  /** A board that was read and could not be understood is a connection
   *  problem, and belongs in the connection workspace - not in a
   *  "still working on it" state that never ends. */
  it('treats a FAILED identification as disconnected', () => {
    expect(
      resolve([
        session({identification: {status: 'FAILED', error: new Error('x')}}),
      ]).kind,
    ).toBe('DISCONNECTED');
  });

  it('ignores a dead session and unlocks on a live one beside it', () => {
    const dead = session({sessionId: 'old', ownership: 'INACTIVE'});
    expect(resolve([dead, session()])).toEqual({
      kind: 'CONNECTED',
      sessionKey: KEY,
    });
  });

  it('reports the key of the session that actually qualified', () => {
    const other = {sessionId: 'usb-2', generation: 9};
    const verdict = resolve([
      session({sessionId: 'usb-1', ownership: 'CLOSING'}),
      session({sessionId: 'usb-2', sessionKey: other}),
    ]);
    expect(verdict).toEqual({kind: 'CONNECTED', sessionKey: other});
  });
});

describe('a reboot we asked for is not a disconnection', () => {
  it('reports REBOOTING while the recovery lifecycle is running', () => {
    const verdict = resolve([], true);
    expect(verdict.kind).toBe('REBOOTING');
    expect(configurationWorkspaceUnlocked(verdict)).toBe(false);
  });

  it('outranks IDENTIFYING - the operator is told why, not just that', () => {
    expect(resolve([session({identification: {status: 'IDLE'}})], true).kind).toBe(
      'REBOOTING',
    );
  });

  /**
   * AND IT NEVER OUTRANKS A WORKING BOARD. Once the reconnect has
   * succeeded and the new session is identified, the workspace opens
   * even if the recovery lifecycle has not been marked finished yet.
   */
  it('never holds the workspace shut over a session that is already up', () => {
    expect(resolve([session()], true)).toEqual({
      kind: 'CONNECTED',
      sessionKey: KEY,
    });
  });
});
