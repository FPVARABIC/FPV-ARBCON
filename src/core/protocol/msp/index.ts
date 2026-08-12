export {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BUILD_INFO,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_RAW_GPS,
  MSP_COMP_GPS,
  MSP_GPS_CONFIG,
  MSP_GPS_SV_INFO,
  MSP_ANALOG,
  MSP_STATUS_EX,
  MSP_TX_INFO,
  MSP_BOXIDS,
  MSP_ACC_CALIBRATION,
  MSP_MAG_CALIBRATION,
  MSP_REBOOT,
  MSP_NAME,
  MSP_SET_NAME,
  MSP_FEATURE_CONFIG,
  MSP_RX_CONFIG,
  MSP_SET_RX_CONFIG,
  MSP_RSSI_CONFIG,
  MSP_SET_RSSI_CONFIG,
  MSP_RX_MAP,
  MSP_SET_RX_MAP,
  MSP_ARMING_CONFIG,
  MSP_SET_ARMING_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_SET_BEEPER_CONFIG,
  MSP2_GET_TEXT,
  MSP2_SET_TEXT,
  MSP_MIXER_CONFIG,
  MSP_ADVANCED_CONFIG,
  MSP_MOTOR,
  MSP_RC,
  MSP_RC_TUNING,
  MSP_PID,
  MSP_FILTER_CONFIG,
  MSP_PID_ADVANCED,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_PID_ADVANCED,
  MSP_SET_PID,
  MSP_SET_RC_TUNING,
  MSP_MOTOR_3D_CONFIG,
  MSP_RC_DEADBAND,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MSP2_MOTOR_OUTPUT_REORDERING,
  MSP2_SET_MOTOR_OUTPUT_REORDERING,
  MSP2_SEND_DSHOT_COMMAND,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_RC_DEADBAND,
  MSP_SET_MOTOR_CONFIG,
  MSP_SET_GPS_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_VTX_CONFIG,
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
} from './commands/mspCommands';

export { decodeDetailedGps } from './decoding/decodeDetailedGps';
export type { MspDetailedGps } from './decoding/decodeDetailedGps';
export { decodeCompGps } from './decoding/decodeCompGps';
export type { MspCompGps } from './decoding/decodeCompGps';
export { decodeGpsConfiguration } from './decoding/decodeGpsConfiguration';
export type { MspGpsConfiguration } from './decoding/decodeGpsConfiguration';
export {
  decodeGpsSatelliteInfo,
  GPS_SATELLITE_MAX_COUNT,
} from './decoding/decodeGpsSatelliteInfo';
export type {
  GpsConstellation,
  MspGpsSatellite,
  MspGpsSatelliteInfo,
} from './decoding/decodeGpsSatelliteInfo';
export { encodeGpsConfiguration } from './encoding/encodeGpsConfiguration';
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
  decodeSerialPorts,
  encodeSerialPorts,
  SERIAL_PORT_RECORD_MIN_BYTES,
} from './decoding/decodeSerialPorts';
export type { MspSerialPortRecord } from './decoding/decodeSerialPorts';
export { decodeBuildOptions } from './decoding/decodeBuildOptions';
export type { MspBuildOptions } from './decoding/decodeBuildOptions';
export { decodeSerialRxProvider } from './decoding/decodeSerialRxProvider';
export { decodeVtxTableStatus } from './decoding/decodeVtxTableStatus';
export type { MspVtxTableStatus } from './decoding/decodeVtxTableStatus';
export { decodeArmingConfig } from './decoding/decodeArmingConfig';
export type { MspArmingConfig } from './decoding/decodeArmingConfig';
export { decodeBeeperConfig } from './decoding/decodeBeeperConfig';
export type { MspBeeperConfig } from './decoding/decodeBeeperConfig';
export { decodeRxConfig } from './decoding/decodeRxConfig';
export type { MspRxConfig } from './decoding/decodeRxConfig';
export {
  decodeRcChannels,
  decodeReceiverMap,
  decodeRssiConfig,
  decodeReceiverDeadband,
  RECEIVER_CHANNEL_MAX_COUNT,
} from './decoding/decodeReceiver';
export type { MspRcChannels, MspReceiverDeadband } from './decoding/decodeReceiver';
export { decodeTxInfo } from './decoding/decodeTxInfo';
export type { MspTxInfo } from './decoding/decodeTxInfo';
export {
  decodePidTerms,
  decodeRcTuning,
  decodeFilterConfiguration,
  decodePidTuningSnapshot,
  PID_ITEM_COUNT,
  PID_AXIS_COUNT,
  PID_ADVANCED_API147_MIN_BYTES,
  RC_TUNING_API147_BYTES,
  FILTER_CONFIG_API147_BYTES,
} from './decoding/decodePidTuning';
export type {
  MspPidTerm,
  MspRcTuning,
  MspFilterConfiguration,
  MspPidTuningSnapshot,
} from './decoding/decodePidTuning';
export {encodeChangedPidTuning} from './encoding/encodePidTuning';
export type {PidTuningWriteGroup, EncodedPidTuningWrite} from './encoding/encodePidTuning';
export {
  MSP_MODE_RANGES,
  MSP_SET_MODE_RANGE,
  MSP_BOXNAMES,
  MSP_MODE_RANGES_EXTRA,
} from './commands/mspCommands';
export {
  decodeModesConfiguration,
  MODE_RANGE_MIN,
  MODE_RANGE_MAX,
  MODE_RANGE_STEP,
  MODE_RANGE_SLOT_BYTES,
  MODE_RANGE_EXTRA_SLOT_BYTES,
} from './decoding/decodeModes';
export type {
  MspModeDefinition,
  MspModeRangeSlot,
  MspModesConfiguration,
} from './decoding/decodeModes';
export {encodeModeRangeWrites} from './encoding/encodeModes';
export type {EncodedModeRangeWrite} from './encoding/encodeModes';
export {
  MSP_FAILSAFE_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_RXFAIL_CONFIG,
  MSP_SET_RXFAIL_CONFIG,
} from './commands/mspCommands';
export {
  decodeFailsafeConfiguration,
  decodeRxFailsafeConfiguration,
  RX_FAILSAFE_MIN,
  RX_FAILSAFE_MAX,
  RX_FAILSAFE_STEP,
  BUILD_OPTION_GPS,
} from './decoding/decodeFailsafe';
export type {
  FailsafeProcedure,
  FailsafeSwitchMode,
  RxFailsafeMode,
  MspFailsafeConfiguration,
  MspRxFailsafeChannel,
  MspFailsafeSnapshot,
} from './decoding/decodeFailsafe';
export {encodeChangedFailsafeConfiguration} from './encoding/encodeFailsafe';
export type {FailsafeWriteGroup, EncodedFailsafeWrite} from './encoding/encodeFailsafe';
export {
  MSP_BATTERY_CONFIG,
  MSP_SET_BATTERY_CONFIG,
  MSP_CURRENT_METER_CONFIG,
  MSP_SET_CURRENT_METER_CONFIG,
  MSP_VOLTAGE_METER_CONFIG,
  MSP_SET_VOLTAGE_METER_CONFIG,
  MSP_VOLTAGE_METERS,
  MSP_CURRENT_METERS,
  MSP_OSD_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP_OSD_CANVAS,
  MSP_SET_VTX_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  MSP_SET_VTXTABLE_BAND,
  MSP_SET_VTXTABLE_POWERLEVEL,
  MSP_RAW_IMU,
  MSP_ALTITUDE,
} from './commands/mspCommands';
export {decodeBatteryConfiguration, decodeVoltageMeterConfiguration, decodeCurrentMeterConfiguration} from './decoding/decodePowerConfiguration';
export type {MspBatteryConfiguration, MspVoltageMeterConfiguration, MspCurrentMeterConfiguration, MspPowerConfigurationSnapshot} from './decoding/decodePowerConfiguration';
export {encodeChangedPowerConfiguration} from './encoding/encodePowerConfiguration';
export type {PowerWriteGroup, EncodedPowerWrite} from './encoding/encodePowerConfiguration';
export {decodeOsdConfiguration, decodeOsdCanvas} from './decoding/decodeOsdConfiguration';
export type {MspOsdConfiguration, MspOsdCanvas, MspOsdSnapshot} from './decoding/decodeOsdConfiguration';
export {encodeChangedOsdConfiguration} from './encoding/encodeOsdConfiguration';
export type {OsdWriteGroup, EncodedOsdWrite} from './encoding/encodeOsdConfiguration';
export {decodeVtxConfiguration, decodeVtxBand, decodeVtxPowerLevel} from './decoding/decodeVtxConfiguration';
export type {MspVtxConfiguration, MspVtxBand, MspVtxPowerLevel, MspVtxSnapshot} from './decoding/decodeVtxConfiguration';
export {encodeChangedVtxConfiguration} from './encoding/encodeVtxConfiguration';
export type {VtxWriteGroup, EncodedVtxWrite} from './encoding/encodeVtxConfiguration';
export {decodeRawImu, decodeAltitude} from './decoding/decodeSensorTelemetry';
export type {SensorVector3, MspRawImu, MspAltitude} from './decoding/decodeSensorTelemetry';
export {
  decodeMspText,
  MSP_TEXT_PILOT_NAME,
  MSP_TEXT_CRAFT_NAME,
  MSP_TEXT_MAX_BYTES,
} from './decoding/decodeMspText';
export type { MspTextValue } from './decoding/decodeMspText';
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
  encodeArmingConfiguration,
  encodeBeeperConfiguration,
  encodeAdvancedGeneralConfiguration,
  encodeRxCameraAngle,
  encodeMspTextRequest,
  encodeMspText,
  encodeChangedGeneralConfiguration,
} from './encoding/encodeGeneralConfiguration';
export type {
  GeneralConfigurationWriteGroup,
  EncodedGeneralConfigurationWrite,
} from './encoding/encodeGeneralConfiguration';
export {
  encodeReceiverMap,
  encodeReceiverDeadband,
  encodeReceiverConfig,
  encodeChangedReceiverConfiguration,
} from './encoding/encodeReceiver';
export type { ReceiverWriteGroup, EncodedReceiverWrite } from './encoding/encodeReceiver';
export { encodeFeatureConfig } from './encoding/encodeFeatureConfig';

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
