/* eslint-disable no-bitwise -- fixtures use the same function-mask notation as firmware. */
/*
 * WHAT THE OPERATOR IS TOLD WHEN A READ DID NOT ANSWER.
 *
 * These render the real PortsScreen against real snapshots and read the
 * rendered tree. The distinction under test is not cosmetic: "your
 * configuration is wrong" and "we could not check this" are different
 * claims, they lead to different actions, and before this work the
 * screen made the first claim on the evidence for neither.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {
  EVIDENCE_READ_FAILED,
  observedEvidence,
} from '../../core/state/serialPortsModel';
import type { MspSerialPortRecord } from '../../core/protocol/msp';
import type { SerialPortsSnapshot } from '../../core/state/serialPortsModel';

jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => ({ status: 'IDLE' }),
  useMspRecoveryState: () => 'READY',
}));

import PortsScreen, { type PortsControllerPort } from './PortsScreen';

const MSP_ROLE = 1 << 0;
const GPS = 1 << 1;
const TELEMETRY_FRSKY = 1 << 2;
const RX_SERIAL = 1 << 6;
const VTX_MSP = 1 << 17;

const SERIALRX_SBUS = 2;
const SERIALRX_CRSF = 9;
const BUILD_OPTION_GPS = 16412;
const BUILD_OPTION_FRSKY = 12301;

const key = { sessionId: 'ports-evidence', generation: 2 } as const;

const port = (
  identifier: number,
  functionMask: number,
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 4,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xa5]),
});

/** USB MSP, a shared RX+FrSky pad, and one free UART. */
const BOARD = Object.freeze([
  port(20, MSP_ROLE),
  port(0, RX_SERIAL | TELEMETRY_FRSKY),
  port(1, 0),
]);

function snapshot(
  options: Partial<SerialPortsSnapshot> = {},
): SerialPortsSnapshot {
  return Object.freeze({
    ports: BOARD,
    featureMaskRaw: (1 << 3) | (1 << 10),
    apiVersionMajor: 1,
    apiVersionMinor: 48,
    serialRxProvider: observedEvidence(SERIALRX_SBUS),
    buildOptionIds: observedEvidence<ReadonlySet<number>>(
      new Set([BUILD_OPTION_GPS, BUILD_OPTION_FRSKY]),
    ),
    vtxTable: observedEvidence({ tableAvailable: true, tableConfigured: true }),
    ...options,
  });
}

function controllerFor(value: SerialPortsSnapshot): PortsControllerPort & {
  save: jest.MockedFunction<PortsControllerPort['save']>;
} {
  return {
    load: jest.fn(async () => ({ kind: 'LOADED' as const, snapshot: value })),
    save: jest.fn(async (_key, original) => ({
      kind: 'NO_CHANGES' as const,
      snapshot: original,
    })),
  } as unknown as PortsControllerPort & {
    save: jest.MockedFunction<PortsControllerPort['save']>;
  };
}

async function render(controller: PortsControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <PortsScreen sessionKey={key} controller={controller} />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    find: (testID: string) => renderer.root.findAllByProps({ testID })[0],
    query: (testID: string) => renderer.root.findAllByProps({ testID }),
    press: async (testID: string) => {
      await ReactTestRenderer.act(async () => {
        renderer.root.findAllByProps({ testID })[0].props.onPress();
        await Promise.resolve();
      });
    },
    /** Every rendered string beneath the node carrying `testID`. The
     * oracle is what the screen actually puts on the page, not a prop. */
    textUnder: (testID: string) =>
      renderer.root
        .findAllByProps({ testID })[0]
        .findAll(node => typeof node.type === 'string' || node.type === Text)
        .flatMap(node => flattenText(node.props.children)),
    /** Every string the page renders, for duplicate-copy detection. */
    allText: () =>
      renderer.root
        .findAllByType(Text)
        .flatMap(node => flattenText(node.props.children)),
    unmount: () => ReactTestRenderer.act(() => renderer.unmount()),
  };
}

function flattenText(children: unknown): string[] {
  if (typeof children === 'string') return [children];
  if (Array.isArray(children)) return children.flatMap(flattenText);
  return [];
}

const t = (key_: string) => i18n.t(key_);

/* ================================================================== *
 * A - AN UNREAD PROVIDER IS SHOWN AS DOUBT, NOT AS A FAULT
 * ================================================================== */

describe('A. a failed provider read', () => {
  it('reports an uncertainty and raises no validation error', async () => {
    const screen = await render(
      controllerFor(snapshot({ serialRxProvider: EVIDENCE_READ_FAILED })),
    );
    expect(screen.query('ports-evidence-uncertainties').length).toBeGreaterThan(
      0,
    );
    expect(screen.query('ports-validation-errors')).toHaveLength(0);
    screen.unmount();
  });

  it('leaves an unrelated edit saveable', async () => {
    const controller = controllerFor(
      snapshot({ serialRxProvider: EVIDENCE_READ_FAILED }),
    );
    const screen = await render(controller);
    await screen.press('ports-card-toggle-1');
    await screen.press('ports-1-role-BLACKBOX');
    // Pre-fix, the fabricated provider 0 made this board invalid and the
    // Save control stayed disabled for every edit on the page.
    expect(screen.find('ports-save').props.disabled).toBe(false);
    await screen.press('ports-save');
    expect(controller.save).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('names the port it could not judge', async () => {
    const screen = await render(
      controllerFor(snapshot({ serialRxProvider: EVIDENCE_READ_FAILED })),
    );
    expect(screen.textUnder('ports-evidence-uncertainties').join(' ')).toContain(
      'UART1',
    );
    screen.unmount();
  });
});

/* ================================================================== *
 * B - A PROVEN FAULT STILL READS AS A FAULT
 * ================================================================== */

describe('B. an observed provider that really is incompatible', () => {
  const invalid = snapshot({
    serialRxProvider: observedEvidence(SERIALRX_CRSF),
  });

  it('reports a validation error and no uncertainty', async () => {
    const screen = await render(controllerFor(invalid));
    expect(screen.query('ports-validation-errors').length).toBeGreaterThan(0);
    expect(screen.query('ports-evidence-uncertainties')).toHaveLength(0);
    screen.unmount();
  });

  it('blocks Save, because this is a claim we can make', async () => {
    const controller = controllerFor(invalid);
    const screen = await render(controller);
    await screen.press('ports-card-toggle-1');
    await screen.press('ports-1-role-BLACKBOX');
    expect(screen.find('ports-save').props.disabled).toBe(true);
    expect(controller.save).not.toHaveBeenCalled();
    screen.unmount();
  });
});

/* ================================================================== *
 * C/D - "NOT VERIFIED" AND "NOT COMPILED" ARE DIFFERENT SENTENCES
 * ================================================================== */

describe('C. a failed build-inventory read', () => {
  const unread = snapshot({ buildOptionIds: EVIDENCE_READ_FAILED });

  it('withholds a build-gated role the board is not already running', async () => {
    const screen = await render(controllerFor(unread));
    await screen.press('ports-card-toggle-1');
    // Pre-fix this control was enabled, presenting an unproven role as
    // compiled, and the resulting write went out unchallenged.
    expect(screen.find('ports-1-role-GPS').props.disabled).toBe(true);
    screen.unmount();
  });

  it('says the capability is unverified, not that it is absent', async () => {
    const screen = await render(controllerFor(unread));
    await screen.press('ports-card-toggle-1');
    const chip = screen.textUnder('ports-1-role-GPS');
    expect(chip).toContain(t('portsConfiguration.compilationUnverified'));
    expect(chip).not.toContain(t('portsConfiguration.notCompiled'));
    screen.unmount();
  });

  it('lists one uncertainty per gated role the board actually runs', async () => {
    const screen = await render(controllerFor(unread));
    expect(screen.textUnder('ports-evidence-uncertainties').join(' ')).toContain(
      t('portsConfiguration.roles.TELEMETRY_FRSKY'),
    );
    screen.unmount();
  });
});

describe('D. an observed inventory that omits the option', () => {
  it('withholds the role and says it is absent from the build', async () => {
    const screen = await render(
      controllerFor(
        snapshot({
          buildOptionIds: observedEvidence(new Set([BUILD_OPTION_FRSKY])),
        }),
      ),
    );
    await screen.press('ports-card-toggle-1');
    expect(screen.find('ports-1-role-GPS').props.disabled).toBe(true);
    const chip = screen.textUnder('ports-1-role-GPS');
    expect(chip).toContain(t('portsConfiguration.notCompiled'));
    expect(chip).not.toContain(t('portsConfiguration.compilationUnverified'));
    screen.unmount();
  });

  it('offers the role when the inventory lists it', async () => {
    const screen = await render(controllerFor(snapshot()));
    await screen.press('ports-card-toggle-1');
    expect(screen.find('ports-1-role-GPS').props.disabled).toBe(false);
    const chip = screen.textUnder('ports-1-role-GPS');
    expect(chip).toContain(t('portsConfiguration.roles.GPS'));
    expect(chip).not.toContain(t('portsConfiguration.notCompiled'));
    expect(chip).not.toContain(t('portsConfiguration.compilationUnverified'));
    screen.unmount();
  });
});

/* ================================================================== *
 * E - BOARD TRUTH OUTRANKS MISSING EVIDENCE
 * ================================================================== */

describe('E. a gated role the board already runs', () => {
  it('stays operable while the inventory is unknown, so it can be removed', async () => {
    const screen = await render(
      controllerFor(snapshot({ buildOptionIds: EVIDENCE_READ_FAILED })),
    );
    await screen.press('ports-card-toggle-0');
    // UART1 runs FrSky telemetry. Whatever the build read did, that is
    // what the board is doing, and locking the control would trap the
    // operator with a role they cannot take off.
    expect(screen.find('ports-0-role-TELEMETRY_FRSKY').props.disabled).toBe(
      false,
    );
    screen.unmount();
  });

  it('is decided by the FC record, not by what the draft currently shows', async () => {
    const screen = await render(
      controllerFor(snapshot({ buildOptionIds: EVIDENCE_READ_FAILED })),
    );
    await screen.press('ports-card-toggle-1');
    // The free UART does not run GPS on the board, so picking it in the
    // draft must not be what authorises it.
    expect(screen.find('ports-1-role-GPS').props.disabled).toBe(true);
    screen.unmount();
  });
});

/* ================================================================== *
 * F - THE VTX TABLE: EMPTY, ABSENT, AND UNKNOWN ARE THREE THINGS
 * ================================================================== */

describe('F. the VTX table diagnostic', () => {
  const withVtx = (vtxTable: SerialPortsSnapshot['vtxTable']) =>
    snapshot({
      ports: Object.freeze([
        port(20, MSP_ROLE),
        port(0, MSP_ROLE | VTX_MSP),
        port(1, 0),
      ]),
      vtxTable,
    });

  it('warns when the board says its table is available and incomplete', async () => {
    const screen = await render(
      controllerFor(
        withVtx(
          observedEvidence({ tableAvailable: true, tableConfigured: false }),
        ),
      ),
    );
    expect(screen.query('ports-vtx-table-warning').length).toBeGreaterThan(0);
    expect(screen.query('ports-evidence-uncertainties')).toHaveLength(0);
    screen.unmount();
  });

  it('says nothing when the board says it has no table', async () => {
    const screen = await render(
      controllerFor(
        withVtx(
          observedEvidence({ tableAvailable: false, tableConfigured: false }),
        ),
      ),
    );
    expect(screen.query('ports-vtx-table-warning')).toHaveLength(0);
    expect(screen.query('ports-evidence-uncertainties')).toHaveLength(0);
    screen.unmount();
  });

  it('says it could not check when the read failed', async () => {
    const screen = await render(controllerFor(withVtx(EVIDENCE_READ_FAILED)));
    // Pre-fix this rendered as nothing at all, so a failed read was
    // indistinguishable from a healthy VTX table. It is said exactly
    // once, in the uncertainties card, and never as the board's own
    // "your table is incomplete" claim.
    expect(
      screen.textUnder('ports-evidence-uncertainties').join(' '),
    ).toContain(t('portsConfiguration.uncertainty.VTX_TABLE_NOT_VERIFIED'));
    expect(screen.query('ports-vtx-table-warning')).toHaveLength(0);
    screen.unmount();
  });

  it('says it exactly once - no second copy anywhere on the page', async () => {
    const screen = await render(controllerFor(withVtx(EVIDENCE_READ_FAILED)));
    const sentence = t('portsConfiguration.uncertainty.VTX_TABLE_NOT_VERIFIED');
    expect(screen.allText().filter(line => line.includes(sentence))).toHaveLength(
      1,
    );
    screen.unmount();
  });

  it('does not block saving - the table gates no port configuration', async () => {
    const controller = controllerFor(withVtx(EVIDENCE_READ_FAILED));
    const screen = await render(controller);
    await screen.press('ports-card-toggle-1');
    await screen.press('ports-1-role-BLACKBOX');
    expect(screen.find('ports-save').props.disabled).toBe(false);
    screen.unmount();
  });
});

/* ================================================================== *
 * THE TWO CARDS ARE SEPARATE SURFACES
 * ================================================================== */

describe('issues and uncertainties are presented apart', () => {
  it('renders both, distinctly, when a board has one of each', async () => {
    const screen = await render(
      controllerFor(
        snapshot({
          // Two ports claim GPS: a real, evidence-free validation fault.
          ports: Object.freeze([
            port(20, MSP_ROLE),
            port(0, GPS),
            port(1, GPS),
          ]),
          serialRxProvider: EVIDENCE_READ_FAILED,
          buildOptionIds: EVIDENCE_READ_FAILED,
        }),
      ),
    );
    expect(screen.query('ports-validation-errors').length).toBeGreaterThan(0);
    expect(screen.query('ports-evidence-uncertainties').length).toBeGreaterThan(
      0,
    );
    screen.unmount();
  });

  it('renders neither on a board whose reads all answered', async () => {
    const screen = await render(controllerFor(snapshot()));
    expect(screen.query('ports-validation-errors')).toHaveLength(0);
    expect(screen.query('ports-evidence-uncertainties')).toHaveLength(0);
    screen.unmount();
  });
});
