/**
 * Shared types and constants for the MSP encode/decode foundation (Pass 6.1).
 *
 * Pure types + constants only — no behavior lives in this file.
 */

import type { MspDiagnosticCode, MspDiagnosticDetailMap } from './mspErrors';

/** Physical byte encoding actually observed on (or written to) the wire. */
export type MspWireFormat = 'v1' | 'v2' | 'v2-over-v1';

/**
 * Semantic command space of a frame's payload: 8-bit command / no flags byte / XOR
 * checksum (v1) vs 16-bit function code / flags byte / CRC8-DVB-S2 checksum (v2).
 *
 * This is deliberately distinct from MspWireFormat: a 'v2-over-v1' frame has
 * wireFormat 'v2-over-v1' (that's how it was physically framed) but
 * protocolVersion 'v2' (the command code, flags, and payload semantics are
 * always the real, unwrapped MSP v2 ones — never the outer command-255 marker).
 */
export type MspProtocolVersion = 'v1' | 'v2';

export type MspDirection = 'request' | 'response' | 'error';

/**
 * Unified frame shape produced by the parser / consumed by the encoder,
 * regardless of which wire format carried it.
 */
export interface MspFrame {
  protocolVersion: MspProtocolVersion;
  wireFormat: MspWireFormat;
  direction: MspDirection;
  /** Real function/command code. For 'v2-over-v1' this is the INNER code — never 255. */
  command: number;
  /** MSP v2 flags byte. Always 0 for wireFormat 'v1' (v1 has no flags byte). */
  flags: number;
  payload: Uint8Array;
}

/**
 * Diagnostic event shape: a discriminated union keyed by `code`, so a
 * `switch (diagnostic.code)` (or an `if` narrowing on it) narrows `detail` to
 * the code-specific payload defined in mspErrors.ts, with no cast required.
 */
export type MspDiagnostic = {
  [Code in MspDiagnosticCode]: {
    code: Code;
    message: string;
    detail: MspDiagnosticDetailMap[Code];
  };
}[MspDiagnosticCode];

/** Command code that marks an MSP v1 frame as wrapping an MSP v2 frame (v2-over-v1). */
export const MSP_V2_FRAME_ID = 255;

/**
 * Default cap on a declared/decoded payload size, applied before any payload
 * buffer is allocated.
 *
 * Justification (see Pass 6.1 report for full source citations): the MSP wire
 * ceiling is 65535 bytes (u16 LE size field, both MSP v2 native/inner and MSP
 * v1 jumbo extended size). The largest payload real Betaflight firmware itself
 * is known to emit is a dataflash-log chunk, MSP_PORT_DATAFLASH_BUFFER_SIZE
 * (4096) + MSP_PORT_DATAFLASH_INFO_SIZE (16) = 4112 bytes
 * (src/main/msp/msp_serial.h). 8192 comfortably covers that plus headroom for
 * large settings/config dumps, while staying far below the 65535 wire ceiling
 * so a corrupted size field can't force a large allocation. Callers may
 * override per instance.
 */
export const MSP_MAX_PAYLOAD_BYTES_DEFAULT = 8192;

/** Absolute wire-format ceiling: both the MSP v2 size field and the MSP v1 jumbo
 * extended size field are u16 LE, so no declared size can exceed this regardless
 * of maxPayloadBytes configuration. Informational — not separately enforced. */
export const MSP_PROTOCOL_SIZE_FIELD_CEILING = 0xffff;

/**
 * Default lazy partial-frame timeout, in milliseconds. This is an application
 * policy choice, not a wire-protocol fact — there is no Betaflight source
 * citation for it. Callers may override per instance.
 */
export const MSP_PARTIAL_FRAME_TIMEOUT_MS_DEFAULT = 1000;
