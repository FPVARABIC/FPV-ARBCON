import {
  decodeMotorOutputs,
  decodeMotorTelemetry,
  MSP_MOTOR,
  MSP_MOTOR_TELEMETRY,
  MspClientError,
  MspPayloadReadError,
  type MspMotorOutputs,
  type MspMotorTelemetry,
  type MspTelemetryScheduler,
  type TelemetryValue,
} from '../../../core';
import { mspSessionCoordinator } from './MspSessionCoordinator';

export const MOTOR_OUTPUTS_TELEMETRY_POLL_ID = 'motorOutputs';
export const MOTOR_ESC_TELEMETRY_POLL_ID = 'motorEscTelemetry';

export type MotorDiagnosticsChannelState =
  | 'WAITING_FOR_SESSION'
  | 'ACTIVE'
  | 'NOT_ENABLED'
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
  unsubscribeScheduler: (() => void) | undefined;
  unsubscribeAvailability: () => void;
  unsubscribeOwnership: () => void;
  outputLastValue: TelemetryValue<MspMotorOutputs> | undefined;
  escLastValue: TelemetryValue<MspMotorTelemetry> | undefined;
  outputConsecutiveFailures: number;
  escConsecutiveFailures: number;
  availability: MotorDiagnosticsAvailability;
  readonly listeners: Set<() => void>;
}

const registrations = new Map<string, Registration>();

function waitingAvailability(
  registration: Pick<Registration, 'escTelemetryReferences'>,
): MotorDiagnosticsAvailability {
  return Object.freeze({
    outputs: 'WAITING_FOR_SESSION',
    escTelemetry:
      registration.escTelemetryReferences > 0
        ? 'WAITING_FOR_SESSION'
        : 'NOT_ENABLED',
  });
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
  registration.scheduler = undefined;
  registration.outputLastValue = undefined;
  registration.escLastValue = undefined;
  registration.outputConsecutiveFailures = 0;
  registration.escConsecutiveFailures = 0;
  registration.availability = waitingAvailability(registration);
}

function reconcileEscTelemetryPoll(registration: Registration): void {
  const scheduler = registration.scheduler;
  if (scheduler === undefined) {
    publish(
      registration,
      'escTelemetry',
      registration.escTelemetryReferences > 0
        ? 'WAITING_FOR_SESSION'
        : 'NOT_ENABLED',
    );
    return;
  }
  if (registration.escTelemetryReferences <= 0) {
    registration.unregisterEscTelemetry?.();
    registration.unregisterEscTelemetry = undefined;
    registration.escLastValue = undefined;
    registration.escConsecutiveFailures = 0;
    publish(registration, 'escTelemetry', 'NOT_ENABLED');
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
    escTelemetry:
      registration.escTelemetryReferences > 0 ? 'ACTIVE' : 'NOT_ENABLED',
  });
  registration.unregisterOutputs = scheduler.registerPoll<MspMotorOutputs>({
    id: MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
    command: MSP_MOTOR,
    intervalMs: 150,
    staleAfterMs: 750,
    priority: -1,
    decode: decodeMotorOutputs,
  });
  reconcileEscTelemetryPoll(registration);

  registration.unsubscribeScheduler = scheduler.subscribe(() => {
    if (registration.scheduler !== scheduler) {
      return;
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
