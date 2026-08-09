import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import '../../i18n';
import type {MspModesConfiguration} from '../../core';
import type {ModesControllerPort} from './ModesScreen';
import ModesScreen from './ModesScreen';

const snapshot: MspModesConfiguration = {
  definitions: [
    {name: 'ARM', permanentId: 0, flagIndex: 0},
    {name: 'ANGLE', permanentId: 1, flagIndex: 1},
    {name: 'BEEPER', permanentId: 13, flagIndex: 2},
  ],
  capacity: 20,
  slots: Array.from({length: 20}, () => ({permanentId: 0, auxChannelIndex: 0, start: 900, end: 900, logic: 0 as const, linkedTo: 0})),
};

async function renderScreen(controller: ModesControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<ModesScreen sessionKey={{sessionId: 'fc', generation: 1}} active onOpenMotors={() => {}} controller={controller} />);
    await Promise.resolve();
  });
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({testID})[0],
    press: async (testID: string) => ReactTestRenderer.act(async () => { renderer.root.findAllByProps({testID})[0].props.onPress(); await Promise.resolve(); }),
    unmount: () => ReactTestRenderer.act(() => renderer.unmount()),
  };
}

describe('ModesScreen', () => {
  it('renders real FC mode definitions and creates an editable AUX condition', async () => {
    const controller: ModesControllerPort = {load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})), save: jest.fn()};
    const screen = await renderScreen(controller);
    expect(screen.find('modes-mode-0')).toBeDefined();
    expect(screen.find('modes-mode-1')).toBeDefined();
    await screen.press('modes-add-range-1');
    expect(screen.find('modes-condition-0')).toBeDefined();
    expect(screen.find('modes-save-bar')).toBeDefined();
    screen.unmount();
  });

  it('sends the edited draft through the verified controller save path', async () => {
    const savedSnapshot: MspModesConfiguration = {
      ...snapshot,
      slots: [
        {permanentId: 1, auxChannelIndex: 0, start: 1300, end: 1700, logic: 0, linkedTo: 0},
        ...snapshot.slots.slice(1),
      ],
    };
    const controller: ModesControllerPort = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})),
      save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: savedSnapshot})),
    };
    const screen = await renderScreen(controller);
    await screen.press('modes-add-range-1');
    const bar = screen.find('modes-save-bar');
    await ReactTestRenderer.act(async () => { await bar.props.onSave(); });
    expect(controller.save).toHaveBeenCalledWith(
      {sessionId: 'fc', generation: 1},
      snapshot,
      expect.objectContaining({conditions: [expect.objectContaining({kind: 'RANGE', permanentId: 1})]}),
    );
    screen.unmount();
  });

  it('keeps the screen fail-closed when a motor-test session blocks loading', async () => {
    const openMotors = jest.fn();
    const controller: ModesControllerPort = {load: jest.fn(async () => ({kind: 'REJECTED' as const, reason: 'MOTOR_TEST_ACTIVE' as const})), save: jest.fn()};
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ModesScreen sessionKey={{sessionId: 'fc', generation: 1}} active onOpenMotors={openMotors} controller={controller} />); await Promise.resolve(); });
    const action = renderer.root.findAllByProps({testID: 'modes-open-motors'})[0];
    ReactTestRenderer.act(() => action.props.onPress());
    expect(openMotors).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
