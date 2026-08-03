import { MspPayloadReader } from './MspPayloadReader';

export interface MspGpsConfiguration {
  readonly provider: number;
  readonly sbasMode: number;
  readonly autoConfig: boolean;
  readonly autoBaud: boolean;
  readonly homePointOnce: boolean;
  readonly useGalileo: boolean;
}

export function decodeGpsConfiguration(
  payload: Uint8Array,
): MspGpsConfiguration {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    provider: reader.readU8(),
    sbasMode: reader.readU8(),
    autoConfig: reader.readU8() !== 0,
    autoBaud: reader.readU8() !== 0,
    homePointOnce: reader.readU8() !== 0,
    useGalileo: reader.readU8() !== 0,
  });
}
