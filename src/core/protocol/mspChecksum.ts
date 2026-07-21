/**
 * MSP checksum algorithms: XOR (MSP v1) and CRC8-DVB-S2 (MSP v2).
 *
 * Both are exposed as a single-byte `*Step` function plus a bulk convenience
 * wrapper. The `*Step` forms exist because mspStreamParser.ts accumulates a
 * checksum incrementally, one byte at a time, as bytes arrive across
 * potentially many ingest() calls — it must never re-scan a buffer from
 * scratch. The bulk forms are implemented in terms of `*Step` and exist for
 * mspEncoder.ts and tests, which do have the full byte range in hand at once.
 */

/** MSP v1 checksum: XOR of every byte in the checksummed range. */
export function xorChecksumStep(crc: number, byte: number): number {
  return (crc ^ byte) & 0xff;
}

export function xorChecksum(bytes: Uint8Array, initial = 0): number {
  let crc = initial & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    crc = xorChecksumStep(crc, bytes[i]);
  }
  return crc;
}

// CRC8-DVB-S2, polynomial 0xD5, initial value 0x00.
//
// Transcribed line-for-line (not independently derived) from Betaflight's own
// implementation, per the Pass 6.1 instruction to transcribe rather than
// derive when no independent reference vector could be found for the
// algorithm's *source*:
//   crc8_calc() in src/main/common/crc.c
//   https://github.com/betaflight/betaflight/blob/master/src/main/common/crc.c
//   crc8_dvb_s2_update(crc, data, length) == crc8_update(crc, data, length, 0xD5)
//   in src/main/common/crc.h
//   https://github.com/betaflight/betaflight/blob/master/src/main/common/crc.h
//
//   uint8_t crc8_calc(uint8_t crc, unsigned char a, uint8_t poly) {
//       crc ^= a;
//       for (int ii = 0; ii < 8; ++ii) {
//           if (crc & 0x80) { crc = (crc << 1) ^ poly; } else { crc = crc << 1; }
//       }
//       return crc;
//   }
//
// Independently verified (not just self-consistent) against the CRC RevEng
// catalogue's published check value for CRC-8/DVB-S2 (poly 0xD5, init 0x00,
// refin/refout false, xorout 0x00): check("123456789") == 0xBC.
// https://reveng.sourceforge.io/crc-catalogue/legend.htm
const CRC8_DVB_S2_POLY = 0xd5;

export function crc8DvbS2Step(crc: number, byte: number): number {
  let c = (crc ^ byte) & 0xff;
  for (let i = 0; i < 8; i++) {
    c = c & 0x80 ? ((c << 1) ^ CRC8_DVB_S2_POLY) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export function crc8DvbS2(bytes: Uint8Array, initial = 0): number {
  let crc = initial & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc8DvbS2Step(crc, bytes[i]);
  }
  return crc;
}
