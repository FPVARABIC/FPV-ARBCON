import * as base64 from './base64';
import {bytesToBase64, base64ToBytes, base64ToBytesAsync} from './base64';
import {RNMspTransport} from './RNMspTransport';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';

interface FakeClient {
  writeBytes: jest.Mock;
  onDataReceived: jest.Mock;
  onSessionDetached: jest.Mock;
  stopReading: jest.Mock;
  startReading: jest.Mock;
  emitData: (event: UsbSerialDataEvent) => void;
  emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => void;
}

function makeFakeClient(): FakeClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const sessionDetachedListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();

  const onDataReceived = jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
    dataListeners.add(cb);
    return jest.fn(() => {
      dataListeners.delete(cb);
    });
  });
  const onSessionDetached = jest.fn((cb: (event: UsbSerialSessionDetachedEvent) => void) => {
    sessionDetachedListeners.add(cb);
    return jest.fn(() => {
      sessionDetachedListeners.delete(cb);
    });
  });

  return {
    writeBytes: jest.fn(),
    onDataReceived,
    onSessionDetached,
    stopReading: jest.fn(),
    startReading: jest.fn(),
    emitData: event => {
      for (const listener of dataListeners) {
        listener(event);
      }
    },
    emitSessionDetached: event => {
      for (const listener of sessionDetachedListeners) {
        listener(event);
      }
    },
  };
}

function makeTransport(client: FakeClient = makeFakeClient()) {
  const transport = new RNMspTransport(client as unknown as UsbSerialTransportClient, SESSION_ID);
  return {client, transport};
}

describe('base64 round-trip (base64.ts)', () => {
  it('round-trips an empty payload', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('round-trips a large, arbitrary payload losslessly', () => {
    const bytes = Uint8Array.from({length: 997}, (_, i) => (i * 37 + 11) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips every single byte value 0-255', () => {
    const bytes = Uint8Array.from({length: 256}, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('decodes a large document payload incrementally without changing bytes', async () => {
    const bytes = Uint8Array.from({length: 256 * 1024 + 3}, (_, i) => (i * 17 + 5) % 256);
    await expect(base64ToBytesAsync(bytesToBase64(bytes), 32 * 1024)).resolves.toEqual(bytes);
  });
});

describe('RNMspTransport.writeBytes', () => {
  it('calls the underlying client with the correct sessionId and correctly-encoded base64', async () => {
    const {client, transport} = makeTransport();
    client.writeBytes.mockResolvedValueOnce(undefined);
    const payload = Uint8Array.from([1, 2, 3, 255]);

    await transport.writeBytes(payload);

    expect(client.writeBytes).toHaveBeenCalledTimes(1);
    const [calledSessionId, calledBase64] = client.writeBytes.mock.calls[0];
    expect(calledSessionId).toBe(SESSION_ID);
    expect(base64ToBytes(calledBase64)).toEqual(payload);
  });

  it('rejects with {code, message} (nativeMessage renamed to message; code untouched) on a native rejection', async () => {
    const {client, transport} = makeTransport();
    client.writeBytes.mockRejectedValueOnce({code: 'WRITE_FAILED', nativeMessage: 'native boom'});

    await expect(transport.writeBytes(new Uint8Array(0))).rejects.toEqual({
      code: 'WRITE_FAILED',
      message: 'native boom',
    });
  });
});

describe('RNMspTransport.onDataReceived - session filtering and ordering', () => {
  it('filters events for a different sessionId BEFORE any decoding is attempted', () => {
    const decodeSpy = jest.spyOn(base64, 'base64ToBytes');
    const {client, transport} = makeTransport();
    const received: Uint8Array[] = [];
    transport.onDataReceived(bytes => received.push(bytes));

    client.emitData({sessionId: OTHER_SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([9]))});

    expect(decodeSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    decodeSpy.mockRestore();
  });

  it('delivers multiple data events for this session in exact delivery order', () => {
    const {client, transport} = makeTransport();
    const received: number[][] = [];
    transport.onDataReceived(bytes => received.push(Array.from(bytes)));

    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([1]))});
    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([2]))});
    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([3]))});

    expect(received).toEqual([[1], [2], [3]]);
  });

  it('a throwing FIRST listener does not prevent the SECOND or THIRD from running, and the exception never escapes into the real client emit call', () => {
    const {client, transport} = makeTransport();
    const secondReceived: number[][] = [];
    const thirdReceived: number[][] = [];
    transport.onDataReceived(() => {
      throw new Error('boom - simulated throwing first data listener');
    });
    transport.onDataReceived(bytes => secondReceived.push(Array.from(bytes)));
    transport.onDataReceived(bytes => thirdReceived.push(Array.from(bytes)));

    // Calling the fake client's own emit helper is exactly the real
    // client's own event dispatch invoking the callback RNMspTransport's
    // constructor passed to onDataReceived() - if the throw escaped
    // handleRealData(), it would surface right here, at the real client's
    // own dispatch boundary, not merely inside RNMspTransport's fan-out.
    expect(() =>
      client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([7]))}),
    ).not.toThrow();

    expect(secondReceived).toEqual([[7]]);
    expect(thirdReceived).toEqual([[7]]);
  });
});

describe('RNMspTransport.onSessionDetached - session filtering', () => {
  it('ignores a session-detached event for a different sessionId', () => {
    const {client, transport} = makeTransport();
    const events: unknown[] = [];
    transport.onSessionDetached(event => events.push(event));

    client.emitSessionDetached({sessionId: OTHER_SESSION_ID, deviceId: 1});

    expect(events).toHaveLength(0);
  });

  it('delivers a matching session-detached event as {sessionId: this.sessionId}', () => {
    const {client, transport} = makeTransport();
    const events: {sessionId: string}[] = [];
    transport.onSessionDetached(event => events.push(event));

    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(events).toEqual([{sessionId: SESSION_ID}]);
  });

  it('a throwing FIRST listener does not prevent the SECOND or THIRD from running, and the exception never escapes into the real client emit call', () => {
    const {client, transport} = makeTransport();
    const second: unknown[] = [];
    const third: unknown[] = [];
    transport.onSessionDetached(() => {
      throw new Error('boom - simulated throwing first session-detached listener');
    });
    transport.onSessionDetached(event => second.push(event));
    transport.onSessionDetached(event => third.push(event));

    expect(() => client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1})).not.toThrow();

    expect(second).toEqual([{sessionId: SESSION_ID}]);
    expect(third).toEqual([{sessionId: SESSION_ID}]);
  });

  it('a listener that synchronously disposes the transport mid-dispatch (the SECOND of three) does not silently drop the THIRD listener - proves the pre-iteration snapshot', () => {
    const {client, transport} = makeTransport();
    const third: unknown[] = [];
    transport.onSessionDetached(() => undefined); // first - ordinary listener
    transport.onSessionDetached(() => {
      // Simulates exactly MspSessionCoordinator's own pattern: a listener
      // that synchronously calls dispose(), which clears
      // sessionDetachedListeners - while this very fan-out loop is still
      // iterating that same Set.
      transport.dispose();
    });
    transport.onSessionDetached(event => third.push(event));

    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(third).toEqual([{sessionId: SESSION_ID}]);
  });
});

describe('RNMspTransport.restartReceiveLoop', () => {
  it('calls stopReading() then, strictly sequentially, startReading()', async () => {
    const {client, transport} = makeTransport();
    const order: string[] = [];
    client.stopReading.mockImplementationOnce(async () => {
      order.push('stop');
    });
    client.startReading.mockImplementationOnce(async () => {
      order.push('start');
    });

    await transport.restartReceiveLoop();

    expect(order).toEqual(['stop', 'start']);
    expect(client.stopReading).toHaveBeenCalledWith(SESSION_ID);
    expect(client.startReading).toHaveBeenCalledWith(SESSION_ID);
  });

  it('never calls startReading() if stopReading() rejects, and rejects with stopReading()s reason ({code, message})', async () => {
    const {client, transport} = makeTransport();
    client.stopReading.mockRejectedValueOnce({code: 'RX_RESTART_TIMEOUT', nativeMessage: 'timed out'});

    await expect(transport.restartReceiveLoop()).rejects.toEqual({
      code: 'RX_RESTART_TIMEOUT',
      message: 'timed out',
    });
    expect(client.startReading).not.toHaveBeenCalled();
  });

  it('propagates a startReading() rejection (e.g. RX_ALREADY_ACTIVE) with code unchanged and message renamed', async () => {
    const {client, transport} = makeTransport();
    client.stopReading.mockResolvedValueOnce(undefined);
    client.startReading.mockRejectedValueOnce({code: 'RX_ALREADY_ACTIVE', nativeMessage: 'already active'});

    await expect(transport.restartReceiveLoop()).rejects.toEqual({
      code: 'RX_ALREADY_ACTIVE',
      message: 'already active',
    });
  });
});

describe('RNMspTransport.dispose', () => {
  it('unsubscribes both real subscriptions; a callback fired immediately after has no effect', () => {
    const {client, transport} = makeTransport();
    const dataEvents: unknown[] = [];
    const detachEvents: unknown[] = [];
    transport.onDataReceived(bytes => dataEvents.push(bytes));
    transport.onSessionDetached(event => detachEvents.push(event));

    transport.dispose();

    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([1]))});
    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(dataEvents).toHaveLength(0);
    expect(detachEvents).toHaveLength(0);
  });

  it('writeBytes() and restartReceiveLoop() called after dispose() reject immediately without reaching the real client', async () => {
    const {client, transport} = makeTransport();
    transport.dispose();

    await expect(transport.writeBytes(new Uint8Array(0))).rejects.toMatchObject({code: 'SESSION_CLOSED'});
    await expect(transport.restartReceiveLoop()).rejects.toMatchObject({code: 'SESSION_CLOSED'});

    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(client.stopReading).not.toHaveBeenCalled();
    expect(client.startReading).not.toHaveBeenCalled();
  });

  it('is idempotent - a second dispose() call does not throw and does not re-invoke the real unsubscribe functions', () => {
    const {client, transport} = makeTransport();
    const dataUnsubscribe = client.onDataReceived.mock.results[0].value;
    const detachUnsubscribe = client.onSessionDetached.mock.results[0].value;

    transport.dispose();
    expect(() => transport.dispose()).not.toThrow();

    expect(dataUnsubscribe).toHaveBeenCalledTimes(1);
    expect(detachUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('RNMspTransport - multiple independent listeners on ONE real subscription', () => {
  it('two listeners both receive the same data events, and one unsubscribing does not affect the other or the real subscription', () => {
    const {client, transport} = makeTransport();
    const firstReceived: number[][] = [];
    const secondReceived: number[][] = [];
    transport.onDataReceived(bytes => firstReceived.push(Array.from(bytes)));
    const unsubscribeSecond = transport.onDataReceived(bytes => secondReceived.push(Array.from(bytes)));

    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([1]))});
    expect(firstReceived).toEqual([[1]]);
    expect(secondReceived).toEqual([[1]]);

    // The real underlying subscription was created exactly once, for both
    // listeners combined - not once per internal listener.
    expect(client.onDataReceived).toHaveBeenCalledTimes(1);
    const realUnsubscribe = client.onDataReceived.mock.results[0].value;
    expect(realUnsubscribe).not.toHaveBeenCalled();

    // The second listener unsubscribes (e.g. the debug panel unmounting) -
    // this must ONLY remove it from the internal Set, never touch the real
    // subscription, which MspClient's own (the first) listener still needs.
    unsubscribeSecond();
    expect(realUnsubscribe).not.toHaveBeenCalled();

    client.emitData({sessionId: SESSION_ID, dataBase64: bytesToBase64(Uint8Array.from([2]))});

    // The first listener keeps receiving all subsequent events, completely
    // unaffected; the second (unsubscribed) listener receives nothing more.
    expect(firstReceived).toEqual([[1], [2]]);
    expect(secondReceived).toEqual([[1]]);

    // Still not torn down - only transport.dispose() itself may do that.
    expect(realUnsubscribe).not.toHaveBeenCalled();
    transport.dispose();
    expect(realUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('the same independence holds for onSessionDetached listeners', () => {
    const {client, transport} = makeTransport();
    const first: unknown[] = [];
    const second: unknown[] = [];
    transport.onSessionDetached(event => first.push(event));
    const unsubscribeSecond = transport.onSessionDetached(event => second.push(event));

    unsubscribeSecond();
    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(client.onSessionDetached).toHaveBeenCalledTimes(1);
  });
});
