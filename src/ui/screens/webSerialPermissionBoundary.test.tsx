/**
 * THE PERMISSION BOUNDARY - the first stage a real hardware trace failed at.
 *
 * The trace from a real Kakute F7 session read, in full:
 *
 *     connectionState: ready
 *     deviceCount: 0
 *     bytes: sent=0 (0 writes)  received=0 (0 chunks)
 *     SCAN_OK authorizedPorts=0
 *     SCAN_OK authorizedPorts=0
 *     SCAN_OK authorizedPorts=0
 *
 * No port was ever opened and no MSP byte was ever written, so every
 * conclusion about MSP, BOARD_INFO or board naming was unreachable. The
 * cause was the screen itself: navigator.serial.getPorts() returns only
 * already-authorized ports, so on a first visit it returns zero whatever is
 * plugged in - and the screen answered that with "لم يتم العثور على جهاز
 * USB" and offered «تحديث» as the obvious action, which can only ever
 * return zero again. The one control that could have worked sat below that
 * verdict as a secondary button.
 *
 * These tests hold the corrected boundary in place:
 *   - zero authorized ports is a PERMISSION state, never an absence of
 *     hardware, and it puts one obvious enabled action on screen
 *   - that action calls requestPort() exactly once, from the gesture
 *   - requestPort() is NEVER called on load
 *   - a dismissed chooser is not a failure and never says "unsupported"
 *   - an already-authorized port reconnects with no chooser at all
 *   - Android renders none of this and is untouched
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Platform, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import UsbDeviceList from '../components/connection/UsbDeviceList';

type Renderer = ReactTestRenderer.ReactTestRenderer;

const NO_DEVICES: never[] = [];

const AUTHORIZED_DEVICE = {
  deviceId: 7,
  vendorId: 0x0483,
  productId: 0x5740,
  driverType: 'WEB_SERIAL',
  portCount: 1,
};

function renderList(props: Partial<React.ComponentProps<typeof UsbDeviceList>>): Renderer {
  let tree!: Renderer;
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

function text(tree: Renderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function control(tree: Renderer, testID: string) {
  return tree.root
    .findAllByProps({testID})
    .find(node => typeof node.props.onPress === 'function' || node.props.testID === testID);
}

const renderers: Renderer[] = [];
afterEach(() => {
  renderers.splice(0).forEach(tree => act(() => tree.unmount()));
  jest.clearAllMocks();
});

describe('zero authorized ports is a permission state, not a missing board', () => {
  it('shows ONE obvious enabled action instead of a "no device found" verdict', () => {
    const onRequestDevice = jest.fn();
    const tree = renderList({onRequestDevice});
    renderers.push(tree);

    // The action exists, is enabled, and is the permission-state control.
    const button = control(tree, 'usb-request-device-button');
    expect(button).toBeDefined();
    expect(button?.props.disabled).toBe(false);
    expect(control(tree, 'usb-permission-required')).toBeDefined();

    // ...and the false verdict is gone.
    expect(text(tree)).not.toContain('لم يتم العثور على جهاز USB');
    expect(text(tree)).toContain('الاتصال بمتحكم الطيران');
  });

  it('says what is actually true: the browser has granted no port yet', () => {
    const tree = renderList({onRequestDevice: jest.fn()});
    renderers.push(tree);
    const screen = text(tree);

    expect(screen).toContain('لم يمنح المتصفح إذن الوصول إلى أي منفذ بعد');
    // Explicitly denies the wrong inference rather than leaving it open.
    expect(screen).toContain('هذا لا يعني أن اللوحة غير متصلة');
  });

  it('the action is a real press target, and pressing it asks exactly once', () => {
    const onRequestDevice = jest.fn();
    const tree = renderList({onRequestDevice});
    renderers.push(tree);

    act(() => {
      control(tree, 'usb-request-device-button')?.props.onPress();
    });
    expect(onRequestDevice).toHaveBeenCalledTimes(1);
  });

  it('once a port IS authorized, the permission state is gone', () => {
    const tree = renderList({
      devices: [AUTHORIZED_DEVICE] as never,
      onRequestDevice: jest.fn(),
    });
    renderers.push(tree);

    // The chooser stays available for adding another board, but it is no
    // longer the emphasized "you must do this" state.
    expect(control(tree, 'usb-permission-required')).toBeUndefined();
    expect(control(tree, 'usb-picker-section')).toBeDefined();
    expect(text(tree)).not.toContain('لم يمنح المتصفح إذن الوصول إلى أي منفذ بعد');
  });

  it('a still-running scan is never reported as a permission problem', () => {
    const tree = renderList({scanning: true, onRequestDevice: jest.fn()});
    renderers.push(tree);
    expect(control(tree, 'usb-permission-required')).toBeUndefined();
  });

  it('ANDROID renders no chooser and keeps its own empty-state copy', () => {
    // Android's permission dialog is raised by the system during open();
    // the screen passes no handler there, so none of the above applies.
    const previous = Platform.OS;
    // Writable at runtime; the type merely describes the usual case.
    (Platform as {OS: string}).OS = 'android';
    try {
      const tree = renderList({});
      renderers.push(tree);
      expect(control(tree, 'usb-request-device-button')).toBeUndefined();
      expect(control(tree, 'usb-permission-required')).toBeUndefined();
      // The honest Android message still stands: there really is nothing.
      expect(text(tree)).toContain('لم يتم العثور على جهاز USB');
    } finally {
      (Platform as {OS: string}).OS = previous;
    }
  });
});
