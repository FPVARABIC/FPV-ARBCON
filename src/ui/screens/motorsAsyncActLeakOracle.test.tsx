/**
 * THE ASYNC-ACT LEAK ORACLE.
 *
 * WHAT WENT WRONG. Android Validation's Jest shards printed a green summary
 * and then refused to exit, until the step's own 20-minute bound killed
 * them. The cause was not slowness and not a failing assertion: three test
 * files each left ONE ref'd, repeating 650ms `setInterval` alive, and a
 * ref'd timer keeps Node's event loop open for as long as the process runs.
 *
 * WHERE IT CAME FROM. Those files drive the screen through a helper shaped
 * like this:
 *
 *     ReactTestRenderer.act(() => node.props.onPress());     // WRONG
 *
 * The handler is `async`, so the concise arrow body RETURNS ITS PROMISE.
 * React inspects what a synchronous `act()` callback returned, sees a
 * thenable, and switches that call into an ASYNC act - one nobody awaits.
 * It says so out loud ("You called act(async () => ...) without await"),
 * and then leaves the act scope OPEN. From that moment every passive-effect
 * flush in the file is queued into a scope that never drains, including the
 * destroy functions `unmount()` is supposed to run - so
 * MotorDiagnosticsPanel's own `clearInterval` never executes.
 *
 * The repair is to stop handing `act()` a promise:
 *
 *     ReactTestRenderer.act(() => {                          // RIGHT
 *       node.props.onPress();
 *     });
 *
 * A block body evaluates to `undefined` whatever the call returns, so the
 * promise never reaches act() and the call stays synchronous. (`void` in
 * front of the call would say the same thing more loudly, but this project
 * lints `no-void`, and the rule ORACLE 2 enforces is the BLOCK, not the
 * operator.)
 *
 * THE PRODUCTION CODE WAS NEVER AT FAULT. MotorDiagnosticsPanel's effect
 * has always returned a cleanup that clears its interval, and outside a
 * test - where no `act()` scope exists - React runs it on unmount as
 * normal. The defect was entirely in how the tests drove it.
 *
 * WHAT THIS FILE GUARDS. Two independent oracles, both answering in about
 * a second rather than at a 20-minute timeout:
 *
 *   1. BEHAVIOURAL - unmounting the panel leaves no live repeating timer.
 *      Mechanism-agnostic: it fails if the production `clearInterval` is
 *      deleted, and it fails if an act scope is left open so the destroy
 *      never runs.
 *
 *   2. STRUCTURAL - none of the three files known to drive async handlers
 *      may reintroduce the concise-body shape.
 *
 * The last test pins the React behaviour the rule rests on, so that if a
 * future React stops corrupting the scope this file says so instead of
 * silently guarding nothing.
 *
 * NOTHING HERE IS A HARDWARE CLAIM.
 */

import fs from 'fs';
import path from 'path';

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {MotorDiagnosticsPanel} from './MotorDiagnosticsPanel';

jest.mock('../../platforms/react-native/protocol', () => ({
  acquireMotorDiagnosticsTelemetry: jest.fn(() => () => undefined),
  getMotorDiagnosticsAvailability: jest.fn(() => ({
    outputs: 'ACTIVE',
    escTelemetry: 'ACTIVE',
  })),
  getMotorDiagnosticsSupport: jest.fn(() => undefined),
  subscribeMotorDiagnosticsAvailability: jest.fn(() => () => undefined),
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID: 'motorOutputs',
  MOTOR_ESC_TELEMETRY_POLL_ID: 'motorEscTelemetry',
  useTelemetryValue: jest.fn(() => ({status: 'UNAVAILABLE'})),
}));

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

/** The panel's own interval period, in milliseconds. */
const PANEL_INTERVAL_MILLIS = 650;

interface TimerCensus {
  /** Repeating timers created since arming that are still alive AND ref'd -
   *  i.e. exactly the set that can hold Node's event loop open. */
  readonly survivors: () => ReadonlyArray<NodeJS.Timeout>;
  /** Every repeating timer created since arming, cleared or not. */
  readonly created: () => number;
  readonly disarm: () => void;
}

/**
 * Watches real `setInterval`/`clearInterval` for the duration of one test.
 *
 * Deliberately NOT `jest.getTimerCount()`: that answers about FAKE timers,
 * and the leak under test is a real one. `hasRef()` is the discriminator
 * that matters - an unref'd handle is untidy but cannot block exit, and an
 * oracle that counted handles alone would accuse innocent code.
 */
function armTimerCensus(): TimerCensus {
  const live = new Set<NodeJS.Timeout>();
  let created = 0;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  global.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    live.add(handle);
    created += 1;
    return handle;
  }) as typeof setInterval;

  global.clearInterval = ((handle: NodeJS.Timeout) => {
    live.delete(handle);
    return realClearInterval(handle);
  }) as typeof clearInterval;

  return {
    survivors: () =>
      [...live].filter(
        handle => typeof handle?.hasRef === 'function' && handle.hasRef(),
      ),
    created: () => created,
    disarm: () => {
      for (const handle of live) {
        realClearInterval(handle);
      }
      live.clear();
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

function operatorStub(): MotorTestOperatorPort {
  return {
    refreshDiagnostics: jest.fn(async () => undefined),
  } as unknown as MotorTestOperatorPort;
}

async function mountPanel(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <MotorDiagnosticsPanel
        sessionId="oracle-session"
        operator={operatorStub()}
        activeMotorTest
      />,
    );
  });
  return tree;
}

describe('ORACLE 1 - unmounting the diagnostics panel leaves no live timer', () => {
  it('creates a ref’d repeating timer while active, and clears it on unmount', async () => {
    const census = armTimerCensus();
    try {
      const tree = await mountPanel();

      /* The premise: if no interval was created, the rest of this test
         would pass vacuously and guard nothing. */
      expect(census.created()).toBeGreaterThan(0);
      expect(census.survivors().length).toBeGreaterThan(0);

      await act(async () => {
        tree.unmount();
      });

      /* The invariant. This is the assertion that would have caught the
         hang in one second instead of twenty minutes. */
      expect(census.survivors()).toEqual([]);
    } finally {
      census.disarm();
    }
  });

  it('clears the timer on unmount even after an async handler ran inside act', async () => {
    const census = armTimerCensus();
    try {
      const tree = await mountPanel();
      expect(census.survivors().length).toBeGreaterThan(0);

      /* The repaired helper shape: the promise is discarded INSIDE the
         callback, so `act()` stays synchronous and its scope closes. */
      const handler = async () => undefined;
      act(() => {
        handler();
      });

      await act(async () => {
        tree.unmount();
      });
      expect(census.survivors()).toEqual([]);
    } finally {
      census.disarm();
    }
  });
});

describe('ORACLE 2 - the async-driving test files keep the safe act() shape', () => {
  /**
   * The three files whose helpers actually invoke `async` handlers. This
   * is a named list rather than a repository-wide sweep on purpose: most
   * `act(() => x.onPress())` call sites in this project drive SYNCHRONOUS
   * handlers, where the concise body returns `undefined` and is harmless.
   * Accusing those would be a false alarm, and a rule that cries wolf is
   * a rule that gets deleted.
   */
  const GUARDED = [
    'motorsFinalClosure.test.tsx',
    'motorsDirectionProductionPath.test.tsx',
    'motorsDirectionNormalProductionPath.test.tsx',
  ];

  /**
   * `act(` followed by an arrow body, capturing the body's FIRST non-space
   * character. A concise body is anything whose first character is not `{`.
   *
   * The obvious spelling - `=>\s*(?!\{)` - silently matches everything: the
   * greedy `\s*` backtracks to zero width, so the lookahead is tested
   * against a space rather than against the body. Capturing the character
   * forces `\s*` to consume the whitespace and leaves no such loophole.
   */
  const ARROW_BODY = /ReactTestRenderer\.act\(\s*\(\)\s*=>\s*([^\s])/g;

  it.each(GUARDED)(
    '%s hands act() no promise',
    file => {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');

      const offenders: string[] = [];
      for (const match of source.matchAll(ARROW_BODY)) {
        if (match[1] === '{') {
          continue; /* a block body returns undefined - always safe */
        }
        /* The whole `act(...)` statement, not a fixed-width window: these
           call sites are line-wrapped by the formatter, so a window that
           stopped at the newline would miss the callee, and one that ran
           past the `;` could borrow an `unmount()` from the NEXT call and
           wave a real offender through. */
        const start = match.index ?? 0;
        const end = source.indexOf(';', start);
        const statement = source.slice(start, end === -1 ? start + 200 : end);
        /* `unmount()` returns void by contract, so the concise form can
           never hand act() a thenable there. Every other concise body in
           these files is a handler call and must move into a block. */
        if (!/\bunmount\(\)/.test(statement)) {
          offenders.push(statement.replace(/\s+/g, ' ').trim());
        }
      }

      expect(offenders).toEqual([]);
    },
  );

  it('the guarded list names files that exist', () => {
    for (const file of GUARDED) {
      expect(fs.existsSync(path.join(__dirname, file))).toBe(true);
    }
  });
});

/* ================================================================== *
 * DELIBERATELY THE LAST TEST IN THIS FILE.
 *
 * It reproduces the defect on purpose, which leaves React's act scope
 * open for whatever runs afterwards - so nothing may run afterwards. It
 * clears its own leaked handle before returning, and asserts that the
 * clear worked, so this oracle never becomes the thing it warns about.
 * ================================================================== */

describe('ORACLE 3 - the React behaviour the rule rests on', () => {
  it('a sync act() handed a promise warns, and strands the unmount destroy', async () => {
    const census = armTimerCensus();
    const warnings: string[] = [];
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string') {
          warnings.push(args[0]);
        }
      });
    try {
      const tree = await mountPanel();
      expect(census.survivors().length).toBe(1);

      /* THE DEFECT, on purpose: a concise body returning a promise. */
      const handler = async () => undefined;
      act(() => handler() as unknown as void);

      /* React's own complaint is queued on the microtask queue. */
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(
        warnings.some(text =>
          text.includes('You called act(async () => ...) without await'),
        ),
      ).toBe(true);

      /* And the consequence: unmount runs, but its passive destroy is
         queued into the stranded scope, so the interval survives. */
      await act(async () => {
        tree.unmount();
      });
      expect(tree.toJSON()).toBeNull();
      expect(census.survivors().length).toBe(1);
      expect(census.survivors()[0]?.hasRef()).toBe(true);

      /* Interval period recorded so a future reader can match this to the
         handle the CI open-handle reporter names. */
      expect(PANEL_INTERVAL_MILLIS).toBe(650);
    } finally {
      /* disarm() clears every handle it is still holding - including the
         stranded one - so this file leaks nothing of its own. */
      census.disarm();
      expect(census.survivors()).toEqual([]);
      spy.mockRestore();
    }
  });
});
