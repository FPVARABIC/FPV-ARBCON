import {MspPayloadReader} from './MspPayloadReader';

/** Betaflight API 1.47 rx.h: MAX_SUPPORTED_RC_CHANNEL_COUNT. */
export const RECEIVER_CHANNEL_MAX_COUNT = 18;

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
  // Betaflight is `FC.RC.active_channels = data.byteLength / 2` with no cap
  // and no evenness check (src/js/msp/MSPHelper.js case MSP_RC). These are the
  // live stick bars: a firmware compiled for more channels than this build
  // knows about, or one trailing byte, must not blank the receiver display -
  // and it is exactly the display an operator uses to diagnose a bad link.
  // The cap is kept as a CLAMP so a long payload cannot make us allocate
  // without bound.
  const count = Math.min(Math.floor(payload.length / 2), RECEIVER_CHANNEL_MAX_COUNT);
  const reader = new MspPayloadReader(payload, {lenient: true});
  const channels: number[] = [];
  for (let index = 0; index < count; index += 1) channels.push(reader.readU16LE());
  return Object.freeze({channels: Object.freeze(channels)});
}

export function decodeReceiverMap(payload: Uint8Array): readonly number[] {
  // Betaflight reads this positionally with no length guard at all
  // (src/js/msp/MSPHelper.js); a firmware that appends or omits a
  // trailing field must not close the screen that shows it.
  return Object.freeze(Array.from(payload));
}

export function decodeRssiConfig(payload: Uint8Array): number {
  // Betaflight reads this positionally with no length guard at all
  // (src/js/msp/MSPHelper.js); a firmware that appends or omits a
  // trailing field must not close the screen that shows it.
  return payload.length > 0 ? payload[0] : 0;
}

export function decodeReceiverDeadband(payload: Uint8Array): MspReceiverDeadband {
  // Betaflight reads this positionally with no length guard at all
  // (src/js/msp/MSPHelper.js); a firmware that appends or omits a
  // trailing field must not close the screen that shows it.
  const reader = new MspPayloadReader(payload, {lenient: true});
  return Object.freeze({
    deadband: reader.readU8(),
    yawDeadband: reader.readU8(),
    altitudeHoldDeadband: reader.readU8(),
    throttle3dDeadband: reader.readU16LE(),
  });
}
