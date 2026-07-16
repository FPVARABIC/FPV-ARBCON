export type {
  UsbSerialTransportSpec,
  UsbSerialDeviceDescriptor,
  SerialDataBits,
  SerialStopBits,
  SerialParity,
  SerialFlowControl,
  SerialConfiguration,
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialErrorEvent,
} from './native';

export {
  UsbSerialTransportClient,
  usbSerialTransportClient,
  isSupportedDevice,
} from './UsbSerialTransportClient';

export {
  normalizeNativeError,
  localizeTransportError,
  KNOWN_ERROR_CODES,
} from './transportErrors';
export type {TransportError, KnownTransportErrorCode} from './transportErrors';
