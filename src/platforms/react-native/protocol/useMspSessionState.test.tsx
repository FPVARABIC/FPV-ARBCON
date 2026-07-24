/**
 * Pass 7.4, Step 4 - covers ONLY useMspRecoveryState(), the new hook.
 * useMspOwnershipState()/useMspIdentificationState() already have
 * indirect coverage via UsbConnectionScreen.test.tsx/
 * UsbSerialDebugPanel.test.tsx and had no dedicated file of their own
 * before this pass; this file does not attempt to add one for them.
 *
 * Uses the REAL mspSessionCoordinator singleton, driven through a fake
 * UsbSerialTransportClient - same structure as useTelemetryValue.test.tsx.
 * identify()'s own three requests must be scripted so it settles
 * cleanly; a write can be made to reject on demand (rejectNextWrite()) to
 * trigger a real MspClient desync/recovery cycle, the same mechanism
 * MspSessionCoordinator.test.ts's own Step 4 tests use. No fake timers
 * needed anywhere in this file - unlike useTelemetryValue.test.tsx (which
 * must advance MspSessionCoordinator's real tick-driver interval),
 * useMspRecoveryState() is purely event-driven off MspClient.subscribe(),
 * with no interval of its own to advance.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {useMspRecoveryState} from './useMspSessionState';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

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

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  let rejectNextWriteReason: {reason: unknown} | undefined;

  const fake = {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      if (rejectNextWriteReason) {
        const {reason} = rejectNextWriteReason;
        rejectNextWriteReason = undefined;
        return Promise.reject(reason);
      }
      const bytes = base64ToBytes(dataBase64);
      const command = bytes[4];
      const payload = responses.get(command);
      if (payload) {
        const frameBytes = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
        Promise.resolve().then(() => {
          const event: UsbSerialDataEvent = {sessionId, dataBase64: bytesToBase64(frameBytes)};
          for (const listener of Array.from(dataListeners)) {
            listener(event);
          }
        });
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn((cb: (event: UsbSerialSessionDetachedEvent) => void) => {
      detachListeners.add(cb);
      return jest.fn(() => detachListeners.delete(cb));
    }),
    stopReading: jest.fn().mockResolvedValue(undefined),
    startReading: jest.fn().mockResolvedValue(undefined),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
    rejectNextWrite: (reason: unknown = new Error('fake write failure')) => {
      rejectNextWriteReason = {reason};
    },
    emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => {
      for (const listener of Array.from(detachListeners)) {
        listener(event);
      }
    },
  };
  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  return fake;
}

function TestHarness({sessionId}: {sessionId: string}): React.JSX.Element {
  const value = useMspRecoveryState(sessionId);
  return <>{JSON.stringify(value ?? null)}</>;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('useMspRecoveryState', () => {
  it('returns undefined for a sessionId with no active session at all', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId="never-opened" />);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify(null));
  });

  it('reacts to a real session opening: undefined -> READY', async () => {
    const sessionId = 'rs-session-1';
    const client = makeFakeClient(sessionId);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify(null));

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify('READY'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('reacts to a real recovery-state transition: READY -> RESTARTING_READER, on a real write failure', async () => {
    const sessionId = 'rs-session-2';
    const client = makeFakeClient(sessionId);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });

    let mspClient: ReturnType<typeof mspSessionCoordinator.openSession>;
    await act(async () => {
      mspClient = mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify('READY'));

    await act(async () => {
      client.rejectNextWrite('write failed');
      // MSP_API_VERSION (1) - already has a scripted response, so the
      // probe that follows the restart resolves back to READY on its
      // own without needing a real timer.
      await mspClient!.request(1, new Uint8Array(0), {wireFormat: 'v1'}).catch(() => undefined);
      await flushAsync();
    });

    expect(renderer!.toJSON()).toBe(JSON.stringify('READY'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('reverts to undefined once the session is deactivated', async () => {
    const sessionId = 'rs-session-3';
    const client = makeFakeClient(sessionId);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify('READY'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify(null));
  });

  it('reverts to undefined after a physical detach', async () => {
    const sessionId = 'rs-session-4';
    const client = makeFakeClient(sessionId);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify('READY'));

    await act(async () => {
      client.emitSessionDetached({sessionId, deviceId: 1});
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify(null));
  });
});
