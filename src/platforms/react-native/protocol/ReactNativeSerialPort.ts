import type {SerialConfiguration, UsbSerialTransportClient} from '../transport';
import {base64ToBytes, bytesToBase64} from './base64';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const RAW_WRITE_CHUNK = 512;

type ReadWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class RawSerialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawSerialError';
  }
}

/** Exclusive native serial owner with the SLIP surface esptool-js expects. */
export class ReactNativeSerialPort {
  baudrate = 0;
  _DTR_state = false;
  slipReaderEnabled = true;
  tracing = false;

  private sessionId: string | null = null;
  private rawBuffer = new Uint8Array(0);
  private waiter: ReadWaiter | null = null;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeDetached: (() => void) | null = null;
  private rtsState = false;
  private closed = true;
  private terminalError: Error | null = null;
  private deviceLostCallback: (() => void) | null = null;

  constructor(
    private readonly client: UsbSerialTransportClient,
    private readonly deviceId: number,
    private readonly portIndex: number,
    private readonly signal?: AbortSignal,
  ) {}

  setDeviceLostCallback(callback: (() => void) | null): void {
    this.deviceLostCallback = callback;
  }

  getInfo(): string {
    return `Android USB device ${this.deviceId}, port ${this.portIndex}`;
  }

  getPid(): number | undefined {
    return undefined;
  }

  trace(_message: string): void {}

  async returnTrace(): Promise<void> {}

  hexify(data: Uint8Array): string {
    return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  hexConvert(data: Uint8Array): string {
    return this.hexify(data);
  }

  async readLoop(): Promise<void> {
    // Native startReading() already owns the one continuous RX loop.
  }

  async connect(baud = 115200, serialOptions: Partial<SerialOptions> = {}): Promise<void> {
    this.throwIfUnavailable();
    if (this.sessionId !== null) {
      await this.client.setBaudRate(this.sessionId, baud);
      this.baudrate = baud;
      return;
    }
    const configuration: SerialConfiguration = {
      baudRate: baud,
      dataBits: serialOptions.dataBits === 7 ? 7 : 8,
      stopBits: serialOptions.stopBits === 2 ? '2' : '1',
      parity: serialOptions.parity === 'even' ? 'even' : serialOptions.parity === 'odd' ? 'odd' : 'none',
      flowControl: serialOptions.flowControl === 'hardware' ? 'rtsCts' : 'off',
    };
    const sessionId = await this.client.openDevice(this.deviceId, this.portIndex, configuration);
    this.sessionId = sessionId;
    this.closed = false;
    this.baudrate = baud;
    this.terminalError = null;
    this.rawBuffer = new Uint8Array(0);
    this.unsubscribeData = this.client.onDataReceived(event => {
      if (event.sessionId === sessionId) {
        this.append(base64ToBytes(event.dataBase64));
      }
    });
    this.unsubscribeDetached = this.client.onSessionDetached(event => {
      if (event.sessionId === sessionId) {
        this.fail(new RawSerialError('تم فصل جهاز USB أثناء عملية Firmware.'));
        this.deviceLostCallback?.();
      }
    });
    try {
      await this.client.startReading(sessionId);
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.closed = true;
    this.unsubscribeData?.();
    this.unsubscribeDetached?.();
    this.unsubscribeData = null;
    this.unsubscribeDetached = null;
    this.rejectWaiter(new RawSerialError('تم إغلاق جلسة Firmware.'));
    if (sessionId !== null) {
      await this.client.stopReading(sessionId).catch(() => undefined);
      await this.client.closeSession(sessionId);
    }
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writeRaw(this.slipWriter(data));
  }

  async writeRaw(data: Uint8Array): Promise<void> {
    this.throwIfUnavailable();
    const sessionId = this.requireSession();
    for (let offset = 0; offset < data.length; offset += RAW_WRITE_CHUNK) {
      this.throwIfUnavailable();
      await this.client.writeBytes(sessionId, bytesToBase64(data.subarray(offset, offset + RAW_WRITE_CHUNK)));
    }
  }

  async read(timeout: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeout;
    while (true) {
      this.throwIfUnavailable();
      const packet = this.takeSlipPacket();
      if (packet !== null) {
        return packet;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RawSerialError('انتهت مهلة انتظار حزمة ESP bootloader.');
      }
      await this.waitForData(remaining);
    }
  }

  async readExactly(length: number, timeout: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeout;
    while (this.rawBuffer.length < length) {
      this.throwIfUnavailable();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RawSerialError(`انتهت مهلة استقبال ${length} بايت من bootloader.`);
      }
      await this.waitForData(remaining);
    }
    const result = this.rawBuffer.slice(0, length);
    this.rawBuffer = this.rawBuffer.slice(length);
    return result;
  }

  async setRTS(state: boolean): Promise<void> {
    this.throwIfUnavailable();
    this.rtsState = state;
    await this.client.setControlLines(this.requireSession(), this._DTR_state, this.rtsState);
  }

  async setDTR(state: boolean): Promise<void> {
    this.throwIfUnavailable();
    this._DTR_state = state;
    await this.client.setControlLines(this.requireSession(), this._DTR_state, this.rtsState);
  }

  flushInput(): void {
    this.rawBuffer = new Uint8Array(0);
  }

  async flushOutput(): Promise<void> {
    // Native write promises settle only after the physical write completes.
  }

  inWaiting(): number {
    return this.rawBuffer.length;
  }

  peek(): Uint8Array {
    return this.rawBuffer.slice();
  }

  async waitForUnlock(_timeout: number): Promise<void> {
    // The native session has one serialized RX/TX lock and no exposed stream locks.
  }

  async rawRead(onData: (data: Uint8Array) => void, isClosed: () => boolean): Promise<void> {
    while (!isClosed() && !this.closed) {
      await this.waitForData(250).catch(() => undefined);
      if (this.rawBuffer.length > 0) {
        const data = this.rawBuffer;
        this.rawBuffer = new Uint8Array(0);
        onData(data);
      }
    }
  }

  private slipWriter(data: Uint8Array): Uint8Array {
    const encoded: number[] = [0xc0];
    for (const byte of data) {
      if (byte === 0xc0) encoded.push(0xdb, 0xdc);
      else if (byte === 0xdb) encoded.push(0xdb, 0xdd);
      else encoded.push(byte);
    }
    encoded.push(0xc0);
    return Uint8Array.from(encoded);
  }

  private takeSlipPacket(): Uint8Array | null {
    let start = this.rawBuffer.indexOf(0xc0);
    if (start < 0) {
      if (this.rawBuffer.length > 0) this.rawBuffer = new Uint8Array(0);
      return null;
    }
    if (start > 0) this.rawBuffer = this.rawBuffer.slice(start);
    while (this.rawBuffer.length > 1 && this.rawBuffer[1] === 0xc0) {
      this.rawBuffer = this.rawBuffer.slice(1);
    }
    const end = this.rawBuffer.indexOf(0xc0, 1);
    if (end < 0) return null;
    const framed = this.rawBuffer.slice(1, end);
    this.rawBuffer = this.rawBuffer.slice(end + 1);
    const decoded: number[] = [];
    for (let index = 0; index < framed.length; index += 1) {
      if (framed[index] !== 0xdb) {
        decoded.push(framed[index]);
        continue;
      }
      index += 1;
      if (index >= framed.length) throw new RawSerialError('حزمة SLIP تنتهي بمحرف escape ناقص.');
      if (framed[index] === 0xdc) decoded.push(0xc0);
      else if (framed[index] === 0xdd) decoded.push(0xdb);
      else throw new RawSerialError('حزمة SLIP تحتوي escape غير صالح.');
    }
    return Uint8Array.from(decoded);
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.closed) return;
    if (this.rawBuffer.length + bytes.length > MAX_BUFFERED_BYTES) {
      this.fail(new RawSerialError('تجاوز مخزن الاستقبال الحد الآمن أثناء التفليش.'));
      return;
    }
    const combined = new Uint8Array(this.rawBuffer.length + bytes.length);
    combined.set(this.rawBuffer);
    combined.set(bytes, this.rawBuffer.length);
    this.rawBuffer = combined;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private waitForData(timeout: number): Promise<void> {
    if (this.waiter !== null) {
      return Promise.reject(new RawSerialError('لا يُسمح بقراءتين متوازيتين من جلسة Firmware.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.waiter = null;
        reject(new RawSerialError('انتهت مهلة استقبال بيانات bootloader.'));
      }, timeout);
      this.waiter = {resolve, reject, timer};
    });
  }

  private fail(error: Error): void {
    this.terminalError = error;
    this.closed = true;
    this.rejectWaiter(error);
  }

  private rejectWaiter(error: Error): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private requireSession(): string {
    if (this.sessionId === null) throw new RawSerialError('جلسة Firmware غير مفتوحة.');
    return this.sessionId;
  }

  private throwIfUnavailable(): void {
    if (this.signal?.aborted) throw new RawSerialError('أُلغيَت عملية Firmware.');
    if (this.terminalError !== null) throw this.terminalError;
  }
}
