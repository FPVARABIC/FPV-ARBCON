/**
 * THE EXPLICIT DEVICE-CHOOSER BUTTON.
 *
 * In a browser this button is not a convenience: navigator.serial.getPorts()
 * lists only ports the operator has already authorized, so on a first visit
 * the ordinary scan legitimately finds nothing and there is no other way to
 * reach a first connection. On Android the system raises its own permission
 * dialog during open(), so the button must not appear at all.
 *
 * Those two facts are what these tests hold in place. The screen decides
 * which case applies by asking the transport client; this component's only
 * job is to render the button when it is given a handler and to render
 * nothing when it is not.
 */

// UsbDeviceRow reaches the transport barrel for its descriptor type, and
// the TurboModule spec calls getEnforcing() at module load. Same mock every
// other screen test in this repository uses.
jest.mock('../../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import UsbDeviceList from './UsbDeviceList';
import '../../../i18n';

const NO_DEVICES: never[] = [];

function render(props: Partial<React.ComponentProps<typeof UsbDeviceList>>) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <UsbDeviceList
        devices={NO_DEVICES}
        scanning={false}
        hasScannedOnce
        refreshDisabled={false}
        selectedKey={null}
        selectionDisabled={false}
        onRefresh={() => {}}
        onSelectDevice={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

function find(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(node => node.props?.testID === testID, {deep: false});
}

describe('UsbDeviceList device picker', () => {
  it('does NOT render the chooser on a platform that has none (Android)', () => {
    // Android's permission dialog comes from the system during open().
    // A "choose a device" button there would promise a step that does not
    // exist and cannot do anything.
    const tree = render({});

    expect(find(tree, 'usb-request-device-button')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('renders the chooser when the platform supplies one (browser)', () => {
    const tree = render({onRequestDevice: () => {}});

    expect(find(tree, 'usb-request-device-button')).toHaveLength(1);
    act(() => tree.unmount());
  });

  it('invokes the handler on press', () => {
    const onRequestDevice = jest.fn();
    const tree = render({onRequestDevice});

    act(() => {
      find(tree, 'usb-request-device-button')[0].props.onPress();
    });

    expect(onRequestDevice).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('does not invoke the handler while disabled', () => {
    // Disabled during connect/disconnect and while connected: opening a
    // chooser mid-handshake would let a second device be authorized while
    // the first is being opened.
    const onRequestDevice = jest.fn();
    const tree = render({onRequestDevice, requestDeviceDisabled: true});

    const [button] = find(tree, 'usb-request-device-button');
    expect(button.props.disabled).toBe(true);
    expect(button.props.onPress).toBeUndefined();
    expect(onRequestDevice).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('keeps the ordinary refresh button alongside it', () => {
    // The chooser grants permission; the scan is still what enumerates.
    // Replacing refresh with the chooser would make every rescan pop a
    // browser dialog.
    const tree = render({onRequestDevice: () => {}});

    expect(find(tree, 'usb-refresh-button')).toHaveLength(1);
    act(() => tree.unmount());
  });
});
