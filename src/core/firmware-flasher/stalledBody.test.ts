/**
 * THE STALLED BODY, THROUGH THE REAL API LAYERS.
 *
 * boundedBody.test.ts proves the primitive. This proves the two places
 * that actually reach the network on the operator's behalf USE it - that
 * `loadTargets()`, `loadFirmware()`, `loadBuildLog()` and the preset
 * repository all end in an Arabic sentence rather than a pending
 * Promise when a server answers `200 OK` and then stops sending bytes.
 *
 * That distinction matters because the previous round's fix was real and
 * still left this open: the header deadline was cleared the instant the
 * headers arrived, so everything after it ran with no clock.
 */

import {BetaflightBuildApi, BuildApiError} from './buildApi';
import {FirmwarePresetRepository} from '../../platforms/react-native/protocol/FirmwarePresetRepository';

/**
 * A response whose headers have arrived and whose body never will.
 * Both shapes are covered: a browser's stream, and React Native's
 * buffered `text()`.
 */
function stalledResponse(kind: 'stream' | 'buffered', contentLength = 4096) {
  const headers = {
    get: (name: string) =>
      name.toLowerCase() === 'content-length' ? String(contentLength) : null,
  };
  if (kind === 'buffered') {
    return {
      ok: true,
      status: 200,
      headers,
      body: null,
      text: () => new Promise<string>(() => undefined),
      arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
    } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    headers,
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => undefined),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
    text: () => new Promise<string>(() => undefined),
    arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
  } as unknown as Response;
}

/**
 * Drives real timers forward without waiting for them. Every call the
 * code under test makes is bounded, so pushing the clock past the
 * largest bound is enough to settle all of them.
 */
async function runClockPast(ms: number): Promise<void> {
  /* Microtasks FIRST: the fetch itself resolves on one, and advancing
     the clock before it lands would fire the HEADER deadline and prove
     the wrong thing. The point of these tests is that the BODY read is
     bounded, so the headers must genuinely arrive first. */
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Larger than every bound these layers arm, by construction. */
const PAST_EVERY_BOUND = 20 * 60 * 1000;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('the build API cannot hang on a body that stops arriving', () => {
  it.each([['stream'], ['buffered']] as const)(
    'loadTargets settles on a %s response whose body stalls',
    async kind => {
      const api = new BetaflightBuildApi(
        (async () => stalledResponse(kind)) as unknown as typeof fetch,
      );
      const attempt = api.loadTargets();
      // eslint-disable-next-line jest/valid-expect -- awaited below
      const expectation = expect(attempt).rejects.toBeInstanceOf(BuildApiError);
      await runClockPast(PAST_EVERY_BOUND);
      await expectation;
    },
  );

  it('loadFirmware settles rather than leaving the flasher on its load state', async () => {
    const api = new BetaflightBuildApi(
      (async () => stalledResponse('stream')) as unknown as typeof fetch,
    );
    const attempt = api.loadFirmware('/firmware/test.bin');
    // eslint-disable-next-line jest/valid-expect -- awaited below
    const expectation = expect(attempt).rejects.toBeInstanceOf(BuildApiError);
    await runClockPast(PAST_EVERY_BOUND);
    await expectation;
  });

  it('loadBuildLog settles too', async () => {
    const api = new BetaflightBuildApi(
      (async () => stalledResponse('buffered', 512)) as unknown as typeof fetch,
    );
    const attempt = api.loadBuildLog('build-1');
    // eslint-disable-next-line jest/valid-expect -- awaited below
    const expectation = expect(attempt).rejects.toBeInstanceOf(BuildApiError);
    await runClockPast(PAST_EVERY_BOUND);
    await expectation;
  });

  /**
   * The message the operator reads has to name the situation. An empty
   * failure is only marginally better than a spinner.
   */
  it('says the download stopped, in Arabic, with no internal code', async () => {
    const api = new BetaflightBuildApi(
      (async () => stalledResponse('stream')) as unknown as typeof fetch,
    );
    const attempt = api.loadTargets().catch((error: unknown) => error);
    await runClockPast(PAST_EVERY_BOUND);
    const error = (await attempt) as Error;
    expect(error.message).toContain('توقّف تنزيل البيانات');
    expect(error.message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });

  /**
   * THE CONTROL. A healthy response must not be affected by any of this.
   */
  it('leaves an ordinary response alone', async () => {
    const api = new BetaflightBuildApi(
      (async () =>
        ({
          ok: true,
          status: 200,
          headers: {get: () => null},
          body: null,
          text: async () => JSON.stringify([{target: 'S405'}]),
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as Response) as unknown as typeof fetch,
    );
    await expect(api.loadTargets()).resolves.toEqual([{target: 'S405'}]);
  });
});

describe('the preset repository cannot hang on a body that stops arriving', () => {
  it.each([['stream'], ['buffered']] as const)(
    'loadIndex settles on a %s response whose body stalls',
    async kind => {
      const repository = new FirmwarePresetRepository({
        fetcher: (async () => stalledResponse(kind)) as never,
      });
      const attempt = repository.loadIndex().catch((error: unknown) => error);
      await runClockPast(PAST_EVERY_BOUND);
      const error = (await attempt) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('توقّف تنزيل');
    },
  );

  it('leaves an ordinary preset index alone', async () => {
    const index = JSON.stringify({
      majorVersion: 1,
      minorVersion: 0,
      presets: [],
    });
    const repository = new FirmwarePresetRepository({
      fetcher: (async () => ({
        ok: true,
        status: 200,
        body: null,
        headers: {get: () => null},
        text: async () => index,
      })) as never,
    });
    await expect(repository.loadIndex()).resolves.toBeDefined();
  });
});
