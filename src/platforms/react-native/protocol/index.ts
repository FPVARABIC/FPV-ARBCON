export { RNMspTransport } from './RNMspTransport';
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
  subscribeMotorDiagnosticsAvailability,
  classifyMotorDiagnosticsFailure,
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
  MOTOR_ESC_TELEMETRY_POLL_ID,
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
