export { default as SafetyStrip } from './SafetyStrip';
export type { SafetyStripProps } from './SafetyStrip';
export { default as SetupSafetyNotices } from './SetupSafetyNotices';
export type { SetupSafetyNoticesProps } from './SetupSafetyNotices';

/**
 * SETUP R9. BatteryCard / SensorsCard / ReceiverCard / GpsCard /
 * FlightControllerCard / SetupSummaryLink / TelemetryCardFrame and
 * TopSystemBar are GONE - not hidden behind a flag, not kept as a
 * compatibility wrapper, not reachable from any conditional branch. The
 * information they carried is in SetupStatusBar (connection, board,
 * firmware, API, arming, battery, sensors) and SetupInfoGrid (status,
 * GPS, build), which sit above and immediately below the 3D model
 * respectively. setupNoTopBar.test.tsx fails if any of them returns.
 */
export { default as SetupChromeBar } from './SetupChromeBar';
export type { SetupChromeBarProps } from './SetupChromeBar';
export { default as SetupStatusBar } from './SetupStatusBar';
export type { SetupStatusBarProps } from './SetupStatusBar';
export { default as SetupInfoGrid, resolveSetupInfoColumns } from './SetupInfoGrid';
export type { SetupInfoGridProps } from './SetupInfoGrid';

export { default as DiagnosticsSection } from './DiagnosticsSection';
export type { DiagnosticsSectionProps } from './DiagnosticsSection';

export { default as FcToolsSection } from './FcToolsSection';
export type { FcToolsSectionProps } from './FcToolsSection';

export { default as OrientationHero } from './OrientationHero';
export type { OrientationHeroProps } from './OrientationHero';
export { default as OrientationCalibrationCard } from './OrientationCalibrationCard';
export type { OrientationCalibrationCardProps } from './OrientationCalibrationCard';
export { default as BoardAlignmentCard } from './BoardAlignmentCard';
export type { BoardAlignmentCardProps } from './BoardAlignmentCard';
export { default as FlightInstruments } from './FlightInstruments';
export type {
  FlightInstrumentsProps,
  FlightInstrumentsStatus,
} from './FlightInstruments';
export { default as OrientationStabilityPanel } from './OrientationStabilityPanel';
export type { OrientationStabilityPanelProps } from './OrientationStabilityPanel';

export {
  deriveConnectionIndicatorState,
  deriveTopBarNotice,
  listTopBarNoticeCandidateIds,
  updateNoticeActivationTimestamps,
} from './connectionIndicator';
export type { SetupConnectionIndicatorState } from './connectionIndicator';
export { useTopBarNotice } from './useTopBarNotice';
