/**
 * ONE AIRCRAFT'S NUMBERS MUST NEVER BE DRAWN AS ANOTHER'S.
 *
 * =====================================================================
 * THE FAILURE THIS EXISTS FOR
 * =====================================================================
 *
 * A pilot unplugs one quad and plugs in the next. Same firmware, same
 * target, same configuration - and for a moment the new session has not
 * received a single telemetry frame yet. If the screen keeps drawing the
 * numbers it already had, the operator is looking at the FIRST
 * aircraft's battery voltage, satellite count and stick positions under
 * a heading that says «قياس حي», about the aircraft in their hand.
 *
 * Nothing about the second board looks wrong, so nothing prompts them to
 * doubt it. They arm on a pack that is not the pack they are reading.
 *
 * =====================================================================
 * WHAT THIS ADDS TO THE PROTOCOL SUITES
 * =====================================================================
 *
 * The U-X2/U-X3 family proves the SESSION layer refuses to serve one
 * board's samples under another's key. That is a claim about the poller.
 * This is a claim about the SCREEN, and it has two halves, because a
 * screen can break either one independently:
 *
 *   A. IT ASKS ABOUT THE AIRCRAFT IN FRONT OF IT.
 *      Every live read the screen performs must carry the CURRENT
 *      session id. A screen that captured the id once - in a memo, a
 *      ref, a closure created on first render - keeps asking about the
 *      previous aircraft, and the poller answers correctly about the
 *      wrong board. Measured by recording every session id the telemetry
 *      hook is called with, before and after the swap.
 *
 *   B. IT STOPS DRAWING A VALUE THE POLLER NO LONGER REPORTS.
 *      Even asking correctly is not enough: a screen that copied the
 *      last value into its own state renders it forever. Measured by
 *      taking the samples away and looking for the numbers.
 *
 * Together those two say: the reading on screen is this aircraft's, or
 * there is no reading on screen.
 *
 * The values are inputs, not findings. They are deliberately far apart so
 * that a leaked one is unmistakable in the rendered text.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

/**
 * The poller this suite drives, and the log of every question the
 * screens asked it.
 */
const mockLive: {
  servedSession: string | undefined;
  readings: Record<string, unknown>;
  asked: {sessionId: string; pollId: string}[];
  listeners: Set<() => void>;
  cache: Map<string, unknown>;
  epoch: number;
} = {
  servedSession: undefined,
  readings: {},
  asked: [],
  listeners: new Set(),
  cache: new Map(),
  epoch: 0,
};

/** Announce new samples the way a scheduler does. */
function mockPublish(
  servedSession: string | undefined,
  readings: Record<string, unknown>,
): void {
  mockLive.servedSession = servedSession;
  mockLive.readings = readings;
  mockLive.epoch += 1;
  mockLive.cache.clear();
  for (const listener of [...mockLive.listeners]) listener();
}

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));
jest.mock('../../platforms/react-native/protocol/useTelemetryValue', () => {
  const jestReact = require('react') as typeof import('react');
  return {
  ...jest.requireActual('../../platforms/react-native/protocol/useTelemetryValue'),
  /**
   * A POLLER THAT KNOWS WHICH AIRCRAFT IT IS TALKING TO.
   *
   * A sample belongs to the session it arrived on. Asked about a session
   * it has nothing for, this answers WAITING - exactly what the
   * production poller does before a new board's first frame lands.
   */
  useTelemetryValue: (sessionId: string, pollId: string) => {
    /* A SUBSCRIBING HOOK, because the real one is
       `useSyncExternalStore`. A plain function that just reads a module
       variable is NOT a faithful double: `BatteryLive`, the receiver
       panel and the sensors panel are all `React.memo`, so a re-render
       driven from the parent bails out and the mocked hook is never
       called again. Measured with such a double, three screens looked
       like they were caching the previous aircraft's readings for ever.
       They were not - the harness simply never asked them again. */
    const subscribe = jestReact.useCallback(
      (listener: () => void) => {
        mockLive.listeners.add(listener);
        return () => {
          mockLive.listeners.delete(listener);
        };
      },
      [],
    );
    const snapshot = jestReact.useCallback(() => {
      const key = `${mockLive.epoch}:${sessionId}:${pollId}`;
      const cached = mockLive.cache.get(key);
      if (cached !== undefined) return cached;
      mockLive.asked.push({sessionId, pollId});
      const value =
        sessionId !== mockLive.servedSession
          ? {status: 'WAITING'}
          : mockLive.readings[pollId] === undefined
            ? {status: 'WAITING'}
            : {
                status: 'FRESH',
                value: mockLive.readings[pollId],
                updatedAtMs: 1_000,
                sampleSeq: 1,
              };
      mockLive.cache.set(key, value);
      return value;
    }, [sessionId, pollId]);
    return jestReact.useSyncExternalStore(subscribe, snapshot, snapshot);
  },
  };
});

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {KEY, SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * TWO AIRCRAFT, AND WHAT EACH REPORTS
 * ==================================================================== */

function battery(voltageCentivolts: number, consumedMah: number): unknown {
  return {
    cellCount: 4,
    configuredCapacityMah: 1500,
    legacyVoltageDecivolts: Math.round(voltageCentivolts / 10),
    consumedMah,
    amperageCentiamps: 850,
    batteryStateRaw: 0,
    voltageCentivolts,
  };
}

function channels(first: number): unknown {
  return {channels: [first, 1500, 1000, 1500, 1800, 1000, 1000, 1000]};
}

function detailedGps(satellites: number, altitudeMeters: number): unknown {
  return {
    hasFix: true,
    fixFlagRaw: 3,
    satelliteCount: satellites,
    latitudeDegrees: 24.7136,
    longitudeDegrees: 46.6753,
    altitudeMeters,
    groundSpeedCentimetersPerSecond: 0,
    groundCourseDecidegrees: 0,
    pdopHundredths: 120,
  };
}

function rawImu(accelerationX: number): unknown {
  return {
    accelerometer: {x: accelerationX, y: 0, z: 512},
    gyroscopeDps: {x: 0, y: 0, z: 0},
    magnetometer: {x: 0, y: 0, z: 0},
  };
}

/**
 * Every number differs by a wide margin, so a value that survives the
 * swap is visible on sight rather than inferred. `fcStatus` is
 * deliberately NOT served: this suite has no honest way to hand-build an
 * `MspStatusExDiagnostics`, and a poll answered WAITING is exactly what
 * a real poller reports before its first frame.
 */
const READINGS_A: Record<string, unknown> = {
  'power-battery-live': battery(1680, 321),
  'receiver-channels-live': channels(1111),
  receiver: channels(1111),
  'gps-detail-raw': detailedGps(17, 811),
  'sensors-imu-live': rawImu(711),
};
const READINGS_B: Record<string, unknown> = {
  'power-battery-live': battery(1422, 999),
  'receiver-channels-live': channels(1943),
  receiver: channels(1943),
  'gps-detail-raw': detailedGps(6, 422),
  'sensors-imu-live': rawImu(288),
};

/** Numbers that appear in A's readings and nowhere in B's, and vice versa. */
const A_ONLY = ['16.80', '1680', '321', '1111', '811', '711'];
const B_ONLY = ['14.22', '1422', '999', '1943', '422', '288'];

/**
 * A TRACE IS A HISTORY ON PURPOSE.
 *
 * Sensors plots the last N gyro/accelerometer samples, so a sample that
 * is merely LATE must not wipe the plot - that is what a trace is for,
 * and demanding otherwise would be this suite asking the product to
 * throw away the very thing the screen exists to show. What a trace may
 * NOT do is carry one aircraft's samples into another's session, which
 * is measured separately below.
 */
const KEEPS_HISTORY_BY_DESIGN: Readonly<Record<string, string>> = {
  Sensors:
    'the gyro/acc/mag trace is a rolling history of the last samples;' +
    ' a late frame must not blank the plot',
};

/** The screens that draw a live reading from the telemetry poller. */
const LIVE_SCREENS = [
  'Power',
  'Receiver',
  'GPS',
  'Sensors',
  'Modes',
  'Failsafe',
  'Configurations',
] as const;

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function present(text: string, needles: readonly string[]): string[] {
  return needles.filter(needle => text.includes(needle));
}

interface Row {
  readonly screen: string;
  readonly drewA: string[];
  readonly stillDrawingAWhenSamplesStopped: string[];
  readonly drewBAfterItsSample: string[];
  readonly askedAboutTheNewSession: boolean;
  readonly askedAboutTheOldSessionAfterSwap: boolean;
  readonly verdict: string;
}

const LEDGER: Row[] = [];

/**
 * Mounts a screen and reports the session it is actually bound to.
 *
 * Not every screen in the registry runs under the shared `KEY`: Sensors
 * opens through a real `MspSessionCoordinator` and carries a session of
 * its own. Assuming the shared one made this suite report that Sensors
 * reads no telemetry at all, which was false - so the session is READ
 * off the element rather than assumed.
 */
async function open(
  screenName: string,
  readings: Record<string, unknown>,
): Promise<{
  tree: ReactTestRenderer.ReactTestRenderer;
  element: React.ReactElement;
  sessionId: string;
}> {
  const screen = SCREENS.find(candidate => candidate.name === screenName)!;
  const element = await screen.mount(recorder());
  const sessionId = String(
    (element.props as any)?.sessionKey?.sessionId ?? KEY.sessionId,
  );
  mockLive.listeners.clear();
  mockPublish(sessionId, readings);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  return {tree, element, sessionId};
}

/**
 * Re-renders the mounted screen so its hooks run again against whatever
 * the poller now reports - which is what a delivered (or withheld)
 * sample does in production. `cloneElement` is deliberate: handing
 * `update` the very same element object lets React bail out of the
 * render entirely, and the suite would then be measuring a tree that was
 * never asked the question.
 */
async function settle(
  tree: ReactTestRenderer.ReactTestRenderer,
  element: React.ReactElement,
): Promise<void> {
  /* The store notified its subscribers in `mockPublish`; this only lets
     React flush them. The parent is re-rendered as well so that a screen
     which reads telemetry through a prop rather than a hook is measured
     too. */
  await act(async () => {
    tree.update(React.cloneElement(element));
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
}

/* ==================================================================== *
 * B. THE SCREEN STOPS DRAWING A VALUE THE POLLER NO LONGER REPORTS
 * ==================================================================== */

describe('a live reading belongs to the aircraft it arrived from', () => {
  it.each(LIVE_SCREENS.map(name => [name] as const))('%s', async name => {
    /* --- The aircraft in front of us is reporting. --- */
    mockLive.asked = [];
    const {tree, element} = await open(name, READINGS_A);
    const drewA = present(textOf(tree), A_ONLY);

    /* --- The pilot swaps aircraft. The new board is identical in every
       way the screen can see, and has not sent a frame yet, so the
       poller answers WAITING for every poll. --- */
    mockPublish(mockLive.servedSession, {});
    await settle(tree, element);
    const stillDrawingA = present(textOf(tree), drewA);

    /* --- Now the new board reports its own, different numbers. --- */
    mockPublish(mockLive.servedSession, READINGS_B);
    await settle(tree, element);
    const after = textOf(tree);
    const drewB = present(after, B_ONLY);
    const aSurvived = present(after, drewA);

    const verdict =
      drewA.length === 0
        ? 'NO_LIVE_VALUE_RENDERED_ON_THIS_SCREEN'
        : stillDrawingA.length > 0 || aSurvived.length > 0
          ? 'PREVIOUS_AIRCRAFT_VALUE_STILL_SHOWN'
          : 'FOLLOWS_THE_POLLER';

    LEDGER.push({
      screen: name,
      drewA,
      stillDrawingAWhenSamplesStopped: stillDrawingA,
      drewBAfterItsSample: drewB,
      askedAboutTheNewSession: true,
      askedAboutTheOldSessionAfterSwap: false,
      verdict,
    });

    if (stillDrawingA.length > 0) {
      console.log(
        [
          '',
          `--- ${name}: A READING THAT IS NO LONGER REPORTED IS STILL ON SCREEN ---`,
          `  values still rendered after the poller went quiet: ${stillDrawingA.join(', ')}`,
        ].join('\n'),
      );
    }

    /* THE ONE THING THAT MUST NEVER HAPPEN - except on a screen whose
       whole job is to keep a history, which is declared and reasoned
       about rather than quietly excused. */
    if (KEEPS_HISTORY_BY_DESIGN[name] === undefined) {
      expect({screen: name, stillShownAfterSamplesStopped: stillDrawingA})
        .toEqual({screen: name, stillShownAfterSamplesStopped: []});
      expect({screen: name, survivedTheNewBoardsSample: aSurvived}).toEqual({
        screen: name,
        survivedTheNewBoardsSample: [],
      });
    }
    /* A screen that never drew anything cannot leak anything, so it is
       recorded rather than counted as a pass. Where it DID draw, the new
       board's own numbers must arrive - otherwise the assertion above is
       satisfied by a blank screen. */
    if (drewA.length > 0 && KEEPS_HISTORY_BY_DESIGN[name] === undefined) {
      expect({screen: name, drewTheNewBoard: drewB.length > 0}).toEqual({
        screen: name,
        drewTheNewBoard: true,
      });
    }
    await act(async () => tree.unmount());
  });
});

/* ==================================================================== *
 * A. THE SCREEN ASKS ABOUT THE AIRCRAFT IN FRONT OF IT
 * ==================================================================== */

describe('every live read carries the current session', () => {
  it.each(LIVE_SCREENS.map(name => [name] as const))('%s', async name => {
    mockLive.asked = [];
    const {tree, element, sessionId} = await open(name, READINGS_A);

    /* THE SUBJECT EXISTS: this screen really does read telemetry. */
    const askedFirst = mockLive.asked.filter(
      row => row.sessionId === sessionId,
    );
    expect({screen: name, readsTelemetry: askedFirst.length > 0}).toEqual({
      screen: name,
      readsTelemetry: true,
    });

    /* --- The aircraft is swapped: a new session id and a new
       generation, which is what the app does on a reconnect. --- */
    const swapped = {sessionId: 'fc-b', generation: KEY.generation + 1};
    mockPublish(swapped.sessionId, READINGS_B);
    mockLive.asked = [];
    await act(async () => {
      tree.update(React.cloneElement(element, {sessionKey: swapped} as any));
    });
    await act(async () => {
      for (let round = 0; round < 12; round += 1) await Promise.resolve();
    });

    const askedAboutNew = mockLive.asked.filter(
      row => row.sessionId === swapped.sessionId,
    );
    const askedAboutOld = mockLive.asked.filter(
      row => row.sessionId === sessionId,
    );

    if (askedAboutOld.length > 0) {
      console.log(
        [
          '',
          `--- ${name}: STILL ASKING ABOUT THE PREVIOUS AIRCRAFT ---`,
          `  polls issued under the OLD session after the swap: ${askedAboutOld
            .map(row => row.pollId)
            .join(', ')}`,
        ].join('\n'),
      );
    }

    /* Every live read after the swap names the NEW aircraft. A screen
       that captured the session id once would keep naming the old one,
       and the poller would answer correctly about the wrong board. */
    expect({
      screen: name,
      pollsStillNamingTheOldAircraft: [
        ...new Set(askedAboutOld.map(row => row.pollId)),
      ],
    }).toEqual({screen: name, pollsStillNamingTheOldAircraft: []});
    expect({screen: name, askedAboutTheNewAircraft: askedAboutNew.length > 0})
      .toEqual({screen: name, askedAboutTheNewAircraft: true});

    const row = LEDGER.find(entry => entry.screen === name);
    if (row !== undefined) {
      (row as {askedAboutTheOldSessionAfterSwap: boolean}).askedAboutTheOldSessionAfterSwap =
        askedAboutOld.length > 0;
    }
    await act(async () => tree.unmount());
  });
});

/* ==================================================================== *
 * C. A SESSION CHANGE TAKES THE PREVIOUS AIRCRAFT WITH IT
 *
 * This is the half a rolling trace cannot be excused from. Sensors keeps
 * a history on purpose - and that history belongs to ONE aircraft. When
 * the session changes it has to go, or the plot splices two boards into
 * one line with a step in the middle that belongs to neither, and the
 * numeric readout beside it reports the aircraft that is no longer
 * plugged in.
 * ==================================================================== */

const SWAP_LEDGER: {screen: string; survived: string[]}[] = [];

describe('a session change takes the previous aircraft off the screen', () => {
  it.each(LIVE_SCREENS.map(name => [name] as const))('%s', async name => {
    mockLive.asked = [];
    const {tree, element} = await open(name, READINGS_A);
    const drewA = present(textOf(tree), A_ONLY);

    /* The pilot swaps aircraft: a new session id and generation, which
       is what a reconnect produces. The new board has not reported. */
    const swapped = {sessionId: 'fc-swap', generation: 99};
    mockPublish(swapped.sessionId, {});
    await act(async () => {
      tree.update(React.cloneElement(element, {sessionKey: swapped} as any));
    });
    await act(async () => {
      for (let round = 0; round < 12; round += 1) await Promise.resolve();
    });

    const survived = present(textOf(tree), drewA);
    SWAP_LEDGER.push({screen: name, survived});
    if (survived.length > 0) {
      console.log(
        [
          '',
          `--- ${name}: THE PREVIOUS AIRCRAFT SURVIVED THE SESSION CHANGE ---`,
          `  values still on screen under the new session: ${survived.join(', ')}`,
        ].join('\n'),
      );
    }
    expect({screen: name, previousAircraftStillOnScreen: survived}).toEqual({
      screen: name,
      previousAircraftStillOnScreen: [],
    });
    await act(async () => tree.unmount());
  });

  it('and the oracle was not measuring an empty screen', () => {
    /* At least one screen really did draw the first aircraft's numbers
       before the swap, or every row above passes for the wrong reason. */
    expect(LEDGER.filter(row => row.drewA.length > 0).length).toBeGreaterThan(0);
    expect(SWAP_LEDGER.length).toBe(LIVE_SCREENS.length);
  });
});

describe('the cross-FC ledger', () => {
  it('prints it', () => {
    console.log(
      [
        '',
        '===== UI-X1D CROSS-FC LIVE TELEMETRY (UI LAYER) =====',
        '  screen           drew A   still shown when   drew B after   still polled',
        '                            A stopped          its sample     the old FC',
        ...LEDGER.map(
          row =>
            `  ${row.screen.padEnd(16)} ${String(row.drewA.length).padStart(6)}` +
            ` ${String(row.stillDrawingAWhenSamplesStopped.length).padStart(18)}` +
            ` ${String(row.drewBAfterItsSample.length).padStart(14)}` +
            ` ${(row.askedAboutTheOldSessionAfterSwap ? 'YES' : 'no').padStart(14)}` +
            `   ${row.verdict}`,
        ),
        '',
        `  screens measured                              : ${LEDGER.length}`,
        `  FC_A values represented as current FC truth   : ${LEDGER.reduce(
          (sum, row) => sum + row.stillDrawingAWhenSamplesStopped.length,
          0,
        )}`,
        `  screens still polling the previous aircraft   : ${
          LEDGER.filter(row => row.askedAboutTheOldSessionAfterSwap).length
        }`,
        '=====================================================',
        '',
      ].join('\n'),
    );
    expect(LEDGER.length).toBe(LIVE_SCREENS.length);
    /* THE REQUIREMENT: zero. */
    expect(
      LEDGER.filter(
        row => KEEPS_HISTORY_BY_DESIGN[row.screen] === undefined,
      ).reduce(
        (sum, row) => sum + row.stillDrawingAWhenSamplesStopped.length,
        0,
      ),
    ).toBe(0);
    /* And across a SESSION change, zero everywhere - history or not. */
    expect(
      SWAP_LEDGER.reduce((sum, row) => sum + row.survived.length, 0),
    ).toBe(0);
    expect(LEDGER.filter(row => row.askedAboutTheOldSessionAfterSwap)).toEqual(
      [],
    );
    /* AND THE ORACLE IS NOT VACUOUS: some screens really did draw the
       first board's numbers while it was the one reporting. */
    expect(LEDGER.filter(row => row.drewA.length > 0).length).toBeGreaterThan(0);
  });

  it('the detector sees a leaked value', () => {
    /* NEGATIVE CONTROL. */
    expect(present('البطارية 16.80 فولت', A_ONLY)).toEqual(['16.80']);
    expect(present('البطارية 14.22 فولت', A_ONLY)).toEqual([]);
  });
});
