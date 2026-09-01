/**
 * Bounds-checked, forward-only cursor over an MSP response payload. By
 * default every read method throws MspPayloadReadError rather than
 * silently returning truncated/garbage data if the requested read would
 * exceed the remaining buffer length - no decoder built on top of this may
 * ever read past the end of the actual payload.
 *
 * The one exception is opt-in `lenient` mode, which exists solely to match
 * Betaflight Configurator's own tolerance for short MSP_BOARD_INFO
 * responses - see the constructor. Lenient readers never throw; they yield
 * a zero/empty value and set truncated().
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
  private readonly lenient: boolean;
  /** True once a read has actually run off the end under lenient mode. A
   * decoder can report "the firmware sent fewer bytes than this decoder
   * knows about" without having to compare lengths itself. */
  private truncatedFlag = false;

  /**
   * `lenient` exists for ONE reason, and it is Betaflight parity.
   *
   * Betaflight Configurator's reader (src/js/injected_methods.js) returns
   * `null` from readU8/readU16/readU32 instead of throwing when the
   * payload runs out, and MSPHelper's getText() turns a null length into
   * 0. Its MSP_BOARD_INFO decoder (src/js/msp/MSPHelper.js, `case
   * MSPCodes.MSP_BOARD_INFO`) then reads all fourteen fields
   * unconditionally - no API-version branch, no length check - so a
   * firmware whose response is shorter than the current field list simply
   * yields nulls at the tail and the board still connects.
   *
   * Our strict default is the better contract for a decoder we control the
   * inputs of, and it stays the default for every other decoder. But for
   * BOARD_INFO specifically, "throw" means "reject a flight controller
   * Betaflight would have accepted", which is precisely the failure this
   * project is chasing. Lenient mode reproduces Betaflight's tolerance
   * without reproducing its NUL-padded strings: an over-read yields a
   * zero/empty value and sets truncated().
   */
  constructor(private readonly bytes: Uint8Array, options?: {lenient?: boolean}) {
    this.lenient = options?.lenient === true;
  }

  /** Bytes not yet consumed - never negative, never throws. */
  remaining(): number {
    return this.bytes.length - this.offset;
  }

  /** Whether any read ran past the end of the payload (lenient mode only;
   * in strict mode such a read throws instead). */
  truncated(): boolean {
    return this.truncatedFlag;
  }

  /** Returns false in lenient mode when the read cannot be satisfied, so
   * callers yield a default instead of reading garbage. */
  private ensure(byteCount: number): boolean {
    if (this.remaining() >= byteCount) {
      return true;
    }
    if (this.lenient) {
      this.truncatedFlag = true;
      // Consume whatever is left: a forward-only cursor must never appear
      // to rewind, and every later read then also finds nothing.
      this.offset = this.bytes.length;
      return false;
    }
    throw new MspPayloadReadError(
      `MspPayloadReader: attempted to read ${byteCount} byte(s) with only ` +
        `${this.remaining()} remaining (offset ${this.offset} of ${this.bytes.length}).`,
    );
  }

  readU8(): number {
    if (!this.ensure(1)) return 0;
    return this.bytes[this.offset++];
  }

  readU16LE(): number {
    if (!this.ensure(2)) return 0;
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value >>> 0;
  }

  /** Pass 7.0 - added because MSP_ATTITUDE's roll/pitch/yaw fields are
   * genuinely signed (see decodeAttitude.ts's own doc comment: Betaflight
   * declares them int16_t and roll/pitch can go negative) even though the
   * firmware source writes them via sbufWriteU16 - that is only the raw
   * byte-writing primitive's name, not a claim about the value's sign.
   * Reads the same two little-endian bytes readU16LE() would, then
   * reinterprets as two's-complement signed 16-bit. */
  readS16LE(): number {
    const unsigned = this.readU16LE();
    return unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  }

  readU32LE(): number {
    if (!this.ensure(4)) return 0;
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
    if (!this.ensure(length)) return new Uint8Array(0);
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readFixedAscii(length: number): string {
    if (!this.ensure(length)) return '';
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
   * over-read as any other field. Under lenient mode it yields '' and
   * marks the reader truncated instead, matching Betaflight's getText().
   */
  readLengthPrefixedString(): string {
    const length = this.readU8();
    return this.readFixedAscii(length);
  }
}
