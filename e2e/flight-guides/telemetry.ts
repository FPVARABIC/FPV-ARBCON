/** Simulated guide data only. This module is never in the product bundle. */
export function useTelemetryValue<T>(_session: string, poll: string): unknown {
  const q = new URLSearchParams(window.location.search);
  if (q.get('screen') !== 'power' || !poll.toLowerCase().includes('battery')) return {status: 'UNAVAILABLE'};
  return {status: 'FRESH', ageMs: 0, receivedAtMs: 0, sampleSeq: 1, value: {
    cellCount: Number(q.get('cells')), voltageCentivolts: Number(q.get('voltage')),
    amperageCentiamps: 0, consumedMah: 0, configuredCapacityMah: Number(q.get('capacity')),
    batteryState: 0,
  } as T};
}
