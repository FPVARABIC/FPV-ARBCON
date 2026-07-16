import NativeUsbSerialTransport from './native/NativeUsbSerialTransport';
import type {
  SerialConfiguration,
  UsbSerialDeviceDescriptor,
} from './native/NativeUsbSerialTransport';
import {normalizeNativeError} from './transportErrors';

export type {SerialConfiguration, UsbSerialDeviceDescriptor};

/**
 * driverType value the Kotlin side (UsbSerialDriverType.UNSUPPORTED) reports
 * for any device it does not recognize as a supported serial driver.
 */
const UNSUPPORTED_DRIVER_TYPE = 'UNSUPPORTED';

/**
 * A device is connectable only when the native layer both recognized its
 * driver and reported at least one usable port. Support is never inferred
 * from product/manufacturer text or from VID/PID - only from these two
 * native-reported fields, matching UsbSerialDriverType.portCountFor's own
 * invariant that an UNSUPPORTED device can never carry a nonzero port count.
 */
export function isSupportedDevice(device: UsbSerialDeviceDescriptor): boolean {
  return device.driverType !== UNSUPPORTED_DRIVER_TYPE && device.portCount > 0;
}

function isValidDescriptor(value: unknown): value is UsbSerialDeviceDescriptor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === 'number' &&
    typeof candidate.vendorId === 'number' &&
    typeof candidate.productId === 'number' &&
    typeof candidate.driverType === 'string' &&
    typeof candidate.portCount === 'number' &&
    (candidate.productName === undefined || typeof candidate.productName === 'string') &&
    (candidate.manufacturerName === undefined ||
      typeof candidate.manufacturerName === 'string')
  );
}

/**
 * Thin internal client around the UsbSerialTransport TurboModule. This is
 * the only file that should import the default export of
 * NativeUsbSerialTransport.ts directly - the screen and its components only
 * ever see this client's stable result/error types.
 *
 * Deliberately does not: implement src/core's Transport, implement
 * AndroidUsbTransport, call writeBytes, touch Base64, retry, reconnect, or
 * persist anything. It validates shapes defensively and normalizes rejected
 * values; it does not decide UI policy.
 */
export class UsbSerialTransportClient {
  async listDevices(): Promise<UsbSerialDeviceDescriptor[]> {
    let result: unknown;
    try {
      result = await NativeUsbSerialTransport.listDevices();
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (!Array.isArray(result)) {
      throw normalizeNativeError(new Error('listDevices resolved with a non-array result.'));
    }
    // Malformed entries are dropped rather than failing the whole scan -
    // one unrecognizable descriptor should not hide every other device.
    return result.filter(isValidDescriptor);
  }

  async openDevice(
    deviceId: number,
    portIndex: number,
    configuration: SerialConfiguration,
  ): Promise<string> {
    let sessionId: unknown;
    try {
      sessionId = await NativeUsbSerialTransport.openDevice(deviceId, portIndex, configuration);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw normalizeNativeError(new Error('openDevice resolved with an empty sessionId.'));
    }
    return sessionId;
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await NativeUsbSerialTransport.closeSession(sessionId);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }
}

export const usbSerialTransportClient = new UsbSerialTransportClient();
