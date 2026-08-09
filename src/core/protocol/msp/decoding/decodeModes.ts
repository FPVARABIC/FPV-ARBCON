import {MspPayloadReadError} from './MspPayloadReader';

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
}

export interface MspModesConfiguration {
  readonly definitions: readonly MspModeDefinition[];
  readonly slots: readonly MspModeRangeSlot[];
  readonly capacity: number;
}

function decodeAsciiNames(payload: Uint8Array): readonly string[] {
  const names: string[] = [];
  let current = '';
  for (const byte of payload) {
    if (byte === 0x3b) {
      if (current.length === 0) throw new MspPayloadReadError('MSP_BOXNAMES contains an empty mode name.');
      names.push(current);
      current = '';
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) throw new MspPayloadReadError('MSP_BOXNAMES must contain printable ASCII names separated by semicolons.');
    current += String.fromCharCode(byte);
  }
  if (current.length > 0) names.push(current);
  if (names.length === 0) throw new MspPayloadReadError('MSP_BOXNAMES did not contain any modes.');
  return Object.freeze(names);
}

export function decodeModesConfiguration(input: {
  readonly names: Uint8Array;
  readonly boxIds: Uint8Array;
  readonly ranges: Uint8Array;
  readonly rangesExtra: Uint8Array;
}): MspModesConfiguration {
  const names = decodeAsciiNames(input.names);
  if (input.boxIds.length !== names.length) {
    throw new MspPayloadReadError(`MSP_BOXIDS count ${input.boxIds.length} does not match MSP_BOXNAMES count ${names.length}.`);
  }
  if (new Set(input.boxIds).size !== input.boxIds.length) {
    throw new MspPayloadReadError('MSP_BOXIDS contains duplicate permanent IDs.');
  }
  if (input.ranges.length === 0 || input.ranges.length % MODE_RANGE_SLOT_BYTES !== 0) {
    throw new MspPayloadReadError('MSP_MODE_RANGES must contain complete four-byte slots.');
  }
  if (input.rangesExtra.length < 1) {
    throw new MspPayloadReadError('MSP_MODE_RANGES_EXTRA is missing its slot count.');
  }
  const capacity = input.ranges.length / MODE_RANGE_SLOT_BYTES;
  const extraCount = input.rangesExtra[0];
  if (extraCount !== capacity || input.rangesExtra.length !== 1 + extraCount * MODE_RANGE_EXTRA_SLOT_BYTES) {
    throw new MspPayloadReadError('MSP_MODE_RANGES_EXTRA does not align with MSP_MODE_RANGES.');
  }

  const definitions = Object.freeze(names.map((name, flagIndex) => Object.freeze({
    name,
    permanentId: input.boxIds[flagIndex],
    flagIndex,
  })));
  const validIds = new Set(definitions.map(definition => definition.permanentId));
  const slots: MspModeRangeSlot[] = [];
  for (let index = 0; index < capacity; index += 1) {
    const base = index * MODE_RANGE_SLOT_BYTES;
    const extra = 1 + index * MODE_RANGE_EXTRA_SLOT_BYTES;
    const permanentId = input.ranges[base];
    const extraPermanentId = input.rangesExtra[extra];
    const startStep = input.ranges[base + 2];
    const endStep = input.ranges[base + 3];
    const logic = input.rangesExtra[extra + 1];
    const linkedTo = input.rangesExtra[extra + 2];
    if (permanentId !== extraPermanentId) throw new MspPayloadReadError(`Mode range slot ${index} has mismatched permanent IDs.`);
    if (!validIds.has(permanentId)) throw new MspPayloadReadError(`Mode range slot ${index} references unknown mode ID ${permanentId}.`);
    if (logic !== 0 && logic !== 1) throw new MspPayloadReadError(`Mode range slot ${index} has invalid logic ${logic}.`);
    if (linkedTo !== 0 && !validIds.has(linkedTo)) throw new MspPayloadReadError(`Mode range slot ${index} links to unknown mode ID ${linkedTo}.`);
    const start = MODE_RANGE_MIN + startStep * MODE_RANGE_STEP;
    const end = MODE_RANGE_MIN + endStep * MODE_RANGE_STEP;
    if (start > MODE_RANGE_MAX || end > MODE_RANGE_MAX) throw new MspPayloadReadError(`Mode range slot ${index} is outside 900-2100.`);
    slots.push(Object.freeze({
      permanentId,
      auxChannelIndex: input.ranges[base + 1],
      start,
      end,
      logic: logic as 0 | 1,
      linkedTo,
    }));
  }
  return Object.freeze({definitions, slots: Object.freeze(slots), capacity});
}
