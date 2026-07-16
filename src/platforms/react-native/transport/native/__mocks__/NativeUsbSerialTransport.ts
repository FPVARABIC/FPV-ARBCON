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
};

export default NativeUsbSerialTransport;
