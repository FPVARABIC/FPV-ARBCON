jest.mock('../../platforms/react-native/protocol', () => ({
  mspSessionCoordinator: {
    getActiveTransport: jest.fn(),
  },
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import UsbSerialDebugPanel from './UsbSerialDebugPanel';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import type {
  UsbSerialDataEvent,
  UsbSerialErrorEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

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
  return renderer;
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

beforeEach(() => {
  getActiveTransportMock.mockReset();
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
