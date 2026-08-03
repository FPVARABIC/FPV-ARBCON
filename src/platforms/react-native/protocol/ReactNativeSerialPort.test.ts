jest.mock('../transport/native/NativeUsbSerialTransport');

import type {UsbSerialTransportClient} from '../transport';
import {base64ToBytes, bytesToBase64} from './base64';
import {ReactNativeSerialPort} from './ReactNativeSerialPort';

function harness() {
  let dataListener: ((event: {sessionId: string; dataBase64: string}) => void) | undefined;
  let detachListener: ((event: {sessionId: string; deviceId: number}) => void) | undefined;
  const writes: Uint8Array[] = [];
  const client = {
    openDevice: jest.fn(async () => 'session-1'),
    startReading: jest.fn(async () => undefined),
    stopReading: jest.fn(async () => undefined),
    closeSession: jest.fn(async () => undefined),
    setBaudRate: jest.fn(async () => undefined),
    setControlLines: jest.fn(async () => undefined),
    writeBytes: jest.fn(async (_session: string, data: string) => { writes.push(base64ToBytes(data)); }),
    onDataReceived: jest.fn((listener: typeof dataListener) => { dataListener = listener; return () => undefined; }),
    onSessionDetached: jest.fn((listener: typeof detachListener) => { detachListener = listener; return () => undefined; }),
  } as unknown as UsbSerialTransportClient;
  return {
    client,
    writes,
    receive(bytes: Uint8Array) { dataListener?.({sessionId: 'session-1', dataBase64: bytesToBase64(bytes)}); },
    detach() { detachListener?.({sessionId: 'session-1', deviceId: 1}); },
  };
}

describe('ReactNativeSerialPort', () => {
  it('SLIP-encodes writes and decodes a received packet without polling the JS thread', async () => {
    const h = harness();
    const port = new ReactNativeSerialPort(h.client, 1, 0);
    await port.connect();
    await port.write(Uint8Array.of(0xc0, 0xdb, 1));
    expect(Array.from(h.writes[0])).toEqual([0xc0, 0xdb, 0xdc, 0xdb, 0xdd, 1, 0xc0]);
    const read = port.read(1000);
    h.receive(Uint8Array.of(0xc0, 1, 0xdb, 0xdc, 0xc0));
    await expect(read).resolves.toEqual(Uint8Array.of(1, 0xc0));
    await port.disconnect();
  });

  it('changes the native baud rate on an already-open transport and preserves DTR/RTS state', async () => {
    const h = harness();
    const port = new ReactNativeSerialPort(h.client, 1, 0);
    await port.connect(115200);
    await port.connect(460800);
    await port.setDTR(true);
    await port.setRTS(true);
    expect(h.client.setBaudRate).toHaveBeenCalledWith('session-1', 460800);
    expect(h.client.setControlLines).toHaveBeenLastCalledWith('session-1', true, true);
    await port.disconnect();
  });

  it('rejects an in-flight read immediately on physical detach', async () => {
    const h = harness();
    const port = new ReactNativeSerialPort(h.client, 1, 0);
    await port.connect();
    const read = port.readExactly(1, 10_000);
    h.detach();
    await expect(read).rejects.toThrow(/فصل/);
  });

  it('rejects an in-flight bootloader read immediately when the operation is cancelled', async () => {
    const h = harness();
    const controller = new AbortController();
    const port = new ReactNativeSerialPort(h.client, 1, 0, controller.signal);
    await port.connect();
    const read = port.readExactly(1, 10_000);

    controller.abort();

    await expect(read).rejects.toThrow(/أُلغي/);
    await port.disconnect();
    expect(h.client.closeSession).toHaveBeenCalledWith('session-1');
  });

  it('closes a USB session that finishes opening after cancellation', async () => {
    const h = harness();
    let finishOpening!: (sessionId: string) => void;
    (h.client.openDevice as jest.Mock).mockReturnValueOnce(
      new Promise(resolve => {
        finishOpening = resolve;
      }),
    );
    const controller = new AbortController();
    const port = new ReactNativeSerialPort(h.client, 1, 0, controller.signal);
    const connect = port.connect();

    controller.abort();
    finishOpening('late-session');

    await expect(connect).rejects.toThrow(/أُلغي/);
    expect(h.client.closeSession).toHaveBeenCalledWith('late-session');
    expect(h.client.startReading).not.toHaveBeenCalled();
  });
});
