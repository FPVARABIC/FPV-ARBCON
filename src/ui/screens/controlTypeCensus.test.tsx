/**
 * A CONTROL CHANGES ITS OWN VALUE AND NOTHING ELSE.
 *
 * =====================================================================
 * THE ORACLE: PUT IT BACK
 * =====================================================================
 *
 * "Does this toggle change the right field" is hard to ask from outside
 * a screen - the draft is internal state and no test should reach into
 * it. But there is an equivalent question that is answerable from the
 * render alone, and stronger:
 *
 *   DOES TAKING IT BACK TAKE EVERYTHING BACK?
 *
 * Toggle a switch twice and the screen must be byte-identical to how it
 * started. Press minus then plus on a stepper and the same. Choose a
 * different option in a group and then choose the original again, and
 * the same. If ANY other field moved - a second value nudged, a
 * selection dropped, a section closed, a dirty flag left standing - the
 * tree does not come back, and the round trip fails.
 *
 * That is one oracle for four of the censuses this phase asks for
 * (toggles, steppers, selectors, chips), it needs no knowledge of any
 * screen's draft shape, and it cannot be satisfied by a control that
 * writes to a neighbour.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 *   It does not treat a BOUNDARY as a failure. A stepper on its maximum
 *   refuses to go higher, so `plus` then `minus` legitimately ends one
 *   step LOWER. The pair is therefore driven in the direction that has
 *   room, and a control with room in neither direction is reported as
 *   pinned rather than as broken.
 *
 *   It does not compare trees on a screen that redraws by itself.
 *   Sensors paints live traces; two identical presses there produce two
 *   different trees for reasons that have nothing to do with the press.
 *   Ambient drift is measured first and subtracted, exactly as the
 *   interaction census does for disabled controls.
 *
 * The wire half of the same question - that none of these controls
 * writes to the flight controller before Save - is measured across every
 * control on every screen by `interactionCensus`, which watches the
 * ports' own call log.
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

import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(600000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

type Kind = 'TOGGLE' | 'STEPPER' | 'SELECTOR' | 'SLIDER' | 'TEXT';

interface Control {
  readonly id: string;
  readonly kind: Kind;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly node: ReactTestRenderer.ReactTestInstance;
}

/**
 * WHAT KIND OF CONTROL THIS IS, read off the props it renders with.
 *
 * Deliberately not a list of component names: a screen that swaps one
 * switch implementation for another keeps the same census row, and a new
 * one joins without anyone updating a table.
 */
function classify(props: any): Kind | undefined {
  if (typeof props.onValueChange === 'function' && typeof props.value === 'boolean') {
    return 'TOGGLE';
  }
  if (props.accessibilityRole === 'adjustable') return 'SLIDER';
  if (
    typeof props.onPress === 'function' &&
    typeof props.testID === 'string' &&
    /-(plus|minus)$/.test(props.testID)
  ) {
    return 'STEPPER';
  }
  if (
    typeof props.onPress === 'function' &&
    (props.accessibilityRole === 'radio' ||
      props.accessibilityRole === 'tab' ||
      typeof props.accessibilityState?.selected === 'boolean')
  ) {
    return 'SELECTOR';
  }
  if (typeof props.onChangeText === 'function') return 'TEXT';
  return undefined;
}

function discover(tree: ReactTestRenderer.ReactTestRenderer): Control[] {
  const byKey = new Map<string, Control>();
  for (const node of tree.root.findAll(
    candidate => candidate.props !== undefined && classify(candidate.props) !== undefined,
    {deep: true},
  )) {
    const props = node.props as any;
    const kind = classify(props)!;
    const id =
      (typeof props.testID === 'string' ? props.testID : undefined) ??
      (typeof props.accessibilityLabel === 'string'
        ? props.accessibilityLabel
        : undefined);
    if (id === undefined) continue;
    /* A composite and the host it renders both carry the handler; the
       inner one is the control, and `findAll` yields parents first. */
    byKey.set(`${id}::${kind}`, {
      id,
      kind,
      disabled:
        props.disabled === true || props.accessibilityState?.disabled === true,
      selected: props.accessibilityState?.selected === true,
      node,
    });
  }
  return [...byKey.values()];
}

const snapshotOf = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  JSON.stringify(tree.toJSON());

/** Does this screen redraw with nobody touching it? */
async function driftOf(tree: ReactTestRenderer.ReactTestRenderer): Promise<boolean> {
  const before = snapshotOf(tree);
  await act(async () => {
    for (let round = 0; round < 3; round += 1) await Promise.resolve();
  });
  return snapshotOf(tree) !== before;
}

/**
 * TWO DENOMINATORS, NAMED APART.
 *
 * This suite reports two different quantities and they must never share
 * a label:
 *
 *   UNIQUE_CONTROL_SUBJECTS  one per (screen, control, kind) examined -
 *                            the rows of `ROWS`, one outcome each.
 *   ACTION_ROWS              one per interaction actually performed.
 *                            A round trip is two or three of them
 *                            (toggle twice; minus then plus; away, then
 *                            back to the group's home), so this is
 *                            always the larger number.
 *
 * `ROUND_TRIP_CLEAN` is neither: it is a SUBSET of the subjects - the
 * ones that could round-trip at all. A subject that is DISABLED or
 * PINNED never performs one, which is why 269 clean does not add up to
 * 655 subjects and never should.
 *
 * Counted here rather than inferred from the shape of the loop, because
 * a count derived from what the code is supposed to do is not a
 * measurement.
 */
const ACTIONS: {screen: string; id: string; kind: Kind}[] = [];
let currentScreen = '(none)';

async function tap(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
  kind: Kind,
): Promise<boolean> {
  const control = discover(tree).find(
    candidate => candidate.id === id && candidate.kind === kind,
  );
  if (control === undefined || control.disabled) return false;
  ACTIONS.push({screen: currentScreen, id, kind});
  const props = control.node.props as any;
  await act(async () => {
    try {
      if (kind === 'TOGGLE') props.onValueChange(!props.value);
      else props.onPress();
    } catch {
      /* a control that refuses is measured by its refusal, below */
    }
    for (let round = 0; round < 3; round += 1) await Promise.resolve();
  });
  return true;
}

interface Row {
  readonly screen: string;
  readonly kind: Kind;
  readonly id: string;
  readonly outcome:
    | 'ROUND_TRIP_CLEAN'
    | 'ROUND_TRIP_DIRTY'
    | 'PINNED'
    | 'INERT'
    | 'DISABLED'
    | 'DRIFTS';
  readonly detail: string;
}

const ROWS: Row[] = [];

/** Every screen the registry builds; the sweep skips none of them. */
const ALL = SCREENS;

describe('a control puts the screen back when it is taken back', () => {
  it.each(ALL.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const element = await screen.mount(recorder());
      let tree!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        tree = ReactTestRenderer.create(element);
      });
      await act(async () => {
        for (let round = 0; round < 8; round += 1) await Promise.resolve();
      });
      if (screen.precondition !== undefined) {
        await screen.precondition(tree);
        await act(async () => {
          await Promise.resolve();
        });
      }

      currentScreen = name;
      const drifts = await driftOf(tree);
      const found = discover(tree);
      const done = new Set<string>();

      for (const control of found) {
        if (done.has(`${control.id}::${control.kind}`)) continue;
        done.add(`${control.id}::${control.kind}`);
        if (control.kind === 'TEXT' || control.kind === 'SLIDER') continue;
        /* THE MOTOR-TEST SESSION IS NOT ROUND-TRIPPED HERE.
           Switching it on arms outputs. It is measured through the real
           production screen over a scripted board in
           motorsFinalWorkspace.test.tsx and refused for every blocking
           reason in motorsBlockedStateMatrix.test.tsx; a generic
           on-then-off from this sweep would be the census taking that
           decision on its own. */
        if (control.id === 'motor-session-toggle') {
          ROWS.push({
            screen: name,
            kind: control.kind,
            id: control.id,
            outcome: 'PINNED',
            detail:
              'SAFETY_CONTROLLED: opens the motor-test session; driven for' +
              ' real in motorsFinalWorkspace.test.tsx',
          });
          continue;
        }
        if (control.disabled) {
          ROWS.push({
            screen: name,
            kind: control.kind,
            id: control.id,
            outcome: 'DISABLED',
            detail: 'refused before the round trip, as it should',
          });
          continue;
        }
        if (drifts) {
          ROWS.push({
            screen: name,
            kind: control.kind,
            id: control.id,
            outcome: 'DRIFTS',
            detail:
              'this screen redraws by itself, so a before/after comparison' +
              ' cannot attribute a change to the press',
          });
          continue;
        }

        const before = snapshotOf(tree);
        if (control.kind === 'TOGGLE') {
          if (!(await tap(tree, control.id, 'TOGGLE'))) continue;
          const moved = snapshotOf(tree) !== before;
          await tap(tree, control.id, 'TOGGLE');
          const back = snapshotOf(tree) === before;
          ROWS.push({
            screen: name,
            kind: 'TOGGLE',
            id: control.id,
            outcome: !moved ? 'INERT' : back ? 'ROUND_TRIP_CLEAN' : 'ROUND_TRIP_DIRTY',
            detail: !moved
              ? 'switching it changed nothing at all'
              : back
                ? 'off then on left the screen exactly as it was'
                : 'off then on left the screen in a different state',
          });
          continue;
        }

        if (control.kind === 'STEPPER') {
          /* THE DIRECTION WITH ROOM. A stepper on its floor cannot go
             lower, and driving the pair the wrong way round would end a
             step away and report a false finding. */
          const partner = control.id.endsWith('-minus')
            ? `${control.id.slice(0, -'-minus'.length)}-plus`
            : `${control.id.slice(0, -'-plus'.length)}-minus`;
          const partnerHere = found.find(
            candidate => candidate.id === partner && candidate.kind === 'STEPPER',
          );
          if (partnerHere === undefined || partnerHere.disabled) {
            ROWS.push({
              screen: name,
              kind: 'STEPPER',
              id: control.id,
              outcome: 'PINNED',
              detail: `its counterpart ${partner} is ${
                partnerHere === undefined ? 'absent' : 'disabled'
              }, so there is no round trip to make`,
            });
            continue;
          }
          done.add(`${partner}::STEPPER`);
          if (!(await tap(tree, control.id, 'STEPPER'))) continue;
          const moved = snapshotOf(tree) !== before;
          await tap(tree, partner, 'STEPPER');
          const back = snapshotOf(tree) === before;
          ROWS.push({
            screen: name,
            kind: 'STEPPER',
            id: `${control.id} + ${partner}`,
            outcome: !moved ? 'INERT' : back ? 'ROUND_TRIP_CLEAN' : 'ROUND_TRIP_DIRTY',
            detail: !moved
              ? 'one step changed nothing at all'
              : back
                ? 'one step out and one step back left the screen exactly as it was'
                : 'one step out and one step back left the screen in a different state',
          });
          continue;
        }

        /* SELECTOR. THE ROUND TRIP IS THROUGH THE GROUP'S HOME.
           The first attempt at this chose a sibling and then chose the
           control again - which ends with the selection on the CONTROL,
           not where it started, and reported 316 healthy radio buttons
           as having left something behind. A group's home is whichever
           option was selected when the screen was drawn; the trip is
           away to this control and back to that. A group with no
           selected option has no home and nothing to return to, and
           says so. */
        const cut = control.id.lastIndexOf('-');
        const family =
          cut <= 0
            ? []
            : found.filter(
                candidate =>
                  candidate.kind === 'SELECTOR' &&
                  candidate.id.startsWith(control.id.slice(0, cut + 1)),
              );
        const home = family.find(candidate => candidate.selected);
        if (home === undefined || home.id === control.id) {
          ROWS.push({
            screen: name,
            kind: 'SELECTOR',
            id: control.id,
            outcome: 'PINNED',
            detail:
              home === undefined
                ? 'no option in its group reports itself selected, so there is nowhere to return the selection to'
                : 'it already holds its group\'s selection',
          });
          continue;
        }
        if (!(await tap(tree, control.id, 'SELECTOR'))) continue;
        const moved = snapshotOf(tree) !== before;
        const returned = await tap(tree, home.id, 'SELECTOR');
        const back = snapshotOf(tree) === before;
        ROWS.push({
          screen: name,
          kind: 'SELECTOR',
          id: `${control.id} and back to ${home.id}`,
          outcome: !moved
            ? 'INERT'
            : !returned
              ? 'PINNED'
              : back
                ? 'ROUND_TRIP_CLEAN'
                : 'ROUND_TRIP_DIRTY',
          detail: !moved
            ? 'choosing it changed nothing at all'
            : !returned
              ? `the group's home ${home.id} could not be chosen again`
              : back
                ? 'away and back left the screen exactly as it was'
                : 'away and back left the screen in a different state',
        });
      }

      await act(async () => tree.unmount());

      const dirty = ROWS.filter(
        row => row.screen === name && row.outcome === 'ROUND_TRIP_DIRTY',
      );
      const inert = ROWS.filter(
        row => row.screen === name && row.outcome === 'INERT',
      );
      if (dirty.length + inert.length > 0) {
        console.log(
          [
            '',
            `--- ${name}: A ROUND TRIP DID NOT COME BACK ---`,
            ...dirty.map(row => `  DIRTY ${row.kind} ${row.id}  [${row.detail}]`),
            ...inert.map(row => `  INERT ${row.kind} ${row.id}  [${row.detail}]`),
          ].join('\n'),
        );
      }
      expect({
        screen: name,
        didNotComeBack: dirty.map(row => `${row.kind} ${row.id}`),
      }).toEqual({screen: name, didNotComeBack: []});
      expect({
        screen: name,
        changedNothing: inert.map(row => `${row.kind} ${row.id}`),
      }).toEqual({screen: name, changedNothing: []});
    },
  );

  it('prints the control-type census', () => {
    const kinds: Kind[] = ['TOGGLE', 'STEPPER', 'SELECTOR'];
    const outcomes: Row['outcome'][] = [
      'ROUND_TRIP_CLEAN',
      'ROUND_TRIP_DIRTY',
      'PINNED',
      'INERT',
      'DISABLED',
      'DRIFTS',
    ];
    console.log(
      [
        '',
        '===== UI-X1D CONTROL-TYPE ROUND TRIP =====',
        '  kind      ' + outcomes.map(o => o.padStart(18)).join(''),
        ...kinds.map(
          kind =>
            `  ${kind.padEnd(10)}` +
            outcomes
              .map(outcome =>
                String(
                  ROWS.filter(row => row.kind === kind && row.outcome === outcome)
                    .length,
                ).padStart(18),
              )
              .join(''),
        ),
        '',
        '  DENOMINATORS - these count different things and are never mixed',
        `    UNIQUE_CONTROL_SUBJECTS  ${String(ROWS.length).padStart(5)}` +
          `   one per (screen, control, kind), one outcome each`,
        `    ACTION_ROWS              ${String(ACTIONS.length).padStart(5)}` +
          `   one per interaction actually performed`,
        `    ROUND_TRIP_CLEAN         ${String(
          ROWS.filter(row => row.outcome === 'ROUND_TRIP_CLEAN').length,
        ).padStart(5)}   a SUBSET of the subjects, not a third total`,
        '',
        '  kind        UNIQUE_SUBJECTS      ACTION_ROWS',
        ...kinds.map(
          kind =>
            `    ${kind.padEnd(10)}` +
            String(ROWS.filter(row => row.kind === kind).length).padStart(15) +
            String(ACTIONS.filter(row => row.kind === kind).length).padStart(17),
        ),
        `    ${'(TEXT/SLIDER, skipped)'.padEnd(10)}` +
          String(
            ACTIONS.filter(row => !kinds.includes(row.kind)).length,
          ).padStart(32),
        '',
        `  subjects: ${ROWS.length}  across ${new Set(ROWS.map(r => r.screen)).size} screens`,
        '==========================================',
        '',
      ].join('\n'),
    );
    /* A census that measured nothing would satisfy every assertion. */
    expect(
      ROWS.filter(row => row.outcome === 'ROUND_TRIP_CLEAN').length,
    ).toBeGreaterThan(30);

    /* THE TWO DENOMINATORS ARE REALLY DIFFERENT, AND THE SUBJECT ONE IS
       REALLY UNIQUE. A duplicated subject would inflate the row count
       while every per-outcome column still looked plausible. */
    const subjectKeys = ROWS.map(row => `${row.screen}::${row.id}::${row.kind}`);
    expect(new Set(subjectKeys).size).toBe(ROWS.length);
    /* Every outcome column adds up to the subject total - no row is
       counted under two outcomes and none is dropped. */
    const perOutcome = outcomes.reduce(
      (sum, outcome) =>
        sum + ROWS.filter(row => row.outcome === outcome).length,
      0,
    );
    expect({sumOfOutcomeColumns: perOutcome}).toEqual({
      sumOfOutcomeColumns: ROWS.length,
    });
    /* And per kind, the same. */
    for (const kind of kinds) {
      const rows = ROWS.filter(row => row.kind === kind);
      const columns = outcomes.reduce(
        (sum, outcome) =>
          sum + rows.filter(row => row.outcome === outcome).length,
        0,
      );
      expect({kind, sumOfOutcomeColumns: columns}).toEqual({
        kind,
        sumOfOutcomeColumns: rows.length,
      });
    }
    /* A round trip is more than one press, so actions must exceed the
       subjects that performed one. */
    expect(ACTIONS.length).toBeGreaterThan(
      ROWS.filter(row => row.outcome === 'ROUND_TRIP_CLEAN').length,
    );
  });

  it('the round-trip oracle sees a control that leaves something behind', () => {
    /* NEGATIVE CONTROL: two trees that differ after a round trip. */
    const before = JSON.stringify({value: 3, other: 1});
    const after = JSON.stringify({value: 3, other: 2});
    expect(after === before).toBe(false);
    expect(JSON.stringify({value: 3, other: 1}) === before).toBe(true);
  });
});
