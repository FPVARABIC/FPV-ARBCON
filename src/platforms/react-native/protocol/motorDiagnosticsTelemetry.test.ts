import {
  MSP_MOTOR,
  MSP_MOTOR_CONFIG,
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
    /* WHAT CHANGED HERE, AND WHY IT IS NOT A RELAXATION.
     *
     * This test used to assert that a consumer which did not declare an
     * ESC source got MSP_MOTOR alone and a channel reading NOT_ENABLED.
     * The first half is now stronger, not weaker: the module ALSO
     * registers MSP_MOTOR_CONFIG, which is the only command that can
     * decide whether a source exists (command 139 answers a structurally
     * valid all-zero payload either way). The second half was simply
     * wrong: NOT_ENABLED is a claim about the flight controller, and with
     * `getValue` never returning a configuration - as the stub below
     * never does - nothing has read it. The honest state is
     * SOURCE_UNKNOWN, and the command-139 gate is unchanged: it is still
     * registered only for a live consumer or a PROVEN source. */
    const unregisterOutputs = jest.fn();
    const unregisterSource = jest.fn();
    const unregisterEscTelemetry = jest.fn();
    const unsubscribeScheduler = jest.fn();
    const unsubscribeAvailability = jest.fn();
    const unsubscribeOwnership = jest.fn();
    const registeredCommands: number[] = [];
    const scheduler = {
      registerPoll: jest.fn((config: {readonly command: number}) => {
        registeredCommands.push(config.command);
        if (config.command === MSP_MOTOR) return unregisterOutputs;
        if (config.command === MSP_MOTOR_CONFIG) return unregisterSource;
        return unregisterEscTelemetry;
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
    expect(registeredCommands).toEqual([MSP_MOTOR, MSP_MOTOR_CONFIG]);
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'SOURCE_UNKNOWN',
    });

    const releaseEscConsumer = acquireMotorDiagnosticsTelemetry(
      'lifecycle-session',
      true,
    );
    expect(registeredCommands).toEqual([
      MSP_MOTOR,
      MSP_MOTOR_CONFIG,
      MSP_MOTOR_TELEMETRY,
    ]);
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'ACTIVE',
    });

    releaseEscConsumer();
    expect(unregisterEscTelemetry).toHaveBeenCalledTimes(1);
    expect(unregisterOutputs).not.toHaveBeenCalled();
    // Still UNKNOWN rather than NOT_ENABLED: the stub scheduler never
    // delivered a motor configuration, so nothing was ever proven.
    expect(getMotorDiagnosticsAvailability('lifecycle-session')).toEqual({
      outputs: 'ACTIVE',
      escTelemetry: 'SOURCE_UNKNOWN',
    });

    releaseOutputsOnly();
    expect(unregisterOutputs).toHaveBeenCalledTimes(1);
    // The source poll is torn down with the rest - it is not left running
    // on a session no consumer is watching.
    expect(unregisterSource).toHaveBeenCalledTimes(1);
    expect(unsubscribeScheduler).toHaveBeenCalledTimes(1);
    expect(unsubscribeAvailability).toHaveBeenCalledTimes(1);
    expect(unsubscribeOwnership).toHaveBeenCalledTimes(1);
  });
});
