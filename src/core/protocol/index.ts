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
export type {
  MspDiagnosticCode,
  MspDiagnosticDetailMap,
  MspDiagnosticDetail,
} from './mspErrors';

export {
  xorChecksumStep,
  xorChecksum,
  crc8DvbS2Step,
  crc8DvbS2,
} from './mspChecksum';

export { encode } from './mspEncoder';
export type { MspEncodeOptions } from './mspEncoder';

export { createMspStreamParser } from './mspStreamParser';
export type {
  MspStreamParser,
  MspStreamParserOptions,
  MspIngestEvent,
  MspIngestResult,
} from './mspStreamParser';

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
  STATUS_SENSOR_GPS_BIT,
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
} from './msp';
export {
  BETAFLIGHT_SOURCE_REPO,
  BETAFLIGHT_PINNED_COMMIT,
  BETAFLIGHT_API147_COMMIT,
  BETAFLIGHT_2025_12_2_COMMIT,
  INAV_SOURCE_REPO,
  INAV_PINNED_COMMIT,
  EMUFLIGHT_SOURCE_REPO,
  EMUFLIGHT_PINNED_COMMIT,
} from './msp';
export { MspPayloadReader, MspPayloadReadError } from './msp';
export {
  decodeApiVersion,
  decodeFcVariant,
  decodeBoardInfo,
  decodeAttitude,
  decodeBatteryState,
  decodeAnalog,
  decodeRawGps,
  decodeStatusEx,
} from './msp';
export {
  decodeStatusExReadiness,
  STATUS_EX_FIXED_PREFIX_BYTES,
  decodeStatusExDiagnostics,
} from './msp';
export type { MspStatusExReadiness, MspStatusExDiagnostics } from './msp';
export type {
  MspApiVersion,
  MspFcVariantRaw,
  MspBoardInfo,
  MspAttitude,
  MspBatteryState,
  MspAnalog,
  MspRawGpsCompact,
  MspStatusExCompact,
} from './msp';
export {
  decodeFeatureConfig,
  FEATURE_3D_BIT,
  decodeMixerConfig,
  MIXER_MODE_QUADX,
  MIXER_MODE_QUADX_1234,
  decodeAdvancedConfig,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  decodeMotorConfig,
  decodeMotor3dConfig,
  decodeMotorOutputs,
  MSP_MOTOR_OUTPUT_SLOT_COUNT,
  decodeMotorTelemetry,
  MSP_MOTOR_TELEMETRY_MAX_COUNT,
  decodeMotorOutputOrder,
  MOTOR_OUTPUT_ORDER_MAX_COUNT,
  encodeMotorOutputOrder,
  MotorOutputOrderEncodeError,
  encodeDshotEscDirection,
  DshotEscDirectionEncodeError,
} from './msp';
export type {
  MspFeatureConfig,
  MspMixerConfig,
  MspAdvancedConfig,
  MspMotorConfig,
  MspMotor3dConfig,
  MspMotorOutputs,
  MspMotorTelemetry,
  MspMotorTelemetryEntry,
  MspMotorOutputOrder,
  DshotEscDirection,
} from './msp';
export {
  checkMspCompatibility,
  MSP_MIN_REQUIRED_API_VERSION_MAJOR,
  MSP_MIN_REQUIRED_API_VERSION_MINOR,
} from './msp';
export type { MspCompatibilityResult } from './msp';
export {
  deriveFcFamily,
  MspIdentificationService,
  MspIncompatibleFirmwareError,
  BoxIdsAcquisition,
} from './msp';
export type { BoxIdsOwnerIdentity, BoxIdsResult } from './msp';
export type {
  MspFcFamily,
  MspFcVariant,
  FlightControllerIdentity,
  MspRequester,
} from './msp';

export { RealClock, FakeClock, createMspTelemetryScheduler } from './telemetry';
export type {
  MonotonicClock,
  MspPollDefinition,
  TelemetryValue,
  TelemetryPauseReason,
  TelemetryPauseLease,
  MspTelemetryScheduler,
  MspTelemetrySchedulerOptions,
} from './telemetry';

export {
  MspOperationOutcomeUnknownError,
  createMspOperationCoordinator,
  MspExclusiveOperationInProgressError,
} from './telemetry';
export type {
  ExclusiveOperationState,
  OperationExecutionPhase,
  MspOperationContext,
  MspOperationValidationResult,
  MspExclusiveOperation,
  SetupOperationResult,
  MspOperationCoordinator,
  MspOperationSessionSource,
  MspOperationCoordinatorOptions,
} from './telemetry';
