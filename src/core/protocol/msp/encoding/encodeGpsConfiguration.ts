import type { MspGpsConfiguration } from '../decoding/decodeGpsConfiguration';

export function encodeGpsConfiguration(
  config: MspGpsConfiguration,
): Uint8Array {
  for (const value of [config.provider, config.sbasMode]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new RangeError('GPS configuration contains a non-u8 value.');
  }
  return Uint8Array.from([
    config.provider,
    config.sbasMode,
    config.autoConfig ? 1 : 0,
    config.autoBaud ? 1 : 0,
    config.homePointOnce ? 1 : 0,
    config.useGalileo ? 1 : 0,
  ]);
}
