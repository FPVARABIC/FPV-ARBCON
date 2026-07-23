export type {MonotonicClock} from './clock';
export {RealClock, FakeClock} from './clock';

export type {MspPollDefinition, TelemetryValue, TelemetryPauseReason, TelemetryPauseLease} from './telemetryTypes';

export {createMspTelemetryScheduler} from './MspTelemetryScheduler';
export type {MspTelemetryScheduler, MspTelemetrySchedulerOptions} from './MspTelemetryScheduler';
