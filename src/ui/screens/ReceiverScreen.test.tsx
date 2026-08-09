import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';
import ReceiverScreen, {type ReceiverControllerPort} from './ReceiverScreen';

function snapshot(): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39); const view = new DataView(bytes.buffer);
  bytes[0] = 9; view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true); view.setUint16(8, 885, true); view.setUint16(10, 2115, true); bytes[27] = 30; bytes[30] = 30; bytes[31] = 1;
  return {rx: decodeRxConfig(bytes), channelMap: [0, 1, 3, 2, 4, 5, 6, 7], rssiChannel: 0, deadband: {deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 5}};
}

async function render(controller: ReceiverControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { renderer = ReactTestRenderer.create(<ReceiverScreen sessionKey={{sessionId: 'receiver-ui', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller} />); });
  return renderer;
}

describe('ReceiverScreen', () => {
  it('renders an interactive surface, not a bitmap or fake stick sample', async () => {
    const original = snapshot(); const controller: ReceiverControllerPort = {load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original}))};
    const renderer = await render(controller);
    expect(renderer.root.findAllByProps({testID: 'receiver-screen'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-stick-left'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-stick-left-position'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-channel-map'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('sends the exact dirty draft through verified save', async () => {
    const original = snapshot(); const save = jest.fn(async (_key, _original, draft) => ({kind: 'SAVED_VERIFIED' as const, snapshot: {...original, channelMap: [1, 2, 3, 0, 4, 5, 6, 7]}, draft}));
    const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: save as ReceiverControllerPort['save']});
    const preset = renderer.root.findAll(node => node.props.onPress !== undefined && node.findAllByType('Text' as never).some(text => text.props.children === 'TAER1234'))[0];
    act(() => preset.props.onPress());
    await act(async () => { await renderer.root.findByProps({testID: 'receiver-save-bar-save'}).props.onPress(); });
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][2].channelMapText).toBe('TAER1234');
    act(() => renderer.unmount());
  });

  it('skips primary stick channels when stepping RSSI from disabled', async () => {
    const original = snapshot();
    const renderer = await render({load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original}))});
    act(() => renderer.root.findByProps({testID: 'receiver-rssi-channel-plus'}).props.onPress());
    const input = renderer.root.findAllByProps({testID: 'receiver-rssi-channel'}).find(node => node.props.value !== undefined);
    expect(input?.props.value).toBe('5');
    act(() => renderer.root.findByProps({testID: 'receiver-rssi-channel-minus'}).props.onPress());
    expect(renderer.root.findAllByProps({testID: 'receiver-rssi-channel'}).find(node => node.props.value !== undefined)?.props.value).toBe('0');
    act(() => renderer.unmount());
  });

  it('explains a motor-test interlock and opens Motors', async () => {
    const onOpenMotors = jest.fn(); let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => { renderer = ReactTestRenderer.create(<ReceiverScreen sessionKey={{sessionId: 'receiver-ui', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={onOpenMotors} controller={{load: jest.fn(async () => ({kind: 'REJECTED' as const, reason: 'MOTOR_TEST_ACTIVE' as const})), save: jest.fn()}} />); });
    const message = renderer.root.findByProps({testID: 'receiver-load-message'});
    const button = message.findAll(node => node.props.onPress === onOpenMotors)[0]; act(() => button.props.onPress()); expect(onOpenMotors).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
