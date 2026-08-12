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
  // RECEIVER P4. Byte 0 is serialrx_provider (msp.c MSP_SET_RX_CONFIG,
  // first field). Patched into a CLONE of the payload the flight
  // controller just sent, exactly like every other field here, so the
  // ~25 bytes this screen does not own - rx_min/max_usec, the SPI
  // protocol/id/channel-count block, the USB HID type owned by General
  // Configuration, the ExpressLRS SPI UID and modelId - survive
  // bit-for-bit. A synthetic payload would silently reset all of them.
  bytes[0] = draft.serialRxProvider;
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

/**
 * RECEIVER P4 adds 'FEATURE'. It is not produced by
 * encodeChangedReceiverConfiguration - the feature mask is not part of
 * the Receiver configuration snapshot and must be read fresh inside the
 * save transaction - but it is a stage a save can be interrupted at, so
 * it belongs in the same vocabulary the outcome types report.
 */
export type ReceiverWriteGroup = 'RX_MAP' | 'RSSI' | 'DEADBAND' | 'RX_CONFIG' | 'FEATURE';
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
