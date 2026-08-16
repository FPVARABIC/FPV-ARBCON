/**
 * ENTRY-FLOW GUARDS that App.test.tsx does not already carry.
 *
 * The browser device chooser (navigator.serial.requestPort() behind
 * client.requestDevicePermission()) is legally callable ONLY from a user
 * gesture. The old standalone connection screen honored that; hosting
 * the same workspace inside the Setup tab must not regress it - opening
 * the configurator is navigation, not a gesture aimed at the chooser.
 * So: mount the workspace, let its automatic enumeration settle, and
 * prove the chooser was never asked for - then press the explicit button
 * and prove that exact press is what asks.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import UsbConnectionScreen from './UsbConnectionScreen';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';

function createPickerClient() {
  return {
    listDevices: jest.fn().mockResolvedValue([]),
    openDevice: jest.fn(),
    closeSession: jest.fn(),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(() => jest.fn()),
    onDataReceived: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    writeBytes: jest.fn(),
    startReading: jest.fn(),
    stopReading: jest.fn(),
    supportsDevicePicker: jest.fn(() => true),
    requestDevicePermission: jest.fn().mockResolvedValue(null),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('the browser device chooser stays gesture-only inside the configurator', () => {
  it('mounting and auto-scanning the hosted workspace never requests device permission; the explicit button press does, exactly once', async () => {
    const client = createPickerClient();
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <UsbConnectionScreen
          client={client as unknown as UsbSerialTransportClient}
          onSessionEstablished={jest.fn()}
        />,
      );
      await settle();
    });
    await act(async () => {
      await settle();
    });

    // Navigation + automatic enumeration happened; the chooser did not.
    expect(client.listDevices).toHaveBeenCalled();
    expect(client.requestDevicePermission).not.toHaveBeenCalled();

    const button = renderer.root
      .findAllByProps({testID: 'usb-request-device-button'})
      .find(node => typeof node.props.onPress === 'function');
    expect(button).toBeDefined();

    await act(async () => {
      button!.props.onPress();
      await settle();
    });

    expect(client.requestDevicePermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });
});
