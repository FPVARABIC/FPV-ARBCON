/**
 * Connection lifecycle only - no read/write, no MSP, no reconnect. `idle`
 * and `ready` both display as the same "غير متصل" badge; they are kept
 * distinct internally only to know whether a scan has already completed.
 */
export type ConnectionState =
  | 'idle'
  | 'scanning'
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface ValidationLogEntry {
  id: number;
  timestamp: number;
  messageKey: string;
  params?: Record<string, string | number>;
}

export function connectionStateLabelKey(state: ConnectionState): string {
  if (state === 'idle' || state === 'ready') {
    return 'connection.state.disconnected';
  }
  return `connection.state.${state}`;
}

/** Stable composite identity for a device across a rescan - deviceId alone
 * is not guaranteed stable across detach/reattach (see UsbDeviceIdentity.kt
 * on the native side), so vendorId/productId are checked alongside it. */
export function deviceKey(device: {
  deviceId: number;
  vendorId: number;
  productId: number;
}): string {
  return `${device.deviceId}:${device.vendorId}:${device.productId}`;
}
