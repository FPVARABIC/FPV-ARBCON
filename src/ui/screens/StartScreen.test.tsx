import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import StartScreen from './StartScreen';

function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const node = renderer.root.findAllByProps({testID}).find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`Missing pressable ${testID}`);
  act(() => node.props.onPress());
}

describe('StartScreen', () => {
  it('offers the connection workspace and independent firmware flasher as separate routes', () => {
    const navigation = {navigate: jest.fn()};
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<StartScreen navigation={navigation as never} route={{} as never} />);
    });
    press(renderer, 'start-connection');
    press(renderer, 'start-firmware');
    expect(navigation.navigate).toHaveBeenNthCalledWith(1, 'Connection');
    expect(navigation.navigate).toHaveBeenNthCalledWith(2, 'FirmwareFlasher');
    act(() => renderer.unmount());
  });
});
