import {
  decodeMotorConfig,
  decodeMotorOutputs,
  decodeMotorTelemetry,
  deriveMotorDiagnosticsSupport,
  hasEscTelemetrySource,
  MSP_MOTOR,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MspClientError,
  MspPayloadReadError,
  type MotorDiagnosticsSupport,
  type MspMotorConfig,
  type MspMotorOutputs,
  type MspMotorTelemetry,
  type MspTelemetryScheduler,
  type TelemetryValue,
} from '../../../core';
import { mspSessionCoordinator } from './MspSessionCoordinator';

export const MOTOR_OUTPUTS_TELEMETRY_POLL_ID = 'motorOutputs';
export const MOTOR_ESC_TELEMETRY_POLL_ID = 'motorEscTelemetry';
/**
 * THE POLL THAT ENDS THE GUESS.
 *
 * Command 139 cannot report its own availability: Betaflight serializes a
 * structurally valid, all-zero MSP_MOTOR_TELEMETRY payload when neither
 * bidirectional DShot nor FEATURE_ESC_SENSOR is enabled. Only
 * MSP_MOTOR_CONFIG carries the two flags that decide it - `useDshotTelemetry`
 * and `featureIsEnabled(FEATURE_ESC_SENSOR)` (msp.c, case MSP_MOTOR_CONFIG).
 *
 * Before this poll existed, this module learned the source ONLY from an
 * open motor-test session, and reported the flat sentence "no telemetry
 * source is enabled" whenever it had not been told otherwise. That is a
 * statement about the operator's flight controller, and outside a session
 * this module had never read the byte that decides it. It now reads it,
 * on its own, for as long as the Motors screen is open - a 7-byte reply
 * on the lowest priority, paused with every other poll during a motor test.
 */
export const MOTOR_TELEMETRY_SOURCE_POLL_ID = 'motorTelemetrySource';

export type MotorDiagnosticsChannelState =
  | 'WAITING_FOR_SESSION'
  | 'ACTIVE'
  /** PROVEN absent: the flight controller's own motor configuration says
   * neither bidirectional DShot nor FEATURE_ESC_SENSOR is enabled. */
  | 'NOT_ENABLED'
  /** NOT YET KNOWN. Never rendered as "not enabled": the difference
   * between "your ESCs are not configured for telemetry" and "this app
   * has not read your motor configuration yet" is the difference between
   * a diagnosis and a guess. */
  | 'SOURCE_UNKNOWN'
  | 'UNSUPPORTED'
  | 'MALFORMED_RESPONSE'
  | 'LINK_FAILED';

export interface MotorDiagnosticsAvailability {
  readonly outputs: MotorDiagnosticsChannelState;
  readonly escTelemetry: MotorDiagnosticsChannelState;
}

const WAITING_AVAILABILITY: MotorDiagnosticsAvailability = Object.freeze({
  outputs: 'WAITING_FOR_SESSION',
  escTelemetry: 'WAITING_FOR_SESSION',
});

interface Registration {
  readonly sessionId: string;
  references: number;
  escTelemetryReferences: number;
  scheduler: MspTelemetryScheduler | undefined;
  unregisterOutputs: (() => void) | undefined;
  unregisterEscTelemetry: (() => void) | undefined;
  unregisterSource: (() => void) | undefined;
  unsubscribeScheduler: (() => void) | undefined;
  unsubscribeAvailability: () => void;
  unsubscribeOwnership: () => void;
  outputLastValue: TelemetryValue<MspMotorOutputs> | undefined;
  escLastValue: TelemetryValue<MspMotorTelemetry> | undefined;
  sourceLastValue: TelemetryValue<MspMotorConfig> | undefined;
  /** Derived from THIS session's own MSP_MOTOR_CONFIG reply. Undefined
   * until one has actually arrived - never defaulted to "no source". */
  support: MotorDiagnosticsSupport | undefined;
  outputConsecutiveFailures: number;
  escConsecutiveFailures: number;
  availability: MotorDiagnosticsAvailability;
  readonly listeners: Set<() => void>;
}

const registrations = new Map<string, Registration>();

function waitingAvailability(
  registration: Pick<
    Registration,
    'escTelemetryReferences' | 'support'
  >,
): MotorDiagnosticsAvailability {
  return Object.freeze({
    outputs: 'WAITING_FOR_SESSION',
    escTelemetry: escTelemetryIdleState(registration),
  });
}

/**
 * What the ESC channel is when no poll is running: an unproven absence is
 * SOURCE_UNKNOWN, and only a motor configuration this session actually
 * read may downgrade it to the definite NOT_ENABLED.
 */
function escTelemetryIdleState(
  registration: Pick<Registration, 'escTelemetryReferences' | 'support'>,
): MotorDiagnosticsChannelState {
  if (registration.escTelemetryReferences > 0) {
    return 'WAITING_FOR_SESSION';
  }
  return registration.support === undefined ? 'SOURCE_UNKNOWN' : 'NOT_ENABLED';
}

/** True when either the caller or this module's own read proves a source. */
function escTelemetryWanted(registration: Registration): boolean {
  return (
    registration.escTelemetryReferences > 0 ||
    hasEscTelemetrySource(registration.support)
  );
}

export function classifyMotorDiagnosticsFailure(
  error: unknown,
): MotorDiagnosticsChannelState | undefined {
  if (error instanceof MspClientError) {
    if (error.code === 'MSP_REMOTE_ERROR') {
      return 'UNSUPPORTED';
    }
    if (
      error.code === 'MSP_TIMEOUT' ||
      error.code === 'MSP_DEVICE_DETACHED' ||
      error.code === 'MSP_SESSION_CLOSED' ||
      error.code === 'MSP_RECOVERY_REQUIRED'
    ) {
      return 'LINK_FAILED';
    }
  }
  if (error instanceof MspPayloadReadError) {
    return 'MALFORMED_RESPONSE';
  }
  return undefined;
}

function publish(
  registration: Registration,
  channel: 'outputs' | 'escTelemetry',
  state: MotorDiagnosticsChannelState,
): void {
  if (registration.availability[channel] === state) {
    return;
  }
  registration.availability = Object.freeze({
    ...registration.availability,
    [channel]: state,
  });
  for (const listener of Array.from(registration.listeners)) {
    try {
      listener();
    } catch {
      // One presentation listener must never break telemetry containment.
    }
  }
}

function stopChannel(
  registration: Registration,
  channel: 'outputs' | 'escTelemetry',
  state: MotorDiagnosticsChannelState,
): void {
  if (channel === 'outputs') {
    registration.unregisterOutputs?.();
    registration.unregisterOutputs = undefined;
  } else {
    registration.unregisterEscTelemetry?.();
    registration.unregisterEscTelemetry = undefined;
  }
  publish(registration, channel, state);
}

function evaluateChannel<T>(
  registration: Registration,
  channel: 'outputs' | 'escTelemetry',
  value: TelemetryValue<T>,
): void {
  if (value.status === 'FRESH') {
    if (channel === 'outputs') {
      registration.outputConsecutiveFailures = 0;
    } else {
      registration.escConsecutiveFailures = 0;
    }
    publish(registration, channel, 'ACTIVE');
    return;
  }
  if (value.status !== 'ERROR') {
    return;
  }
  const terminal = classifyMotorDiagnosticsFailure(value.error);
  if (terminal !== undefined) {
    stopChannel(registration, channel, terminal);
    return;
  }
  const failures =
    channel === 'outputs'
      ? ++registration.outputConsecutiveFailures
      : ++registration.escConsecutiveFailures;
  // Unknown transient errors get one retry. A second consecutive failure
  // opens the breaker so the Motors screen can never flood a weak link.
  if (failures >= 2) {
    stopChannel(registration, channel, 'LINK_FAILED');
  }
}

function detachScheduler(registration: Registration): void {
  registration.unsubscribeScheduler?.();
  registration.unsubscribeScheduler = undefined;
  registration.unregisterOutputs?.();
  registration.unregisterOutputs = undefined;
  registration.unregisterEscTelemetry?.();
  registration.unregisterEscTelemetry = undefined;
  registration.unregisterSource?.();
  registration.unregisterSource = undefined;
  registration.scheduler = undefined;
  registration.outputLastValue = undefined;
  registration.escLastValue = undefined;
  registration.sourceLastValue = undefined;
  // THE SOURCE BELONGS TO THE SESSION THAT PROVED IT. A replacement cable
  // is a different aircraft until it says otherwise, so the derived
  // support is dropped with the scheduler rather than carried across.
  registration.support = undefined;
  registration.outputConsecutiveFailures = 0;
  registration.escConsecutiveFailures = 0;
  registration.availability = waitingAvailability(registration);
}

function reconcileEscTelemetryPoll(registration: Registration): void {
  const scheduler = registration.scheduler;
  if (scheduler === undefined) {
    publish(registration, 'escTelemetry', escTelemetryIdleState(registration));
    return;
  }
  if (!escTelemetryWanted(registration)) {
    registration.unregisterEscTelemetry?.();
    registration.unregisterEscTelemetry = undefined;
    registration.escLastValue = undefined;
    registration.escConsecutiveFailures = 0;
    publish(registration, 'escTelemetry', escTelemetryIdleState(registration));
    return;
  }
  if (registration.unregisterEscTelemetry !== undefined) {
    return;
  }
  registration.escLastValue = undefined;
  registration.escConsecutiveFailures = 0;
  registration.unregisterEscTelemetry =
    scheduler.registerPoll<MspMotorTelemetry>({
      id: MOTOR_ESC_TELEMETRY_POLL_ID,
      command: MSP_MOTOR_TELEMETRY,
      intervalMs: 500,
      staleAfterMs: 1_500,
      priority: -2,
      initialDelayMs: 250,
      decode: decodeMotorTelemetry,
    });
  publish(registration, 'escTelemetry', 'ACTIVE');
}

function attachCurrentScheduler(registration: Registration): void {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(
    registration.sessionId,
  );
  if (scheduler === registration.scheduler) {
    reconcileEscTelemetryPoll(registration);
    return;
  }
  detachScheduler(registration);
  if (scheduler === undefined) {
    for (const listener of Array.from(registration.listeners)) {
      listener();
    }
    return;
  }

  registration.scheduler = scheduler;
  registration.availability = Object.freeze({
    outputs: 'ACTIVE',
    escTelemetry: escTelemetryWanted(registration)
      ? 'ACTIVE'
      : escTelemetryIdleState(registration),
  });
  registration.unregisterOutputs = scheduler.registerPoll<MspMotorOutputs>({
    id: MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
    command: MSP_MOTOR,
    intervalMs: 150,
    staleAfterMs: 750,
    priority: -1,
    decode: decodeMotorOutputs,
  });
  // The motor configuration is static between writes, so this is the
  // slowest poll on the scheduler and the lowest priority on it. It exists
  // to answer ONE question - which telemetry source, if any, this aircraft
  // has - and it re-answers it after a settings write without any coupling
  // to the code that performed the write.
  registration.unregisterSource = scheduler.registerPoll<MspMotorConfig>({
    id: MOTOR_TELEMETRY_SOURCE_POLL_ID,
    command: MSP_MOTOR_CONFIG,
    intervalMs: 5_000,
    staleAfterMs: 60_000,
    priority: -3,
    initialDelayMs: 100,
    decode: decodeMotorConfig,
  });
  reconcileEscTelemetryPoll(registration);

  registration.unsubscribeScheduler = scheduler.subscribe(() => {
    if (registration.scheduler !== scheduler) {
      return;
    }
    if (registration.unregisterSource !== undefined) {
      const value = scheduler.getValue<MspMotorConfig>(
        MOTOR_TELEMETRY_SOURCE_POLL_ID,
      );
      if (value !== registration.sourceLastValue) {
        registration.sourceLastValue = value;
        // ONLY A FRESH READING MAY DECIDE THIS. A stale one is kept
        // (the flags cannot change without a write) but an error or a
        // never-answered poll leaves the source unknown rather than
        // silently reverting to "no source".
        const support =
          value.status === 'FRESH' || value.status === 'STALE'
            ? deriveMotorDiagnosticsSupport(value.value)
            : registration.support;
        if (support !== registration.support) {
          registration.support = support;
          reconcileEscTelemetryPoll(registration);
          for (const listener of Array.from(registration.listeners)) {
            try {
              listener();
            } catch {
              // One presentation listener must never break containment.
            }
          }
        }
      }
    }
    if (registration.unregisterOutputs !== undefined) {
      const value = scheduler.getValue<MspMotorOutputs>(
        MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
      );
      if (value !== registration.outputLastValue) {
        registration.outputLastValue = value;
        evaluateChannel(registration, 'outputs', value);
      }
    }
    if (registration.unregisterEscTelemetry !== undefined) {
      const value = scheduler.getValue<MspMotorTelemetry>(
        MOTOR_ESC_TELEMETRY_POLL_ID,
      );
      if (value !== registration.escLastValue) {
        registration.escLastValue = value;
        evaluateChannel(registration, 'escTelemetry', value);
      }
    }
  });

  for (const listener of Array.from(registration.listeners)) {
    listener();
  }
}

function createRegistration(sessionId: string): Registration {
  let registration!: Registration;
  registration = {
    sessionId,
    references: 0,
    escTelemetryReferences: 0,
    scheduler: undefined,
    unregisterOutputs: undefined,
    unregisterEscTelemetry: undefined,
    unregisterSource: undefined,
    unsubscribeScheduler: undefined,
    unsubscribeAvailability:
      mspSessionCoordinator.subscribeTelemetryAvailability(() =>
        attachCurrentScheduler(registration),
      ),
    unsubscribeOwnership: mspSessionCoordinator.subscribeOwnershipState(() =>
      attachCurrentScheduler(registration),
    ),
    outputLastValue: undefined,
    escLastValue: undefined,
    sourceLastValue: undefined,
    support: undefined,
    outputConsecutiveFailures: 0,
    escConsecutiveFailures: 0,
    availability: WAITING_AVAILABILITY,
    listeners: new Set(),
  };
  return registration;
}

/**
 * Reference-counted screen-level registration. It only adds read-only polls
 * to the canonical session scheduler and removes them when the final Motors
 * consumer unmounts. A replacement physical session gets fresh breakers.
 */
export function acquireMotorDiagnosticsTelemetry(
  sessionId: string,
  escTelemetryEnabled = true,
): () => void {
  let registration = registrations.get(sessionId);
  if (registration === undefined) {
    registration = createRegistration(sessionId);
    registrations.set(sessionId, registration);
  }
  registration.references += 1;
  if (escTelemetryEnabled) {
    registration.escTelemetryReferences += 1;
  }
  attachCurrentScheduler(registration);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = registrations.get(sessionId);
    if (current !== registration) {
      return;
    }
    current.references -= 1;
    if (escTelemetryEnabled) {
      current.escTelemetryReferences = Math.max(
        0,
        current.escTelemetryReferences - 1,
      );
    }
    if (current.references > 0) {
      reconcileEscTelemetryPoll(current);
      return;
    }
    detachScheduler(current);
    current.unsubscribeAvailability();
    current.unsubscribeOwnership();
    registrations.delete(sessionId);
  };
}

export function getMotorDiagnosticsAvailability(
  sessionId: string,
): MotorDiagnosticsAvailability {
  return registrations.get(sessionId)?.availability ?? WAITING_AVAILABILITY;
}

/**
 * The telemetry source this session's own MSP_MOTOR_CONFIG read proved,
 * or undefined when no reply has arrived yet.
 *
 * `undefined` is a first-class answer here and must be presented as one:
 * it means "not read yet", NOT "no source". A caller that already holds a
 * motor-test session's support keeps using that; this is what the screen
 * has to work with when no session is open.
 */
export function getMotorDiagnosticsSupport(
  sessionId: string,
): MotorDiagnosticsSupport | undefined {
  return registrations.get(sessionId)?.support;
}

export function subscribeMotorDiagnosticsAvailability(
  sessionId: string,
  listener: () => void,
): () => void {
  const registration = registrations.get(sessionId);
  if (registration === undefined) {
    return () => undefined;
  }
  registration.listeners.add(listener);
  return () => registration.listeners.delete(listener);
}
