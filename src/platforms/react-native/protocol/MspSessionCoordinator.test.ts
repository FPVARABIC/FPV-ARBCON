import {MspSessionCoordinator} from './MspSessionCoordinator';
import {RNMspTransport} from './RNMspTransport';
import {MspClient} from '../../../core';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';

interface FakeClient {
  writeBytes: jest.Mock;
  onDataReceived: jest.Mock;
  onSessionDetached: jest.Mock;
  stopReading: jest.Mock;
  startReading: jest.Mock;
  emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => void;
}

function makeFakeClient(): FakeClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const sessionDetachedListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();

  return {
    writeBytes: jest.fn(),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn((cb: (event: UsbSerialSessionDetachedEvent) => void) => {
      sessionDetachedListeners.add(cb);
      return jest.fn(() => sessionDetachedListeners.delete(cb));
    }),
    stopReading: jest.fn(),
    startReading: jest.fn(),
    emitSessionDetached: event => {
      for (const listener of sessionDetachedListeners) {
        listener(event);
      }
    },
  };
}

describe('MspSessionCoordinator - one MspClient per session', () => {
  it('two different call sites into openSession() for the same sessionId observe the SAME MspClient instance', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;

    // Simulates two different "screens" both asking for the session's client.
    const fromScreenA = coordinator.openSession(client, SESSION_ID);
    const fromScreenB = coordinator.openSession(client, SESSION_ID);

    expect(fromScreenA).toBeInstanceOf(MspClient);
    expect(fromScreenA).toBe(fromScreenB);
  });

  it('getActiveMspClient() returns the same instance openSession() already created', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;

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
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;

    coordinator.openSession(client, SESSION_ID);
    const first = coordinator.getActiveTransport(SESSION_ID);
    const second = coordinator.getActiveTransport(SESSION_ID);

    expect(first).toBeInstanceOf(RNMspTransport);
    expect(first).toBe(second);
  });

  it('getActiveTransport() returns undefined for a never-opened session, and again after it is closed', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;

    expect(coordinator.getActiveTransport('never-opened')).toBeUndefined();

    coordinator.openSession(client, SESSION_ID);
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeInstanceOf(RNMspTransport);

    coordinator.closeSession(SESSION_ID);
    expect(coordinator.getActiveTransport(SESSION_ID)).toBeUndefined();
  });

  it('a different sessionId gets a different MspClient instance', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;

    const first = coordinator.openSession(client, SESSION_ID);
    const second = coordinator.openSession(client, OTHER_SESSION_ID);

    expect(first).not.toBe(second);
  });
});

describe('MspSessionCoordinator - dispose ordering', () => {
  it('closeSession() disposes MspClient BEFORE RNMspTransport, verified via a spy', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;
    const mspClient = coordinator.openSession(client, SESSION_ID);

    const order: string[] = [];
    const mspClientDisposeSpy = jest.spyOn(mspClient, 'dispose').mockImplementation(() => {
      order.push('MspClient.dispose');
    });
    const transportDisposeSpy = jest.spyOn(RNMspTransport.prototype, 'dispose').mockImplementation(() => {
      order.push('RNMspTransport.dispose');
    });

    coordinator.closeSession(SESSION_ID);

    expect(order).toEqual(['MspClient.dispose', 'RNMspTransport.dispose']);

    mspClientDisposeSpy.mockRestore();
    transportDisposeSpy.mockRestore();
  });

  it('closeSession() removes the session, so a later openSession() for the same id creates a fresh pairing', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient() as unknown as UsbSerialTransportClient;
    const first = coordinator.openSession(client, SESSION_ID);

    coordinator.closeSession(SESSION_ID);
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();

    const second = coordinator.openSession(client, SESSION_ID);
    expect(second).not.toBe(first);
  });

  it('closeSession() for an unknown sessionId is a harmless no-op', () => {
    const coordinator = new MspSessionCoordinator();
    expect(() => coordinator.closeSession('never-opened')).not.toThrow();
  });

  it('a physical detach (no explicit closeSession() call) disposes MspClient BEFORE RNMspTransport automatically', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient();
    const mspClient = coordinator.openSession(
      client as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );

    const order: string[] = [];
    const mspClientDisposeSpy = jest.spyOn(mspClient, 'dispose').mockImplementation(() => {
      order.push('MspClient.dispose');
    });
    const transportDisposeSpy = jest.spyOn(RNMspTransport.prototype, 'dispose').mockImplementation(() => {
      order.push('RNMspTransport.dispose');
    });

    // Nobody calls closeSession() - the transport itself reports the detach.
    client.emitSessionDetached({sessionId: SESSION_ID, deviceId: 1});

    expect(order).toEqual(['MspClient.dispose', 'RNMspTransport.dispose']);
    expect(coordinator.getActiveMspClient(SESSION_ID)).toBeUndefined();

    mspClientDisposeSpy.mockRestore();
    transportDisposeSpy.mockRestore();
  });

  it('a physical detach for a different sessionId does not dispose this session', () => {
    const coordinator = new MspSessionCoordinator();
    const client = makeFakeClient();
    const mspClient = coordinator.openSession(
      client as unknown as UsbSerialTransportClient,
      SESSION_ID,
    );

    client.emitSessionDetached({sessionId: OTHER_SESSION_ID, deviceId: 1});

    expect(coordinator.getActiveMspClient(SESSION_ID)).toBe(mspClient);
  });
});
