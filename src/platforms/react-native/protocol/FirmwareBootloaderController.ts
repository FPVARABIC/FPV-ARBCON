import {MSP_REBOOT} from '../../../core';
import type {FlightControllerIdentity, MspClient} from '../../../core';
import type {
  DfuDeviceDescriptor,
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../transport';
import {isSupportedDevice} from '../transport';
import type {MspSessionCoordinator} from './MspSessionCoordinator';
import {mspSessionCoordinator} from './MspSessionCoordinator';

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

export class FirmwareDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmwareDetectionError';
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

  targetMatches(selectedTarget: string): boolean {
    const expected = selectedTarget.trim().toUpperCase();
    if (expected.length === 0) return true;
    const actual = [
      this.identity.board.targetName,
      this.identity.board.boardName,
      this.identity.board.boardIdentifier,
    ].map(value => value.trim().toUpperCase());
    return actual.includes(expected);
  }

  get rebootMode(): 1 | 4 {
    return (this.identity.board.targetCapabilities & (1 << 3)) !== 0 ? 4 : 1;
  }

  async rebootToBootloader(selectedTarget: string, allowMismatch = false): Promise<1 | 4> {
    if (this.identity.firmware.knownFamily !== 'BETAFLIGHT') {
      throw new FirmwareDetectionError('إعادة التشغيل التلقائية إلى bootloader متاحة لـ Betaflight فقط.');
    }
    if (!allowMismatch && !this.targetMatches(selectedTarget)) {
      throw new FirmwareDetectionError(
        `Target المحدد ${selectedTarget} لا يطابق المتحكم ${this.identity.board.boardName}.`,
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
    const supported = (await this.client.listDevices()).filter(isSupportedDevice);
    if (supported.length === 0) throw new FirmwareDetectionError('لم يُعثر على Flight Controller تسلسلي مدعوم.');
    if (selection === undefined && supported.length > 1) {
      throw new FirmwareDetectionError('وُجد أكثر من متحكم؛ اختر جهاز USB يدوياً لتجنب تفليش الجهاز الخطأ.');
    }
    const device = selection === undefined
      ? supported[0]
      : supported.find(candidate => candidate.deviceId === selection.deviceId);
    if (device === undefined) {
      throw new FirmwareDetectionError('جهاز USB المحدد يدوياً لم يعد متصلاً.');
    }
    if (selection === undefined && device.portCount !== 1) {
      throw new FirmwareDetectionError('للمتحكم أكثر من منفذ؛ يلزم اختيار المنفذ يدوياً.');
    }
    const portIndex = selection?.portIndex ?? 0;
    if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex >= device.portCount) {
      throw new FirmwareDetectionError('منفذ USB serial المحدد غير صالح.');
    }
    const sessionId = await this.client.openDevice(device.deviceId, portIndex, {
      baudRate: 115200,
      dataBits: 8,
      stopBits: '1',
      parity: 'none',
      flowControl: 'off',
    });
    let mspClient: MspClient | undefined;
    try {
      mspClient = this.coordinator.openSession(this.client, sessionId);
      const identity = await this.waitForIdentity(sessionId, signal);
      return new DetectedFlightController(device, sessionId, identity, this.client, this.coordinator, mspClient);
    } catch (error) {
      if (mspClient !== undefined) this.coordinator.deactivateMspSession(sessionId);
      await this.client.stopReading(sessionId).catch(() => undefined);
      await this.client.closeSession(sessionId).catch(() => undefined);
      throw error;
    }
  }

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
    throw new FirmwareDetectionError('انتهت مهلة انتظار متحكم واحد في وضع DFU.');
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
        () => finish(() => reject(new FirmwareDetectionError('انتهت مهلة التعرف التلقائي على المتحكم.'))),
        10_000,
      );
      const onAbort = () => finish(() => reject(new FirmwareDetectionError('أُلغيَ التعرف التلقائي.')));
      signal?.addEventListener('abort', onAbort, {once: true});
      inspect();
    });
  }
}
