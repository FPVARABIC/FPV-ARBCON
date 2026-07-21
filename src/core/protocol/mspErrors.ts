/**
 * Typed diagnostic taxonomy for the MSP encode/decode foundation (Pass 6.1).
 *
 * These are internal parser diagnostics, not user-facing errors — nothing here
 * is translated or shown in the UI. If a later pass ever surfaces one of these
 * to a user, that must be flagged explicitly rather than wired silently.
 *
 * This file has no dependency on any other MSP module by design: it is the
 * leaf-level taxonomy that mspTypes.ts composes into the diagnostic event shape.
 */

export const MSP_DIAGNOSTIC_CODES = [
  'MSP_BAD_CHECKSUM',
  'MSP_MALFORMED_HEADER',
  'MSP_FRAME_TOO_LARGE',
  'MSP_PARTIAL_FRAME_TIMEOUT',
  'MSP_RESYNC',
] as const;

export type MspDiagnosticCode = (typeof MSP_DIAGNOSTIC_CODES)[number];

export interface MspDiagnosticDetailMap {
  MSP_BAD_CHECKSUM: {
    // Mirrors MspWireFormat from mspTypes.ts. Duplicated (not imported) so this
    // taxonomy file stays a dependency-free leaf.
    wireFormat: 'v1' | 'v2' | 'v2-over-v1';
    // Which checksum failed. For 'v2-over-v1' this distinguishes the inner MSP v2
    // CRC8 (payload integrity) from the outer MSP v1 XOR (envelope integrity) —
    // the two checksums cover overlapping, not parallel, byte ranges; see
    // mspStreamParser.ts for the exact ranges.
    checksumKind: 'xor' | 'crc8-dvb-s2';
    expected: number;
    actual: number;
  };
  MSP_MALFORMED_HEADER: {
    reason: string;
  };
  MSP_FRAME_TOO_LARGE: {
    declaredSize: number;
    maxPayloadBytes: number;
  };
  MSP_PARTIAL_FRAME_TIMEOUT: {
    elapsedMs: number;
    partialFrameTimeoutMs: number;
  };
  MSP_RESYNC: {
    discardedByteCount: number;
  };
}

export type MspDiagnosticDetail<Code extends MspDiagnosticCode> = MspDiagnosticDetailMap[Code];
