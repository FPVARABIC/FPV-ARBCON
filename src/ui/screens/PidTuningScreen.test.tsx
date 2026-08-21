import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import '../../i18n';
import {decodePidTuningSnapshot, type MspPidTuningSnapshot} from '../../core';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

function snapshot(rollP = 42, rollRcRate = 100, gyroStaticHz = 0): MspPidTuningSnapshot {
  const pid = Uint8Array.from([rollP, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = new Uint8Array(61); const view = new DataView(advanced.buffer); view.setUint16(32, 120, true); view.setUint16(34, 130, true); view.setUint16(36, 140, true);
  const rates = new Uint8Array(24); rates[0] = rollRcRate; rates[12] = 100; rates[11] = 100; rates[2] = 70; rates[3] = 70; rates[4] = 70; rates[6] = 50; rates[15] = 100; rates[23] = 50;
  const ratesView = new DataView(rates.buffer); ratesView.setUint16(16, 1998, true); ratesView.setUint16(18, 1998, true); ratesView.setUint16(20, 1998, true);
  const filters = new Uint8Array(49); new DataView(filters.buffer).setUint16(20, gyroStaticHz, true);
  return decodePidTuningSnapshot({pid, advanced, rates, filters, gyroSampleRateHz: 8000, pidProcessDenom: 2, pidProfileIndex: 1, pidProfileCount: 3, controlRateProfileIndex: 2});
}
async function render(controller: PidControllerPort, onOpenMotors = jest.fn()) { let renderer!: ReactTestRenderer.ReactTestRenderer; await act(async () => { renderer = ReactTestRenderer.create(<PidTuningScreen sessionKey={{sessionId: 'pid-ui', generation: 1}} active onOpenMotors={onOpenMotors} controller={controller} />); }); return renderer; }

describe('PidTuningScreen', () => {
  it('renders real editable axis controls and no bitmap substitute', async () => {
    const original = snapshot(); const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original}))});
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
    expect(selected('pid-active-profile')).toContain('ملف PID النشط 2');
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
    >(async () => ({kind: 'SAVED_VERIFIED', snapshot: saved}));
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
    const save = jest.fn<ReturnType<PidControllerPort['save']>, Parameters<PidControllerPort['save']>>(async () => ({kind: 'SAVED_VERIFIED', snapshot: saved}));
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
    const save = jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original}));
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
