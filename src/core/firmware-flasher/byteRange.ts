/**
 * HALF-OPEN 32-BIT BYTE RANGES.
 *
 * Every address range in the firmware-flashing path is `[start,
 * endExclusive)`. Mixing inclusive and exclusive ends is how an off-by-one
 * gets into a destructive operation, so there is exactly one range type and
 * one set of predicates, and `lastAddress` is derived - never written by
 * hand as `start + length`.
 *
 * THE BOUND IS `endExclusive <= 0x1_0000_0000`, NOT `<= 0xFFFFFFFF`.
 * A one-byte range at 0xFFFFFFFF is arithmetically valid and the Intel-HEX
 * parser already accepts it (see intelHex.ts, which range-checks the LAST
 * address rather than the exclusive end). A stricter rule here would reject
 * an image the parser upstream had already accepted - two layers
 * disagreeing about the same bytes.
 *
 * 0x1_0000_0000 is 4294967296, exactly representable as a double and far
 * below Number.MAX_SAFE_INTEGER, so the addition cannot silently lose
 * precision.
 *
 * ARITHMETIC VALIDITY IS NOT DEVICE ACCEPTANCE. Everything here answers
 * only "is this range expressible in 32 bits?". Whether a range lies inside
 * a particular device's flash window is a separate decision made against a
 * selected chip profile, and it is deliberately not made in this file.
 */

/** One past the highest addressable byte in a 32-bit space. */
export const ADDRESS_SPACE_END_EXCLUSIVE = 0x1_0000_0000;
/** The highest addressable byte itself. */
export const MAX_ADDRESS = 0xffffffff;

export type ByteRange = {
  readonly start: number;
  readonly endExclusive: number;
};

export type ByteRangeRejection =
  | 'START_NOT_SAFE_INTEGER'
  | 'START_NEGATIVE'
  | 'START_ABOVE_ADDRESS_SPACE'
  | 'LENGTH_NOT_SAFE_INTEGER'
  | 'LENGTH_NOT_POSITIVE'
  | 'RANGE_OVERFLOWS_ADDRESS_SPACE';

export type ByteRangeResult =
  | {readonly ok: true; readonly range: ByteRange}
  | {readonly ok: false; readonly rejection: ByteRangeRejection};

/**
 * Builds a range from a start and a POSITIVE length. A zero-length range
 * has no `lastAddress` and no meaningful containment test, so it is
 * rejected rather than represented.
 */
export function makeRange(start: number, length: number): ByteRangeResult {
  if (!Number.isSafeInteger(start)) return {ok: false, rejection: 'START_NOT_SAFE_INTEGER'};
  if (start < 0) return {ok: false, rejection: 'START_NEGATIVE'};
  if (start > MAX_ADDRESS) return {ok: false, rejection: 'START_ABOVE_ADDRESS_SPACE'};
  if (!Number.isSafeInteger(length)) return {ok: false, rejection: 'LENGTH_NOT_SAFE_INTEGER'};
  if (length <= 0) return {ok: false, rejection: 'LENGTH_NOT_POSITIVE'};

  const endExclusive = start + length;
  if (!Number.isSafeInteger(endExclusive) || endExclusive > ADDRESS_SPACE_END_EXCLUSIVE) {
    return {ok: false, rejection: 'RANGE_OVERFLOWS_ADDRESS_SPACE'};
  }
  return {ok: true, range: {start, endExclusive}};
}

/** The highest address the range covers. Derived, never hand-written. */
export function lastAddress(range: ByteRange): number {
  return range.endExclusive - 1;
}

export function rangeLength(range: ByteRange): number {
  return range.endExclusive - range.start;
}

/** `address` is inside `[start, endExclusive)`. */
export function containsAddress(range: ByteRange, address: number): boolean {
  return address >= range.start && address < range.endExclusive;
}

/** Half-open overlap: touching ends do not overlap. */
export function rangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.endExclusive && right.start < left.endExclusive;
}

/** `inner` lies entirely within `outer`. */
export function rangeContainsRange(outer: ByteRange, inner: ByteRange): boolean {
  return inner.start >= outer.start && inner.endExclusive <= outer.endExclusive;
}
