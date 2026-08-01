import { MspPayloadReader } from './MspPayloadReader';

export interface MspBuildOptions {
  readonly optionIds: ReadonlySet<number>;
  readonly headerBytes: Uint8Array;
}

/** Betaflight MSP_BUILD_INFO: 26-byte fixed header, then u16 IDs and zero. */
export function decodeBuildOptions(payload: Uint8Array): MspBuildOptions {
  const reader = new MspPayloadReader(payload);
  const headerBytes = reader.readBytes(26);
  const ids = new Set<number>();
  while (reader.remaining() >= 2) {
    const id = reader.readU16LE();
    if (id === 0) {
      break;
    }
    ids.add(id);
  }
  return Object.freeze({ optionIds: ids, headerBytes });
}
