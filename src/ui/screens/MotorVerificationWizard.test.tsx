/**
 * Phase 2I - tests for the observation wizard, the read-only report, the
 * controller receipt, and the development-only entry.
 *
 * NO HARDWARE. No USB, no flight controller, no ESC, no LiPo, no motor.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  MotorVerificationWizard,
  MotorTestReport,
} from './MotorVerificationWizard';
import '../../i18n';
import i18n from '../../i18n';
import {
  beginVerification,
  confirmObservation,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import type {MotorTestVerificationReceipt} from '../../core/state/motorTestController';

const SESSION = {};

function receiptFor(motorNumber: number, attemptId = motorNumber, sessionToken: object = SESSION): MotorTestVerificationReceipt {
  return Object.freeze({
    sessionToken,
    attemptId,
    motorNumber,
    stopEpisodeId: attemptId,
    pulseAcknowledged: true as const,
    stopAcknowledged: true as const,
    attributionAmbiguous: false as const,
    stopUnsafe: false as const,
    physicalStopConfirmed: false as const,
  });
}

interface Rendered {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  query(testID: string): ReactTestRenderer.ReactTestInstance | undefined;
  press(testID: string): void;
  unmount(): void;
  json(): string;
}

function mount(element: React.ReactElement): Rendered {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(element);
  });
  const query = (testID: string) =>
    tree.root.findAll(node => node.props?.testID === testID)[0];
  return {
    tree,
    query,
    press: (testID: string) => {
      const node = query(testID);
      if (node === undefined) {
        throw new Error(`no node with testID "${testID}"`);
      }
      act(() => {
        node.props.onPress?.();
      });
    },
    unmount: () => {
      act(() => {
        tree.unmount();
      });
    },
    json: () => JSON.stringify(tree.toJSON()),
  };
}

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

describe('Phase 2I - the wizard requires an eligible receipt', () => {
  it('offers no questions at all without a receipt', () => {
    const rendered = mount(
      <MotorVerificationWizard
        receipt={undefined}
        state={beginVerification(SESSION)}
        onConfirm={() => undefined}
      />,
    );
    expect(rendered.query('verification-no-receipt')).toBeDefined();
    expect(rendered.query('verification-questions')).toBeUndefined();
    expect(rendered.query('verification-confirm')).toBeUndefined();
    rendered.unmount();
  });

  it('shows the exact output named by the receipt, and its expectation', () => {
    const rendered = mount(
      <MotorVerificationWizard
        receipt={receiptFor(3)}
        state={beginVerification(SESSION)}
        onConfirm={() => undefined}
      />,
    );
    const rendering = rendered.json();
    expect(rendering).toContain('M3');
    // M3's expectation is Rear Left / CW.
    expect(rendering).toContain('خلفي يسار');
    rendered.unmount();
  });
});

describe('Phase 2I - the wizard never activates anything', () => {
  const executable = readFileSync(
    join(__dirname, 'MotorVerificationWizard.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('cannot call pulseMotor, construct motor traffic, or advance an output', () => {
    for (const forbidden of [
      'pulseMotor',
      'writeBytes',
      'MSP_SET_MOTOR',
      'encodeSetMotorPayload',
      'buildSingleMotorVector',
      'MspClient',
      'operatorPort',
      'setTimeout',
      'setInterval',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    expect(executable).not.toMatch(/\b214\b/);
    expect(executable).not.toMatch(/\b1050\b/);
    expect(executable).not.toMatch(/\b1000\b/);
  });

  it('persists, exports or shares nothing', () => {
    for (const forbidden of ['AsyncStorage', 'localStorage', 'Share.share', 'upload']) {
      expect(executable).not.toContain(forbidden);
    }
  });
});

describe('Phase 2I - correcting before confirmation, immutable after', () => {
  it('lets a selection change until confirmation and confirms only once', () => {
    const calls: {motor: number; observation: MotorObservation}[] = [];
    const state = beginVerification(SESSION);
    const rendered = mount(
      <MotorVerificationWizard
        receipt={receiptFor(1)}
        state={state}
        onConfirm={(receipt, observation) =>
          calls.push({motor: receipt.motorNumber, observation})
        }
      />,
    );
    // Confirm is inert until both answers exist.
    rendered.press('verification-confirm');
    expect(calls).toEqual([]);

    rendered.press('verification-position-FRONT_LEFT');
    rendered.press('verification-direction-CW');
    // Corrected before confirming.
    rendered.press('verification-position-REAR_RIGHT');
    rendered.press('verification-direction-CCW');
    rendered.press('verification-confirm');

    expect(calls).toEqual([
      {
        motor: 1,
        observation: {kind: 'OBSERVED', position: 'REAR_RIGHT', direction: 'CCW'},
      },
    ]);
    rendered.unmount();
  });

  it('locks the output once its observation is confirmed', () => {
    const confirmed = confirmObservation(
      beginVerification(SESSION),
      receiptFor(1),
      {kind: 'OBSERVED', position: 'REAR_RIGHT', direction: 'CCW'},
    );
    if (confirmed.kind !== 'ACCEPTED') {
      throw new Error('fixture');
    }
    const rendered = mount(
      <MotorVerificationWizard
        receipt={receiptFor(1)}
        state={confirmed.state}
        onConfirm={() => undefined}
      />,
    );
    expect(rendered.query('verification-locked')).toBeDefined();
    expect(rendered.query('verification-questions')).toBeUndefined();
    rendered.unmount();
  });

  it('raises the multiple-motor abort to the host', () => {
    let aborted = 0;
    const rendered = mount(
      <MotorVerificationWizard
        receipt={receiptFor(2)}
        state={beginVerification(SESSION)}
        onConfirm={() => undefined}
        onMultipleMotorsReported={() => {
          aborted += 1;
        }}
      />,
    );
    rendered.press('verification-exception-MULTIPLE_MOTORS');
    expect(aborted).toBe(1);
    rendered.unmount();
  });
});

describe('Phase 2I - the read-only report', () => {
  function fullyMatching(): MotorVerificationState {
    let state = beginVerification(SESSION);
    for (const entry of MOTOR_TEST_EXPECTED_CONFIGURATION) {
      const result = confirmObservation(state, receiptFor(entry.motorNumber), {
        kind: 'OBSERVED',
        position: entry.position,
        direction: entry.direction,
      });
      if (result.kind !== 'ACCEPTED') {
        throw new Error('fixture');
      }
      state = result.state;
    }
    return state;
  }

  it('states only that the OBSERVATIONS matched, with the safety caveat', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed />,
    );
    expect(
      rendered.query('report-overall-OBSERVATIONS_MATCH_EXPECTED'),
    ).toBeDefined();
    const rendering = rendered.json();
    expect(rendering).toContain('تطابق ملاحظاتك مع الترتيب والاتجاه المتوقعَين');
    expect(rendering).toContain('هذه المطابقة لا تعني أن الدرون أصبح آمنًا للإقلاع.');
    expect(rendered.query('report-match-caveat')).toBeDefined();
    rendered.unmount();
  });

  it('carries the observation disclaimer', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed />,
    );
    expect(rendered.json()).toContain(
      'هذه النتيجة مبنية على ملاحظتك البصرية، وليست قياسًا تلقائيًا من وحدة التحكم.',
    );
    rendered.unmount();
  });

  it('never claims rotation, direction proof, physical stop, or safety to fly', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed />,
    );
    const rendering = rendered.json();
    for (const forbidden of [
      'آمن للإقلاع',
      'تم التحقق بواسطة البرنامج',
      'تأكد دوران',
      'توقف المحرك ميكانيكيًا',
      'PASS',
      'RPM',
    ]) {
      expect(rendering).not.toContain(forbidden);
    }
    rendered.unmount();
  });

  it('refuses a normal completed report when final teardown was not safe', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed={false} />,
    );
    // Even four perfect observations cannot produce a completed report
    // when the software stop itself is unproven.
    expect(rendered.query('report-overall-UNSAFE_ABORTED')).toBeDefined();
    expect(
      rendered.query('report-overall-OBSERVATIONS_MATCH_EXPECTED'),
    ).toBeUndefined();
    expect(rendered.query('report-match-caveat')).toBeUndefined();
    rendered.unmount();
  });

  it('exposes no operator capability at all', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed />,
    );
    // No pressable, no handler: a finalized report cannot start, stop or
    // re-run anything.
    const pressables = rendered.tree.root.findAll(
      node => typeof node.props?.onPress === 'function',
    );
    expect(pressables).toHaveLength(0);
    rendered.unmount();
  });

  it('marks the report read-only and session-scoped', () => {
    const rendered = mount(
      <MotorTestReport state={fullyMatching()} safeTeardownConfirmed />,
    );
    expect(rendered.query('report-readonly-notice')).toBeDefined();
    rendered.unmount();
  });
});

/**
 * SINGLE-APP MERGE. The block that used to live here asserted the
 * development-only entry's containment - that `MotorsDevEntry` was
 * reachable only behind a seam and that an ordinary Production bundle
 * contained none of it. All of that is deliberately gone: the entry itself
 * is deleted, because with Motors in the tab bar it was a SECOND,
 * ungoverned way in - it navigated straight to the screen from the
 * connection screen, bypassing the shell that owns tab state and fires the
 * lifecycle bridge's blur source.
 *
 * What survives is the part that was never about bundling: nothing outside
 * the one official binding may reach the engine, and the app entry must
 * not know the motor flow exists.
 */
describe('Motor flow entry after the single-app merge', () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..');

  it('has no development-only entry module or seam left behind', () => {
    expect(existsSync(join(__dirname, 'MotorsDevEntry.tsx'))).toBe(false);
    const panels = readFileSync(join(__dirname, 'debugPanels.ts'), 'utf8');
    const panelsCode = panels
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(panelsCode).not.toContain('DevBenchEntry');
    expect(panelsCode).not.toContain('DevBenchScreen');
    expect(panelsCode).not.toContain('MOTORS_ROUTE_NAME');
    // The debug-only panels it DOES still gate are untouched.
    expect(panelsCode).toContain('DevAppLogPanel');
    expect(panelsCode).toContain('DevSerialPanel');
    expect(panelsCode).toContain('__DEV__');
  });

  it('removed the duplicate entry POINT from the connection screen, not just its import', () => {
    const host = readFileSync(join(__dirname, 'UsbConnectionScreen.tsx'), 'utf8');
    const code = host
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // No import, no render site, no navigate() to a motors route.
    expect(code).not.toContain('DevBenchEntry');
    expect(code).not.toContain('MotorsDevEntry');
    expect(code).not.toContain("'Motors'");
    for (const forbidden of [
      'createMotorTestSessionBinding',
      'operatorPort',
      'pulseMotor',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('keeps the app entry free of any direct motor-flow import', () => {
    // App.tsx registers the tab shell; the shell owns which screens exist
    // behind which tab. The entry point still never names the motor flow.
    const app = readFileSync(join(REPO_ROOT, 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/from '\.\/src\/ui\/screens\/MotorsScreen'/);
    expect(app).not.toMatch(/MotorVerificationWizard/);
  });
});
