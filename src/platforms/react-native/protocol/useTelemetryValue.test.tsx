/**
 * Uses the REAL mspSessionCoordinator singleton (useTelemetryValue.ts
 * hardcodes that import, same as useMspOwnershipState()/
 * useMspIdentificationState() already do - not injectable), driven
 * through a fake UsbSerialTransportClient. identify()'s own three
 * requests (MSP_API_VERSION/MSP_FC_VARIANT/MSP_BOARD_INFO) MUST be
 * scripted too, even though this file only cares about MSP_ATTITUDE -
 * confirmed by direct investigation (not assumed): MspClient allows only
 * ONE request in flight at a time, queuing anything else behind it: an
 * unscripted (forever-pending) identify() request would permanently
 * block the MSP_ATTITUDE request the telemetry scheduler dispatches
 * right after it from ever reaching the wire at all. Every test
 * deactivates its own session at the end so no state or real
 * tick-driver interval leaks into another test.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {useTelemetryValue} from './useTelemetryValue';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {ATTITUDE_TELEMETRY_POLL_ID} from './MspSessionCoordinator';
import {MSP_ATTITUDE, MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from '../../../core';
import type {MspAttitude} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';

function attitudePayload(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): Uint8Array {
  const s16le = (value: number) => {
    const unsigned = value < 0 ? value + 0x10000 : value;
    return [unsigned & 0xff, (unsigned >> 8) & 0xff];
  };
  return Uint8Array.from([...s16le(rollDecidegrees), ...s16le(pitchDecidegrees), ...s16le(yawDegrees)]);
}

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** A minimal, valid MSP_BOARD_INFO response payload (guaranteed prefix
 * only) - same shape MspSessionCoordinator.test.ts's own boardInfoPayload()
 * already established. */
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

  const fake = {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
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
    emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => {
      for (const listener of Array.from(detachListeners)) {
        listener(event);
      }
    },
  };
  // Let identify() complete quickly and cleanly so it never occupies
  // MspClient's single in-flight slot for longer than necessary - see
  // this file's own doc comment.
  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  return fake;
}

function TestHarness({
  sessionId,
  enabled = true,
}: {
  sessionId: string;
  enabled?: boolean;
}): React.JSX.Element {
  const value = useTelemetryValue<MspAttitude>(
    sessionId,
    ATTITUDE_TELEMETRY_POLL_ID,
    enabled,
  );
  return <>{JSON.stringify(value)}</>;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('useTelemetryValue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns UNAVAILABLE for a sessionId with no active session at all', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId="never-opened" />);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));
  });

  it('reacts to a real scheduler being created and dispatching real data: UNAVAILABLE -> WAITING -> FRESH', async () => {
    const sessionId = 'ht-session-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(15, -5, 90));

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    // Scheduler now exists, poll registered, but the first tick() hasn't
    // fired yet (the tick driver only fires every 50ms, starting after
    // the first interval elapses).
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'WAITING'}));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });

    const rendered = JSON.parse(renderer!.toJSON() as unknown as string);
    expect(rendered).toMatchObject({
      status: 'FRESH',
      value: {rollDecidegrees: 15, pitchDecidegrees: -5, yawDegrees: 90},
    });

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('reverts to UNAVAILABLE once the session is deactivated', async () => {
    const sessionId = 'ht-session-2';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    expect(JSON.parse(renderer!.toJSON() as unknown as string).status).toBe('FRESH');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));
  });

  it('a physical detach also reverts the hook to UNAVAILABLE', async () => {
    const sessionId = 'ht-session-3';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(1, 1, 1));

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TestHarness sessionId={sessionId} />);
    });

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    expect(JSON.parse(renderer!.toJSON() as unknown as string).status).toBe('FRESH');

    await act(async () => {
      client.emitSessionDetached({sessionId, deviceId: 1});
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));
  });

  it('does not re-render a hidden consumer at telemetry frequency and catches up when enabled again', async () => {
    const sessionId = 'ht-session-hidden';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(10, 20, 30));

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TestHarness sessionId={sessionId} enabled={false} />,
      );
    });
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));

    await act(async () => {
      mspSessionCoordinator.openSession(
        client as unknown as UsbSerialTransportClient,
        sessionId,
      );
      await flushAsync();
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    // The scheduler is live, but the hidden tree owns no subscription and
    // therefore keeps its last rendered snapshot.
    expect(renderer!.toJSON()).toBe(JSON.stringify({status: 'UNAVAILABLE'}));

    await act(async () => {
      renderer!.update(<TestHarness sessionId={sessionId} enabled />);
    });
    expect(JSON.parse(renderer!.toJSON() as unknown as string)).toMatchObject({
      status: 'FRESH',
      value: {rollDecidegrees: 10, pitchDecidegrees: 20, yawDegrees: 30},
    });

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      renderer!.unmount();
    });
  });
});
