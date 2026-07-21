import { encode } from '../mspEncoder';
import { createMspStreamParser, type MspIngestEvent } from '../mspStreamParser';
import { MSP_V2_FRAME_ID } from '../mspTypes';
import {
  buildMspFrameBytes,
  buildV1JumboSizeOnlyBytes,
  buildV2HeaderOnlyBytes,
  buildV2OverV1HeaderOnlyBytes,
} from '../__testUtils__/mspFixtures';

function concatAll(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Small deterministic LCG so "random" chunk splits are reproducible in CI. */
function deterministicChunks(bytes: Uint8Array, seed: number, maxChunkSize = 5): Uint8Array[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = 1 + (next() % maxChunkSize);
    const end = Math.min(bytes.length, i + size);
    chunks.push(bytes.slice(i, end));
    i = end;
  }
  return chunks;
}

describe('createMspStreamParser — basic round trips', () => {
  it('parses a zero-length chunk as a no-op', () => {
    const parser = createMspStreamParser();
    const result = parser.ingest(new Uint8Array(0));
    expect(result).toEqual({ events: [], frames: [], diagnostics: [] });
  });

  it('parses multiple complete frames delivered in a single chunk, in order', () => {
    const a = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const b = encode(2, Uint8Array.from([2, 2]), { wireFormat: 'v2' });
    const c = encode(3, Uint8Array.from([3, 3, 3]), { wireFormat: 'v2-over-v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([a, b, c]));

    expect(result.diagnostics).toEqual([]);
    expect(result.frames.map((f) => f.command)).toEqual([1, 2, 3]);
    expect(result.frames.map((f) => f.wireFormat)).toEqual(['v1', 'v2', 'v2-over-v1']);
  });

  it('does not misinterpret a literal "$" byte inside a payload as a new frame start', () => {
    const payload = Uint8Array.from([0x01, 0x24, 0x02, 0x24, 0x24, 0x03]); // 0x24 == '$'
    const bytes = encode(9, payload, { wireFormat: 'v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);

    expect(result.diagnostics).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].payload).toEqual(payload);
  });

  it('decodes a "!" (error) direction frame correctly, distinct from a checksum failure', () => {
    const bytes = buildMspFrameBytes(5, Uint8Array.from([1, 2]), { wireFormat: 'v2', direction: 'error' });
    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);

    expect(result.diagnostics).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].direction).toBe('error');
  });
});

describe('createMspStreamParser — noise and resync', () => {
  it('skips noise bytes before a frame and between two valid frames, reporting MSP_RESYNC', () => {
    const noise1 = Uint8Array.from([0x00, 0x01, 0x02]);
    const frame1 = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const noise2 = Uint8Array.from([0xff, 0xee]);
    const frame2 = encode(2, Uint8Array.from([2]), { wireFormat: 'v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([noise1, frame1, noise2, frame2]));

    expect(result.frames.map((f) => f.command)).toEqual([1, 2]);
    const resyncs = result.diagnostics.filter((d) => d.code === 'MSP_RESYNC');
    expect(resyncs).toHaveLength(2);
    expect(resyncs[0].detail.discardedByteCount).toBe(noise1.length);
    expect(resyncs[1].detail.discardedByteCount).toBe(noise2.length);
  });

  it('never hangs, throws, or stops on noise at any position, and keeps parsing subsequent valid frames', () => {
    const stray = Uint8Array.from([0x24, 0x00, 0x24, 0x4d, 0x99]); // stray '$' bytes, bogus magic
    const frame = encode(42, Uint8Array.from([7, 7, 7]), { wireFormat: 'v2' });

    const parser = createMspStreamParser();
    expect(() => parser.ingest(concatAll([stray, frame]))).not.toThrow();

    const result = parser.ingest(new Uint8Array(0));
    expect(result).toEqual({ events: [], frames: [], diagnostics: [] });

    // Re-run fresh to check the stray+frame chunk actually recovered and found the frame.
    const parser2 = createMspStreamParser();
    const result2 = parser2.ingest(concatAll([stray, frame]));
    expect(result2.frames.map((f) => f.command)).toEqual([42]);
  });
});

describe('createMspStreamParser — jumbo frames', () => {
  it('decodes a v1 native jumbo frame (payload >= 255 bytes)', () => {
    const payload = new Uint8Array(500).map((_, i) => i & 0xff);
    const bytes = encode(11, payload, { wireFormat: 'v1' });
    const parser = createMspStreamParser({ maxPayloadBytes: 1000 });
    const result = parser.ingest(bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.frames[0].payload).toEqual(payload);
  });

  it('decodes a v2-over-v1 frame whose outer envelope needs the jumbo extension', () => {
    const payload = new Uint8Array(500).map((_, i) => (i * 3) & 0xff);
    const bytes = encode(0x4001, payload, { wireFormat: 'v2-over-v1' });
    const parser = createMspStreamParser({ maxPayloadBytes: 1000 });
    const result = parser.ingest(bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.frames[0].wireFormat).toBe('v2-over-v1');
    expect(result.frames[0].payload).toEqual(payload);
  });
});

describe('createMspStreamParser — corrupted checksums, per wire format', () => {
  it('detects a corrupted MSP v1 XOR checksum', () => {
    const bytes = buildMspFrameBytes(1, Uint8Array.from([1, 2, 3]), {
      wireFormat: 'v1',
      direction: 'response',
      corruptChecksum: true,
    });
    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);
    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_BAD_CHECKSUM');
    if (result.diagnostics[0].code === 'MSP_BAD_CHECKSUM') {
      expect(result.diagnostics[0].detail.wireFormat).toBe('v1');
      expect(result.diagnostics[0].detail.checksumKind).toBe('xor');
    }
  });

  it('detects a corrupted MSP v2 native CRC8 checksum', () => {
    const bytes = buildMspFrameBytes(1, Uint8Array.from([1, 2, 3]), {
      wireFormat: 'v2',
      direction: 'response',
      corruptChecksum: true,
    });
    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);
    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_BAD_CHECKSUM');
    if (result.diagnostics[0].code === 'MSP_BAD_CHECKSUM') {
      expect(result.diagnostics[0].detail.wireFormat).toBe('v2');
      expect(result.diagnostics[0].detail.checksumKind).toBe('crc8-dvb-s2');
    }
  });

  describe('v2-over-v1 — overlapping (not parallel) checksum ranges', () => {
    // Byte layout, confirmed against Betaflight source (see mspStreamParser.ts
    // doc comment): ... v2-header(5) v2-payload(N) innerCRC8(1) outerXOR(1).
    // The inner CRC8 covers ONLY the v2 header + v2 payload. The outer XOR
    // covers the v1 header/jumbo + v2 header + v2 payload + the INNER CRC8
    // BYTE ITSELF — i.e. the outer checksum's range includes the inner CRC8
    // byte. These two tests corrupt exactly one of those two specific bytes
    // (the inner CRC8 byte, and the byte immediately after it) to prove that,
    // not just "some byte is wrong somewhere".
    it('corrupting ONLY the byte immediately after the inner CRC8 byte (the outer checksum) is caught as an outer/v1 XOR mismatch', () => {
      const payload = Uint8Array.from([10, 20, 30]);
      const bytes = buildMspFrameBytes(0x5000, payload, { wireFormat: 'v2-over-v1', direction: 'response' });
      const corrupted = Uint8Array.from(bytes);
      corrupted[corrupted.length - 1] ^= 0xff; // the very last byte == outer XOR checksum

      const parser = createMspStreamParser();
      const result = parser.ingest(corrupted);

      expect(result.frames).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe('MSP_BAD_CHECKSUM');
      if (result.diagnostics[0].code === 'MSP_BAD_CHECKSUM') {
        expect(result.diagnostics[0].detail.wireFormat).toBe('v2-over-v1');
        expect(result.diagnostics[0].detail.checksumKind).toBe('xor');
      }
    });

    it('corrupting ONLY the inner CRC8 byte is caught as an inner/v2 CRC8 mismatch, never reaching the outer check', () => {
      const payload = Uint8Array.from([10, 20, 30]);
      const bytes = buildMspFrameBytes(0x5000, payload, { wireFormat: 'v2-over-v1', direction: 'response' });
      const corrupted = Uint8Array.from(bytes);
      corrupted[corrupted.length - 2] ^= 0xff; // second-to-last byte == inner CRC8

      const parser = createMspStreamParser();
      const result = parser.ingest(corrupted);

      expect(result.frames).toEqual([]);
      expect(result.diagnostics).toHaveLength(1); // only the inner failure — never an outer diagnostic too
      expect(result.diagnostics[0].code).toBe('MSP_BAD_CHECKSUM');
      if (result.diagnostics[0].code === 'MSP_BAD_CHECKSUM') {
        expect(result.diagnostics[0].detail.wireFormat).toBe('v2-over-v1');
        expect(result.diagnostics[0].detail.checksumKind).toBe('crc8-dvb-s2');
      }
    });

    it('correctly parses when neither checksum is corrupted (baseline for the two tests above)', () => {
      const payload = Uint8Array.from([10, 20, 30]);
      const bytes = buildMspFrameBytes(0x5000, payload, { wireFormat: 'v2-over-v1', direction: 'response' });
      const parser = createMspStreamParser();
      const result = parser.ingest(bytes);
      expect(result.diagnostics).toEqual([]);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0].command).toBe(0x5000);
    });
  });
});

describe('createMspStreamParser — declared size vs maxPayloadBytes, checked before allocation', () => {
  it('rejects an MSP v2 native declared size near the 65535 wire ceiling immediately, before any payload bytes are supplied', () => {
    // Only the 8-byte header ($X< + 5-byte v2 header) is sent — no payload
    // bytes exist at all. If the implementation allocated a buffer sized by
    // the declared size and waited to fill it, this ingest() call could never
    // produce a result for that frame (the bytes it's "waiting for" don't
    // exist). Getting an immediate MSP_FRAME_TOO_LARGE back proves the size
    // check happened at header-parse time, strictly before any allocation.
    const headerOnly = buildV2HeaderOnlyBytes(1, 0, 65000);
    const parser = createMspStreamParser({ maxPayloadBytes: 100 });
    const result = parser.ingest(headerOnly);

    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_FRAME_TOO_LARGE');
    if (result.diagnostics[0].code === 'MSP_FRAME_TOO_LARGE') {
      expect(result.diagnostics[0].detail.declaredSize).toBe(65000);
      expect(result.diagnostics[0].detail.maxPayloadBytes).toBe(100);
    }
  });

  it('rejects an MSP v1 jumbo extended size near the 65535 wire ceiling immediately, before any payload bytes are supplied', () => {
    // Only $M< + 0xFF marker + cmd + the 2-byte extended size are sent.
    const headerOnly = buildV1JumboSizeOnlyBytes(77, 65000);
    const parser = createMspStreamParser({ maxPayloadBytes: 100 });
    const result = parser.ingest(headerOnly);

    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_FRAME_TOO_LARGE');
    if (result.diagnostics[0].code === 'MSP_FRAME_TOO_LARGE') {
      expect(result.diagnostics[0].detail.declaredSize).toBe(65000);
      expect(result.diagnostics[0].detail.maxPayloadBytes).toBe(100);
    }
  });

  it('recovers cleanly and parses a subsequent valid frame after a too-large rejection', () => {
    const headerOnly = buildV1JumboSizeOnlyBytes(77, 65000);
    const validFrame = encode(1, Uint8Array.from([9]), { wireFormat: 'v1' });

    const parser = createMspStreamParser({ maxPayloadBytes: 100 });
    const result = parser.ingest(concatAll([headerOnly, validFrame]));

    expect(result.diagnostics.map((d) => d.code)).toEqual(['MSP_FRAME_TOO_LARGE']);
    expect(result.frames.map((f) => f.command)).toEqual([1]);
  });
});

describe('createMspStreamParser — byte-boundary and chunking invariance', () => {
  it('parses correctly no matter where a single frame is split across two chunks (every possible boundary)', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const bytes = encode(0x60, payload, { wireFormat: 'v2-over-v1', flags: 0x02 });

    for (let split = 1; split < bytes.length; split++) {
      const parser = createMspStreamParser();
      const first = parser.ingest(bytes.slice(0, split));
      const second = parser.ingest(bytes.slice(split));

      const allDiagnostics = [...first.diagnostics, ...second.diagnostics];
      const allFrames = [...first.frames, ...second.frames];

      expect(allDiagnostics).toEqual([]);
      expect(allFrames).toHaveLength(1);
      expect(allFrames[0].command).toBe(0x60);
      expect(allFrames[0].payload).toEqual(payload);
    }
  });

  it('produces an identical result regardless of how a multi-frame byte stream is chunked (deterministic fuzz)', () => {
    const frames = [
      encode(1, Uint8Array.from([1]), { wireFormat: 'v1' }),
      encode(2, Uint8Array.from([2, 2]), { wireFormat: 'v2' }),
      encode(3, Uint8Array.from([3, 3, 3]), { wireFormat: 'v2-over-v1' }),
      encode(4, new Uint8Array(0), { wireFormat: 'v1' }),
    ];
    const stream = concatAll(frames);

    const wholeChunkParser = createMspStreamParser();
    const reference = wholeChunkParser.ingest(stream);

    for (const seed of [1, 7, 42, 99, 12345]) {
      const parser = createMspStreamParser();
      const chunks = deterministicChunks(stream, seed);
      const combined = { frames: [] as unknown[], diagnostics: [] as unknown[] };
      for (const chunk of chunks) {
        const result = parser.ingest(chunk);
        combined.frames.push(...result.frames);
        combined.diagnostics.push(...result.diagnostics);
      }
      expect(combined.frames).toEqual(reference.frames);
      expect(combined.diagnostics).toEqual(reference.diagnostics);
    }
  });
});

describe('createMspStreamParser — reset()', () => {
  it('fully clears in-progress state so a subsequent frame parses correctly with no leftover state', () => {
    const validFrame = encode(1, Uint8Array.from([9, 9]), { wireFormat: 'v2' });

    const parser = createMspStreamParser();
    // Feed only part of a frame (header + partial payload), never completing it.
    const partial = validFrame.slice(0, validFrame.length - 3);
    const partialResult = parser.ingest(partial);
    expect(partialResult.frames).toEqual([]);
    expect(partialResult.diagnostics).toEqual([]);

    parser.reset();

    const afterReset = parser.ingest(validFrame);
    expect(afterReset.diagnostics).toEqual([]);
    expect(afterReset.frames).toHaveLength(1);
    expect(afterReset.frames[0].command).toBe(1);
  });
});

describe('createMspStreamParser — partial-frame timeout (lazy, clock-injected, no real timers)', () => {
  it('emits MSP_PARTIAL_FRAME_TIMEOUT only once ingest() is next called with new bytes past the deadline', () => {
    let currentTime = 1_000_000;
    const parser = createMspStreamParser({ partialFrameTimeoutMs: 500, now: () => currentTime });

    const validFrame = encode(1, Uint8Array.from([9, 9]), { wireFormat: 'v1' });
    const partial = validFrame.slice(0, validFrame.length - 1); // withhold the checksum byte
    const firstResult = parser.ingest(partial);
    expect(firstResult.diagnostics).toEqual([]);

    currentTime += 499; // just under the deadline
    const stillOk = parser.ingest(new Uint8Array(0)); // empty chunk: must NOT trigger the check at all
    expect(stillOk).toEqual({ events: [], frames: [], diagnostics: [] });

    currentTime += 1; // now exactly at the 500ms deadline, and this call carries a new byte
    const timeoutResult = parser.ingest(Uint8Array.from([0x00])); // arbitrary noise byte
    expect(timeoutResult.diagnostics).toHaveLength(1);
    expect(timeoutResult.diagnostics[0].code).toBe('MSP_PARTIAL_FRAME_TIMEOUT');
    if (timeoutResult.diagnostics[0].code === 'MSP_PARTIAL_FRAME_TIMEOUT') {
      expect(timeoutResult.diagnostics[0].detail.elapsedMs).toBe(500);
      expect(timeoutResult.diagnostics[0].detail.partialFrameTimeoutMs).toBe(500);
    }
  });

  it('recovers cleanly and parses a subsequent valid frame after a timeout', () => {
    let currentTime = 0;
    const parser = createMspStreamParser({ partialFrameTimeoutMs: 100, now: () => currentTime });

    const validFrame = encode(1, Uint8Array.from([9]), { wireFormat: 'v1' });
    parser.ingest(validFrame.slice(0, 2)); // just "$M"

    currentTime = 200; // well past the deadline
    const nextFrame = encode(2, Uint8Array.from([5, 5]), { wireFormat: 'v1' });
    const result = parser.ingest(nextFrame);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['MSP_PARTIAL_FRAME_TIMEOUT']);
    expect(result.frames.map((f) => f.command)).toEqual([2]);
  });
});

describe('createMspStreamParser — event ordering (events is the sole authoritative record)', () => {
  it('records a noise-triggered diagnostic strictly before a valid frame in the same chunk', () => {
    const noise = Uint8Array.from([0x11, 0x22]);
    const frame = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([noise, frame]));

    expect(result.events.map((e) => e.type)).toEqual(['DIAGNOSTIC', 'FRAME']);
    expect((result.events[0] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>).diagnostic.code).toBe(
      'MSP_RESYNC',
    );
    expect((result.events[1] as Extract<MspIngestEvent, { type: 'FRAME' }>).frame.command).toBe(1);
  });

  it('records frame, then checksum diagnostic, then (a resync over the one reprocessed byte, then) another frame, in that exact order', () => {
    const good1 = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const bad = buildMspFrameBytes(2, Uint8Array.from([2]), {
      wireFormat: 'v1',
      direction: 'request',
      corruptChecksum: true,
    });
    const good2 = encode(3, Uint8Array.from([3]), { wireFormat: 'v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([good1, bad, good2]));

    // `bad`'s own (corrupted) checksum byte is re-examined for '$' immediately
    // on resync (per the parser's documented recovery rule); since it isn't
    // '$', it counts as one discarded/noise byte, reported via MSP_RESYNC once
    // good2's '$' is found — hence 4 events, not 3.
    expect(result.events.map((e) => e.type)).toEqual(['FRAME', 'DIAGNOSTIC', 'DIAGNOSTIC', 'FRAME']);
    expect((result.events[0] as Extract<MspIngestEvent, { type: 'FRAME' }>).frame.command).toBe(1);
    expect((result.events[1] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>).diagnostic.code).toBe(
      'MSP_BAD_CHECKSUM',
    );
    const resync = result.events[2] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>;
    expect(resync.diagnostic.code).toBe('MSP_RESYNC');
    if (resync.diagnostic.code === 'MSP_RESYNC') {
      expect(resync.diagnostic.detail.discardedByteCount).toBe(1);
    }
    expect((result.events[3] as Extract<MspIngestEvent, { type: 'FRAME' }>).frame.command).toBe(3);
  });

  it('records multiple interleaved diagnostics and frames within one chunk, in true chronological order', () => {
    const noise1 = Uint8Array.from([0x00]);
    const good1 = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const bad1 = buildMspFrameBytes(2, Uint8Array.from([2]), {
      wireFormat: 'v2',
      direction: 'request',
      corruptChecksum: true,
    });
    const noise2 = Uint8Array.from([0x01, 0x02]);
    const good2 = encode(3, Uint8Array.from([3]), { wireFormat: 'v1' });
    const good3 = encode(4, Uint8Array.from([4]), { wireFormat: 'v2' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([noise1, good1, bad1, noise2, good2, good3]));

    expect(result.events.map((e) => e.type)).toEqual([
      'DIAGNOSTIC', // resync over noise1
      'FRAME', // good1
      'DIAGNOSTIC', // bad1 checksum
      'DIAGNOSTIC', // resync over noise2
      'FRAME', // good2
      'FRAME', // good3
    ]);
  });

  it('preserves ordering across ingest() calls: all of an earlier call\'s events precede all of a later call\'s', () => {
    const frameBytes = encode(9, Uint8Array.from([1, 2, 3]), { wireFormat: 'v1' });
    const chunk1 = frameBytes.slice(0, 3); // "$M<" only — a partial, never-completed frame

    let currentTime = 0;
    const parser = createMspStreamParser({ partialFrameTimeoutMs: 10, now: () => currentTime });
    const result1 = parser.ingest(chunk1);
    expect(result1.events).toEqual([]);

    currentTime = 100; // expire the partial frame from chunk 1
    const noiseThenFrame = concatAll([Uint8Array.from([0xff, 0xfe]), frameBytes]);
    const result2 = parser.ingest(noiseThenFrame);

    expect(result2.events.map((e) => e.type)).toEqual(['DIAGNOSTIC', 'DIAGNOSTIC', 'FRAME']);
    expect((result2.events[0] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>).diagnostic.code).toBe(
      'MSP_PARTIAL_FRAME_TIMEOUT',
    );
    expect((result2.events[1] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>).diagnostic.code).toBe(
      'MSP_RESYNC',
    );
    expect((result2.events[2] as Extract<MspIngestEvent, { type: 'FRAME' }>).frame.command).toBe(9);

    // result1's events (none, here) trivially precede all of result2's — the
    // meaningful assertion is that chunk 1 contributed zero events of its own
    // and chunk 2's events are self-consistently ordered, proving no event
    // from "in-progress-at-the-time-of-call-1" leaked out of order.
  });

  it('a stale partial frame timing out AND a brand-new complete frame both resolving in the SAME ingest() call: timeout diagnostic strictly precedes the new frame\'s FRAME event', () => {
    let currentTime = 0;
    const parser = createMspStreamParser({ partialFrameTimeoutMs: 10, now: () => currentTime });

    const staleFrame = encode(1, Uint8Array.from([1, 2, 3]), { wireFormat: 'v1' });
    parser.ingest(staleFrame.slice(0, 3)); // "$M<" only — a genuinely in-progress, never-completed frame

    currentTime = 1000; // long past the deadline
    const newFrame = encode(2, Uint8Array.from([9]), { wireFormat: 'v1' });
    // The bytes that finally arrive both (a) trigger the lazy timeout check for
    // the stale partial frame, at the very start of this ingest() call, and
    // (b) themselves contain one brand-new, complete, valid frame.
    const result = parser.ingest(newFrame);

    expect(result.events.map((e) => e.type)).toEqual(['DIAGNOSTIC', 'FRAME']);
    expect((result.events[0] as Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }>).diagnostic.code).toBe(
      'MSP_PARTIAL_FRAME_TIMEOUT',
    );
    expect((result.events[1] as Extract<MspIngestEvent, { type: 'FRAME' }>).frame.command).toBe(2);
  });

  it('`frames` exactly matches all FRAME events, in the same order', () => {
    const good1 = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const bad = buildMspFrameBytes(2, Uint8Array.from([2]), {
      wireFormat: 'v1',
      direction: 'request',
      corruptChecksum: true,
    });
    const good2 = encode(3, Uint8Array.from([3]), { wireFormat: 'v1' });

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([good1, bad, good2]));

    const framesFromEvents = result.events
      .filter((e): e is Extract<MspIngestEvent, { type: 'FRAME' }> => e.type === 'FRAME')
      .map((e) => e.frame);
    expect(result.frames).toEqual(framesFromEvents);
  });

  it('`diagnostics` exactly matches all DIAGNOSTIC events, in the same order', () => {
    const noise1 = Uint8Array.from([0x00]);
    const good1 = encode(1, Uint8Array.from([1]), { wireFormat: 'v1' });
    const bad1 = buildMspFrameBytes(2, Uint8Array.from([2]), {
      wireFormat: 'v1',
      direction: 'request',
      corruptChecksum: true,
    });
    const noise2 = Uint8Array.from([0x01, 0x02]);

    const parser = createMspStreamParser();
    const result = parser.ingest(concatAll([noise1, good1, bad1, noise2]));

    const diagnosticsFromEvents = result.events
      .filter((e): e is Extract<MspIngestEvent, { type: 'DIAGNOSTIC' }> => e.type === 'DIAGNOSTIC')
      .map((e) => e.diagnostic);
    expect(result.diagnostics).toEqual(diagnosticsFromEvents);
  });
});

describe('createMspStreamParser — v2-over-v1 outer-size allocation fix', () => {
  it('rejects outerSize = 65535 (via the real v1 jumbo marker + 2-byte extension + outer cmd 255) immediately, no allocation', () => {
    // Genuinely exercises the jumbo-extension-reading path AND the
    // v2-over-v1 (outer cmd = 255) path together — outerSize can only reach
    // a value like 65535 through the jumbo mechanism, since the ordinary v1
    // size byte maxes out at 254 (0xFF is reserved as the jumbo marker).
    const headerOnly = buildV1JumboSizeOnlyBytes(MSP_V2_FRAME_ID, 65535);
    const parser = createMspStreamParser({ maxPayloadBytes: 100 });
    const result = parser.ingest(headerOnly);

    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_FRAME_TOO_LARGE');
    if (result.diagnostics[0].code === 'MSP_FRAME_TOO_LARGE') {
      // Reported as the implied inner payload size (65535 - 6 overhead).
      expect(result.diagnostics[0].detail.declaredSize).toBe(65535 - 6);
      expect(result.diagnostics[0].detail.maxPayloadBytes).toBe(100);
    }
  });

  it('resumes correctly when the 5-byte inner v2 header is split across a chunk boundary, allocating nothing while waiting', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const bytes = encode(0x7000, payload, { wireFormat: 'v2-over-v1', flags: 0x03 });
    // Outer envelope for this small (non-jumbo) frame is exactly 5 bytes:
    // '$','M','<',size,cmd(255) — so the inner v2 header starts at index 5.
    const splitPoint = 5 + 2; // 2 of the 5 inner header bytes in chunk 1

    const parser = createMspStreamParser();
    const firstResult = parser.ingest(bytes.slice(0, splitPoint));
    expect(firstResult.frames).toEqual([]);
    expect(firstResult.diagnostics).toEqual([]);

    const secondResult = parser.ingest(bytes.slice(splitPoint));
    expect(secondResult.diagnostics).toEqual([]);
    expect(secondResult.frames).toHaveLength(1);
    expect(secondResult.frames[0].command).toBe(0x7000);
    expect(secondResult.frames[0].payload).toEqual(payload);
  });

  it('rejects when innerPayloadSize exceeds maxPayloadBytes even though outerSize is within its own derived bound', () => {
    const maxPayloadBytes = 100;
    const outerSize = 56; // within [6, maxPayloadBytes + 6] = [6, 106]
    const innerDeclaredSize = 9000; // independently way over maxPayloadBytes
    const headerOnly = buildV2OverV1HeaderOnlyBytes(outerSize, 0x10, 0, innerDeclaredSize);

    const parser = createMspStreamParser({ maxPayloadBytes });
    const result = parser.ingest(headerOnly);

    expect(result.frames).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MSP_FRAME_TOO_LARGE');
    if (result.diagnostics[0].code === 'MSP_FRAME_TOO_LARGE') {
      expect(result.diagnostics[0].detail.declaredSize).toBe(innerDeclaredSize);
      expect(result.diagnostics[0].detail.maxPayloadBytes).toBe(maxPayloadBytes);
    }
  });

  it('rejects with MSP_MALFORMED_HEADER when outerSize does not equal overhead + innerPayloadSize exactly, no allocation, and resyncs', () => {
    const maxPayloadBytes = 1000;
    const innerDeclaredSize = 10;
    const wrongOuterSize = 6 + innerDeclaredSize + 4; // deliberately off by 4
    const malformedHeaderOnly = buildV2OverV1HeaderOnlyBytes(wrongOuterSize, 0x20, 0, innerDeclaredSize);
    const noise = Uint8Array.from([0xaa, 0xbb]);
    const nextFrame = encode(9, Uint8Array.from([1]), { wireFormat: 'v1' });

    const parser = createMspStreamParser({ maxPayloadBytes });
    const result = parser.ingest(concatAll([malformedHeaderOnly, noise, nextFrame]));

    expect(result.diagnostics.map((d) => d.code)).toEqual(['MSP_MALFORMED_HEADER', 'MSP_RESYNC']);
    if (result.diagnostics[1].code === 'MSP_RESYNC') {
      expect(result.diagnostics[1].detail.discardedByteCount).toBe(noise.length);
    }
    expect(result.frames.map((f) => f.command)).toEqual([9]);
  });

  it('accepts the smallest valid outerSize (innerPayloadSize = 0): outerSize is exactly the 6-byte overhead', () => {
    const bytes = encode(0x8000, new Uint8Array(0), { wireFormat: 'v2-over-v1' });
    // Outer size byte is at index 3 ('$','M','<',size,...) for this non-jumbo frame.
    expect(bytes[3]).toBe(6);

    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].command).toBe(0x8000);
    expect(result.frames[0].payload).toEqual(new Uint8Array(0));
  });

  it('a zero-length inner payload succeeds end-to-end and produces a valid frame', () => {
    const bytes = encode(0x8001, new Uint8Array(0), { wireFormat: 'v2-over-v1', flags: 0x05 });
    const parser = createMspStreamParser();
    const result = parser.ingest(bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].wireFormat).toBe('v2-over-v1');
    expect(result.frames[0].flags).toBe(0x05);
    expect(result.frames[0].payload).toHaveLength(0);
  });

  it('never allocates a payload buffer larger than maxPayloadBytes (not outerSize) across a sweep of v2-over-v1 frames', () => {
    const maxPayloadBytes = 500;
    const innerSizes = [0, 1, 50, 249, 250, 499, 500]; // 249/250/... straddle the outer jumbo threshold (outerSize = inner + 6)
    for (const innerSize of innerSizes) {
      const payload = new Uint8Array(innerSize).map((_, i) => i & 0xff);
      const bytes = encode(0x9000, payload, { wireFormat: 'v2-over-v1' });
      const parser = createMspStreamParser({ maxPayloadBytes });
      const result = parser.ingest(bytes);

      expect(result.diagnostics).toEqual([]);
      expect(result.frames).toHaveLength(1);
      // The allocated buffer's actual length IS frame.payload.length (a
      // Uint8Array's .length reflects exactly what was allocated for it) —
      // asserting it equals innerSize (never outerSize = innerSize + 6, and
      // never anything above maxPayloadBytes) is a direct, inspectable proof
      // of what was actually allocated, not an assumption.
      expect(result.frames[0].payload.length).toBe(innerSize);
      expect(result.frames[0].payload.length).toBeLessThanOrEqual(maxPayloadBytes);
    }
  });

  it('never allocates a buffer sized by outerSize itself (instrumented Uint8Array allocation proof)', () => {
    const innerPayloadSize = 20;
    const outerSize = 6 + innerPayloadSize; // 26 — what a buggy outerSize-sized allocation would look like
    const payload = new Uint8Array(innerPayloadSize).map((_, i) => i);
    // Build the frame bytes with the REAL global Uint8Array, before instrumenting it below.
    const bytes = encode(0xa000, payload, { wireFormat: 'v2-over-v1' });
    const parser = createMspStreamParser();

    const requestedSizes: number[] = [];
    const RealUint8Array = Uint8Array;
    const globalWithUint8Array = globalThis as unknown as { Uint8Array: unknown };
    function InstrumentedUint8Array(arg?: unknown) {
      if (typeof arg === 'number') requestedSizes.push(arg);
      // `new RealUint8Array(...)` here explicitly returns an object, which is
      // what `new InstrumentedUint8Array(...)` callers actually receive. Only
      // the numeric-length constructor form is used anywhere in this test.
      return new RealUint8Array(arg as number);
    }
    globalWithUint8Array.Uint8Array = InstrumentedUint8Array;

    let result;
    try {
      result = parser.ingest(bytes);
    } finally {
      globalWithUint8Array.Uint8Array = RealUint8Array;
    }

    expect(result.diagnostics).toEqual([]);
    expect(result.frames).toHaveLength(1);
    // Exactly one size-based Uint8Array allocation happens while decoding a
    // v2-over-v1 frame (the payload buffer in finishV2Header), and it is
    // sized by the INNER payload size — never by outerSize. Note: since the
    // parser enforces outerSize === overhead + innerSize exactly (the
    // MSP_MALFORMED_HEADER cross-check above) for any frame that reaches
    // allocation at all, there is no way to construct a successfully-parsed
    // frame where outerSize and innerSize diverge — so instrumenting the
    // actual allocation call is the only way to observe which one was used,
    // rather than inferring it from a size/timing side-channel.
    expect(requestedSizes).toEqual([innerPayloadSize]);
    expect(requestedSizes).not.toContain(outerSize);
  });
});
