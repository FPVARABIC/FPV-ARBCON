/**
 * THE DRIFT GUARD BETWEEN THE TWO TYPE DECLARATIONS.
 *
 * usbSerialTransportTypes.ts explains why the browser transport cannot
 * import its types from the TurboModule spec (moduleSuffixes resolves that
 * path back to the browser file) and why the spec cannot import them from
 * there (it is React Native codegen's input and is parsed as one file).
 * The cost of that decision is two declarations of the same shapes, and
 * the mitigation is this file.
 *
 * It is typechecked by tsconfig.json, where './NativeUsbSerialTransport'
 * resolves to the REAL spec - so `assignable` below compares the spec's
 * types against the shared ones in both directions. Add a field to one
 * side only, or change `stopBits` on one side only, and the Android
 * typecheck fails naming exactly which type diverged.
 *
 * There are no runtime assertions here. The check is the compilation
 * itself; the single `expect` exists because Jest fails a suite with no
 * test in it.
 */

import type {
  DfuDeviceDescriptor as SpecDfuDeviceDescriptor,
  DfuFlashProgressEvent as SpecDfuFlashProgressEvent,
  FirmwareFileSelection as SpecFirmwareFileSelection,
  SerialConfiguration as SpecSerialConfiguration,
  SerialDataBits as SpecSerialDataBits,
  SerialFlowControl as SpecSerialFlowControl,
  SerialParity as SpecSerialParity,
  SerialStopBits as SpecSerialStopBits,
  UsbDeviceHotplugEvent as SpecUsbDeviceHotplugEvent,
  UsbSerialDataEvent as SpecUsbSerialDataEvent,
  UsbSerialDeviceDescriptor as SpecUsbSerialDeviceDescriptor,
  UsbSerialErrorEvent as SpecUsbSerialErrorEvent,
  UsbSerialSessionDetachedEvent as SpecUsbSerialSessionDetachedEvent,
} from './NativeUsbSerialTransport';
import type {
  DfuDeviceDescriptor,
  DfuFlashProgressEvent,
  FirmwareFileSelection,
  SerialConfiguration,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
  UsbDeviceHotplugEvent,
  UsbSerialDataEvent,
  UsbSerialDeviceDescriptor,
  UsbSerialErrorEvent,
  UsbSerialSessionDetachedEvent,
} from './usbSerialTransportTypes';

/**
 * Resolves to `true` only when A and B are mutually assignable. A one-way
 * check would pass while one side quietly gained an extra optional field.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** Compiles only if the argument is exactly `true`. */
function assertIdentical<T extends true>(): T {
  return true as T;
}

assertIdentical<MutuallyAssignable<SpecSerialDataBits, SerialDataBits>>();
assertIdentical<MutuallyAssignable<SpecSerialStopBits, SerialStopBits>>();
assertIdentical<MutuallyAssignable<SpecSerialParity, SerialParity>>();
assertIdentical<MutuallyAssignable<SpecSerialFlowControl, SerialFlowControl>>();
assertIdentical<
  MutuallyAssignable<SpecUsbSerialDeviceDescriptor, UsbSerialDeviceDescriptor>
>();
assertIdentical<MutuallyAssignable<SpecSerialConfiguration, SerialConfiguration>>();
assertIdentical<MutuallyAssignable<SpecUsbSerialDataEvent, UsbSerialDataEvent>>();
assertIdentical<
  MutuallyAssignable<SpecUsbSerialSessionDetachedEvent, UsbSerialSessionDetachedEvent>
>();
assertIdentical<
  MutuallyAssignable<SpecUsbDeviceHotplugEvent, UsbDeviceHotplugEvent>
>();
assertIdentical<MutuallyAssignable<SpecUsbSerialErrorEvent, UsbSerialErrorEvent>>();
assertIdentical<
  MutuallyAssignable<SpecFirmwareFileSelection, FirmwareFileSelection>
>();
assertIdentical<MutuallyAssignable<SpecDfuDeviceDescriptor, DfuDeviceDescriptor>>();
assertIdentical<
  MutuallyAssignable<SpecDfuFlashProgressEvent, DfuFlashProgressEvent>
>();

describe('usbSerialTransportTypes', () => {
  it('declares the same shapes as the TurboModule spec', () => {
    // The real assertion is above, at the type level: this suite failing
    // to COMPILE is the signal. Nothing meaningful can be checked at
    // runtime, since types are erased.
    expect(assertIdentical<true>()).toBe(true);
  });
});
