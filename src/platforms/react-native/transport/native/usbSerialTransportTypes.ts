/**
 * THE TRANSPORT'S DATA TYPES, SHARED BY BOTH IMPLEMENTATIONS.
 *
 * WHY THESE ARE NOT SIMPLY IMPORTED FROM THE SPEC FILE. Under
 * tsconfig.web.json's `moduleSuffixes`, every import of
 * './NativeUsbSerialTransport' resolves to the `.web.ts` sibling - that
 * resolution IS the platform seam. So the browser implementation cannot
 * import its types from the spec file: that path resolves back to the
 * browser file itself. It must therefore export the full type surface, and
 * these definitions are where it gets them.
 *
 * WHY THE SPEC FILE STILL DECLARES ITS OWN. NativeUsbSerialTransport.ts is
 * the codegen INPUT for the Android native interface (see package.json's
 * codegenConfig, which generates into com.fpvarbcon.transport). React
 * Native's codegen parses that single file and does not follow type
 * imports out of it; rewriting the spec to import from here would risk the
 * generated Kotlin contract for a purely cosmetic deduplication. That
 * trade was refused.
 *
 * WHAT STOPS THE TWO COPIES DRIFTING. Not a comment - a compile error.
 * usbSerialTransportTypes.parity.test.ts asserts mutual assignability
 * between every type here and its counterpart in the spec, and is
 * typechecked by tsconfig.json (where './NativeUsbSerialTransport'
 * resolves to the real spec). Change one side only, and the Android
 * typecheck fails naming the type that diverged.
 */

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
