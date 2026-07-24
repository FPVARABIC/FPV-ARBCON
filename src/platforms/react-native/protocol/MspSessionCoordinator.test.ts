import {MspSessionCoordinator, MspOwnershipActivationError, ATTITUDE_TELEMETRY_POLL_ID} from './MspSessionCoordinator';
import type {MspSessionOwnershipState} from './MspSessionCoordinator';
import {RNMspTransport} from './RNMspTransport';
import {MspClient, MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO, MSP_ATTITUDE} from '../../../core';
import type {MspAttitude} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** A valid MSP_API_VERSION response payload. */
function apiVersionPayload(apiVersionMinor = 48): Uint8Array {
  return Uint8Array.from([0, 1, apiVersionMinor]);
}

function fcVariantPayload(identifier = 'BTFL'): Uint8Array {
  return Uint8Array.from(ascii(identifier));
}

/** A valid, minimal MSP_BOARD_INFO response payload (guaranteed prefix only). */
function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16le(0),
    0,
    0,
    ...pstring('TEST'),
    ...pstring('MyBoard'),
    ...pstring('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}

/** A valid MSP_ATTITUDE response payload: 3 signed LE16 fields
 * (roll/pitch decidegrees, yaw whole degrees - see decodeAttitude.ts). */
function attitudePayload(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): Uint8Array {
  const s16le = (value: number) => {
    const unsigned = value < 0 ? value + 0x10000 : value;
    return [unsigned & 0xff, (unsigned >> 8) & 0xff];
  };
  return Uint8Array.from([...s16le(rollDecidegrees), ...s16le(pitchDecidegrees), ...s16le(yawDegrees)]);
}

/**
 * Drains microtask chains ONLY (never a real/fake timer) - every test in
 * this file is deliberately structured so identify() either resolves via a
 * scripted response frame (a chain of Promise.resolve().then() hops) or
 * via MspClient.dispose()'s own SYNCHRONOUS rejection, never by waiting
 * out MSP_RESPONSE_TIMEOUT_MILLIS/MSP_PROBE_TIMEOUT_MILLIS - so no fake
 * timers are needed anywhere in this file, and this loop of plain
 * microtask hops is sufficient (and portable) to let any such chain fully
 * settle before assertions run.
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

interface FakeClient {
  writeBytes: jest.Mock;
  onDataReceived: jest.Mock;
  onSessionDetached: jest.Mock;
  stopReading: jest.Mock;
  startReading: jest.Mock;
  emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => void;
  setResponse: (command: number, payload: Uint8Array) => void;
  /** Only meaningful when constructed with {deferStartReading: true} -
   * resolves the pending startReading() Promise on demand. A no-op
   * (never referenced) for every fake built without that option. */
  resolveStartReading: () => void;
  /** Pass 7.4, Step 4: marks the NEXT writeBytes() call to reject instead
   * of resolving - mirrors mspClient.test.ts's own FakeMspTransport
   * rejectNextWrite(), the standard way this codebase triggers a real
   * desync/recovery cycle in a test. Never referenced by any test that
   * doesn't explicitly call it, so this is purely additive. */
  rejectNextWrite: (reason?: unknown) => void;
}

/**
 * A single, consistent fake client for every test in this file - scriptable
 * per-command via setResponse(), so identify()'s sequential MSP_API_VERSION
 * -> MSP_FC_VARIANT -> MSP_BOARD_INFO round trips can be made to resolve
 * cleanly and deterministically (via real, checksummed MSP v1 response
 * frames built with buildMspFrameBytes(), the same test-only frame builder
 * mspStreamParser.test.ts/mspClient.test.ts already use) without ever
 * needing a real or fake timer.
 */
function makeFakeClient(
  sessionId: string,
  options: {neverResolveWrite?: boolean; deferStartReading?: boolean} = {},
): FakeClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const sessionDetachedListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  let resolveStartReadingImpl: () => void = () => undefined;
  const startReadingPromise = options.deferStartReading
    ? new Promise<void>(resolve => {
        resolveStartReadingImpl = resolve;
      })
    : Promise.resolve(undefined);
  let rejectNextWriteReason: {reason: unknown} | undefined;

  const emitFrame = (command: number, payload: Uint8Array) => {
    const frameBytes = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
    const event: UsbSerialDataEvent = {sessionId, dataBase64: bytesToBase64(frameBytes)};
    for (const listener of Array.from(dataListeners)) {
      listener(event);
    }
  };

  return {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      // neverResolveWrite: deliberately never settles - see
      // makeQuietFakeClient()'s own doc comment for why.
      if (options.neverResolveWrite) {
        return new Promise<void>(() => undefined);
      }
      if (rejectNextWriteReason) {
        const {reason} = rejectNextWriteReason;
        rejectNextWriteReason = undefined;
        return Promise.reject(reason);
      }
      const bytes = base64ToBytes(dataBase64);
      // v1 request frame layout: $ M < size command ...payload checksum -
      // command is byte index 4 for any non-jumbo (small) payload, which
      // every identify() request is.
      const command = bytes[4];
      const payload = responses.get(command);
      if (payload) {
        // A microtask hop, not synchronous - mirrors a real write's own
        // async settlement, and keeps ordering deterministic without
        // relying on exactly-synchronous re-entrancy into the parser.
        Promise.resolve().then(() => emitFrame(command, payload));
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn((cb: (event: UsbSerialSessionDetachedEvent) => void) => {
      sessionDetachedListeners.add(cb);
      return jest.fn(() => sessionDetachedListeners.delete(cb));
    }),
    stopReading: jest.fn().mockResolvedValue(undefined),
    startReading: jest.fn(() => startReadingPromise),
    resolveStartReading: () => {
      resolveStartReadingImpl();
    },
    emitSessionDetached: event => {
      for (const listener of Array.from(sessionDetachedListeners)) {
        listener(event);
      }
    },
    setResponse: (command, payload) => {
      responses.set(command, payload);
    },
    rejectNextWrite: (reason: unknown = new Error('fake write failure')) => {
      rejectNextWriteReason = {reason};
    },
  };
}

/** A fake client scripted to let identify() succeed cleanly, via real
 * (fake) response frames - for tests that explicitly await flushAsync()
 * and assert on identify()'s own outcome. */
function makeHappyFakeClient(sessionId: string): FakeClient {
  const client = makeFakeClient(sessionId);
  client.setResponse(MSP_API_VERSION, apiVersionPayload());
  client.setResponse(MSP_FC_VARIANT, fcVariantPayload());
  client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  return client;
}

/**
 * For tests that genuinely don't care what happens to the fire-and-forget
 * identify() call openSession() starts (most of the renamed Pass 6.3
 * tests below, and the dispose-ordering tests, which only assert on
 * openSession()'s own return value / spy-recorded dispose order) -
 * writeBytes() never settles at all, so MspClient's own onWriteSettled()
 * never runs and therefore never starts its real MSP_RESPONSE_TIMEOUT_MILLIS
 * setTimeout in the first place. This sidesteps entirely (rather than
 * merely mitigating) any risk of a real background timer surviving past
 * a synchronous test's own return - these tests never flush/await
 * anything, so there is no other point at which such a timer could be
 * reliably cleared.
 */
function makeQuietFakeClient(sessionId: string): FakeClient {
  return makeFakeClient(sessionId, {neverResolveWrite: true});
}

describe('MspSessionCoordinator - one MspClient per session (Pass 6.3, renamed/extended for Pass 6.4b)', () => {
  it('two different call sites into openSession() for the same sessionId observe the SAME MspClient instance', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    const fromScreenA = coordinator.openSession(client, SESSION_ID);
    const fromScreenB = coordinator.openSession(client, SESSION_ID);

    expect(fromScreenA).toBeInstanceOf(MspClient);
    expect(fromScreenA).toBe(fromScreenB);
  });

  it('getActiveMspClient() returns the same instance openSession() already created', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    const opened = coordinator.openSession(client, SESSION_ID);
    const fetched = coordinator.getActiveMspClient(SESSION_ID);

    expect(fetched).toBe(opened);
  });

  it('getActiveMspClient() returns undefined for a session that was never opened', () => {
    const coordinator = new MspSessionCoordinator();
    expect(coordinator.getActiveMspClient('never-opened')).toBeUndefined();
  });

  it('getActiveTransport() returns the same RNMspTransport instance openSession() internally created, stably across repeated calls', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    coordinator.openSession(client, SESSION_ID);
    const first = coordinator.getActiveTransport(SESSION_ID);
    const second = coordinator.getActiveTransport(SESSION_ID);

    expect(first).toBeInstanceOf(RNMspTransport);
    expect(first).toBe(second);
  });

  it('getActiveTransport() returns undefined for a never-opened session, and again after it is deactivated', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    expect(coordinator.getActiveTransport('never-opened')).toBeUndefined();

    coordinator.openSession(client, SESSION_ID);
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeInstanceOf(RNMspTransport);

    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeUndefined();
  });

  it('a different sessionId gets a different MspClient instance', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    const first = coordinator.openSession(client, SESSION_ID);
    const second = coordinator.openSession(client, OTHER_SESSION_ID);

    expect(first).not.toBe(second);
  });
});

describe('MspSessionCoordinator - Pass 7.1 getSessionKey()', () => {
  it('returns a stable {sessionId, generation} key for an active session across repeated calls', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    coordinator.openSession(client, SESSION_ID);
    const first = coordinator.getSessionKey(SESSION_ID);
    const second = coordinator.getSessionKey(SESSION_ID);

    expect(first).toEqual({sessionId: SESSION_ID, generation: expect.any(Number)});
    expect(second).toEqual(first);
  });

  it('returns undefined for a never-opened session, and again after it is deactivated', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    expect(coordinator.getSessionKey('never-opened')).toBeUndefined();

    coordinator.openSession(client, SESSION_ID);
    expect(coordinator.getSessionKey(SESSION_ID)).not.toBeUndefined();

    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getSessionKey(SESSION_ID)).toBeUndefined();
  });

  it('the generation component changes across deactivate+reopen for the same reused sessionId string', () => {
    const coordinator = new MspSessionCoordinator();
    const firstClient = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    coordinator.openSession(firstClient, SESSION_ID);
    const firstKey = coordinator.getSessionKey(SESSION_ID);
    expect(firstKey).toBeDefined();

    coordinator.deactivateMspSession(SESSION_ID);

    const secondClient = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;
    coordinator.openSession(secondClient, SESSION_ID);
    const secondKey = coordinator.getSessionKey(SESSION_ID);

    expect(secondKey).toBeDefined();
    expect(secondKey!.sessionId).toBe(firstKey!.sessionId);
    expect(secondKey!.generation).not.toBe(firstKey!.generation);
  });
});

describe('MspSessionCoordinator - dispose ordering (Pass 6.3, renamed for Pass 6.4b)', () => {
  it('deactivateMspSession() disposes MspClient BEFORE RNMspTransport, verified via a spy', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;
    const mspClient = coordinator.openSession(client, SESSION_ID);

    const order: string[] = [];
    const mspClientDisposeSpy = jest.spyOn(mspClient, 'dispose').mockImplementation(() => {
      order.push('MspClient.dispose');
    });
    const transportDisposeSpy = jest.spyOn(RNMspTransport.prototype, 'dispose').mockImplementation(() => {
      order.push('RNMspTransport.dispose');
    });

    coordinator.deactivateMspSession(SESSION_ID);

    expect(order).toEqual(['MspClient.dispose', 'RNMspTransport.dispose']);

    mspClientDisposeSpy.mockRestore();
    transportDisposeSpy.mockRestore();
  });

  it('deactivateMspSession() removes the session, so a later openSession() for the same id creates a fresh pairing', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;
    const first = coordinator.openSession(client, SESSION_ID);

    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();

    const second = coordinator.openSession(client, SESSION_ID);
    expect(second).not.toBe(first);
  });

  it('deactivateMspSession() for an unknown sessionId is a harmless no-op', () => {
    const coordinator = new MspSessionCoordinator();
    expect(() => coordinator.deactivateMspSession('never-opened')).not.toThrow();
  });

  it('a physical detach (no explicit deactivateMspSession() call) disposes MspClient BEFORE RNMspTransport automatically', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);

    const order: string[] = [];
    const mspClientDisposeSpy = jest.spyOn(mspClient, 'dispose').mockImplementation(() => {
      order.push('MspClient.dispose');
    });
    const transportDisposeSpy = jest.spyOn(RNMspTransport.prototype, 'dispose').mockImplementation(() => {
      order.push('RNMspTransport.dispose');
    });

    // Nobody calls deactivateMspSession() - the transport itself reports the detach.
    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(order).toEqual(['MspClient.dispose', 'RNMspTransport.dispose']);
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();

    mspClientDisposeSpy.mockRestore();
    transportDisposeSpy.mockRestore();
  });

  it('a physical detach for a different sessionId does not dispose this session', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);

    client.emitSessionDetached({sessionId: OTHER_SESSION_ID, deviceId: 1});

    expect(coordinator.getActiveMspClient(SESSION_ID)).toBe(mspClient);
  });
});

describe('MspSessionCoordinator - Pass 6.4b ownership lifecycle', () => {
  it('openSession() transitions INACTIVE -> ACTIVATING -> ACTIVE on success, in order', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');

    const observed: MspSessionOwnershipState[] = [];
    coordinator.subscribeOwnershipState(() => {
      observed.push(coordinator.getOwnershipState(SESSION_ID));
    });

    coordinator.openSession(client, SESSION_ID);

    expect(observed).toEqual(['ACTIVATING', 'ACTIVE']);
  });

  it('beginIdentification() (and therefore identify()\'s first writeBytes()) never fires until startReading() genuinely resolves - not merely issued in the same synchronous turn', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID, {deferStartReading: true});
    client.setResponse(MSP_API_VERSION, apiVersionPayload());
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload());
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);

    // startReading() was called (the fix's whole point), but its Promise is
    // deliberately left unresolved by this fake client until
    // resolveStartReading() is called below - proving the corrected
    // sequencing, not just that the call was issued.
    expect(client.startReading).toHaveBeenCalledWith(SESSION_ID);
    await flushAsync();
    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'IDLE'});

    client.resolveStartReading();
    await flushAsync();

    // Only NOW, after startReading() genuinely resolved, does identify()'s
    // first request (and therefore its first writeBytes() call) happen.
    expect(client.writeBytes).toHaveBeenCalled();
    const identification = coordinator.getIdentificationState(SESSION_ID);
    expect(identification.status).toBe('SUCCEEDED');
  });

  it('a startReading() rejection tears the session down (ACTIVE -> INACTIVE directly, skipping CLOSING) and never starts identification', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID);
    client.startReading.mockRejectedValueOnce({code: 'RX_ALREADY_ACTIVE', nativeMessage: 'x'});

    const observed: MspSessionOwnershipState[] = [];
    coordinator.subscribeOwnershipState(() => {
      observed.push(coordinator.getOwnershipState(SESSION_ID));
    });

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    expect(observed).toEqual(['ACTIVATING', 'ACTIVE', 'INACTIVE']);
    expect(observed).not.toContain('CLOSING');
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeUndefined();
    // Never even reached beginIdentification() - stayed IDLE throughout.
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'IDLE'});
  });

  it('a construction failure reverts ACTIVATING -> INACTIVE, cleans up fully, and re-throws MspOwnershipActivationError', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID);
    client.onDataReceived.mockImplementationOnce(() => {
      throw new Error('boom - simulated construction failure');
    });

    const observed: MspSessionOwnershipState[] = [];
    coordinator.subscribeOwnershipState(() => {
      observed.push(coordinator.getOwnershipState(SESSION_ID));
    });

    expect(() =>
      coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID),
    ).toThrow(MspOwnershipActivationError);

    expect(observed).toEqual(['ACTIVATING', 'INACTIVE']);
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeUndefined();
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();
  });

  it('calling openSession() again while ACTIVE returns the SAME MspClient, constructs nothing new, and never starts a second identify() round', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    const uClient = client as unknown as UsbSerialTransportClient;

    const first = coordinator.openSession(uClient, SESSION_ID);
    const second = coordinator.openSession(uClient, SESSION_ID);

    expect(first).toBe(second);

    await flushAsync();

    // Exactly one identify() round (API_VERSION, FC_VARIANT, BOARD_INFO) -
    // 3 writeBytes() calls total, not 6.
    expect(client.writeBytes).toHaveBeenCalledTimes(3);
  });

  it('identify() failure (malformed response) leaves ownership at ACTIVE and sets identificationState to FAILED', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID);
    // Too short for decodeApiVersion() - the REQUEST itself succeeds (a
    // real, matching frame arrives), only the decode step fails, so this
    // never touches MspClient's own desync/recovery machinery at all.
    client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1]));

    const observed: MspSessionOwnershipState[] = [];
    coordinator.subscribeOwnershipState(() => {
      observed.push(coordinator.getOwnershipState(SESSION_ID));
    });

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    expect(observed).toEqual(['ACTIVATING', 'ACTIVE']);
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('ACTIVE');
    expect(coordinator.getIdentificationState(SESSION_ID).status).toBe('FAILED');
  });

  it('identify() success sets identificationState to SUCCEEDED with the correct identity and populates the metrics snapshot', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const identification = coordinator.getIdentificationState(SESSION_ID);
    expect(identification.status).toBe('SUCCEEDED');
    if (identification.status === 'SUCCEEDED') {
      expect(identification.identity.firmware).toEqual({identifier: 'BTFL', knownFamily: 'BETAFLIGHT'});
      expect(identification.identity.board.targetName).toBe('TEST');
    }

    const metrics = coordinator.getIdentificationMetrics(SESSION_ID);
    expect(metrics).toBeDefined();
    expect(metrics?.completedFrameCount).toBeGreaterThanOrEqual(3);
    expect(metrics?.nativeChunkCount).toBeGreaterThanOrEqual(3);
    expect(metrics?.completedAtMs).toBeDefined();
    expect(metrics?.durationMs).toBeDefined();
    expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('physical detach while identification is RUNNING discards the eventual late result and moves ownership DIRECTLY from ACTIVE to INACTIVE, without visiting CLOSING', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID);
    // Deliberately no responses scripted - the only thing that will ever
    // settle this pending request is the detach below, via
    // MspClient.dispose()'s own synchronous MSP_SESSION_CLOSED rejection.
    const uClient = client as unknown as UsbSerialTransportClient;

    const observed: MspSessionOwnershipState[] = [];
    coordinator.subscribeOwnershipState(() => {
      observed.push(coordinator.getOwnershipState(SESSION_ID));
    });

    coordinator.openSession(uClient, SESSION_ID);
    // beginIdentification() is now chained onto startReading()'s own
    // resolution (the corrected fix this test file was updated for) - a
    // flush is required before identificationState genuinely reaches
    // RUNNING, whereas before that fix it was set synchronously within
    // openSession() itself.
    await flushAsync();
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'RUNNING'});

    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(observed).toEqual(['ACTIVATING', 'ACTIVE', 'INACTIVE']);
    expect(observed).not.toContain('CLOSING');
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');

    await flushAsync();

    // The late (now-superseded) identify() rejection must never be recorded.
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'IDLE'});
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();
  });

  it('deactivateMspSession() sequence order verified via spies: CLOSING -> MspClient.dispose() -> RNMspTransport.dispose() -> INACTIVE, in exactly that order', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);

    const order: string[] = [];
    coordinator.subscribeOwnershipState(() => {
      order.push(`ownership:${coordinator.getOwnershipState(SESSION_ID)}`);
    });
    const mspClientDisposeSpy = jest.spyOn(mspClient, 'dispose').mockImplementation(() => {
      order.push('MspClient.dispose');
    });
    const transportDisposeSpy = jest.spyOn(RNMspTransport.prototype, 'dispose').mockImplementation(() => {
      order.push('RNMspTransport.dispose');
    });

    coordinator.deactivateMspSession(SESSION_ID);

    expect(order).toEqual(['ownership:CLOSING', 'MspClient.dispose', 'RNMspTransport.dispose', 'ownership:INACTIVE']);

    mspClientDisposeSpy.mockRestore();
    transportDisposeSpy.mockRestore();
  });

  it('deactivateMspSession() also discards a late in-flight identify() result via the generation-token invalidation', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID); // no responses scripted
    const uClient = client as unknown as UsbSerialTransportClient;

    coordinator.openSession(uClient, SESSION_ID);
    // See the physical-detach test above's identical comment - a flush is
    // now required before identificationState reaches RUNNING.
    await flushAsync();
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'RUNNING'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();

    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'IDLE'});
  });

  it('reusing the same sessionId for a genuinely new session (deactivate, then reopen, before the old identify() settles) never lets the old identify() result contaminate the new session', async () => {
    const coordinator = new MspSessionCoordinator();
    // No response scripted - the OLD session's identify() request is left
    // pending, only ever settled by deactivateMspSession()'s own
    // MspClient.dispose() call below (a SYNCHRONOUS rejection, but its
    // .then()/.catch() handler - beginIdentification()'s finish() - only
    // ever runs as a MICROTASK, per the JS spec: it cannot run until the
    // current synchronous call stack fully unwinds).
    const oldClient = makeFakeClient(SESSION_ID);
    const oldMspClient = coordinator.openSession(oldClient as unknown as UsbSerialTransportClient, SESSION_ID);
    // beginIdentification() is chained onto startReading()'s resolution
    // (the corrected fix) - flushed once here so the OLD session's
    // identify() request is genuinely in flight (RUNNING) before it gets
    // torn down below, matching this test's own stated scenario.
    await flushAsync();
    expect(coordinator.getIdentificationState(SESSION_ID)).toEqual({status: 'RUNNING'});

    // Intentional close: invalidates the OLD generation token and disposes
    // the OLD MspClient (queuing its pending request's rejection as a
    // microtask - not yet run).
    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');

    // Reused sessionId, reopened for a genuinely NEW session/client pairing
    // - synchronously, in the very next statement, well before the old
    // identify()'s pending rejection microtask has had any chance to run.
    // This is the realistic ordering this scenario is named for: a fast
    // disconnect/reconnect cycle where the native layer happens to reuse
    // the same session identifier.
    const newClient = makeHappyFakeClient(SESSION_ID);
    const newMspClient = coordinator.openSession(newClient as unknown as UsbSerialTransportClient, SESSION_ID);
    expect(newMspClient).not.toBe(oldMspClient);
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('ACTIVE');

    await flushAsync();

    // The NEW session's identify() succeeded (scripted via
    // makeHappyFakeClient()) - the OLD session's late rejection (tagged
    // with the OLD, now-invalidated generation token) must never have
    // overwritten this with FAILED, and getActiveMspClient() must still
    // report the NEW MspClient instance, never the disposed old one.
    const identification = coordinator.getIdentificationState(SESSION_ID);
    expect(identification.status).toBe('SUCCEEDED');
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBe(newMspClient);
  });

  it("subscribeOwnershipState()'s fan-out: a throwing listener does not prevent another listener from being notified", () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;
    let secondCallCount = 0;
    coordinator.subscribeOwnershipState(() => {
      throw new Error('boom - simulated throwing listener');
    });
    coordinator.subscribeOwnershipState(() => {
      secondCallCount += 1;
    });

    expect(() => coordinator.openSession(client, SESSION_ID)).not.toThrow();
    // ACTIVATING + ACTIVE - both notifications reached the second listener
    // despite the first one throwing on every call.
    expect(secondCallCount).toBe(2);
  });

  it('getOwnershipState()/getIdentificationState() default to INACTIVE/IDLE for any never-opened sessionId', () => {
    const coordinator = new MspSessionCoordinator();
    expect(coordinator.getOwnershipState('never-opened')).toBe('INACTIVE');
    expect(coordinator.getIdentificationState('never-opened')).toEqual({status: 'IDLE'});
    expect(coordinator.getIdentificationMetrics('never-opened')).toBeUndefined();
  });
});

/**
 * Pass 7.4: the real MspTelemetryScheduler + tick() driver integration.
 * This is one of the few places in this project where a real/fake timer
 * is genuinely unavoidable (the tick driver is a real setInterval) - Jest
 * fake timers are used ONLY in this describe block, scoped via
 * beforeEach/afterEach, not introduced anywhere else in this file that
 * could instead use the existing flushAsync()/scripted-response
 * convention. jest.advanceTimersByTimeAsync() is used throughout (not
 * plain advanceTimersByTime()) since it also flushes the microtask chain
 * a scripted writeBytes() response settles through, matching the same
 * need this project's pollingCapacityAudit.test.ts already established
 * that pattern for.
 */
describe('MspSessionCoordinator - Pass 7.4 real telemetry scheduler integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Defensive backstop: any test in this block that started a real
    // tick-driver setInterval without explicitly deactivating its own
    // coordinator (most of them do deactivate/detach explicitly, as
    // that IS what they're testing) would otherwise leave a fake-timer
    // handle open past the test's own end, which is what was actually
    // causing Jest to report "did not exit one second after the test
    // run has completed" - confirmed by reading Jest's own warning, not
    // guessed.
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('getTelemetryScheduler() is undefined immediately after openSession() returns, and only becomes defined once startReading() has actually resolved (the same point identification starts from)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(10, -20, 30));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeUndefined();

    await flushAsync();

    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeDefined();
    coordinator.deactivateMspSession(SESSION_ID); // stop the real tick interval
  });

  it('getTelemetryScheduler() returns undefined for a never-opened session', () => {
    const coordinator = new MspSessionCoordinator();
    expect(coordinator.getTelemetryScheduler('never-opened')).toBeUndefined();
  });

  it('registers the real MSP_ATTITUDE poll, which round-trips real decoded data through the real MspClient once the tick driver fires', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(10, -20, 30));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler).toBeDefined();
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toEqual({status: 'WAITING'});

    // First tick driver firing (50ms) - the poll is due immediately at
    // registration, so this dispatches right away.
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();

    const value = scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
    expect(value).toMatchObject({
      status: 'FRESH',
      value: {rollDecidegrees: 10, pitchDecidegrees: -20, yawDegrees: 30},
    });
    coordinator.deactivateMspSession(SESSION_ID); // stop the real tick interval
  });

  it('registers MSP_ATTITUDE at the confirmed real ~220ms interval, not some other cadence (the second real dispatch only happens once ~220ms have elapsed since the first)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const countAttitudeWrites = () =>
      client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === MSP_ATTITUDE).length;

    // First dispatch - due immediately at registration.
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(1);

    // Well under 220ms further - must NOT have dispatched again yet.
    await jest.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(1);

    // The first dispatch's next-due time is dueAtMs = 50 + 220 = 270ms
    // after registration. 50ms + 100ms so far = 150ms elapsed; this
    // advance brings the total to 300ms, comfortably past 270ms.
    await jest.advanceTimersByTimeAsync(150);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(2);
    coordinator.deactivateMspSession(SESSION_ID); // stop the real tick interval
  });

  it('stops the tick driver on deactivateMspSession() - no further MSP_ATTITUDE dispatches happen afterward', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();

    const countAttitudeWrites = () =>
      client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === MSP_ATTITUDE).length;
    const beforeDeactivate = countAttitudeWrites();
    expect(beforeDeactivate).toBeGreaterThan(0);

    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeUndefined();

    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(beforeDeactivate);
  });

  it('stops the tick driver on a physical detach - no further MSP_ATTITUDE dispatches happen afterward', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();

    const countAttitudeWrites = () =>
      client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === MSP_ATTITUDE).length;
    const beforeDetach = countAttitudeWrites();
    expect(beforeDetach).toBeGreaterThan(0);

    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});
    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeUndefined();

    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(beforeDetach);
  });
});

describe('MspSessionCoordinator - Pass 7.4, Step 4: MspClient recovery-state axis', () => {
  const EMPTY = new Uint8Array(0);

  it('getMspRecoveryState() returns undefined for a never-opened session', () => {
    const coordinator = new MspSessionCoordinator();
    expect(coordinator.getMspRecoveryState('never-opened')).toBeUndefined();
  });

  it('getMspRecoveryState() reflects READY immediately once a session is open', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBe('READY');
  });

  it('two consecutive getMspRecoveryState() calls with no transition in between return the exact same reference', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    const first = coordinator.getMspRecoveryState(SESSION_ID);
    const second = coordinator.getMspRecoveryState(SESSION_ID);
    expect(first).toBe(second);
  });

  it('subscribeMspRecoveryState() fires, and getMspRecoveryState() reflects the transition, on a real desync triggered by a write failure', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync(); // let identify() finish first

    const listener = jest.fn();
    coordinator.subscribeMspRecoveryState(listener);

    client.rejectNextWrite('write failed');
    const failing = mspClient.request(42, EMPTY, {wireFormat: 'v1'});
    await expect(failing).rejects.toBeDefined();

    expect(listener).toHaveBeenCalled();
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBe('RESTARTING_READER');
    coordinator.deactivateMspSession(SESSION_ID); // stop the in-flight recovery attempt cleanly
  });

  it('does not fire for a DIFFERENT session\'s recovery-state transition', async () => {
    const coordinator = new MspSessionCoordinator();
    const clientA = makeHappyFakeClient(SESSION_ID);
    const clientB = makeHappyFakeClient(OTHER_SESSION_ID);
    const mspClientA = coordinator.openSession(clientA as unknown as UsbSerialTransportClient, SESSION_ID);
    coordinator.openSession(clientB as unknown as UsbSerialTransportClient, OTHER_SESSION_ID);
    await flushAsync();

    const listener = jest.fn();
    coordinator.subscribeMspRecoveryState(listener);
    listener.mockClear();

    clientA.rejectNextWrite('write failed');
    const failing = mspClientA.request(42, EMPTY, {wireFormat: 'v1'});
    await expect(failing).rejects.toBeDefined();

    // Confirm the desync genuinely happened (otherwise the assertion
    // below would trivially pass for the wrong reason).
    expect(listener).toHaveBeenCalled();
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBe('RESTARTING_READER');

    // subscribeMspRecoveryState() is broad-notify (fires for ANY session's
    // transition, same as every other axis - the caller re-reads
    // getMspRecoveryState(sessionId) itself to narrow) - this test
    // confirms session B's OWN state is genuinely untouched by session
    // A's desync, not that the listener itself was filtered.
    expect(coordinator.getMspRecoveryState(OTHER_SESSION_ID)).toBe('READY');
    coordinator.deactivateMspSession(SESSION_ID); // stop the in-flight recovery attempt cleanly
    coordinator.deactivateMspSession(OTHER_SESSION_ID);
  });

  it('cross-axis isolation: a recovery-state transition does not fire ownership/identification/telemetry-availability listeners, and vice versa', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const recoveryListener = jest.fn();
    const ownershipListener = jest.fn();
    const identificationListener = jest.fn();
    const telemetryAvailabilityListener = jest.fn();
    coordinator.subscribeMspRecoveryState(recoveryListener);
    coordinator.subscribeOwnershipState(ownershipListener);
    coordinator.subscribeIdentificationState(identificationListener);
    coordinator.subscribeTelemetryAvailability(telemetryAvailabilityListener);

    client.rejectNextWrite('write failed');
    const failing = mspClient.request(42, EMPTY, {wireFormat: 'v1'});
    await expect(failing).rejects.toBeDefined();

    expect(recoveryListener).toHaveBeenCalled();
    expect(ownershipListener).not.toHaveBeenCalled();
    expect(identificationListener).not.toHaveBeenCalled();
    expect(telemetryAvailabilityListener).not.toHaveBeenCalled();
    coordinator.deactivateMspSession(SESSION_ID); // stop the in-flight recovery attempt cleanly
  });

  it('getMspRecoveryState() reverts to undefined after deactivateMspSession()', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBe('READY');

    coordinator.deactivateMspSession(SESSION_ID);
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBeUndefined();
  });

  it('getMspRecoveryState() reverts to undefined after a physical detach', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBe('READY');

    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});
    expect(coordinator.getMspRecoveryState(SESSION_ID)).toBeUndefined();
  });

  it('deactivateMspSession() itself still notifies subscribeMspRecoveryState() once, for the final DISCONNECTED transition, before the entry is torn down', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const listener = jest.fn();
    coordinator.subscribeMspRecoveryState(listener);

    coordinator.deactivateMspSession(SESSION_ID);

    expect(listener).toHaveBeenCalled();
  });

  it('the returned unsubscribe function stops further notifications', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    const mspClient = coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const listener = jest.fn();
    const unsubscribe = coordinator.subscribeMspRecoveryState(listener);
    unsubscribe();

    client.rejectNextWrite('write failed');
    const failing = mspClient.request(42, EMPTY, {wireFormat: 'v1'});
    await expect(failing).rejects.toBeDefined();

    expect(listener).not.toHaveBeenCalled();
    coordinator.deactivateMspSession(SESSION_ID); // stop the in-flight recovery attempt cleanly
  });
});
