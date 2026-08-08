import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {decodePidTuningSnapshot, type MspPidTuningSnapshot} from '../../core';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

function snapshot(rollP = 42): MspPidTuningSnapshot {
  const pid = Uint8Array.from([rollP, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = new Uint8Array(61); const view = new DataView(advanced.buffer); view.setUint16(32, 120, true); view.setUint16(34, 130, true); view.setUint16(36, 140, true);
  return decodePidTuningSnapshot({pid, advanced, rates: new Uint8Array(24), filters: new Uint8Array(49)});
}
async function render(controller: PidControllerPort, onOpenMotors = jest.fn()) { let renderer!: ReactTestRenderer.ReactTestRenderer; await act(async () => { renderer = ReactTestRenderer.create(<PidTuningScreen sessionKey={{sessionId: 'pid-ui', generation: 1}} active onOpenMotors={onOpenMotors} controller={controller} />); }); return renderer; }

describe('PidTuningScreen', () => {
  it('renders real editable axis controls and no bitmap substitute', async () => {
    const original = snapshot(); const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original}))});
    expect(renderer.root.findAllByProps({testID: 'pid-screen'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-axis-roll'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-roll-p'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByProps({testID: 'pid-yaw-f'}).length).toBeGreaterThan(0); expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0); act(() => renderer.unmount());
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
  it('explains the motor-test interlock and opens Motors', async () => {
    const onOpenMotors = jest.fn(); const renderer = await render({load: jest.fn(async () => ({kind: 'REJECTED' as const, reason: 'MOTOR_TEST_ACTIVE' as const})), save: jest.fn()}, onOpenMotors); const message = renderer.root.findByProps({testID: 'pid-load-message'}); const button = message.findAll(node => node.props.onPress === onOpenMotors)[0]; act(() => button.props.onPress()); expect(onOpenMotors).toHaveBeenCalledTimes(1); act(() => renderer.unmount());
  });
});
