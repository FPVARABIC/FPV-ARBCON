import { MspClientError, MspPayloadReadError } from '../../../core';
import { classifyMotorDiagnosticsFailure } from './motorDiagnosticsTelemetry';

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
