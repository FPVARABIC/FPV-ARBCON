/* eslint-disable no-bitwise -- serialising the documented MSP bit fields. */
import type {MspOsdSnapshot} from '../decoding/decodeOsdConfiguration';
import {createOsdConfigurationDraft, osdDraftsEqual, validateOsdDraft, type OsdConfigurationDraft} from '../../../state/osdConfigurationModel';

export type OsdWriteGroup = 'GENERAL' | 'ELEMENT' | 'STATISTIC' | 'TIMER';
export interface EncodedOsdWrite {readonly group: OsdWriteGroup; readonly index?: number; readonly payload: Uint8Array}

export function encodeChangedOsdConfiguration(snapshot: MspOsdSnapshot, draft: OsdConfigurationDraft): readonly EncodedOsdWrite[] {
  if (validateOsdDraft(draft, snapshot).length > 0) throw new RangeError('Invalid OSD configuration draft.');
  const original = createOsdConfigurationDraft(snapshot);
  if (osdDraftsEqual(original, draft)) return Object.freeze([]);
  const writes: EncodedOsdWrite[] = [];
  const generalKeys: readonly (keyof OsdConfigurationDraft)[] = ['videoSystem', 'units', 'rssiAlarmPercent', 'capacityAlarmMah', 'altitudeAlarm', 'enabledWarnings', 'selectedProfile', 'overlayRadioMode', 'cameraFrameWidth', 'cameraFrameHeight', 'linkQualityAlarmPercent', 'rssiDbmAlarm'];
  if (generalKeys.some(key => original[key] !== draft[key])) {
    const payload = new Uint8Array(24); const view = new DataView(payload.buffer);
    payload[0] = 0xff; payload[1] = draft.videoSystem; payload[2] = draft.units; payload[3] = draft.rssiAlarmPercent;
    view.setUint16(4, draft.capacityAlarmMah, true); view.setUint16(6, 0, true); view.setUint16(8, draft.altitudeAlarm, true);
    view.setUint16(10, draft.enabledWarnings & 0xffff, true); view.setUint32(12, draft.enabledWarnings >>> 0, true);
    payload[16] = draft.selectedProfile; payload[17] = draft.overlayRadioMode; payload[18] = draft.cameraFrameWidth; payload[19] = draft.cameraFrameHeight;
    view.setUint16(20, draft.linkQualityAlarmPercent, true); view.setInt16(22, draft.rssiDbmAlarm, true);
    writes.push(Object.freeze({group: 'GENERAL', payload}));
  }
  draft.elementPositions.forEach((value, index) => {if (value === original.elementPositions[index]) return; const payload = new Uint8Array(4); const view = new DataView(payload.buffer); payload[0] = index; view.setUint16(1, value, true); payload[3] = 1; writes.push(Object.freeze({group: 'ELEMENT', index, payload}));});
  draft.statistics.forEach((enabled, index) => {if (enabled === original.statistics[index]) return; writes.push(Object.freeze({group: 'STATISTIC', index, payload: Uint8Array.from([index, enabled ? 1 : 0, 0, 0])}));});
  draft.timers.forEach((value, index) => {if (value === original.timers[index]) return; const payload = new Uint8Array(4); const view = new DataView(payload.buffer); payload[0] = 0xfe; payload[1] = index; view.setUint16(2, value, true); writes.push(Object.freeze({group: 'TIMER', index, payload}));});
  return Object.freeze(writes);
}
