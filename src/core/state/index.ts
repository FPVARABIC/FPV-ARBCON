export {
  deriveOrientationViewState,
  describeOrientationForAccessibility,
} from './orientationViewModel';
export type {
  OrientationViewOffset,
  OrientationViewState,
} from './orientationViewModel';

export {
  analyzeOrientationStability,
  ORIENTATION_STABILITY_WINDOW_MS,
  ORIENTATION_STABILITY_MIN_SAMPLES,
  ORIENTATION_STABILITY_LIMITS,
} from './orientationStability';
export type {
  OrientationStabilitySample,
  OrientationStabilityResult,
} from './orientationStability';

export {
  deriveArmingReadiness,
  rankArmingBlockReasons,
  selectTopArmingBlockReasons,
} from './armingReadiness';
export type {
  ArmingBlockSeverity,
  ArmingBlockReason,
  ArmingReadiness,
  ArmingBlockReasonSelection,
} from './armingReadiness';

export { pickTopNotice } from './setupNotice';
export type {
  SetupNotice,
  SetupNoticeDomain,
  SetupNoticeSeverity,
  SetupNoticeScope,
} from './setupNotice';

export {
  assembleMotorStaticFacts,
  bindMotorStaticFacts,
} from './motorStaticFacts';
export {
  SERIAL_BAUD_RATES,
  SERIAL_ROLE_DEFINITIONS,
  SERIAL_KNOWN_FUNCTION_MASK,
  serialPortDisplayName,
  serialRoleIsAvailable,
  hasSerialRole,
  enabledSerialRoles,
  unknownSerialFunctionMask,
  setSerialRole,
  setSerialBaud,
  availableBaudIndexes,
  validateSerialPorts,
  normalizeSerialPortsForSave,
  deriveSerialPortsFeatureMask,
  FEATURE_RX_SERIAL_BIT,
  FEATURE_GPS_BIT,
  FEATURE_TELEMETRY_BIT,
  FEATURE_ESC_SENSOR_BIT_FOR_PORTS,
  serialPortsEqual,
} from './serialPortsModel';
export type {
  SerialRoleCategory,
  SerialRoleKey,
  SerialRoleDefinition,
  SerialPortsSnapshot,
  SerialPortsValidationCode,
  SerialPortsValidationIssue,
  SerialBaudField,
} from './serialPortsModel';
export {
  GPS_FEATURE_BIT,
  GPS_PROVIDERS,
  GPS_SBAS_MODES,
  createGpsConfigurationDraft,
  hasGpsFeature,
  deriveGpsFeatureMask,
  gpsDraftsEqual,
  gpsConfigurationsEqual,
  validateGpsDraft,
  assignedGpsPorts,
} from './gpsConfigurationModel';
export type {
  GpsConfigurationSnapshot,
  GpsConfigurationDraft,
  GpsConfigurationValidationCode,
} from './gpsConfigurationModel';
export {
  FEATURE_MOTOR_STOP_BIT,
  FEATURE_ESC_SENSOR_BIT,
  MOTOR_PROTOCOL_RAW_MIN,
  MOTOR_PROTOCOL_RAW_MAX,
  MOTOR_PROTOCOL_DSHOT_MIN,
  MOTOR_PROTOCOL_DSHOT_MAX,
  createMotorConfigurationDraft,
  hasFeature,
  setFeature,
  validateMotorConfigurationDraft,
  motorConfigurationDraftsEqual,
} from './motorConfigurationModel';
export {
  deriveMotorDiagnosticsSupport,
  hasEscTelemetrySource,
  visibleMotorTelemetryMetrics,
} from './motorDiagnosticsSemantics';
export type {
  MotorEscTelemetrySource,
  MotorDiagnosticsSupport,
  MotorTelemetryVisibleMetrics,
} from './motorDiagnosticsSemantics';
export type {
  MotorConfigurationSnapshot,
  MotorConfigurationDraft,
  MotorConfigurationValidationCode,
  MotorConfigurationValidationIssue,
  MotorConfigurationValidationResult,
} from './motorConfigurationModel';
export type {
  MotorStaticFacts,
  MotorStaticFactsInput,
  MotorStaticFactsBinding,
  MotorStaticFactsSessionIdentity,
  MotorStaticFactsFlightControllerIdentity,
  MotorStaticFactsApiVersionSnapshot,
  MotorStaticFactsFirmwareSnapshot,
  MotorStaticFactsBoardSnapshot,
} from './motorStaticFacts';
