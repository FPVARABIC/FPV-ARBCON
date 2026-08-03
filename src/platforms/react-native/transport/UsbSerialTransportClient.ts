import NativeUsbSerialTransport from './native/NativeUsbSerialTransport';
import type {
  SerialConfiguration,
  UsbDeviceHotplugEvent,
  UsbSerialDataEvent,
  UsbSerialDeviceDescriptor,
  UsbSerialErrorEvent,
  UsbSerialSessionDetachedEvent,
  FirmwareFileSelection,
  DfuDeviceDescriptor,
  DfuFlashProgressEvent,
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

function isValidHotplugEvent(value: unknown): value is UsbDeviceHotplugEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === 'number' &&
    typeof candidate.vendorId === 'number' &&
    typeof candidate.productId === 'number'
  );
}

function isValidSessionDetachedEvent(value: unknown): value is UsbSerialSessionDetachedEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' && typeof candidate.deviceId === 'number';
}

function isValidDataEvent(value: unknown): value is UsbSerialDataEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' && typeof candidate.dataBase64 === 'string';
}

function isValidErrorEvent(value: unknown): value is UsbSerialErrorEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.recoverable === 'boolean' &&
    (candidate.sessionId === undefined || typeof candidate.sessionId === 'string') &&
    (candidate.deviceId === undefined || typeof candidate.deviceId === 'number')
  );
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

function isValidFirmwareFile(value: unknown): value is FirmwareFileSelection {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string' && candidate.name.length > 0 &&
    typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > 0 &&
    typeof candidate.dataBase64 === 'string' && candidate.dataBase64.length > 0;
}

function isValidDfuDescriptor(value: unknown): value is DfuDeviceDescriptor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.deviceId === 'number' &&
    typeof candidate.vendorId === 'number' &&
    typeof candidate.productId === 'number' &&
    typeof candidate.interfaceNumber === 'number' &&
    typeof candidate.alternateSetting === 'number' &&
    (candidate.productName === undefined || typeof candidate.productName === 'string') &&
    (candidate.manufacturerName === undefined || typeof candidate.manufacturerName === 'string') &&
    (candidate.memoryLayout === undefined || typeof candidate.memoryLayout === 'string');
}

function isValidDfuProgress(value: unknown): value is DfuFlashProgressEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.phase === 'string' &&
    typeof candidate.percent === 'number' && candidate.percent >= 0 && candidate.percent <= 100 &&
    typeof candidate.bytesProcessed === 'number' && candidate.bytesProcessed >= 0 &&
    typeof candidate.totalBytes === 'number' && candidate.totalBytes >= 0;
}

/**
 * Thin internal client around the UsbSerialTransport TurboModule. This is
 * the only file that should import the default export of
 * NativeUsbSerialTransport.ts directly - the screen and its components only
 * ever see this client's stable result/error types.
 *
 * Deliberately does not: implement src/core's Transport, implement
 * AndroidUsbTransport, decode or interpret dataBase64's contents, parse any
 * protocol, retry, reconnect, or persist anything. It validates shapes
 * defensively and normalizes rejected values; it does not decide UI policy.
 * Pass 5.2 adds startReading()/stopReading() and the onDataReceived/onError
 * subscriptions; Pass 5.3 adds writeBytes() - dataBase64 crosses this
 * boundary exactly as the caller/native side encoded it, opaque to this
 * client either direction.
 */
/**
 * THE ONE CAPABILITY ANDROID DOES NOT HAVE, reached without touching the
 * TurboModule spec.
 *
 * A browser will not list a serial port until the user has picked it from
 * the browser's own chooser, and that chooser may only be opened from a
 * real user gesture. Android has no equivalent: its permission dialog is
 * raised by the system during open(), so the Kotlin module needs no such
 * method.
 *
 * This is deliberately NOT an optional member on `Spec`. That file is the
 * codegen source for the Android native interface (see package.json's
 * codegenConfig), so adding a method there would change the generated
 * Kotlin contract and demand a native implementation for a capability
 * Android does not need. Instead the web module exports the extra
 * function, and the client looks for it defensively - present in the
 * browser, absent on Android, and typechecked against both.
 */
type OptionalDevicePicker = {
  requestSerialDevice?: () => Promise<UsbSerialDeviceDescriptor | null>;
};

function devicePicker(): OptionalDevicePicker['requestSerialDevice'] {
  return (NativeUsbSerialTransport as unknown as OptionalDevicePicker)
    .requestSerialDevice;
}

export class UsbSerialTransportClient {
  /**
   * Whether this platform has an explicit "choose a device" step. False on
   * Android. The UI uses this to decide whether to OFFER the button at
   * all - never to decide whether a device exists.
   */
  supportsDevicePicker(): boolean {
    return typeof devicePicker() === 'function';
  }

  /**
   * Opens the platform's device chooser. MUST be called from a user
   * gesture; browsers reject it otherwise.
   *
   * Resolves with `null` when the operator dismissed the chooser without
   * choosing - a cancellation, not a failure, and the UI must not show an
   * error for it.
   */
  async requestDevicePermission(): Promise<UsbSerialDeviceDescriptor | null> {
    const request = devicePicker();
    if (!request) {
      throw normalizeNativeError(
        Object.assign(
          new Error('This platform has no explicit device picker.'),
          {code: 'NOT_IMPLEMENTED'},
        ),
      );
    }
    let result: unknown;
    try {
      result = await request();
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (result === null || result === undefined) {
      return null;
    }
    if (!isValidDescriptor(result)) {
      throw normalizeNativeError(
        new Error('requestDevicePermission resolved with an invalid descriptor.'),
      );
    }
    return result;
  }

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

  /**
   * Starts the receive loop for an already-open session. Explicit only -
   * this client never calls it implicitly from openDevice(). See
   * onDataReceived/onError for how received bytes and receive-loop failures
   * are reported afterward.
   */
  async startReading(sessionId: string): Promise<void> {
    try {
      await NativeUsbSerialTransport.startReading(sessionId);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  /**
   * Stops the receive loop for a session. Idempotent - safe to call
   * repeatedly, or for a session with no active receive loop. Never closes
   * the underlying session.
   */
  async stopReading(sessionId: string): Promise<void> {
    try {
      await NativeUsbSerialTransport.stopReading(sessionId);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  /**
   * Writes bytes (already Base64-encoded by the caller) to an already-open
   * session. Explicit only - never called implicitly by this client.
   * Resolves only once the native side reports the write itself actually
   * completed (success or failure) - never merely once it was queued. This
   * client does not encode, batch, retry, or otherwise interpret
   * dataBase64's contents.
   */
  async writeBytes(sessionId: string, dataBase64: string): Promise<void> {
    try {
      await NativeUsbSerialTransport.writeBytes(sessionId, dataBase64);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async setControlLines(sessionId: string, dtr: boolean, rts: boolean): Promise<void> {
    try {
      await NativeUsbSerialTransport.setControlLines(sessionId, dtr, rts);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async setBaudRate(sessionId: string, baudRate: number): Promise<void> {
    try {
      await NativeUsbSerialTransport.setBaudRate(sessionId, baudRate);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async listDfuDevices(): Promise<DfuDeviceDescriptor[]> {
    let result: unknown;
    try {
      result = await NativeUsbSerialTransport.listDfuDevices();
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (!Array.isArray(result)) {
      throw normalizeNativeError(new Error('listDfuDevices resolved with a non-array result.'));
    }
    return result.filter(isValidDfuDescriptor);
  }

  async pickFirmwareFile(): Promise<FirmwareFileSelection | null> {
    let result: unknown;
    try {
      result = await NativeUsbSerialTransport.pickFirmwareFile();
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (result === null) {
      return null;
    }
    if (!isValidFirmwareFile(result)) {
      throw normalizeNativeError(new Error('pickFirmwareFile resolved with an invalid file result.'));
    }
    return result;
  }

  async saveFirmwareFile(filename: string, mimeType: string, dataBase64: string): Promise<boolean> {
    let result: unknown;
    try {
      result = await NativeUsbSerialTransport.saveFirmwareFile(filename, mimeType, dataBase64);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
    if (typeof result !== 'boolean') {
      throw normalizeNativeError(new Error('saveFirmwareFile resolved with a non-boolean result.'));
    }
    return result;
  }

  async flashDfuFirmware(deviceId: number, intelHexBase64: string, fullErase: boolean): Promise<void> {
    try {
      await NativeUsbSerialTransport.flashDfuFirmware(deviceId, intelHexBase64, fullErase);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async cancelDfuFlash(): Promise<void> {
    try {
      await NativeUsbSerialTransport.cancelDfuFlash();
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async exitDfuMode(deviceId: number): Promise<void> {
    try {
      await NativeUsbSerialTransport.exitDfuMode(deviceId);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  async unprotectDfuDevice(deviceId: number): Promise<void> {
    try {
      await NativeUsbSerialTransport.unprotectDfuDevice(deviceId);
    } catch (reason) {
      throw normalizeNativeError(reason);
    }
  }

  /**
   * Subscribes to received serial data. dataBase64 is delivered exactly as
   * the native side encoded it - this client does not decode, interpret, or
   * touch its contents. Malformed events (missing sessionId/dataBase64) are
   * dropped rather than forwarded.
   */
  onDataReceived(callback: (event: UsbSerialDataEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onDataReceived(event => {
      if (isValidDataEvent(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }

  /**
   * Subscribes to native transport errors, including an active receive
   * loop's unexpected termination (code READ_FAILED). Malformed events are
   * dropped rather than forwarded.
   */
  onError(callback: (event: UsbSerialErrorEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onError(event => {
      if (isValidErrorEvent(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }

  /**
   * Subscribes to the native USB attach broadcast. Fires with the attached
   * device's canonical identity only - never a session, never a firmware
   * claim. Returns an unsubscribe function; malformed events (missing
   * fields) are dropped rather than forwarded.
   */
  onDeviceAttached(callback: (event: UsbDeviceHotplugEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onDeviceAttached(event => {
      if (isValidHotplugEvent(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }

  /** Subscribes to the native USB detach broadcast. See onDeviceAttached. */
  onDeviceDetached(callback: (event: UsbDeviceHotplugEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onDeviceDetached(event => {
      if (isValidHotplugEvent(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }

  /**
   * Subscribes to the native "active session's device physically detached"
   * broadcast - distinct from onDeviceDetached: this only fires when the
   * detached device owned an open session, and carries that sessionId.
   */
  onSessionDetached(callback: (event: UsbSerialSessionDetachedEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onSessionDetached(event => {
      if (isValidSessionDetachedEvent(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }

  onDfuFlashProgress(callback: (event: DfuFlashProgressEvent) => void): () => void {
    const subscription = NativeUsbSerialTransport.onDfuFlashProgress(event => {
      if (isValidDfuProgress(event)) {
        callback(event);
      }
    });
    return () => subscription.remove();
  }
}

export const usbSerialTransportClient = new UsbSerialTransportClient();
