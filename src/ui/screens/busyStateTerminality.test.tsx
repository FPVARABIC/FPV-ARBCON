/**
 * A REJECTED CONTROLLER CALL MUST NOT LEAVE A SCREEN BUSY.
 *
 * =====================================================================
 * THE DEFECT THIS FILE EXISTS FOR
 * =====================================================================
 *
 * Every configuration screen here awaits a controller that returns a
 * DISCRIMINATED OUTCOME - `{kind: 'LOADED'}`, `{kind: 'FAILED'}` and so
 * on. Because the outcome type covers failure, the screens were written
 * as if the Promise could not reject. It can: `capture()` reads
 * coordinator state before any try block, the interlock acquisition can
 * throw, and an unexpected TypeError anywhere inside is a rejection like
 * any other.
 *
 * When that happened the screen had ALREADY entered its busy phase. The
 * throw skipped every line that would have left it, so the operator was
 * left looking at «جارٍ القراءة…» or a spinning save bar with no
 * message, no error, and no way back except reloading the application.
 *
 * =====================================================================
 * WHAT IS ASSERTED, AND WHY IT IS THE LOADING TEXT
 * =====================================================================
 *
 * Each screen renders a distinctive Arabic sentence while it is loading.
 * That sentence IS the busy state as the operator experiences it, so its
 * disappearance is the property worth testing - more so than an internal
 * phase value, which could be renamed without the screen changing.
 *
 * livenessContract.test.ts guards the SHAPE of these call sites so a new
 * screen cannot reintroduce the pattern. This file proves the shape
 * actually produces the behaviour.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import FailsafeScreen from './FailsafeScreen';
import ModesScreen from './ModesScreen';
import OsdScreen from './OsdScreen';
import PidTuningScreen from './PidTuningScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import ReceiverScreen from './ReceiverScreen';
import VideoTransmitterScreen from './VideoTransmitterScreen';

const SESSION = {sessionId: 'fc', generation: 1} as const;

/** The controller call throws instead of returning an outcome. */
const rejecting = () => ({
  load: jest.fn(async () => {
    throw new Error('the coordinator was not in the state anyone expected');
  }),
  save: jest.fn(async () => {
    throw new Error('the coordinator was not in the state anyone expected');
  }),
  readRuntime: jest.fn(async () => {
    throw new Error('runtime read exploded');
  }),
  selectProfile: jest.fn(async () => {
    throw new Error('profile switch exploded');
  }),
  requestReboot: jest.fn(async () => {
    throw new Error('reboot request exploded');
  }),
});

/** Every visible string in the rendered tree, flattened. */
function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join(' ');
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return walk((node as {children: unknown}).children);
    }
    return '';
  };
  return walk(renderer.toJSON() as unknown);
}

type ScreenCase = {
  readonly name: string;
  readonly render: (
    controller: ReturnType<typeof rejecting>,
  ) => React.JSX.Element;
  /** The sentence the operator stares at while the screen is busy. */
  readonly busyText: string;
  /** What the screen must say once it gives up. */
  readonly failedText: string;
};

const CASES: readonly ScreenCase[] = [
  {
    name: 'Modes',
    render: controller => (
      <ModesScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة أسماء الأوضاع',
    failedText: 'تعذرت قراءة جدول الأوضاع',
  },
  {
    name: 'OSD',
    render: controller => (
      <OsdScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة',
    failedText: 'تعذرت قراءة',
  },
  {
    name: 'Failsafe',
    render: controller => (
      <FailsafeScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        onOpenReceiver={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة Failsafe',
    failedText: 'تعذرت قراءة',
  },
  {
    name: 'PID tuning',
    render: controller => (
      <PidTuningScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة PID',
    failedText: 'تعذرت قراءة إعدادات PID',
  },
  {
    name: 'Power and battery',
    render: controller => (
      <PowerBatteryScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة البطارية',
    failedText: 'تعذرت قراءة إعدادات الطاقة',
  },
  {
    name: 'Receiver',
    render: controller => (
      <ReceiverScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        onOpenPorts={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة إعدادات الريسيفر',
    failedText: 'فشلت العملية قبل اكتمال التحقق',
  },
  {
    name: 'Video transmitter',
    render: controller => (
      <VideoTransmitterScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    busyText: 'جارٍ قراءة VTX',
    failedText: 'تعذرت قراءة VTX',
  },
];

describe('a rejected load leaves the screen in a terminal state', () => {
  it.each(CASES.map(entry => [entry.name, entry] as const))(
    '%s stops loading and says so',
    async (_name, testCase) => {
      const controller = rejecting();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(testCase.render(controller));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const rendered = textOf(renderer);
      expect(controller.load).toHaveBeenCalled();
      // The busy sentence is GONE...
      expect(`${testCase.name}: ${rendered.includes(testCase.busyText)}`).toBe(
        `${testCase.name}: false`,
      );
      // ...and replaced by something that tells the operator what
      // happened. A blank screen would satisfy the first assertion alone.
      expect(`${testCase.name}: ${rendered.includes(testCase.failedText)}`).toBe(
        `${testCase.name}: true`,
      );
      // And whatever it settled on, it offers a way to try again rather
      // than a dead end.
      expect(rendered).toContain('إعادة');

      ReactTestRenderer.act(() => renderer.unmount());
    },
  );

  /**
   * THE CONTROL. If the screens showed no loading text at all, the
   * assertions above would pass for the wrong reason. This proves the
   * busy sentence is genuinely there before the rejection lands.
   */
  it('the busy sentence really is on screen before the call settles', async () => {
    let release!: () => void;
    const controller = {
      ...rejecting(),
      load: jest.fn(
        () =>
          new Promise((_resolve, reject) => {
            release = () => reject(new Error('late failure'));
          }),
      ),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ModesScreen
          sessionKey={SESSION}
          active
          onOpenMotors={() => undefined}
          controller={controller as never}
        />,
      );
      await Promise.resolve();
    });
    expect(textOf(renderer)).toContain('جارٍ قراءة أسماء الأوضاع');

    await ReactTestRenderer.act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textOf(renderer)).not.toContain('جارٍ قراءة أسماء الأوضاع');

    ReactTestRenderer.act(() => renderer.unmount());
  });
});

describe('a rejected save leaves the save bar in a terminal state', () => {
  /**
   * Driven through the sticky bar's own save handler, because that is
   * the control the operator presses. The bar's `busy` prop is what
   * renders the spinner label, so asserting on it is asserting on what
   * the operator sees.
   */
  async function saveThroughTheBar(
    element: React.JSX.Element,
    barTestId: string,
    loadedController: {save: jest.Mock},
  ): Promise<{busyAfter: boolean}> {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(element);
      await Promise.resolve();
      await Promise.resolve();
    });
    const bar = renderer.root.findAllByProps({testID: barTestId})[0];
    await ReactTestRenderer.act(async () => {
      (bar.props as {onSave: () => void}).onSave();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadedController.save).toHaveBeenCalled();
    const after = renderer.root.findAllByProps({testID: barTestId})[0];
    const busyAfter = (after.props as {busy: boolean}).busy;
    ReactTestRenderer.act(() => renderer.unmount());
    return {busyAfter};
  }

  it('Power & battery: the bar stops spinning when save throws', async () => {
    // The exact snapshot PowerBatteryScreen.test.tsx already proves
    // loads cleanly, so this test is about the save path and nothing
    // else.
    const snapshot = {
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 430,
        warningCellCentivolts: 350,
        capacityMah: 1500,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      voltageMeters: [
        {id: 10, sensorType: 0, scale: 110, divider: 10, multiplier: 1},
      ],
      currentMeters: [{id: 10, sensorType: 1, scale: 400, offset: 0}],
    };
    const controller = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})),
      save: jest.fn(async () => {
        throw new Error('save exploded');
      }),
    };
    const {busyAfter} = await saveThroughTheBar(
      <PowerBatteryScreen
        sessionKey={SESSION}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />,
      'power-save-bar',
      controller,
    );
    expect(busyAfter).toBe(false);
  });
});
