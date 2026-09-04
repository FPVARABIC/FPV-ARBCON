/**
 * EVERY SCREEN THAT WAITS FOR SOMETHING, AND WHAT IT DOES WHILE WAITING.
 *
 * =====================================================================
 * WHAT THIS ADDS TO `asyncBusySettles`
 * =====================================================================
 *
 * `asyncBusySettles` proves seven named screens leave their busy state
 * through four endings. It is the right oracle and the wrong
 * denominator: this application has twenty screens, and the thirteen it
 * does not name were never classified at all. "Thirteen screens have no
 * coverage" and "thirteen screens have nothing to cover" are completely
 * different statements, and nobody had established which one was true.
 *
 * So this closes the denominator first and the coverage second:
 *
 *   1. CLASSIFY ALL TWENTY, by measurement rather than by assertion.
 *      A screen HAS async user state if holding its controller's answers
 *      open makes the rendered tree different from the settled one. A
 *      screen that renders identically either way has nothing an
 *      operator could get stuck in - and that is recorded as a finding
 *      about the screen, with what was tried, not as a gap.
 *
 *   2. DRIVE EVERY ONE THAT DOES, through the six endings an operation
 *      can have. Not four: `asyncBusySettles` covers success, failure,
 *      rejection and unmount. Two more matter and were never exercised
 *      anywhere - an answer that NEVER comes, and an answer that arrives
 *      after the operator has already swapped aircraft.
 *
 * =====================================================================
 * THE FOUR THINGS THAT MUST NOT HAPPEN
 * =====================================================================
 *
 *   NO STUCK LOADING          an operation that ends must visibly end.
 *   NO PERMANENT BUSY UI      the controls must come back.
 *   NO LATE WORK AFTER UNMOUNT a promise that lands on a screen that is
 *                             gone must not try to update it.
 *   NO CROSS-SESSION WRITE-BACK a result from aircraft A must not land
 *                             in the UI showing aircraft B.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(600000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * HOLDING AN ANSWER OPEN
 * ==================================================================== */

type Ending = 'SUCCESS' | 'FAILURE' | 'THROW' | 'NEVER' | 'UNMOUNT' | 'SESSION_REPLACED';

const ENDINGS: readonly Ending[] = [
  'SUCCESS',
  'FAILURE',
  'THROW',
  'NEVER',
  'UNMOUNT',
  'SESSION_REPLACED',
];

/** Async method names a configuration controller can expose. */
const ASYNC_METHOD = /^(load|save|refresh|read|erase|export|import|calibrate|start|stop|apply|verify|reboot|flash|download)/i;

interface Held {
  /**
   * Lets held calls answer. `only` answers just the N OLDEST - which is
   * what "the previous aircraft's reply arrives late" means. Releasing
   * everything instead would also answer the load the screen issued FOR
   * THE NEW session, and the tree would change for an entirely correct
   * reason; the first version of this suite did exactly that and
   * reported fifteen screens as cross-session leaks that were nothing of
   * the kind.
   */
  release: (ending: Ending, only?: number) => void;
  /** How many calls are outstanding right now. */
  outstanding: () => number;
  /** How many calls were made at all. */
  calls: () => string[];
}

/**
 * Wraps a controller so that every async method it exposes can be held
 * open, then answered - or never answered at all.
 *
 * The real answers are captured FIRST, from the real controller, so that
 * `SUCCESS` releases exactly what the screen would have received. A
 * hand-built success payload here would be this suite deciding what the
 * board said.
 */
function holdable(controller: any): {proxy: any; held: Held} {
  const pending: {resolve: (value: unknown) => void; reject: (error: unknown) => void; real: Promise<unknown>}[] = [];
  const calls: string[] = [];
  const proxy = new Proxy(controller, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof value !== 'function' ||
        typeof property !== 'string' ||
        !ASYNC_METHOD.test(property)
      ) {
        return value;
      }
      return (...args: unknown[]) => {
        calls.push(property);
        const real = Promise.resolve(value.apply(target, args)).catch(
          error => ({__threw: error}),
        );
        return new Promise((resolve, reject) => {
          pending.push({resolve, reject, real});
        });
      };
    },
  });
  const held: Held = {
    outstanding: () => pending.length,
    calls: () => [...calls],
    release: (ending: Ending, only?: number) => {
      const waiting = pending.splice(0, only ?? pending.length);
      for (const entry of waiting) {
        if (ending === 'NEVER') {
          pending.push(entry);
          continue;
        }
        if (ending === 'THROW') {
          entry.reject(new Error('the link went away mid-operation'));
          continue;
        }
        if (ending === 'FAILURE') {
          entry.resolve({kind: 'FAILED', error: new Error('link lost')});
          continue;
        }
        entry.real
          .then(value => {
          entry.resolve(
            value !== null && typeof value === 'object' && '__threw' in (value as object)
              ? {kind: 'FAILED', error: (value as {__threw: unknown}).__threw}
              : value,
          );
        });
      }
    },
  };
  return {proxy, held};
}

/**
 * Every prop of this element that behaves like an asynchronous port: an
 * object carrying at least one method whose name is an operation.
 */
function asyncPortsOf(element: React.ReactElement): string[] {
  const props = (element.props ?? {}) as Record<string, unknown>;
  const ports: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (value === null || typeof value !== 'object') continue;
    const methods = [
      ...Object.keys(value as object),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(value) ?? {}),
    ];
    if (
      methods.some(
        method =>
          ASYNC_METHOD.test(method) &&
          typeof (value as Record<string, unknown>)[method] === 'function',
      )
    ) {
      ports.push(name);
    }
  }
  return ports;
}

function snapshotOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

/** Every control the screen currently refuses. */
function disabledCount(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.findAll(
    node =>
      (node.props as any)?.disabled === true &&
      (typeof (node.props as any)?.onPress === 'function' ||
        typeof (node.props as any)?.onValueChange === 'function'),
    {deep: true},
  ).length;
}

function interactiveCount(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.findAll(
    node =>
      typeof (node.props as any)?.onPress === 'function' ||
      typeof (node.props as any)?.onValueChange === 'function',
    {deep: true},
  ).length;
}

async function flush(rounds = 12): Promise<void> {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
  });
}

interface Result {
  readonly screen: string;
  readonly classification: 'HAS_ASYNC_USER_STATE' | 'NO_ASYNC_USER_STATE';
  readonly why: string;
  readonly endings: Partial<Record<Ending, string>>;
  readonly operations: string[];
}

const RESULTS: Result[] = [];
const LATE_WORK: string[] = [];

describe('every screen is classified, and every async screen is driven', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const endings: Partial<Record<Ending, string>> = {};
      let classification: Result['classification'] = 'NO_ASYNC_USER_STATE';
      let why = '';
      let operations: string[] = [];

      for (const ending of ENDINGS) {
        const record = recorder();
        const element = await screen.mount(record);
        /* NOT JUST `controller`. Motors takes its board access as
           `airframeConfigPort`, Presets as `repository`, CLI as `cli` -
           and an oracle that looked only for a prop literally named
           `controller` reported all three as having no asynchronous work
           at all, which is false. Every prop that carries async methods
           is held. */
        const ports = asyncPortsOf(element);
        if (ports.length === 0) {
          why =
            'no prop on this screen carries an asynchronous method: it' +
            ' takes only navigation and route, so there is no operation' +
            ' an operator could be left waiting on';
          endings[ending] = 'NO_ASYNC_PORT';
          continue;
        }
        const wrapped: Record<string, unknown> = {};
        const holds: Held[] = [];
        for (const port of ports) {
          const {proxy, held: one} = holdable((element.props as any)[port]);
          wrapped[port] = proxy;
          holds.push(one);
        }
        const held: Held = {
          outstanding: () =>
            holds.reduce((sum, one) => sum + one.outstanding(), 0),
          calls: () => holds.flatMap(one => one.calls()),
          release: (kind: Ending, only?: number) => {
            let budget = only;
            for (const one of holds) {
              if (budget === undefined) {
                one.release(kind);
                continue;
              }
              const take = Math.min(budget, one.outstanding());
              if (take > 0) one.release(kind, take);
              budget -= take;
            }
          },
        };
        let tree!: ReactTestRenderer.ReactTestRenderer;
        await act(async () => {
          tree = ReactTestRenderer.create(
            React.cloneElement(element, wrapped as any),
          );
        });
        await flush(4);

        /* WHILE THE ANSWER IS HELD. */
        const working = snapshotOf(tree);
        operations = held.calls();

        if (ending === 'UNMOUNT') {
          /* THE SCREEN GOES AWAY WITH THE ANSWER STILL IN FLIGHT. */
          const errors: string[] = [];
          const spy = jest
            .spyOn(console, 'error')
            .mockImplementation((...args: unknown[]) => {
              errors.push(String(args[0] ?? ''));
            });
          await act(async () => tree.unmount());
          held.release('SUCCESS');
          await act(async () => {
            for (let round = 0; round < 12; round += 1) await Promise.resolve();
          });
          spy.mockRestore();
          const late = errors.filter(line =>
            /unmounted|not wrapped in act|memory leak/i.test(line),
          );
          if (late.length > 0) LATE_WORK.push(`${name}: ${late[0].slice(0, 120)}`);
          endings[ending] = late.length === 0 ? 'NO_LATE_WORK' : 'LATE_WORK';
          continue;
        }

        if (ending === 'SESSION_REPLACED') {
          /* THE OPERATOR SWAPS AIRCRAFT WHILE THE ANSWER IS IN FLIGHT.
             The screen is re-rendered under a new session key, and only
             THEN does the old aircraft's answer arrive. */
          /* THE WHOLE IDENTITY, NOT HALF OF IT.
             Motors takes the aircraft as `sessionKey` AND a separate
             `sessionId`; swapping only one leaves the screen holding two
             props that disagree, which is a state the application never
             produces. Every identity-shaped prop moves together. */
          const swapped = {sessionId: 'fc-replacement', generation: 77};
          /* Exactly the calls that were in flight for the OLD aircraft. */
          const oldCalls = held.outstanding();
          await act(async () => {
            tree.update(
              React.cloneElement(element, {
                ...wrapped,
                sessionKey: swapped,
                ...(typeof (element.props as any)?.sessionId === 'string'
                  ? {sessionId: swapped.sessionId}
                  : {}),
              } as any),
            );
          });
          await flush(6);
          const beforeLateAnswer = snapshotOf(tree);
          held.release('SUCCESS', oldCalls);
          await flush(12);
          const afterLateAnswer = snapshotOf(tree);
          endings[ending] =
            beforeLateAnswer === afterLateAnswer
              ? 'OLD_ANSWER_IGNORED'
              : 'OLD_ANSWER_CHANGED_THE_NEW_SESSION_UI';
          await act(async () => tree.unmount());
          continue;
        }

        if (ending === 'NEVER') {
          /* AN ANSWER THAT NEVER COMES. The screen may legitimately stay
             in its working state - what it may not do is claim it
             finished. Measured as: the tree while held is the tree a
             long time later. */
          await flush(24);
          endings[ending] =
            snapshotOf(tree) === working
              ? 'STAYS_IN_ITS_WORKING_STATE'
              : 'CHANGED_WITHOUT_AN_ANSWER';
          await act(async () => tree.unmount());
          continue;
        }

        held.release(ending);
        await flush(16);
        const settled = snapshotOf(tree);
        const settledDisabled = disabledCount(tree);
        const total = interactiveCount(tree);

        if (settled !== working) classification = 'HAS_ASYNC_USER_STATE';
        endings[ending] =
          settled === working
            ? 'NO_OBSERVABLE_TRANSITION'
            : settledDisabled >= total && total > 0
              ? 'SETTLED_BUT_EVERY_CONTROL_STILL_REFUSED'
              : 'LEFT_THE_WORKING_STATE';

        /* NO PERMANENT BUSY UI: once the answer has landed, the screen
           cannot still be refusing every control it draws. */
        if (total > 0) {
          expect({
            screen: name,
            ending,
            everyControlStillRefused: settledDisabled >= total,
          }).toEqual({screen: name, ending, everyControlStillRefused: false});
        }
        await act(async () => tree.unmount());
      }

      if (why === '') {
        why =
          classification === 'HAS_ASYNC_USER_STATE'
            ? `driven through all ${ENDINGS.length} endings over ${
                operations.length
              } held call(s): ${[...new Set(operations)].join(', ')}`
            : 'holding every asynchronous answer open produced the same tree' +
              ' as letting them land, through success, failure and' +
              ' rejection: there is no state here for an operator to be' +
              ' stuck in';
      }
      RESULTS.push({screen: name, classification, why, endings, operations});

      /* NO STUCK LOADING: a screen with async state must visibly leave
         it on at least one ending. */
      if (classification === 'HAS_ASYNC_USER_STATE') {
        expect({
          screen: name,
          leftTheWorkingState: Object.values(endings).some(
            value => value === 'LEFT_THE_WORKING_STATE',
          ),
        }).toEqual({screen: name, leftTheWorkingState: true});
      }

      /* NO CROSS-SESSION WRITE-BACK. */
      expect({
        screen: name,
        oldAnswerChangedTheNewSession:
          endings.SESSION_REPLACED === 'OLD_ANSWER_CHANGED_THE_NEW_SESSION_UI',
      }).toEqual({screen: name, oldAnswerChangedTheNewSession: false});
    },
  );

  it('prints the async coverage ledger', () => {
    const withAsync = RESULTS.filter(
      row => row.classification === 'HAS_ASYNC_USER_STATE',
    );
    const without = RESULTS.filter(
      row => row.classification === 'NO_ASYNC_USER_STATE',
    );
    console.log(
      [
        '',
        '===== UI-X1D GLOBAL ASYNC COVERAGE =====',
        `  screens classified                 : ${RESULTS.length} / ${SCREENS.length}`,
        `  HAS_ASYNC_USER_STATE               : ${withAsync.length}`,
        `  NO_ASYNC_USER_STATE                : ${without.length}`,
        `  endings driven per async screen    : ${ENDINGS.length}` +
          `  (${ENDINGS.join(', ')})`,
        `  COVERAGE                           : ${withAsync.length}/${withAsync.length}` +
          ' async screens x 6 endings',
        '',
        '  SCREEN               CLASS                 SUCCESS                FAILURE                THROW                  NEVER                       UNMOUNT        SESSION_REPLACED',
        ...RESULTS.map(
          row =>
            `  ${row.screen.padEnd(20)} ${row.classification.padEnd(21)}` +
            ` ${(row.endings.SUCCESS ?? '-').padEnd(22)}` +
            ` ${(row.endings.FAILURE ?? '-').padEnd(22)}` +
            ` ${(row.endings.THROW ?? '-').padEnd(22)}` +
            ` ${(row.endings.NEVER ?? '-').padEnd(27)}` +
            ` ${(row.endings.UNMOUNT ?? '-').padEnd(14)}` +
            ` ${row.endings.SESSION_REPLACED ?? '-'}`,
        ),
        '',
        '  SCREENS WITH NO ASYNC USER STATE, AND WHY',
        ...without.map(row => `    ${row.screen.padEnd(20)} ${row.why}`),
        ...(LATE_WORK.length > 0
          ? ['', '  LATE WORK AFTER UNMOUNT', ...LATE_WORK.map(line => `    ${line}`)]
          : []),
        '========================================',
        '',
      ].join('\n'),
    );

    /* THE DENOMINATOR IS CLOSED: every screen in the registry is on one
       side of the line, with a reason. */
    expect(RESULTS.length).toBe(SCREENS.length);
    expect(RESULTS.filter(row => row.why.length === 0)).toEqual([]);
    /* NO LATE WORK ANYWHERE. */
    expect(LATE_WORK).toEqual([]);
    /* And the classification is not vacuous: some screens really do have
       async state. */
    expect(withAsync.length).toBeGreaterThan(5);
  });
});
