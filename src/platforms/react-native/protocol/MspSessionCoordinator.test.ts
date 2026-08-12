import {
  MspSessionCoordinator,
  MspOwnershipActivationError,
  ATTITUDE_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  GPS_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
} from './MspSessionCoordinator';
import type {MspSessionOwnershipState} from './MspSessionCoordinator';
import {RNMspTransport} from './RNMspTransport';
import {
  MspClient,
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
} from '../../../core';
import type {MspAttitude, MspBatteryState, MspAnalog, MspRawGpsCompact, MspStatusExCompact} from '../../../core';
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
  /** Pass 7.6a (additive): removes a previously-scripted response so
   * later requests for that command go unanswered - mirrors
   * SetupScreen.test.tsx's own fake's clearResponse(). */
  clearResponse: (command: number) => void;
  /** Pass 7.6a (additive): every FUTURE writeBytes() carrying this exact
   * command never settles at all (the same never-settling promise
   * neverResolveWrite uses, but per-command) - so MspClient's
   * onWriteSettled() never runs for it and no response-timeout timer is
   * ever started, leaving that one poll genuinely in-flight forever.
   * The scheduler-side effect (a permanently in-flight dispatch whose
   * poll goes STALE by age) is exactly what the battery staleness test
   * needs and cannot be produced any other way without timers. */
  holdWritesFor: (command: number) => void;
  /** Pass 7.6c closure (additive): emits a response frame for this
   * command RIGHT NOW, independent of any write - the only way to model
   * a LATE response arriving after MspClient's 2000ms response timeout
   * already rejected the request. */
  emitResponseNow: (command: number, payload: Uint8Array) => void;
  /** Pass 7.6c (additive): scripts an MSP v1 ERROR-direction ('!') frame
   * for this command - the real wire shape a flight controller uses to
   * reject an unsupported command, which MspClient surfaces as
   * MspClientError('MSP_REMOTE_ERROR') (mspClient.ts). Needed by the
   * circuit-breaker UNSUPPORTED tests; never referenced elsewhere. */
  setErrorResponse: (command: number) => void;
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
  options: {neverResolveWrite?: boolean; deferStartReading?: boolean; responseDelayMs?: number} = {},
): FakeClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const sessionDetachedListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const errorResponseCommands = new Set<number>();
  const heldWriteCommands = new Set<number>();
  let resolveStartReadingImpl: () => void = () => undefined;
  const startReadingPromise = options.deferStartReading
    ? new Promise<void>(resolve => {
        resolveStartReadingImpl = resolve;
      })
    : Promise.resolve(undefined);
  let rejectNextWriteReason: {reason: unknown} | undefined;

  const emitFrame = (command: number, payload: Uint8Array, direction: 'response' | 'error' = 'response') => {
    const frameBytes = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction});
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
      // Pass 7.6a (additive): a per-command held write never settles -
      // see the FakeClient interface doc for why.
      if (heldWriteCommands.has(command)) {
        return new Promise<void>(() => undefined);
      }
      // Pass 7.6c (additive): a scripted remote rejection - see the
      // FakeClient interface doc for setErrorResponse().
      if (errorResponseCommands.has(command)) {
        Promise.resolve().then(() => emitFrame(command, new Uint8Array(0), 'error'));
        return Promise.resolve(undefined);
      }
      const payload = responses.get(command);
      if (payload) {
        if (options.responseDelayMs !== undefined) {
          // Pass 7.6a (additive): models a real serial link's service
          // time (e.g. the recorded ~224ms median RTT) - the response
          // frame arrives via a (fake-timer-driven) delay instead of a
          // microtask hop. Only tests that opt in via responseDelayMs
          // ever take this branch.
          setTimeout(() => emitFrame(command, payload), options.responseDelayMs);
        } else {
          // A microtask hop, not synchronous - mirrors a real write's own
          // async settlement, and keeps ordering deterministic without
          // relying on exactly-synchronous re-entrancy into the parser.
          Promise.resolve().then(() => emitFrame(command, payload));
        }
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
    clearResponse: (command: number) => {
      responses.delete(command);
    },
    holdWritesFor: (command: number) => {
      heldWriteCommands.add(command);
    },
    setErrorResponse: (command: number) => {
      errorResponseCommands.add(command);
    },
    emitResponseNow: (command: number, payload: Uint8Array) => {
      emitFrame(command, payload);
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
  // Pass 7.6a (additive): production now registers a battery poll for
  // every successfully-identified BETAFLIGHT session, and an UNANSWERED
  // battery request would occupy the serialized MSP queue until the
  // response timeout, distorting older tests' attitude timing. A benign
  // scripted response keeps every pre-existing "happy" test isolated
  // from the new poll without changing any of their assertions. Tests
  // that need different battery behavior simply overwrite/clear it.
  client.setResponse(
    MSP_BATTERY_STATE,
    Uint8Array.from([4, ...u16le(1500), 168, ...u16le(0), ...u16le(0), 0, ...u16le(1680)]),
  );
  // Pass 7.6c (additive, same isolation rationale as the battery response
  // above): production now also registers three auxiliary polls
  // (MSP_ANALOG / MSP_RAW_GPS / MSP_STATUS_EX, phase-staggered at
  // 700/1400/2100ms) for every successfully-identified BETAFLIGHT
  // session. Benign scripted responses keep pre-existing "happy" tests
  // isolated from the new channels; tests needing different aux behavior
  // overwrite/clear them.
  client.setResponse(
    MSP_ANALOG,
    Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]),
  );
  client.setResponse(
    MSP_RAW_GPS,
    Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]),
  );
  client.setResponse(
    MSP_STATUS_EX,
    Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]),
  );
  return client;
}

/**
 * For tests that genuinely don't care what happens to the fire-and-forget
 * identify() call openSession() starts (most of the renamed Pass 6.3
 * tests below, and the dispose-ordering tests, which only assert on
 * openSession()'s own return value / spy-recorded dispose order) -
 * writeBytes() never settles at all, so MspClient's own onWriteSettled()
 * never runs and therefore never starts its real MSP_RESPONSE_TIMEOUT_MILLIS
 * setTimeout in the first place.
 *
 * STALE CLAIM, CORRECTED (Pass 7.4 CI-hang investigation): the paragraph
 * below used to claim this "sidesteps entirely... any risk of a real
 * background timer surviving past a synchronous test's own return." That
 * was true when it was written, but is NO LONGER true as of this same
 * pass's own startTelemetry() addition: that method starts a SECOND,
 * INDEPENDENT real setInterval() (the MSP_ATTITUDE tick driver) the
 * moment startReading() resolves - completely unconditional on whether
 * identify()'s writeBytes() ever settles. Since this fixture's
 * startReading() DOES resolve (only writeBytes() is held open), a test
 * using this fixture that never explicitly tears its session down (via
 * deactivateMspSession()/a detach) DOES leak a real, permanently-ticking
 * setInterval for the rest of the process's life, even though it "never
 * flushes/awaits anything" - the queued microtask chain
 * (startReading().then(...) -> startTelemetry()) still runs on its own,
 * once the current synchronous test body returns and the microtask queue
 * drains, before the next test begins. Confirmed by an actual CI hang
 * (GitHub Actions run stuck in the Jest step for 40+ minutes, vs. this
 * project's own established ~12-17s baseline) traced back to exactly
 * this gap - not a hypothetical. Every test using this fixture (or the
 * plain makeFakeClient()/makeHappyFakeClient() below, without
 * deferStartReading) MUST still call deactivateMspSession() (or trigger
 * a detach) for its own sessionId before returning, even if it "doesn't
 * care" about identify()'s own outcome.
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

    coordinator.deactivateMspSession(SESSION_ID);
  });

  it('getActiveMspClient() returns the same instance openSession() already created', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeQuietFakeClient(SESSION_ID) as unknown as UsbSerialTransportClient;

    const opened = coordinator.openSession(client, SESSION_ID);
    const fetched = coordinator.getActiveMspClient(SESSION_ID);

    expect(fetched).toBe(opened);

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
    coordinator.deactivateMspSession(OTHER_SESSION_ID);
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

    // Pass 7.4 CI-hang fix: SESSION_ID's own session is deliberately never
    // torn down by the detach above (that's the whole point of this test)
    // - it must still be torn down here, explicitly, or its real telemetry
    // tick-driver setInterval leaks for the rest of the process's life.
    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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
    // 3 writeBytes() calls total, not 6. (Pass 7.6c closure: the removed
    // one-shot MSP_BATTERY_CONFIG read no longer adds a 4th write.)
    expect(client.writeBytes).toHaveBeenCalledTimes(3);

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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

    coordinator.deactivateMspSession(SESSION_ID);
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

  it('registers MSP_ATTITUDE at the responsive 50ms cadence without dispatching more than once per tick', async () => {
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

    // UPDATED BY RECEIVER P1, and the change is an improvement, not an
    // accommodation. This assertion used to read 1 here and reach 2 only
    // after a THIRD 50ms window, because the opportunity clock and the
    // attitude interval were the same 50ms number: the immediately-due
    // battery poll fairly took the single slot at t=50, and attitude -
    // having missed it - could not retry until its next whole period, so
    // a poll DECLARED at 50ms actually delivered at ~100ms.
    //
    // With the clock decoupled (10ms grid vs 50ms interval) the auxiliary
    // still gets its own slot, but it now costs 10ms of grid rather than
    // a whole attitude period, so attitude achieves its declared cadence.
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(2);

    // Still exactly one dispatch per interval, never a catch-up burst:
    // three 50ms windows produce three attitude writes, not more.
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();
    expect(countAttitudeWrites()).toBe(3);
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

describe('MspSessionCoordinator - Pass 7.6a Betaflight-gated battery telemetry poll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Same defensive backstop as the Pass 7.4 scheduler describe above -
    // every test here still deactivates its own sessions explicitly.
    // ADDITIONALLY (found via an intermittent full-serial-run "did not
    // exit" watchdog warning, reproducible only under whole-suite
    // event-loop load): teardown chains from dispose()-rejected requests
    // are ordinary microtasks interleaved with this afterEach in the
    // SAME queue - a continuation that lands after useRealTimers() would
    // schedule its response-timeout as a REAL 2000ms timer and trip
    // Jest's exit watchdog. Drain every straggler while fake timers are
    // still installed, uninstall, then drain once more so nothing can
    // outlive this file.
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  /** The verified 11-byte MSP_BATTERY_STATE payload (mspCommandSources.ts)
   * - built with this file's existing u16le() helper; negative current is
   * pre-converted to its unsigned two's-complement representation. */
  function batteryPayload(fields: {
    cellCount: number;
    capacityMah: number;
    legacyDecivolts: number;
    consumedMah: number;
    amperageCentiamps: number;
    stateRaw: number;
    voltageCentivolts: number;
  }): Uint8Array {
    const amperageUnsigned =
      fields.amperageCentiamps < 0 ? fields.amperageCentiamps + 0x10000 : fields.amperageCentiamps;
    return Uint8Array.from([
      fields.cellCount,
      ...u16le(fields.capacityMah),
      fields.legacyDecivolts,
      ...u16le(fields.consumedMah),
      ...u16le(amperageUnsigned),
      fields.stateRaw,
      ...u16le(fields.voltageCentivolts),
    ]);
  }

  const GOLDEN_BATTERY = batteryPayload({
    cellCount: 4,
    capacityMah: 1500,
    legacyDecivolts: 168,
    consumedMah: 350,
    amperageCentiamps: -250,
    stateRaw: 1,
    voltageCentivolts: 1685,
  });

  const countWritesFor = (client: FakeClient, command: number) =>
    client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === command).length;

  it('reports UNAVAILABLE while identification is still pending - no battery poll exists yet and no battery request is ever sent', async () => {
    const coordinator = new MspSessionCoordinator();
    // No identify responses scripted: identification never settles.
    const client = makeFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler).toBeDefined();
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'UNAVAILABLE'});

    await jest.advanceTimersByTimeAsync(200);
    await flushAsync();
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'UNAVAILABLE'});
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(0);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('registers the battery poll after successful BETAFLIGHT identification, immediately due, and round-trips the real decoded 11-byte payload', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    // Registered (WAITING), not UNAVAILABLE - identification has settled.
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'WAITING'});

    // Immediately due at registration - but tick() dispatches only the
    // single best overdue-ratio poll per firing, and attitude (50/220)
    // outranks battery (50/3000) on the first tick. Battery therefore
    // dispatches on the SECOND 50ms tick.
    await jest.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);

    const value = scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID);
    expect(value).toMatchObject({
      status: 'FRESH',
      value: {
        cellCount: 4,
        configuredCapacityMah: 1500,
        legacyVoltageDecivolts: 168,
        consumedMah: 350,
        amperageCentiamps: -250,
        batteryStateRaw: 1,
        voltageCentivolts: 1685,
      },
    });
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('never registers the battery poll when identification FAILS (incompatible API 1.41)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID);
    client.setResponse(MSP_API_VERSION, apiVersionPayload(41)); // below the 1.42 minimum
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload());
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    // The failure is the CANONICAL compatibility decision: identify()
    // runs checkMspCompatibility() first and throws
    // MspIncompatibleFirmwareError, so SUCCEEDED can never carry an
    // unaccepted API version (MspIdentificationService.ts:125-128).
    const identification = coordinator.getIdentificationState(SESSION_ID);
    expect(identification).toMatchObject({status: 'FAILED'});
    if (identification.status === 'FAILED') {
      expect((identification.error as Error).name).toBe('MspIncompatibleFirmwareError');
    }
    // The incompatible session is deliberately NOT detached or
    // reclassified - it stays ACTIVE, exactly as before this pass.
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('ACTIVE');

    await jest.advanceTimersByTimeAsync(200);
    await flushAsync();
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(0);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('registers the battery poll with EXACTLY the corrected specification: id, command 130, intervalMs 3000, staleAfterMs 9000, priority -1, and immediately due', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID, {deferStartReading: true});
    client.setResponse(MSP_API_VERSION, apiVersionPayload());
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    client.resolveStartReading();
    // One-hop settle: the startReading() continuation has now run
    // (scheduler exists, identification is still in flight), so the
    // registerPoll spy can be attached BEFORE identification finishes.
    let scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    for (let i = 0; i < 5 && !scheduler; i++) {
      await Promise.resolve();
      scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    }
    expect(scheduler).toBeDefined();
    expect(coordinator.getIdentificationState(SESSION_ID)).toMatchObject({status: 'RUNNING'});
    const registerSpy = jest.spyOn(scheduler!, 'registerPoll');

    await flushAsync(); // identification settles -> battery registers

    // Pass 7.6c: battery is no longer the only registration - the three
    // auxiliary Region 3 polls register in the same finish() path (their
    // own exact specs are asserted in the Pass 7.6c describe below).
    expect(registerSpy).toHaveBeenCalledTimes(4);
    const batteryCall = registerSpy.mock.calls.find(call => call[0].id === BATTERY_TELEMETRY_POLL_ID);
    expect(batteryCall?.[0]).toMatchObject({
      id: BATTERY_TELEMETRY_POLL_ID,
      command: MSP_BATTERY_STATE,
      intervalMs: 3000,
      staleAfterMs: 9000,
      priority: -1,
    });

    // Initially due upon registration: it dispatches within the first
    // two 50ms ticks (attitude wins the first by overdue ratio), not
    // after a full 3000ms interval.
    await jest.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('never registers the battery poll for INAV, EMUFLIGHT, or UNKNOWN firmware families, even though identification SUCCEEDS', async () => {
    for (const identifier of ['INAV', 'EMUF', 'XXXX']) {
      const sessionId = `family-${identifier}`;
      const coordinator = new MspSessionCoordinator();
      const client = makeFakeClient(sessionId);
      client.setResponse(MSP_API_VERSION, apiVersionPayload());
      client.setResponse(MSP_FC_VARIANT, fcVariantPayload(identifier));
      client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
      client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
      client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

      coordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      expect(coordinator.getIdentificationState(sessionId)).toMatchObject({status: 'SUCCEEDED'});

      await jest.advanceTimersByTimeAsync(200);
      await flushAsync();
      expect(
        coordinator.getTelemetryScheduler(sessionId)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
      ).toEqual({status: 'UNAVAILABLE'});
      expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(0);
      coordinator.deactivateMspSession(sessionId);
      await flushAsync(); // drain teardown chains inside fake-timer scope
    }
  });

  it('polls battery at the corrected 3000ms interval (not 1000ms) while attitude continues at its own unchanged cadence', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // First battery dispatch on the second tick (t=100 - attitude wins
    // the first tick by overdue ratio; see the round-trip test above).
    await jest.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);

    // Just under the next due time (dueAt = 100 + 3000 = 3100): still one.
    await jest.advanceTimersByTimeAsync(2850); // t = 2950
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);
    // Attitude was NOT starved meanwhile: the direct stream remains
    // high-frequency even while the slow battery channel gets its slots.
    expect(countWritesFor(client, MSP_ATTITUDE)).toBeGreaterThanOrEqual(50);

    // Past dueAt = 3100 (t=3250): exactly the second dispatch.
    await jest.advanceTimersByTimeAsync(300);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(2);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('goes STALE by age when a battery dispatch hangs in-flight forever (a held write also blocks the serialized MSP queue - reported honestly, not hidden)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(100); // two ticks - battery dispatches on the second
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    // Every future battery write hangs (never settles - no response
    // timeout timer ever starts), so the next dispatch at ~t=3050 stays
    // in-flight forever and the value ages into STALE at 9000ms past the
    // last success (~t=100).
    client.holdWritesFor(MSP_BATTERY_STATE);
    await jest.advanceTimersByTimeAsync(3150); // second dispatch (held)
    await flushAsync();
    await jest.advanceTimersByTimeAsync(6100); // t ≈ 9350 > 100 + 9000
    await flushAsync();

    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({
      status: 'STALE',
      value: {voltageCentivolts: 1685},
    });
    // HONEST consequence of the ONE serialized MSP queue: a request that
    // never settles blocks every later request too, so attitude also
    // degrades to STALE here. This models a pathological transport (a
    // write that never settles); a merely UNANSWERED request is ended by
    // the real 2000ms response timeout instead - covered next.
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'STALE'});
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('battery-timeout closure: a SINGLE battery MSP_TIMEOUT after a success disables battery polling for the session - honest UNAVAILABLE, never a stale value shown live, attitude recovers', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(100); // two ticks - battery dispatches on the second
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    // The next battery request goes unanswered: the write settles, the
    // REAL 2000ms response timeout ends it (~t=5150 for the ~3150ms
    // dispatch) - ONE strike disables battery polling for the session.
    client.clearResponse(MSP_BATTERY_STATE);
    await jest.advanceTimersByTimeAsync(3150);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2300); // past the timeout
    await flushAsync();
    await jest.advanceTimersByTimeAsync(500); // attitude refreshes within its own cadence
    await flushAsync();

    // Exactly 2 battery writes this generation (1 success + the 1 timed
    // out) - and the earlier FRESH value is NEVER retained as live: the
    // unregistered poll reads honest UNAVAILABLE (the approved
    // "بيانات البطارية غير متاحة" state), never UNSUPPORTED/no-LiPo.
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(2);
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'UNAVAILABLE'});
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    // NO battery request through at least THREE later nominal polling
    // windows (3 x 3000ms), and the disabled invariant persists after.
    await jest.advanceTimersByTimeAsync(9500);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(2);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'UNAVAILABLE'});
    // No second periodic attitude stall: attitude is FRESH at the end of
    // a window that would have contained three of the old retry stalls.
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('battery-timeout closure: a timeout BEFORE the first battery success equally disables battery for the session (exactly ONE timed-out request in the generation)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.clearResponse(MSP_BATTERY_STATE); // never answered - REAL 2000ms timeout

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    // Battery dispatches at ~t=100 and times out at ~t=2100.
    await jest.advanceTimersByTimeAsync(2300);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});

    // Three-plus later polling windows: still exactly the one request.
    await jest.advanceTimersByTimeAsync(10_000);
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);
    // The auxiliary channels and attitude all recover and keep working.
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspStatusExCompact>(FC_STATUS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('battery-timeout closure MEASURED: the single battery timeout stalls attitude once (honest STALE then FRESH) and never again; a late battery response cannot resurrect the poll', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.clearResponse(MSP_BATTERY_STATE);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID)!;

    const attitudeSuccessTimes: number[] = [];
    let staleObservedAtMs: number | undefined;
    for (let t = 50; t <= 12_000; t += 50) {
      await jest.advanceTimersByTimeAsync(50);
      const value = scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
      if (value.status === 'FRESH' && attitudeSuccessTimes[attitudeSuccessTimes.length - 1] !== value.updatedAtMs) {
        attitudeSuccessTimes.push(value.updatedAtMs);
      }
      if (value.status === 'STALE' && staleObservedAtMs === undefined) {
        staleObservedAtMs = t;
      }
    }
    await flushAsync();

    // Battery dispatched at ~t=100, held the ONE serialized link to its
    // REAL timeout at ~t=2100, then desync recovery ran. Measured:
    let maxGapMs = 0;
    for (let i = 1; i < attitudeSuccessTimes.length; i++) {
      maxGapMs = Math.max(maxGapMs, attitudeSuccessTimes[i] - attitudeSuccessTimes[i - 1]);
    }
    // One honest stall spanning the timeout + recovery (~2.1s) - attitude
    // truthfully crossed its 700ms threshold and returned to FRESH...
    expect(maxGapMs).toBeGreaterThanOrEqual(2000);
    expect(maxGapMs).toBeLessThan(3000);
    expect(staleObservedAtMs).toBeDefined();
    expect(scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    // ...and NO second periodic stall exists anywhere in the remaining
    // ~10s (the old 3000ms retry loop would have produced three more):
    // (updatedAtMs values are absolute mocked-epoch timestamps - filter
    // RELATIVE to the first success, past the one recovery point.)
    const afterRecovery = attitudeSuccessTimes.filter(at => at - attitudeSuccessTimes[0] >= 3000);
    for (let i = 1; i < afterRecovery.length; i++) {
      expect(afterRecovery[i] - afterRecovery[i - 1]).toBeLessThan(600);
    }
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1); // no backlog, no suppressed-tick burst

    // A LATE battery response after the breaker cannot resurrect the
    // poll or corrupt anything.
    client.emitResponseNow(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(1000);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(scheduler.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toEqual({status: 'UNAVAILABLE'});
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);
    expect(scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    // Teardown leaves no timer of any kind (one-shot stragglers drained
    // first - same discipline as the aux measured test).
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('Pass 7.7 latch: a timeout AFTER a real reading retains that reading as a FROZEN truthful STALE snapshot - never fabricated zeros, never "not detected", never UNSUPPORTED', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(coordinator.getBatteryLatchedValue(SESSION_ID)).toBeUndefined(); // healthy: no latch

    // The next dispatch times out for real -> breaker + latch.
    client.clearResponse(MSP_BATTERY_STATE);
    await jest.advanceTimersByTimeAsync(6000);
    await flushAsync();

    const latched = coordinator.getBatteryLatchedValue(SESSION_ID);
    expect(latched).toMatchObject({
      status: 'STALE',
      value: {cellCount: 4, voltageCentivolts: 1685, batteryStateRaw: 1},
    });
    // Truthful, not fabricated: the retained payload is the REAL last
    // reading, and the channel verdict says it is no longer updating.
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(latched?.status).not.toBe('UNAVAILABLE');
    if (latched?.status === 'STALE') {
      expect(latched.value.cellCount).not.toBe(0); // never "battery not detected"
    }
    // Frozen + referentially stable across repeated reads (snapshot contract).
    expect(Object.isFrozen(latched)).toBe(true);
    expect(coordinator.getBatteryLatchedValue(SESSION_ID)).toBe(latched);

    // A late response cannot reverse the verdict or refresh the latch.
    client.emitResponseNow(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(4000);
    await flushAsync();
    expect(coordinator.getBatteryLatchedValue(SESSION_ID)).toBe(latched);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('Pass 7.7 latch: a timeout BEFORE any battery success latches a truthful read-ERROR (no invented values), and a NEW generation clears the latch', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.clearResponse(MSP_BATTERY_STATE);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2400);
    await flushAsync();

    const latched = coordinator.getBatteryLatchedValue(SESSION_ID);
    expect(latched?.status).toBe('ERROR');
    expect(JSON.stringify(latched)).not.toContain('cellCount'); // no fabricated payload
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('DISABLED');

    // Teardown clears it; a genuinely new physical generation starts clean.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(coordinator.getBatteryLatchedValue(SESSION_ID)).toBeUndefined();

    const client2 = makeHappyFakeClient(SESSION_ID);
    client2.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client2.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(150);
    await flushAsync();
    expect(coordinator.getBatteryLatchedValue(SESSION_ID)).toBeUndefined();
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('battery-timeout closure: teardown while the battery request is pending is clean, and a genuinely NEW generation polls battery normally again', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeHappyFakeClient(SESSION_ID);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.clearResponse(MSP_BATTERY_STATE);

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(150); // battery dispatched ~t=100, still pending
    await flushAsync();
    expect(countWritesFor(client, MSP_BATTERY_STATE)).toBe(1);

    // Deactivate mid-flight: the generation guard discards the late
    // settle; no timer survives.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);

    // A NEW physical session on the same id: battery breaker is reset,
    // polling works normally at its unchanged cadence.
    const client2 = makeHappyFakeClient(SESSION_ID);
    client2.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client2.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(150);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});
    // Cadence unchanged: second dispatch lands after the same 3000ms.
    await jest.advanceTimersByTimeAsync(3100);
    await flushAsync();
    expect(countWritesFor(client2, MSP_BATTERY_STATE)).toBe(2);

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('battery-timeout closure: session REPLACEMENT while the battery request is pending never leaks the old outcome into the new generation', async () => {
    const coordinator = new MspSessionCoordinator();
    const client1 = makeHappyFakeClient(SESSION_ID);
    client1.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client1.clearResponse(MSP_BATTERY_STATE);

    coordinator.openSession(client1 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(150); // battery pending on gen 1
    await flushAsync();

    // Replace in place: deactivate + immediately open gen 2 on the same id.
    coordinator.deactivateMspSession(SESSION_ID);
    const client2 = makeHappyFakeClient(SESSION_ID);
    client2.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client2.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    // Let gen 1's would-have-been timeout moment pass INSIDE gen 2's life.
    await jest.advanceTimersByTimeAsync(2500);
    await flushAsync();

    // Gen 2's battery is alive and ACTIVE - the old generation's pending
    // request (rejected at dispose) never disabled the replacement.
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, BATTERY_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('re-gates from scratch for a reused sessionId: a BETAFLIGHT session followed by an INAV session on the same id gets no battery poll', async () => {
    const coordinator = new MspSessionCoordinator();
    const client1 = makeHappyFakeClient(SESSION_ID);
    client1.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client1.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client1 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toEqual({status: 'WAITING'});
    coordinator.deactivateMspSession(SESSION_ID);

    const client2 = makeFakeClient(SESSION_ID);
    client2.setResponse(MSP_API_VERSION, apiVersionPayload());
    client2.setResponse(MSP_FC_VARIANT, fcVariantPayload('INAV'));
    client2.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client2.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client2.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(200);
    await flushAsync();

    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});
    expect(countWritesFor(client2, MSP_BATTERY_STATE)).toBe(0);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('a replaced generation\'s late startReading() completion cannot start identification or register battery into the replacement session', async () => {
    const coordinator = new MspSessionCoordinator();
    const client1 = makeFakeClient(SESSION_ID, {deferStartReading: true});
    client1.setResponse(MSP_API_VERSION, apiVersionPayload());
    client1.setResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    client1.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client1.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    coordinator.openSession(client1 as unknown as UsbSerialTransportClient, SESSION_ID);
    coordinator.deactivateMspSession(SESSION_ID); // gen 1 torn down before startReading resolves

    const client2 = makeFakeClient(SESSION_ID);
    client2.setResponse(MSP_API_VERSION, apiVersionPayload());
    client2.setResponse(MSP_FC_VARIANT, fcVariantPayload('INAV'));
    client2.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client2.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // Gen 1's startReading now resolves LATE - its continuation must hit
    // the generation guard and do nothing at all.
    client1.resolveStartReading();
    await flushAsync();
    await jest.advanceTimersByTimeAsync(200);
    await flushAsync();

    expect(client1.writeBytes).not.toHaveBeenCalled(); // no late identify(), let alone battery
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});
    expect(countWritesFor(client2, MSP_BATTERY_STATE)).toBe(0);
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });

  it('contention at the recorded ~224ms link service time stays bounded: no backlog, no catch-up burst, at most one in-flight demand per poll, attitude never starved', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID, {responseDelayMs: 224});
    client.setResponse(MSP_API_VERSION, apiVersionPayload());
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, GOLDEN_BATTERY);
    // Pass 7.6c: the session now also runs the three auxiliary polls -
    // answered at the same 224ms service time so this test keeps modeling
    // the REAL shared-queue contention instead of 2000ms response-timeout
    // stalls that no healthy link has.
    client.setResponse(MSP_ANALOG, Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]));
    client.setResponse(
      MSP_RAW_GPS,
      Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]),
    );
    client.setResponse(
      MSP_STATUS_EX,
      Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]),
    );

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // Drive ~10s of fake time in 50ms steps, recording each command's
    // dispatch times at 50ms resolution.
    const attitudeDispatchTimes: number[] = [];
    const batteryDispatchTimes: number[] = [];
    let attitudeSeen = 0;
    let batterySeen = 0;
    for (let t = 50; t <= 10_000; t += 50) {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
      const attitudeNow = countWritesFor(client, MSP_ATTITUDE);
      const batteryNow = countWritesFor(client, MSP_BATTERY_STATE);
      // At most ONE new dispatch per command per 50ms step - a backlog
      // or catch-up burst would emit several in a single step.
      expect(attitudeNow - attitudeSeen).toBeLessThanOrEqual(1);
      expect(batteryNow - batterySeen).toBeLessThanOrEqual(1);
      if (attitudeNow > attitudeSeen) {
        attitudeDispatchTimes.push(t);
      }
      if (batteryNow > batterySeen) {
        batteryDispatchTimes.push(t);
      }
      attitudeSeen = attitudeNow;
      batterySeen = batteryNow;
    }

    // Battery stays at its corrected 3000ms cadence: bounded count over
    // the window (registration ~ after 3 sequential 224ms identify round
    // trips), and consecutive dispatches never closer than ~2500ms (no
    // catch-up burst after the identification delay either).
    expect(batteryDispatchTimes.length).toBeGreaterThanOrEqual(2);
    expect(batteryDispatchTimes.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < batteryDispatchTimes.length; i++) {
      expect(batteryDispatchTimes[i] - batteryDispatchTimes[i - 1]).toBeGreaterThanOrEqual(2500);
    }

    // Attitude keeps flowing: with a 224ms service time on a serialized
    // link plus occasional battery turns, the MODELED completion cadence
    // is ~250-320ms (NOT the nominal 220ms - the queue genuinely shares
    // time; asserted honestly here). Over the ~9s window that means at
    // least 25 dispatches, and consecutive dispatches at least 200ms
    // apart (one in-flight demand at a time - the scheduler's own
    // inFlight guard).
    expect(attitudeDispatchTimes.length).toBeGreaterThanOrEqual(25);
    for (let i = 1; i < attitudeDispatchTimes.length; i++) {
      expect(attitudeDispatchTimes[i] - attitudeDispatchTimes[i - 1]).toBeGreaterThanOrEqual(200);
    }

    // Both polls end the window genuinely served.
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    coordinator.deactivateMspSession(SESSION_ID);
    // Drain dispose/rejection chains INSIDE this test's fake-timer scope
    // - a straggler settling after afterEach's useRealTimers() would
    // otherwise schedule a real timer and trip Jest's exit watchdog.
    await flushAsync();
  });
});

describe('MspSessionCoordinator - Pass 7.6c auxiliary Region 3 telemetry (Receiver/GPS/FC status) and one-shot battery config', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Same double-drain backstop as the Pass 7.6a describe above - see
    // its afterEach comment for the full straggler rationale.
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  const countWritesFor = (client: FakeClient, command: number) =>
    client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === command).length;

  /** Verified 9-byte MSP_ANALOG payload (mspCommandSources.ts). */
  const GOLDEN_ANALOG = Uint8Array.from([168, ...u16le(350), ...u16le(540), ...u16le(1234), ...u16le(1685)]);
  /** Verified 16-byte MSP_RAW_GPS payload: raw GPS_FIX bit (2), 11 sats,
   * deliberately NON-ZERO coordinate bytes (they must be dropped). */
  const GOLDEN_RAW_GPS = Uint8Array.from([
    2,
    11,
    0x15,
    0xcd,
    0x5b,
    0x07,
    0xa1,
    0x86,
    0x01,
    0x00,
    ...u16le(300),
    ...u16le(100),
    ...u16le(900),
  ]);
  /** Verified 13-byte MSP_STATUS_EX fixed prefix: 900us cycle, 7 i2c
   * errors, mask ACC|GPS|GYRO=41, cpu 42%. */
  const GOLDEN_STATUS_EX = Uint8Array.from([...u16le(900), ...u16le(7), ...u16le(41), 0, 0, 0, 0, 1, ...u16le(42)]);
  function makeAuxHappyClient(sessionId: string): FakeClient {
    const client = makeHappyFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_ANALOG, GOLDEN_ANALOG);
    client.setResponse(MSP_RAW_GPS, GOLDEN_RAW_GPS);
    client.setResponse(MSP_STATUS_EX, GOLDEN_STATUS_EX);
    return client;
  }

  it('registers the three auxiliary polls with EXACTLY the authorized capacity-safe specifications (intervals, staleness, priorities, phase stagger)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID, {deferStartReading: true});
    client.setResponse(MSP_API_VERSION, apiVersionPayload());
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, Uint8Array.from([4, ...u16le(1500), 168, ...u16le(0), ...u16le(0), 0, ...u16le(1680)]));

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    client.resolveStartReading();
    let scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    for (let i = 0; i < 5 && !scheduler; i++) {
      await Promise.resolve();
      scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    }
    expect(scheduler).toBeDefined();
    const registerSpy = jest.spyOn(scheduler!, 'registerPoll');

    await flushAsync(); // identification settles -> battery + aux register

    const byId = (id: string) => registerSpy.mock.calls.find(call => call[0].id === id)?.[0];
    expect(byId(RECEIVER_TELEMETRY_POLL_ID)).toMatchObject({
      command: MSP_ANALOG,
      intervalMs: 4000,
      staleAfterMs: 12000,
      priority: -2,
      initialDelayMs: 700,
    });
    expect(byId(GPS_TELEMETRY_POLL_ID)).toMatchObject({
      command: MSP_RAW_GPS,
      intervalMs: 5000,
      staleAfterMs: 15000,
      priority: -3,
      initialDelayMs: 1400,
    });
    expect(byId(FC_STATUS_TELEMETRY_POLL_ID)).toMatchObject({
      command: MSP_STATUS_EX,
      intervalMs: 8000,
      staleAfterMs: 24000,
      priority: -4,
      initialDelayMs: 2100,
    });
    // Battery (asserted fully in the Pass 7.6a describe) plus the three
    // auxiliaries - and nothing else.
    expect(registerSpy).toHaveBeenCalledTimes(4);

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('phase-staggers the first auxiliary dispatches (receiver ~700ms, gps ~1400ms, fc ~2100ms) - no startup burst', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(650);
    expect(countWritesFor(client, MSP_ANALOG)).toBe(0);
    expect(countWritesFor(client, MSP_RAW_GPS)).toBe(0);
    expect(countWritesFor(client, MSP_STATUS_EX)).toBe(0);

    await jest.advanceTimersByTimeAsync(100); // t = 750
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    expect(countWritesFor(client, MSP_RAW_GPS)).toBe(0);
    expect(countWritesFor(client, MSP_STATUS_EX)).toBe(0);

    await jest.advanceTimersByTimeAsync(700); // t = 1450
    expect(countWritesFor(client, MSP_RAW_GPS)).toBe(1);
    expect(countWritesFor(client, MSP_STATUS_EX)).toBe(0);

    await jest.advanceTimersByTimeAsync(700); // t = 2150
    expect(countWritesFor(client, MSP_STATUS_EX)).toBe(1);

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('round-trips all three auxiliary payloads through the real decoders - and the GPS value structurally CANNOT carry coordinates', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(2200);
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);

    expect(scheduler?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID)).toMatchObject({
      status: 'FRESH',
      value: {legacyVoltageDecivolts: 168, consumedMah: 350, rssi: 540, amperageCentiamps: 1234, voltageCentivolts: 1685},
    });
    const gpsValue = scheduler?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID);
    expect(gpsValue).toMatchObject({
      status: 'FRESH',
      value: {
        hasFix: true,
        satelliteCount: 11,
        altitudeMeters: 300,
        groundSpeedCentimetersPerSecond: 100,
        groundCourseDecidegrees: 900,
      },
    });
    if (gpsValue?.status === 'FRESH') {
      // Privacy by model shape: the scripted payload deliberately carries
      // non-zero coordinates, but only non-location flight facts survive.
      expect(gpsValue.value).not.toHaveProperty('latitude');
      expect(gpsValue.value).not.toHaveProperty('longitude');
      expect(gpsValue.value).not.toHaveProperty('latitudeDegrees');
      expect(gpsValue.value).not.toHaveProperty('longitudeDegrees');
    }
    expect(scheduler?.getValue<MspStatusExCompact>(FC_STATUS_TELEMETRY_POLL_ID)).toMatchObject({
      status: 'FRESH',
      value: {cycleTimeUs: 900, i2cErrorCount: 7, sensorPresenceMask: 41, cpuLoadPercent: 42},
    });
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('never registers auxiliary polls or requests battery config for INAV/EMUFLIGHT/UNKNOWN families (Betaflight-only gating)', async () => {
    for (const identifier of ['INAV', 'EMUF', 'XXXX']) {
      const sessionId = `aux-family-${identifier}`;
      const coordinator = new MspSessionCoordinator();
      const client = makeFakeClient(sessionId);
      client.setResponse(MSP_API_VERSION, apiVersionPayload());
      client.setResponse(MSP_FC_VARIANT, fcVariantPayload(identifier));
      client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
      client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
      client.setResponse(MSP_ANALOG, GOLDEN_ANALOG);

      coordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      expect(coordinator.getIdentificationState(sessionId)).toMatchObject({status: 'SUCCEEDED'});

      await jest.advanceTimersByTimeAsync(3000);
      await flushAsync();
      expect(countWritesFor(client, MSP_ANALOG)).toBe(0);
      expect(countWritesFor(client, MSP_RAW_GPS)).toBe(0);
      expect(countWritesFor(client, MSP_STATUS_EX)).toBe(0);
      // Default 'ACTIVE' verdict; the poll ids simply read UNAVAILABLE.
      expect(coordinator.getAuxTelemetryChannelState(sessionId, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
      expect(
        coordinator.getTelemetryScheduler(sessionId)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
      ).toEqual({status: 'UNAVAILABLE'});
      coordinator.deactivateMspSession(sessionId);
      await flushAsync();
    }
  });

  it('circuit-breaks a structurally invalid response as DECODE_FAILED after ONE dispatch - and the other channels keep polling', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.setResponse(MSP_ANALOG, Uint8Array.from([1, 2, 3])); // truncated - decodeAnalog throws
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(800);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DECODE_FAILED');
    // Unregistered: reads UNAVAILABLE and NEVER polls again this session.
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});

    await jest.advanceTimersByTimeAsync(9000);
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    // Isolation: gps/fc/battery/attitude are entirely unaffected.
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspStatusExCompact>(FC_STATUS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('circuit-breaks an explicit MSP error frame as UNSUPPORTED after ONE dispatch (the FC rejected the command)', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.clearResponse(MSP_RAW_GPS);
    client.setErrorResponse(MSP_RAW_GPS);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(1500);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('UNSUPPORTED');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});

    await jest.advanceTimersByTimeAsync(11_000);
    await flushAsync();
    expect(countWritesFor(client, MSP_RAW_GPS)).toBe(1);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  /** Pass 7.6c closure: MSP_BATTERY_CONFIG's command id, kept ONLY as a
   * test literal to prove the removed one-shot request never comes back -
   * production no longer defines or references this command at all. */
  const REMOVED_MSP_BATTERY_CONFIG_COMMAND = 32;

  it('opening and fully identifying a session sends NO MSP_BATTERY_CONFIG request, ever - the estimate path is fully removed', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(5000);
    await flushAsync();
    // Identification succeeded, all four polls are live...
    expect(coordinator.getIdentificationState(SESSION_ID)).toMatchObject({status: 'SUCCEEDED'});
    expect(countWritesFor(client, MSP_ANALOG)).toBeGreaterThanOrEqual(1);
    // ...and command 32 was never written once.
    expect(countWritesFor(client, REMOVED_MSP_BATTERY_CONFIG_COMMAND)).toBe(0);

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('a SINGLE genuine 2000ms response timeout BEFORE first success disables that channel for the session - no automatic retry, never labeled UNSUPPORTED', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.clearResponse(MSP_ANALOG); // write succeeds, response never arrives -> REAL 2000ms response timeout
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // Dispatch ~700ms; still genuinely in flight just before the real
    // MSP_RESPONSE_TIMEOUT_MILLIS elapses at ~2700ms.
    await jest.advanceTimersByTimeAsync(2600);
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    // The timeout fires -> MspClientError('MSP_TIMEOUT') -> ONE strike
    // disables the channel. DISABLED (timeout/error classification),
    // NEVER 'UNSUPPORTED' - a timeout proves nothing about support.
    await jest.advanceTimersByTimeAsync(300);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);

    // NO retry for the remainder of this physical session - even four
    // nominal intervals later the count stays exactly 1.
    await jest.advanceTimersByTimeAsync(16_000);
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);

    // Every OTHER channel is fully operational after the one bounded stall.
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(scheduler?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspStatusExCompact>(FC_STATUS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('a SINGLE timeout AFTER a successful reading equally disables the channel - the old ten-failure retry loop is gone', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // First receiver dispatch succeeds (~700ms).
    await jest.advanceTimersByTimeAsync(800);
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});

    // The next dispatch (~4700ms) times out at ~6700ms -> DISABLED
    // immediately. Exactly 2 writes total (1 success + the 1 timeout),
    // never the old 1+10 pattern of repeated 2-second stalls.
    client.clearResponse(MSP_ANALOG);
    await jest.advanceTimersByTimeAsync(20_000);
    await flushAsync();

    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(countWritesFor(client, MSP_ANALOG)).toBe(2);
    // Isolation: the other channels are untouched and still served.
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspRawGpsCompact>(GPS_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('a fast-settling NON-timeout failure still gets the bounded delayed retry - only genuine timeouts are one-strike', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    // Arm a one-shot WRITE failure just before the receiver's 700ms
    // first dispatch (attitude last dispatched at 550, next due 770, so
    // the receiver's write is the next one) - it settles immediately
    // (rejection), never holding the serialized link for 2000ms.
    await jest.advanceTimersByTimeAsync(690);
    await flushAsync();
    client.rejectNextWrite(new Error('transient transport failure'));
    await jest.advanceTimersByTimeAsync(110); // t = 800: failed fast
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    // Non-timeout failure #1 -> still ACTIVE (one permitted delayed retry).
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    // The retry a full interval later succeeds normally.
    await jest.advanceTimersByTimeAsync(5000);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('MEASURED: one auxiliary timeout stalls the serialized link ~2.2s - attitude honestly goes STALE (>700ms) and recovers to FRESH; the stall is bounded and never repeats', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.clearResponse(MSP_ANALOG);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID)!;
    const attitudeSuccessTimes: number[] = [];
    let staleObservedAtMs: number | undefined;
    let freshAfterStaleAtMs: number | undefined;
    for (let t = 50; t <= 8000; t += 50) {
      await jest.advanceTimersByTimeAsync(50);
      const value = scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
      if (value.status === 'FRESH' && attitudeSuccessTimes[attitudeSuccessTimes.length - 1] !== value.updatedAtMs) {
        attitudeSuccessTimes.push(value.updatedAtMs);
        if (staleObservedAtMs !== undefined && freshAfterStaleAtMs === undefined) {
          freshAfterStaleAtMs = t;
        }
      }
      if (value.status === 'STALE' && staleObservedAtMs === undefined) {
        staleObservedAtMs = t;
      }
    }
    await flushAsync();

    // The receiver's only dispatch (~700ms) held the ONE serialized MSP
    // link until its REAL 2000ms response timeout (~2700ms). Honest
    // consequences, measured (not assumed):
    let maxGapMs = 0;
    for (let i = 1; i < attitudeSuccessTimes.length; i++) {
      maxGapMs = Math.max(maxGapMs, attitudeSuccessTimes[i] - attitudeSuccessTimes[i - 1]);
    }
    // (a) the maximum attitude-success gap spans the full timeout window
    // plus the post-timeout desync recovery MSP_TIMEOUT triggers - well
    // over 2000ms; it is NOT kept under 600ms and this test does not
    // pretend otherwise. It stays bounded (single stall, no repeats).
    expect(maxGapMs).toBeGreaterThanOrEqual(2000);
    expect(maxGapMs).toBeLessThan(3000);
    // (b) attitude genuinely crossed its 700ms stale threshold and the
    // UI-facing value truthfully reported STALE during the stall...
    expect(staleObservedAtMs).toBeDefined();
    // ...(c) and recovered to FRESH after the timeout + recovery probe.
    expect(freshAfterStaleAtMs).toBeDefined();
    expect(scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    // (d) after recovery the cadence is healthy again: gaps in the final
    // 4 seconds are all normal (<600ms) - the stall happened exactly once.
    const lateTimes = attitudeSuccessTimes.filter(at => at >= attitudeSuccessTimes[attitudeSuccessTimes.length - 1] - 4000);
    for (let i = 1; i < lateTimes.length; i++) {
      expect(lateTimes[i] - lateTimes[i - 1]).toBeLessThan(600);
    }
    // (e) no queue backlog built up: the timed-out channel wrote exactly
    // once and is DISABLED; nothing retried it.
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DISABLED');

    // (f) teardown leaves no timer of any kind.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a LATE response arriving after the timeout already disabled the channel is safely absorbed - the verdict stands and no channel is poisoned', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.clearResponse(MSP_ANALOG);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(2800); // dispatch ~700, timeout ~2700 -> DISABLED
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DISABLED');

    // The FC's answer finally arrives - long after MspClient rejected
    // the request. It must not resurrect the channel, corrupt another
    // in-flight request, or crash anything.
    client.emitResponseNow(MSP_ANALOG, GOLDEN_ANALOG);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('DISABLED');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toEqual({status: 'UNAVAILABLE'});
    // The rest of the session keeps working (any late-frame desync
    // handling MspClient performs settles back to a served link).
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    expect(scheduler?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID)).toMatchObject({status: 'FRESH'});
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('teardown while an auxiliary request is pending is clean, and a NEW physical session re-probes the channel from scratch', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    client.clearResponse(MSP_ANALOG);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();

    await jest.advanceTimersByTimeAsync(750); // receiver dispatched at ~700, still pending
    await flushAsync();
    expect(countWritesFor(client, MSP_ANALOG)).toBe(1);

    // Deactivate mid-flight: dispose rejects the pending request; the
    // generation guard discards the late settle; no timer survives.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);

    // A genuinely NEW physical session on the same id starts from
    // scratch: channel ACTIVE, fresh probe, no cross-session
    // contamination from the old pending request.
    const client2 = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client2 as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(800);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH', value: {rssi: 540}});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('subscribeAuxTelemetry() notifies on lifecycle changes and unsubscribing stops the notifications', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeAuxHappyClient(SESSION_ID);
    let notifications = 0;
    const unsubscribe = coordinator.subscribeAuxTelemetry(() => {
      notifications += 1;
    });

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    expect(notifications).toBeGreaterThan(0); // aux registration

    unsubscribe();
    const after = notifications;
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    expect(notifications).toBe(after);
  });

  it('getters default safely for unknown sessions (ACTIVE) and teardown clears every aux surface and timer', async () => {
    const coordinator = new MspSessionCoordinator();
    expect(coordinator.getAuxTelemetryChannelState('never-opened', RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    const client = makeAuxHappyClient(SESSION_ID);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(800);
    await flushAsync();
    expect(
      coordinator.getTelemetryScheduler(SESSION_ID)?.getValue<MspAnalog>(RECEIVER_TELEMETRY_POLL_ID),
    ).toMatchObject({status: 'FRESH'});

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeUndefined();
    // No timer of any kind survives teardown (tick driver cleared,
    // MspClient response timers cleared by dispose).
    expect(jest.getTimerCount()).toBe(0);
  });

  it('LOAD: 60 simulated seconds at the measured ~224ms service time - concurrency one, no backlog, no burst, attitude never stale (max gap < 600ms), auxiliaries never starved, clean teardown', async () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient(SESSION_ID, {responseDelayMs: 224});
    client.setResponse(MSP_API_VERSION, apiVersionPayload());
    client.setResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));
    client.setResponse(MSP_BATTERY_STATE, Uint8Array.from([4, ...u16le(1500), 168, ...u16le(0), ...u16le(0), 0, ...u16le(1680)]));
    client.setResponse(MSP_ANALOG, GOLDEN_ANALOG);
    client.setResponse(MSP_RAW_GPS, GOLDEN_RAW_GPS);
    client.setResponse(MSP_STATUS_EX, GOLDEN_STATUS_EX);

    // Timestamped write log (modern fake timers mock Date.now(), so these
    // are exact fake-clock readings).
    const writeLog: Array<{cmd: number; at: number}> = [];
    const baseImpl = client.writeBytes.getMockImplementation()!;
    client.writeBytes.mockImplementation((sessionId: string, dataBase64: string) => {
      writeLog.push({cmd: base64ToBytes(dataBase64)[4], at: Date.now()});
      return baseImpl(sessionId, dataBase64);
    });

    coordinator.openSession(client as unknown as UsbSerialTransportClient, SESSION_ID);
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID)!;

    // Identification itself takes 3 sequential 224ms round trips;
    // registration (finish()) happens the moment the third identify
    // response lands, exactly 224ms after the third identify write.
    const successTimes = new Map<string, number[]>([
      [ATTITUDE_TELEMETRY_POLL_ID, []],
      [BATTERY_TELEMETRY_POLL_ID, []],
      [RECEIVER_TELEMETRY_POLL_ID, []],
      [GPS_TELEMETRY_POLL_ID, []],
      [FC_STATUS_TELEMETRY_POLL_ID, []],
    ]);
    let attitudeWentStale = false;
    for (let step = 0; step < 1200; step++) {
      await jest.advanceTimersByTimeAsync(50);
      for (const [id, times] of successTimes) {
        const value = scheduler.getValue<unknown>(id);
        if (value.status === 'FRESH' && times[times.length - 1] !== value.updatedAtMs) {
          times.push(value.updatedAtMs);
        }
        if (id === ATTITUDE_TELEMETRY_POLL_ID && value.status === 'STALE') {
          attitudeWentStale = true;
        }
      }
    }

    // --- Wire discipline: the link is genuinely serialized end to end.
    // Every consecutive write is at least one full 224ms service time
    // after the previous one - therefore concurrency was exactly one,
    // there was never a queued backlog burst, and no startup burst.
    for (let i = 1; i < writeLog.length; i++) {
      expect(writeLog[i].at - writeLog[i - 1].at).toBeGreaterThanOrEqual(224);
    }
    // Bounded total demand: a 224ms-serialized link fits at most
    // 60000/224 ~ 268 requests in the window (+identify slack).
    expect(writeLog.length).toBeLessThanOrEqual(272);

    // --- Phase stagger honored relative to registration (the third
    // identify response = writeLog[2].at + 224ms): no auxiliary fired
    // before its initial delay.
    const registrationAt = writeLog[2].at + 224;
    const firstWriteAt = (cmd: number) => writeLog.find(write => write.cmd === cmd)?.at;
    expect(firstWriteAt(MSP_ANALOG)! - registrationAt).toBeGreaterThanOrEqual(700);
    expect(firstWriteAt(MSP_RAW_GPS)! - registrationAt).toBeGreaterThanOrEqual(1400);
    expect(firstWriteAt(MSP_STATUS_EX)! - registrationAt).toBeGreaterThanOrEqual(2100);

    // --- Attitude health: never crossed its 700ms stale boundary, and
    // the maximum gap between successful readings stayed under 600ms.
    expect(attitudeWentStale).toBe(false);
    const attitudeTimes = successTimes.get(ATTITUDE_TELEMETRY_POLL_ID)!;
    expect(attitudeTimes.length).toBeGreaterThanOrEqual(150);
    let maxAttitudeGap = 0;
    for (let i = 1; i < attitudeTimes.length; i++) {
      maxAttitudeGap = Math.max(maxAttitudeGap, attitudeTimes[i] - attitudeTimes[i - 1]);
    }
    expect(maxAttitudeGap).toBeLessThan(600);

    // --- Auxiliaries genuinely served (not starved) at their own
    // cadences across the 60s window.
    expect(successTimes.get(BATTERY_TELEMETRY_POLL_ID)!.length).toBeGreaterThanOrEqual(14);
    expect(successTimes.get(RECEIVER_TELEMETRY_POLL_ID)!.length).toBeGreaterThanOrEqual(10);
    expect(successTimes.get(GPS_TELEMETRY_POLL_ID)!.length).toBeGreaterThanOrEqual(8);
    expect(successTimes.get(FC_STATUS_TELEMETRY_POLL_ID)!.length).toBeGreaterThanOrEqual(5);
    // Every channel ended the hour-long-feeling window still healthy.
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, RECEIVER_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, GPS_TELEMETRY_POLL_ID)).toBe('ACTIVE');
    expect(coordinator.getAuxTelemetryChannelState(SESSION_ID, FC_STATUS_TELEMETRY_POLL_ID)).toBe('ACTIVE');

    // --- Detach/disposal leaves no active RECURRING timer. Two one-shot
    // straggler classes are drained first because they are bounded and
    // harmless: (a) the FIXTURE's own 224ms response-emit setTimeout for
    // a request mid-service when the loop ended (its frame lands on a
    // disposed client - a no-op), and (b) the documented ~rare teardown
    // microtask-chain interleaving (the Pass 7.6a lesson) where a write
    // settling across dispose can still start one final one-shot 2000ms
    // response timeout. Advancing past BOTH consumes every one-shot; the
    // assertion then proves what actually matters - the telemetry tick
    // interval (the only recurring timer) is genuinely gone, since an
    // interval would survive any amount of advancing.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);
  });
});
