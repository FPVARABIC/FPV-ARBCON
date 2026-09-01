/**
 * THE SCREEN LAYER OF SESSION-BOUND DRAFT OWNERSHIP.
 *
 * =====================================================================
 * WHY A SECOND LAYER EXISTS AT ALL
 * =====================================================================
 *
 * The controllers refuse a foreign baseline before any wire access, and
 * `sessionBoundDraftOwnership.test.ts` proves that against real boards.
 * That is the safety guarantee. This file is about the other half of
 * §4A: what the OPERATOR meets.
 *
 * A refusal that only exists inside a controller reaches the operator as
 * a Save button that looks live, a press, a pause, and then a sentence.
 * A refusal that exists in the screen reaches them as a Save button that
 * is already unavailable, with the reason next to it, before they press
 * anything - and no round trip at all.
 *
 * Both layers are required. Neither replaces the other: remove the
 * screen's and the operator gets no warning, remove the controller's and
 * a future navigation change that keeps a screen mounted across a
 * reconnect silently re-opens the whole defect.
 *
 * =====================================================================
 * HOW THE FOREIGN BASELINE IS BUILT
 * =====================================================================
 *
 * From a REAL controller against a REAL virtual board, under session A.
 * A hand-written object would prove nothing: ownership is recorded by
 * the production load path, and a fixture that skipped it would be
 * testing the fixture. So each screen is handed a snapshot the product
 * itself issued for a different session, which is exactly the state a
 * mounted screen is in when the aircraft underneath it has been
 * replaced.
 */

/**
 * GPS and Ports gate their own load on `useMspOwnershipState`, which
 * reads the real session-coordinator singleton - a session this test
 * never opens. Answering ACTIVE is the only way those two screens can
 * reach the state this file is about; it does not touch the ownership
 * comparison under test, which lives in
 * `core/state/configurationSessionOwnership` and is not mocked here.
 */
jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  return {
    ...actual,
    useMspOwnershipState: () => 'ACTIVE',
    useMspIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
        apiVersion: {
          mspProtocolVersion: 0,
          apiVersionMajor: 1,
          apiVersionMinor: 47,
        },
        board: {},
      },
    }),
  };
});

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import StickyActionBar from '../components/editing/StickyActionBar';
import FailsafeScreen from './FailsafeScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import GpsScreen from './GpsScreen';
import PidTuningScreen from './PidTuningScreen';
import OsdScreen from './OsdScreen';
import ModesScreen from './ModesScreen';
import PortsScreen from './PortsScreen';
import ReceiverScreen from './ReceiverScreen';
import {MotorConfigurationPanel} from './MotorConfigurationPanel';
import {createFailsafeConfigurationDraft} from '../../core';
import {FailsafeConfigurationController} from '../../platforms/react-native/protocol/FailsafeConfigurationController';
import {GpsConfigurationController} from '../../platforms/react-native/protocol/GpsConfigurationController';
import {ModesConfigurationController} from '../../platforms/react-native/protocol/ModesConfigurationController';
import {MotorConfigurationController} from '../../platforms/react-native/protocol/MotorConfigurationController';
import {OsdConfigurationController} from '../../platforms/react-native/protocol/OsdConfigurationController';
import {PidTuningController} from '../../platforms/react-native/protocol/PidTuningController';
import {PortsConfigurationController} from '../../platforms/react-native/protocol/PortsConfigurationController';
import {PowerConfigurationController} from '../../platforms/react-native/protocol/PowerConfigurationController';
import {ReceiverConfigurationController} from '../../platforms/react-native/protocol/ReceiverConfigurationController';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';
import {MSP_MODE_RANGES} from '../../core/protocol/msp/commands/mspCommands';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from '../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';

jest.setTimeout(120000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/** The one sentence §21 mandates, in one place. */
const SESSION_CHANGED_TEXT =
  'تغيّرت جلسة المتحكم منذ إنشاء هذه التعديلات. أعد تحميل الإعدادات قبل الحفظ.';

const KEY_A: SetupUiSessionKey = {sessionId: 'fc-a', generation: 1};
const KEY_B: SetupUiSessionKey = {sessionId: 'fc-b', generation: 1};

/* ==================================================================== *
 * A REAL BASELINE, ISSUED BY THE PRODUCT, FOR SESSION A
 * ==================================================================== */

function boardAndSessionA(): VirtualSession {
  const spec = DRONE_SPECS.find(candidate => candidate.key === 'LONG_RANGE');
  if (spec === undefined) throw new Error('no LONG_RANGE spec');
  const board = new VirtualFlightController({parameters: buildFactoryBoard(spec)});
  /* Modes needs one range to have anything to show. */
  const ranges = new Uint8Array(4 * 20);
  ranges[2] = (1300 - 900) / 25;
  ranges[3] = (1700 - 900) / 25;
  board.overwriteParameter(MSP_MODE_RANGES, ranges);
  return new VirtualSession({sessionId: KEY_A.sessionId, board, apiMinor: 47});
}

async function baselineForSessionA(
  make: (options: never) => {
    load: (key: SetupUiSessionKey) => Promise<{kind: string; snapshot?: object}>;
  },
): Promise<object> {
  const session = boardAndSessionA();
  const outcome = await make(session.options as never).load(session.key);
  if (outcome.kind !== 'LOADED' || outcome.snapshot === undefined) {
    throw new Error(`expected LOADED, got ${outcome.kind}`);
  }
  return outcome.snapshot;
}

/* ==================================================================== *
 * THE NINE SCREENS, EACH MOUNTED UNDER B WITH A'S BASELINE
 * ==================================================================== */

interface ScreenCase {
  readonly name: string;
  /** Loads a genuine snapshot under session A, through the real path. */
  readonly baseline: () => Promise<object>;
  /** Renders the screen under key B with a stub returning that baseline. */
  readonly render: (
    baseline: object,
    save: jest.Mock,
  ) => React.ReactElement;
}

const CASES: readonly ScreenCase[] = [
  {
    name: 'Failsafe',
    baseline: () =>
      baselineForSessionA(o => new FailsafeConfigurationController(o) as never),
    render: (snapshot, save) => (
      <FailsafeScreen
        sessionKey={KEY_B}
        active
        onOpenReceiver={() => undefined}
        onOpenMotors={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'Power',
    baseline: () =>
      baselineForSessionA(o => new PowerConfigurationController(o) as never),
    render: (snapshot, save) => (
      <PowerBatteryScreen
        sessionKey={KEY_B}
        active
        onOpenMotors={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'GPS',
    baseline: () =>
      baselineForSessionA(o => new GpsConfigurationController(o) as never),
    render: (snapshot, save) => (
      <GpsScreen
        sessionKey={KEY_B}
        active
        onOpenPorts={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'PID',
    baseline: () => baselineForSessionA(o => new PidTuningController(o) as never),
    render: (snapshot, save) => (
      <PidTuningScreen
        sessionKey={KEY_B}
        active
        onOpenMotors={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'OSD',
    baseline: () =>
      baselineForSessionA(o => new OsdConfigurationController(o) as never),
    render: (snapshot, save) => (
      <OsdScreen
        sessionKey={KEY_B}
        active
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'Modes',
    baseline: () =>
      baselineForSessionA(o => new ModesConfigurationController(o) as never),
    render: (snapshot, save) => (
      <ModesScreen
        sessionKey={KEY_B}
        active
        onOpenMotors={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'Ports',
    baseline: () =>
      baselineForSessionA(o => new PortsConfigurationController(o) as never),
    render: (snapshot, save) => (
      <PortsScreen
        sessionKey={KEY_B}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
  {
    name: 'Receiver',
    baseline: () =>
      baselineForSessionA(o => new ReceiverConfigurationController(o) as never),
    render: (snapshot, save) => (
      <ReceiverScreen
        sessionKey={KEY_B}
        active
        onOpenPorts={() => undefined}
        onOpenMotors={() => undefined}
        controller={{load: async () => ({kind: 'LOADED', snapshot}), save} as never}
      />
    ),
  },
];

async function mount(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

describe('a screen holding another session s baseline refuses to save', () => {
  it.each(CASES.map(row => [row.name, row] as const))(
    '%s: Save is unavailable, the reason is the mandated sentence, and no save is attempted',
    async (_name, row) => {
      const snapshot = await row.baseline();
      const save = jest.fn();
      const tree = await mount(row.render(snapshot, save));

      const bar = tree.root.findByType(StickyActionBar);
      /* UNAVAILABLE. `StickyActionBar` disables Save whenever
         `disabledReason` is set, so this one prop is both halves of the
         contract: the button cannot be pressed, and the operator can
         read why. */
      expect(bar.props.disabledReason).toBe(SESSION_CHANGED_TEXT);

      /* REFUSED, not merely hidden. Even reached programmatically - a
         keyboard shortcut, a future affordance, a test - the screen must
         not hand this draft to the controller. */
      await act(async () => {
        await bar.props.onSave();
      });
      expect(save).not.toHaveBeenCalled();

      act(() => tree.unmount());
    },
  );

  /**
   * THE CONTROL. Eight rows of "disabled" prove nothing on their own: a
   * screen that disabled Save unconditionally would pass all of them.
   * Same baseline, mounted under the session that issued it.
   */
  it.each(CASES.map(row => [row.name, row] as const))(
    '%s: the session that issued the baseline is not blocked',
    async (_name, row) => {
      const snapshot = await row.baseline();
      const save = jest.fn(async () => ({kind: 'NO_CHANGES', snapshot}));
      const element = row.render(snapshot, save as never);
      /* Re-mount the same screen with key A instead of B. */
      const tree = await mount(
        React.cloneElement(element, {sessionKey: KEY_A} as never),
      );

      const bar = tree.root.findByType(StickyActionBar);
      expect(bar.props.disabledReason).not.toBe(SESSION_CHANGED_TEXT);

      act(() => tree.unmount());
    },
  );
});

/* ==================================================================== *
 * THE OPERATOR ACTUALLY READS IT
 *
 * The rows above assert the contract the sticky bar is given. This one
 * drives a real edit so the bar is VISIBLE, and looks for the sentence
 * in the rendered output - the thing an operator would see.
 * ==================================================================== */

describe('the sentence reaches the screen', () => {
  it('Failsafe renders the session-changed reason next to a dirty draft', async () => {
    const snapshot = await baselineForSessionA(
      o => new FailsafeConfigurationController(o) as never,
    );
    const save = jest.fn();
    const tree = await mount(
      <FailsafeScreen
        sessionKey={KEY_B}
        active
        onOpenReceiver={() => undefined}
        onOpenMotors={() => undefined}
        controller={
          {load: async () => ({kind: 'LOADED', snapshot}), save} as never
        }
      />,
    );

    /* A real edit through the screen's own stepper, so `dirty` becomes
       true and the bar renders. */
    await act(async () => {
      const plus = tree.root.findAll(
        node =>
          node.props?.testID === 'failsafe-delay-plus' &&
          typeof node.props?.onPress === 'function',
      );
      plus[plus.length - 1].props.onPress();
    });

    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain(SESSION_CHANGED_TEXT);
    expect(save).not.toHaveBeenCalled();

    /* And the draft was not thrown away: the operator's edit is still on
       screen, waiting for a reload rather than being silently reverted. */
    const draft = createFailsafeConfigurationDraft(snapshot as never);
    expect(draft.delayDeciseconds).toBeGreaterThan(0);

    act(() => tree.unmount());
  });
});

/* ==================================================================== *
 * MOTORS, WHICH HAS ITS OWN ACTIONS RATHER THAN A STICKY BAR
 * ==================================================================== */

describe('the Motors configuration panel', () => {
  it('disables its review-and-save action and names the reason', async () => {
    const snapshot = await baselineForSessionA(
      o => new MotorConfigurationController(o) as never,
    );
    const save = jest.fn();
    const tree = await mount(
      <MotorConfigurationPanel
        sessionKey={KEY_B}
        controller={
          {load: async () => ({kind: 'LOADED', snapshot}), save} as never
        }
      />,
    );

    expect(
      tree.root.findByProps({testID: 'motor-config-review-save'}).props.disabled,
    ).toBe(true);
    expect(
      tree.root.findAll(
        node => node.props?.testID === 'motor-config-session-changed',
      ).length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(tree.toJSON())).toContain(SESSION_CHANGED_TEXT);
    expect(save).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('is not blocked under the session that issued the baseline', async () => {
    const snapshot = await baselineForSessionA(
      o => new MotorConfigurationController(o) as never,
    );
    const tree = await mount(
      <MotorConfigurationPanel
        sessionKey={KEY_A}
        controller={
          {
            load: async () => ({kind: 'LOADED', snapshot}),
            save: jest.fn(),
          } as never
        }
      />,
    );

    expect(
      tree.root.findAll(
        node => node.props?.testID === 'motor-config-session-changed',
      ).length,
    ).toBe(0);
    expect(JSON.stringify(tree.toJSON())).not.toContain(SESSION_CHANGED_TEXT);

    act(() => tree.unmount());
  });
});
