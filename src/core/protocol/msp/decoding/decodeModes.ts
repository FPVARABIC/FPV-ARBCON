
export const MODE_RANGE_MIN = 900;
export const MODE_RANGE_MAX = 2100;
export const MODE_RANGE_STEP = 25;
export const MODE_RANGE_SLOT_BYTES = 4;
export const MODE_RANGE_EXTRA_SLOT_BYTES = 3;

export interface MspModeDefinition {
  readonly name: string;
  readonly permanentId: number;
  /** Bit position in MSP_STATUS[_EX]'s packed active-mode flags. */
  readonly flagIndex: number;
}

export interface MspModeRangeSlot {
  readonly permanentId: number;
  readonly auxChannelIndex: number;
  readonly start: number;
  readonly end: number;
  readonly logic: 0 | 1;
  readonly linkedTo: number;
  /** The stored range falls outside 900-2100us. Shown, not discarded. */
  readonly outOfRange: boolean;
}

export interface MspModesConfiguration {
  readonly definitions: readonly MspModeDefinition[];
  readonly slots: readonly MspModeRangeSlot[];
  readonly capacity: number;
  /** Permanent ids occupying a slot that this build's mode catalogue does
   * not contain - typically a newer firmware's flight mode. Reported so
   * the screen can say so, never a reason to refuse to load. */
  readonly unknownIds: readonly number[];
}

/**
 * Betaflight splits MSP_BOXNAMES on ';' and keeps whatever it gets
 * (src/js/msp/MSPHelper.js). It never rejects a name, so neither does
 * this: a byte outside printable ASCII is dropped rather than made into
 * a reason the ARM screen will not open.
 */
function decodeAsciiNames(payload: Uint8Array): readonly string[] {
  const names: string[] = [];
  let current = '';
  for (const byte of payload) {
    if (byte === 0x3b) {
      if (current.length > 0) names.push(current);
      current = '';
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) current += String.fromCharCode(byte);
  }
  if (current.length > 0) names.push(current);
  return Object.freeze(names);
}

/**
 * READS THE BOARD'S MODES; IT DOES NOT AUDIT THEM.
 *
 * This decoder had THIRTEEN rejection points - a non-printable name byte,
 * a BOXIDS/BOXNAMES count mismatch, EXTRA misalignment, an unknown mode
 * id in a slot, a logic byte that was not 0/1, a link to an id we did not
 * know, a range outside 900-2100. Any one of them threw, and this is the
 * ARM screen: the operator would have been unable to see or fix ANY mode,
 * including a perfectly good arm switch.
 *
 * The pinned Betaflight Configurator validates NOTHING here
 * (src/js/msp/MSPHelper.js, cases MSP_MODE_RANGES and
 * MSP_MODE_RANGES_EXTRA): the range count is `data.byteLength / 4`, the
 * extra count is its own leading byte, and every field is stored as read.
 *
 * That difference is not academic. Betaflight adds flight modes regularly,
 * and a firmware carrying one mode this build has never heard of would
 * have made our whole Modes screen unopenable - the exact "future board
 * must not be rejected" failure this project already fixed elsewhere.
 *
 * So: counts come from the payloads themselves, an unknown id is kept and
 * reported through `unknownIds`, a stray logic byte clamps to OR (0, the
 * value that cannot silently add an extra condition to an arm switch),
 * and an out-of-range step is preserved and flagged. Validity is enforced
 * on WRITE, which is where Betaflight enforces it too.
 */
export function decodeModesConfiguration(input: {
  readonly names: Uint8Array;
  readonly boxIds: Uint8Array;
  readonly ranges: Uint8Array;
  readonly rangesExtra: Uint8Array;
}): MspModesConfiguration {
  const names = decodeAsciiNames(input.names);
  // Pair names with ids as far as BOTH go; a mismatch is a partial
  // catalogue, not a broken screen.
  const definitionCount = Math.min(names.length, input.boxIds.length);
  const definitions = Object.freeze(
    Array.from({length: definitionCount}, (_unused, flagIndex) =>
      Object.freeze({name: names[flagIndex], permanentId: input.boxIds[flagIndex], flagIndex}),
    ),
  );

  const capacity = Math.floor(input.ranges.length / MODE_RANGE_SLOT_BYTES);
  // Betaflight trusts EXTRA's own count byte rather than cross-checking it.
  const extraDeclared = input.rangesExtra.length > 0 ? input.rangesExtra[0] : 0;

  const validIds = new Set(definitions.map(definition => definition.permanentId));
  const unknownIds = new Set<number>();
  const slots: MspModeRangeSlot[] = [];

  for (let index = 0; index < capacity; index += 1) {
    const base = index * MODE_RANGE_SLOT_BYTES;
    const extra = 1 + index * MODE_RANGE_EXTRA_SLOT_BYTES;
    const hasExtra = index < extraDeclared && extra + 2 < input.rangesExtra.length;

    const permanentId = input.ranges[base];
    const rawLogic = hasExtra ? input.rangesExtra[extra + 1] : 0;
    const linkedTo = hasExtra ? input.rangesExtra[extra + 2] : 0;
    const start = MODE_RANGE_MIN + input.ranges[base + 2] * MODE_RANGE_STEP;
    const end = MODE_RANGE_MIN + input.ranges[base + 3] * MODE_RANGE_STEP;

    // An occupied slot naming a mode this build does not know is worth
    // reporting, but it is never a reason to hide every other mode.
    if (permanentId !== 0 && !validIds.has(permanentId)) unknownIds.add(permanentId);

    slots.push(
      Object.freeze({
        permanentId,
        auxChannelIndex: input.ranges[base + 1],
        start,
        end,
        logic: (rawLogic === 1 ? 1 : 0) as 0 | 1,
        linkedTo,
        outOfRange: start > MODE_RANGE_MAX || end > MODE_RANGE_MAX,
      }),
    );
  }
  return Object.freeze({definitions, slots: Object.freeze(slots), capacity, unknownIds: Object.freeze([...unknownIds])});
}
