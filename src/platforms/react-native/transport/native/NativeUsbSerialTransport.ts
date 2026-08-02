import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

type EventEmitter<T> = CodegenTypes.EventEmitter<T>;

export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = '1' | '1.5' | '2';
export type SerialParity = 'none' | 'odd' | 'even' | 'mark' | 'space';
export type SerialFlowControl = 'off' | 'rtsCts' | 'dtrDsr' | 'xonXoff';

export type UsbSerialDeviceDescriptor = {
  deviceId: number;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  driverType: string;
  portCount: number;
};

export type SerialConfiguration = {
  baudRate: number;
  dataBits: SerialDataBits;
  stopBits: SerialStopBits;
  parity: SerialParity;
  flowControl: SerialFlowControl;
};

export type UsbSerialDataEvent = {
  sessionId: string;
  dataBase64: string;
};

export type UsbSerialSessionDetachedEvent = {
  sessionId: string;
  deviceId: number;
};

/**
 * Canonical device identity only (deviceId/vendorId/productId) - the same
 * shape UsbSerialDeviceDescriptor's identity fields and UsbDeviceIdentity.kt
 * use. Carries no product name, no display label, and no firmware/session
 * information: hot-plug attach/detach is a device-presence signal only, not
 * a session or connection event.
 */
export type UsbDeviceHotplugEvent = {
  deviceId: number;
  vendorId: number;
  productId: number;
};

export type UsbSerialErrorEvent = {
  sessionId?: string;
  deviceId?: number;
  code: string;
  message: string;
  recoverable: boolean;
};

export type FirmwareFileSelection = {
  name: string;
  sizeBytes: number;
  dataBase64: string;
};

export type DfuDeviceDescriptor = {
  deviceId: number;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  interfaceNumber: number;
  alternateSetting: number;
  memoryLayout?: string;
};

export type DfuFlashProgressEvent = {
  phase: string;
  percent: number;
  bytesProcessed: number;
  totalBytes: number;
};

export interface Spec extends TurboModule {
  listDevices(): Promise<UsbSerialDeviceDescriptor[]>;

  openDevice(
    deviceId: number,
    portIndex: number,
    configuration: SerialConfiguration,
  ): Promise<string>;

  closeSession(sessionId: string): Promise<void>;

  writeBytes(sessionId: string, dataBase64: string): Promise<void>;

  setControlLines(sessionId: string, dtr: boolean, rts: boolean): Promise<void>;
  setBaudRate(sessionId: string, baudRate: number): Promise<void>;

  listDfuDevices(): Promise<DfuDeviceDescriptor[]>;

  pickFirmwareFile(): Promise<FirmwareFileSelection | null>;

  saveFirmwareFile(filename: string, mimeType: string, dataBase64: string): Promise<boolean>;

  flashDfuFirmware(deviceId: number, intelHexBase64: string, fullErase: boolean): Promise<void>;

  cancelDfuFlash(): Promise<void>;

  exitDfuMode(deviceId: number): Promise<void>;

  unprotectDfuDevice(deviceId: number): Promise<void>;

  /**
   * Starts a receive loop for an already-open session. Explicit only - never
   * started implicitly by openDevice(). Rejects if the session is unknown,
   * if a receive loop is already active for it, or if the module is being
   * torn down. Received chunks arrive via onDataReceived; an unexpected
   * native read failure arrives via onError, not as a rejection of some
   * later call - this Promise only reflects whether the loop was started.
   */
  startReading(sessionId: string): Promise<void>;

  /**
   * Stops the receive loop for a session, if one is active. Idempotent -
   * safe to call repeatedly, or for a session with no active receive loop.
   * Never closes or otherwise affects the underlying session.
   */
  stopReading(sessionId: string): Promise<void>;

  readonly onDataReceived: EventEmitter<UsbSerialDataEvent>;
  readonly onSessionDetached: EventEmitter<UsbSerialSessionDetachedEvent>;
  readonly onError: EventEmitter<UsbSerialErrorEvent>;
  readonly onDeviceAttached: EventEmitter<UsbDeviceHotplugEvent>;
  readonly onDeviceDetached: EventEmitter<UsbDeviceHotplugEvent>;
  readonly onDfuFlashProgress: EventEmitter<DfuFlashProgressEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('UsbSerialTransport');
