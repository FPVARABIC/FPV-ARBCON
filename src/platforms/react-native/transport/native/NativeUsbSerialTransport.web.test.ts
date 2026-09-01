/**
 * @jest-environment jsdom
 *
 * THE WEB SERIAL TRANSPORT.
 *
 * These tests drive the module through a fake `navigator.serial` that
 * behaves the way the real API does - streams that must be unlocked
 * before close(), a baud rate fixed at open() time, DOMExceptions with
 * the browser's own error names. What is asserted is not "the code runs"
 * but the four properties the rest of the stack depends on:
 *
 *   1. The scan NEVER opens a permission chooser. requestPort() is called
 *      only by the explicit picker entry point.
 *   2. Bytes cross the boundary unchanged, in the chunks the device sent
 *      them - the shared MSP parser above handles framing and must not be
 *      second-guessed here.
 *   3. Nothing is ever fabricated: no port, no session, no device name,
 *      and no success when the browser has no Web Serial at all.
 *   4. Teardown genuinely releases the streams, because a locked reader
 *      makes port.close() throw and the next connection attempt fail.
 */

import transport, {
  __resetWebSerialTransportForTests,
} from './NativeUsbSerialTransport.web';
import type {SerialConfiguration} from './NativeUsbSerialTransport';
import {bytesToBase64} from '../../protocol/base64';

const CONFIG: SerialConfiguration = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: '1',
  parity: 'none',
  flowControl: 'off',
};

/* ------------------------------------------------------------------ *
 * A Web Serial fake with the real API's locking behaviour
 * ------------------------------------------------------------------ */

class FakePort {
  opened = false;
  openCalls: unknown[] = [];
  closeCalls = 0;
  signals: Array<{dataTerminalReady: boolean; requestToSend: boolean}> = [];
  written: Uint8Array[] = [];
  openError: unknown = null;
  closeError: unknown = null;
  /** open() never settles - models a wedged driver (D1). */
  openHangs = false;
  /** getReader() throws - models a readable stream that cannot lock (D7). */
  readerUnavailable = false;
  /** The NEXT pending read() rejects - models a mid-session stream death (D2). */
  failNextRead: unknown = null;
  /** writer.write() never settles - models a driver whose queue filled
   *  because the peer stopped draining (a browned-out board, a hub that
   *  went away without a disconnect event). */
  writeHangs = false;
  /** Set when the module releases a writer it gave up waiting on. */
  writerReleases = 0;

  private readerLocked = false;
  private writerLocked = false;
  private pending: Array<(value: {value?: Uint8Array; done: boolean}) => void> = [];
  private queue: Uint8Array[] = [];
  private finished = false;

  constructor(private readonly info: {usbVendorId?: number; usbProductId?: number}) {}

  getInfo() {
    return this.info;
  }

  async open(options: unknown): Promise<void> {
    if (this.openHangs) {
      return new Promise<void>(() => {});
    }
    if (this.openError) {
      throw this.openError;
    }
    if (this.opened) {
      throw new DOMException('already open', 'InvalidStateError');
    }
    this.openCalls.push(options);
    this.opened = true;
    this.finished = false;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) {
      throw this.closeError;
    }
    // The real API throws if a stream is still locked. Asserting it here
    // is what makes "teardown releases the reader" a genuine test rather
    // than a hopeful one.
    if (this.readerLocked || this.writerLocked) {
      throw new DOMException('port streams are locked', 'InvalidStateError');
    }
    this.opened = false;
  }

  async setSignals(signals: {dataTerminalReady: boolean; requestToSend: boolean}) {
    this.signals.push(signals);
  }

  /** Delivers a chunk to whatever reader is pumping. */
  deliver(bytes: Uint8Array): void {
    const waiter = this.pending.shift();
    if (waiter) {
      waiter({value: bytes, done: false});
      return;
    }
    this.queue.push(bytes);
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.opened) {
      return null;
    }
    // Arrow functions throughout so `this` stays lexical - no alias.
    return {
      getReader: () => {
        if (this.readerUnavailable) {
          throw new TypeError('cannot lock readable');
        }
        if (this.readerLocked) {
          throw new TypeError('stream already locked');
        }
        this.readerLocked = true;
        return {
          read: async () => {
            if (this.failNextRead) {
              const failure = this.failNextRead;
              this.failNextRead = null;
              throw failure;
            }
            if (this.finished) {
              return {value: undefined, done: true};
            }
            const queued = this.queue.shift();
            if (queued) {
              return {value: queued, done: false};
            }
            return new Promise(resolve => {
              this.pending.push(resolve);
            });
          },
          cancel: async () => {
            this.finished = true;
            const waiters = this.pending;
            this.pending = [];
            for (const waiter of waiters) {
              waiter({value: undefined, done: true});
            }
          },
          releaseLock: () => {
            this.readerLocked = false;
          },
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.opened) {
      return null;
    }
    return {
      getWriter: () => {
        if (this.writerLocked) {
          throw new TypeError('stream already locked');
        }
        this.writerLocked = true;
        return {
          write: (chunk: Uint8Array) => {
            if (this.writeHangs) {
              return new Promise<void>(() => {});
            }
            this.written.push(chunk);
            return Promise.resolve();
          },
          releaseLock: () => {
            this.writerReleases += 1;
            this.writerLocked = false;
          },
        };
      },
    } as unknown as WritableStream<Uint8Array>;
  }
}

type FakeSerial = {
  getPorts: jest.Mock;
  requestPort: jest.Mock;
  addEventListener: jest.Mock;
  dispatch(type: 'connect' | 'disconnect', port: FakePort): void;
};

function installSerial(ports: FakePort[]): FakeSerial {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const serial: FakeSerial = {
    getPorts: jest.fn(async () => ports),
    requestPort: jest.fn(async () => ports[0]),
    addEventListener: jest.fn((type: string, listener: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    }),
    dispatch(type, port) {
      for (const listener of listeners.get(type) ?? []) {
        listener({target: port});
      }
    },
  };
  Object.defineProperty(navigator, 'serial', {value: serial, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});
  return serial;
}

function removeSerial(secure: boolean): void {
  Reflect.deleteProperty(navigator as object, 'serial');
  Object.defineProperty(window, 'isSecureContext', {value: secure, configurable: true});
}

/** Lets the transport's internal read-loop microtasks run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  __resetWebSerialTransportForTests();
  Reflect.deleteProperty(navigator as object, 'serial');
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe('listDevices', () => {
  it('uses getPorts() ONLY - the scan never opens a chooser', async () => {
    // The single most important assertion in this file. listDevices() is
    // called on a timer by the connection screen; a requestPort() in this
    // path would pop a browser permission dialog at the app's own
    // initiative, over and over.
    const serial = installSerial([new FakePort({usbVendorId: 0x0483, usbProductId: 0x5740})]);

    await transport.listDevices();
    await transport.listDevices();

    expect(serial.getPorts).toHaveBeenCalledTimes(2);
    expect(serial.requestPort).not.toHaveBeenCalled();
  });

  it('reports a connectable descriptor with no invented identity', async () => {
    installSerial([new FakePort({usbVendorId: 0x0483, usbProductId: 0x5740})]);

    const [device] = await transport.listDevices();

    expect(device.vendorId).toBe(0x0483);
    expect(device.productId).toBe(0x5740);
    expect(device.portCount).toBe(1);
    expect(device.driverType).not.toBe('UNSUPPORTED');
    // Web Serial exposes no product/manufacturer text. Filling these in
    // would put a guess in front of the operator as device identity.
    expect(device.productName).toBeUndefined();
    expect(device.manufacturerName).toBeUndefined();
  });

  it('keeps a device id stable across scans so it stays openable', async () => {
    const port = new FakePort({usbVendorId: 1, usbProductId: 2});
    installSerial([port]);

    const first = await transport.listDevices();
    const second = await transport.listDevices();

    expect(second[0].deviceId).toBe(first[0].deviceId);
  });

  it('reports a non-USB port as zero ids rather than guessing', async () => {
    installSerial([new FakePort({})]);

    const [device] = await transport.listDevices();

    expect(device.vendorId).toBe(0);
    expect(device.productId).toBe(0);
  });
});

describe('unsupported browsers', () => {
  it('rejects with WEB_SERIAL_UNSUPPORTED, never an empty device list', async () => {
    // An empty list would read as "no flight controller is plugged in"
    // and send the operator to check their cable. The distinction is the
    // whole point of the code.
    removeSerial(true);

    await expect(transport.listDevices()).rejects.toMatchObject({
      code: 'WEB_SERIAL_UNSUPPORTED',
    });
  });

  it('blames the insecure context when the page is not on HTTPS', async () => {
    removeSerial(false);

    await expect(transport.listDevices()).rejects.toMatchObject({
      code: 'INSECURE_CONTEXT',
    });
  });

  it('still allows firmware file selection without any serial support', async () => {
    // Opening a local HEX/BIN/UF2 needs no transport. Disabling it
    // because Web Serial is missing would remove working functionality
    // for no safety benefit.
    removeSerial(true);
    const click = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(function (this: HTMLInputElement) {
        this.dispatchEvent(new Event('cancel'));
      });

    await expect(transport.pickFirmwareFile()).resolves.toBeNull();
    expect(click).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The explicit picker
 * ------------------------------------------------------------------ */

describe('requestSerialDevice', () => {
  it('calls requestPort() and returns the chosen device', async () => {
    const serial = installSerial([new FakePort({usbVendorId: 0x0483, usbProductId: 0x5740})]);

    const device = await transport.requestSerialDevice();

    expect(serial.requestPort).toHaveBeenCalledTimes(1);
    expect(device?.vendorId).toBe(0x0483);
  });

  it('returns null - not an error - when the operator dismisses the chooser', async () => {
    const serial = installSerial([new FakePort({})]);
    serial.requestPort.mockRejectedValueOnce(
      new DOMException('No port selected', 'NotFoundError'),
    );

    await expect(transport.requestSerialDevice()).resolves.toBeNull();
  });

  it('surfaces a genuine permission denial as PERMISSION_DENIED', async () => {
    const serial = installSerial([new FakePort({})]);
    serial.requestPort.mockRejectedValueOnce(
      new DOMException('blocked by policy', 'SecurityError'),
    );

    await expect(transport.requestSerialDevice()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('makes the chosen device immediately openable', async () => {
    const port = new FakePort({usbVendorId: 1, usbProductId: 2});
    installSerial([port]);

    const device = await transport.requestSerialDevice();
    const sessionId = await transport.openDevice(device!.deviceId, 0, CONFIG);

    expect(sessionId).toEqual(expect.any(String));
    expect(port.opened).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Opening
 * ------------------------------------------------------------------ */

describe('openDevice', () => {
  it('opens with the requested serial parameters', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();

    await transport.openDevice(device.deviceId, 0, {
      baudRate: 57600,
      dataBits: 8,
      stopBits: '2',
      parity: 'even',
      flowControl: 'rtsCts',
    });

    expect(port.openCalls[0]).toMatchObject({
      baudRate: 57600,
      dataBits: 8,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
    });
  });

  it('refuses a second session on the same port', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    await transport.openDevice(device.deviceId, 0, CONFIG);

    await expect(transport.openDevice(device.deviceId, 0, CONFIG)).rejects.toMatchObject({
      code: 'DEVICE_ALREADY_IN_USE',
    });
  });

  it('rejects a stale/unknown device id as DEVICE_CHANGED, never as an unsupported board', async () => {
    // D6: "هذا الجهاز غير مدعوم حاليًا" for a registry miss reads as a
    // verdict about the BOARD. The truthful code already has copy that
    // tells the operator to re-scan and retry.
    installSerial([new FakePort({})]);

    await expect(transport.openDevice(999, 0, CONFIG)).rejects.toMatchObject({
      code: 'DEVICE_CHANGED_DURING_OPEN',
    });
  });

  it('rejects a non-zero port index', async () => {
    installSerial([new FakePort({})]);
    const [device] = await transport.listDevices();

    await expect(transport.openDevice(device.deviceId, 1, CONFIG)).rejects.toMatchObject({
      code: 'INVALID_PORT_INDEX',
    });
  });

  it.each([
    ['1.5 stop bits', {...CONFIG, stopBits: '1.5' as const}],
    ['mark parity', {...CONFIG, parity: 'mark' as const}],
    ['xon/xoff flow control', {...CONFIG, flowControl: 'xonXoff' as const}],
  ])('refuses %s rather than silently downgrading it', async (_label, configuration) => {
    // A silent downgrade would open the port at a framing the caller did
    // not ask for, and the corruption would look like a wiring fault.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();

    await expect(
      transport.openDevice(device.deviceId, 0, configuration),
    ).rejects.toMatchObject({code: 'UNSUPPORTED_SERIAL_CONFIGURATION'});
    expect(port.opened).toBe(false);
  });

  it('maps a browser InvalidStateError to DEVICE_ALREADY_IN_USE', async () => {
    const port = new FakePort({});
    port.openError = new DOMException('already open', 'InvalidStateError');
    installSerial([port]);
    const [device] = await transport.listDevices();

    await expect(transport.openDevice(device.deviceId, 0, CONFIG)).rejects.toMatchObject({
      code: 'DEVICE_ALREADY_IN_USE',
    });
  });

  it('maps a vanished device to DEVICE_CHANGED_DURING_OPEN', async () => {
    const port = new FakePort({});
    port.openError = new DOMException('gone', 'NotFoundError');
    installSerial([port]);
    const [device] = await transport.listDevices();

    await expect(transport.openDevice(device.deviceId, 0, CONFIG)).rejects.toMatchObject({
      code: 'DEVICE_CHANGED_DURING_OPEN',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

describe('reading', () => {
  it('delivers received bytes unchanged, one event per device chunk', async () => {
    // No reassembly and no splitting here. The shared MSP parser above
    // already handles partial and coalesced frames; a second, divergent
    // framing implementation in the transport is exactly the bug this
    // architecture exists to avoid.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const received: string[] = [];
    transport.onDataReceived(event => received.push(event.dataBase64));

    await transport.startReading(sessionId);
    port.deliver(Uint8Array.from([0x24, 0x4d, 0x3e]));
    port.deliver(Uint8Array.from([0x00, 0x64]));
    await settle();

    expect(received).toEqual(['JE0+', 'AGQ=']);
  });

  it('tags every chunk with the owning session', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const events: string[] = [];
    transport.onDataReceived(event => events.push(event.sessionId));

    await transport.startReading(sessionId);
    port.deliver(Uint8Array.from([1]));
    await settle();

    expect(events).toEqual([sessionId]);
  });

  it('refuses a second receive loop on one session', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    await transport.startReading(sessionId);

    await expect(transport.startReading(sessionId)).rejects.toMatchObject({
      code: 'RX_ALREADY_ACTIVE',
    });
  });

  it('stopReading is idempotent and leaves the session open', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    await transport.startReading(sessionId);

    await transport.stopReading(sessionId);
    await transport.stopReading(sessionId);

    expect(port.opened).toBe(true);
    // Restartable afterwards - stopReading must not have ended the session.
    await expect(transport.startReading(sessionId)).resolves.toBeUndefined();
  });

  it('stops delivering after stopReading', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const received: string[] = [];
    transport.onDataReceived(event => received.push(event.dataBase64));
    await transport.startReading(sessionId);
    await transport.stopReading(sessionId);

    port.deliver(Uint8Array.from([9]));
    await settle();

    expect(received).toEqual([]);
  });

  it('a throwing listener does not kill the receive loop', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    transport.onDataReceived(() => {
      throw new Error('a defective consumer');
    });
    const received: string[] = [];
    transport.onDataReceived(event => received.push(event.dataBase64));

    await transport.startReading(sessionId);
    port.deliver(Uint8Array.from([1]));
    await settle();
    port.deliver(Uint8Array.from([2]));
    await settle();

    expect(received).toEqual(['AQ==', 'Ag==']);
  });

  it('unsubscribing stops delivery to that listener only', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const dropped: string[] = [];
    const kept: string[] = [];
    const subscription = transport.onDataReceived(e => dropped.push(e.dataBase64));
    transport.onDataReceived(e => kept.push(e.dataBase64));
    await transport.startReading(sessionId);

    subscription.remove();
    port.deliver(Uint8Array.from([7]));
    await settle();

    expect(dropped).toEqual([]);
    expect(kept).toEqual(['Bw==']);
  });
});

describe('writing', () => {
  it('writes the exact decoded bytes', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await transport.writeBytes(sessionId, 'JE080A==');

    expect(Array.from(port.written[0])).toEqual([0x24, 0x4d, 0x3c, 0xd0]);
  });

  it('splits the 64-byte serial-configuration frame at the browser-driver-safe 63-byte boundary without changing a byte', async () => {
    const port = new FakePort({usbVendorId: 11836, usbProductId: 22336});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    // Six ordinary 9-byte serial records plus the MSP v2 header/CRC produce
    // a 64-byte wire frame. This is the exact first size across the
    // compatibility boundary in the field path, not a synthetic payload.
    const frame = Uint8Array.from({length: 64}, (_value, index) => index);

    await transport.writeBytes(sessionId, bytesToBase64(frame));

    expect(port.written.map(chunk => chunk.length)).toEqual([63, 1]);
    const reconstructed = Uint8Array.from(
      port.written.flatMap(chunk => Array.from(chunk)),
    );
    expect(reconstructed).toEqual(frame);
  });

  it('rejects a write to an unknown session', async () => {
    installSerial([new FakePort({})]);

    await expect(transport.writeBytes('web-serial-404', 'AA==')).rejects.toMatchObject({
      code: 'UNKNOWN_SESSION',
    });
  });

  it('rejects a write after the session is closed', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    await transport.closeSession(sessionId);

    await expect(transport.writeBytes(sessionId, 'AA==')).rejects.toMatchObject({
      code: 'UNKNOWN_SESSION',
    });
  });

  it('forwards DTR/RTS to the port', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await transport.setControlLines(sessionId, true, false);

    expect(port.signals).toEqual([{dataTerminalReady: true, requestToSend: false}]);
  });
});

/* ------------------------------------------------------------------ *
 * Baud rate
 * ------------------------------------------------------------------ */

describe('setBaudRate', () => {
  it('reopens the port at the new rate and KEEPS the session id', async () => {
    // Web Serial fixes the baud rate at open(). Every caller - the ESP
    // flasher and the STM32 ROM bootloader both change baud mid-session -
    // holds the session id across the change.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await transport.setBaudRate(sessionId, 460800);

    expect(port.closeCalls).toBe(1);
    expect(port.openCalls).toHaveLength(2);
    expect(port.openCalls[1]).toMatchObject({baudRate: 460800});
    await expect(transport.writeBytes(sessionId, 'AA==')).resolves.toBeUndefined();
  });

  it('restores the receive loop across the reopen', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const received: string[] = [];
    transport.onDataReceived(event => received.push(event.dataBase64));
    await transport.startReading(sessionId);

    await transport.setBaudRate(sessionId, 921600);
    port.deliver(Uint8Array.from([0x55]));
    await settle();

    expect(received).toEqual(['VQ==']);
  });

  it('leaves the session untouched when the new rate is invalid', async () => {
    // Validation happens before teardown on purpose: a rejected rate must
    // not leave the operator with a closed port and a live session id.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await expect(transport.setBaudRate(sessionId, 0)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    expect(port.closeCalls).toBe(0);
    expect(port.opened).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Teardown and disconnect
 * ------------------------------------------------------------------ */

describe('closeSession', () => {
  it('releases the reader and writer so close() actually succeeds', async () => {
    // FakePort.close() throws while a stream is locked, exactly as the
    // real API does. Without this release the next connection attempt
    // fails with a port that was never really closed.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    await transport.startReading(sessionId);
    await transport.writeBytes(sessionId, 'AA==');

    await expect(transport.closeSession(sessionId)).resolves.toBeUndefined();
    expect(port.opened).toBe(false);
  });

  it('is idempotent for an already-closed or unknown session', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await transport.closeSession(sessionId);
    await expect(transport.closeSession(sessionId)).resolves.toBeUndefined();
    await expect(transport.closeSession('web-serial-404')).resolves.toBeUndefined();
  });

  it('surfaces a genuine close failure as CLOSE_FAILED', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    port.closeError = new Error('device stopped responding');

    await expect(transport.closeSession(sessionId)).rejects.toMatchObject({
      code: 'CLOSE_FAILED',
    });
  });
});

describe('hot-plug', () => {
  it('emits a session-detached event when the OWNING device is unplugged', async () => {
    const port = new FakePort({usbVendorId: 1, usbProductId: 2});
    const serial = installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const detached: string[] = [];
    transport.onSessionDetached(event => detached.push(event.sessionId));

    serial.dispatch('disconnect', port);
    await settle();

    expect(detached).toEqual([sessionId]);
  });

  it('emits only a device event when the unplugged port owns no session', async () => {
    // onSessionDetached is the stronger signal - the coordinator
    // surrenders MSP ownership on it. Firing it for an unrelated device
    // would tear down a healthy connection.
    const owned = new FakePort({usbVendorId: 1, usbProductId: 2});
    const other = new FakePort({usbVendorId: 3, usbProductId: 4});
    const serial = installSerial([owned, other]);
    const devices = await transport.listDevices();
    await transport.openDevice(devices[0].deviceId, 0, CONFIG);
    const detachedSessions: string[] = [];
    const detachedDevices: number[] = [];
    transport.onSessionDetached(event => detachedSessions.push(event.sessionId));
    transport.onDeviceDetached(event => detachedDevices.push(event.deviceId));

    serial.dispatch('disconnect', other);
    await settle();

    expect(detachedSessions).toEqual([]);
    expect(detachedDevices).toEqual([devices[1].deviceId]);
  });

  it('emits an attach event for a reconnected authorized device', async () => {
    const port = new FakePort({usbVendorId: 0x0483, usbProductId: 0x5740});
    const serial = installSerial([port]);
    await transport.listDevices();
    const attached: UsbDeviceIdentity[] = [];
    transport.onDeviceAttached(event => attached.push(event));

    serial.dispatch('connect', port);

    expect(attached).toEqual([
      {deviceId: expect.any(Number), vendorId: 0x0483, productId: 0x5740},
    ]);
  });

  it('lets a new session open on the same port after a detach', async () => {
    // The recovery path an operator actually takes: unplug, plug back in,
    // reconnect. A session left registered against the dead port would
    // make this fail with DEVICE_ALREADY_IN_USE.
    const port = new FakePort({});
    const serial = installSerial([port]);
    const [device] = await transport.listDevices();
    await transport.openDevice(device.deviceId, 0, CONFIG);

    serial.dispatch('disconnect', port);
    await settle();
    port.opened = false;

    await expect(
      transport.openDevice(device.deviceId, 0, CONFIG),
    ).resolves.toEqual(expect.any(String));
  });
});

type UsbDeviceIdentity = {deviceId: number; vendorId: number; productId: number};

/* ------------------------------------------------------------------ *
 * DFU is not available in this build
 * ------------------------------------------------------------------ */

describe('DFU surface', () => {
  it('reports an empty DFU list on a browser with no WebUSB', async () => {
    // Deliberately EMPTY rather than a rejection, and the asymmetry with
    // listDevices() is the point: the flasher refreshes this alongside the
    // serial scan, so rejecting would turn "no WebUSB in this browser"
    // into a hard error on a screen whose serial paths work fine. The
    // absence is reported by the compatibility notice and by the DFU
    // actions themselves.
    installSerial([new FakePort({})]);
    Reflect.deleteProperty(navigator as object, 'usb');

    await expect(transport.listDfuDevices()).resolves.toEqual([]);
  });

  it('rejects a flash attempt for a device that was never authorized', async () => {
    // Never a fabricated success: an unknown id must fail, not silently
    // select some other attached device.
    installSerial([new FakePort({})]);

    await expect(
      transport.flashDfuFirmware(999_999, 'AA==', false),
    ).rejects.toMatchObject({code: 'DFU_DEVICE_NOT_FOUND'});
  });
});

/* ------------------------------------------------------------------ *
 * Audit fixes D1 / D2 / D7 (docs/WEB_REAL_USER_AUDIT.md)
 * ------------------------------------------------------------------ */

describe('D1: connect timeout parity with Android', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects CONNECT_TIMEOUT when port.open() never settles, instead of freezing forever', async () => {
    const port = new FakePort({});
    port.openHangs = true;
    installSerial([port]);
    const [device] = await transport.listDevices();

    const attempt = transport.openDevice(device.deviceId, 0, CONFIG);
    // Handler attached before the clock is driven, awaited after - see
    // the same pattern in MspIdentificationService.test.ts for why.
    // eslint-disable-next-line jest/valid-expect -- awaited two lines below
    const expectation = expect(attempt).rejects.toMatchObject({code: 'CONNECT_TIMEOUT'});
    await jest.advanceTimersByTimeAsync(15_000);
    await expectation;
  });

  it('does not fire the timeout on a normal, prompt open', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();

    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    await jest.advanceTimersByTimeAsync(20_000);

    // The session is alive and usable long past the timeout window.
    await expect(transport.writeBytes(sessionId, 'AA==')).resolves.toBeUndefined();
  });
});

describe('D2: a dead receive stream surfaces as a session loss, not silence', () => {
  it('emits onSessionDetached and forgets the session when the read stream errors mid-session', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const detached: string[] = [];
    const errors: string[] = [];
    transport.onSessionDetached(event => detached.push(event.sessionId));
    transport.onError(event => errors.push(event.code));
    await transport.startReading(sessionId);

    port.failNextRead = new DOMException('device lost', 'NetworkError');
    port.deliver(Uint8Array.from([1])); // wakes the pending read, which then rejects
    await settle();

    // Both signals: the error (for the debug panel) AND the detach (for
    // the coordinator surrender + screen banner every user actually has).
    expect(errors).toEqual(['READ_FAILED']);
    expect(detached).toEqual([sessionId]);
    await expect(transport.writeBytes(sessionId, 'AA==')).rejects.toMatchObject({
      code: 'UNKNOWN_SESSION',
    });
  });

  it('stays SILENT on the detach hub during an ordinary stopReading/close teardown', async () => {
    // The detach signal is meaningful precisely because teardown does not
    // fire it: a deliberate close must never masquerade as a device loss.
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const detached: string[] = [];
    transport.onSessionDetached(event => detached.push(event.sessionId));
    await transport.startReading(sessionId);

    await transport.stopReading(sessionId);
    await transport.closeSession(sessionId);
    await settle();

    expect(detached).toEqual([]);
  });
});

describe('D7: a failed receive-loop START also converges on session loss', () => {
  it('emits onSessionDetached and frees the port when startReading cannot lock the stream', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const detached: string[] = [];
    transport.onSessionDetached(event => detached.push(event.sessionId));

    port.readerUnavailable = true;
    await expect(transport.startReading(sessionId)).rejects.toMatchObject({
      code: 'READ_FAILED',
    });
    await settle();

    expect(detached).toEqual([sessionId]);
    // The port is genuinely free again - the user's retry can open it.
    port.readerUnavailable = false;
    port.opened = false;
    await expect(transport.openDevice(device.deviceId, 0, CONFIG)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('does NOT kill the session for RX_ALREADY_ACTIVE - a second start on a healthy loop', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);
    const detached: string[] = [];
    transport.onSessionDetached(event => detached.push(event.sessionId));
    await transport.startReading(sessionId);

    await expect(transport.startReading(sessionId)).rejects.toMatchObject({
      code: 'RX_ALREADY_ACTIVE',
    });
    await settle();

    expect(detached).toEqual([]);
    await expect(transport.writeBytes(sessionId, 'AA==')).resolves.toBeUndefined();
  });
});
/* ------------------------------------------------------------------ *
 * The write bound: Android has always had one, the browser had none
 * ------------------------------------------------------------------ */

describe('a serial write cannot hang forever', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects WRITE_FAILED when the browser driver never accepts the bytes', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    port.writeHangs = true;
    const attempt = transport.writeBytes(sessionId, 'AA==');
    // eslint-disable-next-line jest/valid-expect -- awaited two lines below
    const expectation = expect(attempt).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    await jest.advanceTimersByTimeAsync(2_000);
    await expectation;
  });

  /**
   * A stalled chunk may still land later. Reusing the same writer would
   * let it drain into the middle of the NEXT frame and hand the flight
   * controller a spliced command, so the writer is dropped on timeout.
   */
  it('drops the writer it gave up on, so a late chunk cannot splice the next frame', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    port.writeHangs = true;
    const releasesBefore = port.writerReleases;
    // eslint-disable-next-line jest/valid-expect -- awaited two lines below
    const expectation = expect(transport.writeBytes(sessionId, 'AA==')).rejects.toBeDefined();
    await jest.advanceTimersByTimeAsync(2_000);
    await expectation;
    expect(port.writerReleases).toBeGreaterThan(releasesBefore);

    // And the link is usable again once the driver recovers: a fresh
    // writer is taken, and the bytes that arrive are only the new ones.
    port.writeHangs = false;
    port.written.length = 0;
    await expect(transport.writeBytes(sessionId, 'JE080A==')).resolves.toBeUndefined();
    expect(port.written).toHaveLength(1);
  });

  it('does not fire the bound on an ordinary prompt write', async () => {
    const port = new FakePort({});
    installSerial([port]);
    const [device] = await transport.listDevices();
    const sessionId = await transport.openDevice(device.deviceId, 0, CONFIG);

    await expect(transport.writeBytes(sessionId, 'AA==')).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(port.written).toHaveLength(1);
  });
});
