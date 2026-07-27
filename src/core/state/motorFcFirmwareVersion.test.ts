/**
 * Pass 1C-P2 - tests for the motor-scoped, session-bound FC firmware
 * version acquisition.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no transport, no real MspClient, no ESC, no motor,
 * no LiPo, no timers. The requester is a hand-written fake.
 *
 * AN ACQUIRED BINDING IS NOT MOTOR-TEST READINESS, SAFETY OR
 * AUTHORIZATION. It records which firmware version the FC reported and
 * which session it was read under - nothing more.
 */

import {
  acquireMotorFcFirmwareVersion,
  motorSessionIdentitiesMatch,
  type MotorFcFirmwareVersionAcquisition,
} from './motorFcFirmwareVersion';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import type {MspRequestOptions} from '../protocol/mspClient';
import type {MspFrame} from '../protocol/mspTypes';
import {MSP_FC_VERSION} from '../protocol/msp/commands/mspCommands';

const IDENTITY: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};

function payloadFor(yearOffset: number, month: number, patch: number, text: string): Uint8Array {
  const textBytes = Array.from(text, character => character.charCodeAt(0));
  return Uint8Array.from([yearOffset, month, patch, textBytes.length, ...textBytes]);
}

const VALID_PAYLOAD = payloadFor(25, 12, 2, '2025.12.2');

type Scripted = {payload: Uint8Array} | {reject: unknown};

class FakeRequester implements MspRequester {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = [];
  /** Invoked while the request is "in flight", so a test can change the
   * session identity exactly between send and settle. */
  onRequest: (() => void) | undefined;

  constructor(private readonly scripted: Scripted = {payload: VALID_PAYLOAD}) {}

  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    this.onRequest?.();
    if ('reject' in this.scripted) {
      throw this.scripted.reject;
    }
    return {
      protocolVersion: 'v1',
      wireFormat: 'v1',
      direction: 'response',
      command,
      flags: 0,
      payload: this.scripted.payload,
    };
  }
}

/** A provider whose answer the test can change at any moment. */
function providerFor(initial: MotorStaticFactsSessionIdentity | undefined) {
  const box: {current: MotorStaticFactsSessionIdentity | undefined} = {current: initial};
  return {box, read: () => box.current};
}

async function acquireWith(
  requester: FakeRequester,
  current: MotorStaticFactsSessionIdentity = IDENTITY,
  expected: MotorStaticFactsSessionIdentity = IDENTITY,
): Promise<MotorFcFirmwareVersionAcquisition> {
  const {read} = providerFor(current);
  return acquireMotorFcFirmwareVersion({
    requester,
    expectedIdentity: expected,
    readCurrentIdentity: read,
  });
}

describe('motorSessionIdentitiesMatch', () => {
  it('matches only when BOTH fields are equal', () => {
    expect(motorSessionIdentitiesMatch(IDENTITY, {physicalGeneration: 3, mspEpoch: 11})).toBe(true);
    expect(motorSessionIdentitiesMatch(IDENTITY, {physicalGeneration: 4, mspEpoch: 11})).toBe(false);
    expect(motorSessionIdentitiesMatch(IDENTITY, {physicalGeneration: 3, mspEpoch: 12})).toBe(false);
  });

  it('never matches when either side is absent', () => {
    expect(motorSessionIdentitiesMatch(undefined, IDENTITY)).toBe(false);
    expect(motorSessionIdentitiesMatch(IDENTITY, undefined)).toBe(false);
    expect(motorSessionIdentitiesMatch(undefined, undefined)).toBe(false);
  });
});

describe('acquireMotorFcFirmwareVersion - success', () => {
  it('requests command 3 exactly once with an EMPTY payload', async () => {
    const requester = new FakeRequester();
    await acquireWith(requester);

    expect(requester.calls).toHaveLength(1);
    expect(requester.calls[0].command).toBe(MSP_FC_VERSION);
    expect(requester.calls[0].command).toBe(3);
    expect(requester.calls[0].payload).toEqual(new Uint8Array(0));
    expect(requester.calls[0].payload.length).toBe(0);
  });

  it('returns a complete binding carrying the snapshot and the session identity', async () => {
    const result = await acquireWith(new FakeRequester());

    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    expect(result.binding.sessionIdentity).toEqual({physicalGeneration: 3, mspEpoch: 11});
    expect(result.binding.firmwareVersion).toEqual({
      yearOffsetRaw: 25,
      year: 2025,
      month: 12,
      patch: 2,
      versionString: '2025.12.2',
      suffix: null,
    });
    expect(Object.keys(result.binding).sort()).toEqual(['firmwareVersion', 'sessionIdentity']);
  });

  it('preserves a suffixed pre-release without treating it as the final release', async () => {
    const requester = new FakeRequester({payload: payloadFor(25, 12, 2, '2025.12.2-RC1')});
    const result = await acquireWith(requester);

    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    expect(result.binding.firmwareVersion.versionString).toBe('2025.12.2-RC1');
    expect(result.binding.firmwareVersion.suffix).toBe('RC1');
  });

  it('freezes the acquisition, the binding, the snapshot and the identity copy', async () => {
    const result = await acquireWith(new FakeRequester());
    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen(result.binding.firmwareVersion)).toBe(true);
    expect(Object.isFrozen(result.binding.sessionIdentity)).toBe(true);
    expect(Reflect.set(result.binding.firmwareVersion, 'patch', 99)).toBe(false);
    expect(result.binding.firmwareVersion.patch).toBe(2);
  });

  it('copies the identity rather than retaining the caller-owned object', async () => {
    const expected = {physicalGeneration: 3, mspEpoch: 11};
    const {read} = providerFor(IDENTITY);
    const result = await acquireMotorFcFirmwareVersion({
      requester: new FakeRequester(),
      expectedIdentity: expected,
      readCurrentIdentity: read,
    });

    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    expect(result.binding.sessionIdentity).not.toBe(expected);
    expected.physicalGeneration = 99;
    expect(result.binding.sessionIdentity.physicalGeneration).toBe(3);
  });

  it('creates a fresh binding and exactly one request per explicit acquisition', async () => {
    const first = await acquireWith(new FakeRequester());
    const secondRequester = new FakeRequester();
    const second = await acquireWith(secondRequester);

    expect(secondRequester.calls).toHaveLength(1);
    expect(first.kind).toBe('ACQUIRED');
    expect(second.kind).toBe('ACQUIRED');
    if (first.kind !== 'ACQUIRED' || second.kind !== 'ACQUIRED') {
      return;
    }
    expect(first.binding).not.toBe(second.binding);
    expect(first.binding).toEqual(second.binding);
  });
});

describe('acquireMotorFcFirmwareVersion - identity gating BEFORE the request', () => {
  it('fails without requesting when there is no current identity', async () => {
    // Called directly rather than through acquireWith(): passing an
    // explicit `undefined` to a defaulted parameter would silently
    // reinstate the default identity and make this test vacuous.
    const requester = new FakeRequester();
    const result = await acquireMotorFcFirmwareVersion({
      requester,
      expectedIdentity: IDENTITY,
      readCurrentIdentity: () => undefined,
    });

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_UNAVAILABLE'});
    expect(requester.calls).toHaveLength(0);
  });

  it('fails without requesting on a physicalGeneration mismatch', async () => {
    const requester = new FakeRequester();
    const result = await acquireWith(requester, {physicalGeneration: 4, mspEpoch: 11});

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_MISMATCH'});
    expect(requester.calls).toHaveLength(0);
  });

  it('fails without requesting on an mspEpoch mismatch', async () => {
    const requester = new FakeRequester();
    const result = await acquireWith(requester, {physicalGeneration: 3, mspEpoch: 12});

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_MISMATCH'});
    expect(requester.calls).toHaveLength(0);
  });
});

describe('acquireMotorFcFirmwareVersion - identity change DURING the request', () => {
  it('discards the response when physicalGeneration changes in flight', async () => {
    const requester = new FakeRequester();
    const {box, read} = providerFor(IDENTITY);
    requester.onRequest = () => {
      box.current = {physicalGeneration: 4, mspEpoch: 11};
    };

    const result = await acquireMotorFcFirmwareVersion({
      requester,
      expectedIdentity: IDENTITY,
      readCurrentIdentity: read,
    });

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_CHANGED'});
    expect(requester.calls).toHaveLength(1);
  });

  it('discards the response when mspEpoch changes in flight', async () => {
    const requester = new FakeRequester();
    const {box, read} = providerFor(IDENTITY);
    requester.onRequest = () => {
      box.current = {physicalGeneration: 3, mspEpoch: 12};
    };

    const result = await acquireMotorFcFirmwareVersion({
      requester,
      expectedIdentity: IDENTITY,
      readCurrentIdentity: read,
    });

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_CHANGED'});
  });

  it('discards the response when the session disappears entirely in flight', async () => {
    const requester = new FakeRequester();
    const {box, read} = providerFor(IDENTITY);
    requester.onRequest = () => {
      box.current = undefined;
    };

    const result = await acquireMotorFcFirmwareVersion({
      requester,
      expectedIdentity: IDENTITY,
      readCurrentIdentity: read,
    });

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'SESSION_IDENTITY_CHANGED'});
  });

  it('never combines a response from one identity with another identity', async () => {
    // The FC answers with a perfectly valid version, but for a session
    // that is no longer current: no binding may be produced at all.
    const requester = new FakeRequester({payload: VALID_PAYLOAD});
    const {box, read} = providerFor(IDENTITY);
    requester.onRequest = () => {
      box.current = {physicalGeneration: 4, mspEpoch: 99};
    };

    const result = await acquireMotorFcFirmwareVersion({
      requester,
      expectedIdentity: IDENTITY,
      readCurrentIdentity: read,
    });

    expect(result.kind).toBe('UNAVAILABLE');
    expect(Object.keys(result)).not.toContain('binding');
  });
});

describe('acquireMotorFcFirmwareVersion - failure is closed and never retried', () => {
  it('returns REQUEST_FAILED on a rejected request, with no retry', async () => {
    const requester = new FakeRequester({reject: new Error('simulated MSP_TIMEOUT')});
    const result = await acquireWith(requester);

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'});
    expect(requester.calls).toHaveLength(1);
  });

  it('returns MALFORMED_RESPONSE on a truncated payload, with no retry', async () => {
    const requester = new FakeRequester({payload: Uint8Array.from([25, 12])});
    const result = await acquireWith(requester);

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'MALFORMED_RESPONSE'});
    expect(requester.calls).toHaveLength(1);
  });

  it('returns MALFORMED_RESPONSE on a semantic contradiction', async () => {
    const requester = new FakeRequester({payload: payloadFor(25, 12, 2, '2025.12.5')});
    const result = await acquireWith(requester);

    expect(result).toEqual({kind: 'UNAVAILABLE', reason: 'MALFORMED_RESPONSE'});
  });

  it('publishes no partial binding on any failure path', async () => {
    const failures = [
      new FakeRequester({reject: new Error('boom')}),
      new FakeRequester({payload: Uint8Array.from([])}),
      new FakeRequester({payload: payloadFor(25, 13, 2, '2025.13.2')}),
    ];
    for (const requester of failures) {
      const result = await acquireWith(requester);
      expect(result.kind).toBe('UNAVAILABLE');
      expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
    }
  });
});

describe('acquireMotorFcFirmwareVersion - no substitution and no hidden machinery', () => {
  it('never falls back to an API version, variant, user input or build constant', async () => {
    // The ONLY input that can produce a version is the FC response: a
    // failed request yields no version at all rather than a stand-in.
    const requester = new FakeRequester({reject: new Error('no answer')});
    const result = await acquireWith(requester);

    expect(result.kind).toBe('UNAVAILABLE');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('2025.12.2');
    expect(serialized).not.toContain('BTFL');
    expect(serialized).not.toContain('1.47');
  });

  it('reads the FC response and nothing else for the version text', async () => {
    // A DIFFERENT coherent version flows straight through, proving the
    // value comes from the wire rather than from a pinned constant.
    const requester = new FakeRequester({payload: payloadFor(25, 12, 5, '2025.12.5')});
    const result = await acquireWith(requester);

    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    expect(result.binding.firmwareVersion.versionString).toBe('2025.12.5');
  });

  it('exposes no readiness, safety, authorization or motor-write surface', async () => {
    const result = await acquireWith(new FakeRequester());
    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    const keys = [
      ...Object.keys(result.binding),
      ...Object.keys(result.binding.firmwareVersion),
      ...Object.keys(result.binding.sessionIdentity),
    ];
    for (const key of keys) {
      expect(key).not.toMatch(
        /safe|ready|canTest|canPulse|authorized|pulse|motorIdle|payload|stop|armed|battery|rpm|temp/i,
      );
    }
  });

  it('stores no requester, transport, callback or other runtime owner in the binding', async () => {
    const result = await acquireWith(new FakeRequester());
    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      return;
    }
    const values = [
      ...Object.values(result.binding),
      ...Object.values(result.binding.firmwareVersion),
      ...Object.values(result.binding.sessionIdentity),
    ];
    for (const value of values) {
      expect(typeof value).not.toBe('function');
    }
    expect(JSON.parse(JSON.stringify(result.binding))).toEqual(result.binding);
  });
});
