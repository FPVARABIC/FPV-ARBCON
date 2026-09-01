import type {MspApiVersion} from '../decoding/decodeApiVersion';
import type {MspBoardInfo} from '../decoding/decodeBoardInfo';

export type MspFcFamily = 'BETAFLIGHT' | 'INAV' | 'EMUFLIGHT' | 'UNKNOWN';

export type MspFcVariant = {
  /** Raw 4-character identifier as decoded off the wire, e.g. "BTFL". */
  identifier: string;
  knownFamily: MspFcFamily;
};

/**
 * An empty board record: every field present and blank. Used when
 * MSP_BOARD_INFO could not be obtained at all, so callers keep one shape
 * to read from and never have to branch on undefined.
 */
export const UNKNOWN_BOARD: MspBoardInfo = {
  boardIdentifier: '',
  hardwareRevision: 0,
  boardType: 0,
  targetCapabilities: 0,
  targetName: '',
  boardName: '',
  manufacturerId: '',
  signature: new Uint8Array(0),
  mcuTypeId: 0,
  trailingBytes: new Uint8Array(0),
  truncated: true,
};

export type FlightControllerIdentity = {
  apiVersion: MspApiVersion;
  firmware: MspFcVariant;
  board: MspBoardInfo;
  /**
   * WHY BOARD METADATA IS ALLOWED TO BE MISSING.
   *
   * Betaflight Configurator establishes a connection on two facts and two
   * only: MSP_API_VERSION parsed and at/above its accepted version, and
   * MSP_FC_VARIANT reading "BTFL" (src/js/serial_backend.js, onOpen). Its
   * MSP_BOARD_INFO handler - processBoardInfo() - logs the hardware name
   * and proceeds; nothing in it can abort the connection, and it is not
   * even reached on the AutoDetect path until after the variant check.
   *
   * This app used to require MSP_BOARD_INFO to arrive AND decode before it
   * would call a flight controller identified, which turns a board whose
   * metadata is slow, short or absent into "no flight controller found".
   * Board metadata is now what Betaflight treats it as: valuable, used for
   * catalogue lookup, and never a precondition for being connected. When
   * it is absent this holds the reason and `board` is UNKNOWN_BOARD.
   */
  boardInfoUnavailableReason?: string;
};

/**
 * Known raw MSP_FC_VARIANT identifiers, each verified against that
 * project's own source at the pinned commit recorded in
 * ../commands/mspCommandSources.ts (Pass 6.4a Step 0/clarification 1) -
 * not guessed:
 *  - Betaflight: "BTFL" (FC_FIRMWARE_IDENTIFIER, src/main/build/version.h,
 *    BETAFLIGHT_PINNED_COMMIT)
 *  - iNav: "INAV" (INAV_IDENTIFIER, src/main/msp/msp_protocol.h,
 *    INAV_PINNED_COMMIT)
 *  - EmuFlight: "EMUF" (BUTTERFLIGHT_IDENTIFIER, src/main/interface/
 *    msp_protocol.h, EMUFLIGHT_PINNED_COMMIT - confirmed via msp.c that
 *    this constant is what's actually assigned to flightControllerIdentifier,
 *    not dead code)
 * Anything else maps to UNKNOWN rather than being rejected - this project
 * accepts identification from any MSP-speaking firmware; it merely can't
 * name the family beyond what it recognizes. (iNav's own msp_protocol.h
 * incidentally also defines MULTIWII_IDENTIFIER "MWII", BASEFLIGHT_IDENTIFIER
 * "BAFL", CLEANFLIGHT_IDENTIFIER "CLFL", and RACEFLIGHT_IDENTIFIER "RCFL" -
 * seen during this pass's verification but deliberately not added as their
 * own MspFcFamily members, since only Betaflight/iNav/EmuFlight were asked
 * for; they fall through to UNKNOWN like any other unrecognized identifier.)
 */
export function deriveFcFamily(identifier: string): MspFcFamily {
  switch (identifier) {
    case 'BTFL':
      return 'BETAFLIGHT';
    case 'INAV':
      return 'INAV';
    case 'EMUF':
      return 'EMUFLIGHT';
    default:
      return 'UNKNOWN';
  }
}
