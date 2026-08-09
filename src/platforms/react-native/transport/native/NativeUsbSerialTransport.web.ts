/**
 * THE WEB SERIAL TRANSPORT - the browser's last leaf of the transport
 * stack, and the ONLY file that differs from Android below the client.
 *
 * WHERE THIS SITS. UsbSerialTransportClient.ts imports
 * './native/NativeUsbSerialTransport' with no extension. Metro resolves
 * that to the TurboModule spec and Android's Kotlin implementation; Vite
 * resolves it to this file (see vite.config.mts's resolve.extensions).
 * Everything above the client - RNMspTransport, MspSessionCoordinator,
 * the MSP encoder, the frame parser, telemetry, every save transaction,
 * every safety gate - is byte-for-byte the same code on both platforms
 * and contains no platform conditional at all. That is the entire point
 * of implementing this seam rather than a browser edition of the app.
 *
 * THE THREE RULES THIS FILE MUST NOT BREAK, from
 * docs/WEB_APP_ARCHITECTURE.md:
 *
 *   1. NO FABRICATED DEVICE, EVER. If Web Serial is absent, every method
 *      that needs it rejects with a real, localized code. It never
 *      invents a port, a session, or a byte of telemetry. Note which
 *      methods deliberately keep working without it: pickFirmwareFile and
 *      saveFirmwareFile need no transport, and disabling them would
 *      remove working functionality for no safety benefit.
 *
 *   2. NO UNPROMPTED PERMISSION DIALOG. listDevices() calls
 *      navigator.serial.getPorts(), which returns ONLY ports the user has
 *      already authorized and never opens a chooser. The chooser lives
 *      behind requestSerialDevice() below, which the UI calls from an
 *      explicit tap - the browser requires a user gesture and would
 *      reject it anyway, but the rule holds regardless of enforcement:
 *      the periodic connection scan must never make a dialog appear.
 *
 *   3. NO INVENTED IDENTITY. Web Serial exposes only usbVendorId and
 *      usbProductId. There is no product or manufacturer string, so those
 *      fields are left undefined rather than filled with a plausible
 *      guess. UsbConnectionScreen already renders a device with no name.
 *
 * WHAT GENUINELY DIFFERS FROM ANDROID, recorded because it is behaviour,
 * not detail:
 *
 *   - setBaudRate() is a CLOSE AND REOPEN. Web Serial has no live baud
 *     change; the rate is fixed by port.open(). The ESP and STM32 ROM
 *     bootloader paths change baud mid-session, so this reopens the port
 *     at the new rate and restores the receive loop if one was running.
 *     The session id survives, which is what every caller depends on.
 *     A physical device does see a port close and reopen, which some
 *     boards treat as a reset - REQUIRES HARDWARE TEST.
 *
 *   - deviceId is a page-lifetime integer this module assigns, not an
 *     OS handle. Web Serial identifies a port by object identity, and the
 *     shared client's API is numeric, so the two are bridged by the
 *     registry below.
 *
 *   - portCount is always 1. Web Serial exposes one stream per port
 *     object; a multi-port adapter appears as several SerialPorts.
 */

import type {
  DfuDeviceDescriptor,
  DfuFlashProgressEvent,
  FirmwareFileSelection,
  SerialConfiguration,
  UsbDeviceHotplugEvent,
  UsbSerialDataEvent,
  UsbSerialDeviceDescriptor,
  UsbSerialErrorEvent,
  UsbSerialSessionDetachedEvent,
} from './usbSerialTransportTypes';
import {bytesToBase64, base64ToBytes} from '../../protocol/base64';
// Bounded, non-secret staging evidence for the Arabic "copy connection
// report" action. Byte COUNTS only - never payload bytes. See the module
// header of connectionDiagnostics.ts for the record/refuse contract.
import {
  recordBytesReceived,
  recordBytesWritten,
  recordDiagnostic,
} from '../../../web/connectionDiagnostics';
import {
  cancelDfuFlash as cancelWebUsbDfuFlash,
  exitDfuMode as exitWebUsbDfuMode,
  flashDfuFirmware as flashWebUsbDfuFirmware,
  listDfuDevices as listWebUsbDfuDevices,
  requestDfuDevice as requestWebUsbDfuDevice,
  unprotectDfuDevice as unprotectWebUsbDfuDevice,
} from './webUsbDfu.web';

/**
 * THIS FILE IS A COMPLETE DROP-IN, TYPES INCLUDED.
 *
 * Under tsconfig.web.json's `moduleSuffixes` and Vite's resolve.extensions,
 * EVERY importer of './NativeUsbSerialTransport' - native/index.ts and
 * UsbSerialTransportClient.ts among them - gets this module instead of the
 * spec. Those importers re-export the transport's types, so the types have
 * to come out of here as well; a browser build would otherwise fail on
 * "has no exported member 'SerialConfiguration'". See
 * usbSerialTransportTypes.ts for why the shapes live in their own module
 * and what stops them drifting from the spec's copies.
 */
export type {
  DfuDeviceDescriptor,
  DfuFlashProgressEvent,
  FirmwareFileSelection,
  SerialConfiguration,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
  UsbDeviceHotplugEvent,
  UsbSerialDataEvent,
  UsbSerialDeviceDescriptor,
  UsbSerialErrorEvent,
  UsbSerialSessionDetachedEvent,
} from './usbSerialTransportTypes';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Rejections are shaped exactly like the TurboModule bridge's own: an
 * Error carrying a `code`. normalizeNativeError() in transportErrors.ts
 * reads `code` and `message` and nothing else, so the browser and Android
 * are indistinguishable to every layer above - including
 * localizeTransportError(), which turns the code into Arabic.
 */
class WebTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebTransportError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WebTransportError(code, message);
}

/* ------------------------------------------------------------------ *
 * Capability gate
 * ------------------------------------------------------------------ */

const WEB_SERIAL_DRIVER_TYPE = 'WEB_SERIAL';

/**
 * D1 (docs/WEB_REAL_USER_AUDIT.md): the browser had NO connect timeout.
 * Android bounds its whole open sequence with CONNECT_TIMEOUT_MILLIS =
 * 15000 (UsbSerialTransportModule.kt), and the Arabic copy for
 * errors.CONNECT_TIMEOUT has existed since Pass 5 - but the web path
 * awaited port.open() unbounded, so a driver that never settles froze
 * the connection screen in `connecting` forever, with every control
 * disabled and no cancel. Same constant, same code, same user guidance
 * (unplug/replug) as Android.
 */
const CONNECT_TIMEOUT_MILLIS = 15_000;

/**
 * Maximum size of one Web Serial writer call.
 *
 * This is deliberately a transport chunk size, not an MSP frame limit.
 * Betaflight Configurator's own WebSerial implementation splits writes at
 * 63 bytes for the AT32/macOS driver path. A normal six-port
 * MSP2_COMMON_SET_SERIAL_CONFIG request is 64 bytes on the wire, so writing
 * the whole frame in one call lands exactly on the first size beyond that
 * compatibility bound: the UI changes and Save is pressed, but an affected
 * driver may never deliver a complete command. Serial is a byte stream and
 * the FC's MSP parser already accepts partial frames, therefore applying the
 * same bound to every browser port is both portable and avoids user-agent/VID
 * policy in the protocol layer. Android keeps its native write path unchanged.
 */
const WEB_SERIAL_WRITE_CHUNK_BYTES = 63;

/**
 * Bounds port.open(). On timeout the eventual LATE settlement is not
 * abandoned: a late success is immediately closed (the port would
 * otherwise stay locked-open and un-openable until tab close), and a
 * late failure is swallowed - the operator already got CONNECT_TIMEOUT.
 */
async function openWithTimeout(port: SerialPort, options: SerialOptions): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new WebTransportError(
          'CONNECT_TIMEOUT',
          `port.open() did not settle within ${CONNECT_TIMEOUT_MILLIS}ms.`,
        ),
      );
    }, CONNECT_TIMEOUT_MILLIS);
  });
  const opening = port.open(options);
  try {
    await Promise.race([opening, timedOut]);
  } catch (reason) {
    if (reason instanceof WebTransportError && reason.code === 'CONNECT_TIMEOUT') {
      opening.then(
        () => {
          port.close().catch(() => undefined);
        },
        () => undefined,
      );
    }
    throw reason;
  } finally {
    clearTimeout(timer);
  }
}

function serialApi(): Serial {
  if (typeof navigator === 'undefined' || !navigator.serial) {
    // Distinguishing these two is not pedantry: they look identical from
    // inside the app and have completely different fixes. Telling an
    // operator on plain HTTP that their browser is unsupported sends them
    // to reinstall software that was never at fault.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      fail(
        'INSECURE_CONTEXT',
        'Web Serial requires a secure context (HTTPS or localhost).',
      );
    }
    fail('WEB_SERIAL_UNSUPPORTED', 'This browser does not implement Web Serial.');
  }
  return navigator.serial;
}

/* ------------------------------------------------------------------ *
 * Event hub
 * ------------------------------------------------------------------ */

type Subscription = {remove(): void};

/**
 * The subscribe/emit shape CodegenTypes.EventEmitter produces on Android,
 * reimplemented here so the client's `subscription.remove()` calls work
 * unchanged. A listener that throws must not stop the remaining listeners
 * or kill the read loop that emitted the event, so each is isolated.
 */
class EventHub<T> {
  private readonly listeners = new Set<(event: T) => void>();

  readonly subscribe = (listener: (event: T) => void): Subscription => {
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  };

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Swallowed deliberately. This is the transport's own emit path;
        // a defective consumer must not be able to terminate the receive
        // loop for every other consumer.
      }
    }
  }
}

const onDataReceivedHub = new EventHub<UsbSerialDataEvent>();
const onSessionDetachedHub = new EventHub<UsbSerialSessionDetachedEvent>();
const onErrorHub = new EventHub<UsbSerialErrorEvent>();
const onDeviceAttachedHub = new EventHub<UsbDeviceHotplugEvent>();
const onDeviceDetachedHub = new EventHub<UsbDeviceHotplugEvent>();
const onDfuFlashProgressHub = new EventHub<DfuFlashProgressEvent>();

/* ------------------------------------------------------------------ *
 * Device registry
 * ------------------------------------------------------------------ */

let nextDeviceId = 1;
const idByPort = new Map<SerialPort, number>();
const portById = new Map<number, SerialPort>();

/**
 * Web Serial returns the SAME SerialPort object for the same underlying
 * port for as long as the page lives, so object identity is a sound key
 * and an id handed out by listDevices() stays valid for openDevice().
 */
function identify(port: SerialPort): number {
  const existing = idByPort.get(port);
  if (existing !== undefined) {
    return existing;
  }
  const deviceId = nextDeviceId;
  nextDeviceId += 1;
  idByPort.set(port, deviceId);
  portById.set(deviceId, port);
  return deviceId;
}

function describe(port: SerialPort): UsbSerialDeviceDescriptor {
  const info = port.getInfo();
  return {
    deviceId: identify(port),
    // A non-USB port (a real UART, a Bluetooth bridge) reports neither
    // id. Zero is reported rather than a guess; the UI shows the numbers
    // it is given and claims nothing about them.
    vendorId: info.usbVendorId ?? 0,
    productId: info.usbProductId ?? 0,
    // productName/manufacturerName deliberately absent: Web Serial does
    // not expose them and inventing one would be a fabricated identity.
    driverType: WEB_SERIAL_DRIVER_TYPE,
    portCount: 1,
  };
}

/* ------------------------------------------------------------------ *
 * Serial configuration mapping
 * ------------------------------------------------------------------ */

function toSerialOptions(configuration: SerialConfiguration): SerialOptions {
  const {baudRate, dataBits, stopBits, parity, flowControl} = configuration;

  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    fail('INVALID_CONFIGURATION', `Invalid baud rate: ${String(baudRate)}.`);
  }

  // Web Serial supports 1 and 2 stop bits only. 1.5 is a real RS-232
  // mode this app's type allows, and the honest answer for a browser is
  // that it cannot be requested - not a silent downgrade to 1, which
  // would open the port at a framing the caller did not ask for.
  if (stopBits === '1.5') {
    fail(
      'UNSUPPORTED_SERIAL_CONFIGURATION',
      'Web Serial cannot request 1.5 stop bits.',
    );
  }
  // Same reasoning for mark/space parity.
  if (parity === 'mark' || parity === 'space') {
    fail(
      'UNSUPPORTED_SERIAL_CONFIGURATION',
      `Web Serial cannot request ${parity} parity.`,
    );
  }
  // Web Serial offers 'none' or 'hardware' (RTS/CTS). Software
  // flow control (XON/XOFF) and DTR/DSR have no representation, and
  // silently opening without flow control would corrupt a transfer that
  // depended on it.
  if (flowControl === 'xonXoff' || flowControl === 'dtrDsr') {
    fail(
      'UNSUPPORTED_SERIAL_CONFIGURATION',
      `Web Serial cannot request ${flowControl} flow control.`,
    );
  }

  return {
    baudRate,
    dataBits,
    stopBits: stopBits === '2' ? 2 : 1,
    parity,
    flowControl: flowControl === 'rtsCts' ? 'hardware' : 'none',
    // MSP telemetry arrives continuously while JavaScript may be busy
    // rendering. A larger receive buffer than the 255-byte default keeps
    // the driver from dropping bytes during a long frame.
    bufferSize: 8 * 1024,
  };
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

let nextSessionOrdinal = 1;

class WebSerialSession {
  readonly sessionId: string;
  readonly deviceId: number;
  readonly port: SerialPort;
  configuration: SerialConfiguration;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  /** True between startReading() and stopReading(), across a reopen. */
  private receiveRequested = false;
  private closed = false;

  constructor(port: SerialPort, deviceId: number, configuration: SerialConfiguration) {
    this.port = port;
    this.deviceId = deviceId;
    this.configuration = configuration;
    this.sessionId = `web-serial-${nextSessionOrdinal}`;
    nextSessionOrdinal += 1;
  }

  get isReceiving(): boolean {
    return this.receiveRequested;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async startReading(): Promise<void> {
    if (this.closed) {
      fail('SESSION_CLOSED', 'The session was closed.');
    }
    if (this.receiveRequested) {
      fail('RX_ALREADY_ACTIVE', 'A receive loop is already active for this session.');
    }
    this.receiveRequested = true;
    this.beginReadLoop();
  }

  /**
   * Starts the single reader. Separated from startReading() because a
   * baud-rate change reopens the port and must restore the loop WITHOUT
   * going through the RX_ALREADY_ACTIVE guard.
   */
  private beginReadLoop(): void {
    const readable = this.port.readable;
    if (!readable) {
      // Reachable when the device vanished between open() and here.
      this.receiveRequested = false;
      fail('READ_FAILED', 'The port has no readable stream.');
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = readable.getReader();
    } catch (reason) {
      // A stream that exists but cannot be locked (already errored, or
      // seized by another consumer) is the same operational fact as no
      // stream at all - and it must surface under the transport's own
      // code, not as a raw TypeError that bypasses the error contract
      // every layer above localizes from. Found by the D7 test, which
      // asserts the code, not just "it threw".
      this.receiveRequested = false;
      fail('READ_FAILED', describeReason(reason));
    }
    this.reader = reader;
    this.readLoop = this.pump(reader);
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) {
          return;
        }
        if (value && value.length > 0) {
          recordBytesReceived(value.length);
          // Emitted EXACTLY as received - no reassembly, no splitting on
          // a frame boundary, no interpretation. The shared MSP parser
          // above already handles partial and coalesced frames, and
          // duplicating that here would be a second, divergent parser.
          onDataReceivedHub.emit({
            sessionId: this.sessionId,
            dataBase64: bytesToBase64(value),
          });
        }
      }
    } catch (reason) {
      if (this.closed) {
        // An expected cancel during teardown, not a fault.
        return;
      }
      recordDiagnostic('RX_FAILED', {sessionId: this.sessionId, code: 'READ_FAILED'});
      onErrorHub.emit({
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        code: 'READ_FAILED',
        message: describeReason(reason),
        recoverable: false,
      });
      // D2 (docs/WEB_REAL_USER_AUDIT.md): onError's ONLY production
      // subscriber is the __DEV__ debug panel, so in a release build a
      // dead receive loop used to be COMPLETELY silent - the session
      // stayed registered, receiveRequested stayed true, and the operator
      // learned about it as an undifferentiated MSP timeout two seconds
      // later. A Web Serial read-stream failure outside our own teardown
      // means the device is gone or the driver gave up; report it the way
      // the platform reports a physical unplug, which every shared layer
      // (coordinator surrender, screen banner, session-loss redirect)
      // already handles. Same shape the hot-plug 'disconnect' path emits.
      this.closed = true;
      this.receiveRequested = false;
      sessionsById.delete(this.sessionId);
      recordDiagnostic('SESSION_DETACHED', {
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        cause: 'READ_FAILED',
      });
      onSessionDetachedHub.emit({sessionId: this.sessionId, deviceId: this.deviceId});
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released by a concurrent teardown.
      }
      if (this.reader === reader) {
        this.reader = null;
      }
    }
  }

  async stopReading(): Promise<void> {
    // Idempotent by contract - safe for a session with no active loop.
    this.receiveRequested = false;
    await this.releaseReader();
  }

  private async releaseReader(): Promise<void> {
    const reader = this.reader;
    if (!reader) {
      return;
    }
    this.reader = null;
    try {
      // cancel() both ends the pending read() and unlocks the stream, so
      // port.close() below is not blocked by a locked reader.
      await reader.cancel();
    } catch {
      // The stream may already be errored; teardown proceeds regardless.
    }
    try {
      await this.readLoop;
    } catch {
      // pump() reports its own failures through onError.
    }
    this.readLoop = null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) {
      fail('SESSION_CLOSED', 'The session was closed.');
    }
    const writable = this.port.writable;
    if (!writable) {
      fail('WRITE_FAILED', 'The port has no writable stream.');
    }
    if (!this.writer) {
      this.writer = writable.getWriter();
    }
    try {
      // Keep individual browser-driver writes bounded. This does NOT split
      // or reinterpret an MSP frame semantically; serial is a byte stream
      // and the shared parser on the FC reassembles the bytes. Await every
      // chunk in order so the request Promise cannot settle before the
      // complete frame has been handed to the browser driver.
      for (
        let offset = 0;
        offset < bytes.length;
        offset += WEB_SERIAL_WRITE_CHUNK_BYTES
      ) {
        await this.writer.write(
          bytes.subarray(offset, offset + WEB_SERIAL_WRITE_CHUNK_BYTES),
        );
      }
      if (bytes.length > WEB_SERIAL_WRITE_CHUNK_BYTES) {
        recordDiagnostic('TX_CHUNKED', {
          sessionId: this.sessionId,
          bytes: bytes.length,
          chunks: Math.ceil(bytes.length / WEB_SERIAL_WRITE_CHUNK_BYTES),
          chunkBytes: WEB_SERIAL_WRITE_CHUNK_BYTES,
        });
      }
      recordBytesWritten(bytes.length);
    } catch (reason) {
      throw new WebTransportError('WRITE_FAILED', describeReason(reason));
    }
  }

  private async releaseWriter(): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      return;
    }
    this.writer = null;
    try {
      writer.releaseLock();
    } catch {
      // Already released.
    }
  }

  async setSignals(dtr: boolean, rts: boolean): Promise<void> {
    if (this.closed) {
      fail('SESSION_CLOSED', 'The session was closed.');
    }
    try {
      await this.port.setSignals({dataTerminalReady: dtr, requestToSend: rts});
    } catch (reason) {
      throw new WebTransportError('NATIVE_OPERATION_FAILED', describeReason(reason));
    }
  }

  /**
   * Web Serial fixes the baud rate at open() time, so a change is a close
   * and reopen. The session id, its subscribers and its receive state all
   * survive; only the physical port is cycled.
   */
  async changeBaudRate(baudRate: number): Promise<void> {
    if (this.closed) {
      fail('SESSION_CLOSED', 'The session was closed.');
    }
    const wasReceiving = this.receiveRequested;
    const next: SerialConfiguration = {...this.configuration, baudRate};
    // Validate BEFORE tearing anything down, so a rejected rate leaves
    // the existing session exactly as it was rather than closed.
    const options = toSerialOptions(next);

    await this.releaseReader();
    await this.releaseWriter();
    try {
      await this.port.close();
    } catch (reason) {
      throw new WebTransportError('CLOSE_FAILED', describeReason(reason));
    }
    try {
      await this.port.open(options);
    } catch (reason) {
      // The port is now closed and cannot be used again. Report the
      // session as gone rather than leaving callers holding an id that
      // silently no longer works.
      this.closed = true;
      onSessionDetachedHub.emit({sessionId: this.sessionId, deviceId: this.deviceId});
      throw new WebTransportError('OPEN_FAILED', describeReason(reason));
    }
    this.configuration = next;
    if (wasReceiving) {
      this.receiveRequested = true;
      this.beginReadLoop();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.receiveRequested = false;
    await this.releaseReader();
    await this.releaseWriter();
    try {
      await this.port.close();
    } catch (reason) {
      throw new WebTransportError('CLOSE_FAILED', describeReason(reason));
    }
  }

  /**
   * The device was physically unplugged. The port is already dead, so
   * nothing is closed here - the streams are torn down and the session is
   * marked gone.
   */
  async abandon(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.receiveRequested = false;
    await this.releaseReader();
    await this.releaseWriter();
  }
}

const sessionsById = new Map<string, WebSerialSession>();

function requireSession(sessionId: string): WebSerialSession {
  const session = sessionsById.get(sessionId);
  if (!session || session.isClosed) {
    fail('UNKNOWN_SESSION', `No open session with id ${sessionId}.`);
  }
  return session;
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return typeof reason === 'string' ? reason : 'Unknown Web Serial error.';
}

/* ------------------------------------------------------------------ *
 * Hot-plug
 * ------------------------------------------------------------------ */

let hotplugInstalled = false;

/**
 * Web Serial's connect/disconnect events fire only for ports this origin
 * already has permission for, which is the same practical scope as
 * Android's USB attach/detach broadcast for an authorized device.
 */
function installHotplugListeners(serial: Serial): void {
  if (hotplugInstalled) {
    return;
  }
  hotplugInstalled = true;

  serial.addEventListener('connect', event => {
    // The spec dispatches a plain Event whose `target` IS the SerialPort.
    // Chromium additionally exposes it as `.port`; both are read because
    // the two forms have coexisted across releases and neither is
    // guaranteed by the type definitions.
    const port = (event.target ?? (event as {port?: SerialPort}).port) as
      | SerialPort
      | undefined;
    if (!port) {
      return;
    }
    const info = port.getInfo();
    onDeviceAttachedHub.emit({
      deviceId: identify(port),
      vendorId: info.usbVendorId ?? 0,
      productId: info.usbProductId ?? 0,
    });
  });

  serial.addEventListener('disconnect', event => {
    // The spec dispatches a plain Event whose `target` IS the SerialPort.
    // Chromium additionally exposes it as `.port`; both are read because
    // the two forms have coexisted across releases and neither is
    // guaranteed by the type definitions.
    const port = (event.target ?? (event as {port?: SerialPort}).port) as
      | SerialPort
      | undefined;
    if (!port) {
      return;
    }
    const info = port.getInfo();
    const deviceId = identify(port);
    onDeviceDetachedHub.emit({
      deviceId,
      vendorId: info.usbVendorId ?? 0,
      productId: info.usbProductId ?? 0,
    });
    // A detached device that owned a session is a SEPARATE, stronger
    // signal - MspSessionCoordinator surrenders ownership on it, and
    // MotorsScreen treats it as loss of the aircraft. Emitted only when
    // a session genuinely existed, exactly as the Android module does.
    for (const session of [...sessionsById.values()]) {
      if (session.port === port && !session.isClosed) {
        session.abandon().catch(() => undefined);
        sessionsById.delete(session.sessionId);
        recordDiagnostic('SESSION_DETACHED', {sessionId: session.sessionId, deviceId});
        onSessionDetachedHub.emit({sessionId: session.sessionId, deviceId});
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * File selection and saving - no transport required
 * ------------------------------------------------------------------ */

const FIRMWARE_ACCEPT = '.hex,.bin,.uf2,application/octet-stream';

/**
 * The browser counterpart of Android's Document Picker. Must be reached
 * from a user gesture, which every call site is (a button press in
 * FirmwareFlasherScreen).
 *
 * Resolving with `null` means the operator cancelled, and is not an
 * error - the same contract the Android module has.
 */
async function pickFirmwareFile(): Promise<FirmwareFileSelection | null> {
  if (typeof document === 'undefined') {
    fail('NOT_IMPLEMENTED', 'No document is available to open a file picker.');
  }
  const file = await new Promise<File | null>(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = FIRMWARE_ACCEPT;
    input.style.display = 'none';
    let settled = false;
    const settle = (value: File | null) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      settle(input.files && input.files.length > 0 ? input.files[0] : null);
    });
    // 'cancel' is the only reliable signal that the operator dismissed
    // the chooser. Without it a cancelled pick would leave this promise
    // pending forever and the flasher's button dead until reload.
    input.addEventListener('cancel', () => settle(null));
    document.body.appendChild(input);
    input.click();
  });

  if (!file) {
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) {
    // The shared client rejects a zero-length selection anyway; failing
    // here names the real problem instead of "invalid file result".
    fail('NATIVE_OPERATION_FAILED', 'The selected firmware file is empty.');
  }
  return {
    name: file.name,
    sizeBytes: bytes.length,
    dataBase64: bytesToBase64(bytes),
  };
}

/**
 * The browser counterpart of Android's save sheet: an ordinary download.
 * Used for UF2, where copying the file onto the board's mass-storage
 * volume remains the operator's step on every platform.
 */
async function saveFirmwareFile(
  filename: string,
  mimeType: string,
  dataBase64: string,
): Promise<boolean> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    fail('NOT_IMPLEMENTED', 'This browser cannot save a file.');
  }
  const bytes = base64ToBytes(dataBase64);
  // `bytes.buffer` is typed ArrayBufferLike, which includes
  // SharedArrayBuffer and is therefore not a BlobPart. base64ToBytes()
  // always allocates a plain ArrayBuffer, so the narrowing is sound.
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: mimeType || 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Deferred: revoking synchronously can cancel the download in some
    // browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  // True means "handed to the browser's download machinery". Whether the
  // operator kept the file is not observable, and is not claimed.
  return true;
}

/* ------------------------------------------------------------------ *
 * The module
 * ------------------------------------------------------------------ */

const NativeUsbSerialTransportWeb = {
  /** Previously-authorized ports ONLY. Never opens a chooser. */
  async listDevices(): Promise<UsbSerialDeviceDescriptor[]> {
    const serial = serialApi();
    installHotplugListeners(serial);
    let ports: SerialPort[];
    try {
      ports = await serial.getPorts();
    } catch (reason) {
      recordDiagnostic('SCAN_FAILED', {code: 'DEVICE_ENUMERATION_FAILED'});
      throw new WebTransportError('DEVICE_ENUMERATION_FAILED', describeReason(reason));
    }
    recordDiagnostic('SCAN_OK', {authorizedPorts: ports.length});
    return ports.map(describe);
  },

  /**
   * WEB-ONLY, and the only path that may open the browser's chooser.
   * Called from an explicit operator tap; see UsbSerialTransportClient's
   * requestDevicePermission() for how the shared layer reaches it without
   * the Android spec growing a method it cannot implement.
   */
  async requestSerialDevice(): Promise<UsbSerialDeviceDescriptor | null> {
    const serial = serialApi();
    installHotplugListeners(serial);
    let port: SerialPort;
    try {
      port = await serial.requestPort();
    } catch (reason) {
      // The browser rejects with NotFoundError when the operator closed
      // the chooser without picking anything. That is a cancellation, not
      // a failure, and must not surface as an error.
      if (reason instanceof DOMException && reason.name === 'NotFoundError') {
        recordDiagnostic('PICKER_DISMISSED');
        return null;
      }
      if (reason instanceof DOMException && reason.name === 'SecurityError') {
        recordDiagnostic('PICKER_DENIED', {code: 'PERMISSION_DENIED'});
        throw new WebTransportError('PERMISSION_DENIED', describeReason(reason));
      }
      recordDiagnostic('PICKER_FAILED', {code: 'PERMISSION_REQUEST_FAILED'});
      throw new WebTransportError('PERMISSION_REQUEST_FAILED', describeReason(reason));
    }
    const described = describe(port);
    recordDiagnostic('PICKER_GRANTED', {
      vendorId: described.vendorId,
      productId: described.productId,
      deviceId: described.deviceId,
    });
    return described;
  },

  async openDevice(
    deviceId: number,
    portIndex: number,
    configuration: SerialConfiguration,
  ): Promise<string> {
    // D9: a connect that somehow precedes any scan (deep link, restored
    // state) must still hear the detach that ends it.
    installHotplugListeners(serialApi());
    if (portIndex !== 0) {
      // Web Serial exposes exactly one stream per port object; a
      // multi-port adapter appears as several SerialPorts instead.
      fail('INVALID_PORT_INDEX', `Web Serial has no port index ${portIndex}.`);
    }
    const port = portById.get(deviceId);
    if (!port) {
      // D6: this is a STALE id (page reloaded, registry reset, device
      // re-enumerated) - not an unsupported device. The old code answered
      // "هذا الجهاز غير مدعوم حاليًا", which reads as a verdict about the
      // BOARD and sends the operator shopping for hardware faults.
      // DEVICE_CHANGED_DURING_OPEN's copy ("تم فصل الجهاز أو تغييره أثناء
      // محاولة الاتصال") tells them the truth: re-scan and retry.
      fail(
        'DEVICE_CHANGED_DURING_OPEN',
        `No authorized Web Serial port with id ${deviceId}.`,
      );
    }
    for (const session of sessionsById.values()) {
      if (session.port === port && !session.isClosed) {
        fail('DEVICE_ALREADY_IN_USE', 'This port already has an open session.');
      }
    }
    const options = toSerialOptions(configuration);
    recordDiagnostic('OPEN_REQUESTED', {
      deviceId,
      baudRate: configuration.baudRate,
      dataBits: configuration.dataBits,
      stopBits: configuration.stopBits,
      parity: configuration.parity,
      flowControl: configuration.flowControl,
    });
    try {
      await openWithTimeout(port, options);
    } catch (reason) {
      if (reason instanceof WebTransportError && reason.code === 'CONNECT_TIMEOUT') {
        recordDiagnostic('OPEN_FAILED', {deviceId, code: 'CONNECT_TIMEOUT'});
        throw reason;
      }
      const code =
        reason instanceof DOMException && reason.name === 'InvalidStateError'
          ? 'DEVICE_ALREADY_IN_USE'
          : reason instanceof DOMException && reason.name === 'SecurityError'
            ? 'PERMISSION_DENIED'
            : reason instanceof DOMException && reason.name === 'NotFoundError'
              ? 'DEVICE_CHANGED_DURING_OPEN'
              : 'OPEN_FAILED';
      recordDiagnostic('OPEN_FAILED', {deviceId, code});
      // InvalidStateError is the browser's "already open", which for
      // this app means another tab or another session owns it.
      throw new WebTransportError(code, describeReason(reason));
    }
    const session = new WebSerialSession(port, deviceId, configuration);
    sessionsById.set(session.sessionId, session);
    recordDiagnostic('OPEN_OK', {deviceId, sessionId: session.sessionId});
    return session.sessionId;
  },

  async closeSession(sessionId: string): Promise<void> {
    const session = sessionsById.get(sessionId);
    if (!session) {
      // Idempotent: closing an already-forgotten session is not an error,
      // and teardown paths call this after a detach has already removed
      // it. Rejecting here would turn ordinary cleanup into a failure.
      return;
    }
    sessionsById.delete(sessionId);
    await session.close();
    recordDiagnostic('SESSION_CLOSED', {sessionId});
  },

  async startReading(sessionId: string): Promise<void> {
    const session = requireSession(sessionId);
    try {
      await session.startReading();
    } catch (reason) {
      // D7: the coordinator reacts to a startReading rejection by tearing
      // its own state down (handleStartReadingFailure -> physical-detach
      // path) - but WITHOUT a transport-level detach event the connection
      // screen kept showing "متصل" with a live session id while Setup
      // showed connection lost. If the receive loop cannot start, the
      // session is unusable: close it here and emit the same detach event
      // a physical unplug produces, so BOTH shared listeners converge on
      // the same truth. RX_ALREADY_ACTIVE is the one exception - a second
      // start on a HEALTHY session must not kill it.
      const code = reason instanceof WebTransportError ? reason.code : '';
      if (code !== 'RX_ALREADY_ACTIVE') {
        sessionsById.delete(sessionId);
        await session.abandon();
        recordDiagnostic('SESSION_DETACHED', {sessionId, cause: 'RX_START_FAILED'});
        onSessionDetachedHub.emit({sessionId, deviceId: session.deviceId});
      }
      throw reason;
    }
    recordDiagnostic('RX_STARTED', {sessionId});
  },

  async stopReading(sessionId: string): Promise<void> {
    const session = sessionsById.get(sessionId);
    if (!session || session.isClosed) {
      // Idempotent by contract, including for a session already gone.
      return;
    }
    await session.stopReading();
  },

  async writeBytes(sessionId: string, dataBase64: string): Promise<void> {
    await requireSession(sessionId).write(base64ToBytes(dataBase64));
  },

  async setControlLines(sessionId: string, dtr: boolean, rts: boolean): Promise<void> {
    await requireSession(sessionId).setSignals(dtr, rts);
  },

  async setBaudRate(sessionId: string, baudRate: number): Promise<void> {
    await requireSession(sessionId).changeBaudRate(baudRate);
    recordDiagnostic('BAUD_CHANGED', {sessionId, baudRate});
  },

  pickFirmwareFile,
  saveFirmwareFile,

  /* ---- STM32 DFU / DfuSe over WebUSB (see webUsbDfu.web.ts) ---- */

  /**
   * Previously-authorized WebUSB devices ONLY, filtered to the bootloader
   * identities the app supports. Never opens a chooser - the flasher polls
   * this alongside the serial scan.
   *
   * A browser with no WebUSB resolves EMPTY rather than rejecting. That is
   * a deliberate difference from listDevices(): the flasher calls this on
   * every refresh, in parallel with the serial scan, and a rejection would
   * turn "this browser has no WebUSB" into a hard error on a screen whose
   * serial-based paths are working perfectly. The compatibility notice and
   * the DFU actions below are where that absence is reported.
   */
  async listDfuDevices(): Promise<DfuDeviceDescriptor[]> {
    if (typeof navigator === 'undefined' || !navigator.usb) {
      return [];
    }
    return listWebUsbDfuDevices();
  },

  /** WEB-ONLY. The only path that may open the WebUSB chooser. */
  async requestDfuDevice(): Promise<DfuDeviceDescriptor | null> {
    return requestWebUsbDfuDevice();
  },

  async flashDfuFirmware(
    deviceId: number,
    intelHexBase64: string,
    fullErase: boolean,
  ): Promise<void> {
    await flashWebUsbDfuFirmware(
      deviceId,
      base64ToBytes(intelHexBase64),
      fullErase,
      progress => onDfuFlashProgressHub.emit(progress),
    );
  },

  async cancelDfuFlash(): Promise<void> {
    // Raises a flag every transfer and poll loop checks. Deliberately does
    // NOT abort mid-transfer: interrupting an erase or a block write is
    // how a board is left unbootable. The in-flight operation finishes its
    // current step and then stops.
    cancelWebUsbDfuFlash();
  },

  async exitDfuMode(deviceId: number): Promise<void> {
    await exitWebUsbDfuMode(deviceId);
  },

  async unprotectDfuDevice(deviceId: number): Promise<void> {
    await unprotectWebUsbDfuDevice(deviceId);
  },

  onDataReceived: onDataReceivedHub.subscribe,
  onSessionDetached: onSessionDetachedHub.subscribe,
  onError: onErrorHub.subscribe,
  onDeviceAttached: onDeviceAttachedHub.subscribe,
  onDeviceDetached: onDeviceDetachedHub.subscribe,
  onDfuFlashProgress: onDfuFlashProgressHub.subscribe,
};

/**
 * The browser's counterpart of the spec's `Spec` interface. native/index.ts
 * re-exports this name as UsbSerialTransportSpec, so it must exist here
 * too. Derived from the implementation rather than written out a second
 * time - there is nothing for the two to disagree about.
 */
export type Spec = typeof NativeUsbSerialTransportWeb;

/**
 * Test seam only. Never called by the application.
 *
 * Abandons live sessions before clearing the registry rather than just
 * dropping them: each open session holds a pending reader.read() promise,
 * and simply forgetting the map would leave those promises - and the
 * streams they lock - alive for the rest of the worker's life.
 */
export function __resetWebSerialTransportForTests(): void {
  for (const session of sessionsById.values()) {
    session.abandon().catch(() => undefined);
  }
  sessionsById.clear();
  idByPort.clear();
  portById.clear();
  nextDeviceId = 1;
  nextSessionOrdinal = 1;
  hotplugInstalled = false;
}

export default NativeUsbSerialTransportWeb;
