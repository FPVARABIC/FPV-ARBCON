export {MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from './commands/mspCommands';
export {
  BETAFLIGHT_SOURCE_REPO,
  BETAFLIGHT_PINNED_COMMIT,
  INAV_SOURCE_REPO,
  INAV_PINNED_COMMIT,
  EMUFLIGHT_SOURCE_REPO,
  EMUFLIGHT_PINNED_COMMIT,
} from './commands/mspCommandSources';

export {MspPayloadReader, MspPayloadReadError} from './decoding/MspPayloadReader';
export {decodeApiVersion} from './decoding/decodeApiVersion';
export type {MspApiVersion} from './decoding/decodeApiVersion';
export {decodeFcVariant} from './decoding/decodeFcVariant';
export type {MspFcVariantRaw} from './decoding/decodeFcVariant';
export {decodeBoardInfo} from './decoding/decodeBoardInfo';
export type {MspBoardInfo} from './decoding/decodeBoardInfo';

export {
  checkMspCompatibility,
  MSP_MIN_REQUIRED_API_VERSION_MAJOR,
  MSP_MIN_REQUIRED_API_VERSION_MINOR,
} from './identification/mspCompatibility';
export type {MspCompatibilityResult} from './identification/mspCompatibility';
export {deriveFcFamily} from './identification/mspIdentificationTypes';
export type {MspFcFamily, MspFcVariant, FlightControllerIdentity} from './identification/mspIdentificationTypes';
export {MspIdentificationService, MspIncompatibleFirmwareError} from './identification/MspIdentificationService';
export type {MspRequester} from './identification/MspIdentificationService';
