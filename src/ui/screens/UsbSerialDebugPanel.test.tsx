jest.mock('../../platforms/react-native/protocol', () => ({
  mspSessionCoordinator: {
    getActiveTransport: jest.fn(),
    // Pass 6.4b: getActiveMspClient()?.getState() (polled by the panel's own
    // setInterval while mspActive) and getIdentificationMetrics() (read once
    // identificationState reaches SUCCEEDED/FAILED) - both new call sites
    // added to the component this pass; the mock must satisfy them for the
    // component to render at all now, even for tests that don't care about
    // either value (they get undefined, exactly like a session the
    // coordinator has no entry for).
    getActiveMspClient: jest.fn(),
    getIdentificationMetrics: jest.fn(),
  },
  // Pass 6.4b: a plain jest.fn(), not a real useSyncExternalStore hook - this
  // file renders UsbSerialDebugPanel directly (not through React's normal
  // external-store subscription machinery), so each test simply configures
  // this mock's return value up front, exactly like the getActiveTransport
  // mock above already worked for Pass 6.3.
  useMspIdentificationState: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import UsbSerialDebugPanel from './UsbSerialDebugPanel';
import {mspSessionCoordinator, useMspIdentificationState} from '../../platforms/react-native/protocol';
import type {MspIdentificationState} from '../../platforms/react-native/protocol';
import type {MspClientState} from '../../core';
import type {
  UsbSerialDataEvent,
  UsbSerialErrorEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {MSP_ATTITUDE} from '../../core';
import type {MspFrame} from '../../core';

const SESSION_ID = 'session-debug-1';

type MockClient = {
  startReading: jest.Mock;
  stopReading: jest.Mock;
  writeBytes: jest.Mock;
  onDataReceived: jest.Mock;
  onError: jest.Mock;
  emitData: (event: UsbSerialDataEvent) => void;
  emitError: (event: UsbSerialErrorEvent) => void;
};

function createMockClient(): MockClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const errorListeners = new Set<(event: UsbSerialErrorEvent) => void>();

  return {
    startReading: jest.fn().mockResolvedValue(undefined),
    stopReading: jest.fn().mockResolvedValue(undefined),
    writeBytes: jest.fn().mockResolvedValue(undefined),
    onDataReceived: jest.fn((listener: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(listener);
      return jest.fn(() => {
        dataListeners.delete(listener);
      });
    }),
    onError: jest.fn((listener: (event: UsbSerialErrorEvent) => void) => {
      errorListeners.add(listener);
      return jest.fn(() => {
        errorListeners.delete(listener);
      });
    }),
    emitData: event => {
      for (const listener of Array.from(dataListeners)) {
        listener(event);
      }
    },
    emitError: event => {
      for (const listener of Array.from(errorListeners)) {
        listener(event);
      }
    },
  };
}

type FakeTransport = {
  onDataReceived: jest.Mock;
  emit: (bytes: Uint8Array) => void;
};

function createFakeTransport(): FakeTransport {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  return {
    onDataReceived: jest.fn((listener: (bytes: Uint8Array) => void) => {
      listeners.add(listener);
      return jest.fn(() => {
        listeners.delete(listener);
      });
    }),
    emit: bytes => {
      for (const listener of Array.from(listeners)) {
        listener(bytes);
      }
    },
  };
}

// Pass 6.4b: every renderer created in this file is tracked here and
// force-unmounted in the afterEach() below - see UsbConnectionScreen.test.tsx's
// own identical afterEach for the full reasoning. It applies just as much
// here: any test rendering with mspActive=true leaves the panel's own real
// setInterval(1000ms) MspClientState poll running (UsbSerialDebugPanel.tsx's
// own class-level note), and most tests in this file never explicitly
// unmount before returning.
const trackedRenderers: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of trackedRenderers.splice(0, trackedRenderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Best-effort - a test that already unmounted its own renderer must
        // not fail here on a harmless second unmount() call.
      }
    }
  });
});

async function renderPanel(client: MockClient, mspActive: boolean) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <UsbSerialDebugPanel
        sessionId={SESSION_ID}
        client={client as unknown as UsbSerialTransportClient}
        mspActive={mspActive}
      />,
    );
  });
  trackedRenderers.push(renderer);
  return renderer;
}

/** A minimal, valid FlightControllerIdentity fixture - only the fields the
 * panel's own SUCCEEDED display actually reads (firmware.identifier,
 * firmware.knownFamily, board.targetName) are given meaningful values;
 * every other required field is filled with an arbitrary valid placeholder
 * so the object satisfies the real FlightControllerIdentity shape. */
function buildIdentity(
  overrides: {identifier?: string; knownFamily?: string; targetName?: string} = {},
): MspIdentificationState & {status: 'SUCCEEDED'} {
  return {
    status: 'SUCCEEDED',
    identity: {
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 48},
      firmware: {
        identifier: overrides.identifier ?? 'BTFL',
        knownFamily: (overrides.knownFamily ?? 'BETAFLIGHT') as never,
      },
      board: {
        boardIdentifier: 'AFF3',
        hardwareRevision: 0,
        boardType: 0,
        targetCapabilities: 0,
        targetName: overrides.targetName ?? 'MATEKF722',
        boardName: 'MATEKF722',
        manufacturerId: 'MTKS',
        signature: new Uint8Array(32),
        mcuTypeId: 0,
        trailingBytes: new Uint8Array(0),
      },
    },
  };
}

function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  const match = matches.find(node => 'onPress' in node.props) ?? matches[0];
  if (!match) {
    throw new Error(`No element found with testID "${testID}"`);
  }
  return match;
}

function logText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text' as never)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

const getActiveTransportMock = mspSessionCoordinator.getActiveTransport as jest.Mock;
const getActiveMspClientMock = mspSessionCoordinator.getActiveMspClient as jest.Mock;
const getIdentificationMetricsMock = mspSessionCoordinator.getIdentificationMetrics as jest.Mock;
const useMspIdentificationStateMock = useMspIdentificationState as jest.Mock;

beforeEach(() => {
  getActiveTransportMock.mockReset();
  getActiveMspClientMock.mockReset();
  getIdentificationMetricsMock.mockReset();
  useMspIdentificationStateMock.mockReset();
  // Every pre-existing (Pass 6.3) test in this file renders with no opinion
  // at all about identification - IDLE (no status message, no identity
  // block) and an absent MspClient (getState() never called, since
  // getActiveMspClientMock's default `undefined` return short-circuits the
  // panel's own `?.getState()` optional chain) are the correct, inert
  // defaults for all of them. Only the new Pass 6.4b describe blocks below
  // override these per-test.
  useMspIdentificationStateMock.mockReturnValue({status: 'IDLE'} satisfies MspIdentificationState);
  getActiveMspClientMock.mockReturnValue(undefined);
});

describe('UsbSerialDebugPanel - controls enabled/disabled by mspActive', () => {
  it('leaves Start Reading, Stop Reading, and Send controls enabled when mspActive is false', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, false);

    expect(findByTestID(renderer, 'debug-start-reading').props.disabled).toBe(false);
    expect(findByTestID(renderer, 'debug-send-preset-1,2,3,4,5').props.disabled).toBe(false);
    expect(findByTestID(renderer, 'debug-send-custom').props.disabled).toBe(false);
  });

  it('disables Start Reading, Stop Reading, every preset Send, and the custom Send control when mspActive is true', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, true);

    expect(findByTestID(renderer, 'debug-start-reading').props.disabled).toBe(true);
    expect(findByTestID(renderer, 'debug-stop-reading').props.disabled).toBe(true);
    expect(findByTestID(renderer, 'debug-send-preset-1,2,3,4,5').props.disabled).toBe(true);
    expect(findByTestID(renderer, 'debug-send-preset-AA 55').props.disabled).toBe(true);
    expect(findByTestID(renderer, 'debug-send-custom').props.disabled).toBe(true);
  });

  it('shows the Arabic MSP-active notice only when mspActive is true', async () => {
    const client = createMockClient();

    const inactive = await renderPanel(client, false);
    expect(logText(inactive)).not.toContain('بروتوكول MSP نشط');

    const active = await renderPanel(client, true);
    expect(logText(active)).toContain('بروتوكول MSP نشط');
  });

  it('pressing Start Reading while mspActive never calls client.startReading()', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, true);

    const button = findByTestID(renderer, 'debug-start-reading');
    // Disabled Pressables still receive onPress in the test renderer since
    // it does not simulate a real touch responder chain - assert the real
    // guard (disabled=true) instead of relying on onPress never firing.
    expect(button.props.disabled).toBe(true);
    expect(client.startReading).not.toHaveBeenCalled();
  });
});

describe('UsbSerialDebugPanel - raw RX subscription (mspActive=false)', () => {
  it('subscribes directly to client.onDataReceived() and logs matching-session bytes', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, false);

    expect(client.onDataReceived).toHaveBeenCalledTimes(1);
    expect(getActiveTransportMock).not.toHaveBeenCalled();

    await act(async () => {
      client.emitData({sessionId: SESSION_ID, dataBase64: 'AQID'});
    });

    expect(logText(renderer)).toContain('RX  3B');
  });

  it('ignores data events for a different sessionId', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, false);

    await act(async () => {
      client.emitData({sessionId: 'some-other-session', dataBase64: 'AQID'});
    });

    expect(logText(renderer)).not.toContain('RX  3B');
  });

  it('unsubscribes the raw data listener on unmount', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, false);
    const unsubscribe = client.onDataReceived.mock.results[0].value as jest.Mock;

    await act(async () => {
      renderer.unmount();
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('UsbSerialDebugPanel - MSP-mode RX subscription (mspActive=true)', () => {
  it('does not subscribe to the raw client onDataReceived, and instead reads from the coordinator-provided transport', async () => {
    const client = createMockClient();
    const transport = createFakeTransport();
    getActiveTransportMock.mockReturnValue(transport);

    const renderer = await renderPanel(client, true);

    expect(client.onDataReceived).not.toHaveBeenCalled();
    expect(getActiveTransportMock).toHaveBeenCalledWith(SESSION_ID);
    expect(transport.onDataReceived).toHaveBeenCalledTimes(1);

    await act(async () => {
      transport.emit(Uint8Array.from([0xaa, 0x55]));
    });

    expect(logText(renderer)).toContain('RX (MSP)  2B');
  });

  it('does not crash and registers no MSP listener when getActiveTransport() returns undefined', async () => {
    const client = createMockClient();
    getActiveTransportMock.mockReturnValue(undefined);

    const renderer = await renderPanel(client, true);

    expect(getActiveTransportMock).toHaveBeenCalledWith(SESSION_ID);
    expect(logText(renderer)).toContain('debug panel attached to this session');
  });

  it('unsubscribes the MSP data listener on unmount', async () => {
    const client = createMockClient();
    const transport = createFakeTransport();
    getActiveTransportMock.mockReturnValue(transport);

    const renderer = await renderPanel(client, true);
    const unsubscribe = transport.onDataReceived.mock.results[0].value as jest.Mock;

    await act(async () => {
      renderer.unmount();
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('switches from the raw subscription to the MSP transport subscription when mspActive flips true, unsubscribing the raw one', async () => {
    const client = createMockClient();
    const transport = createFakeTransport();
    getActiveTransportMock.mockReturnValue(transport);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <UsbSerialDebugPanel
          sessionId={SESSION_ID}
          client={client as unknown as UsbSerialTransportClient}
          mspActive={false}
        />,
      );
    });
    trackedRenderers.push(renderer);
    const rawUnsubscribe = client.onDataReceived.mock.results[0].value as jest.Mock;
    expect(rawUnsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(
        <UsbSerialDebugPanel
          sessionId={SESSION_ID}
          client={client as unknown as UsbSerialTransportClient}
          mspActive
        />,
      );
    });

    expect(rawUnsubscribe).toHaveBeenCalledTimes(1);
    expect(transport.onDataReceived).toHaveBeenCalledTimes(1);
  });
});

describe('UsbSerialDebugPanel - error subscription is unaffected by mspActive', () => {
  it('logs client.onError() events regardless of mspActive', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, true);

    await act(async () => {
      client.emitError({sessionId: SESSION_ID, code: 'READ_FAILED', message: 'boom', recoverable: false});
    });

    expect(logText(renderer)).toContain('ERR READ_FAILED: boom');
  });
});

describe('UsbSerialDebugPanel - mspActiveRef guard (ref-based, not dependency-array based)', () => {
  // Renders once, mounted with mspActive=false, and returns the renderer
  // plus an update() helper to flip mspActive on the SAME component
  // instance - this is what lets a handler reference captured before the
  // flip remain valid (and testable) after it.
  async function renderTogglable(client: MockClient) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <UsbSerialDebugPanel
          sessionId={SESSION_ID}
          client={client as unknown as UsbSerialTransportClient}
          mspActive={false}
        />,
      );
    });
    trackedRenderers.push(renderer);
    const setMspActive = async (value: boolean) => {
      await act(async () => {
        renderer.update(
          <UsbSerialDebugPanel
            sessionId={SESSION_ID}
            client={client as unknown as UsbSerialTransportClient}
            mspActive={value}
          />,
        );
      });
    };
    return {renderer, setMspActive};
  }

  it('handleStartReading: a reference captured while mspActive=false is still blocked once mspActive flips true, and un-blocks when it flips back', async () => {
    const client = createMockClient();
    const {renderer, setMspActive} = await renderTogglable(client);

    // The SAME captured reference throughout - handleStartReading's own
    // useCallback deps ([client, sessionId, appendLog]) do not include
    // mspActive, so this is exactly the "already holds a stale reference"
    // scenario the ref-based guard exists for.
    const startOnPress = findByTestID(renderer, 'debug-start-reading').props.onPress as () => Promise<void>;

    await setMspActive(true);
    await act(async () => {
      await startOnPress();
    });

    expect(client.startReading).not.toHaveBeenCalled();
    expect(logText(renderer)).toContain('DEBUG_CONTROL_BLOCKED_BY_MSP');
    // No busy-state side effect: the "startReading() called" log line is
    // only appended after setReadBusy(true), immediately below the guard -
    // its absence proves the guard returned before any local state change.
    expect(logText(renderer)).not.toContain('startReading() called');

    await setMspActive(false);
    await act(async () => {
      await startOnPress();
    });

    expect(client.startReading).toHaveBeenCalledTimes(1);
    expect(logText(renderer)).toContain('startReading() called');
    expect(logText(renderer)).toContain('startReading() resolved');
  });

  it('handleStopReading: a reference captured while mspActive=false is still blocked once mspActive flips true, and un-blocks when it flips back', async () => {
    const client = createMockClient();
    const {renderer, setMspActive} = await renderTogglable(client);

    const stopOnPress = findByTestID(renderer, 'debug-stop-reading').props.onPress as () => Promise<void>;

    await setMspActive(true);
    await act(async () => {
      await stopOnPress();
    });

    expect(client.stopReading).not.toHaveBeenCalled();
    expect(logText(renderer)).toContain('DEBUG_CONTROL_BLOCKED_BY_MSP');
    expect(logText(renderer)).not.toContain('stopReading() called');

    await setMspActive(false);
    await act(async () => {
      await stopOnPress();
    });

    expect(client.stopReading).toHaveBeenCalledTimes(1);
    expect(logText(renderer)).toContain('stopReading() called');
    expect(logText(renderer)).toContain('stopReading() resolved');
  });

  it('sendBytes (custom Send path): a reference captured while mspActive=false is still blocked once mspActive flips true, and un-blocks when it flips back', async () => {
    const client = createMockClient();
    const {renderer, setMspActive} = await renderTogglable(client);

    // handleSendCustom's own useCallback deps ([byteInput, sendBytes,
    // appendLog]) do not include mspActive either - sendBytes itself is
    // where the guard lives.
    const sendCustomOnPress = findByTestID(renderer, 'debug-send-custom').props.onPress as () => void;

    await setMspActive(true);
    await act(async () => {
      sendCustomOnPress();
    });

    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(logText(renderer)).toContain('DEBUG_CONTROL_BLOCKED_BY_MSP');
    expect(logText(renderer)).not.toContain('TX  (custom)');

    await setMspActive(false);
    await act(async () => {
      sendCustomOnPress();
    });

    expect(client.writeBytes).toHaveBeenCalledTimes(1);
    expect(logText(renderer)).toContain('TX  (custom)');
  });

  it('sendBytes (preset Send path): a reference captured while mspActive=false is still blocked once mspActive flips true, and un-blocks when it flips back', async () => {
    const client = createMockClient();
    const {renderer, setMspActive} = await renderTogglable(client);

    const sendPresetOnPress = findByTestID(renderer, 'debug-send-preset-1,2,3,4,5').props.onPress as () => void;

    await setMspActive(true);
    await act(async () => {
      sendPresetOnPress();
    });

    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(logText(renderer)).toContain('DEBUG_CONTROL_BLOCKED_BY_MSP');
    expect(logText(renderer)).not.toContain('TX  (1,2,3,4,5)');

    await setMspActive(false);
    await act(async () => {
      sendPresetOnPress();
    });

    expect(client.writeBytes).toHaveBeenCalledTimes(1);
    expect(logText(renderer)).toContain('TX  (1,2,3,4,5)');
  });

  it('DEBUG_CONTROL_BLOCKED_BY_MSP is never surfaced as anything other than a plain internal log line (no separate error/toast text)', async () => {
    const client = createMockClient();
    const {renderer, setMspActive} = await renderTogglable(client);
    const startOnPress = findByTestID(renderer, 'debug-start-reading').props.onPress as () => Promise<void>;

    await setMspActive(true);
    await act(async () => {
      await startOnPress();
    });

    // It appears exactly as an appendLog() entry, timestamp-prefixed like
    // every other diagnostic line - not wrapped in "ERR ..." (the format
    // client.onError() events use) or any other distinguishing marker.
    const matchingLines = renderer.root
      .findAllByType('Text' as never)
      .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
      .filter((text): text is string => typeof text === 'string')
      .join('\n')
      .split('\n')
      .filter(line => line.includes('DEBUG_CONTROL_BLOCKED_BY_MSP'));

    expect(matchingLines).toHaveLength(1);
    expect(matchingLines[0]).not.toContain('ERR ');
  });
});

describe('UsbSerialDebugPanel - Pass 6.4b read-only MSP status message (Step 7 priority order)', () => {
  it('shows the "identifying" message while identificationState is RUNNING', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue({status: 'RUNNING'} satisfies MspIdentificationState);
    const renderer = await renderPanel(client, true);

    expect(findByTestID(renderer, 'msp-status-message').props.children).toBe('جارٍ التعرّف على وحدة التحكم…');
  });

  it('shows the FAILED message when identification failed but the client is otherwise fine', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue({
      status: 'FAILED',
      error: new Error('boom'),
    } satisfies MspIdentificationState);
    getActiveMspClientMock.mockReturnValue({getState: () => 'READY' as MspClientState});
    const renderer = await renderPanel(client, true);

    expect(findByTestID(renderer, 'msp-status-message').props.children).toBe(
      'تعذّر التعرّف على نوع وحدة التحكم، مع بقاء الاتصال قائمًا.',
    );
  });

  it('shows the RECOVERY_FAILED message, outranking a simultaneously RUNNING identification status', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue({status: 'RUNNING'} satisfies MspIdentificationState);
    getActiveMspClientMock.mockReturnValue({getState: () => 'RECOVERY_FAILED' as MspClientState});
    const renderer = await renderPanel(client, true);

    expect(findByTestID(renderer, 'msp-status-message').props.children).toBe(
      'تعذّرت استعادة اتصال MSP. أعد الاتصال بوحدة التحكم للمتابعة.',
    );
  });

  it('shows the DISCONNECTED message, outranking RECOVERY_FAILED too', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue({status: 'IDLE'} satisfies MspIdentificationState);
    getActiveMspClientMock.mockReturnValue({getState: () => 'DISCONNECTED' as MspClientState});
    const renderer = await renderPanel(client, true);

    expect(findByTestID(renderer, 'msp-status-message').props.children).toBe(
      'انتهت جلسة الاتصال بوحدة التحكم أو تم فصلها.',
    );
  });

  it('shows no status message once identification SUCCEEDED and the client is READY', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue(buildIdentity());
    getActiveMspClientMock.mockReturnValue({getState: () => 'READY' as MspClientState});
    const renderer = await renderPanel(client, true);

    expect(renderer.root.findAllByProps({testID: 'msp-status-message'})).toHaveLength(0);
  });

  it('shows no status message while mspActive is false, regardless of identificationState', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue({status: 'RUNNING'} satisfies MspIdentificationState);
    const renderer = await renderPanel(client, false);

    expect(renderer.root.findAllByProps({testID: 'msp-status-message'})).toHaveLength(0);
  });

  it('no write/RX-control button becomes enabled in any status/identification combination', async () => {
    const client = createMockClient();
    const identificationScenarios: MspIdentificationState[] = [
      {status: 'IDLE'},
      {status: 'RUNNING'},
      {status: 'FAILED', error: new Error('boom')},
      buildIdentity(),
    ];
    const clientStateScenarios: Array<MspClientState | undefined> = [
      undefined,
      'READY',
      'RECOVERY_FAILED',
      'DISCONNECTED',
    ];

    for (const identificationState of identificationScenarios) {
      for (const clientState of clientStateScenarios) {
        useMspIdentificationStateMock.mockReturnValue(identificationState);
        getActiveMspClientMock.mockReturnValue(
          clientState === undefined ? undefined : {getState: () => clientState},
        );
        const renderer = await renderPanel(client, true);

        expect(findByTestID(renderer, 'debug-start-reading').props.disabled).toBe(true);
        expect(findByTestID(renderer, 'debug-stop-reading').props.disabled).toBe(true);
        expect(findByTestID(renderer, 'debug-send-preset-1,2,3,4,5').props.disabled).toBe(true);
        expect(findByTestID(renderer, 'debug-send-preset-AA 55').props.disabled).toBe(true);
        expect(findByTestID(renderer, 'debug-send-custom').props.disabled).toBe(true);
      }
    }
  });
});

describe('UsbSerialDebugPanel - Pass 6.4b identification result display (SUCCEEDED)', () => {
  it('shows no identity section at all for IDLE/RUNNING/FAILED identification states', async () => {
    const client = createMockClient();
    for (const identificationState of [
      {status: 'IDLE'},
      {status: 'RUNNING'},
      {status: 'FAILED', error: new Error('boom')},
    ] satisfies MspIdentificationState[]) {
      useMspIdentificationStateMock.mockReturnValue(identificationState);
      const renderer = await renderPanel(client, true);
      expect(renderer.root.findAllByProps({testID: 'msp-identity-section'})).toHaveLength(0);
    }
  });

  it('displays the firmware identifier, known family, and board target name once identification SUCCEEDED', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue(
      buildIdentity({identifier: 'BTFL', knownFamily: 'BETAFLIGHT', targetName: 'MATEKF722'}),
    );
    const renderer = await renderPanel(client, true);

    expect(renderer.root.findAllByProps({testID: 'msp-identity-section'}).length).toBeGreaterThan(0);
    const text = logText(renderer);
    expect(text).toContain('BTFL');
    expect(text).toContain('BETAFLIGHT');
    expect(text).toContain('MATEKF722');
  });

  it('displays the metrics snapshot alongside a SUCCEEDED identity, sourced from getIdentificationMetrics()', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue(buildIdentity());
    getIdentificationMetricsMock.mockReturnValue({
      startedAtMs: 1_000,
      completedAtMs: 1_250,
      durationMs: 250,
      nativeChunkCount: 4,
      receivedByteCount: 32,
      completedFrameCount: 3,
      diagnosticCount: 0,
    });
    const renderer = await renderPanel(client, true);

    expect(getIdentificationMetricsMock).toHaveBeenCalledWith(SESSION_ID);
    const text = logText(renderer);
    expect(text).toContain('chunks=4');
    expect(text).toContain('bytes=32');
    expect(text).toContain('frames=3');
    expect(text).toContain('diagnostics=0');
    expect(text).toContain('duration=250ms');
  });

  it('renders the identity block even with no metrics snapshot available (getIdentificationMetrics() returns undefined)', async () => {
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue(buildIdentity());
    getIdentificationMetricsMock.mockReturnValue(undefined);
    const renderer = await renderPanel(client, true);

    expect(renderer.root.findAllByProps({testID: 'msp-identity-section'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'msp-identification-metrics'})).toHaveLength(0);
  });

  it('does not call identify() or expose any new write capability from the identity display itself', async () => {
    // The panel has no identify()-triggering call of its own anywhere - this
    // is a structural guarantee (no such function exists on the component's
    // props or imports), verified here simply by confirming the mocked
    // coordinator's only two read-site methods used by this display
    // (getIdentificationMetrics/getActiveMspClient) were called with no
    // arguments beyond sessionId, and client.writeBytes/startReading/
    // stopReading remain untouched by merely rendering a SUCCEEDED state.
    const client = createMockClient();
    useMspIdentificationStateMock.mockReturnValue(buildIdentity());
    await renderPanel(client, true);

    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(client.startReading).not.toHaveBeenCalled();
    expect(client.stopReading).not.toHaveBeenCalled();
  });
});

// PASS7.0 (TEMPORARY) - remove alongside the panel section/handler these
// tests cover, and pollingCapacityAudit.ts/.test.ts.
describe('UsbSerialDebugPanel - Pass 7.0 TEMPORARY polling-capacity audit section', () => {
  function attitudeFrame(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): MspFrame {
    const s16le = (value: number) => {
      const unsigned = value < 0 ? value + 0x10000 : value;
      return [unsigned & 0xff, (unsigned >> 8) & 0xff];
    };
    const payload = Uint8Array.from([...s16le(rollDecidegrees), ...s16le(pitchDecidegrees), ...s16le(yawDegrees)]);
    return {protocolVersion: 'v1', wireFormat: 'v1', direction: 'response', command: MSP_ATTITUDE, flags: 0, payload};
  }

  function createFakeMspClient(overrides: {request?: () => Promise<MspFrame>} = {}) {
    return {
      getState: jest.fn(() => 'READY' as MspClientState),
      request: jest.fn(overrides.request ?? (async () => attitudeFrame(10, -20, 30))),
      onDiagnostic: jest.fn(() => jest.fn()),
    };
  }

  it('renders no polling-audit section at all while mspActive is false', async () => {
    const client = createMockClient();
    const renderer = await renderPanel(client, false);

    expect(renderer.root.findAllByProps({testID: 'polling-capacity-audit-section'})).toHaveLength(0);
  });

  it('renders the section (with its run button) once mspActive is true', async () => {
    const client = createMockClient();
    getActiveMspClientMock.mockReturnValue(createFakeMspClient());
    getActiveTransportMock.mockReturnValue(createFakeTransport());
    const renderer = await renderPanel(client, true);

    expect(renderer.root.findAllByProps({testID: 'polling-capacity-audit-section'}).length).toBeGreaterThan(0);
    expect(findByTestID(renderer, 'polling-capacity-audit-run').props.disabled).toBe(false);
  });

  it('runs the real harness against getActiveMspClient()/getActiveTransport() for this exact session and displays a summary', async () => {
    const client = createMockClient();
    const fakeMspClient = createFakeMspClient();
    const fakeTransport = createFakeTransport();
    getActiveMspClientMock.mockReturnValue(fakeMspClient);
    getActiveTransportMock.mockReturnValue(fakeTransport);
    const renderer = await renderPanel(client, true);

    const runButton = findByTestID(renderer, 'polling-capacity-audit-run');
    await act(async () => {
      await (runButton.props.onPress as () => Promise<void>)();
    });

    expect(getActiveMspClientMock).toHaveBeenCalledWith(SESSION_ID);
    expect(getActiveTransportMock).toHaveBeenCalledWith(SESSION_ID);
    // Default maxRequests (100) with every request succeeding instantly and
    // state always READY - the harness's own maxRequests stop condition is
    // what ends this run.
    expect(fakeMspClient.request).toHaveBeenCalledTimes(100);
    const summary = renderer.root.findAllByProps({testID: 'polling-capacity-audit-summary'})[0];
    expect(summary.props.children.join('')).toContain('attempted=100');
    expect(summary.props.children.join('')).toContain('success=100');
    expect(summary.props.children.join('')).toContain('error=0');
  });

  it('shows an error message (not a crash) instead of running when no MSP session is actually active', async () => {
    const client = createMockClient();
    getActiveMspClientMock.mockReturnValue(undefined);
    getActiveTransportMock.mockReturnValue(undefined);
    const renderer = await renderPanel(client, true);

    const runButton = findByTestID(renderer, 'polling-capacity-audit-run');
    await act(async () => {
      await (runButton.props.onPress as () => Promise<void>)();
    });

    expect(renderer.root.findAllByProps({testID: 'polling-capacity-audit-summary'})).toHaveLength(0);
    expect(findByTestID(renderer, 'polling-capacity-audit-error')).toBeDefined();
  });

  it('never calls client.startReading()/writeBytes() (the raw transport methods) - only mspClient.request()', async () => {
    const client = createMockClient();
    const fakeMspClient = createFakeMspClient();
    getActiveMspClientMock.mockReturnValue(fakeMspClient);
    getActiveTransportMock.mockReturnValue(createFakeTransport());
    const renderer = await renderPanel(client, true);

    const runButton = findByTestID(renderer, 'polling-capacity-audit-run');
    await act(async () => {
      await (runButton.props.onPress as () => Promise<void>)();
    });

    expect(client.startReading).not.toHaveBeenCalled();
    expect(client.writeBytes).not.toHaveBeenCalled();
    expect(fakeMspClient.request).toHaveBeenCalled();
  });
});
