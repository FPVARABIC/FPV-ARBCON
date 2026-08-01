import { FakeMspTransport } from '../../../core/protocol/__testUtils__/mspFakeTransport';
import { MspClient } from '../../../core/protocol/mspClient';
import {
  acquireMotorConfigurationInterlock,
  isMotorConfigurationTransactionActive,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';

describe('motor configuration / motor test interlock', () => {
  it('is reference-scoped, rejects overlap, and releases idempotently', () => {
    const first = new MspClient(new FakeMspTransport(), 'interlock-a');
    const second = new MspClient(new FakeMspTransport(), 'interlock-b');
    const lease = acquireMotorConfigurationInterlock(first);

    expect(isMotorConfigurationTransactionActive(first)).toBe(true);
    expect(isMotorConfigurationTransactionActive(second)).toBe(false);
    expect(() => acquireMotorConfigurationInterlock(first)).toThrow(
      MotorConfigurationTransactionInProgressError,
    );
    expect(() => acquireMotorConfigurationInterlock(second)).not.toThrow();

    lease.release();
    lease.release();
    expect(isMotorConfigurationTransactionActive(first)).toBe(false);
    expect(() => acquireMotorConfigurationInterlock(first)).not.toThrow();
  });
});
