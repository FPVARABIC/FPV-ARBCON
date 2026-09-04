/**
 * WHAT THE PORTS SCREEN OFFERS, AND WHAT THE BOARD IS THEN TOLD.
 *
 * =====================================================================
 * WHY THE GENERIC CENSUS IS NOT ENOUGH HERE
 * =====================================================================
 *
 * `interactionCensus` proves every Ports control DOES something, and
 * `controlTypeCensus` proves each one comes back when it is taken back.
 * Neither asks the question this screen actually turns on:
 *
 *     the operator picked GPS on UART3 - which BIT, on WHICH record, is
 *     now different, and did anything else move?
 *
 * A serial-port table is one array of records that the firmware rewrites
 * WHOLE. There is no "set UART3's role" message: MSP2_COMMON_SET_SERIAL_CONFIG
 * takes every port. So a screen that edits one UART and silently
 * disturbs another - a baud index, an unknown function bit, a trailing
 * byte belonging to a firmware feature this build does not model -
 * writes that damage to the board with the operator's own Save. That is
 * a configuration the pilot did not ask for, on the ports that carry the
 * receiver and the GPS.
 *
 * =====================================================================
 * WHAT IS MEASURED
 * =====================================================================
 *
 * The screen is mounted over a source-realistic snapshot produced by the
 * REAL `PortsConfigurationController` reading the shared virtual board,
 * and driven by its own controls. The controller is replaced only at the
 * boundary, by a recorder that keeps every `save` argument - because the
 * subject of this suite is exactly what the screen hands the controller.
 *
 *   1. EVERY VISIBLE OPTION -> DRAFT FIELD -> FIRMWARE SEMANTIC.
 *      Every role chip, every NONE chip, both role switches and every
 *      baud chip on every UART, each with exactly one recorded outcome.
 *   2. NOTHING REACHES THE BOARD BEFORE SAVE.
 *   3. SAVE WRITES ONE UART, and every other record comes back
 *      byte-identical - trailing firmware bytes included.
 *   4. A ROLE THIS BUILD CANNOT RUN CANNOT BE CHOSEN.
 *   5. RELOAD RETURNS THE OBSERVED VALUE, not the abandoned draft, and
 *      asks before discarding one.
 *
 * MSP semantics are read from the production model. This suite asserts
 * the SCREEN agrees with them; it does not define them, and it changes
 * nothing about them.
 */

/* eslint-disable no-bitwise -- A SERIAL PORT'S ROLE IS A BIT.
   `functionMask` is one u32 whose bits ARE the roles, and the whole
   subject of this file is which bit a chip sets. Writing that with
   arithmetic instead of `1 << n` and `mask & bit` would obscure the one
   thing every assertion here is about, and the production model
   (`setSerialRole`) states it the same way. */

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
import {Alert} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import PortsScreen from './PortsScreen';
import {PortsConfigurationController} from '../../platforms/react-native/protocol/PortsConfigurationController';
import {
  SERIAL_BAUD_RATES,
  SERIAL_ROLE_DEFINITIONS,
  availableBaudIndexes,
  hasSerialRole,
  serialRoleIsAvailable,
  type SerialBaudField,
  type SerialPortsSnapshot,
  type SerialRoleKey,
} from '../../core/state/serialPortsModel';
import {
  decodeSerialPorts,
  type MspSerialPortRecord,
} from '../../core/protocol/msp/decoding/decodeSerialPorts';
import {KEY, snapshotVia, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * THE BOARD, AND THE ONE SEAM
 * ==================================================================== */

interface SaveCall {
  readonly original: SerialPortsSnapshot;
  readonly desired: readonly MspSerialPortRecord[];
}

interface Harness {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly snapshot: SerialPortsSnapshot;
  readonly saves: SaveCall[];
  readonly loads: number[];
}

/**
 * A BOARD WHOSE FIRMWARE CARRIES MORE PER-PORT FIELDS THAN THIS BUILD
 * MODELS.
 *
 * The shared fixture answers `MSP2_COMMON_SERIAL_CONFIG` with the
 * minimum record, so its `extensionBytes` are empty everywhere - and an
 * assertion that empty trailing bytes survive a save proves nothing at
 * all. (It did not, in the first version of this suite; the measurement
 * below is what found that.) Betaflight has widened this record before,
 * which is precisely why `decodeSerialPorts` reads the width from the
 * payload and keeps the remainder. So this builds the WIRE PAYLOAD such
 * a firmware sends and hands it to the PRODUCTION decoder; the records
 * under test are the ones the application itself would produce from that
 * board.
 */
function widenedPorts(
  ports: readonly MspSerialPortRecord[],
  extra: number,
): readonly MspSerialPortRecord[] {
  const bytes: number[] = [ports.length];
  ports.forEach((port, index) => {
    bytes.push(port.identifier & 0xff);
    const mask = port.functionMask >>> 0;
    bytes.push(
      mask & 0xff,
      (mask >>> 8) & 0xff,
      (mask >>> 16) & 0xff,
      (mask >>> 24) & 0xff,
    );
    bytes.push(
      port.mspBaudIndex & 0xff,
      port.gpsBaudIndex & 0xff,
      port.telemetryBaudIndex & 0xff,
      port.blackboxBaudIndex & 0xff,
    );
    /* Distinct per port and per byte, so a save that shuffled records or
       shared one buffer between them could not go unnoticed. */
    for (let offset = 0; offset < extra; offset += 1) {
      bytes.push((0xa0 + index * 16 + offset) & 0xff);
    }
  });
  return decodeSerialPorts(Uint8Array.from(bytes));
}

async function openPorts(
  transform?: (snapshot: SerialPortsSnapshot) => SerialPortsSnapshot,
): Promise<Harness> {
  const observed = (await snapshotVia(
    o => new PortsConfigurationController(o),
  )) as SerialPortsSnapshot;
  const snapshot = transform === undefined ? observed : transform(observed);
  const saves: SaveCall[] = [];
  const loads: number[] = [];
  const controller = {
    load: async () => {
      loads.push(Date.now());
      return {kind: 'LOADED', snapshot};
    },
    save: async (
      _key: unknown,
      original: SerialPortsSnapshot,
      desired: readonly MspSerialPortRecord[],
    ) => {
      saves.push({original, desired});
      return {kind: 'NO_CHANGES', snapshot};
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <PortsScreen sessionKey={KEY} controller={controller as any} />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
  return {tree, snapshot, saves, loads};
}

/**
 * The node that CARRIES THE HANDLER, not merely the testID.
 *
 * A chip renders as a Pressable wrapping a View wrapping a Text, and all
 * three answer to the same testID. Taking the last match found the inner
 * one, whose `disabled` is undefined and whose `onPress` does not exist -
 * so a refused option looked like an absent option and was skipped
 * without a word. Every option below now resolves to the node that would
 * actually receive the touch.
 */
function handlerNode(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  handler: 'onPress' | 'onValueChange',
): ReactTestRenderer.ReactTestInstance | undefined {
  return tree.root
    .findAll(
      candidate =>
        (candidate.props as any)?.testID === testID &&
        typeof (candidate.props as any)?.[handler] === 'function',
      {deep: true},
    )
    .pop();
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const found = handlerNode(tree, testID, 'onPress');
  if (found === undefined || (found.props as any).disabled === true) {
    return false;
  }
  await act(async () => {
    (found.props as any).onPress();
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
  return true;
}

async function toggle(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  value: boolean,
): Promise<boolean> {
  const found = handlerNode(tree, testID, 'onValueChange');
  if (found === undefined || (found.props as any).disabled === true) {
    return false;
  }
  await act(async () => {
    (found.props as any).onValueChange(value);
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
  return true;
}

/** A chip the SCREEN is offering: rendered, enabled, not already chosen. */
function offeredChip(
  tree: ReactTestRenderer.ReactTestRenderer,
  pattern: RegExp,
): string | undefined {
  for (const candidate of tree.root.findAll(
    instance =>
      typeof (instance.props as any)?.testID === 'string' &&
      pattern.test((instance.props as any).testID) &&
      typeof (instance.props as any)?.onPress === 'function',
    {deep: true},
  )) {
    const props = candidate.props as any;
    if (props.disabled === true) continue;
    if (props.accessibilityState?.selected === true) continue;
    return String(props.testID);
  }
  return undefined;
}

async function expand(
  tree: ReactTestRenderer.ReactTestRenderer,
  identifier: number,
): Promise<void> {
  if (
    handlerNode(tree, `ports-${identifier}-msp`, 'onValueChange') === undefined
  ) {
    await press(tree, `ports-card-toggle-${identifier}`);
  }
}

function recordFor(
  call: SaveCall,
  identifier: number,
): MspSerialPortRecord | undefined {
  return call.desired.find(record => record.identifier === identifier);
}

function sameRecord(a: MspSerialPortRecord, b: MspSerialPortRecord): boolean {
  return (
    a.identifier === b.identifier &&
    a.functionMask === b.functionMask &&
    a.mspBaudIndex === b.mspBaudIndex &&
    a.gpsBaudIndex === b.gpsBaudIndex &&
    a.telemetryBaudIndex === b.telemetryBaudIndex &&
    a.blackboxBaudIndex === b.blackboxBaudIndex &&
    a.extensionBytes.length === b.extensionBytes.length &&
    a.extensionBytes.every((byte, index) => byte === b.extensionBytes[index])
  );
}

const BAUD_FIELDS: readonly SerialBaudField[] = [
  'mspBaudIndex',
  'gpsBaudIndex',
  'telemetryBaudIndex',
  'blackboxBaudIndex',
];
const CATEGORY_OF = {
  TELEMETRY: 'telemetry',
  SENSOR: 'sensors',
  PERIPHERAL: 'peripherals',
} as const;

type Kind = 'ROLE' | 'ROLE_SWITCH' | 'NONE' | 'BAUD';

interface MapRow {
  readonly port: number;
  readonly control: string;
  readonly kind: Kind;
  readonly draftField: string;
  readonly semantic: string;
  readonly verdict: string;
}

const MAPPING: MapRow[] = [];

/** How many options the screen SHOULD offer, so nothing goes unrecorded. */
function expectedOptionCount(snapshot: SerialPortsSnapshot): number {
  const perPort =
    SERIAL_ROLE_DEFINITIONS.length /* role chips */ +
    3 /* one NONE per category */ +
    2 /* MSP and Serial RX switches */ +
    BAUD_FIELDS.reduce(
      (sum, field) =>
        sum + availableBaudIndexes(field, snapshot.apiVersionMinor).length,
      0,
    );
  return snapshot.ports.length * perPort;
}

/**
 * Presses one option, reads the draft back through Save, and returns the
 * record the screen would have written - or nothing, with a verdict
 * saying why there is none. Every path through here records exactly one
 * row, which is what makes the accounting assertion possible.
 */
async function measure(
  harness: Harness,
  identifier: number,
  control: string,
  kind: Kind,
  draftField: string,
  semantic: string,
  perform: () => Promise<boolean>,
): Promise<MspSerialPortRecord | undefined> {
  const {tree, snapshot, saves} = harness;
  const row = (verdict: string): undefined => {
    MAPPING.push({port: identifier, control, kind, draftField, semantic, verdict});
    return undefined;
  };
  const node = handlerNode(
    tree,
    control,
    kind === 'ROLE_SWITCH' ? 'onValueChange' : 'onPress',
  );
  if (node === undefined) return row('NOT_RENDERED');
  if ((node.props as any).disabled === true) return row('REFUSED_UNSELECTABLE');
  if (!(await perform())) return row('PRESENT_BUT_NOT_PRESSABLE');

  const before = saves.length;
  await press(tree, 'ports-save');
  const call = saves[before];
  if (call === undefined) {
    row('ALREADY_THE_BOARD_VALUE');
    await press(tree, 'ports-reset');
    return undefined;
  }
  const written = recordFor(call, identifier)!;
  const disturbed = call.desired.filter(record => {
    if (record.identifier === identifier) return false;
    const origin = snapshot.ports.find(
      candidate => candidate.identifier === record.identifier,
    );
    return origin === undefined || !sameRecord(origin, record);
  });
  row(
    disturbed.length === 0
      ? 'ONE_UART_ONLY'
      : `DISTURBED:${disturbed.map(r => r.identifier).join(',')}`,
  );
  await press(tree, 'ports-reset');
  return written;
}

/* ==================================================================== *
 * 1 AND 4. EVERY OPTION, TO ITS FIRMWARE SEMANTIC OR ITS REFUSAL
 * ==================================================================== */

describe('a Ports option means one exact thing to the firmware', () => {
  it('every option on every UART is measured or refused, and nothing is skipped', async () => {
    const harness = await openPorts();
    const {tree, snapshot} = harness;
    expect(snapshot.ports.length).toBeGreaterThan(1);

    for (const port of snapshot.ports) {
      await expand(tree, port.identifier);
      const origin = (): MspSerialPortRecord =>
        snapshot.ports.find(record => record.identifier === port.identifier)!;

      /* THE TWO ROLE SWITCHES. MSP and Serial RX are not chips: they are
         switches with rules of their own (USB keeps MSP; USB never takes
         a serial receiver), and a chip-only loop never touches them. */
      for (const [testID, role] of [
        [`ports-${port.identifier}-msp`, 'MSP'],
        [`ports-${port.identifier}-rx`, 'RX_SERIAL'],
      ] as const) {
        const definition = SERIAL_ROLE_DEFINITIONS.find(d => d.key === role)!;
        const bit = (1 << definition.bit) >>> 0;
        const wanted = !hasSerialRole(origin(), role);
        const written = await measure(
          harness,
          port.identifier,
          testID,
          'ROLE_SWITCH',
          'functionMask',
          `bit ${definition.bit} (${role})`,
          () => toggle(tree, testID, wanted),
        );
        if (written !== undefined) {
          expect({
            control: testID,
            roleAfter: (written.functionMask & bit) !== 0,
          }).toEqual({control: testID, roleAfter: wanted});
        }
      }

      /* EVERY ROLE CHIP. */
      for (const definition of SERIAL_ROLE_DEFINITIONS) {
        const testID = `ports-${port.identifier}-role-${definition.key}`;
        const bit = (1 << definition.bit) >>> 0;
        const assigned = hasSerialRole(origin(), definition.key);
        const written = await measure(
          harness,
          port.identifier,
          testID,
          'ROLE',
          'functionMask',
          `bit ${definition.bit} (${definition.key})`,
          () => press(tree, testID),
        );
        if (written !== undefined) {
          /* Choosing inside a category clears that category's other
             roles - the group's own contract - so what must hold is that
             THIS role's bit ends up set. */
          expect({control: testID, bitSet: (written.functionMask & bit) !== 0})
            .toEqual({control: testID, bitSet: true});
          continue;
        }
        if (MAPPING[MAPPING.length - 1].verdict === 'REFUSED_UNSELECTABLE') {
          /* 4. A REFUSAL MUST BE THE MODEL'S, NOT A MOOD. A role the
             board is ALREADY running has to stay removable whatever the
             build evidence says - that is board truth, and an operator
             who cannot switch off a role they are running is stuck. */
          const available = serialRoleIsAvailable(
            snapshot,
            definition.key,
            assigned,
          );
          expect({
            control: testID,
            refusedWhileRunningOnTheBoard: assigned && available,
          }).toEqual({control: testID, refusedWhileRunningOnTheBoard: false});
        }
      }

      /* THE NONE CHIP OF EVERY CATEGORY. */
      for (const [category, key] of Object.entries(CATEGORY_OF)) {
        await measure(
          harness,
          port.identifier,
          `ports-${port.identifier}-${key}-none`,
          'NONE',
          'functionMask',
          `clear every ${category} bit`,
          () => press(tree, `ports-${port.identifier}-${key}-none`),
        );
      }

      /* EVERY BAUD CHIP THIS API VERSION OFFERS. */
      for (const field of BAUD_FIELDS) {
        for (const index of availableBaudIndexes(
          field,
          snapshot.apiVersionMinor,
        )) {
          const testID = `ports-${port.identifier}-${field}-${index}`;
          const label = SERIAL_BAUD_RATES[index];
          const written = await measure(
            harness,
            port.identifier,
            testID,
            'BAUD',
            field,
            `${label} (index ${index})`,
            () => press(tree, testID),
          );
          if (written !== undefined) {
            expect({control: testID, [field]: written[field]}).toEqual({
              control: testID,
              [field]: index,
            });
            const others = BAUD_FIELDS.filter(
              other => other !== field && written[other] !== origin()[other],
            );
            expect({control: testID, otherBaudFieldsMoved: others}).toEqual({
              control: testID,
              otherBaudFieldsMoved: [],
            });
          }
          /* The label the operator reads is a rate from the shipped
             table - index 0 is the firmware's own AUTO - not an index
             printed as if it were a rate. */
          expect({
            index,
            label,
            isARate: label === 'AUTO' || /^[1-9][0-9]+$/.test(label),
          }).toEqual({index, label, isARate: true});
        }
      }
    }
    await act(async () => tree.unmount());

    /* NOTHING WAS SKIPPED. Every option the screen could offer on every
       UART produced exactly one row - measured, refused, or absent with
       a name. This assertion is what made the suite honest: the first
       version silently dropped every build-gated role, because it looked
       for `disabled` on a node that never carried it. */
    expect({rows: MAPPING.length}).toEqual({
      rows: expectedOptionCount(snapshot),
    });
    /* One row per control, so nothing was counted twice. */
    expect(new Set(MAPPING.map(row => row.control)).size).toBe(MAPPING.length);
    /* No option moved a UART other than its own. */
    expect(MAPPING.filter(row => row.verdict.startsWith('DISTURBED'))).toEqual(
      [],
    );
    /* A rendered, enabled option that could not be pressed would be a
       control with no way to reach it. */
    expect(
      MAPPING.filter(row => row.verdict === 'PRESENT_BUT_NOT_PRESSABLE'),
    ).toEqual([]);
    /* THE REFUSALS ARE REAL. This board reports no build options, so the
       build-gated roles must actually be refused somewhere; a run where
       nothing was refused would leave rule 4 untested. */
    expect(
      MAPPING.filter(row => row.verdict === 'REFUSED_UNSELECTABLE').length,
    ).toBeGreaterThan(0);
    /* And something really was written, or rule 1 is untested too. */
    expect(
      MAPPING.filter(row => row.verdict === 'ONE_UART_ONLY').length,
    ).toBeGreaterThan(10);
  });
});

/* ==================================================================== *
 * 2. NOTHING REACHES THE BOARD BEFORE SAVE
 * ==================================================================== */

describe('a Ports selection is a draft until Save', () => {
  it('pressing every role and baud control writes nothing', async () => {
    const {tree, snapshot, saves} = await openPorts();
    let pressed = 0;
    for (const port of snapshot.ports) {
      await expand(tree, port.identifier);
      for (const role of SERIAL_ROLE_DEFINITIONS) {
        if (await press(tree, `ports-${port.identifier}-role-${role.key}`)) {
          pressed += 1;
        }
      }
      for (const key of Object.values(CATEGORY_OF)) {
        if (await press(tree, `ports-${port.identifier}-${key}-none`)) {
          pressed += 1;
        }
      }
      for (const field of BAUD_FIELDS) {
        for (const index of availableBaudIndexes(
          field,
          snapshot.apiVersionMinor,
        )) {
          if (await press(tree, `ports-${port.identifier}-${field}-${index}`)) {
            pressed += 1;
          }
        }
      }
      if (await toggle(tree, `ports-${port.identifier}-msp`, true)) pressed += 1;
      if (await toggle(tree, `ports-${port.identifier}-rx`, true)) pressed += 1;
    }
    /* THE SUBJECT EXISTS: a sweep that pressed nothing proves nothing. */
    expect(pressed).toBeGreaterThan(20);
    expect({pressed, wroteToTheBoard: saves.length}).toEqual({
      pressed,
      wroteToTheBoard: 0,
    });
    await act(async () => tree.unmount());
  });
});

/* ==================================================================== *
 * 3. SAVE CARRIES THE WHOLE TABLE, UNCHANGED EXCEPT WHERE ASKED
 * ==================================================================== */

describe('Save rewrites the table and disturbs nothing else', () => {
  it.each([
    ['the board as the fixture reports it', 0],
    ['a firmware carrying 3 extra per-port bytes this build does not model', 3],
  ] as const)('%s', async (_label, extra) => {
    const harness = await openPorts(observed =>
      extra === 0
        ? observed
        : ({
            ...observed,
            ports: widenedPorts(observed.ports, extra),
          } as SerialPortsSnapshot),
    );
    const {tree, snapshot, saves} = harness;

    /* THE SUBJECT EXISTS. With `extra > 0` there really are unowned
       bytes to lose; with 0 there are not, and that row is the control
       that says so out loud. */
    expect(
      snapshot.ports.every(port => port.extensionBytes.length === extra),
    ).toBe(true);

    const target = snapshot.ports.find(port => port.identifier !== 20)!;
    await expand(tree, target.identifier);
    const chip = offeredChip(
      tree,
      new RegExp(`^ports-${target.identifier}-(role-|mspBaudIndex-)`),
    );
    expect({uart: target.identifier, offeredSomething: chip !== undefined})
      .toEqual({uart: target.identifier, offeredSomething: true});
    expect(await press(tree, chip!)).toBe(true);

    await press(tree, 'ports-save');
    expect(saves.length).toBe(1);
    const call = saves[0];

    /* EVERY RECORD IS PRESENT, IN ORDER. A table that lost or reordered
       a UART would rewrite the board's ports onto the wrong pads. */
    expect(call.desired.map(record => record.identifier)).toEqual(
      snapshot.ports.map(record => record.identifier),
    );

    /* AND EVERY RECORD EXCEPT THE EDITED ONE IS THE ONE THAT WAS READ. */
    const changed = call.desired.filter(record => {
      const before = snapshot.ports.find(
        candidate => candidate.identifier === record.identifier,
      )!;
      return !sameRecord(before, record);
    });
    expect({changedUarts: changed.map(record => record.identifier)}).toEqual({
      changedUarts: [target.identifier],
    });

    /* THE UNOWNED TRAILING BYTES SPECIFICALLY - including on the record
       the operator DID edit, whose extra bytes have nothing to do with
       the role they picked. */
    for (const record of call.desired) {
      const before = snapshot.ports.find(
        candidate => candidate.identifier === record.identifier,
      )!;
      expect({
        uart: record.identifier,
        extensionBytes: [...record.extensionBytes],
      }).toEqual({
        uart: record.identifier,
        extensionBytes: [...before.extensionBytes],
      });
    }
    await act(async () => tree.unmount());
  });
});

/* ==================================================================== *
 * 5. RELOAD RETURNS THE BOARD, NOT THE ABANDONED DRAFT
 * ==================================================================== */

describe('Reload returns what the board reported', () => {
  it('an edit, then Reload, leaves the observed value on the screen', async () => {
    const {tree, snapshot, saves, loads} = await openPorts();
    const target = snapshot.ports.find(port => port.identifier !== 20)!;
    await expand(tree, target.identifier);

    const settled = JSON.stringify(tree.toJSON());
    const chip = offeredChip(
      tree,
      new RegExp(`^ports-${target.identifier}-role-`),
    );
    expect({offeredSomething: chip !== undefined}).toEqual({
      offeredSomething: true,
    });
    const roleKey = chip!.slice(
      `ports-${target.identifier}-role-`.length,
    ) as SerialRoleKey;
    const edited = await press(tree, chip!);
    /* THE EDIT REALLY HAPPENED, or this proves nothing. */
    expect({edited, changedTheScreen: JSON.stringify(tree.toJSON()) !== settled})
      .toEqual({edited: true, changedTheScreen: true});

    /* RELOAD ASKS FIRST, AND THAT IS THE PRODUCT BEING RIGHT.
       A dirty draft is not thrown away on one press: `requestReload`
       raises the discard confirmation. So both branches are measured -
       Cancel must keep the draft AND not re-read the board, Discard must
       do both. Treating the dialog as a dead end would score a careful
       screen as a broken one. */
    const buttons: {text?: string; style?: string; onPress?: () => void}[] = [];
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _body, actions) => {
        buttons.push(...((actions ?? []) as typeof buttons));
      });

    const loadsBefore = loads.length;
    const dirtyTree = JSON.stringify(tree.toJSON());
    await press(tree, 'ports-reload');
    expect({confirmationRaised: buttons.length}).toEqual({
      confirmationRaised: 2,
    });

    const cancel = buttons.find(button => button.style === 'cancel');
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel!.onPress?.();
      for (let round = 0; round < 6; round += 1) await Promise.resolve();
    });
    expect({
      afterCancel: {
        reReadTheBoard: loads.length !== loadsBefore,
        draftChanged: JSON.stringify(tree.toJSON()) !== dirtyTree,
      },
    }).toEqual({afterCancel: {reReadTheBoard: false, draftChanged: false}});

    const discard = buttons.find(button => button.style !== 'cancel');
    expect(discard).toBeDefined();
    await act(async () => {
      discard!.onPress?.();
      for (let round = 0; round < 10; round += 1) await Promise.resolve();
    });
    alert.mockRestore();
    expect(loads.length).toBeGreaterThan(loadsBefore);

    /* Reopen the same card: the role is what the BOARD says, not what
       the abandoned draft said. */
    await expand(tree, target.identifier);
    const after = handlerNode(tree, chip!, 'onPress');
    expect({
      role: roleKey,
      selectedAfterReload:
        (after?.props as any)?.accessibilityState?.selected === true,
    }).toEqual({
      role: roleKey,
      selectedAfterReload: hasSerialRole(target, roleKey),
    });
    /* And a discarded draft is never written. */
    expect(saves.length).toBe(0);
    await act(async () => tree.unmount());
  });
});

/* ==================================================================== *
 * THE MATRIX
 * ==================================================================== */

describe('the Ports mapping matrix', () => {
  it('prints it', () => {
    const byVerdict = new Map<string, number>();
    for (const row of MAPPING) {
      const key = row.verdict.startsWith('DISTURBED')
        ? 'DISTURBED'
        : row.verdict;
      byVerdict.set(key, (byVerdict.get(key) ?? 0) + 1);
    }
    const kinds: Kind[] = ['ROLE_SWITCH', 'ROLE', 'NONE', 'BAUD'];
    console.log(
      [
        '',
        '===== UI-X1D PORTS ROLE / BAUD MAPPING =====',
        `  options accounted for : ${MAPPING.length}`,
        ...kinds.map(
          kind =>
            `    ${kind.padEnd(12)} ${String(
              MAPPING.filter(row => row.kind === kind).length,
            ).padStart(4)}`,
        ),
        '',
        '  by outcome',
        ...[...byVerdict.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(
            ([verdict, count]) =>
              `    ${verdict.padEnd(28)} ${String(count).padStart(4)}`,
          ),
        '',
        '  UART  CONTROL                              DRAFT FIELD      FIRMWARE SEMANTIC                VERDICT',
        ...MAPPING.map(
          row =>
            `  ${String(row.port).padStart(4)}  ${row.control.padEnd(36)}` +
            ` ${row.draftField.padEnd(16)} ${row.semantic.padEnd(32)} ${row.verdict}`,
        ),
        '============================================',
        '',
      ].join('\n'),
    );
    expect(MAPPING.length).toBeGreaterThan(100);
    expect(MAPPING.filter(row => row.verdict.length === 0)).toEqual([]);
  });
});
