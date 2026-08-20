/**
 * THE GATE'S DECISION, one assertion per way it can be wrong.
 *
 * The screen-level behaviour (what the operator sees, and that the
 * gated screen is not mounted at all) is pinned in
 * connectionGating.test.tsx. This file pins the decision itself, which
 * is pure: three facts in, one verdict out.
 */

import {
  FC_DEPENDENT_TABS,
  resolveFlightControllerGate,
  tabRequiresFlightController,
  type FlightControllerGateInputs,
} from './flightControllerGate';

const KEY = {sessionId: 'usb-1', generation: 4};
const IDENTIFIED = {
  status: 'SUCCEEDED' as const,
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

function inputs(
  over: Partial<FlightControllerGateInputs> = {},
): FlightControllerGateInputs {
  return {
    sessionKey: KEY,
    ownership: 'ACTIVE',
    currentSessionKey: KEY,
    identification: IDENTIFIED as never,
    ...over,
  };
}

describe('a screen is only usable over a live, current, identified board', () => {
  it('passes when all three facts agree', () => {
    expect(resolveFlightControllerGate(inputs())).toEqual({
      kind: 'READY',
      sessionKey: KEY,
    });
  });

  it('refuses with no session key at all', () => {
    expect(resolveFlightControllerGate(inputs({sessionKey: undefined}))).toEqual(
      {kind: 'NO_SESSION'},
    );
  });

  it.each(['INACTIVE', 'ACTIVATING', 'CLOSING'] as const)(
    'refuses while ownership is %s - only ACTIVE is usable',
    ownership => {
      expect(resolveFlightControllerGate(inputs({ownership})).kind).toBe(
        'STALE_SESSION',
      );
    },
  );

  /**
   * THE STALE-KEY CASE, and the reason the coordinator is consulted at
   * all. A navigation parameter outlives the session it names: browser
   * back/forward, a restored navigation state, and a reboot that minted
   * a new generation all leave a screen holding a key that WAS true.
   */
  it('refuses a key from an older generation of the same session', () => {
    expect(
      resolveFlightControllerGate(
        inputs({currentSessionKey: {sessionId: 'usb-1', generation: 5}}),
      ).kind,
    ).toBe('STALE_SESSION');
  });

  it('refuses a key naming a different session id', () => {
    expect(
      resolveFlightControllerGate(
        inputs({currentSessionKey: {sessionId: 'usb-2', generation: 4}}),
      ).kind,
    ).toBe('STALE_SESSION');
  });

  it('refuses when the coordinator has no session under that id', () => {
    expect(
      resolveFlightControllerGate(inputs({currentSessionKey: undefined})).kind,
    ).toBe('STALE_SESSION');
  });

  it.each([{status: 'IDLE'}, {status: 'RUNNING'}] as const)(
    'holds the screen closed while identification is %p',
    identification => {
      expect(
        resolveFlightControllerGate(inputs({identification})).kind,
      ).toBe('IDENTIFYING');
    },
  );

  /** A board we could not read is not one we are still reading. */
  it('treats a FAILED identification as stale, not as identifying', () => {
    expect(
      resolveFlightControllerGate(
        inputs({identification: {status: 'FAILED', error: new Error('no')}}),
      ).kind,
    ).toBe('STALE_SESSION');
  });

  it('never reports READY for any single missing fact', () => {
    const broken: Array<Partial<FlightControllerGateInputs>> = [
      {sessionKey: undefined},
      {ownership: 'INACTIVE'},
      {currentSessionKey: undefined},
      {identification: {status: 'IDLE'}},
    ];
    for (const over of broken) {
      expect(resolveFlightControllerGate(inputs(over)).kind).not.toBe('READY');
    }
  });
});

describe('which tabs the gate covers', () => {
  it.each([
    'MOTORS',
    'PID',
    'PORTS',
    'RECEIVER',
    'GPS',
    'MODES',
    'FAILSAFE',
    'POWER',
    'OSD',
    'VTX',
    'SENSORS',
    'PRESETS',
    'CLI',
    'CONFIGURATIONS',
  ])('%s needs a flight controller', tab => {
    expect(tabRequiresFlightController(tab)).toBe(true);
  });

  /**
   * SETUP MUST NEVER BE GATED. It hosts the USB connection workspace, so
   * gating it would remove the only route to a session and turn the
   * gate's own "connect" button into a loop.
   */
  it('SETUP is NOT gated, because it is where connecting happens', () => {
    expect(tabRequiresFlightController('SETUP')).toBe(false);
    expect(FC_DEPENDENT_TABS).not.toContain('SETUP');
  });

  it('covers fourteen tabs and names each one once', () => {
    expect(FC_DEPENDENT_TABS.length).toBe(14);
    expect(new Set(FC_DEPENDENT_TABS).size).toBe(14);
  });
});
