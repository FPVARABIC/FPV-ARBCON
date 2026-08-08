import type {MspReceiverDeadband} from '../decoding/decodeReceiver';
import type {MspRxConfig} from '../decoding/decodeRxConfig';
import type {ReceiverConfigurationDraft, ReceiverConfigurationSnapshot} from '../../../state/receiverConfigurationModel';
import {receiverMapFromText, validateReceiverDraft} from '../../../state/receiverConfigurationModel';

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

export function encodeReceiverMap(text: string): Uint8Array {
  const map = receiverMapFromText(text);
  if (map === undefined) throw new RangeError('Invalid receiver channel map.');
  return Uint8Array.from(map);
}

export function encodeReceiverDeadband(value: MspReceiverDeadband): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = value.deadband;
  bytes[1] = value.yawDeadband;
  bytes[2] = value.altitudeHoldDeadband;
  writeU16(bytes, 3, value.throttle3dDeadband);
  return bytes;
}

export function encodeReceiverConfig(original: MspRxConfig, draft: ReceiverConfigurationDraft): Uint8Array {
  if (original.raw.length < 39) throw new RangeError('MSP_RX_CONFIG API 1.47 payload is truncated.');
  if (validateReceiverDraft(draft).length > 0) throw new RangeError('Invalid receiver configuration draft.');
  const bytes = original.raw.slice();
  writeU16(bytes, 1, draft.stickMax);
  writeU16(bytes, 3, draft.stickCenter);
  writeU16(bytes, 5, draft.stickMin);
  bytes[25] = draft.setpointCutoff;
  bytes[26] = draft.throttleCutoff;
  bytes[27] = draft.throttleAutoFactor;
  bytes[30] = draft.setpointAutoFactor;
  bytes[31] = draft.smoothingEnabled ? 1 : 0;
  return bytes;
}

export type ReceiverWriteGroup = 'RX_MAP' | 'RSSI' | 'DEADBAND' | 'RX_CONFIG';
export interface EncodedReceiverWrite { readonly group: ReceiverWriteGroup; readonly payload: Uint8Array }

export function encodeChangedReceiverConfiguration(original: ReceiverConfigurationSnapshot, draft: ReceiverConfigurationDraft): readonly EncodedReceiverWrite[] {
  if (validateReceiverDraft(draft).length > 0) throw new RangeError('Invalid receiver configuration draft.');
  const writes: EncodedReceiverWrite[] = [];
  const map = encodeReceiverMap(draft.channelMapText);
  if (map.some((v, i) => v !== original.channelMap[i])) writes.push({group: 'RX_MAP', payload: map});
  if (draft.rssiChannel !== original.rssiChannel) writes.push({group: 'RSSI', payload: Uint8Array.from([draft.rssiChannel])});
  if (draft.deadband !== original.deadband.deadband || draft.yawDeadband !== original.deadband.yawDeadband || draft.throttle3dDeadband !== original.deadband.throttle3dDeadband) {
    writes.push({group: 'DEADBAND', payload: encodeReceiverDeadband({...original.deadband, deadband: draft.deadband, yawDeadband: draft.yawDeadband, throttle3dDeadband: draft.throttle3dDeadband})});
  }
  const rx = encodeReceiverConfig(original.rx, draft);
  if (rx.some((v, i) => v !== original.rx.raw[i])) writes.push({group: 'RX_CONFIG', payload: rx});
  return Object.freeze(writes.map(write => Object.freeze(write)));
}
