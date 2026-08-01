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
  MSP_ACC_CALIBRATION,
  MSP_MAG_CALIBRATION,
  MSP_REBOOT,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_ADVANCED_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MSP2_MOTOR_OUTPUT_REORDERING,
  MSP2_SET_MOTOR_OUTPUT_REORDERING,
  MSP2_SEND_DSHOT_COMMAND,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_EEPROM_WRITE,
} from './commands/mspCommands';
export {
  BETAFLIGHT_SOURCE_REPO,
  BETAFLIGHT_PINNED_COMMIT,
  BETAFLIGHT_API147_COMMIT,
  BETAFLIGHT_2025_12_2_COMMIT,
  INAV_SOURCE_REPO,
  INAV_PINNED_COMMIT,
  EMUFLIGHT_SOURCE_REPO,
  EMUFLIGHT_PINNED_COMMIT,
} from './commands/mspCommandSources';

export {
  MspPayloadReader,
  MspPayloadReadError,
} from './decoding/MspPayloadReader';
export { decodeApiVersion } from './decoding/decodeApiVersion';
export type { MspApiVersion } from './decoding/decodeApiVersion';
export { decodeFcVariant } from './decoding/decodeFcVariant';
export type { MspFcVariantRaw } from './decoding/decodeFcVariant';
export { decodeBoardInfo } from './decoding/decodeBoardInfo';
export type { MspBoardInfo } from './decoding/decodeBoardInfo';
export { decodeAttitude } from './decoding/decodeAttitude';
export type { MspAttitude } from './decoding/decodeAttitude';
export { decodeBatteryState } from './decoding/decodeBatteryState';
export type { MspBatteryState } from './decoding/decodeBatteryState';
export { decodeAnalog } from './decoding/decodeAnalog';
export type { MspAnalog } from './decoding/decodeAnalog';
export { decodeRawGps } from './decoding/decodeRawGps';
export type { MspRawGpsCompact } from './decoding/decodeRawGps';
export {
  decodeStatusEx,
  STATUS_SENSOR_GPS_BIT,
} from './decoding/decodeStatusEx';
export { decodeStatusExDiagnostics } from './decoding/decodeStatusExDiagnostics';
export {
  decodeStatusExReadiness,
  STATUS_EX_FIXED_PREFIX_BYTES,
} from './decoding/decodeStatusExReadiness';
export type { MspStatusExReadiness } from './decoding/decodeStatusExReadiness';
export type { MspStatusExCompact } from './decoding/decodeStatusEx';
export type { MspStatusExDiagnostics } from './decoding/decodeStatusExDiagnostics';

export {
  decodeFeatureConfig,
  FEATURE_3D_BIT,
} from './decoding/decodeFeatureConfig';
export type { MspFeatureConfig } from './decoding/decodeFeatureConfig';
export {
  decodeMixerConfig,
  MIXER_MODE_QUADX,
  MIXER_MODE_QUADX_1234,
} from './decoding/decodeMixerConfig';
export type { MspMixerConfig } from './decoding/decodeMixerConfig';
export {
  decodeAdvancedConfig,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
} from './decoding/decodeAdvancedConfig';
export type { MspAdvancedConfig } from './decoding/decodeAdvancedConfig';
export { decodeMotorConfig } from './decoding/decodeMotorConfig';
export type { MspMotorConfig } from './decoding/decodeMotorConfig';
export { decodeMotor3dConfig } from './decoding/decodeMotor3dConfig';
export type { MspMotor3dConfig } from './decoding/decodeMotor3dConfig';
export {
  decodeMotorOutputs,
  MSP_MOTOR_OUTPUT_SLOT_COUNT,
} from './decoding/decodeMotorOutputs';
export type { MspMotorOutputs } from './decoding/decodeMotorOutputs';
export {
  decodeMotorTelemetry,
  MSP_MOTOR_TELEMETRY_MAX_COUNT,
} from './decoding/decodeMotorTelemetry';
export type {
  MspMotorTelemetry,
  MspMotorTelemetryEntry,
} from './decoding/decodeMotorTelemetry';
export {
  decodeMotorOutputOrder,
  MOTOR_OUTPUT_ORDER_MAX_COUNT,
} from './decoding/decodeMotorOutputOrder';
export type { MspMotorOutputOrder } from './decoding/decodeMotorOutputOrder';
export {
  encodeMotorOutputOrder,
  MotorOutputOrderEncodeError,
} from './encoding/encodeMotorOutputOrder';
export {
  encodeDshotEscDirection,
  DshotEscDirectionEncodeError,
} from './encoding/encodeDshotEscDirection';
export type { DshotEscDirection } from './encoding/encodeDshotEscDirection';

export {
  MotorConfigurationEncodeError,
  deriveFeatureMask,
  encodeMixerConfiguration,
  encodeAdvancedMotorConfiguration,
  encodeMotorConfiguration,
  encodeMotor3dConfiguration,
  encodeFeatureConfiguration,
  encodeChangedMotorConfiguration,
} from './encoding/encodeMotorConfiguration';
export type {
  MotorConfigurationWriteGroup,
  EncodedMotorConfigurationWrite,
} from './encoding/encodeMotorConfiguration';

export {
  checkMspCompatibility,
  MSP_MIN_REQUIRED_API_VERSION_MAJOR,
  MSP_MIN_REQUIRED_API_VERSION_MINOR,
} from './identification/mspCompatibility';
export type { MspCompatibilityResult } from './identification/mspCompatibility';
export { deriveFcFamily } from './identification/mspIdentificationTypes';
export type {
  MspFcFamily,
  MspFcVariant,
  FlightControllerIdentity,
} from './identification/mspIdentificationTypes';
export {
  MspIdentificationService,
  MspIncompatibleFirmwareError,
} from './identification/MspIdentificationService';
export { BoxIdsAcquisition } from './identification/BoxIdsAcquisition';
export type {
  BoxIdsOwnerIdentity,
  BoxIdsResult,
} from './identification/BoxIdsAcquisition';
export type { MspRequester } from './identification/MspIdentificationService';
