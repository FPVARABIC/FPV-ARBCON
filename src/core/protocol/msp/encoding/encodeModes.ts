import {MODE_RANGE_MIN, MODE_RANGE_STEP, type MspModesConfiguration} from '../decoding/decodeModes';
import {createModesConfigurationDraft, modesDraftsEqual, validateModesDraft, type ModesConfigurationDraft} from '../../../state/modesConfigurationModel';

export interface EncodedModeRangeWrite {
  readonly index: number;
  readonly payload: Uint8Array;
}

export function encodeModeRangeWrites(snapshot: MspModesConfiguration, draft: ModesConfigurationDraft): readonly EncodedModeRangeWrite[] {
  if (validateModesDraft(draft, snapshot).length > 0) throw new RangeError('Invalid Modes configuration draft.');
  if (modesDraftsEqual(createModesConfigurationDraft(snapshot), draft)) return Object.freeze([]);
  const writes: EncodedModeRangeWrite[] = [];
  for (let index = 0; index < snapshot.capacity; index += 1) {
    const condition = draft.conditions[index];
    const bytes = new Uint8Array(7);
    bytes[0] = index;
    if (condition === undefined) {
      bytes[1] = 0;
    } else if (condition.kind === 'RANGE') {
      bytes[1] = condition.permanentId;
      bytes[2] = condition.auxChannelIndex;
      bytes[3] = (condition.start - MODE_RANGE_MIN) / MODE_RANGE_STEP;
      bytes[4] = (condition.end - MODE_RANGE_MIN) / MODE_RANGE_STEP;
      bytes[5] = condition.logic;
    } else {
      bytes[1] = condition.permanentId;
      bytes[5] = condition.logic;
      bytes[6] = condition.linkedTo;
    }
    writes.push(Object.freeze({index, payload: bytes}));
  }
  return Object.freeze(writes);
}
