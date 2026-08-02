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
});
