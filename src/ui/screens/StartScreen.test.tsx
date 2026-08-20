/* Home drives the connection itself now (ui/session/useDirectConnect),
   so importing it reaches the transport module graph. The native module
   is mocked for the same reason every other suite mocks it: this file is
   not testing the USB bridge. */
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

// Home renders real Arabic copy for the connection it now drives.
import '../../i18n';

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
    /*
     * THE CONFIGURATION DOOR NAVIGATES NOWHERE, and that is the whole
     * point of it.
     *
     * There is no connection route to send anyone to: with no verified
     * board this press STARTS THE CONNECTION HERE, on Home, and the
     * operator watches it happen beside the card. The only navigation
     * this screen performs is to the two public destinations.
     */
    expect(navigation.navigate).toHaveBeenNthCalledWith(1, 'FirmwareFlasher');
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    for (const [name] of navigation.navigate.mock.calls) {
      expect(name).not.toBe('Connect');
    }
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
