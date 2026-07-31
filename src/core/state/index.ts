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
