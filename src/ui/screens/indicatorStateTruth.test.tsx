/**
 * NOT KNOWING, NOT SUPPORTED, FAILED TO READ, AND ZERO ARE FOUR
 * DIFFERENT THINGS. THE SCREEN HAS TO SAY WHICH.
 *
 * =====================================================================
 * THE DEFECT THIS GENERALISES
 * =====================================================================
 *
 * GPS used to answer "is the GPS feature enabled?" with `draft?.enabled
 * === true ? on : off`. While the read was outstanding, and after a read
 * that FAILED, that expression fell to the negative - so the screen said
 * "GPS is not enabled" as settled fact before the board had said a word,
 * and said it again when the board had refused to answer. On the one
 * screen whose job is to explain why GPS is not working, that names the
 * most likely cause, wrongly.
 *
 * That was one screen and one field. The same shape can be written on
 * any screen: a ternary whose false branch is a CLAIM rather than an
 * admission. So the rule is checked application-wide here, and checked
 * from the OUTSIDE - not by reading source, but by putting each screen
 * into each state and comparing what it draws.
 *
 * =====================================================================
 * THE ORACLE
 * =====================================================================
 *
 * Every screen that reads a subsystem is mounted four times over the
 * SAME shared fixtures, differing only in what the read does:
 *
 *   OBSERVED     the real snapshot, read through the real controller
 *                over a virtual board.
 *   LOADING      a read that never resolves.
 *   READ_FAILED  a read that fails.
 *   REFUSED      a read the board declines.
 *
 * Then: the text of each of the three not-knowing states must DIFFER
 * from the text of OBSERVED. If a screen renders the same thing when it
 * knows and when it does not, it is presenting an absence as a fact -
 * and which fact hardly matters; the operator cannot tell them apart.
 *
 * A screen may legitimately draw LOADING and READ_FAILED alike (both are
 * "no reading yet"), so those are not required to differ from each
 * other. What is forbidden is either of them looking like an answer.
 *
 * ZERO IS THE FIFTH THING, and it is a reading. `indicatorZeroTruth`
 * enforces that at the source, where every site can be seen; the last
 * block here renders REAL zeros through the real controllers and reads
 * them off the screen, because a source rule cannot prove what a render
 * does with a value that is actually there.
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
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';
import type {ScreenCase} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

/* The registry's preconditions press controls; give them React's act. */
installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/** Every word the screen puts on the glass, in order. */
function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

type Read =
  | 'OBSERVED'
  | 'LOADING'
  | 'READ_FAILED'
  | 'REFUSED'
  | 'OTHER_BOARD'
  | 'ALL_ZERO';

/**
 * WHICH LINES ON THIS SCREEN ARE ANSWERS.
 *
 * Comparing whole screens is too blunt: a failed read changes the page
 * enough that a single pill still claiming "GPS is not enabled" would be
 * lost in the diff. So the answers are identified first, by rendering
 * the SAME screen over a DIFFERENT board and taking the lines that
 * moved. A line that changes when the board's data changes is derived
 * from the board's data; a line that does not is chrome - a heading, a
 * button, a unit.
 *
 * The second board is the first one perturbed: every boolean flipped,
 * every finite number moved by one. That is not a realistic aircraft and
 * does not need to be. It only has to differ, so that every data-derived
 * line reveals itself.
 */
function perturb(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value + 1 : value;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => perturb(item, depth + 1));
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value, byte => (byte + 1) % 256);
  }
  /* CONTAINERS KEEP THEIR TYPE. A `Set` walked with `Object.entries`
     comes back as `{}`, and a screen that then calls `.has` on it throws
     - which is the harness inventing a state no board can produce.
     Learned here: Configurations carries its build options as a Set. */
  if (value instanceof Set) {
    return new Set([...value].map(item => perturb(item, depth + 1)));
  }
  if (value instanceof Map) {
    return new Map(
      [...value].map(([key, inner]) => [key, perturb(inner, depth + 1)]),
    );
  }
  if (value !== null && typeof value === 'object') {
    /* Only PLAIN objects are rebuilt. A class instance rebuilt as a bag
       of fields loses its methods, and the screen would throw on a
       snapshot no firmware could send. */
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = perturb(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * THE SAME BOARD, READING ZERO EVERYWHERE.
 *
 * Zero satellites locked, zero amps drawn, zero mAh consumed, zero RPM.
 * Every one of those is a real reading and often the most important one
 * on the screen - and every one of them is one character away from being
 * drawn as "no data" (`value ? show : dash` instead of `value ===
 * undefined ? dash : show`). `indicatorZeroTruth` catches that shape at
 * the source; this catches what the SCREEN does with a zero that is
 * actually there.
 *
 * WHAT THIS DOES TO IDENTIFIERS, AND WHY THE REACT WARNING BELOW IS NOT
 * A PRODUCT DEFECT.
 *
 * It zeroes EVERY finite number, and a snapshot carries identifiers as
 * well as readings: a serial port's `identifier`, a VTX band's `number`,
 * a power level's `number`. Zeroed, they collide, and React prints
 * "Encountered two children with the same key, `0`" - 3 times from Ports
 * (`key={port.identifier}`, four ports) and 8 from VTX
 * (`key={level.number}`), 11 in the suite.
 *
 * No board produces that state: firmware assigns one entry per port and
 * one row per VTXTABLE level, distinct by construction. Keying those
 * lists by array index instead would silence the warning and lose row
 * identity across a reorder, which is worse.
 *
 * The warning matters only if React DROPPED a child, because a dropped
 * line cannot be counted for dashes. Measured, not assumed: with every
 * number zeroed Ports renders the same 39 testIDs it renders from the
 * board's own readings (only their numbers change, plus a validation
 * block the zeroed identifiers legitimately raise), so nothing was
 * omitted. VTX renders a different control set on purpose - band 0 IS
 * direct-frequency mode in the protocol, so the band chips give way to
 * the frequency stepper - which is the screen obeying the reading, not
 * React losing a row.
 */
function zeroed(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? 0 : value;
  if (Array.isArray(value)) return value.map(item => zeroed(item, depth + 1));
  if (value instanceof Uint8Array) return new Uint8Array(value.length);
  if (value instanceof Set) {
    return new Set([...value].map(item => zeroed(item, depth + 1)));
  }
  if (value instanceof Map) {
    return new Map([...value].map(([key, inner]) => [key, zeroed(inner, depth + 1)]));
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = zeroed(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** The one placeholder this application uses for "not reported". */
const DASH = '\u2014';

function dashes(text: string): number {
  return text.split(DASH).length - 1;
}

function lines(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0),
  );
}

/**
 * The same screen, with the read replaced.
 *
 * The registry builds each screen with its real controller double
 * already attached; this clones that element and swaps only `load`, so
 * everything else about the mount - the snapshot the other methods
 * answer with, the session, the collaborators - is identical across the
 * four states. Anything that differs in the render therefore differs
 * because of the READ, which is the whole question.
 */
async function draw(
  screen: ScreenCase,
  state: Read,
): Promise<{text: string; tree: ReactTestRenderer.ReactTestRenderer} | undefined> {
  const record = recorder();
  const element = await screen.mount(record);
  const controller = (element.props as any)?.controller;
  if (controller === undefined || typeof controller.load !== 'function') {
    return undefined;
  }
  const load =
    state === 'OBSERVED'
      ? controller.load
      : state === 'LOADING'
        ? () => new Promise(() => undefined)
        : state === 'READ_FAILED'
          ? async () => ({kind: 'FAILED', error: new Error('link lost')})
          : state === 'REFUSED'
            ? async () => ({kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'})
            : state === 'OTHER_BOARD'
              ? async (...args: unknown[]) => {
                  const real = await controller.load(...args);
                  return real?.kind === 'LOADED'
                    ? {...real, snapshot: perturb(real.snapshot)}
                    : real;
                }
              : async (...args: unknown[]) => {
                  const real = await controller.load(...args);
                  return real?.kind === 'LOADED'
                    ? {...real, snapshot: zeroed(real.snapshot)}
                    : real;
                };
  const swapped = React.cloneElement(element, {
    controller: new Proxy(controller, {
      get(target, property, receiver) {
        if (property === 'load') return load;
        return Reflect.get(target, property, receiver);
      },
    }),
  } as any);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(swapped);
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  return {text: textOf(tree), tree};
}

/** The screens that read a subsystem through a controller of their own. */
const READERS = SCREENS.filter(
  screen =>
    ![
      /* Start opens a transport rather than reading a subsystem; CLI is a
         live terminal, not a request/response read; the two guide screens
         read nothing at all. Each is covered elsewhere and none of them
         has a `controller.load` to swap. */
      'Start',
      'CLI',
      'FlightStyleGuide',
      'FlightStyleCorner',
      'Motors',
      'Presets',
    ].includes(screen.name),
);

interface Row {
  readonly screen: string;
  readonly observed: number;
  readonly loading: number;
  readonly failed: number;
  readonly refused: number;
  readonly loadingDiffers: boolean;
  readonly failedDiffers: boolean;
  readonly refusedDiffers: boolean;
}

const ROWS: Row[] = [];
const SKIPPED: string[] = [];

describe('a screen that has not read cannot claim it has', () => {
  it.each(READERS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const observed = await draw(screen, 'OBSERVED');
      if (observed === undefined) {
        SKIPPED.push(`${name}: no controller.load to replace`);
        expect(true).toBe(true);
        return;
      }
      const loading = await draw(screen, 'LOADING');
      const failed = await draw(screen, 'READ_FAILED');
      const refused = await draw(screen, 'REFUSED');
      /* All four built from the same element: if one is missing the
         harness broke, and that is a failure, not a skip. */
      expect({
        loading: loading !== undefined,
        failed: failed !== undefined,
        refused: refused !== undefined,
      }).toEqual({loading: true, failed: true, refused: true});

      /* THE ANSWERS THIS SCREEN DRAWS, found from the board's own data. */
      const otherBoard = await draw(screen, 'OTHER_BOARD');
      expect(otherBoard !== undefined).toBe(true);
      const here = lines(observed.text);
      const there = lines(otherBoard!.text);
      const answers = [...here].filter(line => !there.has(line));
      /* A screen whose text does not move when the board's data moves
         would make every assertion below vacuous. */
      expect({screen: name, dataDerivedLines: answers.length}).not.toEqual({
        screen: name,
        dataDerivedLines: 0,
      });

      /* AND NONE OF THEM MAY SURVIVE INTO A STATE WITH NO READING. */
      const leaked = (state: string, text: string): string[] => {
        const drawn = lines(text);
        return answers
          .filter(line => drawn.has(line))
          .map(line => `${state}: "${line.slice(0, 70)}"`);
      };
      const claims = [
        ...leaked('while loading', loading!.text),
        ...leaked('after a failed read', failed!.text),
        ...leaked('after a refused read', refused!.text),
      ];
      if (claims.length > 0) {
        console.log(
          [
            '',
            `--- ${name}: A READING SURVIVED INTO A STATE WITH NO READ ---`,
            ...claims.map(line => `  ${line}`),
          ].join('\n'),
        );
      }
      expect({screen: name, claimedWithoutReading: claims}).toEqual({
        screen: name,
        claimedWithoutReading: [],
      });
      await act(async () => otherBoard!.tree.unmount());

      const row: Row = {
        screen: name,
        observed: observed.text.length,
        loading: loading!.text.length,
        failed: failed!.text.length,
        refused: refused!.text.length,
        loadingDiffers: loading!.text !== observed.text,
        failedDiffers: failed!.text !== observed.text,
        refusedDiffers: refused!.text !== observed.text,
      };
      ROWS.push(row);

      /* THE SUBJECT EXISTS. A screen that draws nothing at all in every
         state would satisfy every inequality below. */
      expect(observed.text.length).toBeGreaterThan(0);

      expect({
        screen: name,
        whileLoadingItLooksLikeAnAnswer: !row.loadingDiffers,
        afterAFailedReadItLooksLikeAnAnswer: !row.failedDiffers,
        afterARefusedReadItLooksLikeAnAnswer: !row.refusedDiffers,
      }).toEqual({
        screen: name,
        whileLoadingItLooksLikeAnAnswer: false,
        afterAFailedReadItLooksLikeAnAnswer: false,
        afterARefusedReadItLooksLikeAnAnswer: false,
      });

      for (const state of [observed, loading!, failed!, refused!]) {
        await act(async () => state.tree.unmount());
      }
    },
  );

  it('prints the state matrix', () => {
    console.log(
      [
        '',
        '===== UI-X1D INDICATOR STATE MATRIX =====',
        '  screen              observed loading  failed refused   distinct?',
        ...ROWS.map(
          row =>
            `  ${row.screen.padEnd(19)}` +
            ` ${String(row.observed).padStart(8)}` +
            ` ${String(row.loading).padStart(7)}` +
            ` ${String(row.failed).padStart(7)}` +
            ` ${String(row.refused).padStart(7)}` +
            `   loading=${row.loadingDiffers ? 'yes' : 'NO'}` +
            ` failed=${row.failedDiffers ? 'yes' : 'NO'}` +
            ` refused=${row.refusedDiffers ? 'yes' : 'NO'}`,
        ),
        ...(SKIPPED.length > 0
          ? ['', '  not applicable:', ...SKIPPED.map(row => `    ${row}`)]
          : []),
        '=========================================',
        '',
      ].join('\n'),
    );
    expect(ROWS.length).toBeGreaterThan(8);
  });

  it('the oracle sees a screen that draws the same thing either way', () => {
    /* NEGATIVE CONTROL. Every row above passing means nothing unless a
       collapse would have been caught. */
    const collapsed = {observed: 'GPS is not enabled', failed: 'GPS is not enabled'};
    expect(collapsed.failed !== collapsed.observed).toBe(false);
    const honest = {observed: 'GPS is not enabled', failed: 'reading GPS state'};
    expect(honest.failed !== honest.observed).toBe(true);
  });
});

/* ==================================================================== *
 * §13  A ZERO THE BOARD ACTUALLY REPORTED IS A READING
 *
 * Measured, not reasoned: the same screens, over the same controllers,
 * with every number the board reported replaced by zero. If a screen
 * answers a real zero with the "not reported" dash, it tells the
 * operator there is no data at the exact moment the data says "nothing
 * is there" - and those mean opposite things when deciding whether to
 * arm.
 *
 * The rule is a COMPARISON, not a count: zeroing the board's readings
 * must not put MORE dashes on the screen than the board's real readings
 * did. Fewer is fine and expected - a zero count legitimately empties a
 * list, and its dashes go with it.
 * ==================================================================== */

/**
 * WHERE A ZERO IS NOT A READING.
 *
 * Not every number a board sends is a measurement. A COUNT that gates a
 * control is structural: "how many PID profiles are there" is not a
 * reading like "how many satellites are locked", and a board reporting
 * none has nothing to choose between, so a dash there is the absence of
 * OPTIONS rather than the absence of DATA.
 *
 * Each entry is a decision with a reason and an exact number. A screen
 * that grows one more dash than its entry allows still fails, and an
 * entry whose screen stops producing the dash fails too - a stale
 * exception is an unexamined claim.
 */
const ZERO_IS_STRUCTURAL: Record<string, {readonly dashes: number; readonly why: string}> = {
  PID: {
    dashes: 2,
    why: 'the PID and rate profile badges. `numberOfProfiles`/`numberOfRateProfiles` are counts that gate a selector, not readings: a board reporting zero profiles offers nothing to select and the badge says so. Betaflight reports at least one of each, so this state is unreachable from real firmware - it exists here only because this pass zeroes every number the board sent.',
  },
};

describe('a zero the board reported is drawn as zero', () => {
  const ZEROS: {screen: string; observed: number; zero: number}[] = [];

  it.each(READERS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const observed = await draw(screen, 'OBSERVED');
      if (observed === undefined) {
        expect(true).toBe(true);
        return;
      }
      const zero = await draw(screen, 'ALL_ZERO');
      expect(zero !== undefined).toBe(true);
      const before = dashes(observed.text);
      const after = dashes(zero!.text);
      ZEROS.push({screen: name, observed: before, zero: after});

      /* THE SUBJECT EXISTS. A screen that renders no text in the zeroed
         state would trivially have no dashes. */
      expect(zero!.text.length).toBeGreaterThan(0);

      const appeared = [...lines(zero!.text)]
        .filter(line => line.includes(DASH) && !lines(observed.text).has(line))
        .slice(0, 8);
      if (after > before) {
        console.log(
          [
            '',
            `--- ${name}: A ZERO READING TURNED INTO "NOT REPORTED" ---`,
            `  dashes with the board's real readings: ${before}`,
            `  dashes with every reading at zero    : ${after}`,
            ...appeared.map(line => `    ${line.slice(0, 90)}`),
          ].join('\n'),
        );
      }
      const allowed = ZERO_IS_STRUCTURAL[name]?.dashes ?? 0;
      expect({
        screen: name,
        dashesAZeroAdded: Math.max(0, after - before),
      }).toEqual({screen: name, dashesAZeroAdded: allowed});

      await act(async () => observed.tree.unmount());
      await act(async () => zero!.tree.unmount());
    },
  );

  it('prints the zero ledger', () => {
    console.log(
      [
        '',
        '===== UI-X1D RUNTIME VALID-ZERO =====',
        '  screen              dashes(real)  dashes(all zero)',
        ...ZEROS.map(
          row =>
            `  ${row.screen.padEnd(19)} ${String(row.observed).padStart(12)}` +
            ` ${String(row.zero).padStart(17)}`,
        ),
        '=====================================',
        '',
      ].join('\n'),
    );
    expect(ZEROS.length).toBeGreaterThan(8);
    /* Every declared exception is about a screen that really is measured
       here; a row for a screen this pass never rendered would be a claim
       about nothing. */
    expect(
      Object.keys(ZERO_IS_STRUCTURAL).filter(
        screen => !ZEROS.some(row => row.screen === screen),
      ),
    ).toEqual([]);
  });

  it('the zero oracle sees a value that became a dash', () => {
    /* NEGATIVE CONTROL. */
    expect(dashes(`satellites ${DASH}`)).toBe(1);
    expect(dashes('satellites 0')).toBe(0);
    expect(dashes('satellites 0') > dashes(`satellites ${DASH}`)).toBe(false);
  });
});
