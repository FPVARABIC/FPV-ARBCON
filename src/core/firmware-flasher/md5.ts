function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

/** Dependency-free MD5 for esptool's flash verification callback. */
export function md5Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string'
    ? Uint8Array.from(input, character => character.charCodeAt(0) & 0xff)
    : input;
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({length: 64}, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
  );

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let round = 0; round < 64; round += 1) {
      let f: number;
      let word: number;
      if (round < 16) {
        f = (b & c) | (~b & d);
        word = round;
      } else if (round < 32) {
        f = (d & b) | (~d & c);
        word = (5 * round + 1) % 16;
      } else if (round < 48) {
        f = b ^ c ^ d;
        word = (3 * round + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        word = (7 * round) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + rotateLeft(
        (a + f + constants[round] + view.getUint32(offset + word * 4, true)) | 0,
        shifts[round],
      )) | 0;
      a = next;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0]
    .map(value => [0, 8, 16, 24]
      .map(shift => ((value >>> shift) & 0xff).toString(16).padStart(2, '0'))
      .join(''))
    .join('');
}
