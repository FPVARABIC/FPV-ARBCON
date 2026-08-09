import {decodeRxConfig} from '../protocol/msp/decoding/decodeRxConfig';
import {encodeChangedReceiverConfiguration} from '../protocol/msp/encoding/encodeReceiver';
import {createReceiverConfigurationDraft, receiverMapFromText, receiverMapToText, validateReceiverDraft, type ReceiverConfigurationSnapshot} from './receiverConfigurationModel';

function snapshot(): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39); const view = new DataView(bytes.buffer);
  bytes[0] = 9; view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true); view.setUint16(8, 885, true); view.setUint16(10, 2115, true); bytes[27] = 30; bytes[30] = 30; bytes[31] = 1;
  return {rx: decodeRxConfig(bytes), channelMap: [0, 1, 3, 2, 4, 5, 6, 7], rssiChannel: 0, deadband: {deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 5}};
}

describe('receiver configuration model', () => {
  it('round-trips AETR and TAER without swapping logical positions', () => {
    expect(receiverMapFromText('AETR1234')).toEqual([0, 1, 3, 2, 4, 5, 6, 7]);
    expect(receiverMapFromText('TAER1234')).toEqual([1, 2, 3, 0, 4, 5, 6, 7]);
    expect(receiverMapToText([1, 2, 3, 0, 4, 5, 6, 7])).toBe('TAER1234');
    expect(receiverMapFromText('AAER1234')).toBeUndefined();
  });
  it('validates Betaflight field limits', () => {
    const draft = createReceiverConfigurationDraft(snapshot());
    expect(validateReceiverDraft(draft)).toEqual([]);
    expect(validateReceiverDraft({...draft, stickCenter: 1700})).toContain('STICK_CENTER_INVALID');
    expect(validateReceiverDraft({...draft, setpointAutoFactor: 251})).toContain('SMOOTHING_INVALID');
  });
  it('accepts only disabled or Betaflight AUX channels for RSSI', () => {
    const draft = createReceiverConfigurationDraft(snapshot());
    expect(validateReceiverDraft({...draft, rssiChannel: 0})).not.toContain('RSSI_CHANNEL_INVALID');
    expect(validateReceiverDraft({...draft, rssiChannel: 5})).not.toContain('RSSI_CHANNEL_INVALID');
    expect(validateReceiverDraft({...draft, rssiChannel: 18})).not.toContain('RSSI_CHANNEL_INVALID');
    expect(validateReceiverDraft({...draft, rssiChannel: 4})).toContain('RSSI_CHANNEL_INVALID');
    expect(validateReceiverDraft({...draft, rssiChannel: 19})).toContain('RSSI_CHANNEL_INVALID');
  });
  it('writes changed groups only and preserves unowned RX bytes', () => {
    const original = snapshot(); const draft = {...createReceiverConfigurationDraft(original), stickMin: 1090, deadband: 4};
    const writes = encodeChangedReceiverConfiguration(original, draft);
    expect(writes.map(write => write.group)).toEqual(['DEADBAND', 'RX_CONFIG']);
    const rx = writes.find(write => write.group === 'RX_CONFIG')!.payload;
    expect(new DataView(rx.buffer).getUint16(5, true)).toBe(1090);
    expect(rx[0]).toBe(original.rx.raw[0]); expect(rx[38]).toBe(original.rx.raw[38]);
  });
});
