import {MspSessionCoordinator, MspOwnershipActivationError} from './MspSessionCoordinator';
import type {MspSessionOwnershipState} from './MspSessionCoordinator';
import {RNMspTransport} from './RNMspTransport';
import {MspClient, MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from '../../../core';
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
