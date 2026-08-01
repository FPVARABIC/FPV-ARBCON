import { MspPayloadReader } from './MspPayloadReader';

export function decodeSerialRxProvider(payload: Uint8Array): number {
  return new MspPayloadReader(payload).readU8();
}
