import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export const RECEIVER_CHANNEL_MAX_COUNT = 32;

export interface MspRcChannels {
  readonly channels: readonly number[];
}

export interface MspReceiverDeadband {
  readonly deadband: number;
  readonly yawDeadband: number;
  readonly altitudeHoldDeadband: number;
  readonly throttle3dDeadband: number;
}

export function decodeRcChannels(payload: Uint8Array): MspRcChannels {
  if (payload.length % 2 !== 0) {
    throw new MspPayloadReadError('MSP_RC payload must contain complete u16 channels.');
  }
  const count = payload.length / 2;
  if (count > RECEIVER_CHANNEL_MAX_COUNT) {
    throw new MspPayloadReadError(`MSP_RC returned ${count} channels; maximum is ${RECEIVER_CHANNEL_MAX_COUNT}.`);
  }
  const reader = new MspPayloadReader(payload);
  const channels: number[] = [];
  while (reader.remaining() > 0) channels.push(reader.readU16LE());
  return Object.freeze({channels: Object.freeze(channels)});
}

export function decodeReceiverMap(payload: Uint8Array): readonly number[] {
  if (payload.length !== 8) {
    throw new MspPayloadReadError(`MSP_RX_MAP requires 8 bytes; received ${payload.length}.`);
  }
  return Object.freeze(Array.from(payload));
}

export function decodeRssiConfig(payload: Uint8Array): number {
  if (payload.length < 1) throw new MspPayloadReadError('MSP_RSSI_CONFIG is empty.');
  return payload[0];
}

export function decodeReceiverDeadband(payload: Uint8Array): MspReceiverDeadband {
  if (payload.length < 5) {
    throw new MspPayloadReadError(`MSP_RC_DEADBAND requires 5 bytes; received ${payload.length}.`);
  }
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    deadband: reader.readU8(),
    yawDeadband: reader.readU8(),
    altitudeHoldDeadband: reader.readU8(),
    throttle3dDeadband: reader.readU16LE(),
  });
}
