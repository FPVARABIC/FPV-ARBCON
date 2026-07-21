/**
 * Stateful, incremental MSP byte-stream parser.
 *
 * Consumes bytes as they arrive (never re-parses a growing buffer from
 * scratch) and never performs I/O or starts a real timer. The partial-frame
 * timeout is lazy/reactive only: it is checked once, at the very start of
 * ingest(), against a clock function supplied by the caller (defaulting to
 * Date.now) — never via setTimeout/setInterval. See MSP_PARTIAL_FRAME_TIMEOUT
 * handling below.
 *
 * State machine and checksum ranges are mirrored from Betaflight's own
 * receive-side implementation, `mspSerialProcessReceivedPacketData()` in
 * src/main/msp/msp_serial.c:
 * https://github.com/betaflight/betaflight/blob/master/src/main/msp/msp_serial.c
 *
 * One documented exception: Betaflight firmware's own receive path never
 * handles the MSP v1 jumbo (0xFF size marker + extended 2-byte size)
 * extension, because firmware only ever *receives* small command payloads
 * (MSP_PORT_INBUF_SIZE = 192 bytes) — it only ever *sends* jumbo frames
 * (large telemetry/dataflash responses), which is why jumbo handling only
 * appears in Betaflight's mspSerialEncode(). Since this parser is the
 * *client* side, decoding jumbo responses from the FC is squarely in scope.
 * The jumbo decode logic below is therefore a direct mirror of
 * mspSerialEncode()'s jumbo byte layout (confirmed from that source), not a
 * transcription of an existing Betaflight decode function — flagged here per
 * the "verify, don't assume" instruction rather than silently presented as
 * a found reference.
 */

import { crc8DvbS2Step, xorChecksumStep } from './mspChecksum';
import type { MspDiagnosticCode, MspDiagnosticDetailMap } from './mspErrors';
import {
  MSP_MAX_PAYLOAD_BYTES_DEFAULT,
  MSP_PARTIAL_FRAME_TIMEOUT_MS_DEFAULT,
  MSP_V2_FRAME_ID,
  type MspDiagnostic,
  type MspDirection,
  type MspFrame,
} from './mspTypes';

const DOLLAR = 0x24; // '$'
const MAGIC_V1 = 0x4d; // 'M'
const MAGIC_V2_NATIVE = 0x58; // 'X'
const DIRECTION_REQUEST = 0x3c; // '<'
const DIRECTION_RESPONSE = 0x3e; // '>'
const DIRECTION_ERROR = 0x21; // '!'
const JUMBO_SIZE_MARKER = 0xff;
const V2_HEADER_SIZE = 5; // flags(1) + cmd LE16(2) + size LE16(2)
// Fixed per-frame overhead a v2-over-v1 wrapper adds on top of the inner
// payload: the 5-byte inner v2 header plus the 1-byte inner CRC8. Used both
// as the minimum valid outer size (inner payload = 0) and in the exact
// outerSize == overhead + innerPayloadSize cross-check below.
const MSP_V2_OVER_V1_OVERHEAD_BYTES = V2_HEADER_SIZE + 1;

export type MspIngestEvent = { type: 'FRAME'; frame: MspFrame } | { type: 'DIAGNOSTIC'; diagnostic: MspDiagnostic };

export interface MspIngestResult {
  /** The sole, authoritative chronological record of what happened while consuming
   * this chunk. `frames` and `diagnostics` below are derived views over this array. */
  events: MspIngestEvent[];
  frames: MspFrame[];
  diagnostics: MspDiagnostic[];
}

export interface MspStreamParserOptions {
  /** Declared/decoded payload size cap, checked before any payload buffer is
   * allocated. Defaults to MSP_MAX_PAYLOAD_BYTES_DEFAULT. */
  maxPayloadBytes?: number;
  /** See the file-level doc comment: lazy/reactive only, checked once at the
   * start of ingest(). Defaults to MSP_PARTIAL_FRAME_TIMEOUT_MS_DEFAULT. */
  partialFrameTimeoutMs?: number;
  /** Clock used for the lazy partial-frame timeout check. Defaults to Date.now.
   * Inject a fake clock in tests to simulate elapsed time deterministically,
   * with no real sleep or fake-timer infrastructure required. */
  now?: () => number;
}

export interface MspStreamParser {
  /**
   * Consumes one chunk of bytes, synchronously, to completion, and returns
   * every frame and diagnostic produced while doing so, in the exact order
   * they occurred. A single chunk can yield zero, one, or multiple frames
   * and/or diagnostics, interleaved in any order.
   *
   * Precondition: ingest() must not be called re-entrantly or concurrently
   * on the same parser instance — it is not reentrant-safe. Across separate,
   * sequential calls, every event from an earlier call precedes every event
   * from a later call (ingest() is synchronous and fully drains one chunk
   * before returning).
   *
   * An empty (zero-length) chunk is a no-op: it does not run the partial-frame
   * timeout check and returns empty arrays.
   */
  ingest(chunk: Uint8Array): MspIngestResult;
  /** Fully clears all in-progress frame state. Emits no events. */
  reset(): void;
}

type Phase =
  | 'SEARCH'
  | 'MAGIC'
  | 'DIRECTION'
  | 'V1_HEADER' // collecting 2 bytes: size, cmd
  | 'V1_JUMBO' // collecting 2 bytes: extended size, LE16 (only entered when size byte == 0xFF)
  | 'V1_PAYLOAD'
  | 'V1_CHECKSUM'
  // V2_HEADER / V2_PAYLOAD / V2_CRC are shared between MSP v2 native and the
  // inner MSP v2 frame of a v2-over-v1 envelope; `isV2OverV1` distinguishes them.
  | 'V2_HEADER' // collecting 5 bytes: flags, cmd LE16, size LE16
  | 'V2_PAYLOAD'
  | 'V2_CRC'
  | 'V2_OVER_V1_OUTER_CHECKSUM';

interface ParserState {
  phase: Phase;
  scratch: number[];
  magic: 'M' | 'X' | undefined;
  direction: MspDirection | undefined;
  isV2OverV1: boolean;
  pendingV1Cmd: number;
  /** Resolved outer v1 size (post-jumbo-resolution) for an in-progress
   * v2-over-v1 frame, read as a plain number only — never used to size an
   * allocation. Carried from finishV1Header to finishV2Header purely so the
   * exact outerV1Size === MSP_V2_OVER_V1_OVERHEAD_BYTES + innerSize
   * cross-check can run once the inner header's own size field is known. */
  outerV1Size: number;
  command: number;
  flags: number;
  payload: Uint8Array | undefined;
  payloadOffset: number;
  checksum1: number; // XOR accumulator: MSP v1 native, and the v2-over-v1 outer envelope
  checksum2: number; // CRC8-DVB-S2 accumulator: MSP v2 native, and the v2-over-v1 inner frame
  /** Clock timestamp (from `now()`) captured when '$' was seen for the
   * currently in-progress frame. Undefined while in SEARCH (nothing in progress). */
  startedAt: number | undefined;
  /** Noise bytes discarded since the last time we were in a non-SEARCH phase
   * (or since the parser was created/reset). Reported via MSP_RESYNC once a
   * new '$' is found; reset to 0 at that point. */
  discardedByteCount: number;
}

function createInitialState(): ParserState {
  return {
    phase: 'SEARCH',
    scratch: [],
    magic: undefined,
    direction: undefined,
    isV2OverV1: false,
    pendingV1Cmd: 0,
    outerV1Size: 0,
    command: 0,
    flags: 0,
    payload: undefined,
    payloadOffset: 0,
    checksum1: 0,
    checksum2: 0,
    startedAt: undefined,
    discardedByteCount: 0,
  };
}

function directionFromByte(byte: number): MspDirection | undefined {
  switch (byte) {
    case DIRECTION_REQUEST:
      return 'request';
    case DIRECTION_RESPONSE:
      return 'response';
    case DIRECTION_ERROR:
      return 'error';
    default:
      return undefined;
  }
}

function formatDiagnosticMessage<Code extends MspDiagnosticCode>(
  code: Code,
  detail: MspDiagnosticDetailMap[Code],
): string {
  switch (code) {
    case 'MSP_BAD_CHECKSUM': {
      const d = detail as MspDiagnosticDetailMap['MSP_BAD_CHECKSUM'];
      return (
        `MSP ${d.wireFormat} ${d.checksumKind} checksum mismatch: ` +
        `expected 0x${d.expected.toString(16).padStart(2, '0')}, got 0x${d.actual.toString(16).padStart(2, '0')}`
      );
    }
    case 'MSP_MALFORMED_HEADER': {
      const d = detail as MspDiagnosticDetailMap['MSP_MALFORMED_HEADER'];
      return `Malformed MSP header: ${d.reason}`;
    }
    case 'MSP_FRAME_TOO_LARGE': {
      const d = detail as MspDiagnosticDetailMap['MSP_FRAME_TOO_LARGE'];
      return `Declared MSP frame size ${d.declaredSize} exceeds maxPayloadBytes (${d.maxPayloadBytes})`;
    }
    case 'MSP_PARTIAL_FRAME_TIMEOUT': {
      const d = detail as MspDiagnosticDetailMap['MSP_PARTIAL_FRAME_TIMEOUT'];
      return `Partial MSP frame timed out after ${d.elapsedMs}ms (limit ${d.partialFrameTimeoutMs}ms)`;
    }
    case 'MSP_RESYNC': {
      const d = detail as MspDiagnosticDetailMap['MSP_RESYNC'];
      return `MSP parser resynchronized, discarding ${d.discardedByteCount} byte(s)`;
    }
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function buildDiagnostic<Code extends MspDiagnosticCode>(
  code: Code,
  detail: MspDiagnosticDetailMap[Code],
): Extract<MspDiagnostic, { code: Code }> {
  return {
    code,
    detail,
    message: formatDiagnosticMessage(code, detail),
  } as Extract<MspDiagnostic, { code: Code }>;
}

function pushDiagnostic<Code extends MspDiagnosticCode>(
  events: MspIngestEvent[],
  code: Code,
  detail: MspDiagnosticDetailMap[Code],
): void {
  events.push({ type: 'DIAGNOSTIC', diagnostic: buildDiagnostic(code, detail) });
}

export function createMspStreamParser(options: MspStreamParserOptions = {}): MspStreamParser {
  const maxPayloadBytes = options.maxPayloadBytes ?? MSP_MAX_PAYLOAD_BYTES_DEFAULT;
  const partialFrameTimeoutMs = options.partialFrameTimeoutMs ?? MSP_PARTIAL_FRAME_TIMEOUT_MS_DEFAULT;
  const clock = options.now ?? Date.now;

  let state = createInitialState();

  function resetToSearch(): void {
    state.phase = 'SEARCH';
    state.scratch = [];
    state.magic = undefined;
    state.direction = undefined;
    state.isV2OverV1 = false;
    state.outerV1Size = 0;
    state.payload = undefined;
    state.payloadOffset = 0;
    state.checksum1 = 0;
    state.checksum2 = 0;
    state.startedAt = undefined;
    // discardedByteCount is deliberately NOT cleared here — SEARCH-phase byte
    // discarding accumulates across an error->resync transition until the next '$'.
  }

  function beginNewFrame(startedAt: number): void {
    state.phase = 'MAGIC';
    state.scratch = [];
    state.startedAt = startedAt;
  }

  function finishV1Header(size: number, cmd: number, events: MspIngestEvent[]): void {
    if (cmd === MSP_V2_FRAME_ID) {
      // `size` here is a plain number (the outer v1 size, already resolved
      // through the jumbo extension if the 0xFF marker was used) — nothing is
      // allocated based on it, in this function or anywhere else.
      if (size < MSP_V2_OVER_V1_OVERHEAD_BYTES) {
        pushDiagnostic(events, 'MSP_MALFORMED_HEADER', {
          reason: `v2-over-v1 declared size ${size} is too small to hold a v2 header + CRC byte (minimum ${MSP_V2_OVER_V1_OVERHEAD_BYTES})`,
        });
        resetToSearch();
        return;
      }
      if (size > maxPayloadBytes + MSP_V2_OVER_V1_OVERHEAD_BYTES) {
        // Immediate reject — no waiting for the inner v2 header, no allocation.
        // Reported as the *implied inner payload size* (size minus the fixed
        // wrapper overhead) so it's directly comparable to maxPayloadBytes,
        // consistent with every other MSP_FRAME_TOO_LARGE diagnostic here.
        pushDiagnostic(events, 'MSP_FRAME_TOO_LARGE', {
          declaredSize: size - MSP_V2_OVER_V1_OVERHEAD_BYTES,
          maxPayloadBytes,
        });
        resetToSearch();
        return;
      }
      state.isV2OverV1 = true;
      state.outerV1Size = size;
      state.phase = 'V2_HEADER';
      state.scratch = [];
      return;
    }

    if (size > maxPayloadBytes) {
      pushDiagnostic(events, 'MSP_FRAME_TOO_LARGE', { declaredSize: size, maxPayloadBytes });
      resetToSearch();
      return;
    }

    state.command = cmd;
    state.flags = 0;
    state.payload = new Uint8Array(size);
    state.payloadOffset = 0;
    state.phase = size > 0 ? 'V1_PAYLOAD' : 'V1_CHECKSUM';
  }

  function finishV2Header(events: MspIngestEvent[]): void {
    const flagsByte = state.scratch[0];
    const cmd = state.scratch[1] | (state.scratch[2] << 8);
    const size = state.scratch[3] | (state.scratch[4] << 8);

    if (size > maxPayloadBytes) {
      pushDiagnostic(events, 'MSP_FRAME_TOO_LARGE', { declaredSize: size, maxPayloadBytes });
      resetToSearch();
      return;
    }

    if (state.isV2OverV1) {
      const expectedOuterSize = MSP_V2_OVER_V1_OVERHEAD_BYTES + size;
      if (state.outerV1Size !== expectedOuterSize) {
        pushDiagnostic(events, 'MSP_MALFORMED_HEADER', {
          reason:
            `v2-over-v1 outer size (${state.outerV1Size}) does not match the inner v2 header + payload + CRC ` +
            `(expected ${expectedOuterSize} = ${MSP_V2_OVER_V1_OVERHEAD_BYTES} overhead + inner size ${size})`,
        });
        resetToSearch();
        return;
      }
    }

    state.flags = flagsByte;
    state.command = cmd;
    state.payload = new Uint8Array(size);
    state.payloadOffset = 0;
    state.phase = size > 0 ? 'V2_PAYLOAD' : 'V2_CRC';
  }

  function completeFrame(events: MspIngestEvent[]): void {
    const wireFormat = state.magic === 'X' ? 'v2' : state.isV2OverV1 ? 'v2-over-v1' : 'v1';
    const protocolVersion = wireFormat === 'v1' ? 'v1' : 'v2';

    const frame: MspFrame = {
      protocolVersion,
      wireFormat,
      direction: state.direction!,
      command: state.command,
      flags: state.flags,
      payload: state.payload!,
    };
    events.push({ type: 'FRAME', frame });
    resetToSearch();
  }

  function processByte(byte: number, events: MspIngestEvent[], nowMs: number): void {
    let reprocess = true;
    while (reprocess) {
      reprocess = false;

      switch (state.phase) {
        case 'SEARCH': {
          if (byte === DOLLAR) {
            if (state.discardedByteCount > 0) {
              pushDiagnostic(events, 'MSP_RESYNC', { discardedByteCount: state.discardedByteCount });
              state.discardedByteCount = 0;
            }
            beginNewFrame(nowMs);
          } else {
            state.discardedByteCount += 1;
          }
          break;
        }

        case 'MAGIC': {
          if (byte === MAGIC_V1) {
            state.magic = 'M';
            state.phase = 'DIRECTION';
          } else if (byte === MAGIC_V2_NATIVE) {
            state.magic = 'X';
            state.phase = 'DIRECTION';
          } else {
            pushDiagnostic(events, 'MSP_MALFORMED_HEADER', {
              reason: `expected MSP magic byte 'M' or 'X', got 0x${byte.toString(16).padStart(2, '0')}`,
            });
            resetToSearch();
            reprocess = true;
          }
          break;
        }

        case 'DIRECTION': {
          const direction = directionFromByte(byte);
          if (direction === undefined) {
            pushDiagnostic(events, 'MSP_MALFORMED_HEADER', {
              reason: `expected MSP direction byte '<', '>' or '!', got 0x${byte.toString(16).padStart(2, '0')}`,
            });
            resetToSearch();
            reprocess = true;
            break;
          }
          state.direction = direction;
          state.isV2OverV1 = false;
          state.scratch = [];
          state.phase = state.magic === 'X' ? 'V2_HEADER' : 'V1_HEADER';
          break;
        }

        case 'V1_HEADER': {
          state.scratch.push(byte);
          state.checksum1 = xorChecksumStep(state.checksum1, byte);
          if (state.scratch.length === 2) {
            const [sizeByte, cmdByte] = state.scratch;
            if (sizeByte === JUMBO_SIZE_MARKER) {
              state.pendingV1Cmd = cmdByte;
              state.scratch = [];
              state.phase = 'V1_JUMBO';
            } else {
              finishV1Header(sizeByte, cmdByte, events);
            }
          }
          break;
        }

        case 'V1_JUMBO': {
          state.scratch.push(byte);
          state.checksum1 = xorChecksumStep(state.checksum1, byte);
          if (state.scratch.length === 2) {
            const size = state.scratch[0] | (state.scratch[1] << 8);
            finishV1Header(size, state.pendingV1Cmd, events);
          }
          break;
        }

        case 'V1_PAYLOAD': {
          state.checksum1 = xorChecksumStep(state.checksum1, byte);
          state.payload![state.payloadOffset++] = byte;
          if (state.payloadOffset === state.payload!.length) {
            state.phase = 'V1_CHECKSUM';
          }
          break;
        }

        case 'V1_CHECKSUM': {
          if (state.checksum1 === byte) {
            completeFrame(events);
          } else {
            pushDiagnostic(events, 'MSP_BAD_CHECKSUM', {
              wireFormat: 'v1',
              checksumKind: 'xor',
              expected: state.checksum1,
              actual: byte,
            });
            resetToSearch();
            reprocess = true;
          }
          break;
        }

        case 'V2_HEADER': {
          state.scratch.push(byte);
          state.checksum2 = crc8DvbS2Step(state.checksum2, byte);
          if (state.isV2OverV1) {
            state.checksum1 = xorChecksumStep(state.checksum1, byte);
          }
          if (state.scratch.length === V2_HEADER_SIZE) {
            finishV2Header(events);
          }
          break;
        }

        case 'V2_PAYLOAD': {
          state.checksum2 = crc8DvbS2Step(state.checksum2, byte);
          if (state.isV2OverV1) {
            state.checksum1 = xorChecksumStep(state.checksum1, byte);
          }
          state.payload![state.payloadOffset++] = byte;
          if (state.payloadOffset === state.payload!.length) {
            state.phase = 'V2_CRC';
          }
          break;
        }

        case 'V2_CRC': {
          // The inner CRC8 byte is folded into the outer XOR (checksum1)
          // unconditionally, before the inner comparison decides whether to
          // continue — this is what makes the outer XOR's range include the
          // inner CRC8 byte itself. See the file-level doc comment and
          // mspErrors.ts's MSP_BAD_CHECKSUM.checksumKind for how the two
          // checksums' overlapping (not parallel) ranges are represented.
          if (state.isV2OverV1) {
            state.checksum1 = xorChecksumStep(state.checksum1, byte);
          }
          if (state.checksum2 === byte) {
            if (state.isV2OverV1) {
              state.phase = 'V2_OVER_V1_OUTER_CHECKSUM';
            } else {
              completeFrame(events);
            }
          } else {
            pushDiagnostic(events, 'MSP_BAD_CHECKSUM', {
              wireFormat: state.isV2OverV1 ? 'v2-over-v1' : 'v2',
              checksumKind: 'crc8-dvb-s2',
              expected: state.checksum2,
              actual: byte,
            });
            resetToSearch();
            reprocess = true;
          }
          break;
        }

        case 'V2_OVER_V1_OUTER_CHECKSUM': {
          if (state.checksum1 === byte) {
            completeFrame(events);
          } else {
            pushDiagnostic(events, 'MSP_BAD_CHECKSUM', {
              wireFormat: 'v2-over-v1',
              checksumKind: 'xor',
              expected: state.checksum1,
              actual: byte,
            });
            resetToSearch();
            reprocess = true;
          }
          break;
        }

        default: {
          const exhaustive: never = state.phase;
          throw new Error(`Unreachable MSP parser phase: ${String(exhaustive)}`);
        }
      }
    }
  }

  function maybeEmitPartialFrameTimeout(events: MspIngestEvent[], nowMs: number): void {
    if (state.phase === 'SEARCH' || state.startedAt === undefined) {
      return;
    }
    const elapsedMs = nowMs - state.startedAt;
    if (elapsedMs >= partialFrameTimeoutMs) {
      pushDiagnostic(events, 'MSP_PARTIAL_FRAME_TIMEOUT', { elapsedMs, partialFrameTimeoutMs });
      resetToSearch();
    }
  }

  function ingest(chunk: Uint8Array): MspIngestResult {
    const events: MspIngestEvent[] = [];

    if (chunk.length === 0) {
      return { events, frames: [], diagnostics: [] };
    }

    const nowMs = clock();
    maybeEmitPartialFrameTimeout(events, nowMs);

    for (let i = 0; i < chunk.length; i++) {
      processByte(chunk[i], events, nowMs);
    }

    const frames: MspFrame[] = [];
    const diagnostics: MspDiagnostic[] = [];
    for (const event of events) {
      if (event.type === 'FRAME') {
        frames.push(event.frame);
      } else {
        diagnostics.push(event.diagnostic);
      }
    }

    return { events, frames, diagnostics };
  }

  function reset(): void {
    state = createInitialState();
  }

  return { ingest, reset };
}
