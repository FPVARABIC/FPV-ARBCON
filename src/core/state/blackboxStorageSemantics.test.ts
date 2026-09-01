/**
 * WHAT A ZERO MEANS, PER STATE.
 *
 * The three Blackbox read commands all answer with a complete frame in
 * every situation, so the payload alone cannot separate a measurement of
 * zero from the absence of a measurement. This suite pins the separation.
 *
 * Every input below is decoded from HAND-WRITTEN bytes, not built as an
 * object literal, so the semantic rules are proven against the same wire
 * shape the firmware emits.
 */

import {decodeBlackboxConfig} from '../protocol/msp/decoding/decodeBlackboxConfig';
import {decodeDataflashSummary} from '../protocol/msp/decoding/decodeDataflashSummary';
import {decodeSdcardSummary} from '../protocol/msp/decoding/decodeSdcardSummary';
import {
  classifyBlackboxConfig,
  classifyBlackboxDevice,
  classifyBlackboxSampleRate,
  classifyDataflash,
  classifySdcard,
  dataflashEraseWouldApply,
  isBlackboxFieldDisabled,
  setBlackboxFieldDisabled,
} from './blackboxStorageSemantics';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const blackbox = (over: {
  supported?: number;
  device?: number;
  sampleRate?: number;
  mask?: readonly number[];
}) =>
  decodeBlackboxConfig(
    bytes(
      over.supported ?? 0x01,
      over.device ?? 0x01,
      0x01,
      0x02,
      0x20,
      0x00,
      over.sampleRate ?? 0x01,
      ...(over.mask ?? [0x00, 0x00, 0x00, 0x00]),
    ),
  );

const dataflash = (
  flags: number,
  total: readonly number[],
  used: readonly number[],
) =>
  decodeDataflashSummary(
    bytes(flags, 0x00, 0x01, 0x00, 0x00, ...total, ...used),
  );

const SIXTEEN_MIB = [0x00, 0x00, 0x00, 0x01] as const; // 0x01000000
const EIGHT_MIB = [0x00, 0x00, 0x80, 0x00] as const; // 0x00800000
const ZERO32 = [0x00, 0x00, 0x00, 0x00] as const;

const sdcard = (
  flags: number,
  state: number,
  free: readonly number[] = ZERO32,
  total: readonly number[] = ZERO32,
  lastError = 0x00,
) => decodeSdcardSummary(bytes(flags, state, lastError, ...free, ...total));

/* ================================================================== *
 * DEVICE
 * ================================================================== */

describe('the logging device is modelled only where a source proves it', () => {
  it('maps the four devices the pinned API-1.47 enum defines', () => {
    expect(classifyBlackboxDevice(0)).toEqual({
      device: 'NONE',
      raw: 0,
      modelled: true,
    });
    expect(classifyBlackboxDevice(1).device).toBe('FLASH');
    expect(classifyBlackboxDevice(2).device).toBe('SDCARD');
    expect(classifyBlackboxDevice(3).device).toBe('SERIAL');
  });

  it('does NOT claim VIRTUAL - it exists on master, not at API 1.47', () => {
    const virtual = classifyBlackboxDevice(4);
    expect(virtual.device).toBe('UNKNOWN');
    expect(virtual.modelled).toBe(false);
    // The value survives, so nothing is lost by refusing to name it.
    expect(virtual.raw).toBe(4);
  });

  it('keeps any other byte as UNKNOWN rather than crashing or defaulting', () => {
    for (const raw of [5, 99, 255]) {
      const selection = classifyBlackboxDevice(raw);
      expect(selection.device).toBe('UNKNOWN');
      expect(selection.raw).toBe(raw);
      // Never silently folded into NONE, which would read as "logging off".
      expect(selection.device).not.toBe('NONE');
    }
  });
});

/* ================================================================== *
 * SAMPLE RATE
 * ================================================================== */

describe('the sample rate is a divider, and only 0..4 exist', () => {
  it('maps each defined value to its divider', () => {
    expect(classifyBlackboxSampleRate(0).divider).toBe(1);
    expect(classifyBlackboxSampleRate(1).divider).toBe(2);
    expect(classifyBlackboxSampleRate(2).divider).toBe(4);
    expect(classifyBlackboxSampleRate(3).divider).toBe(8);
    expect(classifyBlackboxSampleRate(4).divider).toBe(16);
  });

  it('reports an out-of-range value without inventing a divider', () => {
    const odd = classifyBlackboxSampleRate(9);
    expect(odd.modelled).toBe(false);
    expect(odd.divider).toBeUndefined();
    expect(odd.raw).toBe(9);
  });
});

/* ================================================================== *
 * DISABLED-FIELDS MASK
 * ================================================================== */

describe('a set bit DISABLES its field', () => {
  it('reads 0x00000009 as bits 0 and 3 disabled and nothing else', () => {
    const mask = 0x00000009;
    expect(isBlackboxFieldDisabled(mask, 0)).toBe(true);
    expect(isBlackboxFieldDisabled(mask, 3)).toBe(true);
    for (const bit of [1, 2, 4, 5, 16, 30, 31]) {
      expect([bit, isBlackboxFieldDisabled(mask, bit)]).toEqual([bit, false]);
    }
  });

  it('reads that mask off the wire the same way', () => {
    const config = classifyBlackboxConfig(
      blackbox({mask: [0x09, 0x00, 0x00, 0x00]}),
    );
    expect(config.disabledFieldsMask).toBe(0x00000009);
    expect(isBlackboxFieldDisabled(config.disabledFieldsMask, 0)).toBe(true);
    expect(isBlackboxFieldDisabled(config.disabledFieldsMask, 1)).toBe(false);
  });

  it('handles bit 31 without ever producing a negative mask', () => {
    // 1 << 31 is negative in JavaScript. Nothing this module returns may be.
    const mask = setBlackboxFieldDisabled(0, 31, true);
    expect(mask).toBe(0x80000000);
    expect(mask).toBeGreaterThan(0);
    expect(isBlackboxFieldDisabled(mask, 31)).toBe(true);
    expect(isBlackboxFieldDisabled(mask, 30)).toBe(false);

    const cleared = setBlackboxFieldDisabled(mask, 31, false);
    expect(cleared).toBe(0);
    expect(cleared).toBeGreaterThanOrEqual(0);
  });

  it('keeps an all-ones mask unsigned through a set and a clear', () => {
    const all = 0xffffffff;
    expect(isBlackboxFieldDisabled(all, 31)).toBe(true);
    const withoutBit0 = setBlackboxFieldDisabled(all, 0, false);
    expect(withoutBit0).toBe(0xfffffffe);
    expect(withoutBit0).toBeGreaterThan(0);
    const restored = setBlackboxFieldDisabled(withoutBit0, 0, true);
    expect(restored).toBe(4_294_967_295);
  });

  it('carries a bit-31 mask through the classifier unsigned', () => {
    const config = classifyBlackboxConfig(
      blackbox({mask: [0x00, 0x00, 0x00, 0x80]}),
    );
    expect(config.disabledFieldsMask).toBe(0x80000000);
    expect(config.disabledFieldsMask).toBeGreaterThan(0);
  });

  it('refuses a bit outside 0..31 rather than silently wrapping', () => {
    expect(() => isBlackboxFieldDisabled(0, 32)).toThrow(RangeError);
    expect(() => isBlackboxFieldDisabled(0, -1)).toThrow(RangeError);
    expect(() => setBlackboxFieldDisabled(0, 32, true)).toThrow(RangeError);
  });
});

/* ================================================================== *
 * DATAFLASH
 * ================================================================== */

describe('dataflash storage states', () => {
  it('UNSUPPORTED: no chip, and no measurement to show', () => {
    const storage = classifyDataflash(dataflash(0x00, ZERO32, ZERO32));
    expect(storage.state).toBe('UNSUPPORTED');
    expect(storage.measurementsValid).toBe(false);
    expect(storage.totalBytes).toBeUndefined();
    expect(storage.usedBytes).toBeUndefined();
    expect(storage.freeBytes).toBeUndefined();
  });

  it('READY_EMPTY: a zero that IS a measurement', () => {
    const storage = classifyDataflash(dataflash(0x03, SIXTEEN_MIB, ZERO32));
    expect(storage.state).toBe('READY_EMPTY');
    expect(storage.measurementsValid).toBe(true);
    expect(storage.usedBytes).toBe(0);
    expect(storage.totalBytes).toBe(16_777_216);
    expect(storage.freeBytes).toBe(16_777_216);
  });

  it('READY_WITH_DATA: free is derived, not read', () => {
    const storage = classifyDataflash(dataflash(0x03, SIXTEEN_MIB, EIGHT_MIB));
    expect(storage.state).toBe('READY_WITH_DATA');
    expect(storage.usedBytes).toBe(8_388_608);
    expect(storage.freeBytes).toBe(16_777_216 - 8_388_608);
  });

  it('READY_FULL: used equals total, nothing left', () => {
    const storage = classifyDataflash(
      dataflash(0x03, SIXTEEN_MIB, SIXTEEN_MIB),
    );
    expect(storage.state).toBe('READY_FULL');
    expect(storage.freeBytes).toBe(0);
    expect(storage.measurementsValid).toBe(true);
  });

  it('supported dataflash that is not ready is never classified as empty', () => {
    // THE REGRESSION. flags = SUPPORTED without READY, used = 0. A reader
    // that only asked "is used zero?" calls this an empty volume. It is a
    // volume whose state cannot be measured right now - which is what a
    // chip mid-erase reports.
    const storage = classifyDataflash(dataflash(0x02, SIXTEEN_MIB, ZERO32));
    expect(storage.state).toBe('BUSY_OR_NOT_READY');
    expect(storage.state).not.toBe('READY_EMPTY');
    expect(storage.state).not.toBe('UNSUPPORTED');
    expect(storage.measurementsValid).toBe(false);
    expect(storage.usedBytes).toBeUndefined();
    expect(storage.freeBytes).toBeUndefined();
  });

  it('withholds the numbers a not-ready volume is still reporting', () => {
    // Same state, but the wire carries real-looking sizes. They are not a
    // stable reading and must not reach a person as one.
    const summary = dataflash(0x02, SIXTEEN_MIB, EIGHT_MIB);
    expect(summary.totalBytes).toBe(16_777_216);
    const storage = classifyDataflash(summary);
    expect(storage.state).toBe('BUSY_OR_NOT_READY');
    expect(storage.totalBytes).toBeUndefined();
  });

  it('INCONSISTENT: used > total is reported, never clamped', () => {
    const storage = classifyDataflash(dataflash(0x03, EIGHT_MIB, SIXTEEN_MIB));
    expect(storage.state).toBe('INCONSISTENT');
    expect(storage.measurementsValid).toBe(false);
    expect(storage.freeBytes).toBeUndefined();
    // No unsigned underflow anywhere in the result.
    expect(storage.freeBytes).not.toBe(4_294_967_295 - 8_388_608 + 1);
  });

  it('INCONSISTENT: a ready volume claiming zero total size', () => {
    const storage = classifyDataflash(dataflash(0x03, ZERO32, ZERO32));
    expect(storage.state).toBe('INCONSISTENT');
    expect(storage.measurementsValid).toBe(false);
  });

  it('handles near-maximum u32 sizes without sign trouble', () => {
    const max = [0xff, 0xff, 0xff, 0xff] as const;
    const nearMax = [0xfe, 0xff, 0xff, 0xff] as const;
    const storage = classifyDataflash(dataflash(0x03, max, nearMax));
    expect(storage.totalBytes).toBe(4_294_967_295);
    expect(storage.usedBytes).toBe(4_294_967_294);
    expect(storage.freeBytes).toBe(1);
    expect(storage.state).toBe('READY_WITH_DATA');
  });
});

/* ================================================================== *
 * SD CARD
 * ================================================================== */

describe('SD card storage states', () => {
  it('an unconfigured slot is not a card fault', () => {
    const storage = classifySdcard(sdcard(0x00, 0x00));
    expect(storage.configured).toBe(false);
    expect(storage.state).toBe('NOT_PRESENT');
    expect(storage.measurementsValid).toBe(false);
  });

  it('configured with no card is BOTH facts, and neither is "0 MB"', () => {
    // THE REQUIRED CASE. flags=1 means an SD slot is wired up as a logging
    // destination; state=0 means nothing is in it. The capacities the
    // firmware sent are uninitialised locals, not a zero-capacity card.
    const storage = classifySdcard(sdcard(0x01, 0x00));
    expect(storage.configured).toBe(true);
    expect(storage.state).toBe('NOT_PRESENT');
    expect(storage.totalKilobytes).toBeUndefined();
    expect(storage.freeKilobytes).toBeUndefined();
    expect(storage.usedKilobytes).toBeUndefined();
    expect(storage.measurementsValid).toBe(false);
  });

  it('maps every defined state byte', () => {
    expect(classifySdcard(sdcard(0x01, 0x00)).state).toBe('NOT_PRESENT');
    expect(classifySdcard(sdcard(0x01, 0x01)).state).toBe('FATAL');
    expect(classifySdcard(sdcard(0x01, 0x02)).state).toBe('CARD_INITIALIZING');
    expect(classifySdcard(sdcard(0x01, 0x03)).state).toBe(
      'FILESYSTEM_INITIALIZING',
    );
    expect(classifySdcard(sdcard(0x01, 0x04)).state).toBe('READY');
  });

  it('reports an unmodelled state as UNKNOWN with its raw value', () => {
    const storage = classifySdcard(sdcard(0x01, 0x09));
    expect(storage.state).toBe('UNKNOWN');
    expect(storage.stateRaw).toBe(9);
    // Never folded into a state that would invent a fault, an absence or
    // a capacity.
    expect(storage.state).not.toBe('FATAL');
    expect(storage.state).not.toBe('NOT_PRESENT');
    expect(storage.state).not.toBe('READY');
    expect(storage.measurementsValid).toBe(false);
    expect(storage.totalKilobytes).toBeUndefined();
  });

  it('capacity is valid ONLY in READY', () => {
    // The firmware writes free/total inside `if (state == READY)`. Prove
    // that by sending real capacities under every other state: they must
    // not surface.
    const free = [0x00, 0x10, 0x10, 0x00] as const; // 0x00101000
    const total = [0x00, 0xc0, 0xda, 0x01] as const; // 0x01DAC000
    for (const state of [0x00, 0x01, 0x02, 0x03, 0x09]) {
      const storage = classifySdcard(sdcard(0x01, state, free, total));
      expect([state, storage.totalKilobytes]).toEqual([state, undefined]);
      expect([state, storage.freeKilobytes]).toEqual([state, undefined]);
      expect([state, storage.measurementsValid]).toEqual([state, false]);
    }
    const ready = classifySdcard(sdcard(0x01, 0x04, free, total));
    expect(ready.totalKilobytes).toBe(0x01dac000);
    expect(ready.freeKilobytes).toBe(0x00101000);
    expect(ready.usedKilobytes).toBe(0x01dac000 - 0x00101000);
    expect(ready.measurementsValid).toBe(true);
  });

  it('refuses a READY card whose free exceeds its total', () => {
    const storage = classifySdcard(
      sdcard(0x01, 0x04, [0x00, 0xc0, 0xda, 0x01], [0x00, 0x10, 0x10, 0x00]),
    );
    expect(storage.state).toBe('READY');
    expect(storage.measurementsValid).toBe(false);
    expect(storage.usedKilobytes).toBeUndefined();
  });

  it('carries the filesystem error code without interpreting it', () => {
    const storage = classifySdcard(sdcard(0x01, 0x01, ZERO32, ZERO32, 0x07));
    expect(storage.filesystemLastError).toBe(7);
  });

  it('handles a near-maximum capacity as unsigned', () => {
    const storage = classifySdcard(
      sdcard(0x01, 0x04, [0x01, 0x00, 0x00, 0x00], [0xff, 0xff, 0xff, 0xff]),
    );
    expect(storage.totalKilobytes).toBe(4_294_967_295);
    expect(storage.usedKilobytes).toBe(4_294_967_294);
  });
});

/* ================================================================== *
 * THE CONFIG, AND ONE FACT B-3 WILL NEED
 * ================================================================== */

describe('the configuration read semantically', () => {
  it('reports an unsupported build without narrowing its fields', () => {
    const config = classifyBlackboxConfig(
      decodeBlackboxConfig(
        bytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      ),
    );
    expect(config.supported).toBe(false);
    expect(config.device.device).toBe('NONE');
    expect(config.sampleRate.divider).toBe(1);
  });

  it('reports a FLASH configuration at rate 1/2', () => {
    const config = classifyBlackboxConfig(blackbox({device: 1, sampleRate: 1}));
    expect(config.supported).toBe(true);
    expect(config.device.device).toBe('FLASH');
    expect(config.sampleRate.divider).toBe(2);
    expect(config.legacyRateDenominator).toBe(2);
    expect(config.pRatio).toBe(32);
  });
});

describe('whether an erase could apply at all', () => {
  const readyWithData = classifyDataflash(
    dataflash(0x03, SIXTEEN_MIB, EIGHT_MIB),
  );

  it('needs the CONFIGURED device to be FLASH, not merely a flash chip', () => {
    // blackboxEraseAll() switches on blackboxConfig()->device and does
    // nothing for any other value, so a board with a perfectly good chip
    // selected as SDCARD accepts the command and erases nothing.
    expect(
      dataflashEraseWouldApply(
        classifyBlackboxConfig(blackbox({device: 1})),
        readyWithData,
      ),
    ).toBe(true);
    for (const device of [0, 2, 3, 4]) {
      expect([
        device,
        dataflashEraseWouldApply(
          classifyBlackboxConfig(blackbox({device})),
          readyWithData,
        ),
      ]).toEqual([device, false]);
    }
  });

  it('needs the volume to be readable and to hold something', () => {
    const flash = classifyBlackboxConfig(blackbox({device: 1}));
    expect(
      dataflashEraseWouldApply(
        flash,
        classifyDataflash(dataflash(0x03, SIXTEEN_MIB, ZERO32)),
      ),
    ).toBe(false);
    expect(
      dataflashEraseWouldApply(
        flash,
        classifyDataflash(dataflash(0x02, SIXTEEN_MIB, EIGHT_MIB)),
      ),
    ).toBe(false);
    expect(
      dataflashEraseWouldApply(
        flash,
        classifyDataflash(dataflash(0x00, ZERO32, ZERO32)),
      ),
    ).toBe(false);
  });
});
