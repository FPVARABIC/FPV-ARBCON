import {withDeadline} from '../async/deadline';
import {readBytesBounded, readTextBounded} from '../async/boundedBody';
import type {BoundedBodyOutcome} from '../async/boundedBody';

const BUILD_ORIGIN = 'https://build.betaflight.com';

/**
 * How long the build server gets to say ANYTHING - once for the
 * headers, and then again for every gap between body chunks.
 *
 * Not derived from anything on the wire - this is a public HTTPS
 * service, not the MSP link - so it is chosen and justified: long enough
 * that a cold cloud-build endpoint on a slow mobile connection still
 * answers, short enough that an operator watching «جارٍ التحمير» learns
 * the truth in well under a minute.
 *
 * ONE NUMBER, APPLIED TWICE, on purpose. A transfer that has already
 * started and then goes silent for as long as the whole connection was
 * allowed to take before it started is not slow - it is dead. Re-arming
 * it per chunk is what keeps a legitimately slow 8 MB firmware download
 * alive while still ending a stalled one promptly; see boundedBody.ts.
 */
const BUILD_API_RESPONSE_TIMEOUT_MILLIS = 30_000;
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
  /**
   * The default is a WRAPPER around the global fetch, not the bare `fetch`
   * reference it used to be, and the difference is a production outage:
   * a bare default captures the function unbound, every use site calls it
   * as `this.fetchImpl(...)`, and a browser's native fetch REQUIRES its
   * receiver to be the global object - Chromium rejects any other `this`
   * with "Failed to execute 'fetch' on 'Window': Illegal invocation".
   * Hermes on Android does not care, which is exactly why this shipped:
   * the same line worked on every Android build and killed the target
   * list on every web build (the flasher caught the error and rendered
   * it as "القائمة غير متاحة"). The arrow re-reads the global at call
   * time with an undefined receiver, which both runtimes accept.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * The single transport hop every method goes through. Exists so a
   * network-level rejection is translated ONCE: browsers reject with a
   * bare TypeError whose text is internal English ("Failed to fetch"),
   * and shown raw that is exactly what the operator reads. Name the real
   * situation - the build server was unreachable from this page
   * (offline, DNS, or the server not permitting cross-origin access) -
   * and keep the technical detail as a suffix for bug reports. An abort
   * is the caller's own cancellation and is rethrown untouched so
   * AbortController semantics (and the screen's aborted-check) hold.
   */
  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<{
    readonly response: Response;
    /** Tears the transfer down - used by the BODY deadline, below. */
    readonly abort: () => void;
    /** Unlinks this request from the caller's signal. */
    readonly detach: () => void;
  }> {
    /*
     * BOUNDED, BECAUSE A SERVER THAT ACCEPTS AND NEVER ANSWERS IS THE
     * COMMON FAILURE, NOT THE RARE ONE.
     *
     * `fetch()` rejects on DNS failure and connection refusal quickly,
     * but a connection that is established and then goes silent - a
     * captive portal, a proxy that swallowed the request, a server under
     * load - leaves this Promise pending with no clock of its own. Every
     * screen above it then sits on its LoadState, and the cloud-build
     * poll loop below never reaches the deadline check between its
     * requests, because it never returns from one.
     *
     * WHAT THIS BOUNDS: the response HEADERS. `fetch()` settles when
     * they arrive, not when the body has been read - so bounding only
     * this call bounds only half the transfer, which is exactly the gap
     * that used to be left open. The other half is bounded by the
     * caller, which reads the body through readTextBounded /
     * readBytesBounded using the `abort` handle returned here.
     *
     * On expiry the underlying request is ABORTED rather than merely
     * abandoned: a half-open connection left behind would hold a
     * connection slot and could still deliver a body nobody is reading.
     */
    const deadlineController = new AbortController();
    const abortOnDeadline = () => deadlineController.abort();
    init?.signal?.addEventListener('abort', abortOnDeadline, {once: true});
    /** True once the caller owns the unlink, so `finally` does not. */
    let detached = false;
    try {
      const outcome = await withDeadline(
        this.fetchImpl(sameOriginUrl(path), {
          ...init,
          signal: deadlineController.signal,
          headers: {'X-CFG-VER': 'FPV-ARBCON/1.0', ...(init?.headers ?? {})},
        }),
        BUILD_API_RESPONSE_TIMEOUT_MILLIS,
      );
      if (outcome.status === 'SETTLED') {
        /* The listener is NOT detached here: the caller still has a body
           to read, and the caller's own cancel must keep reaching this
           request until that read is over. `detach` hands that duty on. */
        detached = true;
        return {
          response: outcome.value,
          abort: () => deadlineController.abort(),
          detach: () => {
            init?.signal?.removeEventListener('abort', abortOnDeadline);
          },
        };
      }
      if (outcome.status === 'TIMED_OUT') {
        deadlineController.abort();
        throw new BuildApiError(
          'لم يستجب خادم البناء خلال المهلة. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
        );
      }
      throw outcome.reason;
    } catch (reason) {
      if (reason instanceof BuildApiError) throw reason;
      /* The caller's own cancellation reaches here as our linked
         controller's abort; report it as the abort it is so the screen's
         aborted-check still holds. */
      if (init?.signal?.aborted === true) {
        const aborted = new Error('أُلغيت العملية.');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (reason instanceof Error && reason.name === 'AbortError') {
        throw reason;
      }
      // The operator gets the Arabic meaning; the browser's own English
      // sentence ("Failed to fetch") goes to the console for developers
      // instead of into the UI, where it read as an untranslated defect.
      if (typeof console !== 'undefined') {
        console.warn(
          '[buildApi] network/CORS failure:',
          reason instanceof Error ? reason.message : String(reason),
        );
      }
      throw new BuildApiError(
        'تعذّر الوصول إلى خادم البناء من هذه الصفحة. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
      );
    } finally {
      if (!detached) init?.signal?.removeEventListener('abort', abortOnDeadline);
    }
  }

  /**
   * THE OTHER HALF OF THE BOUND. Reads a body that may stop arriving,
   * and turns every non-success outcome into an operator-facing
   * BuildApiError rather than a pending Promise. See boundedBody.ts for
   * why the body deadline is a STALL deadline and not a total one.
   */
  private settleBody<T>(
    outcome: BoundedBodyOutcome<T>,
    tooLarge: string,
    signal: AbortSignal | null | undefined,
  ): T {
    if (outcome.status === 'READ') return outcome.value;
    if (outcome.status === 'TOO_LARGE') throw new BuildApiError(tooLarge);
    if (outcome.status === 'STALLED') {
      throw new BuildApiError(
        'توقّف تنزيل البيانات من خادم البناء. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
      );
    }
    /* A rejected read after the caller cancelled is the cancellation,
       not a server fault - the screen's aborted-check must still see it
       as an abort. */
    if (signal?.aborted === true) {
      const aborted = new Error('أُلغيت العملية.');
      aborted.name = 'AbortError';
      throw aborted;
    }
    if (
      outcome.reason instanceof Error &&
      outcome.reason.name === 'AbortError'
    ) {
      throw outcome.reason;
    }
    throw new BuildApiError(
      'انقطع تنزيل البيانات من خادم البناء قبل اكتماله.',
    );
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const {response, abort, detach} = await this.request(path, init);
    try {
      await ensureResponse(response);
      const declared = contentLength(response);
      if (declared !== undefined && declared > MAX_JSON_BYTES) {
        throw new BuildApiError('استجابة خادم البناء أكبر من الحد الآمن.');
      }
      const text = this.settleBody(
        await readTextBounded(response, {
          limitBytes: MAX_JSON_BYTES,
          stallTimeoutMs: BUILD_API_RESPONSE_TIMEOUT_MILLIS,
          expectedBytes: declared,
          abort,
        }),
        'استجابة خادم البناء أكبر من الحد الآمن.',
        init?.signal,
      );
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BuildApiError('خادم البناء أعاد JSON غير صالح.');
      }
    } finally {
      detach();
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
    const {response, abort, detach} = await this.request(
      `/api/builds/${encodeURIComponent(key)}/log`,
      {signal},
    );
    try {
      await ensureResponse(response);
      const declared = contentLength(response);
      if (declared !== undefined && declared > MAX_BUILD_LOG_BYTES) {
        throw new BuildApiError('سجل Build أكبر من الحد الآمن للعرض داخل التطبيق.');
      }
      return this.settleBody(
        await readTextBounded(response, {
          limitBytes: MAX_BUILD_LOG_BYTES,
          stallTimeoutMs: BUILD_API_RESPONSE_TIMEOUT_MILLIS,
          expectedBytes: declared,
          abort,
        }),
        'سجل Build أكبر من الحد الآمن للعرض داخل التطبيق.',
        signal,
      );
    } finally {
      detach();
    }
  }

  async loadFirmware(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const {response, abort, detach} = await this.request(path, {signal});
    try {
      await ensureResponse(response);
      const declared = contentLength(response);
      if (declared !== undefined && declared > MAX_BINARY_BYTES) {
        throw new BuildApiError('ملف Firmware من الخادم أكبر من الحد الآمن.');
      }
      const bytes = this.settleBody(
        await readBytesBounded(response, {
          limitBytes: MAX_BINARY_BYTES,
          stallTimeoutMs: BUILD_API_RESPONSE_TIMEOUT_MILLIS,
          expectedBytes: declared,
          abort,
        }),
        'ملف Firmware فارغ أو أكبر من الحد الآمن.',
        signal,
      );
      if (bytes.length === 0) {
        throw new BuildApiError('ملف Firmware فارغ أو أكبر من الحد الآمن.');
      }
      return bytes;
    } finally {
      detach();
    }
  }
}

export const betaflightBuildApi = new BetaflightBuildApi();
