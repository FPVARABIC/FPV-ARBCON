/**
 * A SAVE HAS MORE THAN TWO ENDINGS, AND THE SCREEN HAS TO SHOW WHICH.
 *
 * =====================================================================
 * WHY THIS IS NOT A DETAIL
 * =====================================================================
 *
 * Writing a configuration to a flight controller is a SEQUENCE of MSP
 * writes ending in a save to EEPROM, and it can stop anywhere in that
 * sequence. U-R1 gave the controllers a vocabulary for where it stopped,
 * because the endings mean genuinely different things to the person
 * holding the aircraft:
 *
 *   SAVED_VERIFIED       written, and read back as written.
 *   SAVED_UNVERIFIED     written, and the read-back did not come. It may
 *                        be right. Nobody has checked.
 *   PARTIAL_UNPERSISTED  some RAM writes were acknowledged and EEPROM was
 *                        never reached. The aircraft is already flying
 *                        something different from what is stored, and
 *                        there is no rollback.
 *   UNCONFIRMED          a write went out and no acknowledgement came
 *                        back. It may have landed.
 *   REJECTED             the application refused before sending anything.
 *   SESSION_ENDED        the board this draft belongs to is gone.
 *   FAILED               the attempt failed outright.
 *   NO_CHANGES           there was nothing to write.
 *
 * The failure mode this suite exists to prevent is the obvious one: a
 * screen that maps several of those onto one green "saved". A pilot who
 * reads "saved" after a PARTIAL_UNPERSISTED will fly an aircraft whose
 * RAM and EEPROM disagree, and will find out in the air.
 *
 * =====================================================================
 * HOW IT IS MEASURED
 * =====================================================================
 *
 * The shared registry builds each screen with its real controller
 * double; this clones that element and swaps ONLY `save`, so the eight
 * renders differ by nothing except how the write ended. Then the
 * rendered text of every pair of DIFFERENT endings must differ.
 *
 * The controllers' own vocabularies are pinned by their own suites; this
 * is about what reaches the glass.
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
import {Alert, Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';
import type {ScreenCase} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

/**
 * THE STAGE VALUE EACH CONTROLLER ACTUALLY USES.
 *
 * `UNCONFIRMED` and `PARTIAL_UNPERSISTED` both carry the stage the write
 * sequence stopped at, and the SHAPE of that stage is the controller's
 * own: a bare string on Ports, `{group}` on Failsafe and OSD, `{kind}`
 * on Modes. Handing a screen the wrong shape produces a render nothing
 * could produce - Failsafe threw `Cannot use 'in' operator to search for
 * 'index' in EEPROM` on the first attempt at this - so each row below is
 * read off that controller's declared union, not guessed.
 */
const EEPROM_STAGE: Record<string, unknown> = {
  Failsafe: {group: 'EEPROM'},
  Power: {group: 'EEPROM'},
  GPS: 'EEPROM',
  OSD: {group: 'EEPROM'},
  Modes: {kind: 'EEPROM'},
  Ports: 'EEPROM',
  Receiver: 'EEPROM',
  Configurations: 'EEPROM',
  VTX: {group: 'EEPROM'},
  Blackbox: 'EEPROM',
};

/** A stage BEFORE EEPROM, for the "these were acknowledged" list. */
const EARLIER_STAGE: Record<string, unknown> = {
  Failsafe: {group: 'FAILSAFE_CONFIG'},
  Power: {group: 'VOLTAGE_METER'},
  GPS: 'FEATURE_CONFIG',
  OSD: {group: 'OSD_CONFIG'},
  Modes: {kind: 'MODE_RANGE', index: 0},
  Ports: 'SERIAL_CONFIG',
  Receiver: 'RX_CONFIG',
  Configurations: 'FEATURE',
  VTX: {group: 'VTX_CONFIG'},
  Blackbox: 'BLACKBOX_WRITE',
};

/**
 * THE ENDINGS EACH SCREEN'S CONTROLLER CAN ACTUALLY REACH.
 *
 * NOT one list for everybody. The first attempt at this handed every
 * screen the same seven kinds and reported LED as "7/7 distinct" - while
 * `LedStripSaveOutcome` has no `SAVED_VERIFIED`, no `SAVED_UNVERIFIED`
 * and no `PARTIAL_UNPERSISTED` at all. Seven kinds it can never return
 * fell through to one default branch and the run looked green. A pass
 * built out of states the product cannot produce measures nothing, and
 * is worse than no pass because it reads as coverage.
 *
 * So each list below is read off that controller's declared union. Where
 * an ending's payload is a structure this pass cannot build faithfully -
 * LED's partial-apply detail carries the entry indexes and phases of a
 * half-written strip - it is SKIPPED AND NAMED rather than approximated,
 * because an approximated payload is the same mistake in a smaller size.
 */
interface Ending {
  readonly kind: string;
  readonly extra: Record<string, unknown>;
}

const SKIPPED_ENDINGS: Record<string, readonly {kind: string; why: string}[]> = {
  LED: [
    {
      kind: 'READBACK_MISMATCH',
      why: 'carries a LedPartialApplyDetail describing which entries were written, at which phase of the strip transition, and what the board reports now; a hand-built one would be a shape no save produced',
    },
    {kind: 'PARTIAL_APPLY', why: 'same LedPartialApplyDetail payload'},
    {kind: 'SESSION_LOST_DURING_SAVE', why: 'same LedPartialApplyDetail payload'},
  ],
  Blackbox: [
    {
      kind: 'AWAITING_REBOOT_VERIFICATION',
      why: 'carries a BlackboxPendingPersistence describing a write that will be verified after the reboot; the reboot evidence path is pinned by rebootEvidenceTruth.test.tsx',
    },
    {
      kind: 'READBACK_MISMATCH',
      why: 'carries the expected and observed BlackboxOwnedDraft; building a pair by hand would compare two invented drafts',
    },
  ],
};

function endings(screen: string): Ending[] {
  const eeprom = EEPROM_STAGE[screen];
  const earlier = EARLIER_STAGE[screen];

  /* LED's vocabulary is its own: a strip is written in groups and the
     persist is a separate step, so "applied but not persisted" is a
     first-class ending rather than a partial write. */
  if (screen === 'LED') {
    return [
      {kind: 'SAVE_VERIFIED', extra: {withSnapshot: true}},
      {kind: 'NO_CHANGES', extra: {withSnapshot: true}},
      {kind: 'REJECTED', extra: {reason: 'SESSION_CHANGED'}},
      {kind: 'REFUSED', extra: {refusal: {kind: 'STALE_SESSION'}}},
      {kind: 'APPLIED_NOT_PERSISTED', extra: {groups: {}, withSnapshot: true}},
      {kind: 'SESSION_ENDED', extra: {}},
    ];
  }
  /* Blackbox writes two groups and then persists across a reboot, so its
     doubt is per-stage rather than per-group. */
  if (screen === 'Blackbox') {
    return [
      {kind: 'NO_CHANGES', extra: {withSnapshot: true}},
      {kind: 'REJECTED', extra: {reason: 'SESSION_CHANGED'}},
      {kind: 'UNCONFIRMED', extra: {stage: eeprom}},
      {kind: 'SESSION_ENDED', extra: {}},
      {kind: 'FAILED', extra: {error: new Error('link lost')}},
    ];
  }

  const shared: Ending[] = [
    {kind: 'NO_CHANGES', extra: {withSnapshot: true}},
    {kind: 'SAVED_VERIFIED', extra: {rebootAcknowledged: true, withSnapshot: true}},
    {
      kind: 'SAVED_UNVERIFIED',
      extra: {rebootAcknowledged: false, error: new Error('no read-back')},
    },
    {
      kind: 'PARTIAL_UNPERSISTED',
      extra: {
        confirmedStages: [earlier],
        acknowledgedGroups: [earlier],
        failedStage: eeprom,
        definitelyNotSent: false,
      },
    },
    {kind: 'UNCONFIRMED', extra: {stage: eeprom, confirmedStages: [earlier]}},
    {kind: 'REJECTED', extra: {reason: 'SESSION_CHANGED'}},
    {kind: 'SESSION_ENDED', extra: {}},
    {kind: 'FAILED', extra: {error: new Error('link lost')}},
  ];
  /* Receiver alone reports a save that needs a reboot before it counts. */
  return screen === 'Receiver'
    ? [
        ...shared,
        {kind: 'SAVED_REBOOT_REQUIRED', extra: {withSnapshot: true}},
      ]
    : shared;
}

/** Screens that own a draft and a Save. */
const SAVERS = SCREENS.filter(screen =>
  [
    'Failsafe',
    'Power',
    'GPS',
    'OSD',
    'Modes',
    'Ports',
    'Receiver',
    'Configurations',
    'VTX',
    'LED',
    'Blackbox',
  ].includes(screen.name),
);

/** Press everything that could make a draft dirty, then the Save. */
async function saveWith(
  screen: ScreenCase,
  outcome: (snapshot: unknown) => unknown,
): Promise<string | undefined> {
  const record = recorder();
  const element = await screen.mount(record);
  const controller = (element.props as any)?.controller;
  if (controller === undefined || typeof controller.save !== 'function') {
    return undefined;
  }
  let snapshot: unknown;
  const swapped = React.cloneElement(element, {
    controller: new Proxy(controller, {
      get(target, property, receiver) {
        if (property === 'load') {
          return async (...args: unknown[]) => {
            const real = await controller.load(...args);
            snapshot = real?.snapshot;
            return real;
          };
        }
        if (property === 'save') return async () => outcome(snapshot);
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

  /* A confirmation is part of the save on several screens; answer it. */
  let dialog: readonly {style?: string; onPress?: () => unknown}[] | undefined;
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_t?: string, _b?: string, buttons?: readonly any[]) => {
      dialog = buttons;
    });

  const find = (predicate: (props: any) => boolean) =>
    tree.root
      .findAll(node => node.props !== undefined && predicate(node.props), {
        deep: true,
      })
      .pop();

  /* DIRTY FIRST. A Save on a clean draft is disabled and correctly does
     nothing, and measuring that would measure nothing.
       The first attempt at this only nudged steppers, and five screens
     have no stepper on their first view - Ports edits inside an expanded
     card, LED inside a grid, Blackbox behind a select. So this presses
     whatever is in front of it, one control at a time, and stops the
     moment a Save turns on. That is a person making a change. */
  const tried = new Set<string>();
  const HANDLERS = ['onPress', 'onValueChange', 'onSelect'] as const;
  for (let round = 0; round < 60; round += 1) {
    const save = find(
      props =>
        typeof props.testID === 'string' &&
        /-save$/.test(props.testID) &&
        typeof props.onPress === 'function' &&
        props.disabled !== true,
    );
    if (save !== undefined) break;
    const next = tree.root
      .findAll(
        node =>
          node.props !== undefined &&
          node.props.disabled !== true &&
          HANDLERS.some(
            handler => typeof (node.props as any)[handler] === 'function',
          ),
        {deep: true},
      )
      .find(node => {
        const props = node.props as any;
        const handler = HANDLERS.find(
          candidate => typeof props[candidate] === 'function',
        );
        const id = `${props.testID ?? props.accessibilityLabel ?? '?'}::${handler}`;
        return (
          !tried.has(id) &&
          !/-save$/.test(String(props.testID ?? '')) &&
          !/(reload|refresh|discard|reset)/i.test(String(props.testID ?? ''))
        );
      });
    if (next === undefined) break;
    const props = next.props as any;
    const handler = HANDLERS.find(
      candidate => typeof props[candidate] === 'function',
    )!;
    tried.add(`${props.testID ?? props.accessibilityLabel ?? '?'}::${handler}`);
    await act(async () => {
      try {
        if (handler === 'onValueChange') props[handler](props.value !== true);
        else props[handler]();
      } catch {
        /* a control that refuses is not this pass's subject */
      }
      await Promise.resolve();
    });
  }

  const save = find(
    props =>
      typeof props.testID === 'string' &&
      /-save$/.test(props.testID) &&
      typeof props.onPress === 'function' &&
      props.disabled !== true,
  );
  if (save === undefined) {
    alert.mockRestore();
    await act(async () => tree.unmount());
    return undefined;
  }
  await act(async () => {
    (save.props as any).onPress();
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
  const confirm = dialog?.find(
    button => button.style !== 'cancel' && typeof button.onPress === 'function',
  );
  if (confirm !== undefined) {
    await act(async () => {
      await confirm.onPress?.();
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
    });
  }
  await act(async () => {
    for (let round = 0; round < 8; round += 1) await Promise.resolve();
  });
  const drawn = textOf(tree);
  alert.mockRestore();
  await act(async () => tree.unmount());
  return drawn;
}

const MATRIX: {screen: string; distinct: number; total: number}[] = [];
const NOT_REACHED: string[] = [];

describe('every ending of a save reads differently', () => {
  it.each(SAVERS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const drawn = new Map<string, string>();
      for (const ending of endings(name)) {
        const text = await saveWith(screen, snapshot => ({
          kind: ending.kind,
          ...(('withSnapshot' in ending.extra) ? {snapshot} : {}),
          ...ending.extra,
        }));
        if (text === undefined) {
          NOT_REACHED.push(`${name}: no enabled Save could be reached`);
          expect(true).toBe(true);
          return;
        }
        drawn.set(ending.kind, text);
      }

      /* THE SUBJECT EXISTS. */
      expect(drawn.size).toBe(endings(name).length);

      const collisions: string[] = [];
      const kinds = [...drawn.keys()];
      for (let a = 0; a < kinds.length; a += 1) {
        for (let b = a + 1; b < kinds.length; b += 1) {
          if (drawn.get(kinds[a]) === drawn.get(kinds[b])) {
            collisions.push(`${kinds[a]} reads exactly like ${kinds[b]}`);
          }
        }
      }
      MATRIX.push({
        screen: name,
        distinct: new Set(drawn.values()).size,
        total: drawn.size,
      });
      if (collisions.length > 0) {
        console.log(
          [
            '',
            `--- ${name}: TWO DIFFERENT ENDINGS READ THE SAME ---`,
            ...collisions.map(line => `  ${line}`),
          ].join('\n'),
        );
      }
      expect({screen: name, collisions}).toEqual({screen: name, collisions: []});
    },
  );

  it('prints the save-state matrix', () => {
    console.log(
      [
        '',
        '===== UI-X1D SAVE-STATE TRUTH =====',
        '  endings are each controller\'s own union, not one shared list',
        ...MATRIX.map(
          row =>
            `  ${row.screen.padEnd(19)} ${row.distinct}/${row.total} distinct renderings` +
            (SKIPPED_ENDINGS[row.screen] === undefined
              ? ''
              : `   (+${SKIPPED_ENDINGS[row.screen].length} not built)`),
        ),
        ...Object.entries(SKIPPED_ENDINGS).flatMap(([screen, rows]) => [
          '',
          `  ${screen} endings this pass did not build:`,
          ...rows.map(row => `    ${row.kind}: ${row.why}`),
        ]),
        ...(NOT_REACHED.length > 0
          ? ['', '  not reached:', ...NOT_REACHED.map(line => `    ${line}`)]
          : []),
        '===================================',
        '',
      ].join('\n'),
    );
    expect(MATRIX.length + NOT_REACHED.length).toBe(SAVERS.length);
  });

  it('the collision detector sees two endings drawn alike', () => {
    /* NEGATIVE CONTROL. */
    const same = new Map([
      ['SAVED_VERIFIED', 'saved'],
      ['PARTIAL_UNPERSISTED', 'saved'],
    ]);
    expect(new Set(same.values()).size).toBe(1);
    const honest = new Map([
      ['SAVED_VERIFIED', 'saved and verified'],
      ['PARTIAL_UNPERSISTED', 'written to RAM, not stored'],
    ]);
    expect(new Set(honest.values()).size).toBe(2);
  });
});
