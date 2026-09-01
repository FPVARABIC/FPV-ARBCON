import {BetaflightBuildApi, BuildApiError} from './buildApi';

function response(options: {
  ok?: boolean;
  status?: number;
  text?: string;
  bytes?: Uint8Array;
  length?: string;
}): Response {
  const bytes = options.bytes ?? new TextEncoder().encode(options.text ?? '');
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {get: (name: string) => name.toLowerCase() === 'content-length' ? options.length ?? null : null},
    text: async () => options.text ?? new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

describe('BetaflightBuildApi', () => {
  it('loads only valid target descriptors from the fixed official origin', async () => {
    const fetcher = jest.fn(async () => response({text: JSON.stringify([{target: 'S405'}, {bad: true}])}));
    const api = new BetaflightBuildApi(fetcher as unknown as typeof fetch);
    await expect(api.loadTargets()).resolves.toEqual([{target: 'S405'}]);
    expect((fetcher.mock.calls as unknown[][])[0][0]).toBe('https://build.betaflight.com/api/targets');
  });

  it('keeps firmware binary-safe and rejects off-origin or oversized downloads', async () => {
    const fetcher = jest.fn(async () => response({bytes: Uint8Array.from([0, 255, 1])}));
    const api = new BetaflightBuildApi(fetcher as unknown as typeof fetch);
    await expect(api.loadFirmware('/firmware/test.bin')).resolves.toEqual(Uint8Array.from([0, 255, 1]));
    await expect(api.loadFirmware('https://evil.example/test.bin')).rejects.toBeInstanceOf(BuildApiError);

    fetcher.mockResolvedValueOnce(response({length: String(9 * 1024 * 1024)}));
    await expect(api.loadFirmware('/large.hex')).rejects.toThrow(/أكبر/);
  });

  it('surfaces HTTP and malformed JSON failures', async () => {
    const failing = new BetaflightBuildApi(jest.fn(async () => response({ok: false, status: 503})) as unknown as typeof fetch);
    await expect(failing.loadTargets()).rejects.toMatchObject({status: 503});
    const malformed = new BetaflightBuildApi(jest.fn(async () => response({text: '{'})) as unknown as typeof fetch);
    await expect(malformed.loadTargets()).rejects.toThrow(/JSON/);
  });

  it('never invokes the DEFAULT fetch with a receiver a browser would reject', async () => {
    // Regression for the web-only production failure "Failed to execute
    // 'fetch' on 'Window': Illegal invocation": the constructor default
    // used to capture `fetch` UNBOUND, and `this.fetchImpl(...)` then
    // called it with the API instance as receiver. Hermes accepts that,
    // Chromium's native fetch does not - so the target list died on every
    // web build while every Android build and every test (which all pass
    // an explicit fetchImpl) stayed green. This stub enforces the
    // browser's contract: any receiver other than undefined/globalThis
    // throws exactly as Chromium does.
    const original = (globalThis as {fetch?: unknown}).fetch;
    const receiverSensitiveFetch = jest.fn(async function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return response({text: JSON.stringify([{target: 'S405'}])});
    });
    (globalThis as {fetch?: unknown}).fetch = receiverSensitiveFetch;
    try {
      const api = new BetaflightBuildApi();
      await expect(api.loadTargets()).resolves.toEqual([{target: 'S405'}]);
      expect(receiverSensitiveFetch).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as {fetch?: unknown}).fetch = original;
    }
  });

  it('explains a network rejection in Arabic and keeps the browser English out of the message', async () => {
    // A raw TypeError("Failed to fetch") is browser-internal English. An
    // Arabic operator learns nothing from it and it reads as an
    // untranslated defect, so the message states what happened and what
    // to do; the technical sentence goes to the console for developers.
    const fetcher = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = new BetaflightBuildApi(fetcher as unknown as typeof fetch);

    await expect(api.loadTargets()).rejects.toThrow(/تعذّر الوصول إلى خادم البناء/);
    await expect(api.loadTargets()).rejects.not.toThrow(/Failed to fetch/);
    expect(warn).toHaveBeenCalledWith(
      '[buildApi] network/CORS failure:',
      'Failed to fetch',
    );
    warn.mockRestore();
  });

  it('rethrows the caller\'s own abort untouched', async () => {
    // The flasher's unmount path aborts in-flight loads and checks
    // signal.aborted; wrapping an AbortError into a BuildApiError would
    // make cancellation read as a network failure.
    const abortError = Object.assign(new Error('Aborted'), {name: 'AbortError'});
    const fetcher = jest.fn(async () => {
      throw abortError;
    });
    const api = new BetaflightBuildApi(fetcher as unknown as typeof fetch);

    await expect(api.loadTargets()).rejects.toBe(abortError);
  });

  it('loads a bounded build log from the official origin for in-app display', async () => {
    const fetcher = jest.fn(async () => response({text: 'compile ok\nlink ok\n', length: '19'}));
    const api = new BetaflightBuildApi(fetcher as unknown as typeof fetch);

    await expect(api.loadBuildLog('build/key')).resolves.toBe('compile ok\nlink ok\n');
    expect((fetcher.mock.calls as unknown[][])[0][0]).toBe(
      'https://build.betaflight.com/api/builds/build%2Fkey/log',
    );
  });
});
