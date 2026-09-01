/**
 * THE BLACKBOX WIRE CONTRACT, IN BYTES.
 *
 * Every expected payload in this file is HAND-WRITTEN from the Betaflight
 * serializer at commit 7348054f268f0058574719c134e9f149565bb8ea (API 1.47),
 * re-checked against master (API 1.49). Nothing here is produced by our own
 * decoder or encoder - the round-trip check at the end is an EXTRA, and it
 * is deliberately the only place the two meet.
 *
 * The three read frames and the one write frame:
 *
 *   MSP_BLACKBOX_CONFIG    80  11 bytes  u8 u8 u8 u8 u16 u8 u32
 *   MSP_DATAFLASH_SUMMARY  70  13 bytes  u8 u32 u32 u32
 *   MSP_SDCARD_SUMMARY     79  11 bytes  u8 u8 u8 u32 u32
 *   MSP_SET_BLACKBOX_CONFIG 81 10 bytes  u8 u8 u8 u16 u8 u32
 *
 * LITTLE-ENDIAN, AND THE ARITHMETIC IS SPELLED OUT. 16 MiB is 16777216 =
 * 0x01000000, which on the wire is 00 00 00 01 - the byte carrying the 1 is
 * LAST. A big-endian reading of the same four bytes is 16777216 only by
 * coincidence of this particular value, so the fixtures below also use
 * numbers whose two readings differ (0x00801000 vs 0x00108000).
 */

import {
  BLACKBOX_CONFIG_PAYLOAD_BYTES,
  decodeBlackboxConfig,
} from './decodeBlackboxConfig';
import {
  DATAFLASH_SUMMARY_PAYLOAD_BYTES,
  decodeDataflashSummary,
} from './decodeDataflashSummary';
import {
  SDCARD_SUMMARY_PAYLOAD_BYTES,
  decodeSdcardSummary,
} from './decodeSdcardSummary';
import {MspPayloadReadError} from './MspPayloadReader';
import {
  BLACKBOX_CONFIG_WRITE_BYTES,
  encodeBlackboxConfig,
} from '../encoding/encodeBlackboxConfig';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/* ================================================================== *
 * FIXTURES - hand-written, with the arithmetic shown
 * ================================================================== */

/**
 * Blackbox: supported, device FLASH(1), legacy num 1, legacy denom 2,
 * pRatio 32 (0x0020 -> 20 00), sampleRate 1, mask 0.
 */
const BB_SUPPORTED_FLASH = bytes(
  0x01, 0x01, 0x01, 0x02, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
);

/** Blackbox: supported, device NONE(0), sampleRate 0, mask 0. */
const BB_SUPPORTED_NONE = bytes(
  0x01, 0x00, 0x01, 0x01, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
);

/** Blackbox: the firmware's !USE_BLACKBOX branch - eleven zeros. */
const BB_UNSUPPORTED = bytes(
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
);

/**
 * Blackbox with bits 0 and 3 disabled.
 *   bit0 = 1, bit3 = 8  ->  9  ->  0x00000009  ->  09 00 00 00
 */
const BB_MASK_BITS_0_AND_3 = bytes(
  0x01, 0x01, 0x01, 0x02, 0x20, 0x00, 0x01, 0x09, 0x00, 0x00, 0x00,
);

/**
 * Dataflash 16 MiB, ready, empty.
 *   flags     = SUPPORTED(2) | READY(1) = 3
 *   sectors   = 256      = 0x00000100 -> 00 01 00 00
 *   total     = 16777216 = 0x01000000 -> 00 00 00 01
 *   used      = 0
 */
const DF_READY_EMPTY_16MIB = bytes(
  0x03,
  0x00, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00,
);

/**
 * Dataflash 16 MiB, ready, half used.
 *   used = 8388608 = 0x00800000 -> 00 00 80 00
 */
const DF_READY_HALF = bytes(
  0x03,
  0x00, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x80, 0x00,
);

/** Dataflash 16 MiB, ready, completely full: used == total. */
const DF_READY_FULL = bytes(
  0x03,
  0x00, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01,
);

/** Dataflash: no chip - the firmware's else branch, thirteen zeros. */
const DF_UNSUPPORTED = bytes(
  0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/**
 * Dataflash present but NOT ready: flags = SUPPORTED only (2), and the
 * sizes are still populated - which is exactly the trap.
 */
const DF_SUPPORTED_NOT_READY = bytes(
  0x02,
  0x00, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x80, 0x00,
);

/** SD: slot not configured at all - flags 0, everything zero. */
const SD_UNCONFIGURED = bytes(
  0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/** SD: configured (flags 1), state NOT_PRESENT(0), capacities zero. */
const SD_CONFIGURED_NO_CARD = bytes(
  0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/** SD: card initialising (state 2). */
const SD_CARD_INIT = bytes(
  0x01, 0x02, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/** SD: filesystem initialising (state 3). */
const SD_FS_INIT = bytes(
  0x01, 0x03, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/**
 * SD ready with capacity, in KILOBYTES:
 *   free  =  1052672 kB = 0x00101000 -> 00 10 10 00
 *   total = 31113216 kB = 0x01DAC000 -> 00 C0 DA 01
 * The endianness test below uses a value whose reversed reading is a
 * different number, which these two are not required to be.
 */
const SD_READY = bytes(
  0x01, 0x04, 0x00,
  0x00, 0x10, 0x10, 0x00,
  0x00, 0xc0, 0xda, 0x01,
);

/** SD: fatal, with a filesystem error code the firmware happened to hold. */
const SD_FATAL = bytes(
  0x01, 0x01, 0x07,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/** SD: a state value this build does not model. */
const SD_UNKNOWN_STATE_9 = bytes(
  0x01, 0x09, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
);

/* ================================================================== *
 * MSP_BLACKBOX_CONFIG
 * ================================================================== */

describe('MSP_BLACKBOX_CONFIG decodes exactly the eleven bytes', () => {
  it('reads every field of a supported FLASH configuration', () => {
    expect(BB_SUPPORTED_FLASH).toHaveLength(BLACKBOX_CONFIG_PAYLOAD_BYTES);
    expect(decodeBlackboxConfig(BB_SUPPORTED_FLASH)).toEqual({
      supported: true,
      supportedRaw: 1,
      deviceRaw: 1,
      legacyRateNumerator: 1,
      legacyRateDenominator: 2,
      pRatio: 32,
      sampleRateRaw: 1,
      disabledFieldsMask: 0,
    });
  });

  it('reads a supported board with logging switched off', () => {
    const config = decodeBlackboxConfig(BB_SUPPORTED_NONE);
    expect(config.supported).toBe(true);
    expect(config.deviceRaw).toBe(0);
    expect(config.pRatio).toBe(16);
    expect(config.sampleRateRaw).toBe(0);
  });

  it('takes `supported` from byte 0, not from the reply arriving', () => {
    // The firmware answers command 80 on a build with no Blackbox at all,
    // with this exact all-zero frame. A decoder that treated a successful
    // reply as capability would call this board supported.
    const config = decodeBlackboxConfig(BB_UNSUPPORTED);
    expect(config.supported).toBe(false);
    expect(config.supportedRaw).toBe(0);
  });

  it('reads the disabled mask with bits 0 and 3 set', () => {
    expect(decodeBlackboxConfig(BB_MASK_BITS_0_AND_3).disabledFieldsMask).toBe(
      0x00000009,
    );
  });

  it('keeps an unmodelled device byte instead of narrowing it', () => {
    const withVirtual = Uint8Array.from(BB_SUPPORTED_FLASH);
    withVirtual[1] = 4; // BLACKBOX_DEVICE_VIRTUAL - master only
    expect(decodeBlackboxConfig(withVirtual).deviceRaw).toBe(4);
    const withNonsense = Uint8Array.from(BB_SUPPORTED_FLASH);
    withNonsense[1] = 0xfe;
    expect(decodeBlackboxConfig(withNonsense).deviceRaw).toBe(0xfe);
  });

  it('keeps an out-of-range sample rate byte', () => {
    const odd = Uint8Array.from(BB_SUPPORTED_FLASH);
    odd[6] = 9;
    expect(decodeBlackboxConfig(odd).sampleRateRaw).toBe(9);
  });

  it('reads bit 31 of the mask as an unsigned value', () => {
    const highBit = Uint8Array.from(BB_SUPPORTED_FLASH);
    // 0x80000000 -> 00 00 00 80
    highBit.set([0x00, 0x00, 0x00, 0x80], 7);
    const mask = decodeBlackboxConfig(highBit).disabledFieldsMask;
    expect(mask).toBe(0x80000000);
    expect(mask).toBeGreaterThan(0);
  });

  it('reads an all-ones mask as 4294967295', () => {
    const allOnes = Uint8Array.from(BB_SUPPORTED_FLASH);
    allOnes.set([0xff, 0xff, 0xff, 0xff], 7);
    expect(decodeBlackboxConfig(allOnes).disabledFieldsMask).toBe(4294967295);
  });

  it('rejects every payload shorter than the contract', () => {
    for (let length = 0; length < BLACKBOX_CONFIG_PAYLOAD_BYTES; length += 1) {
      expect(() =>
        decodeBlackboxConfig(BB_SUPPORTED_FLASH.slice(0, length)),
      ).toThrow(MspPayloadReadError);
    }
  });

  it('ignores trailing bytes a newer firmware may append', () => {
    const longer = new Uint8Array(BLACKBOX_CONFIG_PAYLOAD_BYTES + 3);
    longer.set(BB_SUPPORTED_FLASH);
    expect(decodeBlackboxConfig(longer).deviceRaw).toBe(1);
  });
});

/* ================================================================== *
 * MSP_SET_BLACKBOX_CONFIG
 * ================================================================== */

describe('MSP_SET_BLACKBOX_CONFIG writes exactly the ten bytes', () => {
  it('lays the fields out in the order the firmware consumes them', () => {
    const payload = encodeBlackboxConfig({
      deviceRaw: 1,
      legacyRateNumerator: 1,
      legacyRateDenominator: 2,
      pRatio: 32,
      sampleRateRaw: 1,
      disabledFieldsMask: 0x00000009,
    });
    expect(payload).toHaveLength(BLACKBOX_CONFIG_WRITE_BYTES);
    // Hand-written: device, num, denom, pRatio LE, sampleRate, mask LE.
    expect(Array.from(payload)).toEqual([
      0x01, 0x01, 0x02, 0x20, 0x00, 0x01, 0x09, 0x00, 0x00, 0x00,
    ]);
  });

  it('writes pRatio little-endian', () => {
    // 513 = 0x0201 -> 01 02
    const payload = encodeBlackboxConfig({
      deviceRaw: 0,
      legacyRateNumerator: 1,
      legacyRateDenominator: 1,
      pRatio: 513,
      sampleRateRaw: 0,
      disabledFieldsMask: 0,
    });
    expect(Array.from(payload.slice(3, 5))).toEqual([0x01, 0x02]);
  });

  it('writes bit 31 of the mask without a sign', () => {
    const payload = encodeBlackboxConfig({
      deviceRaw: 2,
      legacyRateNumerator: 1,
      legacyRateDenominator: 1,
      pRatio: 0,
      sampleRateRaw: 4,
      disabledFieldsMask: 0x80000000,
    });
    expect(Array.from(payload.slice(6))).toEqual([0x00, 0x00, 0x00, 0x80]);
  });

  it('writes an all-ones mask', () => {
    const payload = encodeBlackboxConfig({
      deviceRaw: 0,
      legacyRateNumerator: 1,
      legacyRateDenominator: 1,
      pRatio: 0,
      sampleRateRaw: 0,
      disabledFieldsMask: 0xffffffff,
    });
    expect(Array.from(payload.slice(6))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('refuses a value that does not fit its field', () => {
    const base = {
      deviceRaw: 0,
      legacyRateNumerator: 1,
      legacyRateDenominator: 1,
      pRatio: 0,
      sampleRateRaw: 0,
      disabledFieldsMask: 0,
    };
    expect(() => encodeBlackboxConfig({...base, deviceRaw: 256})).toThrow(
      RangeError,
    );
    expect(() => encodeBlackboxConfig({...base, pRatio: 65_536})).toThrow(
      RangeError,
    );
    expect(() =>
      encodeBlackboxConfig({...base, disabledFieldsMask: 4_294_967_296}),
    ).toThrow(RangeError);
    expect(() => encodeBlackboxConfig({...base, deviceRaw: -1})).toThrow(
      RangeError,
    );
    expect(() => encodeBlackboxConfig({...base, sampleRateRaw: 1.5})).toThrow(
      RangeError,
    );
  });
});

/* ================================================================== *
 * MSP_DATAFLASH_SUMMARY
 * ================================================================== */

describe('MSP_DATAFLASH_SUMMARY decodes exactly the thirteen bytes', () => {
  it('reads a ready, empty 16 MiB volume', () => {
    expect(DF_READY_EMPTY_16MIB).toHaveLength(DATAFLASH_SUMMARY_PAYLOAD_BYTES);
    expect(decodeDataflashSummary(DF_READY_EMPTY_16MIB)).toEqual({
      flagsRaw: 3,
      supported: true,
      ready: true,
      sectorCount: 256,
      totalBytes: 16_777_216,
      usedBytes: 0,
    });
  });

  it('reads a half-used volume', () => {
    const summary = decodeDataflashSummary(DF_READY_HALF);
    expect(summary.usedBytes).toBe(8_388_608);
    expect(summary.totalBytes).toBe(16_777_216);
  });

  it('reads a full volume', () => {
    const summary = decodeDataflashSummary(DF_READY_FULL);
    expect(summary.usedBytes).toBe(summary.totalBytes);
  });

  it('reads the no-flash frame without inventing a chip', () => {
    expect(decodeDataflashSummary(DF_UNSUPPORTED)).toEqual({
      flagsRaw: 0,
      supported: false,
      ready: false,
      sectorCount: 0,
      totalBytes: 0,
      usedBytes: 0,
    });
  });

  it('separates SUPPORTED from READY - they are different bits', () => {
    const notReady = decodeDataflashSummary(DF_SUPPORTED_NOT_READY);
    expect(notReady.supported).toBe(true);
    expect(notReady.ready).toBe(false);
    // And the sizes are still on the wire, which is the whole problem.
    expect(notReady.totalBytes).toBe(16_777_216);
    expect(notReady.usedBytes).toBe(8_388_608);
  });

  it('reads a near-maximum u32 as unsigned', () => {
    const huge = Uint8Array.from(DF_READY_HALF);
    // 0xFFFFFFFF -> FF FF FF FF at total, 0xFFFFFFFE at used
    huge.set([0xff, 0xff, 0xff, 0xff], 5);
    huge.set([0xfe, 0xff, 0xff, 0xff], 9);
    const summary = decodeDataflashSummary(huge);
    expect(summary.totalBytes).toBe(4_294_967_295);
    expect(summary.usedBytes).toBe(4_294_967_294);
    expect(summary.totalBytes).toBeGreaterThan(0);
    expect(summary.usedBytes).toBeGreaterThan(0);
  });

  it('reads the size fields little-endian, not big-endian', () => {
    // 0x00801000 = 8392704. Its byte-reversed reading 0x00108000 = 1081344
    // is a different number, so this test cannot pass under either order.
    const frame = Uint8Array.from(DF_READY_HALF);
    frame.set([0x00, 0x10, 0x80, 0x00], 5);
    expect(decodeDataflashSummary(frame).totalBytes).toBe(0x00801000);
    expect(decodeDataflashSummary(frame).totalBytes).not.toBe(0x00108000);
  });

  it('rejects every payload shorter than the contract', () => {
    for (
      let length = 0;
      length < DATAFLASH_SUMMARY_PAYLOAD_BYTES;
      length += 1
    ) {
      expect(() =>
        decodeDataflashSummary(DF_READY_HALF.slice(0, length)),
      ).toThrow(MspPayloadReadError);
    }
  });
});

/* ================================================================== *
 * MSP_SDCARD_SUMMARY
 * ================================================================== */

describe('MSP_SDCARD_SUMMARY decodes exactly the eleven bytes', () => {
  it('reads a ready card with its capacities', () => {
    expect(SD_READY).toHaveLength(SDCARD_SUMMARY_PAYLOAD_BYTES);
    expect(decodeSdcardSummary(SD_READY)).toEqual({
      flagsRaw: 1,
      configured: true,
      stateRaw: 4,
      filesystemLastError: 0,
      freeKilobytes: 0x00101000,
      totalKilobytes: 0x01dac000,
    });
  });

  it('reads an unconfigured slot', () => {
    const summary = decodeSdcardSummary(SD_UNCONFIGURED);
    expect(summary.configured).toBe(false);
    expect(summary.stateRaw).toBe(0);
  });

  it('reads a configured slot with no card - both facts at once', () => {
    const summary = decodeSdcardSummary(SD_CONFIGURED_NO_CARD);
    expect(summary.configured).toBe(true);
    expect(summary.stateRaw).toBe(0);
  });

  it('reads the two initialising states apart', () => {
    expect(decodeSdcardSummary(SD_CARD_INIT).stateRaw).toBe(2);
    expect(decodeSdcardSummary(SD_FS_INIT).stateRaw).toBe(3);
  });

  it('carries the filesystem error code through', () => {
    const summary = decodeSdcardSummary(SD_FATAL);
    expect(summary.stateRaw).toBe(1);
    expect(summary.filesystemLastError).toBe(7);
  });

  it('keeps an unmodelled state byte verbatim', () => {
    expect(decodeSdcardSummary(SD_UNKNOWN_STATE_9).stateRaw).toBe(9);
  });

  it('reads the capacity fields little-endian', () => {
    // free 0x00C0DA01 vs its reversed reading 0x01DAC000 - different.
    const frame = Uint8Array.from(SD_READY);
    frame.set([0x01, 0xda, 0xc0, 0x00], 3);
    expect(decodeSdcardSummary(frame).freeKilobytes).toBe(0x00c0da01);
    expect(decodeSdcardSummary(frame).freeKilobytes).not.toBe(0x01dac000);
  });

  it('reads a near-maximum capacity as unsigned', () => {
    const frame = Uint8Array.from(SD_READY);
    frame.set([0xff, 0xff, 0xff, 0xff], 7);
    expect(decodeSdcardSummary(frame).totalKilobytes).toBe(4_294_967_295);
  });

  it('rejects every payload shorter than the contract', () => {
    for (let length = 0; length < SDCARD_SUMMARY_PAYLOAD_BYTES; length += 1) {
      expect(() => decodeSdcardSummary(SD_READY.slice(0, length))).toThrow(
        MspPayloadReadError,
      );
    }
  });
});

/* ================================================================== *
 * ROUND TRIP - an extra, never the primary proof
 * ================================================================== */

describe('the encoder and decoder agree on the shared fields', () => {
  it('carries a configuration out and back', () => {
    // NOT the byte-layout proof: those are the hand-written expectations
    // above. This only guards the two modules against drifting apart.
    const decoded = decodeBlackboxConfig(BB_MASK_BITS_0_AND_3);
    const encoded = encodeBlackboxConfig({
      deviceRaw: decoded.deviceRaw,
      legacyRateNumerator: decoded.legacyRateNumerator,
      legacyRateDenominator: decoded.legacyRateDenominator,
      pRatio: decoded.pRatio,
      sampleRateRaw: decoded.sampleRateRaw,
      disabledFieldsMask: decoded.disabledFieldsMask,
    });
    // The write frame is the read frame minus its leading `supported` byte.
    expect(Array.from(encoded)).toEqual(
      Array.from(BB_MASK_BITS_0_AND_3.slice(1)),
    );
  });
});
