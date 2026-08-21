export { RNMspTransport } from './RNMspTransport';
export {
  RawCliSessionController,
  rawCliSessionController,
  normalizeCliCommand,
  sanitizeCliOutput,
} from './RawCliSessionController';
export type {
  CliCommandResult,
  CliBatchResult,
  RawCliPhase,
  RawCliCoordinator,
  RawCliSessionControllerOptions,
} from './RawCliSessionController';
export {
  FirmwarePresetRepository,
  firmwarePresetRepository,
  OFFICIAL_PRESETS_BASE_URL,
} from './FirmwarePresetRepository';
export type {
  LoadedFirmwarePreset,
  FirmwarePresetRepositoryOptions,
} from './FirmwarePresetRepository';
export {
  MspSessionCoordinator,
  mspSessionCoordinator,
  MspOwnershipActivationError,
  ATTITUDE_TELEMETRY_POLL_ID,
  ARMED_TELEMETRY_POLL_ID,
  ARMING_BLOCKERS_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  GPS_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
} from './MspSessionCoordinator';
export type {
  MspSessionOwnershipState,
  MspIdentificationState,
  MspIdentificationMetrics,
  MspSessionCoordinatorUnsubscribe,
  SetupUiSessionKey,
  AuxTelemetryChannelState,
} from './MspSessionCoordinator';
export {
  useMspOwnershipState,
  useMspIdentificationState,
  useMspRecoveryState,
} from './useMspSessionState';
export { useTelemetryValue } from './useTelemetryValue';
export {
  useAuxTelemetryChannelState,
  useBatteryLatchedValue,
} from './useAuxTelemetry';
export {
  SetupAppStateTelemetryOwner,
  setupAppStateTelemetryOwner,
} from './setupAppStateTelemetryOwner';
export type {
  SetupAppStatePhase,
  SetupAppStateTelemetryOwnerOptions,
} from './setupAppStateTelemetryOwner';
export { FcToolsController, fcToolsController } from './FcToolsController';
export type {
  FcToolPhase,
  FcToolOutcome,
  FcToolOutcomeOrigin,
  FcToolPublication,
  FcToolsControllerOptions,
} from './FcToolsController';
export {
  useFcToolPhase,
  useFcToolPublication,
  useFcToolArmedState,
} from './useFcTools';
export {
  MotorConfigurationController,
  motorConfigurationController,
} from './MotorConfigurationController';
export {
  PortsConfigurationController,
  portsConfigurationController,
} from './PortsConfigurationController';
export {
  GpsConfigurationController,
  gpsConfigurationController,
} from './GpsConfigurationController';
export {
  ReceiverConfigurationController,
  receiverConfigurationController,
} from './ReceiverConfigurationController';
export type {
  ReceiverBlockReason,
  ReceiverLoadOutcome,
  ReceiverSaveOutcome,
  ReceiverRebootEvidence,
  ReceiverRebootOutcome,
  ReceiverRuntimeOutcome,
  ReceiverModeTarget,
  ReceiverRuntimeTruth,
  ReceiverSessionCoordinator,
  ReceiverAppStateOwner,
  ReceiverConfigurationControllerOptions,
} from './ReceiverConfigurationController';
export {
  acquireReceiverTelemetry,
  getReceiverObservedRateHz,
  RECEIVER_CHANNELS_POLL_ID,
} from './receiverTelemetry';
export {
  PidTuningController,
  pidTuningController,
} from './PidTuningController';
export type {
  PidBlockReason,
  PidLoadOutcome,
  PidProfileKind,
  PidProfileSwitchOutcome,
  PidSaveOutcome,
  PidSessionCoordinator,
  PidAppStateOwner,
  PidTuningControllerOptions,
} from './PidTuningController';
export {
  ModesConfigurationController,
  modesConfigurationController,
} from './ModesConfigurationController';
export type {
  ModesBlockReason,
  ModesWriteStage,
  ModesLoadOutcome,
  ModesSaveOutcome,
  ModesSessionCoordinator,
  ModesAppStateOwner,
  ModesConfigurationControllerOptions,
} from './ModesConfigurationController';
export {
  BoardAlignmentController,
  boardAlignmentController,
} from './BoardAlignmentController';
export type {
  BoardAlignmentBlockReason,
  BoardAlignmentSaveStage,
  BoardAlignmentLoadOutcome,
  BoardAlignmentSaveOutcome,
  BoardAlignmentSessionCoordinator,
  BoardAlignmentAppStateOwner,
  BoardAlignmentControllerOptions,
} from './BoardAlignmentController';
export {
  FailsafeConfigurationController,
  failsafeConfigurationController,
} from './FailsafeConfigurationController';
export type {
  FailsafeBlockReason,
  FailsafeSaveStage,
  FailsafeLoadOutcome,
  FailsafeSaveOutcome,
  FailsafeSessionCoordinator,
  FailsafeAppStateOwner,
  FailsafeConfigurationControllerOptions,
} from './FailsafeConfigurationController';
export {
  PowerConfigurationController,
  powerConfigurationController,
} from './PowerConfigurationController';
export type {
  PowerBlockReason,
  PowerSaveStage,
  PowerLoadOutcome,
  PowerSaveOutcome,
  PowerSessionCoordinator,
  PowerAppStateOwner,
  PowerConfigurationControllerOptions,
} from './PowerConfigurationController';
export {
  acquirePowerTelemetry,
  POWER_BATTERY_POLL_ID,
  POWER_BATTERY_POLL_INTERVAL_MS,
} from './powerTelemetry';
export {
  OsdConfigurationController,
  osdConfigurationController,
} from './OsdConfigurationController';
export type {
  OsdBlockReason,
  OsdSaveStage,
  OsdLoadOutcome,
  OsdSaveOutcome,
  OsdSessionCoordinator,
  OsdAppStateOwner,
  OsdConfigurationControllerOptions,
} from './OsdConfigurationController';
export {
  VtxConfigurationController,
  vtxConfigurationController,
} from './VtxConfigurationController';
export type {
  VtxBlockReason,
  VtxSaveStage,
  VtxLoadOutcome,
  VtxSaveOutcome,
  VtxSessionCoordinator,
  VtxAppStateOwner,
  VtxConfigurationControllerOptions,
} from './VtxConfigurationController';
export {
  acquireSensorsTelemetry,
  SENSOR_IMU_POLL_ID,
  SENSOR_ALTITUDE_POLL_ID,
  SENSOR_IMU_INTERVAL_MS,
} from './sensorsTelemetry';
/* SETUP P3. Only the acquire is public. `isSetupAttitudeSuppressedBySetup`
 * is test-only introspection and stays off the barrel deliberately: the
 * scheduler's own reference count is the authority on whether a poll is
 * suppressed, and a second, weaker answer reachable from the UI would be
 * a way for a screen to disagree with it. */
export {acquireSetupHiddenAttitudeSuppression} from './setupHiddenAttitudeSuppression';
export {
  GeneralConfigurationController,
  generalConfigurationController,
} from './GeneralConfigurationController';
export type {
  GeneralConfigurationBlockReason,
  GeneralConfigurationLoadOutcome,
  GeneralConfigurationSaveStage,
  GeneralConfigurationSaveOutcome,
  GeneralConfigurationSessionCoordinator,
  GeneralConfigurationAppStateOwner,
  GeneralConfigurationControllerOptions,
} from './GeneralConfigurationController';
export type {
  GpsBlockReason,
  GpsLoadOutcome,
  GpsSaveOutcome,
  GpsSessionCoordinator,
  GpsAppStateOwner,
  GpsConfigurationControllerOptions,
} from './GpsConfigurationController';
export {
  acquireGpsDetailTelemetry,
  GPS_DETAIL_RAW_POLL_ID,
  GPS_DETAIL_HOME_POLL_ID,
  GPS_DETAIL_SATELLITES_POLL_ID,
} from './gpsDetailTelemetry';
export type {
  PortsBlockReason,
  PortsLoadOutcome,
  PortsSaveOutcome,
  PortsSessionCoordinator,
  PortsAppStateOwner,
  PortsConfigurationControllerOptions,
} from './PortsConfigurationController';
export {
  acquireMotorDiagnosticsTelemetry,
  getMotorDiagnosticsAvailability,
  getMotorDiagnosticsSupport,
  subscribeMotorDiagnosticsAvailability,
  classifyMotorDiagnosticsFailure,
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
  MOTOR_ESC_TELEMETRY_POLL_ID,
  MOTOR_TELEMETRY_SOURCE_POLL_ID,
} from './motorDiagnosticsTelemetry';
export type {
  MotorDiagnosticsAvailability,
  MotorDiagnosticsChannelState,
} from './motorDiagnosticsTelemetry';
export {
  acquireMotorConfigurationInterlock,
  isMotorConfigurationTransactionActive,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';
export type { MotorConfigurationInterlockLease } from './motorConfigurationInterlock';
export type {
  MotorConfigurationBlockReason,
  MotorConfigurationLoadOutcome,
  MotorConfigurationSaveOutcome,
  MotorOutputOrderLoadOutcome,
  MotorOutputOrderSaveOutcome,
  EscDirectionOutcome,
  MotorConfigurationControllerOptions,
  MotorConfigurationSessionCoordinator,
  MotorConfigurationAppStateOwner,
} from './MotorConfigurationController';
export { useSetupAppStatePhase } from './useSetupAppState';
export {
  SetupUiSessionStore,
  setupUiSessionStore,
} from './SetupUiSessionStore';
export type { SetupUiSessionState } from './SetupUiSessionStore';
/* Phase 2E/2H - the ONE official motor-test binding. Only the sealed
 * facades are exported: no controller class, no client, no lease, no
 * authority token and no transport ever leaves this module. */
/* R2: the RUNTIME export of the binding factory is deliberately GONE.
 * A runtime barrel re-export pulls `motorTestSessionBinding` - and with it
 * the controller, the vector builders, the payload encoder and the pulse
 * constant - into every graph that imports this barrel, including Release.
 * The factory is now reachable only through the one build-time containment
 * seam (motorTestDebugSeam.ts). Type-only exports below erase completely
 * and pull nothing into the bundle. */
export type {
  MotorTestSessionCapability,
  MotorTestOperatorPort,
  MotorTestLifecycleStopPort,
  MotorTestSessionPortInput,
} from './motorTestSessionBinding';
