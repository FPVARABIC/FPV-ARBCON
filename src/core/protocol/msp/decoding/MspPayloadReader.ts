/**
 * Bounds-checked, forward-only cursor over an MSP response payload. Every
 * read method throws MspPayloadReadError rather than silently returning
 * truncated/garbage data if the requested read would exceed the remaining
 * buffer length - no decoder built on top of this may ever read past the
 * end of the actual payload.
 *
 * remaining() is the primary mechanism decoders use to detect whether an
 * optional trailing field group is actually present (see decodeBoardInfo.ts) -
 * checking it before a read, rather than attempting the read and catching
 * the resulting exception, keeps "no more optional fields" a normal,
 * expected control-flow path rather than exception-driven.
 *
 * readBytes() is not part of the originally-sketched method list, but is a
 * natural, minimal addition: MSP_BOARD_INFO's signature field is a fixed-
 * length raw byte buffer (not ASCII text), and captured trailing bytes
 * (decodeBoardInfo.ts's own trailingBytes field) need the same raw-byte
 * read - readFixedAscii() alone cannot serve either use without lossy
 * string round-tripping.
 */

export class MspPayloadReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MspPayloadReadError';
  }
}

export class MspPayloadReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** Bytes not yet consumed - never negative, never throws. */
  remaining(): number {
    return this.bytes.length - this.offset;
  }

  private ensure(byteCount: number): void {
    if (this.remaining() < byteCount) {
      throw new MspPayloadReadError(
        `MspPayloadReader: attempted to read ${byteCount} byte(s) with only ` +
          `${this.remaining()} remaining (offset ${this.offset} of ${this.bytes.length}).`,
      );
    }
  }

  readU8(): number {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  readU16LE(): number {
    this.ensure(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value >>> 0;
  }

  readU32LE(): number {
    this.ensure(4);
    const value =
      (this.bytes[this.offset] |
        (this.bytes[this.offset + 1] << 8) |
        (this.bytes[this.offset + 2] << 16) |
        (this.bytes[this.offset + 3] << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  /** Raw bytes, not an ASCII string - see the class doc comment. */
  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readFixedAscii(length: number): string {
    this.ensure(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += String.fromCharCode(this.bytes[this.offset + i]);
    }
    this.offset += length;
    return result;
  }

  /**
   * Betaflight's sbufWritePString()-style encoding: a 1-byte length prefix
   * followed by that many ASCII bytes. The length-prefix byte itself is
   * read first (via readU8(), which already bounds-checks that one byte
   * exists); if the length it declares exceeds what's actually remaining,
   * this throws the same MspPayloadReadError readFixedAscii() would - a
   * corrupted/truncated length-prefixed string is exactly as much an
   * over-read as any other field.
   */
  readLengthPrefixedString(): string {
    const length = this.readU8();
    return this.readFixedAscii(length);
  }
}
