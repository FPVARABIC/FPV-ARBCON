/**
 * CLOSE A MOTOR SESSION, OPEN ANOTHER. THROUGH THE REAL SCREEN.
 *
 * REPORTED FROM USE, WITH SCREENSHOTS: after closing a motor session the
 * operator was told
 *
 *   «الجلسة انتهت. افصل كابل USB وأعد توصيله لبدء جلسة جديدة.»
 *
 * with the flight controller still connected. Unplugging a cable to start
 * a second bench session is not a recovery step.
 *
 * WHY THE PREVIOUS ROUND MISSED IT. That round fixed the BINDING - a
 * cleanly spent controller is retired and `beginSession()` builds a fresh
 * one - and tested exactly that in isolation. Both were correct and both
 * passed. Neither could see the defect, because the SCREEN never reaches
 * `beginSession()`. Two gates in MotorsScreen sat in front of it, and
 * each was written against `phase` alone:
 *
 *   - `requiresNewConnection` was true whenever `phase === 'CLOSED'` - and
 *     CLOSED is where a HEALTHY session ends, so the normal terminus was
 *     reported as a broken link;
 *   - the session toggle refused to turn ON unless `phase === 'IDLE'`, and
 *     a controller never returns to IDLE, so the press did nothing at all
 *     and the binding's retirement was never invoked.
 *
 * A layer can be right on its own and still leave the product broken.
 *
 * HOW FAR THIS FILE GETS, stated plainly. It drives the real production
 * path - MainTabsScreen, the real capability registry, the real binding,
 * the real controller - over a fake transport, with only the coordinator's
 * session IDENTITY stubbed (the same seam motorPayloadIndexIdentity.test
 * uses). With that, a session genuinely reaches ACTIVE and the assertions
 * below hold.
 *
 * WHAT IT CANNOT DO: complete a real CLOSE. Teardown requires an
 * acknowledged all-stop, and FakeMspTransport answers no MSP request - it
 * only records writes. Driving a full teardown needs a scripted flight
 * controller that frames real MSP_SET_MOTOR responses, which does not
 * exist in this repository. So the close→reopen half is NOT proven here
 * and is not claimed to be; see the round's report.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * Only the coordinator's identity read is stubbed. The lease, the barrier,
 * the binding, the capability store and the controller are all real -
 * without an identity the controller refuses to start at all and the
 * screen never leaves its blocked state, which would test nothing.
 */
jest.mock('../../platforms/react-native/protocol', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol'),
  mspSessionCoordinator: {
    getMotorTestSessionIdentity: () => ({physicalGeneration: 7, mspEpoch: 0}),
    getIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
        firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
        board: {},
      },
    }),
    subscribeIdentificationState: () => () => {},
    subscribeMotorTestSessionInvalidated: () => () => {},
    getSessionBringUpFailure: () => undefined,
    subscribeSessionBringUpFailure: () => () => {},
  },
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  readMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {MspClient} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';

const SESSION_ID = 'reopen-production-session';
const USB_RECONNECT_MESSAGE =
  'الجلسة انتهت. افصل كابل USB وأعد توصيله لبدء جلسة جديدة.';

let transport: FakeMspTransport;

function openRealCapability(): void {
  transport = new FakeMspTransport();
  const client = new MspClient(transport, SESSION_ID);
  openMotorTestCapability(SESSION_ID, client, createMotorTestTelemetryRegistry());
}

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SESSION_ID, generation: 1}},
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  return {
    renderer,
    press: (testID: string) => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => typeof candidate.props?.onPress === 'function');
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    toggle: (testID: string, next: boolean) => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => typeof candidate.props?.onValueChange === 'function');
      if (node === undefined) throw new Error(`no switch "${testID}"`);
      ReactTestRenderer.act(() => node.props.onValueChange(next));
    },
    text: () =>
      renderer.root
        .findAllByType(Text)
        .map(node => {
          const value = node.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('\n'),
  };
}

async function settle() {
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < 20; round += 1) {
      while (transport.writes.length > 0) {
        transport.resolveNextWrite();
      }
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  });
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const renderer of renderers.splice(0, renderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Already torn down.
      }
    }
  });
  closeMotorTestCapability(SESSION_ID);
});

function snapshot() {
  return readMotorTestCapability(SESSION_ID)?.lifecycleStopPort()?.getSnapshot();
}

async function motorsWithSession() {
  const shell = renderShell();
  renderers.push(shell.renderer);
  ReactTestRenderer.act(() => openRealCapability());
  shell.press('main-tab-MOTORS');
  await settle();
  return shell;
}

describe('a live session does not demand a cable', () => {
  it('opens a real session through the screen toggle', async () => {
    // The precondition for everything else: the production path really
    // does reach an active controller, so a passing assertion below is
    // not passing on a screen that never started.
    const shell = await motorsWithSession();
    shell.toggle('motor-session-toggle', true);
    await settle();

    expect(snapshot()?.phase).toBe('ACTIVE');
  });

  it('shows no USB-reconnect message while the session is healthy', async () => {
    const shell = await motorsWithSession();
    shell.toggle('motor-session-toggle', true);
    await settle();

    expect(shell.text()).not.toContain(USB_RECONNECT_MESSAGE);
  });

  it('keeps the capability and the link open throughout', async () => {
    // Reopening must never depend on tearing the connection down.
    const shell = await motorsWithSession();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();

    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();
    expect(readMotorTestCapability(SESSION_ID)?.isOpen()).toBe(true);
  });

  it('leaves the session toggle present and enabled after a close is requested', async () => {
    const shell = await motorsWithSession();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();

    const toggle = shell.renderer.root
      .findAll(node => node.props?.testID === 'motor-session-toggle')
      .find(node => typeof node.props?.onValueChange === 'function');
    expect(toggle).toBeDefined();
    expect(toggle?.props.disabled).not.toBe(true);
  });
});

/**
 * THE TWO GATES THAT CAUSED THE DEFECT.
 *
 * Asserted on the shipped source rather than through a completed close,
 * because completing one needs a scripted flight controller this repo
 * does not have (see the header). These are structural on purpose: they
 * pin the exact expressions that were wrong, so the regression cannot
 * return unnoticed even though the end-to-end cycle is still unproven.
 */
describe('the screen no longer reads CLOSED as a broken link', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const source = fs
    .readFileSync(path.join(__dirname, 'MotorsScreen.tsx'), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('asks for a new connection only when the close did NOT complete', () => {
    expect(source).toContain(
      "const sessionSpentCleanly =\n    snapshot?.phase === 'CLOSED' && snapshot.teardown?.complete === true",
    );
    expect(source).toContain(
      "(snapshot?.phase === 'CLOSED' && !sessionSpentCleanly)",
    );
    // The bare clause that fired on every healthy close is gone.
    expect(source).not.toMatch(
      /requiresNewConnection =\s*\n\s*snapshot\?\.phase === 'CLOSED' \|\|/,
    );
  });

  it('lets the toggle start a session from a cleanly spent controller', () => {
    expect(source).toContain("phase === 'CLOSED' && port?.getSnapshot().teardown?.complete === true");
    expect(source).toContain("(phase !== 'IDLE' && !spent)");
    // The IDLE-only gate that silently swallowed the press is gone.
    expect(source).not.toContain("port.getSnapshot().phase !== 'IDLE'");
  });

  it('keeps fail-closed for a close that did not complete', () => {
    // Both gates hang off `teardown.complete`, so an unconfirmed teardown
    // still demands a new connection and still refuses to reopen - the
    // case where exclusivity or a spinning motor is unproven.
    expect(source).toContain('teardown?.complete === true');
    expect(source).toContain("blockReasons.includes('REQUIRES_NEW_CONNECTION')");
    expect(source).toContain('requiresNewSession');
  });
});
