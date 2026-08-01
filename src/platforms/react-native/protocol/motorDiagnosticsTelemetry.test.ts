import {
  MSP_MOTOR,
  MSP_MOTOR_TELEMETRY,
  MspClientError,
  MspPayloadReadError,
  type MspTelemetryScheduler,
} from '../../../core';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {
  acquireMotorDiagnosticsTelemetry,
  classifyMotorDiagnosticsFailure,
  getMotorDiagnosticsAvailability,
} from './motorDiagnosticsTelemetry';

describe('motorDiagnosticsTelemetry breaker classification', () => {
  it('stops permanently unsupported firmware commands', () => {
    expect(
      classifyMotorDiagnosticsFailure(new MspClientError('MSP_REMOTE_ERROR')),
    ).toBe('UNSUPPORTED');
  });

  it('separates malformed payloads from link failures', () => {
    expect(
      classifyMotorDiagnosticsFailure(
        new MspPayloadReadError('truncated telemetry'),
      ),
    ).toBe('MALFORMED_RESPONSE');
    expect(
      classifyMotorDiagnosticsFailure(new MspClientError('MSP_TIMEOUT')),
    ).toBe('LINK_FAILED');
    expect(
      classifyMotorDiagnosticsFailure(
        new MspClientError('MSP_DEVICE_DETACHED'),
      ),
    ).toBe('LINK_FAILED');
  });

  it('leaves one unknown transient error eligible for the bounded retry path', () => {
    expect(classifyMotorDiagnosticsFailure(new Error('temporary'))).toBe(
      undefined,
    );
  });
});

describe('motorDiagnosticsTelemetry registration lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers command 139 only while a proven ESC source has a live consumer', () => {
    const unregisterOutputs = jest.fn();
    const unregisterEscTelemetry = jest.fn();
    const unsubscribeScheduler = jest.fn();
    const unsubscribeAvailability = jest.fn();
    const unsubscribeOwnership = jest.fn();
    const registeredCommands: number[] = [];
    const scheduler = {
      registerPoll: jest.fn((config: {readonly command: number}) => {
        registeredCommands.push(config.command);
        return config.command === MSP_MOTOR
          ? unregisterOutputs
          : unregisterEscTelemetry;
      }),
      subscribe: jest.fn(() => unsubscribeScheduler),
      getValue: jest.fn(() => ({status: 'WAITING'})),
    } as unknown as MspTelemetryScheduler;

    jest
      .spyOn(mspSessionCoordinator, 'getTelemetryScheduler')
      .mockReturnValue(scheduler);
    jest
      .spyOn(mspSessionCoordinator, 'subscribeTelemetryAvailability')
      .mockReturnValue(unsubscribeAvailability);
    jest
      .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
      .mockReturnValue(unsubscribeOwnership);

    const releaseOutputsOnly = acquireMotorDiagnosticsTelemetry(
      'lifecycle-session',
      false,
    );
    expect(registeredCommands).toEqual([MSP_MOTOR]);
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'NOT_ENABLED',
    });

    const releaseEscConsumer = acquireMotorDiagnosticsTelemetry(
      'lifecycle-session',
      true,
    );
    expect(registeredCommands).toEqual([MSP_MOTOR, MSP_MOTOR_TELEMETRY]);
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'ACTIVE',
    });

    releaseEscConsumer();
    expect(unregisterEscTelemetry).toHaveBeenCalledTimes(1);
    expect(unregisterOutputs).not.toHaveBeenCalled();
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'NOT_ENABLED',
    });

    releaseOutputsOnly();
    expect(unregisterOutputs).toHaveBeenCalledTimes(1);
    expect(unsubscribeScheduler).toHaveBeenCalledTimes(1);
    expect(unsubscribeAvailability).toHaveBeenCalledTimes(1);
    expect(unsubscribeOwnership).toHaveBeenCalledTimes(1);
  });
});
