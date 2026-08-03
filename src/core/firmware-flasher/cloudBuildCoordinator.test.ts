import {CloudBuildCoordinator} from './cloudBuildCoordinator';

describe('CloudBuildCoordinator', () => {
  it('never overlaps status requests and downloads exactly once after success', async () => {
    let statusCalls = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const api = {
      requestBuild: jest.fn(async () => ({file: 'betaflight.hex', url: '/api/file.hex', key: 'build-key'})),
      requestBuildStatus: jest.fn(async () => {
        statusCalls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return statusCalls === 1 ? {status: 'queued'} : {status: 'success', configuration: ['# defaults', 'set foo = 1']};
      }),
      loadFirmware: jest.fn(async () => Uint8Array.of(1, 2, 3)),
    };
    const waited: number[] = [];
    const coordinator = new CloudBuildCoordinator(
      api as never,
      5000,
      async milliseconds => { waited.push(milliseconds); },
      () => 0,
    );
    const updates: string[] = [];
    const result = await coordinator.buildAndDownload(
      {target: 'S405', release: '4.6.0', options: ['CORE_BUILD']},
      update => updates.push(update.phase),
    );
    expect(maximumInFlight).toBe(1);
    expect(api.requestBuildStatus).toHaveBeenCalledTimes(2);
    expect(api.loadFirmware).toHaveBeenCalledTimes(1);
    expect(waited).toEqual([5000]);
    expect(result.configuration).toEqual(['# defaults', 'set foo = 1']);
    expect(updates).toEqual(['requesting', 'queued', 'downloading', 'complete']);
  });

  it('cancels while waiting without issuing another status request', async () => {
    const controller = new AbortController();
    const api = {
      requestBuild: jest.fn(async () => ({file: 'fw.hex', url: '/fw.hex', key: 'k'})),
      requestBuildStatus: jest.fn(async () => ({status: 'queued'})),
      loadFirmware: jest.fn(),
    };
    const coordinator = new CloudBuildCoordinator(
      api as never,
      5000,
      async () => {
        controller.abort();
        throw new Error('أُلغيَ بناء Firmware.');
      },
      () => 0,
    );
    await expect(coordinator.buildAndDownload(
      {target: 'S405', release: '4.6.0', options: ['CORE_BUILD']},
      undefined,
      controller.signal,
    )).rejects.toThrow(/أُلغي/);
    expect(api.requestBuildStatus).toHaveBeenCalledTimes(1);
    expect(api.loadFirmware).not.toHaveBeenCalled();
  });

  it('starts a fresh server timeout when a long-queued build begins processing', async () => {
    let currentTime = 0;
    const api = {
      requestBuild: jest.fn(async () => ({file: 'fw.hex', url: '/fw.hex', key: 'k'})),
      requestBuildStatus: jest.fn()
        .mockResolvedValueOnce({status: 'queued'})
        .mockResolvedValueOnce({status: 'queued', timeOut: 10})
        .mockResolvedValueOnce({status: 'success'}),
      loadFirmware: jest.fn(async () => Uint8Array.of(1)),
    };
    const waits = [119_000, 9_000];
    const coordinator = new CloudBuildCoordinator(
      api as never,
      5000,
      async () => { currentTime += waits.shift() ?? 0; },
      () => currentTime,
    );

    await expect(coordinator.buildAndDownload({
      target: 'S405', release: '4.6.0', options: ['CORE_BUILD'],
    })).resolves.toMatchObject({firmware: Uint8Array.of(1)});
    expect(api.requestBuildStatus).toHaveBeenCalledTimes(3);
  });

  it('retries a direct firmware download only once', async () => {
    const api = {
      requestBuild: jest.fn(async () => ({file: 'fw.bin', url: '/fw.bin'})),
      requestBuildStatus: jest.fn(),
      loadFirmware: jest.fn()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce(Uint8Array.of(9)),
    };
    const coordinator = new CloudBuildCoordinator(api as never, 1, async () => undefined);
    await expect(coordinator.buildAndDownload({
      target: 'ESP32', release: '4.6.0', options: ['CORE_BUILD'],
    })).resolves.toMatchObject({firmware: Uint8Array.of(9)});
    expect(api.loadFirmware).toHaveBeenCalledTimes(2);
  });
});
