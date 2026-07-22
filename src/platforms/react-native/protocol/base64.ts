/**
 * Minimal Base64 codec for the React Native MSP transport boundary
 * (RNMspTransport.ts). React Native's Hermes runtime does not ship
 * atob/btoa, and no base64/buffer dependency exists in package.json, so
 * this is a small, self-contained implementation - algorithmically the
 * same well-known technique as usbSerialDebugPanelBytes.ts's own
 * bytesToBase64()/base64ToBytes(), but NOT reused from there: that file is
 * explicitly documented as temporary debug scaffolding to be deleted
 * alongside UsbSerialDebugPanel.tsx, and it lives under src/ui/screens -
 * importing it from this permanent, platform-layer adapter would both
 * outlive that stated lifecycle and invert this project's established
 * dependency direction (src/ui depends on src/platforms/src/core, never
 * the reverse - see docs/ARCHITECTURE.md).
 */

/* eslint-disable no-bitwise -- a byte-level base64 codec is inherently bit
   manipulation; every use below is a deliberate, ordinary encode/decode
   operation, not a style slip. */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    result += BASE64_CHARS[(triplet >> 18) & 0x3f];
    result += BASE64_CHARS[(triplet >> 12) & 0x3f];
    result += b1 === undefined ? '=' : BASE64_CHARS[(triplet >> 6) & 0x3f];
    result += b2 === undefined ? '=' : BASE64_CHARS[triplet & 0x3f];
  }
  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  // eslint-disable-next-line no-div-regex -- a literal regex, not division.
  const clean = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of clean) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
