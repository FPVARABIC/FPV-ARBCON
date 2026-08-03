/**
 * Manual Jest mock. TurboModuleRegistry.getEnforcing() throws immediately
 * in the test environment (no native binary is registered), so every test
 * that imports anything depending on NativeUsbSerialTransport.ts - directly
 * or transitively - must call jest.mock() on this module first.
 */
const NativeUsbSerialTransport = {
  listDevices: jest.fn(),
  openDevice: jest.fn(),
  closeSession: jest.fn(),
  writeBytes: jest.fn(),
  setControlLines: jest.fn(),
  setBaudRate: jest.fn(),
  listDfuDevices: jest.fn(),
  pickFirmwareFile: jest.fn(),
  saveFirmwareFile: jest.fn(),
  flashDfuFirmware: jest.fn(),
  cancelDfuFlash: jest.fn(),
  exitDfuMode: jest.fn(),
  unprotectDfuDevice: jest.fn(),
  startReading: jest.fn(),
  stopReading: jest.fn(),
  onDataReceived: jest.fn(() => ({remove: jest.fn()})),
  onSessionDetached: jest.fn(() => ({remove: jest.fn()})),
  onError: jest.fn(() => ({remove: jest.fn()})),
  onDeviceAttached: jest.fn(() => ({remove: jest.fn()})),
  onDeviceDetached: jest.fn(() => ({remove: jest.fn()})),
  onDfuFlashProgress: jest.fn(() => ({remove: jest.fn()})),
};

export default NativeUsbSerialTransport;
