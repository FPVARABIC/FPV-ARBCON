const BUILD_ORIGIN = 'https://build.betaflight.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_LOG_BYTES = 512 * 1024;

export type BetaflightTarget = {
  readonly target: string;
  readonly group?: 'supported' | 'unsupported' | 'legacy' | string;
  readonly manufacturer?: string;
  readonly mcu?: string;
  readonly [key: string]: unknown;
};

export class BuildApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BuildApiError';
    this.status = status;
  }
}

function sameOriginUrl(path: string): string {
  const url = new URL(path, BUILD_ORIGIN);
  if (url.origin !== BUILD_ORIGIN || url.protocol !== 'https:') {
    throw new BuildApiError('تم رفض عنوان تنزيل Firmware خارج خادم البناء الموثوق.');
  }
  return url.toString();
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function ensureResponse(response: Response): Promise<void> {
  if (!response.ok) {
    throw new BuildApiError(`خادم Firmware أعاد HTTP ${response.status}.`, response.status);
  }
}

export class BetaflightBuildApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(sameOriginUrl(path), {
      ...init,
      headers: {'X-CFG-VER': 'FPV-ARBCON/1.0', ...(init?.headers ?? {})},
    });
    await ensureResponse(response);
    const declared = contentLength(response);
    if (declared !== undefined && declared > MAX_JSON_BYTES) {
      throw new BuildApiError('استجابة خادم البناء أكبر من الحد الآمن.');
    }
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) {
      throw new BuildApiError('استجابة خادم البناء أكبر من الحد الآمن.');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BuildApiError('خادم البناء أعاد JSON غير صالح.');
    }
  }

  async loadTargets(signal?: AbortSignal): Promise<readonly BetaflightTarget[]> {
    const result = await this.json<unknown>('/api/targets', {signal});
    if (!Array.isArray(result)) {
      throw new BuildApiError('قائمة Targets من الخادم غير صالحة.');
    }
    return result.filter(
      (item): item is BetaflightTarget =>
        typeof item === 'object' && item !== null && typeof (item as {target?: unknown}).target === 'string',
    );
  }

  loadTargetReleases(target: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(`/api/targets/${encodeURIComponent(target)}`, {signal});
  }

  loadBuild(target: string, release: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(`/api/builds/${encodeURIComponent(release)}/${encodeURIComponent(target)}`, {signal});
  }

  loadOptions(release: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(`/api/options/${encodeURIComponent(release)}`, {signal});
  }

  loadOptionsByBuildKey(
    release: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.json(`/api/options/${encodeURIComponent(release)}/${encodeURIComponent(key)}`, {signal});
  }

  loadCommits(release: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(`/api/releases/${encodeURIComponent(release)}/commits`, {signal});
  }

  requestBuild(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json('/api/builds', {
      method: 'POST',
      signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(request),
    });
  }

  requestBuildStatus(key: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(`/api/builds/${encodeURIComponent(key)}/status`, {signal});
  }

  async loadBuildLog(key: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(
      sameOriginUrl(`/api/builds/${encodeURIComponent(key)}/log`),
      {signal, headers: {'X-CFG-VER': 'FPV-ARBCON/1.0'}},
    );
    await ensureResponse(response);
    const declared = contentLength(response);
    if (declared !== undefined && declared > MAX_BUILD_LOG_BYTES) {
      throw new BuildApiError('سجل Build أكبر من الحد الآمن للعرض داخل التطبيق.');
    }
    const log = await response.text();
    if (log.length > MAX_BUILD_LOG_BYTES) {
      throw new BuildApiError('سجل Build أكبر من الحد الآمن للعرض داخل التطبيق.');
    }
    return log;
  }

  async loadFirmware(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchImpl(sameOriginUrl(path), {
      signal,
      headers: {'X-CFG-VER': 'FPV-ARBCON/1.0'},
    });
    await ensureResponse(response);
    const declared = contentLength(response);
    if (declared !== undefined && declared > MAX_BINARY_BYTES) {
      throw new BuildApiError('ملف Firmware من الخادم أكبر من الحد الآمن.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BINARY_BYTES) {
      throw new BuildApiError('ملف Firmware فارغ أو أكبر من الحد الآمن.');
    }
    return bytes;
  }
}

export const betaflightBuildApi = new BetaflightBuildApi();
