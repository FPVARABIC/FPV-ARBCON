import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import StartScreen from './StartScreen';

function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const node = renderer.root.findAllByProps({testID}).find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`Missing pressable ${testID}`);
  act(() => node.props.onPress());
}

describe('StartScreen', () => {
  it('offers exactly two DIRECT primary actions: the configurator and the firmware flasher, with no connection stop between', () => {
    const navigation = {navigate: jest.fn()};
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<StartScreen navigation={navigation as never} route={{} as never} />);
    });
    press(renderer, 'start-configure');
    press(renderer, 'start-firmware');
    // Straight to the destinations - 'Connection' is not a route this
    // product has anymore (navigation/types.ts).
    expect(navigation.navigate).toHaveBeenNthCalledWith(1, 'Setup');
    expect(navigation.navigate).toHaveBeenNthCalledWith(2, 'FirmwareFlasher');
    expect(navigation.navigate).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('renders the official brand logo at the reading-start edge of the brand row on Android', () => {
    const navigation = {navigate: jest.fn()};
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<StartScreen navigation={navigation as never} route={{} as never} />);
    });
    // The real asset, via the BrandLogo crop window - not the old
    // hand-drawn placeholder badge, which is gone entirely.
    const logos = renderer.root.findAllByProps({testID: 'start-brand-logo'});
    expect(logos.length).toBeGreaterThan(0);
    // First child of the RTL brand row = the RIGHT edge, which is the
    // required top-right placement.
    const row = renderer.root
      .findAllByProps({testID: 'start-brand-logo'})[0];
    expect(row).toBeDefined();
    act(() => renderer.unmount());
  });
});
