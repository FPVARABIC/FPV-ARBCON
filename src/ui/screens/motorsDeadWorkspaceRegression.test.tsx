/**
 * M-E2 - THE DEAD WORKSPACE. THROUGH THE REAL SCREEN.
 *
 * WHAT A REAL SCREENSHOT SHOWED, at 1366px on a board whose motor-test
 * setup read had not landed:
 *
 *   - a 619px column (879px at 1920) reserved for an aircraft, 104px tall,
 *     holding one sentence and a single floating "M1";
 *   - the Motor Test controls that column exists to label squeezed into
 *     the remaining 699px;
 *   - everything below inheriting the same half-width grid;
 *   - the page reading as broken.
 *
 * THREE DEFECTS, ONE PICTURE.
 *
 *   1. `MotorAirframeDiagram` documents `motorNumbers` as "an empty array
 *      means nothing has been read, and renders as nothing", and did not:
 *      the layout lookup ran first, missed, and answered with the generic
 *      caption - a sentence about "this Mixer" on a screen where no mixer
 *      had been read either.
 *   2. `MotorIdentitySection`'s map line printed `M{selected}` even with
 *      an EMPTY motor list: an identity for a motor nothing had said
 *      existed.
 *   3. The workspace split into two columns because the VIEWPORT was
 *      >= 1024, with no reference to whether there was anything to put in
 *      the first column.
 *
 * WHY THIS FILE DRIVES THE WHOLE PATH. Each module is defensible alone -
 * the diagram declines correctly, the identity line renders correctly for
 * a motor that exists, the breakpoint is the measured one. The dead
 * workspace only exists when one snapshot flows through all three. So this
 * runs MainTabsScreen, the real binding, the real MotorTestController and
 * the real MspClient over a scripted board.
 *
 * NOTHING HERE IS A HARDWARE CLAIM. `ScriptedMotorFc` is a model.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

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
import {StyleSheet, Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {presentConnectedBoard} from '../session/__testUtils__/connectedBoard';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {MspClient} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {ScriptedMotorFc} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import type {ScriptedMotorFcOptions} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import {
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';
import {MotorAirframeDiagram} from './MotorAirframeDiagram';
import {MotorIdentitySection} from './MotorIdentitySection';
import {evaluateMotorIdentificationCapability} from '../../core/state/motorIdentificationCapability';
import {EMPTY_VERIFICATION_STATE} from '../../core/state/motorVerificationModel';

const SESSION_ID = 'dead-workspace-session';

/** Betaflight `mixerMode_e`, from the pinned firmware's mixer.h. */
const MIXER_TRI = 1;
const MIXER_QUADX = 3;
const MIXER_HEX6X = 10;
const MIXER_OCTOX8 = 11;
/** MIXER_CUSTOM - the firmware declines to describe its geometry. */
const MIXER_CUSTOM = 23;
/** In no pinned mixer table. Must stay unrecognised, never normalised. */
const MIXER_UNRECOGNISED = 199;

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];

function board(mixerMode: number, motorCount: number): ScriptedMotorFcOptions {
  return {
    payloads: new Map<number, Uint8Array>([
      [MSP_MIXER_CONFIG, Uint8Array.from([mixerMode, 0])],
      [
        MSP_MOTOR_CONFIG,
        Uint8Array.from([
          ...u16(1070), ...u16(2000), ...u16(1000),
          motorCount,
          14, 0, 0,
        ]),
      ],
    ]),
  };
}

let transport: FakeMspTransport;
let fc: ScriptedMotorFc;

/**
 * THE VIEWPORT THE RULE IS ABOUT.
 *
 * jsdom reports a fixed ~750px window, which is below the desktop tier -
 * so without this the two-column branch never runs and an assertion about
 * it would pass for the wrong reason. 1366 is the width of the reported
 * screenshot.
 */
const DESKTOP_WIDTH = 1366;
function useDesktopViewport(): void {
  jest
    .spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({width: DESKTOP_WIDTH, height: 1080, scale: 2, fontScale: 1});
}

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SESSION_ID, generation: 1}},
  } as never;
  presentConnectedBoard(SESSION_ID);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  const find = (testID: string, handler: 'onPress' | 'onValueChange') =>
    all(testID).find(candidate => typeof candidate.props?.[handler] === 'function');
  return {
    renderer,
    all,
    press: (testID: string) => {
      const node = find(testID, 'onPress');
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    /**
     * Open a tab from whichever navigation this width renders.
     *
     * At the desktop tier `MainTabsScreen` swaps the bottom tab bar for a
     * side rail, and the rail's items are `main-rail-*`. A helper that
     * only knew `main-tab-*` would fail at exactly the widths this file
     * exists to exercise.
     */
    openTab: (tab: string) => {
      const node =
        find(`main-tab-${tab}`, 'onPress') ?? find(`main-rail-${tab}`, 'onPress');
      if (node === undefined) throw new Error(`no navigation item for "${tab}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    toggle: (testID: string, next: boolean) => {
      const node = find(testID, 'onValueChange');
      if (node === undefined) throw new Error(`no switch "${testID}"`);
      ReactTestRenderer.act(() => node.props.onValueChange(next));
    },
    has: (testID: string) => all(testID).length > 0,
    /**
     * Every motor number offered by the numbered fallback selector.
     *
     * DEDUPED: `findAll` matches a Pressable's composite node AND its host
     * node, so a three-motor selector reports each number several times.
     * The question is which motors are REACHABLE, not how many tree nodes
     * carry the prop.
     */
    selectorSlots: (): number[] =>
      [
        ...new Set(
          all('motor-identification-summary')
            .flatMap(node => node.findAll(child => child.props?.accessibilityRole === 'radio'))
            .map(child => String(child.props?.testID ?? ''))
            .map(id => Number(id.replace(/\D+/g, '')))
            .filter(value => Number.isInteger(value) && value > 0),
        ),
      ].sort((a, b) => a - b),
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

async function settle(rounds = 40, delayMillis = 2) {
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      fc.pump();
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, delayMillis));
    }
  });
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
beforeEach(() => useDesktopViewport());
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const renderer of renderers.splice(0, renderers.length)) {
      try { renderer.unmount(); } catch { /* already torn down */ }
    }
  });
  closeMotorTestCapability(SESSION_ID);
  jest.restoreAllMocks();
});

/** A live motor session on a board reporting the given airframe. */
async function liveMotorsScreen(mixerMode: number, motorCount: number) {
  const shell = renderShell();
  renderers.push(shell.renderer);
  ReactTestRenderer.act(() => {
    transport = new FakeMspTransport();
    fc = new ScriptedMotorFc(transport, board(mixerMode, motorCount));
    openMotorTestCapability(
      SESSION_ID,
      new MspClient(transport, SESSION_ID),
      createMotorTestTelemetryRegistry(),
    );
  });
  shell.openTab('MOTORS');
  await settle();
  shell.toggle('motor-session-toggle', true);
  await settle();
  return shell;
}

/**
 * Does the workspace hold a column open for an aircraft?
 *
 * Read off the STYLE the screen actually applied, not off a width
 * variable: `workspaceColumnAirframe` is the 46% basis that reserved the
 * dead region, and its presence is the defect.
 */
function reservesAirframeColumn(shell: ReturnType<typeof renderShell>): boolean {
  const columns = shell.all('motors-airframe-column');
  if (columns.length === 0) return false;
  const style = StyleSheet.flatten(columns[0].props.style) as {
    flexBasis?: string | number;
    minWidth?: number;
  };
  return style.minWidth !== undefined || typeof style.flexBasis === 'string';
}

describe('M-E2 - a workspace with no aircraft reserves no aircraft column', () => {
  it('the reported state: nothing read - no column, no stage, no lone motor label', async () => {
    // MSP_MOTOR_CONFIG never answers, so the screen has no runtime count
    // and no mixer: exactly the snapshot behind the reported screenshot.
    const shell = renderShell();
    renderers.push(shell.renderer);
    ReactTestRenderer.act(() => {
      transport = new FakeMspTransport();
      fc = new ScriptedMotorFc(transport, {payloads: new Map()});
      openMotorTestCapability(
        SESSION_ID,
        new MspClient(transport, SESSION_ID),
        createMotorTestTelemetryRegistry(),
      );
    });
    shell.openTab('MOTORS');
    await settle();

    expect(reservesAirframeColumn(shell)).toBe(false);
    expect(shell.has('motors-airframe-stage')).toBe(false);
    // THE LONE M1. An identity for a motor nothing said existed.
    expect(shell.has('motor-identity-number')).toBe(false);
    // And no paragraph about a mixer that was never read.
    expect(shell.text()).not.toContain(ar.motorsScreen.layoutGenericCaption);
    /*
     * THE BLOCK ITSELF, NOT ONLY ITS CONTENTS.
     *
     * An empty container is what reserved the column: it has no visible
     * ink, so every assertion about what is DRAWN passes while the grid
     * still hands it 46% of the page. The claim is that with nothing
     * read the map block does not exist.
     */
    expect(shell.has('motors-identity-map')).toBe(false);
  });

  it.each([
    ['CUSTOM', MIXER_CUSTOM, 5],
    ['unrecognised', MIXER_UNRECOGNISED, 3],
  ])(
    'a %s mixer gets the numbered workspace and no reserved column',
    async (_name, mixer, count) => {
      const shell = await liveMotorsScreen(mixer, count);

      // No empty visual workspace, and no invented geometry.
      expect(reservesAirframeColumn(shell)).toBe(false);
      expect(shell.has('motors-airframe-stage')).toBe(false);
      expect(shell.has('motors-diagram-front')).toBe(false);

      // Every runtime motor is reachable from the numbered selector.
      expect(shell.selectorSlots()).toEqual(
        Array.from({length: count}, (_unused, index) => index + 1),
      );
      // The fallback says why, once.
      expect(shell.text()).toContain(ar.motorsScreen.layoutGenericCaption);
      /*
       * AND NO LONE M-NUMBER UNDER THE SELECTOR.
       *
       * These mixers have no authored layout, so the compact identity
       * line has no station to name; with nothing observed either, every
       * optional half of it is empty and only its own anchor - "M1" -
       * would be left. The chip above is already drawn as selected and
       * already spells its state aloud, so the bare number is the
       * floating identity in a second place.
       */
      expect(shell.has('motor-identity-selected-brief')).toBe(false);
      expect(shell.has('motor-identity-station')).toBe(false);
      // The operational controls are present and usable.
      expect(shell.has('motor-workspace-enable')).toBe(true);
      expect(shell.has('motor-session-toggle')).toBe(true);
      expect(shell.has('motors-stop-button')).toBe(true);
    },
  );

  it('an unrecognised mixer is never normalised into a Quad X', async () => {
    const shell = await liveMotorsScreen(MIXER_UNRECOGNISED, 3);
    expect(shell.has('motors-airframe-stage')).toBe(false);
    // Three motors, three chips - not four corners.
    expect(shell.selectorSlots()).toHaveLength(3);
    expect(shell.has('motors-airframe-slot-4')).toBe(false);
  });
});

describe('M-E2 - an authored airframe keeps its drawing and its column', () => {
  it.each([
    ['QUADX', MIXER_QUADX, 4],
    ['TRI', MIXER_TRI, 3],
    ['HEX6X', MIXER_HEX6X, 6],
    ['OCTOX8', MIXER_OCTOX8, 8],
  ])('%s still draws every motor', async (_name, mixer, count) => {
    const shell = await liveMotorsScreen(mixer, count);

    expect(shell.has('motors-airframe-stage')).toBe(true);
    expect(shell.has('motors-diagram-front')).toBe(true);
    expect(reservesAirframeColumn(shell)).toBe(true);
    /*
     * EVERY MOTOR IS ON THE AIRCRAFT - counted as the drawing draws it.
     *
     * A coaxial frame (X8, Y6) carries two rotors per arm and renders ONE
     * node bearing both numbers: eight independent 44px targets do not fit
     * a compact stage, and spreading them round a circle would draw an
     * aircraft that does not exist. So the check is that the drawn nodes
     * ACCOUNT FOR every runtime motor, not that there is a node per motor.
     */
    const drawn = shell.renderer.root
      .findAll(candidate => String(candidate.props?.testID ?? '').startsWith('motors-airframe-slot-'))
      .map(candidate => String(candidate.props.testID));
    expect(new Set(drawn).size).toBeGreaterThan(0);
    const labelled = shell.renderer.root
      .findAll(candidate => String(candidate.props?.testID ?? '').startsWith('motors-airframe-slot-'))
      .flatMap(candidate => candidate.findAllByType(Text))
      .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
      .join(' ');
    for (let slot = 1; slot <= count; slot += 1) {
      expect(labelled).toContain(String(slot));
    }
    // The fallback sentence must never appear beside a real drawing.
    expect(shell.text()).not.toContain(ar.motorsScreen.layoutGenericCaption);
    /*
     * ONE SELECTOR PER AIRFRAME - M-E §16, still true after M-E2.
     *
     * Where an aircraft is drawn its nodes ARE the selector: each is a
     * 44px target with a radio role. The numbered chip row is the
     * selector exactly where there is no picture, and offering both puts
     * two rows asking the same question on one screen.
     *
     * Scoped to the map block on purpose: the verification workflow under
     * technical details renders its own numbered row, unconditionally and
     * correctly, under the same testID.
     */
    const mapBlocks = shell.all('motors-identity-map');
    expect(mapBlocks.length).toBeGreaterThan(0);
    expect(
      mapBlocks.flatMap(block =>
        block.findAll(child => child.props?.testID === 'motor-identification-summary'),
      ),
    ).toHaveLength(0);
    /*
     * THE COMPACT IDENTITY LINE, WHERE IT HAS SOMETHING TO SAY.
     *
     * The other half of the rule the fallback states exercise: an
     * authored frame gives the selected motor a station read from the
     * same mixer table the drawing places it from, so the line names
     * where M1 sits rather than repeating that it is M1.
     */
    expect(shell.has('motor-identity-selected-brief')).toBe(true);
    expect(shell.has('motor-identity-station')).toBe(true);
  });

  it('the numbered fallback keeps its motor order under RTL', async () => {
    /*
     * THE MIRRORING QUESTION, ASKED OF THE FALLBACK.
     *
     * `motorAirframeGeometry.test.tsx` already pins the DRAWING: a
     * physical corner may not move when the reading direction changes,
     * because an operator who saw FRONT_RIGHT drawn on the left would
     * "correct" a correctly-wired aircraft. The numbered fallback has the
     * same duty with no picture to hold it: M1..MN is an output ordering,
     * not prose, so the list a person reads must offer the same motors in
     * the same logical order whichever way the page flows.
     *
     * This app runs RTL in production, and the tree the selector produces
     * is what a screen reader walks. The assertion is that the ORDER is
     * the numeric one, not the visual one.
     */
    const shell = await liveMotorsScreen(MIXER_CUSTOM, 5);
    expect(shell.selectorSlots()).toEqual([1, 2, 3, 4, 5]);
    const rendered = shell
      .all('motor-identification-summary')
      .flatMap(node => node.findAll(child => child.props?.accessibilityRole === 'radio'))
      .map(child => String(child.props?.testID ?? ''));
    // Deduped in document order: the first occurrence of each id.
    const order: string[] = [];
    for (const id of rendered) if (!order.includes(id)) order.push(id);
    const numbers = order.map(id => Number(id.replace(/\D+/g, '')));
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it('a tricopter names its servo as a servo, and never as a motor', async () => {
    const shell = await liveMotorsScreen(MIXER_TRI, 3);
    expect(shell.has('motors-diagram-servo')).toBe(true);
    expect(shell.has('motors-airframe-slot-4')).toBe(false);
  });
});

/**
 * THE TWO GUARDS UNDER THE ONE THE SCREEN REACHES.
 *
 * WHY THESE ARE COMPONENT TESTS, SAID PLAINLY. Three modules each decline
 * to describe motors that were never read, and they are in a line: the MAP
 * variant returns null before it builds `map`, so the diagram's own empty
 * check and the identity line's own empty check are never REACHED from
 * MotorsScreen. Mutating either one alone changes nothing on the real
 * screen - the mutation program measured exactly that - and mutating the
 * outer one alone is caught by the full-path tests above.
 *
 * They are still worth having and still worth pinning. Each is a contract
 * a module states about its OWN props, in its own prop documentation:
 * `motorNumbers` is documented as "an empty array means nothing has been
 * read, and renders as nothing", and `slots` as "empty when nothing has
 * been read - never a placeholder quad". A guard nothing tests is a
 * comment. So these two tests ask each module its own question directly,
 * with the props the outer guard would otherwise never let through.
 *
 * WHAT THEY ARE NOT. They are not a reproduction of the reported defect
 * and they do not stand in for one - that is the suite above, which runs
 * MainTabsScreen over a scripted board.
 */
describe('M-E2 - each module declines nothing-read on its own props', () => {
  function render(element: React.ReactElement) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(element);
    });
    renderers.push(renderer);
    return (testID: string) =>
      renderer.root.findAll(candidate => candidate.props?.testID === testID).length > 0;
  }

  it('the diagram draws nothing at all for an empty motor list', () => {
    /* The mixer is a real, authored one. The list is empty. An unread
       count is the absence of a question, so the answer is not the
       "no layout for this mixer" paragraph - it is nothing. */
    const has = render(
      <MotorAirframeDiagram
        selectedSlot={1}
        onSelectSlot={() => {}}
        mixerModeRaw={MIXER_QUADX}
        motorNumbers={[]}
      />,
    );
    expect(has('motors-airframe-diagram')).toBe(false);
    expect(has('motors-airframe-stage')).toBe(false);
    expect(has('motors-generic-outputs')).toBe(false);
    expect(has('motors-diagram-front')).toBe(false);
  });

  it('the identity line names no motor when the aircraft has none', () => {
    /* DELIBERATELY INCONSISTENT PROPS - and that is the point. A drawable
       set of diagram numbers with an EMPTY logical motor list is a
       combination MotorsScreen cannot build, because it passes the same
       array to both. This asks the component what it does when handed
       one anyway: it may draw the aircraft it was given numbers for, and
       it may not claim an identity for a motor its own list does not
       contain. */
    const has = render(
      <MotorIdentitySection
        slots={[]}
        selectedSlot={1}
        onSelectSlot={() => {}}
        capability={evaluateMotorIdentificationCapability(MIXER_QUADX, [])}
        mixerModeRaw={MIXER_QUADX}
        diagramMotorNumbers={[1, 2, 3, 4]}
        active
        verification={EMPTY_VERIFICATION_STATE}
        receipt={undefined}
        onConfirm={() => {}}
        onClearObservation={() => {}}
        outputOrder={undefined}
        variant="MAP"
      />,
    );
    // The drawing it WAS given numbers for is present ...
    expect(has('motors-airframe-stage')).toBe(true);
    // ... and no identity is claimed for a motor the list does not hold.
    expect(has('motor-identity-selected-brief')).toBe(false);
    expect(has('motor-identity-number')).toBe(false);
  });
});
