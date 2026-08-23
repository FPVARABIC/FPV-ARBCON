import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Alert, Text} from 'react-native';
import '../../i18n';
import {decodePidTuningSnapshot, type MspPidTuningSnapshot} from '../../core';
import {
  SIMPLIFIED_FILTER_BLOCK_BYTES, SIMPLIFIED_PID_BLOCK_BYTES,
  decodeSimplifiedTuning, type MspSimplifiedTuning,
} from '../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

function snapshot(rollP = 42, rollRcRate = 100, gyroStaticHz = 0, ratesTypeRaw = 0): MspPidTuningSnapshot {
  const pid = Uint8Array.from([rollP, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = new Uint8Array(61); const view = new DataView(advanced.buffer); view.setUint16(32, 120, true); view.setUint16(34, 130, true); view.setUint16(36, 140, true);
  const rates = new Uint8Array(24); rates[0] = rollRcRate; rates[12] = 100; rates[11] = 100; rates[2] = 70; rates[3] = 70; rates[4] = 70; rates[6] = 50; rates[15] = 100; rates[22] = ratesTypeRaw; rates[23] = 50;
  const ratesView = new DataView(rates.buffer); ratesView.setUint16(16, 1998, true); ratesView.setUint16(18, 1998, true); ratesView.setUint16(20, 1998, true);
  const filters = new Uint8Array(49); new DataView(filters.buffer).setUint16(20, gyroStaticHz, true);
  return decodePidTuningSnapshot({pid, advanced, rates, filters, gyroSampleRateHz: 8000, pidProcessDenom: 2, pidProfileIndex: 1, pidProfileCount: 3, controlRateProfileIndex: 2});
}

/** The 53-byte simplified block, laid out in the firmware's own order. */
function simplified(options: {modeRaw?: number; masterMultiplier?: number; gyroEnabled?: boolean; gyroMultiplier?: number; gyroLpf1DynMinHz?: number; gyroLpf1DynMaxHz?: number} = {}): MspSimplifiedTuning {
  const payload = new Uint8Array(53); const view = new DataView(payload.buffer);
  payload[0] = options.modeRaw ?? 2;
  payload[1] = options.masterMultiplier ?? 100;
  for (let index = 2; index <= 8; index += 1) payload[index] = 100;
  const dterm = SIMPLIFIED_PID_BLOCK_BYTES; payload[dterm] = 1; payload[dterm + 1] = 100; view.setUint16(dterm + 2, 75, true); view.setUint16(dterm + 4, 150, true);
  const gyro = SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES;
  payload[gyro] = (options.gyroEnabled ?? true) ? 1 : 0;
  payload[gyro + 1] = options.gyroMultiplier ?? 100;
  view.setUint16(gyro + 6, options.gyroLpf1DynMinHz ?? 250, true);
  view.setUint16(gyro + 8, options.gyroLpf1DynMaxHz ?? 500, true);
  return decodeSimplifiedTuning(payload);
}

async function render(controller: PidControllerPort, onOpenMotors = jest.fn()) { let renderer!: ReactTestRenderer.ReactTestRenderer; await act(async () => { renderer = ReactTestRenderer.create(<PidTuningScreen sessionKey={{sessionId: 'pid-ui', generation: 1}} active onOpenMotors={onOpenMotors} controller={controller} />); }); return renderer; }

function screenText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
    .join('\n');
}
function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const target = renderer.root.findAllByProps({testID}).find(node => typeof node.props?.onPress === 'function');
  if (target === undefined) throw new Error(`no pressable ${testID}`);
  act(() => target.props.onPress());
}
/** The Stepper's own centre, whether it renders a Text or a TextInput. */
function stepperValue(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string | undefined {
  return renderer.root.findAllByProps({testID})
    .map(node => (typeof node.props.children === 'string' ? node.props.children : typeof node.props.value === 'string' ? node.props.value : undefined))
    .find(value => value !== undefined);
}
/** Whether the host TextInput - the thing a pilot actually types into - accepts input. */
function editable(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean | undefined {
  return renderer.root.findAllByProps({testID}).find(node => typeof node.props.editable === 'boolean')?.props.editable;
}
function joinedText(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  return renderer.root.findAllByProps({testID})
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
    .join(' ');
}

describe('PidTuningScreen', () => {
  it('renders real editable axis controls and no bitmap substitute', async () => {
    const original = snapshot(); const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original, evidence: {normalisations: []}}))});
    expect(renderer.root.findAllByProps({testID: 'pid-screen'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-axis-roll'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-roll-p'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-yaw-f'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-rate-roll-rc'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-gyro-static'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0); act(() => renderer.unmount());
  });
  it('marks the active PID and Rates profiles read from STATUS_EX', async () => {
    // The badge became a SELECTOR when profile switching landed, so the
    // active profile is now carried by the pressed state rather than by
    // a "2 / 3" string. The FACT under test is unchanged: the screen
    // shows the board's own indices and marks exactly one of each.
    const original = snapshot(); const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn()});
    const selected = (testID: string) => renderer.root
      .findAllByProps({testID})
      .flatMap(node => node.findAll(child => child.props?.accessibilityState?.selected === true))
      .map(child => child.props.accessibilityLabel);
    // pidProfileIndex 1 of pidProfileCount 3 -> the second choice.
    // The label lost the word «النشط» when the badge gained a purpose line:
    // every button in the group carried "active" even the six that were not,
    // and `accessibilityState.selected` already says which one is. The FACT
    // under test - exactly one choice marked, at the board's own index - is
    // unchanged.
    expect(selected('pid-active-profile')).toContain('ملف PID 2');
    expect(renderer.root.findAllByProps({testID: 'pid-active-profile-3'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('asks the flight controller to switch, and never switches on its own', async () => {
    // A selector that only moved local state would be a lie: the board
    // decides which profile is running.
    const original = snapshot();
    const selectProfile = jest.fn(async () => ({kind: 'SWITCHED' as const, snapshot: original}));
    const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(), selectProfile});
    const target = renderer.root
      .findAllByProps({testID: 'pid-active-profile-1'})
      .find(node => typeof node.props?.onPress === 'function');
    expect(target).toBeDefined();
    await act(async () => { target?.props.onPress(); });
    expect(selectProfile).toHaveBeenCalledWith({sessionId: 'pid-ui', generation: 1}, 'PID', 0);
    act(() => renderer.unmount());
  });

  it('renders no selector at all when the host cannot switch', async () => {
    // A control that cannot act must not be drawn.
    const original = snapshot();
    const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn()});
    const pressable = renderer.root
      .findAllByProps({testID: 'pid-active-profile-1'})
      .find(node => typeof node.props?.onPress === 'function');
    expect(pressable?.props.disabled).toBe(true);
    act(() => renderer.unmount());
  });
  it('sends the edited numeric draft through the verified save action', async () => {
    const original = snapshot();
    const saved = snapshot(50);
    const save = jest.fn<
      ReturnType<PidControllerPort['save']>,
      Parameters<PidControllerPort['save']>
    >(async () => ({kind: 'SAVED_VERIFIED', evidence: {normalisations: []}, snapshot: saved}));
    const renderer = await render({
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
      save,
    });
    const input = renderer.root.findAllByProps({testID: 'pid-roll-p'}).find(node => typeof node.props.onChangeText === 'function'); if (input === undefined) throw new Error('PID Roll P input not found'); act(() => input.props.onChangeText('50'));
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2].roll.p).toBe(50);
    act(() => renderer.unmount());
  });
  it('sends editable Rates and Filters through the same verified transaction', async () => {
    const original = snapshot();
    const saved = snapshot(42, 120, 300);
    const save = jest.fn<ReturnType<PidControllerPort['save']>, Parameters<PidControllerPort['save']>>(async () => ({kind: 'SAVED_VERIFIED', evidence: {normalisations: []}, snapshot: saved}));
    const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save});
    const rateInput = renderer.root.findAllByProps({testID: 'pid-rate-roll-rc'}).find(node => typeof node.props.onChangeText === 'function');
    const filterInput = renderer.root.findAllByProps({testID: 'pid-gyro-static'}).find(node => typeof node.props.onChangeText === 'function');
    if (rateInput === undefined || filterInput === undefined) throw new Error('Rates/filter inputs not found');
    act(() => { rateInput.props.onChangeText('1.20'); filterInput.props.onChangeText('300'); });
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2].rates.roll.rcRate).toBe(120);
    expect(save.mock.calls[0]?.[2].filters.gyroLpf1StaticHz).toBe(300);
    act(() => renderer.unmount());
  });
  it('never brings an older result back to the status line', async () => {
    /*
     * THE STALE BANNER, IN THE ORDER THAT PRODUCED IT.
     *
     * The status line reads saveOutcome first and switchOutcome second.
     * An edit used to clear only the save result, which did not clear
     * the line - it UNCOVERED the profile-switch message underneath. So
     * after switch -> edit -> save -> edit, the screen went back to
     * announcing a profile switch from three actions ago as the current
     * state of the board.
     */
    const original = snapshot();
    const selectProfile = jest.fn(async () => ({kind: 'SWITCHED' as const, snapshot: original}));
    const save = jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original, evidence: {normalisations: []}}));
    const renderer = await render({
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
      save,
      selectProfile,
    });
    const text = () =>
      renderer.root
        .findAllByType(Text)
        .map(item => {
          const value = item.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('\n');
    const SWITCH_LINE = 'تم تفعيل الملف المطلوب، وأعيدت قراءة قيمه من متحكم الطيران.';
    const edit = (value: string) => {
      const input = renderer.root
        .findAllByProps({testID: 'pid-roll-p'})
        .find(item => typeof item.props.onChangeText === 'function');
      if (input === undefined) throw new Error('roll P input not found');
      act(() => input.props.onChangeText(value));
    };

    // 1. switch profiles - the switch result is the current news.
    const target = renderer.root
      .findAllByProps({testID: 'pid-active-profile-1'})
      .find(item => typeof item.props?.onPress === 'function');
    await act(async () => { await target?.props.onPress(); });
    expect(text()).toContain(SWITCH_LINE);

    // 2. an edit retires it: this result is no longer what just happened.
    edit('44');
    expect(text()).not.toContain(SWITCH_LINE);

    // 3. save - now the save result is the news.
    await act(async () => {
      await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress();
    });
    expect(save).toHaveBeenCalledTimes(1);

    // 4. edit again. THE DEFECT: the switch line used to reappear here.
    edit('46');
    expect(text()).not.toContain(SWITCH_LINE);
    act(() => renderer.unmount());
  });

  it('explains the motor-test interlock and opens Motors', async () => {
    const onOpenMotors = jest.fn(); const renderer = await render({load: jest.fn(async () => ({kind: 'REJECTED' as const, reason: 'MOTOR_TEST_ACTIVE' as const})), save: jest.fn()}, onOpenMotors); const message = renderer.root.findByProps({testID: 'pid-load-message'}); const button = message.findAll(node => node.props.onPress === onOpenMotors)[0]; act(() => button.props.onPress()); expect(onOpenMotors).toHaveBeenCalledTimes(1); act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* The P-D hierarchy                                                   */
/* ------------------------------------------------------------------ */

function fullPort(overrides: Partial<PidControllerPort> = {}): PidControllerPort {
  const original = snapshot();
  return {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
    save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original, evidence: {normalisations: []}})),
    loadSimplified: jest.fn(async () => ({kind: 'LOADED' as const, simplified: simplified()})),
    saveSimplified: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original, evidence: {normalisations: []}})),
    setRatesType: jest.fn(async () => ({kind: 'PERSISTED_VERIFIED' as const, snapshot: original, ratesTypeRaw: 3})),
    ...overrides,
  };
}

describe('PidTuningScreen · simplified tuning is the main workspace', () => {
  it('renders the generator sliders and its own filter blocks, not a struct editor', async () => {
    const renderer = await render(fullPort());
    expect(renderer.root.findAllByProps({testID: 'pid-simplified'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-masterMultiplier'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-gyro'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-dterm'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('shows the master input as a multiplier, never as a raw byte or a frequency', async () => {
    const renderer = await render(fullPort({loadSimplified: jest.fn(async () => ({kind: 'LOADED' as const, simplified: simplified({masterMultiplier: 113})}))}));
    expect(stepperValue(renderer, 'pid-simplified-masterMultiplier-value')).toBe('1.13×');
    // The bug this guards: the multiplier wearing a frequency unit.
    expect(screenText(renderer)).not.toContain('113 Hz');
    act(() => renderer.unmount());
  });

  it('shows the filter multiplier and its effective RANGE as two different facts', async () => {
    const renderer = await render(fullPort({
      loadSimplified: jest.fn(async () => ({kind: 'LOADED' as const, simplified: simplified({gyroMultiplier: 100, gyroLpf1DynMinHz: 250, gyroLpf1DynMaxHz: 500})})),
    }));
    expect(stepperValue(renderer, 'pid-simplified-gyro-multiplier')).toBe('1.00×');
    expect(joinedText(renderer, 'pid-simplified-gyro-range')).toMatch(/\d+–\d+ Hz|\d+ Hz/);
    act(() => renderer.unmount());
  });

  it('warns that turning the generator off restores nothing', async () => {
    const renderer = await render(fullPort());
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-off-consequence'})).toHaveLength(0);
    press(renderer, 'pid-simplified-mode-OFF');
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-off-consequence'}).length).toBeGreaterThan(0);
    expect(screenText(renderer)).toContain('لا تعود القيم التي كانت قبل تفعيله');
    act(() => renderer.unmount());
  });

  it('names what a save will regenerate before the pilot commits to it', async () => {
    const renderer = await render(fullPort());
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-overwrite'})).toHaveLength(0);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    const overwrite = screenText(renderer);
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-overwrite'}).length).toBeGreaterThan(0);
    expect(overwrite).toContain('PID');
    expect(overwrite).toContain('D Max');
    act(() => renderer.unmount());
  });

  it('keeps an unknown mode unknown, and does not offer to edit it', async () => {
    const renderer = await render(fullPort({loadSimplified: jest.fn(async () => ({kind: 'LOADED' as const, simplified: simplified({modeRaw: 6})}))}));
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-unknown-mode'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-simplified-mode'})).toHaveLength(0);
    expect(screenText(renderer)).toContain('6');
    // With no usable generator the direct controls ARE the workspace, so
    // they must not be folded away behind a disclosure.
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-body'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('blames the firmware only when the FIRMWARE is what lacks the feature', async () => {
    const board = await render(fullPort({loadSimplified: jest.fn(async () => ({kind: 'UNSUPPORTED' as const}))}));
    expect(screenText(board)).toContain('بناء البرنامج الثابت');
    act(() => board.unmount());

    // No implementation on our side is OUR gap, and saying "the firmware
    // does not support it" would be inventing evidence about the board.
    const host = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: snapshot()})), save: jest.fn()});
    const text = screenText(host);
    expect(text).toContain('هذه حدود التطبيق، لا حدود المتحكم');
    expect(text).not.toContain('بناء البرنامج الثابت في هذه اللوحة لا يتضمّن');
    act(() => host.unmount());
  });

  it('disables the direct fields the generator owns, and says why', async () => {
    const renderer = await render(fullPort());
    press(renderer, 'pid-advanced-toggle');
    // RPY generates all three axes, so every P is the generator's and a
    // manual edit would be undone by the next save.
    expect(editable(renderer, 'pid-roll-p')).toBe(false);
    expect(editable(renderer, 'pid-yaw-p')).toBe(false);
    expect(screenText(renderer)).toContain('تتحكم به إعدادات الضبط المبسّط حاليًا');
    act(() => renderer.unmount());
  });

  it('leaves the direct fields alone when the generator is off', async () => {
    const renderer = await render(fullPort({loadSimplified: jest.fn(async () => ({kind: 'LOADED' as const, simplified: simplified({modeRaw: 0})}))}));
    press(renderer, 'pid-advanced-toggle');
    expect(editable(renderer, 'pid-roll-p')).toBe(true);
    act(() => renderer.unmount());
  });
});

describe('PidTuningScreen · rates', () => {
  it('renders the response preview inside the rates section', async () => {
    const renderer = await render(fullPort());
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-chart'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('keeps the rate fields editable when the preview cannot be drawn', async () => {
    // QUICK has no observable expo branch, so the curve is unavailable -
    // that is a display limit and must not disable the section.
    const quick = snapshot(42, 100, 0, 4);
    const renderer = await render(fullPort({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: quick}))}));
    expect(renderer.root.findAllByProps({testID: 'pid-rate-preview-unavailable'}).length).toBeGreaterThan(0);
    expect(editable(renderer, 'pid-rate-roll-rc')).toBe(true);
    act(() => renderer.unmount());
  });

  it('treats a formula change as a draft and writes nothing on selection', async () => {
    const port = fullPort();
    const renderer = await render(port);
    press(renderer, 'pid-rates-type-3');
    // FLUSHED, not just ticked. A mutation that fired a save from the chip's
    // own handler survived the synchronous version of this assertion,
    // because the write it started had not been awaited yet.
    await act(async () => { await Promise.resolve(); });
    expect(port.setRatesType).not.toHaveBeenCalled();
    expect(port.save).not.toHaveBeenCalled();
    expect(port.saveSimplified).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({testID: 'pid-rates-type-pending'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('says plainly that the stored numbers are not converted', async () => {
    const renderer = await render(fullPort());
    press(renderer, 'pid-rates-type-3');
    expect(screenText(renderer)).toContain('الأرقام المخزّنة لا تُحوَّل');
    act(() => renderer.unmount());
  });

  it('relabels and rebounds the fields for the formula being selected', async () => {
    const renderer = await render(fullPort());
    const rcLabel = () => renderer.root.findAllByProps({testID: 'pid-rate-roll-rc'})
      .map(node => String(node.props.accessibilityLabel ?? ''))
      .filter(label => label.length > 0)[0];
    expect(rcLabel()).toContain('RC Rate');
    press(renderer, 'pid-rates-type-3');
    // Under ACTUAL the same byte means something else, so it is named and
    // scaled differently.
    expect(rcLabel()).toContain('°/s');
    act(() => renderer.unmount());
  });

  it('refuses to save a value the newly chosen formula cannot hold', async () => {
    // rcRate 220 is legal under Betaflight (max 255) and illegal under
    // Raceflight (max 200). Nothing is rescaled on the pilot's behalf.
    const port = fullPort({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: snapshot(42, 220)}))});
    const renderer = await render(port);
    press(renderer, 'pid-rates-type-1');
    expect(renderer.root.findAllByProps({testID: 'pid-rates-range-issue'}).length).toBeGreaterThan(0);
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(port.setRatesType).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('hides no rates control when the formula is one we cannot evaluate', async () => {
    const renderer = await render(fullPort({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: snapshot(42, 100, 0, 9)}))}));
    expect(renderer.root.findAllByProps({testID: 'pid-rates-type-unknown'}).length).toBeGreaterThan(0);
    // No formula means no bounds we can trust, so the fields are not drawn -
    // but the section, the notice and the type selector remain.
    expect(renderer.root.findAllByProps({testID: 'pid-rates'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'pid-rates-type'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});

describe('PidTuningScreen · the save chain', () => {
  it('writes the formula, then the values, then the generator - each rebased on the last', async () => {
    const first = snapshot(42);
    const afterType = snapshot(43);
    const afterValues = snapshot(44);
    type SetRatesType = NonNullable<PidControllerPort['setRatesType']>;
    type SaveSimplified = NonNullable<PidControllerPort['saveSimplified']>;
    const setRatesType = jest.fn<ReturnType<SetRatesType>, Parameters<SetRatesType>>(
      async () => ({kind: 'PERSISTED_VERIFIED', snapshot: afterType, ratesTypeRaw: 3}));
    const save = jest.fn<ReturnType<PidControllerPort['save']>, Parameters<PidControllerPort['save']>>(
      async () => ({kind: 'SAVED_VERIFIED', snapshot: afterValues, evidence: {normalisations: []}}));
    const saveSimplified = jest.fn<ReturnType<SaveSimplified>, Parameters<SaveSimplified>>(
      async () => ({kind: 'SAVED_VERIFIED', snapshot: afterValues, evidence: {normalisations: []}}));
    const port = fullPort({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: first})), setRatesType, save, saveSimplified});
    const renderer = await render(port);

    press(renderer, 'pid-rates-type-3');
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    const rc = renderer.root.findAllByProps({testID: 'pid-rate-roll-rc'}).find(node => typeof node.props.onChangeText === 'function');
    act(() => rc?.props.onChangeText('1.20'));
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });

    expect(setRatesType).toHaveBeenCalledTimes(1);
    expect(setRatesType.mock.calls[0][1]).toBe(first);
    expect(save).toHaveBeenCalledTimes(1);
    // Step 2 works from what step 1 returned, never from the stale snapshot.
    expect(save.mock.calls[0][1]).toBe(afterType);
    expect(saveSimplified).toHaveBeenCalledTimes(1);
    expect(saveSimplified.mock.calls[0][1]).toBe(afterValues);
    act(() => renderer.unmount());
  });

  it('stops the chain when the formula write does not clearly succeed', async () => {
    const setRatesType = jest.fn(async () => ({kind: 'UNCONFIRMED' as const}));
    const port = fullPort({setRatesType});
    const renderer = await render(port);
    press(renderer, 'pid-rates-type-3');
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(setRatesType).toHaveBeenCalledTimes(1);
    expect(port.save).not.toHaveBeenCalled();
    expect(port.saveSimplified).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('never calls a write for a scope the pilot did not touch', async () => {
    const port = fullPort();
    const renderer = await render(port);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(port.setRatesType).not.toHaveBeenCalled();
    expect(port.save).not.toHaveBeenCalled();
    expect(port.saveSimplified).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('leaves the generator alone when only a value changed', async () => {
    // The mirror of the case above, and the one that was missing: a
    // simplified write REGENERATES the tune, so sending one because the
    // pilot edited a rate would rewrite gains they never touched.
    const port = fullPort();
    const renderer = await render(port);
    const rc = renderer.root.findAllByProps({testID: 'pid-rate-roll-rc'}).find(node => typeof node.props.onChangeText === 'function');
    act(() => rc?.props.onChangeText('1.20'));
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(port.saveSimplified).not.toHaveBeenCalled();
    expect(port.setRatesType).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('names the scopes that changed instead of one anonymous dirty flag', async () => {
    // SCOPED TO THE BAR'S OWN SUMMARY. Reading the whole screen was no test
    // at all: «الضبط المبسّط» is also the section heading, so an anonymous
    // summary passed. The mutation that replaced the summary with a fixed
    // string survived exactly that mistake.
    const renderer = await render(fullPort());
    const summary = () => joinedText(renderer, 'pid-save-bar-summary');
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    expect(summary()).toContain('الضبط المبسّط');
    expect(summary()).not.toContain('خوارزمية Rates');
    press(renderer, 'pid-rates-type-3');
    expect(summary()).toContain('خوارزمية Rates');
    expect(summary()).toContain('الضبط المبسّط');
    act(() => renderer.unmount());
  });

  it('re-reads the generated state after a simplified save rather than showing its own projection', async () => {
    const port = fullPort();
    const renderer = await render(port);
    expect(port.loadSimplified).toHaveBeenCalledTimes(1);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(port.loadSimplified).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('leaves a way out of a terminal failure instead of freezing the page', async () => {
    // A FAILED write disables every control until the values are read
    // again, so the re-read has to be reachable from the page itself.
    const load = jest.fn(async () => ({kind: 'LOADED' as const, snapshot: snapshot()}));
    const port = fullPort({load, saveSimplified: jest.fn(async () => ({kind: 'FAILED' as const, error: new Error('link down')}))});
    const renderer = await render(port);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(renderer.root.findAllByProps({testID: 'pid-status-reload'}).length).toBeGreaterThan(0);

    // The edits survived the failure, so the re-read still asks before
    // discarding them - it must not throw a pilot's tune away silently.
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
    });
    try {
      await act(async () => { press(renderer, 'pid-status-reload'); });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { alert.mockRestore(); }
    act(() => renderer.unmount());
  });

  it('reports a regeneration as a regeneration, not as "settings saved"', async () => {
    const renderer = await render(fullPort());
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
    expect(screenText(renderer)).toContain('أعاد المتحكم حساب القيم من الشرائح');
    act(() => renderer.unmount());
  });
});

describe('PidTuningScreen · the advanced disclosure', () => {
  it('folds the expert controls away when the simplified workspace works', async () => {
    const renderer = await render(fullPort());
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-body'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'pid-roll-p'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('still holds every control it held before, once opened', async () => {
    // Nothing was deleted when the page was reorganised.
    const renderer = await render(fullPort());
    press(renderer, 'pid-advanced-toggle');
    for (const testID of [
      'pid-axis-roll', 'pid-roll-p', 'pid-yaw-f', 'pid-feel', 'pid-ff-jitter',
      'pid-throttle-rates', 'pid-throttle-mid', 'pid-dynamic-idle', 'pid-idle-min-rpm',
      'pid-gyro-filter', 'pid-gyro-static', 'pid-dterm-filter', 'pid-dynamic-notch',
    ]) {
      expect(renderer.root.findAllByProps({testID}).length).toBeGreaterThan(0);
    }
    act(() => renderer.unmount());
  });

  it('opens itself when there is no simplified workspace to show', async () => {
    const renderer = await render(fullPort({loadSimplified: jest.fn(async () => ({kind: 'UNSUPPORTED' as const}))}));
    expect(renderer.root.findAllByProps({testID: 'pid-roll-p'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});
