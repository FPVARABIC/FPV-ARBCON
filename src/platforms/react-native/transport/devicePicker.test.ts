/**
 * THE DEVICE-PICKER PASSTHROUGH, FROM THE ANDROID SIDE.
 *
 * This file runs against the ANDROID module resolution - the TurboModule
 * spec, which has no picker - so it is the half of the contract that says
 * what happens on a platform that does not have one. The browser half is
 * covered in NativeUsbSerialTransport.web.test.ts against a real
 * navigator.serial fake.
 *
 * Why the capability is probed rather than declared: the picker is
 * deliberately NOT an optional member on `Spec`. That file is React Native
 * codegen's input for the Android native interface, so a method added
 * there would change the generated Kotlin contract and demand a native
 * implementation for something Android does not need - its permission
 * dialog is raised by the system during open().
 */

jest.mock('./native/NativeUsbSerialTransport');

import {usbSerialTransportClient} from './UsbSerialTransportClient';

describe('device picker capability on Android', () => {
  it('reports no serial picker, so the UI never offers the button', () => {
    expect(usbSerialTransportClient.supportsDevicePicker()).toBe(false);
  });

  it('reports no DFU picker either', () => {
    expect(usbSerialTransportClient.supportsDfuDevicePicker()).toBe(false);
  });

  it('rejects a serial picker call with NOT_IMPLEMENTED rather than pretending', () => {
    // Never resolves null here: null means "the operator dismissed the
    // chooser", and reporting a cancellation for a chooser that does not
    // exist would hide a real programming error behind a plausible
    // no-op.
    return expect(
      usbSerialTransportClient.requestDevicePermission(),
    ).rejects.toMatchObject({code: 'NOT_IMPLEMENTED'});
  });

  it('rejects a DFU picker call the same way', () => {
    return expect(
      usbSerialTransportClient.requestDfuDevicePermission(),
    ).rejects.toMatchObject({code: 'NOT_IMPLEMENTED'});
  });
});
