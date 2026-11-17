import {
  MODE_RANGE_MAX,
  MODE_RANGE_MIN,
  MODE_RANGE_STEP,
  type MspModeDefinition,
  type MspModesConfiguration,
} from '../protocol/msp/decoding/decodeModes';
import {RECEIVER_CHANNEL_MAX_COUNT} from '../protocol/msp/decoding/decodeReceiver';

export const MODES_AUX_CHANNEL_COUNT = RECEIVER_CHANNEL_MAX_COUNT - 4;

export type ModeConditionDraft =
  | {readonly kind: 'RANGE'; readonly permanentId: number; readonly auxChannelIndex: number; readonly start: number; readonly end: number; readonly logic: 0 | 1}
  | {readonly kind: 'LINK'; readonly permanentId: number; readonly linkedTo: number; readonly logic: 0 | 1};

export interface ModesConfigurationDraft {
  readonly conditions: readonly ModeConditionDraft[];
}

export type ModesValidationCode =
  | 'TOO_MANY_CONDITIONS'
  | 'UNKNOWN_MODE'
  | 'AUX_CHANNEL_INVALID'
  | 'RANGE_INVALID'
  | 'LOGIC_INVALID'
  | 'LINK_INVALID'
  | 'ARM_LINK_FORBIDDEN';

export function createModesConfigurationDraft(snapshot: MspModesConfiguration): ModesConfigurationDraft {
  const conditions: ModeConditionDraft[] = [];
  for (const slot of snapshot.slots) {
    if (slot.linkedTo !== 0) {
      conditions.push(Object.freeze({kind: 'LINK', permanentId: slot.permanentId, linkedTo: slot.linkedTo, logic: slot.logic}));
    } else if (slot.start < slot.end) {
      conditions.push(Object.freeze({kind: 'RANGE', permanentId: slot.permanentId, auxChannelIndex: slot.auxChannelIndex, start: slot.start, end: slot.end, logic: slot.logic}));
    }
  }
  return Object.freeze({conditions: Object.freeze(conditions)});
}

export function modesDraftsEqual(a: ModesConfigurationDraft, b: ModesConfigurationDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function modesSnapshotsEqual(a: MspModesConfiguration, b: MspModesConfiguration): boolean {
  return a.capacity === b.capacity &&
    a.definitions.length === b.definitions.length &&
    a.definitions.every((value, index) => value.name === b.definitions[index].name && value.permanentId === b.definitions[index].permanentId) &&
    a.slots.length === b.slots.length &&
    a.slots.every((value, index) => JSON.stringify(value) === JSON.stringify(b.slots[index]));
}

export function validateModesDraft(draft: ModesConfigurationDraft, snapshot: MspModesConfiguration): readonly ModesValidationCode[] {
  const issues: ModesValidationCode[] = [];
  const validIds = new Set(snapshot.definitions.map(definition => definition.permanentId));
  if (draft.conditions.length > snapshot.capacity) issues.push('TOO_MANY_CONDITIONS');
  for (const condition of draft.conditions) {
    if (!validIds.has(condition.permanentId)) issues.push('UNKNOWN_MODE');
    if (condition.logic !== 0 && condition.logic !== 1) issues.push('LOGIC_INVALID');
    if (condition.kind === 'RANGE') {
      if (!Number.isInteger(condition.auxChannelIndex) || condition.auxChannelIndex < 0 || condition.auxChannelIndex >= MODES_AUX_CHANNEL_COUNT) issues.push('AUX_CHANNEL_INVALID');
      if (!Number.isInteger(condition.start) || !Number.isInteger(condition.end) || condition.start < MODE_RANGE_MIN || condition.end > MODE_RANGE_MAX || condition.start >= condition.end || (condition.start - MODE_RANGE_MIN) % MODE_RANGE_STEP !== 0 || (condition.end - MODE_RANGE_MIN) % MODE_RANGE_STEP !== 0) issues.push('RANGE_INVALID');
    } else {
      if (condition.permanentId === 0) issues.push('ARM_LINK_FORBIDDEN');
      if (condition.linkedTo === 0 || condition.linkedTo === condition.permanentId || !validIds.has(condition.linkedTo)) issues.push('LINK_INVALID');
    }
  }
  return Object.freeze([...new Set(issues)]);
}

export function conditionsForMode(draft: ModesConfigurationDraft, permanentId: number): readonly ModeConditionDraft[] {
  return draft.conditions.filter(condition => condition.permanentId === permanentId);
}

export function modeIsActive(definition: MspModeDefinition, low32: number, extra: readonly number[] | undefined): boolean {
  if (definition.flagIndex < 32) return Math.floor(low32 / (2 ** definition.flagIndex)) % 2 === 1;
  const offset = definition.flagIndex - 32;
  const byte = extra?.[Math.floor(offset / 8)] ?? 0;
  return Math.floor(byte / (2 ** (offset % 8))) % 2 === 1;
}

const ARABIC_MODE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ARM: "Armstatus", ANGLE: "Angle-stabilisatie", HORIZON: "Horizon", 'AIR MODE': "Air Mode", BEEPER: "Zoemer",
  'FLIP OVER AFTER CRASH': "Omklappen na een crash", 'GPS RESCUE': "GPS Rescue", FAILSAFE: 'Failsafe',
  'BLACKBOX ERASE': "Blackbox wissen", 'CAMERA CONTROL 1': "Camerabediening 1", 'CAMERA CONTROL 2': "Camerabediening 2",
  'CAMERA CONTROL 3': "Camerabediening 3", PREARM: "Prearm", PARALYZE: "Volledig uitschakelen",
});

export function modeArabicName(name: string): string {
  return ARABIC_MODE_NAMES[name.toUpperCase()] ?? name;
}
