import {MspPayloadReader} from './MspPayloadReader';

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT (see
 * ../commands/mspCommandSources.ts): `#define FLIGHT_CONTROLLER_IDENTIFIER_LENGTH 4`. */
const FLIGHT_CONTROLLER_IDENTIFIER_LENGTH = 4;

/**
 * src/main/msp/msp.c, `case MSP_FC_VARIANT:` @ BETAFLIGHT_PINNED_COMMIT -
 * verbatim: `sbufWriteData(dst, flightControllerIdentifier,
 * FLIGHT_CONTROLLER_IDENTIFIER_LENGTH);` - raw 4-character ASCII
 * identifier, unconditionally, never version-gated.
 *
 * Named MspFcVariantRaw (not MspFcVariant) deliberately: this is the
 * as-decoded-off-the-wire result, before knownFamily derivation - the
 * enriched, public-facing MspFcVariant type (identifier + knownFamily)
 * lives in ../identification/mspIdentificationTypes.ts.
 */
export interface MspFcVariantRaw {
  identifier: string;
}

export function decodeFcVariant(payload: Uint8Array): MspFcVariantRaw {
  const reader = new MspPayloadReader(payload);
  return {identifier: reader.readFixedAscii(FLIGHT_CONTROLLER_IDENTIFIER_LENGTH)};
}
