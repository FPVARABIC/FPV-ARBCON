/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.3) - pure byte/Base64/hex helpers for
 * UsbSerialDebugPanel.tsx only. Kept separate from that component so these
 * can be unit-tested directly under Jest without any RN rendering. No
 * dependency was added for this (no `base-64`/`buffer` package in
 * package.json) - React Native's Hermes runtime does not ship
 * `atob`/`btoa`, so this is a small, self-contained implementation scoped
 * to this debug tool only. Delete alongside UsbSerialDebugPanel.tsx.
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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

const DECIMAL_BYTE_PATTERN = /^\d{1,3}$/;
const HEX_BYTE_PATTERN = /^0x[0-9a-f]{1,2}$/i;

/**
 * Parses a comma/whitespace-separated list of byte values (decimal, or hex
 * with a 0x prefix) into a Uint8Array. Returns null - never throws - on any
 * unparseable or out-of-range (0-255) entry, so the debug panel can show a
 * clear "could not parse" message instead of crashing on a typo.
 *
 * Each token is validated against a strict, fully-anchored regex BEFORE
 * parseInt ever runs - parseInt's own leniency (silently truncating
 * trailing garbage, e.g. parseInt("12xyz", 10) === 12, or stopping at the
 * first invalid digit, e.g. parseInt("0xAG", 16) === 10) is never relied
 * on for validation. parseInt is only used afterward, to read the numeric
 * value out of a token the regex has already fully accepted.
 */
export function parseByteInput(input: string): Uint8Array | null {
  const parts = input
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    const isHex = HEX_BYTE_PATTERN.test(part);
    if (!isHex && !DECIMAL_BYTE_PATTERN.test(part)) {
      return null;
    }
    const value = isHex ? parseInt(part, 16) : parseInt(part, 10);
    if (value < 0 || value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return Uint8Array.from(bytes);
}
