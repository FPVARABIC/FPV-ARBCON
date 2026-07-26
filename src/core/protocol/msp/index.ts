export {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_RAW_GPS,
  MSP_ANALOG,
  MSP_STATUS_EX,
  MSP_BOXIDS,
} from './commands/mspCommands';
export {
  BETAFLIGHT_SOURCE_REPO,
  BETAFLIGHT_PINNED_COMMIT,
  BETAFLIGHT_API147_COMMIT,
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
export {decodeAttitude} from './decoding/decodeAttitude';
export type {MspAttitude} from './decoding/decodeAttitude';
export {decodeBatteryState} from './decoding/decodeBatteryState';
export type {MspBatteryState} from './decoding/decodeBatteryState';
export {decodeAnalog} from './decoding/decodeAnalog';
export type {MspAnalog} from './decoding/decodeAnalog';
export {decodeRawGps} from './decoding/decodeRawGps';
export type {MspRawGpsCompact} from './decoding/decodeRawGps';
export {decodeStatusEx, STATUS_SENSOR_GPS_BIT} from './decoding/decodeStatusEx';
export {decodeStatusExDiagnostics} from './decoding/decodeStatusExDiagnostics';
export {decodeStatusExReadiness, STATUS_EX_FIXED_PREFIX_BYTES} from './decoding/decodeStatusExReadiness';
export type {MspStatusExReadiness} from './decoding/decodeStatusExReadiness';
export type {MspStatusExCompact} from './decoding/decodeStatusEx';
export type {MspStatusExDiagnostics} from './decoding/decodeStatusExDiagnostics';

export {
  checkMspCompatibility,
  MSP_MIN_REQUIRED_API_VERSION_MAJOR,
  MSP_MIN_REQUIRED_API_VERSION_MINOR,
} from './identification/mspCompatibility';
export type {MspCompatibilityResult} from './identification/mspCompatibility';
export {deriveFcFamily} from './identification/mspIdentificationTypes';
export type {MspFcFamily, MspFcVariant, FlightControllerIdentity} from './identification/mspIdentificationTypes';
export {MspIdentificationService, MspIncompatibleFirmwareError} from './identification/MspIdentificationService';
export {BoxIdsAcquisition} from './identification/BoxIdsAcquisition';
export type {BoxIdsOwnerIdentity, BoxIdsResult} from './identification/BoxIdsAcquisition';
export type {MspRequester} from './identification/MspIdentificationService';
