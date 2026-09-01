jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * NAVIGATION MUST NEVER TRAP THE OPERATOR.
 *
 * =====================================================================
 * WHY THIS IS A LIVENESS TEST, NOT A ROUTING TEST
 * =====================================================================
 *
 * A busy state that ends is worth nothing if the screen it ends on is
 * blank, or if a blocking overlay outlives the reason it was shown. The
 * reported defect had exactly that second shape: the recovery overlay
 * covered the whole application, and once it stopped being able to end
 * itself there was no route out of it that did not involve reloading the
 * page.
 *
 * So these five journeys - the ones named in the report - are driven
 * through the REAL application root, and after each one the same three
 * questions are asked:
 *
 *   1. Is SOMETHING mounted? (no white screen)
 *   2. Is the blocking overlay gone unless a reboot is genuinely in
 *      flight? (no overlay stranded over Home, no spinner over the root
 *      after recovery ended)
 *   3. Is Home still there to fall back to, and does the workspace exist
 *      only when a verified board is behind it? (no navigation state
 *      without a valid route)
 *
 * The wall itself is covered by hardConnectionWall.test.tsx; what is new
 * here is that every TRANSITION between those states lands somewhere the
 * operator can act.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import App from '../../../App';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  fcRebootRecovery,
  FC_REBOOT_RECOVERY_TIMEOUT_MS,
} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {connectionNotice} from './connectionNotice';

const IDENTIFIED = Object.freeze({
  status: 'SUCCEEDED',
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

/** The coordinator's answers, made mutable so a journey can move. */
const board = {
  sessions: [] as string[],
  ownership: 'INACTIVE' as 'ACTIVE' | 'INACTIVE',
  identification: {status: 'IDLE'} as unknown,
  generation: 1,
};

let listeners: Array<() => void> = [];
let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

/**
 * Everything the coordinator publishes, in one nudge - and then the
 * microtasks that follow it. Mounting the workspace starts real reads
 * (board alignment, among others); letting them settle inside act() is
 * what keeps this test measuring navigation rather than racing it.
 */
async function publish(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...listeners]) listener();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function connectBoard(): Promise<void> {
  board.sessions = ['usb-1'];
  board.ownership = 'ACTIVE';
  board.identification = IDENTIFIED;
  await publish();
}

async function disconnectBoard(): Promise<void> {
  board.sessions = [];
  board.ownership = 'INACTIVE';
  board.identification = {status: 'IDLE'};
  await publish();
}

const has = (testID: string): boolean =>
  (renderer?.root.findAllByProps({testID}).length ?? 0) > 0;

/**
 * Is the application's own answer "there is a verified flight
 * controller"? Read from the same coordinator facts the wall reads, so
 * the assertion below compares the UI against the truth rather than
 * against a hard-coded expectation per test.
 */
function connectionIsVerified(): boolean {
  return (
    board.sessions.length > 0 &&
    board.ownership === 'ACTIVE' &&
    (board.identification as {status: string}).status === 'SUCCEEDED'
  );
}

/**
 * The three questions, asked after every step of every journey. Failing
 * any of them means the operator is looking at something they cannot act
 * on, which is the whole family of defect this round is about.
 *
 * NOTE ON WHAT "MOUNTED" MEANS HERE. This is a native stack: `Start` is
 * the root and stays mounted UNDERNEATH `Setup` when the workspace is
 * pushed. So "both present in the tree" is ordinary navigator behaviour,
 * not a leak - and it is also what guarantees there is always a route to
 * come back to. The wall's real contract is the other direction: the
 * workspace must be absent whenever the connection is not verified,
 * because the route is not registered at all.
 */
function expectNoTrap(where: string): void {
  // 1. Something is on screen. A null root IS the white screen.
  const rendered = renderer?.toJSON();
  expect(`${where}: mounted ${rendered !== null && rendered !== undefined}`).toBe(
    `${where}: mounted true`,
  );

  // 2. The blocking overlay exists exactly while a reboot is in flight,
  //    and not one commit longer.
  const rebootPending = ['EXPECTED', 'WAITING_FOR_LINK', 'RECONNECTING'].includes(
    fcRebootRecovery.getPhase().kind,
  );
  expect(`${where}: overlay ${has('reboot-overlay')}`).toBe(
    `${where}: overlay ${rebootPending}`,
  );

  // 3. Home is always there to fall back to, and the workspace exists if
  //    and only if there is a verified board behind it.
  expect(`${where}: home ${has('start-screen')}`).toBe(`${where}: home true`);
  expect(`${where}: workspace ${has('main-tabs')}`).toBe(
    `${where}: workspace ${connectionIsVerified()}`,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.restoreAllMocks();
  listeners = [];
  board.sessions = [];
  board.ownership = 'INACTIVE';
  board.identification = {status: 'IDLE'};
  connectionNotice.clear();
  fcRebootRecovery.reset();

  const remember = (listener: () => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(entry => entry !== listener);
    };
  };
  jest
    .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'listSessionIds')
    .mockImplementation(() => board.sessions);
  jest
    .spyOn(mspSessionCoordinator, 'getOwnershipState')
    .mockImplementation(() => board.ownership as never);
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() => board.identification as never);
  jest
    .spyOn(mspSessionCoordinator, 'getSessionKey')
    .mockImplementation(sessionId =>
      board.sessions.includes(sessionId)
        ? ({sessionId, generation: board.generation} as never)
        : undefined,
    );
  jest
    .spyOn(mspSessionCoordinator, 'openSession')
    .mockImplementation(() => undefined as never);

  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
});

afterEach(() => {
  if (renderer !== undefined) {
    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
  }
  fcRebootRecovery.reset();
  connectionNotice.clear();
  jest.useRealTimers();
});

describe('no journey through the application ends somewhere unusable', () => {
  it('Home -> connect -> Setup', async () => {
    expectNoTrap('start');
    expect(has('start-screen')).toBe(true);

    await connectBoard();
    expectNoTrap('after connect');
    expect(has('main-tabs')).toBe(true);
  });

  it('Setup -> CLI -> save -> reboot -> Setup', async () => {
    await connectBoard();
    expect(has('main-tabs')).toBe(true);

    // The save. The link drops on purpose and the overlay takes over.
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-1');
    });
    board.sessions = [];
    board.ownership = 'INACTIVE';
    await publish();
    expect(has('reboot-overlay')).toBe(true);
    expectNoTrap('mid-reboot');

    // The board comes back and identifies. The lifecycle is told, the
    // same way useRebootReconnect tells it.
    board.generation = 2;
    board.sessions = ['usb-1'];
    board.ownership = 'ACTIVE';
    board.identification = IDENTIFIED;
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteReconnecting();
      fcRebootRecovery.noteRecovered();
    });
    await publish();

    expectNoTrap('after reboot recovered');
    expect(has('main-tabs')).toBe(true);
    expect(has('reboot-overlay')).toBe(false);
  });

  it('Setup -> CLI -> save -> reboot timeout -> Home', async () => {
    await connectBoard();
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-1');
    });
    board.sessions = [];
    board.ownership = 'INACTIVE';
    board.identification = {status: 'IDLE'};
    await publish();
    expect(has('reboot-overlay')).toBe(true);

    // The board never returns, and nothing is polled or pressed.
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 2_000);
    });
    await publish();

    expectNoTrap('after reboot timeout');
    expect(has('start-screen')).toBe(true);
    // The escape hatch the report asks for: a message and a retry, with
    // no refresh anywhere in the path.
    expect(has('home-reconnect-failed')).toBe(true);
    expect(has('home-reconnect-retry')).toBe(true);
  });

  it('Setup -> disconnect -> Home', async () => {
    await connectBoard();
    expect(has('main-tabs')).toBe(true);

    // An UNEXPECTED loss - no reboot was asked for, so no overlay is
    // correct here and the operator lands on Home with an explanation.
    await disconnectBoard();

    expectNoTrap('after disconnect');
    expect(has('start-screen')).toBe(true);
    expect(has('reboot-overlay')).toBe(false);
  });

  it('Home -> connection timeout -> Home', async () => {
    expect(has('start-screen')).toBe(true);
    // Nothing ever connects. Time passes; Home stays Home and stays
    // usable - no half-mounted workspace, no overlay, no blank root.
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS * 3);
    });
    await publish();

    expectNoTrap('after idle timeout');
    expect(has('start-screen')).toBe(true);
  });

  /**
   * The specific stranding the screenshot showed: the overlay covering
   * the whole application with nothing behind it able to end it. Once
   * the lifecycle is terminal the overlay must be gone in the SAME
   * commit, whatever else is going on.
   */
  it('never leaves the overlay over Home once the lifecycle is terminal', async () => {
    await connectBoard();
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-1');
    });
    await disconnectBoard();
    expect(has('reboot-overlay')).toBe(true);

    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteReopenFailed();
    });
    await publish();

    expect(has('reboot-overlay')).toBe(false);
    expect(has('start-screen')).toBe(true);
    expectNoTrap('after explicit reopen failure');
  });
});

/**
 * WHERE THE EXPLANATION LANDS, not just whether it exists.
 *
 * An escape hatch the operator has to scroll to find is not an escape
 * hatch. Measured in Chromium at 360/390/412/768 with the two primary
 * cards stacked, this message used to sit 74-118 pixels below the fold:
 * a reboot recovery would time out, eject the operator to Home, and Home
 * would look like an ordinary Home. Position is therefore part of the
 * fix, and is pinned here in document order so a future layout change
 * cannot quietly undo it.
 */
describe('the reason the operator was ejected is above the fold', () => {
  /** Depth-first testID order, which is document order for this tree. */
  function testIdOrder(): string[] {
    const order: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const element = node as {props?: Record<string, unknown>; children?: unknown};
      const testId = element.props?.testID ?? element.props?.['data-testid'];
      if (typeof testId === 'string') order.push(testId);
      walk(element.children);
    };
    walk(renderer?.toJSON() as unknown);
    return order;
  }

  it('renders the reconnect-failed message before the primary cards', async () => {
    await connectBoard();
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-1', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-1');
    });
    await disconnectBoard();
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 2_000);
    });
    await publish();

    const order = testIdOrder();
    const message = order.indexOf('home-reconnect-failed');
    const cards = order.indexOf('start-route-group');
    expect(`message=${message >= 0} cards=${cards >= 0}`).toBe(
      'message=true cards=true',
    );
    expect(`message before cards: ${message < cards}`).toBe(
      'message before cards: true',
    );
  });

  it('renders an unexpected session loss before the primary cards too', async () => {
    await connectBoard();
    await disconnectBoard();
    await publish();

    const order = testIdOrder();
    const message = order.indexOf('home-session-lost');
    const cards = order.indexOf('start-route-group');
    expect(`message=${message >= 0}`).toBe('message=true');
    expect(`message before cards: ${message < cards}`).toBe(
      'message before cards: true',
    );
  });
});
