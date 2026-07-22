import {MspPayloadReader} from './MspPayloadReader';

/**
 * src/main/msp/msp.c, `case MSP_API_VERSION:` @ BETAFLIGHT_PINNED_COMMIT
 * (see ../commands/mspCommandSources.ts) - verbatim:
 *   sbufWriteU8(dst, MSP_PROTOCOL_VERSION);
 *   sbufWriteU8(dst, API_VERSION_MAJOR);
 *   sbufWriteU8(dst, API_VERSION_MINOR);
 * Unconditionally 3 bytes, never version-gated.
 */
export interface MspApiVersion {
  mspProtocolVersion: number;
  apiVersionMajor: number;
  apiVersionMinor: number;
}

export function decodeApiVersion(payload: Uint8Array): MspApiVersion {
  const reader = new MspPayloadReader(payload);
  return {
    mspProtocolVersion: reader.readU8(),
    apiVersionMajor: reader.readU8(),
    apiVersionMinor: reader.readU8(),
  };
}
