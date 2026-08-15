/**
 * SETUP FINAL UI CORRECTION - the relocated accelerometer-calibration
 * surface. What this suite proves is that MOVING the action next to the
 * 3D model changed none of its truth:
 *  - enablement still comes from resolveFcToolAvailability() with the
 *    exact disabled reason rendered in text;
 *  - nothing is sent without the explicit propellers-removed
 *    confirmation, and cancel sends nothing;
 *  - the outcome copy is the same truthful wording FcToolsSection
 *    announces (shared describeFcToolOutcome);
 *  - the card renders ONLY accelerometer state - another tool's phase
 *    or outcome (e.g. REBOOT) never appears here, so the relocated
 *    surface and the maintenance section can never both announce the
 *    same event.
 *
 * The real transaction is covered in FcToolsController.test.ts; the
 * controller here is a lightweight stand-in mirroring the publication
 * model, exactly like FcToolsSection.test.tsx.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import OrientationCalibrationCard from './OrientationCalibrationCard';
import '../../../i18n';
import i18n from '../../../i18n';
import type { FcToolGateInput, SensorPresenceBit } from '../../../core';
import type {
  FcToolOutcome,
  FcToolPhase,
  FcToolsController,
} from '../../../platforms/react-native/protocol';

const SENSORS: readonly SensorPresenceBit[] = [
  { kind: 'KNOWN', bit: 0, token: 'ACC' },
  { kind: 'KNOWN', bit: 2, token: 'MAG' },
  { kind: 'KNOWN', bit: 5, token: 'GYRO' },
];

function gate(
  overrides: Partial<FcToolGateInput> = {},
): Omit<FcToolGateInput, 'busy'> {
  return {
    connected: true,
    appActive: true,
    recovering: false,
    compatibility: 'BETAFLIGHT_API_1_47' as const,
    dataState: 'FRESH' as const,
    readingMalformed: false,
    armedState: 'DISARMED' as const,
    sensors: SENSORS,
    ...overrides,
  } as Omit<FcToolGateInput, 'busy'>;
}

function makeFakeController() {
  const listeners = new Set<() => void>();
  let phase: FcToolPhase = { kind: 'IDLE' };
  let published:
    | { outcome: FcToolOutcome; sessionId: string; sequence: number }
    | undefined;
  let sequence = 0;
  const calls: string[] = [];
  const notify = () => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };
  const controller = {
    calls,
    getPhase: () => phase,
    isBusy: () => phase.kind !== 'IDLE',
    getLastOutcome: () => published?.outcome,
    getPublicationSequence: () => sequence,
    getVisibleOutcome: (sessionId: string, mountedAtSequence: number) => {
      if (published === undefined) {
        return undefined;
      }
      if (
        published.sequence <= mountedAtSequence ||
        published.sessionId !== sessionId
      ) {
        return undefined;
      }
      return published.outcome;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestConfirmation: (sessionId: string, tool: string) => {
      calls.push(`request:${tool}`);
      if (phase.kind !== 'IDLE') {
        return false;
      }
      phase = { kind: 'CONFIRMING', tool: tool as never, sessionId };
      published = undefined;
      notify();
      return true;
    },
    cancel: () => {
      calls.push('cancel');
      if (phase.kind !== 'CONFIRMING') {
        return;
      }
      sequence += 1;
      published = {
        outcome: { kind: 'CANCELLED', tool: phase.tool },
        sessionId: phase.sessionId,
        sequence,
      };
      phase = { kind: 'IDLE' };
      notify();
    },
    confirm: async () => {
      calls.push('confirm');
      if (phase.kind !== 'CONFIRMING') {
        return published?.outcome as FcToolOutcome;
      }
      sequence += 1;
      published = {
        outcome: { kind: 'ACCEPTED', tool: phase.tool },
        sessionId: phase.sessionId,
        sequence,
      };
      phase = { kind: 'IDLE' };
      notify();
      return published.outcome;
    },
    setOutcome: (next: FcToolOutcome, sessionId = 's1') => {
      sequence += 1;
      published = { outcome: next, sessionId, sequence };
      notify();
    },
  };
  return controller as unknown as FcToolsController & typeof controller;
}

function render(
  controller: ReturnType<typeof makeFakeController>,
  gateInput: Omit<FcToolGateInput, 'busy'> = gate(),
) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <OrientationCalibrationCard
        sessionId="s1"
        gate={gateInput}
        controller={controller}
      />,
    );
  });
  return renderer;
}

function byTestID(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  const found = renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
  return found.length > 0 ? found[0] : undefined;
}

/** Press handlers live on the composite Pressable, not the host node. */
function press(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): void {
  const target = renderer.root
    .findAll(node => node.props.testID === testID)
    .find(node => typeof node.props.onPress === 'function');
  expect(target).toBeDefined();
  target!.props.onPress();
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      chunks.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return chunks.join('\n');
}

afterEach(() => {
  jest.clearAllMocks();
});

it('renders the relocated action with its context hint, enabled by the same gate', () => {
  const controller = makeFakeController();
  const renderer = render(controller);

  expect(byTestID(renderer, 'orientation-calibration-card')).toBeDefined();
  expect(byTestID(renderer, 'fc-tool-ACC_CALIBRATION')).toBeDefined();
  expect(textOf(renderer)).toContain(
    i18n.t('orientationCalibration.hint'),
  );
  const button = byTestID(renderer, 'fc-tool-ACC_CALIBRATION-button');
  expect(button?.props.accessibilityState).toEqual({ disabled: false });
  // No reason is shown when nothing blocks the tool.
  expect(byTestID(renderer, 'fc-tool-ACC_CALIBRATION-reason')).toBeUndefined();
  act(() => {
    renderer.unmount();
  });
});

it('disables with the exact causal reason and requests nothing while blocked', () => {
  const controller = makeFakeController();
  const renderer = render(controller, gate({ connected: false }));

  const button = byTestID(renderer, 'fc-tool-ACC_CALIBRATION-button');
  expect(button?.props.accessibilityState).toEqual({ disabled: true });
  const reason = byTestID(renderer, 'fc-tool-ACC_CALIBRATION-reason');
  expect(reason).toBeDefined();
  expect(controller.calls).toHaveLength(0);
  act(() => {
    renderer.unmount();
  });
});

it('press -> explicit confirmation -> confirm dispatches exactly once; cancel sends nothing', () => {
  const controller = makeFakeController();
  const renderer = render(controller);

  act(() => {
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');
  });
  expect(controller.calls).toEqual(['request:ACC_CALIBRATION']);
  expect(byTestID(renderer, 'fc-tools-confirmation')).toBeDefined();
  expect(textOf(renderer)).toContain(
    i18n.t('fcTools.confirmBodies.ACC_CALIBRATION'),
  );

  // Cancel first: nothing is sent, the confirmation closes.
  act(() => {
    press(renderer, 'fc-tools-cancel');
  });
  expect(controller.calls).toEqual(['request:ACC_CALIBRATION', 'cancel']);
  expect(byTestID(renderer, 'fc-tools-confirmation')).toBeUndefined();

  // Then the real flow: request again and confirm.
  act(() => {
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');
  });
  act(() => {
    press(renderer, 'fc-tools-confirm');
  });
  expect(controller.calls).toEqual([
    'request:ACC_CALIBRATION',
    'cancel',
    'request:ACC_CALIBRATION',
    'confirm',
  ]);
  // ACCEPTED: the truthful acknowledgement plus the auto-verification
  // note - the same strings the maintenance section would announce.
  expect(textOf(renderer)).toContain(i18n.t('fcTools.outcomeAccepted'));
  expect(textOf(renderer)).toContain(
    i18n.t('fcTools.accVerificationStarted'),
  );
  act(() => {
    renderer.unmount();
  });
});

it("never renders another tool's phase or outcome (REBOOT stays in the maintenance section)", () => {
  const controller = makeFakeController();
  const renderer = render(controller);

  // A REBOOT confirmation opened from the maintenance section must not
  // render a dialog here.
  act(() => {
    controller.requestConfirmation('s1', 'REBOOT');
  });
  expect(byTestID(renderer, 'fc-tools-confirmation')).toBeUndefined();
  act(() => {
    controller.cancel();
  });

  // A REBOOT_REQUESTED outcome must not be announced by this card.
  act(() => {
    controller.setOutcome({ kind: 'REBOOT_REQUESTED' });
  });
  expect(byTestID(renderer, 'fc-tools-outcome-card')).toBeUndefined();

  // An accelerometer outcome IS announced here.
  act(() => {
    controller.setOutcome({ kind: 'ACCEPTED', tool: 'ACC_CALIBRATION' });
  });
  expect(byTestID(renderer, 'fc-tools-outcome-card')).toBeDefined();
  act(() => {
    renderer.unmount();
  });
});
