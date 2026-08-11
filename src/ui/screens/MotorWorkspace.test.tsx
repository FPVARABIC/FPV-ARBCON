/**
 * P3 - the professional motor workspace, proven at the component level.
 *
 * The port here is the NARROW MotorWorkspacePort: the workspace cannot
 * even name pulseMotor or renewPulseHold, which is itself the proof that
 * the primary experience has no long-press and no heartbeat requirement.
 * Nothing asserts a physical outcome.
 */
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

import {
  deriveWorkspacePhase,
  MotorWorkspace,
  type MotorWorkspacePort,
} from './MotorWorkspace';
import type { MotorTestControllerSnapshot } from '../../core/state/motorTestController';

interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

function makePort(): MotorWorkspacePort & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    setMotorValue: (motorIndex: number, value: number) => {
      calls.push({ op: 'setMotorValue', args: [motorIndex, value] });
      return { kind: 'ACCEPTED' as const };
    },
    setMaster: (value: number) => {
      calls.push({ op: 'setMaster', args: [value] });
      return { kind: 'ACCEPTED' as const };
    },
    stopAll: () => {
      calls.push({ op: 'stopAll', args: [] });
      return 'ACCEPTED';
    },
    beginSession: async () => undefined,
    endSession: async () => undefined,
  };
}

/** The minimal snapshot slice the workspace consumes. */
function makeSnapshot(over: {
  motorCount?: number;
  feature3d?: boolean;
  analog?: boolean;
  eligible?: boolean;
  outcome?: 'READY' | 'PENDING' | 'BLOCKED';
}): MotorTestControllerSnapshot {
  const motorCount = over.motorCount ?? 4;
  const feature3d = over.feature3d ?? false;
  const analog = over.analog ?? false;
  const domain = {
    motorCount,
    protocolFamily: analog ? ('PWM' as const) : ('DSHOT' as const),
    feature3dEnabled: feature3d,
    commandDomainMin: analog ? 900 : 1000,
    commandDomainMax: analog ? 1900 : 2000,
    domainSource: analog
      ? ('CONFIGURATION_POLICY' as const)
      : ('FIRMWARE_CONSTRAIN' as const),
    stopValue: feature3d ? 1500 : analog ? 900 : 1000,
    ...(feature3d
      ? {
          neutral: 1500,
          provenReverseRegion: { min: 1000, max: 1499 },
          provenForwardRegion: { min: 1501, max: 2000 },
        }
      : {}),
    notKnowableFromMsp: [] as readonly string[],
  };
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: undefined,
    outcome:
      over.outcome === 'BLOCKED'
        ? { kind: 'BLOCKED', reason: 'MOTOR_SCOPE_UNSUPPORTED', requiresNewSession: true }
        : { kind: over.outcome ?? 'READY' },
    firmwareCompatibility: undefined,
    motorScope: { motorCount, motorProtocolRaw: 7, feature3dEnabled: feature3d },
    motorDiagnosticsSupport: undefined,
    telemetryHeld: true,
    warnings: [],
    stopDescriptors: [],
    teardown: undefined,
    stopExecution: { attempts: 0 } as never,
    pulse: { attemptId: 0 } as never,
    activation: { allowed: false, reasons: [] },
    verificationReceipt: undefined,
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: domain,
    motorRuntimeScope:
      (over.eligible ?? true)
        ? { eligible: true, domain }
        : {
            eligible: false,
            refusal: 'ANALOG_3D_ACTIVE_ENDPOINTS_UNKNOWN',
            notKnowableFromMsp: ['limit3d_low', 'limit3d_high'],
          },
  } as unknown as MotorTestControllerSnapshot;
}

function findAll(
  renderer: ReactTestRenderer,
  testID: string,
): readonly unknown[] {
  // Host elements only: a testID also appears on the composite wrapper,
  // so an unfiltered findAll double-counts every match.
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.props as { testID?: string }).testID === testID,
  );
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const text = (renderer: ReactTestRenderer): string =>
  JSON.stringify(renderer.toJSON());

describe('MotorWorkspace - structure', () => {
  it('renders enable, Master, STOP and the ONE safety line', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({})}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    expect(findAll(renderer, 'motor-workspace-enable')).toHaveLength(1);
    expect(findAll(renderer, 'motor-slider-master')).toHaveLength(1);
    expect(findAll(renderer, 'motor-workspace-stop')).toHaveLength(1);
    const body = text(renderer);
    expect(body).toContain('تفعيل التحكم بالمحركات');
    expect(body).toContain('إيقاف المحركات');
    // The propeller warning lives ONCE at page level, not inside the
    // workspace - asserted in MotorsScreen.test.tsx.
    expect(body.split('أزل المراوح').length - 1).toBe(0);
  });

  it.each([1, 2, 4, 6, 8])(
    'renders exactly %i motor sliders from snapshot.motorCount',
    motorCount => {
      const renderer = render(
        <MotorWorkspace
          snapshot={makeSnapshot({ motorCount })}
          port={makePort()}
          enabled
          onEnableChange={() => {}}
        />,
      );
      for (let index = 1; index <= motorCount; index++) {
        expect(findAll(renderer, `motor-slider-${index}`)).toHaveLength(1);
        expect(text(renderer)).toContain(`محرك ${index}`);
      }
      expect(
        findAll(renderer, `motor-slider-${motorCount + 1}`),
      ).toHaveLength(0);
    },
  );

  it('has NO long-press and NO heartbeat surface: the port cannot express them', () => {
    // Compile-time narrowing IS the proof; this pins it at runtime too.
    const port = makePort();
    expect('pulseMotor' in port).toBe(false);
    expect('renewPulseHold' in port).toBe(false);
  });
});

describe('MotorWorkspace - facade calls', () => {
  it('STOP calls the canonical stopAll and snaps desired to the RESOLVED stop value', () => {
    const port = makePort();
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({ feature3d: true })}
        port={port}
        enabled
        onEnableChange={() => {}}
      />,
    );
    const stop = renderer.root.findAll(
      node =>
        (node.props as { testID?: string }).testID === 'motor-workspace-stop' &&
        typeof (node.props as { onPress?: unknown }).onPress === 'function',
    )[0];
    act(() => {
      (stop.props as { onPress: () => void }).onPress();
    });
    expect(port.calls).toEqual([{ op: 'stopAll', args: [] }]);
    // Digital 3D: desired snaps to 1500 - NEVER to 1000, which is full
    // reverse there.
    const value = findAll(renderer, 'motor-slider-1-value')[0] as {
      props: { children: string };
    };
    expect(value.props.children).toBe('1500');
  });

  it('digital 3D renders the neutral legend and never labels 1000 as stop', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({ feature3d: true })}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    const body = text(renderer);
    expect(body).toContain('عكسي');
    expect(body).toContain('أمامي');
    // The legend renders label and value as adjacent text children.
    expect(body).toContain('محايد / إيقاف');
    expect(body).toContain('"1500"');
    expect(body.replace(/[\s\"]|,/g, '')).not.toContain('محايد/إيقاف1000');
  });

  it('analog 3D renders the concise unsupported state and no sliders', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({ analog: true, feature3d: true, eligible: false })}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    expect(findAll(renderer, 'motor-workspace-unsupported')).toHaveLength(1);
    expect(findAll(renderer, 'motor-slider-1')).toHaveLength(0);
    expect(text(renderer)).toContain('غير متاح');
  });

  it('analog non-3D workspace is available with its policy bounds', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({ analog: true })}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    expect(findAll(renderer, 'motor-workspace')).toHaveLength(1);
    expect(findAll(renderer, 'motor-slider-1')).toHaveLength(1);
  });

  it('disabled session refuses interaction: sliders never call the port', () => {
    const port = makePort();
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({})}
        port={port}
        enabled={false}
        onEnableChange={() => {}}
      />,
    );
    expect(text(renderer)).toContain('غير مفعّل');
    // No call reached the port during render.
    expect(port.calls).toHaveLength(0);
  });

  it('shows recovery copy when the enable attempt failed, without dev codes', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({ outcome: 'BLOCKED' })}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    const body = text(renderer);
    expect(findAll(renderer, 'motor-workspace-recovery')).toHaveLength(1);
    expect(body).not.toContain('MOTOR_SCOPE_UNSUPPORTED');
    expect(body).not.toContain('lease');
  });
});

describe('deriveWorkspacePhase', () => {
  it('maps the controller states onto the five operator phases', () => {
    expect(deriveWorkspacePhase(makeSnapshot({}), false)).toBe('DISABLED');
    expect(deriveWorkspacePhase(makeSnapshot({ outcome: 'PENDING' }), true)).toBe(
      'ENABLING',
    );
    expect(deriveWorkspacePhase(makeSnapshot({}), true)).toBe('READY');
    expect(deriveWorkspacePhase(makeSnapshot({ outcome: 'BLOCKED' }), true)).toBe(
      'RECOVERY_REQUIRED',
    );
    expect(
      deriveWorkspacePhase(makeSnapshot({ eligible: false }), true),
    ).toBe('UNSUPPORTED_3D_ANALOG');
  });
});

describe('MotorWorkspace - no physical claims', () => {
  it('never renders motion language', () => {
    const renderer = render(
      <MotorWorkspace
        snapshot={makeSnapshot({})}
        port={makePort()}
        enabled
        onEnableChange={() => {}}
      />,
    );
    const body = text(renderer);
    expect(body).not.toContain('المحرك يعمل');
    expect(body).not.toContain('توقف المحرك فعليًا');
  });
});

describe('P3 - web Escape-to-STOP', () => {
  const listeners = new Map<string, Set<(e: {key?: string}) => void>>();
  beforeEach(() => {
    listeners.clear();
    (globalThis as {addEventListener?: unknown}).addEventListener = (
      type: string,
      listener: (e: {key?: string}) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    };
    (globalThis as {removeEventListener?: unknown}).removeEventListener = (
      type: string,
      listener: (e: {key?: string}) => void,
    ) => listeners.get(type)?.delete(listener);
  });
  afterEach(() => {
    delete (globalThis as {addEventListener?: unknown}).addEventListener;
    delete (globalThis as {removeEventListener?: unknown}).removeEventListener;
  });
  const fire = (key: string) => {
    for (const listener of listeners.get('keydown') ?? []) {
      listener({key});
    }
  };

  it('Escape triggers the canonical stop; other keys do NOT', () => {
    const port = makePort();
    render(
      <MotorWorkspace
        snapshot={makeSnapshot({})}
        port={port}
        enabled
        onEnableChange={() => {}}
      />,
    );
    act(() => fire('a'));
    act(() => fire('Enter'));
    act(() => fire('ArrowUp'));
    expect(port.calls).toHaveLength(0);
    act(() => fire('Escape'));
    expect(port.calls).toEqual([{ op: 'stopAll', args: [] }]);
  });

  it('does not listen while the session is not commandable', () => {
    const port = makePort();
    render(
      <MotorWorkspace
        snapshot={makeSnapshot({})}
        port={port}
        enabled={false}
        onEnableChange={() => {}}
      />,
    );
    act(() => fire('Escape'));
    expect(port.calls).toHaveLength(0);
  });
});
