export type {
  MspWireFormat,
  MspProtocolVersion,
  MspDirection,
  MspFrame,
  MspDiagnostic,
} from './mspTypes';
export {
  MSP_V2_FRAME_ID,
  MSP_MAX_PAYLOAD_BYTES_DEFAULT,
  MSP_PROTOCOL_SIZE_FIELD_CEILING,
  MSP_PARTIAL_FRAME_TIMEOUT_MS_DEFAULT,
} from './mspTypes';

export { MSP_DIAGNOSTIC_CODES } from './mspErrors';
export type { MspDiagnosticCode, MspDiagnosticDetailMap, MspDiagnosticDetail } from './mspErrors';

export { xorChecksumStep, xorChecksum, crc8DvbS2Step, crc8DvbS2 } from './mspChecksum';

export { encode } from './mspEncoder';
export type { MspEncodeOptions } from './mspEncoder';

export { createMspStreamParser } from './mspStreamParser';
export type { MspStreamParser, MspStreamParserOptions, MspIngestEvent, MspIngestResult } from './mspStreamParser';

export type {
  MspTransport,
  MspTransportError,
  MspTransportSessionDetachedEvent,
  MspTransportUnsubscribe,
} from './mspTransport';

export { MSP_CLIENT_ERROR_CODES } from './mspClientErrorCodes';
export type { MspClientErrorCode } from './mspClientErrorCodes';

export {
  MspClient,
  MspClientError,
  MSP_CLIENT_MAX_PENDING_REQUESTS_DEFAULT,
  MSP_RESPONSE_TIMEOUT_MILLIS,
} from './mspClient';
export type {
  MspClientState,
  MspRequestPhase,
  MspRequestOptions,
  MspClientOptions,
  MspClientDiagnosticEvent,
} from './mspClient';

export {MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from './msp';
export {
  BETAFLIGHT_SOURCE_REPO,
  BETAFLIGHT_PINNED_COMMIT,
  INAV_SOURCE_REPO,
  INAV_PINNED_COMMIT,
  EMUFLIGHT_SOURCE_REPO,
  EMUFLIGHT_PINNED_COMMIT,
} from './msp';
export {MspPayloadReader, MspPayloadReadError} from './msp';
export {decodeApiVersion, decodeFcVariant, decodeBoardInfo} from './msp';
export type {MspApiVersion, MspFcVariantRaw, MspBoardInfo} from './msp';
export {
  checkMspCompatibility,
  MSP_MIN_REQUIRED_API_VERSION_MAJOR,
  MSP_MIN_REQUIRED_API_VERSION_MINOR,
} from './msp';
export type {MspCompatibilityResult} from './msp';
export {deriveFcFamily, MspIdentificationService, MspIncompatibleFirmwareError} from './msp';
export type {MspFcFamily, MspFcVariant, FlightControllerIdentity, MspRequester} from './msp';
