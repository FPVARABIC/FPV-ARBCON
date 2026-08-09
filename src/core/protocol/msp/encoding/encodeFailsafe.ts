import type {MspFailsafeSnapshot} from '../decoding/decodeFailsafe';
import {createFailsafeConfigurationDraft, failsafeDraftsEqual, validateFailsafeDraft, type FailsafeConfigurationDraft} from '../../../state/failsafeConfigurationModel';

export type FailsafeWriteGroup = 'FAILSAFE_CONFIG' | 'RXFAIL_CONFIG';
export interface EncodedFailsafeWrite {readonly group: FailsafeWriteGroup; readonly index?: number; readonly payload: Uint8Array}

export function encodeChangedFailsafeConfiguration(snapshot: MspFailsafeSnapshot, draft: FailsafeConfigurationDraft): readonly EncodedFailsafeWrite[] {
  if (validateFailsafeDraft(draft, snapshot).length > 0) throw new RangeError('Invalid failsafe configuration draft.');
  if (failsafeDraftsEqual(createFailsafeConfigurationDraft(snapshot), draft)) return Object.freeze([]);
  const writes: EncodedFailsafeWrite[] = [];
  const original = createFailsafeConfigurationDraft(snapshot);
  const mainChanged = original.delayDeciseconds !== draft.delayDeciseconds || original.landingTimeSeconds !== draft.landingTimeSeconds || original.throttle !== draft.throttle || original.switchMode !== draft.switchMode || original.throttleLowDelayDeciseconds !== draft.throttleLowDelayDeciseconds || original.procedure !== draft.procedure;
  if (mainChanged) {
    const payload = new Uint8Array(8); const view = new DataView(payload.buffer);
    payload[0] = draft.delayDeciseconds; payload[1] = draft.landingTimeSeconds; view.setUint16(2, draft.throttle, true); payload[4] = draft.switchMode; view.setUint16(5, draft.throttleLowDelayDeciseconds, true); payload[7] = draft.procedure;
    writes.push(Object.freeze({group: 'FAILSAFE_CONFIG', payload}));
  }
  draft.channels.forEach((channel, index) => {
    const before = original.channels[index];
    if (before.mode === channel.mode && before.value === channel.value) return;
    const payload = new Uint8Array(4); const view = new DataView(payload.buffer);
    payload[0] = index; payload[1] = channel.mode; view.setUint16(2, channel.value, true);
    writes.push(Object.freeze({group: 'RXFAIL_CONFIG', index, payload}));
  });
  return Object.freeze(writes);
}
