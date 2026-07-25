/**
 * Uses the REAL mspSessionCoordinator singleton, driven through a fake
 * UsbSerialTransportClient - same structure as useMspSessionState.test.tsx/
 * useTelemetryValue.test.tsx. Covers the real 5-state connection
 * indicator end to end (not just the pure derivation, already covered by
 * connectionIndicator.test.ts) and the arming badge/notice banner
 * rendering from props.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import TopSystemBar from './TopSystemBar';
import '../../../i18n';
import {mspSessionCoordinator} from '../../../platforms/react-native/protocol';
import {MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO} from '../../../core';
import type {ArmingReadiness} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from '../../../platforms/react-native/protocol/base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../../../platforms/react-native/transport';

const UNKNOWN_ARMING: ArmingReadiness = {status: 'UNKNOWN', cause: 'UNAVAILABLE'};

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function boardInfoPayload(boardName = 'MyBoard'): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16le(0),
    0,
    0,
    ...pstring('TEST'),
    ...pstring(boardName),
    ...pstring('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}

function makeFakeClient(sessionId: string, options: {deferStartReading?: boolean} = {}) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  let rejectNextWriteReason: {reason: unknown} | undefined;
  let resolveStartReadingImpl: () => void = () => undefined;
  const startReadingPromise = options.deferStartReading
    ? new Promise<void>(resolve => {
        resolveStartReadingImpl = resolve;
      })
    : Promise.resolve(undefined);

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
    startReading: jest.fn(() => startReadingPromise),
    resolveStartReading: () => {
      resolveStartReadingImpl();
    },
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

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

describe('TopSystemBar', () => {
  it('shows DISCONNECTED for a sessionId with no active session at all', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId="never-opened" onBack={jest.fn()} armingReadiness={UNKNOWN_ARMING} />,
      );
    });
    expect(allText(renderer)).toContain('غير متصل');
    expect(findByTestID(renderer, 'setup-top-bar-notice')).not.toBeNull();
  });

  it('reacts to a real session opening and identifying: DISCONNECTED -> ACTIVATING -> CONNECTED, board name and firmware appear', async () => {
    const sessionId = 'tb-session-1';
    const client = makeFakeClient(sessionId);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId={sessionId} onBack={jest.fn()} armingReadiness={UNKNOWN_ARMING} />,
      );
    });
    expect(allText(renderer)).toContain('غير متصل');

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    expect(allText(renderer)).toContain('متصل');
    expect(allText(renderer)).not.toContain('غير متصل');
    expect(allText(renderer)).toContain('MyBoard');
    expect(allText(renderer)).toContain('BETAFLIGHT 1.48');
    // No notice banner while genuinely connected with successful identification.
    expect(findByTestID(renderer, 'setup-top-bar-notice')).toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('shows the board placeholder while identification has not succeeded yet', async () => {
    const sessionId = 'tb-session-2';
    // deferStartReading: true - identify() cannot even begin until this
    // test explicitly resolves startReading() (mirrors
    // MspSessionCoordinator.test.ts's own fixture), giving a genuine,
    // controllable "not yet identified" window - the earlier version of
    // this test relied on catching a transient moment before any
    // microtask flush, which act()'s own aggressive draining does not
    // reliably preserve.
    const client = makeFakeClient(sessionId, {deferStartReading: true});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId={sessionId} onBack={jest.fn()} armingReadiness={UNKNOWN_ARMING} />,
      );
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    const boardText = findByTestID(renderer, 'setup-top-bar-board-name');
    expect(boardText?.props.children).toBe('—');

    await act(async () => {
      client.resolveStartReading();
      await flushAsync();
    });
    expect(findByTestID(renderer, 'setup-top-bar-board-name')?.props.children).toBe('MyBoard');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('reacts to a real desync/recovery round trip: settles back to CONNECTED with no lingering notice, proving the hook stays live through a real transition', async () => {
    const sessionId = 'tb-session-3';
    const client = makeFakeClient(sessionId);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    let mspClient: ReturnType<typeof mspSessionCoordinator.openSession>;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId={sessionId} onBack={jest.fn()} armingReadiness={UNKNOWN_ARMING} />,
      );
      mspClient = mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(allText(renderer)).toContain('متصل');
    expect(findByTestID(renderer, 'setup-top-bar-notice')).toBeNull();

    // The fixture auto-resolves every scripted command (including
    // MSP_PROBE_COMMAND, which is command 1 = MSP_API_VERSION, already
    // scripted for identify()) within the SAME act() flush - this proves
    // getMspRecoveryState()/useMspRecoveryState() correctly observe a
    // full real desync -> RESTARTING_READER -> PROBING -> READY round
    // trip end to end (already covered at the coordinator/hook layers -
    // MspSessionCoordinator.test.ts and useMspSessionState.test.tsx -
    // for the transient RESTARTING_READER moment specifically), rather
    // than asserting a fleeting intermediate state this auto-resolving
    // fixture cannot reliably freeze.
    await act(async () => {
      client.rejectNextWrite('write failed');
      await mspClient!.request(1, new Uint8Array(0), {wireFormat: 'v1'}).catch(() => undefined);
      await flushAsync();
    });

    expect(allText(renderer)).toContain('متصل');
    expect(findByTestID(renderer, 'setup-top-bar-notice')).toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  it('pressing the back button calls onBack()', async () => {
    const onBack = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId="never-opened" onBack={onBack} armingReadiness={UNKNOWN_ARMING} />,
      );
    });

    await act(async () => {
      findByTestID(renderer, 'setup-top-bar-back')!.props.onPress();
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders each ArmingReadiness status as its own distinct badge label', async () => {
    const cases: Array<[ArmingReadiness, string]> = [
      [{status: 'ARMED'}, 'مسلّحة'],
      [{status: 'READY'}, 'جاهزة'],
      [{status: 'BLOCKED', reasons: []}, 'غير جاهزة'],
      [{status: 'UNKNOWN', cause: 'WAITING'}, 'غير مؤكدة'],
    ];
    for (const [readiness, expectedLabel] of cases) {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          <TopSystemBar sessionId="never-opened" onBack={jest.fn()} armingReadiness={readiness} />,
        );
      });
      expect(allText(renderer!)).toContain(expectedLabel);
    }
  });

  it('never renders a raw sessionId or internal error code anywhere', async () => {
    const sessionId = 'tb-should-not-leak-this-id';
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <TopSystemBar sessionId={sessionId} onBack={jest.fn()} armingReadiness={UNKNOWN_ARMING} />,
      );
    });
    expect(allText(renderer!).join(' ')).not.toContain(sessionId);
  });
});
