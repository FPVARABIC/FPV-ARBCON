import type {BetaflightBuildApi} from './buildApi';
import {
  parseBuildResponse,
  parseBuildStatus,
} from './firmwareCatalog';
import type {
  FirmwareBuildRequest,
  FirmwareBuildResponse,
  FirmwareBuildStatus,
} from './firmwareCatalog';

export type CloudBuildPhase = 'requesting' | 'queued' | 'processing' | 'downloading' | 'complete';
export type CloudBuildUpdate = {
  readonly phase: CloudBuildPhase;
  readonly percent: number;
  readonly key?: string;
  readonly message: string;
};

export type CloudBuildResult = {
  readonly response: FirmwareBuildResponse;
  readonly firmware: Uint8Array;
  readonly configuration?: readonly string[];
};

type BuildApiSurface = Pick<
  BetaflightBuildApi,
  'requestBuild' | 'requestBuildStatus' | 'loadFirmware'
>;

function cancelledError(): Error {
  return new Error('أُلغيَ بناء Firmware.');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

/** One awaited status request at a time: no overlapping interval callbacks. */
export class CloudBuildCoordinator {
  constructor(
    private readonly api: BuildApiSurface,
    private readonly pollIntervalMs = 5000,
    private readonly waitImpl: (ms: number, signal?: AbortSignal) => Promise<void> = wait,
    private readonly now: () => number = Date.now,
  ) {}

  async buildAndDownload(
    request: FirmwareBuildRequest,
    onUpdate: (update: CloudBuildUpdate) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<CloudBuildResult> {
    this.checkCancelled(signal);
    onUpdate({phase: 'requesting', percent: 0, message: 'إرسال طلب البناء الآمن…'});
    const response = parseBuildResponse(await this.api.requestBuild({...request}, signal));
    let configuration: readonly string[] | undefined;

    if (response.key !== undefined) {
      configuration = await this.poll({...response, key: response.key}, onUpdate, signal);
    }

    this.checkCancelled(signal);
    onUpdate({
      phase: 'downloading',
      percent: 94,
      ...(response.key === undefined ? {} : {key: response.key}),
      message: 'تنزيل Firmware من خادم Betaflight الرسمي…',
    });
    const firmware = await this.downloadWithOneRetry(response.url, signal);
    onUpdate({
      phase: 'complete',
      percent: 100,
      ...(response.key === undefined ? {} : {key: response.key}),
      message: 'اكتمل البناء والتنزيل والتحقق الأولي.',
    });
    return {response, firmware, ...(configuration === undefined ? {} : {configuration})};
  }

  private async poll(
    response: FirmwareBuildResponse & {readonly key: string},
    onUpdate: (update: CloudBuildUpdate) => void,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    let deadline = this.now() + 120_000;
    let processingStarted = false;
    let attempt = 0;
    while (true) {
      this.checkCancelled(signal);
      const status = parseBuildStatus(await this.api.requestBuildStatus(response.key, signal));
      if (status.status === 'processing' && !processingStarted) {
        processingStarted = true;
        deadline = this.now() + (status.timeOutSeconds ?? 120) * 1000;
      }
      if (status.status === 'success') return status.configuration;
      if (status.status === 'failed') {
        throw new Error(status.message ?? 'فشل خادم Betaflight في بناء Firmware.');
      }
      if (this.now() >= deadline) {
        throw new Error('انتهت مهلة بناء Firmware دون نتيجة نهائية.');
      }
      attempt += 1;
      const percent = status.status === 'processing'
        ? Math.min(90, 25 + attempt * 5)
        : Math.min(20, attempt * 4);
      onUpdate({
        phase: status.status,
        percent,
        key: response.key,
        message: status.status === 'processing' ? 'يجري بناء Firmware…' : 'طلب البناء في قائمة الانتظار…',
      });
      await this.waitImpl(this.pollIntervalMs, signal);
    }
  }

  private async downloadWithOneRetry(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      return await this.api.loadFirmware(path, signal);
    } catch (firstError) {
      this.checkCancelled(signal);
      await this.waitImpl(Math.min(4000, this.pollIntervalMs), signal);
      try {
        return await this.api.loadFirmware(path, signal);
      } catch {
        throw firstError;
      }
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw cancelledError();
  }
}

export function isBuildTerminal(status: FirmwareBuildStatus): boolean {
  return status.status === 'success' || status.status === 'failed';
}
