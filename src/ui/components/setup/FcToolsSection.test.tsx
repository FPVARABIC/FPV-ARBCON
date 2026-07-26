/**
 * Pass 7.7, Region 5 - the control surface: enablement, the exact
 * disabled reason for every state, the explicit propellers-removed
 * confirmation, cancellation, double taps, touch targets, accessibility
 * and the truthful outcome copy.
 *
 * The controller is a lightweight stand-in here (the REAL transaction is
 * covered end-to-end in FcToolsController.test.ts against the real
 * MspClient); what this suite proves is that the component never invents
 * permission, never sends on cancel, and never overstates an outcome.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import FcToolsSection from './FcToolsSection';
import '../../../i18n';
import type {FcToolGateInput, SensorPresenceBit} from '../../../core';
import type {FcToolOutcome, FcToolPhase, FcToolsController} from '../../../platforms/react-native/protocol';

/** The EXACT acknowledgement copy. A non-error response proves only
 * that the firmware received and parsed the command: msp.c's
 * mspProcessInCommand() has no `dst` buffer at all, and it acks even
 * when the FC is ARMED and the handler therefore did nothing. So this
 * sentence must not affirm that calibration started, completed,
 * succeeded, produced values, or was persisted - it only states that a
 * valid response arrived and explicitly denies the rest. */
const TRUTHFUL_ACK =
  'استلم التطبيق ردًا صالحًا من متحكم الطيران على أمر المعايرة، لكن هذا لا يؤكد أن المعايرة بدأت أو اكتملت أو حُفظت.';

/** The exact sentence this replaced - it affirmatively claimed that
 * execution had begun, which the firmware contract does not support. */
const FORMER_AFFIRMATIVE_ACK = 'قبل متحكم الطيران الأمر وبدأ التنفيذ. لا يستطيع التطبيق تأكيد اكتماله.';

/** Affirmative PHRASES that must never appear anywhere in the rendered
 * tree. Deliberately phrases, not bare words: the truthful sentence
 * legitimately contains بدأت / اكتملت / حُفظت inside an explicit
 * negation ("...does not confirm that calibration started or completed
 * or was saved"), so a bare-word absence check would be both wrong and
 * meaningless. */
const FORBIDDEN_AFFIRMATIVE_PHRASES = [
  'وبدأ التنفيذ',
  'بدأت المعايرة',
  'اكتملت المعايرة',
  'تمت المعايرة',
  'نجحت المعايرة',
  'المعايرة ناجحة',
  'تم حفظ',
  'حُفظت القيم',
  'تمت بنجاح',
  'أُعيد التشغيل بنجاح',
];

const WITH_MAG: readonly SensorPresenceBit[] = [
  {kind: 'KNOWN', bit: 0, token: 'ACC'},
  {kind: 'KNOWN', bit: 2, token: 'MAG'},
  {kind: 'KNOWN', bit: 5, token: 'GYRO'},
];

/** Records exactly what the component asks the shared mutex to do. */
function makeFakeController() {
  const listeners = new Set<() => void>();
  let phase: FcToolPhase = {kind: 'IDLE'};
  let outcome: FcToolOutcome | undefined;
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
    getLastOutcome: () => outcome,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestConfirmation: (sessionId: string, tool: string) => {
      calls.push(`request:${tool}`);
      if (phase.kind !== 'IDLE') {
        return false;
      }
      phase = {kind: 'CONFIRMING', tool: tool as never, sessionId};
      outcome = undefined;
      notify();
      return true;
    },
    cancel: () => {
      calls.push('cancel');
      if (phase.kind !== 'CONFIRMING') {
        return;
      }
      outcome = {kind: 'CANCELLED', tool: phase.tool};
      phase = {kind: 'IDLE'};
      notify();
    },
    confirm: async () => {
      calls.push('confirm');
      if (phase.kind !== 'CONFIRMING') {
        return outcome as FcToolOutcome;
      }
      outcome = {kind: 'ACCEPTED', tool: phase.tool};
      phase = {kind: 'IDLE'};
      notify();
      return outcome;
    },
    setOutcome: (next: FcToolOutcome) => {
      outcome = next;
      notify();
    },
  };
  return controller as unknown as FcToolsController & typeof controller;
}

function gate(overrides: Partial<FcToolGateInput> = {}): Omit<FcToolGateInput, 'busy'> {
  const {connected, appActive, recovering, compatibility, dataState, readingMalformed, armedState, sensors} = {
    connected: true,
    appActive: true,
    recovering: false,
    compatibility: 'BETAFLIGHT_API_1_47' as const,
    dataState: 'FRESH' as const,
    readingMalformed: false,
    armedState: 'DISARMED' as const,
    sensors: WITH_MAG,
    ...overrides,
  };
  return {connected, appActive, recovering, compatibility, dataState, readingMalformed, armedState, sensors};
}

function render(
  controller: FcToolsController,
  gateInput: Omit<FcToolGateInput, 'busy'> = gate(),
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <FcToolsSection sessionId="s1" gate={gateInput} controller={controller} />,
    );
  });
  return renderer;
}

function texts(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)));
}

/** The Pressable ELEMENT (the one carrying onPress/disabled/style) -
 * RN's Pressable renders a host View that also forwards the testID. */
function button(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0];
}

function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  act(() => {
    button(renderer, testID).props.onPress();
  });
}

function unmount(renderer: ReactTestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

describe('FcToolsSection - what is offered', () => {
  it('renders the exact Arabic title and exactly the three proven tools - no placeholder', () => {
    const renderer = render(makeFakeController());
    expect(texts(renderer)).toEqual(expect.arrayContaining(['أدوات وحدة التحكم']));
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['معايرة مقياس التسارع', 'معايرة البوصلة المغناطيسية', 'إعادة تشغيل متحكم الطيران']),
    );
    // Nothing forbidden is offered.
    const all = texts(renderer).join(' | ');
    for (const forbidden of ['المحرك', 'تسليح', 'إعادة ضبط المصنع', 'CLI', 'تحديث البرنامج']) {
      expect(all).not.toContain(forbidden);
    }
    unmount(renderer);
  });

  it('every control has a >=44dp touch target and a button role', () => {
    const renderer = render(makeFakeController());
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      const control = button(renderer, `fc-tool-${tool}-button`);
      expect(control.props.accessibilityRole).toBe('button');
      const styles = control.props.style as Array<{minHeight?: number} | undefined>;
      expect(styles.find(style => style?.minHeight !== undefined)?.minHeight).toBeGreaterThanOrEqual(44);
    }
    unmount(renderer);
  });
});

describe('FcToolsSection - disabled states name their reason in text', () => {
  const cases: Array<[Partial<FcToolGateInput>, string]> = [
    [{connected: false}, 'غير متاح: لا يوجد اتصال نشط'],
    [{appActive: false}, 'غير متاح: التطبيق ليس في المقدمة'],
    [{recovering: true}, 'غير متاح: جارٍ استعادة الاتصال'],
    [{compatibility: 'IDENTIFYING'}, 'غير متاح: لم يكتمل التعرّف على متحكم الطيران'],
    [{compatibility: 'OTHER_FIRMWARE_OR_API'}, 'غير متاح: يتطلب Betaflight بواجهة MSP 1.47'],
    [{dataState: 'WAITING'}, 'غير متاح: لا توجد قراءة حالية من متحكم الطيران'],
    [{dataState: 'STALE'}, 'غير متاح: القراءة غير محدثة'],
    [{armedState: 'ARMED'}, 'غير متاح: الطائرة مسلّحة'],
    [{armedState: 'UNKNOWN'}, 'غير متاح: تعذّر تأكيد أن الطائرة غير مسلّحة'],
  ];

  it.each(cases)('%j shows "%s" and disables the control', (overrides, expected) => {
    const renderer = render(makeFakeController(), gate(overrides));
    expect(texts(renderer)).toContain(expected);
    const control = button(renderer, 'fc-tool-ACC_CALIBRATION-button');
    expect(control.props.disabled).toBe(true);
    expect(control.props.accessibilityState).toEqual({disabled: true});
    expect(String(control.props.accessibilityLabel)).toContain(expected);
    unmount(renderer);
  });

  it('a disabled control cannot open a confirmation at all', () => {
    const controller = makeFakeController();
    const renderer = render(controller, gate({armedState: 'ARMED'}));
    expect(button(renderer, 'fc-tool-ACC_CALIBRATION-button').props.disabled).toBe(true);
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    unmount(renderer);
  });

  it('shows the magnetometer requirement on that control ONLY', () => {
    const renderer = render(makeFakeController(), gate({sensors: [{kind: 'KNOWN', bit: 5, token: 'GYRO'}]}));
    expect(texts(renderer)).toContain('غير متاح: لم يُبلِّغ متحكم الطيران عن اكتشاف بوصلة');
    expect(button(renderer, 'fc-tool-MAG_CALIBRATION-button').props.disabled).toBe(true);
    expect(button(renderer, 'fc-tool-ACC_CALIBRATION-button').props.disabled).toBe(false);
    expect(button(renderer, 'fc-tool-REBOOT-button').props.disabled).toBe(false);
    unmount(renderer);
  });
});

describe('FcToolsSection - confirmation', () => {
  it('requires one explicit confirmation whose positive label states the propellers are removed', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');

    expect(renderer.root.findAll(n => n.props.testID === 'fc-tools-confirmation').length).toBeGreaterThan(0);
    expect(texts(renderer)).toContain('نعم، المراوح مفكوكة — تابع');
    expect(controller.calls).toEqual(['request:ACC_CALIBRATION']);
    unmount(renderer);
  });

  it('states the physical requirements for each tool, including the source-proven magnetometer timing', () => {
    const controller = makeFakeController();
    const acc = render(controller);
    press(acc, 'fc-tool-ACC_CALIBRATION-button');
    expect(texts(acc).join(' ')).toContain('سطح مستوٍ');
    expect(texts(acc).join(' ')).toContain('فُكّ المراوح');
    unmount(acc);

    const controller2 = makeFakeController();
    const mag = render(controller2);
    press(mag, 'fc-tool-MAG_CALIBRATION-button');
    const magBody = texts(mag).join(' ');
    expect(magBody).toContain('١٥ ثانية');
    expect(magBody).toContain('٣٠ ثانية');
    expect(magBody).toContain('لا يرسل متحكم الطيران أي نسبة تقدّم');
    unmount(mag);

    const controller3 = makeFakeController();
    const reboot = render(controller3);
    press(reboot, 'fc-tool-REBOOT-button');
    expect(texts(reboot).join(' ')).toContain('سينقطع اتصال USB/MSP');
    unmount(reboot);
  });

  it('cancelling sends NOTHING and releases the mutex', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');
    press(renderer, 'fc-tools-cancel');

    expect(controller.calls).toEqual(['request:ACC_CALIBRATION', 'cancel']);
    expect(controller.calls).not.toContain('confirm');
    expect(texts(renderer)).toContain('أُلغيت العملية. لم يُرسل أي أمر.');
    unmount(renderer);
  });

  it('confirming runs the transaction exactly once', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');
    press(renderer, 'fc-tools-confirm');

    expect(controller.calls.filter(c => c === 'confirm')).toHaveLength(1);
    unmount(renderer);
  });

  it('while a confirmation is open every tool control is disabled with the BUSY reason', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    press(renderer, 'fc-tool-REBOOT-button');

    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      expect(button(renderer, `fc-tool-${tool}-button`).props.disabled).toBe(true);
    }
    expect(texts(renderer)).toContain('غير متاح: توجد عملية قيد التنفيذ');
    unmount(renderer);
  });

  it('a double tap on the same control opens exactly one confirmation', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    press(renderer, 'fc-tool-ACC_CALIBRATION-button');
    // The control is now disabled; pressing it again is a no-op even if
    // the platform delivered a second tap.
    const control = button(renderer, 'fc-tool-ACC_CALIBRATION-button');
    expect(control.props.disabled).toBe(true);
    act(() => {
      control.props.onPress();
    });
    expect(controller.calls.filter(c => c === 'request:ACC_CALIBRATION')).toHaveLength(2);
    // Exactly one confirmation panel exists (the Text element plus its
    // host node are the same single panel).
    expect(
      renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'fc-tools-confirmation'),
    ).toHaveLength(1);
    unmount(renderer);
  });
});

describe('FcToolsSection - truthful outcome copy', () => {
  const cases: Array<[FcToolOutcome, string]> = [
    [{kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'}, TRUTHFUL_ACK],
    [{kind: 'REBOOT_REQUESTED'}, 'أُرسل أمر إعادة التشغيل. يُتوقَّع انقطاع الاتصال؛ لم تُؤكَّد إعادة الاتصال.'],
    [{kind: 'UNCONFIRMED', tool: 'REBOOT'}, 'تعذّر تأكيد النتيجة. لم يُعَد الإرسال تلقائيًا.'],
    [{kind: 'FAILED', tool: 'ACC_CALIBRATION', error: new Error('x')}, 'رفض متحكم الطيران الأمر أو لم يُرسَل.'],
    [{kind: 'SESSION_ENDED', tool: 'REBOOT'}, 'انتهت الجلسة قبل اكتمال العملية.'],
  ];

  it.each(cases)('%j renders its exact, non-overstating text', (outcome, expected) => {
    const controller = makeFakeController();
    const renderer = render(controller);
    act(() => {
      controller.setOutcome(outcome);
    });
    expect(texts(renderer)).toContain(expected);
    unmount(renderer);
  });

  it('a rejected action states that nothing was sent, with the reason', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    act(() => {
      controller.setOutcome({kind: 'REJECTED', tool: 'ACC_CALIBRATION', reason: 'ARMED'});
    });
    const outcomeText = texts(renderer).find(text => text.startsWith('لم يُرسل أي أمر'));
    expect(outcomeText).toBeDefined();
    expect(outcomeText).toContain('غير متاح: الطائرة مسلّحة');
    unmount(renderer);
  });

  it.each(['ACC_CALIBRATION', 'MAG_CALIBRATION'] as const)(
    'the %s acknowledgement renders the EXACT truthful wording and never the former affirmative sentence',
    tool => {
      const controller = makeFakeController();
      const renderer = render(controller);
      act(() => {
        controller.setOutcome({kind: 'ACCEPTED', tool});
      });

      const rendered = texts(renderer);
      expect(rendered).toContain(TRUTHFUL_ACK);
      const all = rendered.join(' | ');
      expect(all).not.toContain(FORMER_AFFIRMATIVE_ACK);
      expect(all).not.toContain('وبدأ التنفيذ');
      unmount(renderer);
    },
  );

  it('no acknowledgement text affirms that calibration started, completed, succeeded or was persisted', () => {
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION'] as const) {
      const controller = makeFakeController();
      const renderer = render(controller);
      act(() => {
        controller.setOutcome({kind: 'ACCEPTED', tool});
      });
      const all = texts(renderer).join(' | ');
      for (const phrase of FORBIDDEN_AFFIRMATIVE_PHRASES) {
        expect(all).not.toContain(phrase);
      }
      unmount(renderer);
    }
  });

  it('every بدأت/اكتملت/حُفظت in the acknowledgement sits INSIDE the explicit negation', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    act(() => {
      controller.setOutcome({kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'});
    });

    const sentence = texts(renderer).find(text => text.includes('لا يؤكد'));
    expect(sentence).toBeDefined();
    const negationAt = (sentence as string).indexOf('لا يؤكد');
    // Structural, not word-blind: each of these verbs may appear only
    // AFTER the negation marker, so none of them can ever be read as an
    // affirmative claim.
    for (const verb of ['بدأت', 'اكتملت', 'حُفظت']) {
      let from = 0;
      for (;;) {
        const at = (sentence as string).indexOf(verb, from);
        if (at < 0) {
          break;
        }
        expect(at).toBeGreaterThan(negationAt);
        from = at + verb.length;
      }
    }
    unmount(renderer);
  });

  it('the tool DESCRIPTIONS do not affirm that calibration starts, succeeds or is persisted either', () => {
    const renderer = render(makeFakeController());
    const all = texts(renderer).join(' | ');
    for (const phrase of FORBIDDEN_AFFIRMATIVE_PHRASES) {
      expect(all).not.toContain(phrase);
    }
    // The descriptions state what the app REQUESTS, conditionally.
    expect(all).toContain('يطلب من متحكم الطيران بدء معايرة مقياس التسارع');
    expect(all).not.toContain('يبدأ متحكم الطيران معايرة مقياس التسارع ويحفظ النتيجة بنفسه.');
    unmount(renderer);
  });

  it('the outcome is announced as an alert', () => {
    const controller = makeFakeController();
    const renderer = render(controller);
    act(() => {
      controller.setOutcome({kind: 'UNCONFIRMED', tool: 'REBOOT'});
    });
    const node = renderer.root.find(n => typeof n.type === 'string' && n.props.testID === 'fc-tools-outcome');
    expect(node.props.accessibilityRole).toBe('alert');
    unmount(renderer);
  });
});
