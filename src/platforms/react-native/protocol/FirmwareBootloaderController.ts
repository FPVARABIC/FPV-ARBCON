import {
  MSP_REBOOT,
  boardMatchesTarget,
  classifyConnectionStage,
  describeFlightControllerHardware,
  resolveCatalogTarget,
} from '../../../core';
import type {ConnectionStage, FlightControllerIdentity, MspClient} from '../../../core';
import type {
  DfuDeviceDescriptor,
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../transport';
import {isSupportedDevice} from '../transport';
import {beginConnectionTrace} from '../../../core/protocol/msp/identification/connectionTrace';
import type {MspSessionCoordinator} from './MspSessionCoordinator';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {releaseApplicationOwnedSessions} from './exclusiveDeviceAccess';

/**
 * "The port is taken", as every platform reports it.
 *
 * Web Serial surfaces a WebTransportError with this code, Android
 * rejects the promise with it as the native error code, and a browser
 * that fails the open itself raises InvalidStateError which the web
 * transport already normalises to the same code. Matching on the CODE
 * rather than on message text is what makes this work in Arabic, in
 * English, and on a platform that phrases it differently again.
 */
function isDeviceBusyError(error: unknown): boolean {
  const code = (error as {code?: unknown} | null)?.code;
  return code === 'DEVICE_ALREADY_IN_USE';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('أُلغيَ انتظار bootloader.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('أُلغيَ انتظار bootloader.'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * No AUTHORIZED DFU device appeared inside the bounded wait.
 *
 * Deliberately distinct from a detection failure: the board may well be
 * in DFU and simply not yet authorized for this browser origin. The
 * caller is expected to offer a user-gesture chooser and RESUME the same
 * prepared operation - never to re-send the reboot or restart a write.
 */
export class DfuPermissionRequiredError extends Error {
  constructor() {
    super('DFU device permission is required before the pending flash can continue.');
    this.name = 'DfuPermissionRequiredError';
  }
}

/**
 * A detection failure that KNOWS which stage it failed at - USB present
 * or absent, port openable, MSP answering, board named. Callers can
 * present the real stage instead of one catch-all sentence.
 */
export class FirmwareDetectionError extends Error {
  readonly stage?: ConnectionStage;

  constructor(message: string, stage?: ConnectionStage) {
    super(message);
    this.name = 'FirmwareDetectionError';
    this.stage = stage;
  }
}

export class DetectedFlightController {
  private released = false;

  constructor(
    readonly device: UsbSerialDeviceDescriptor,
    readonly sessionId: string,
    readonly identity: FlightControllerIdentity,
    private readonly client: UsbSerialTransportClient,
    private readonly coordinator: MspSessionCoordinator,
    private readonly mspClient: MspClient,
  ) {}

  /** Shared, vendor-neutral matching - see flightControllerNaming.ts. */
  targetMatches(selectedTarget: string): boolean {
    return boardMatchesTarget(this.identity.board, selectedTarget);
  }

  /** The catalogue target this board answers to (board name first). */
  get catalogTarget(): string {
    return resolveCatalogTarget(this.identity.board);
  }

  /** The operator-facing hardware name (flightControllerNaming.ts). */
  get hardwareName(): string {
    return describeFlightControllerHardware(this.identity.board);
  }

  get rebootMode(): 1 | 4 {
    return (this.identity.board.targetCapabilities & (1 << 3)) !== 0 ? 4 : 1;
  }

  async rebootToBootloader(selectedTarget: string, allowMismatch = false): Promise<1 | 4> {
    if (this.identity.firmware.knownFamily !== 'BETAFLIGHT') {
      throw new FirmwareDetectionError('إعادة التشغيل التلقائية إلى bootloader غير مدعومة لعائلة Firmware المكتشفة.');
    }
    if (!allowMismatch && !this.targetMatches(selectedTarget)) {
      throw new FirmwareDetectionError(
        `Target المحدد ${selectedTarget} لا يطابق المتحكم ${this.hardwareName}.`,
      );
    }
    const mode = this.rebootMode;
    try {
      await this.mspClient.request(MSP_REBOOT, Uint8Array.of(mode), {
        wireFormat: 'v1',
        responseTimeoutMs: 1200,
      });
    } catch (error) {
      const code = (error as {code?: unknown} | null)?.code;
      if (!['MSP_DEVICE_DETACHED', 'MSP_SESSION_CLOSED', 'MSP_TIMEOUT'].includes(String(code))) {
        throw error;
      }
      // Losing the link immediately after the write is the normal reboot outcome.
    } finally {
      await this.release();
    }
    return mode;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.coordinator.deactivateMspSession(this.sessionId);
    await this.client.stopReading(this.sessionId).catch(() => undefined);
    await this.client.closeSession(this.sessionId).catch(() => undefined);
  }
}

export class FirmwareBootloaderController {
  constructor(
    private readonly client: UsbSerialTransportClient,
    private readonly coordinator: MspSessionCoordinator = mspSessionCoordinator,
  ) {}

  async detectFlightController(
    signal?: AbortSignal,
    selection?: {readonly deviceId: number; readonly portIndex: number},
  ): Promise<DetectedFlightController> {
    if (signal?.aborted) throw new FirmwareDetectionError('أُلغيَ اكتشاف Flight Controller.');
    // Developer diagnostics only; see connectionTrace.ts. Started here so
    // a failure at ANY stage - including "nothing on the bus" - produces
    // an exportable report rather than only the successful cases.
    const trace = beginConnectionTrace();
    // STAGE TRUTH. A USB device that is present but exposes no usable
    // serial interface is a DIFFERENT fact from no device at all, and
    // reporting both as "no flight controller found" sent operators to
    // check a cable that was never the problem.
    const attached = await this.client.listDevices();
    const supported = attached.filter(isSupportedDevice);
    trace.fact('usbDevicesVisible', attached.length);
    trace.fact('serialCapableDevices', supported.length);
    if (supported.length === 0) {
      const stage = classifyConnectionStage({
        usbDeviceCount: attached.length,
        serialCapableCount: 0,
      });
      trace.failed('USB_DEVICE_FOUND', stage);
      throw new FirmwareDetectionError(
        stage === 'NO_USB_DEVICE'
          ? 'لا يوجد أي جهاز USB متصل. وصّل متحكم الطيران بكابل بيانات ثم أعد المحاولة.'
          : 'تم العثور على جهاز USB، لكنه لا يعرض منفذًا تسلسليًا يمكن فتحه. تأكد أن الكابل كابل بيانات وأن اللوحة في الوضع العادي وليست في وضع DFU.',
        stage,
      );
    }
    if (selection === undefined && supported.length > 1) {
      throw new FirmwareDetectionError(
        'وُجد أكثر من متحكم؛ اختر جهاز USB يدوياً لتجنب تفليش الجهاز الخطأ.',
        'MULTIPLE_USB_DEVICES',
      );
    }
    const device = selection === undefined
      ? supported[0]
      : supported.find(candidate => candidate.deviceId === selection.deviceId);
    if (device === undefined) {
      throw new FirmwareDetectionError('جهاز USB المحدد يدوياً لم يعد متصلاً.');
    }
    if (selection === undefined && device.portCount !== 1) {
      throw new FirmwareDetectionError(
        'للمتحكم أكثر من منفذ؛ يلزم اختيار المنفذ يدوياً.',
        'MULTIPLE_PORTS',
      );
    }
    const portIndex = selection?.portIndex ?? 0;
    if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex >= device.portCount) {
      throw new FirmwareDetectionError('منفذ USB serial المحدد غير صالح.');
    }
    trace.reached('USB_DEVICE_FOUND', `vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)}`);
    trace.fact('vendorId', `0x${device.vendorId.toString(16).padStart(4, '0')}`);
    trace.fact('productId', `0x${device.productId.toString(16).padStart(4, '0')}`);
    trace.fact('driverType', device.driverType);
    trace.fact('portIndex', portIndex);
    // 115200 8N1, no flow control, and no DTR/RTS assertion anywhere on
    // this path - the parameters a flight controller's CDC/FTDI bridge
    // enumerates with.
    trace.fact('openParameters', '115200 8N1 flowControl=off');

    /**
     * EXCLUSIVE ACCESS, TAKEN BEFORE THE OPEN - the root fix.
     *
     * A serial port admits one owner. This application deliberately
     * keeps a verified MSP session alive after the operator leaves the
     * workspace, so the single commonest way to reach this screen -
     * connect, look at Setup, go back, open the flasher - arrives with
     * the port already held BY US. openDevice then rejects
     * DEVICE_ALREADY_IN_USE and the operator was told to re-plug a cable
     * that was never the problem.
     *
     * Releasing here rather than in a press handler covers all three
     * entry points (auto-detect, reboot-to-bootloader, verify) at once.
     * See exclusiveDeviceAccess.ts for the full account.
     */
    const releaseOutcome = await releaseApplicationOwnedSessions(
      this.client,
      this.coordinator,
    );
    trace.fact('ownSessionsReleased', releaseOutcome.released.length);
    if (releaseOutcome.closeFailures.length > 0) {
      trace.fact('ownSessionsCloseUnconfirmed', releaseOutcome.closeFailures.length);
    }

    let sessionId: string;
    try {
      sessionId = await this.client.openDevice(device.deviceId, portIndex, {
        baudRate: 115200,
        dataBits: 8,
        stopBits: '1',
        parity: 'none',
        flowControl: 'off',
      });
    } catch (openError) {
      /* STILL BUSY AFTER WE LET GO means somebody else holds it - another
         browser tab, another application, or a close this process could
         not confirm. Each is actionable, and none of them is "re-plug
         the cable", which is what the generic path used to say. */
      if (isDeviceBusyError(openError)) {
        trace.failed('PORT_OPENED', 'DEVICE_ALREADY_IN_USE after releasing own sessions');
        throw new FirmwareDetectionError(
          releaseOutcome.closeFailures.length > 0
            ? 'تعذّر تأكيد إغلاق جلسة الاتصال السابقة داخل التطبيق، والمنفذ ما زال مشغولًا. افصل الكابل وأعد توصيله ثم أعد المحاولة.'
            : 'منفذ اللوحة مشغول من تطبيق أو تبويب آخر. أغلق أي نافذة أخرى متصلة بهذه اللوحة ثم أعد المحاولة.',
          'TRANSPORT_OPEN_FAILED',
        );
      }
      throw openError;
    }
    trace.reached('PORT_OPENED', sessionId);

    /* A LEFTOVER OWNERSHIP RECORD FOR A REUSED ID WOULD POISON THIS
       SESSION. openSession() returns the EXISTING MspClient when the
       coordinator already knows an id, and never starts identification
       for it - so waitForIdentity() below would read a verdict belonging
       to a dead session: an instant stale FAILED, or an IDLE that runs
       the full timeout and reports "the board did not answer" about a
       board nobody ever asked. The release above should have emptied the
       map; this is the belt to its braces. */
    if (this.coordinator.listSessionIds().includes(sessionId)) {
      trace.fact('staleOwnershipRecordCleared', sessionId);
      this.coordinator.deactivateMspSession(sessionId);
    }
    let mspClient: MspClient | undefined;
    try {
      mspClient = this.coordinator.openSession(this.client, sessionId);
      trace.reached('SERIAL_READY', 'read loop started');
      const identity = await this.waitForIdentity(sessionId, signal);
      trace.reached('READY', 'session usable');
      return new DetectedFlightController(device, sessionId, identity, this.client, this.coordinator, mspClient);
    } catch (error) {
      trace.failed('SERIAL_READY', error instanceof Error ? error.message : String(error));
      if (mspClient !== undefined) this.coordinator.deactivateMspSession(sessionId);
      await this.client.stopReading(sessionId).catch(() => undefined);
      await this.client.closeSession(sessionId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Waits for exactly one AUTHORIZED DFU device.
   *
   * `listDfuDevices()` is `navigator.usb.getDevices()` on the web, which
   * lists only devices the operator has already authorized IN THIS
   * BROWSER. On a first flash the board really is in DFU and really has
   * re-enumerated, but its new identity is invisible here - so running
   * this wait out and reporting a timeout would be a lie about the
   * hardware. Callers that can ask for permission should catch
   * DfuPermissionRequiredError and offer the operator a chooser instead
   * of failing.
   */
  async waitForOneDfuDevice(timeoutMs = 20_000, signal?: AbortSignal): Promise<DfuDeviceDescriptor> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const devices = await this.client.listDfuDevices();
      if (devices.length === 1) return devices[0];
      if (devices.length > 1) {
        throw new FirmwareDetectionError('وُجد أكثر من جهاز DFU؛ افصل الأجهزة الإضافية لتجنب التفليش الخاطئ.');
      }
      await delay(250, signal);
    }
    // Nothing AUTHORIZED appeared. On a platform whose device list is
    // permission-scoped this is the expected first-use outcome, not a
    // hardware failure - so it is reported as its own condition.
    throw new DfuPermissionRequiredError();
  }

  async waitForOneSerialDevice(timeoutMs = 30_000, signal?: AbortSignal): Promise<UsbSerialDeviceDescriptor> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const devices = (await this.client.listDevices()).filter(isSupportedDevice);
      if (devices.length === 1) return devices[0];
      if (devices.length > 1) {
        throw new FirmwareDetectionError('وُجد أكثر من جهاز تسلسلي؛ لا يمكن اختيار جهاز الاستعادة بأمان.');
      }
      await delay(300, signal);
    }
    throw new FirmwareDetectionError('انتهت مهلة انتظار Flight Controller بعد التفليش.');
  }

  private waitForIdentity(sessionId: string, signal?: AbortSignal): Promise<FlightControllerIdentity> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const inspect = () => {
        const state = this.coordinator.getIdentificationState(sessionId);
        if (state.status === 'SUCCEEDED') finish(() => resolve(state.identity));
        else if (state.status === 'FAILED') finish(() => reject(state.error));
      };
      const unsubscribe = this.coordinator.subscribeIdentificationState(inspect);
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new FirmwareDetectionError(
                'فُتح المنفذ لكن لم يرد متحكم الطيران على بروتوكول MSP. تأكد أن اللوحة تعمل ببرنامج ثابت متوافق مع MSP وليست في وضع DFU.',
                'MSP_NOT_RESPONDING',
              ),
            ),
          ),
        10_000,
      );
      const onAbort = () => finish(() => reject(new FirmwareDetectionError('أُلغيَ التعرف التلقائي.')));
      signal?.addEventListener('abort', onAbort, {once: true});
      inspect();
    });
  }
}
