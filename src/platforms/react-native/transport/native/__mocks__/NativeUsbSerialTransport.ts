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
  onDataReceived: jest.fn(() => ({remove: jest.fn()})),
  onSessionDetached: jest.fn(() => ({remove: jest.fn()})),
  onError: jest.fn(() => ({remove: jest.fn()})),
  onDeviceAttached: jest.fn(() => ({remove: jest.fn()})),
  onDeviceDetached: jest.fn(() => ({remove: jest.fn()})),
};

export default NativeUsbSerialTransport;
