/**
 * One tiny cross-capability exclusion boundary, keyed by the canonical
 * MspClient object rather than by a caller-supplied session string.
 *
 * A configuration transaction and a motor-test session must never acquire
 * the same link concurrently. This module carries no settings, controller,
 * command, transport, or queue; it only answers whether the captured client
 * is currently owned by the configuration transaction.
 */

import type { MspRequester } from '../../../core/protocol/msp';

const ACTIVE_CLIENTS = new WeakSet<object>();

export class MotorConfigurationTransactionInProgressError extends Error {
  constructor() {
    super(
      'A motor configuration transaction is already using this MSP client.',
    );
    this.name = 'MotorConfigurationTransactionInProgressError';
  }
}

export interface MotorConfigurationInterlockLease {
  release(): void;
}

export function isMotorConfigurationTransactionActive(
  client: MspRequester,
): boolean {
  return ACTIVE_CLIENTS.has(client as object);
}

export function acquireMotorConfigurationInterlock(
  client: MspRequester,
): MotorConfigurationInterlockLease {
  const key = client as object;
  if (ACTIVE_CLIENTS.has(key)) {
    throw new MotorConfigurationTransactionInProgressError();
  }
  ACTIVE_CLIENTS.add(key);
  let released = false;
  return Object.freeze({
    release: () => {
      if (released) {
        return;
      }
      released = true;
      ACTIVE_CLIENTS.delete(key);
    },
  });
}
