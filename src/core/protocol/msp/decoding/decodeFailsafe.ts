import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';
import {RECEIVER_CHANNEL_MAX_COUNT} from './decodeReceiver';

export const RX_FAILSAFE_MIN = 750;
export const RX_FAILSAFE_MAX = 2250;
export const RX_FAILSAFE_STEP = 25;
export const BUILD_OPTION_GPS = 16412;

export type FailsafeProcedure = 0 | 1 | 2;
export type FailsafeSwitchMode = 0 | 1 | 2;
export type RxFailsafeMode = 0 | 1 | 2;

export interface MspFailsafeConfiguration {
  readonly delayDeciseconds: number;
  readonly landingTimeSeconds: number;
  readonly throttle: number;
  readonly switchMode: FailsafeSwitchMode;
  readonly throttleLowDelayDeciseconds: number;
  readonly procedure: FailsafeProcedure;
}

export interface MspRxFailsafeChannel {
  readonly mode: RxFailsafeMode;
  readonly value: number;
}

export interface MspFailsafeSnapshot {
  readonly config: MspFailsafeConfiguration;
  readonly channels: readonly MspRxFailsafeChannel[];
  readonly supportsGpsRescue: boolean;
}

export function decodeFailsafeConfiguration(payload: Uint8Array): MspFailsafeConfiguration {
  if (payload.length !== 8) throw new MspPayloadReadError(`MSP_FAILSAFE_CONFIG must be exactly 8 bytes; received ${payload.length}.`);
  const reader = new MspPayloadReader(payload);
  const delayDeciseconds = reader.readU8();
  const landingTimeSeconds = reader.readU8();
  const throttle = reader.readU16LE();
  const switchMode = reader.readU8();
  const throttleLowDelayDeciseconds = reader.readU16LE();
  const procedure = reader.readU8();
  if (switchMode > 2) throw new MspPayloadReadError(`Unknown failsafe switch mode ${switchMode}.`);
  if (procedure > 2) throw new MspPayloadReadError(`Unknown failsafe procedure ${procedure}.`);
  return Object.freeze({
    delayDeciseconds,
    landingTimeSeconds,
    throttle,
    switchMode: switchMode as FailsafeSwitchMode,
    throttleLowDelayDeciseconds,
    procedure: procedure as FailsafeProcedure,
  });
}

export function decodeRxFailsafeConfiguration(payload: Uint8Array): readonly MspRxFailsafeChannel[] {
  if (payload.length === 0 || payload.length % 3 !== 0) throw new MspPayloadReadError('MSP_RXFAIL_CONFIG must contain complete three-byte channel records.');
  const count = payload.length / 3;
  if (count > RECEIVER_CHANNEL_MAX_COUNT) throw new MspPayloadReadError(`MSP_RXFAIL_CONFIG channel count ${count} exceeds ${RECEIVER_CHANNEL_MAX_COUNT}.`);
  const reader = new MspPayloadReader(payload);
  const channels: MspRxFailsafeChannel[] = [];
  for (let index = 0; index < count; index += 1) {
    const mode = reader.readU8();
    const value = reader.readU16LE();
    if (mode > 2) throw new MspPayloadReadError(`RX failsafe channel ${index + 1} has unknown mode ${mode}.`);
    if (value < RX_FAILSAFE_MIN || value > RX_FAILSAFE_MAX || (value - RX_FAILSAFE_MIN) % RX_FAILSAFE_STEP !== 0) {
      throw new MspPayloadReadError(`RX failsafe channel ${index + 1} has invalid value ${value}.`);
    }
    channels.push(Object.freeze({mode: mode as RxFailsafeMode, value}));
  }
  return Object.freeze(channels);
}
