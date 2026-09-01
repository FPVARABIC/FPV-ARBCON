import { MspPayloadReader } from './MspPayloadReader';

export const GPS_SATELLITE_MAX_COUNT = 64;

export type GpsConstellation =
  | 'GPS'
  | 'SBAS'
  | 'GALILEO'
  | 'BEIDOU'
  | 'IMES'
  | 'QZSS'
  | 'GLONASS'
  | 'UNKNOWN'
  | 'LEGACY';

export interface MspGpsSatellite {
  readonly channelOrGnssId: number;
  readonly satelliteId: number;
  readonly qualityRaw: number;
  readonly quality: number;
  readonly used: boolean;
  readonly signalToNoiseDbHz: number;
  readonly constellation: GpsConstellation;
}

export interface MspGpsSatelliteInfo {
  readonly satellites: readonly MspGpsSatellite[];
  readonly usesGnssIdentifiers: boolean;
}

const GNSS: readonly GpsConstellation[] = [
  'GPS',
  'SBAS',
  'GALILEO',
  'BEIDOU',
  'IMES',
  'QZSS',
  'GLONASS',
];

export function decodeGpsSatelliteInfo(
  payload: Uint8Array,
): MspGpsSatelliteInfo {
  const reader = new MspPayloadReader(payload, {lenient: true});
  const declared = reader.readU8();
  // The cap still bounds how much we will allocate for a declared count, but
  // it CLAMPS rather than rejects: a satellite list is read-only telemetry,
  // and neither an implausible count nor a short payload is a reason to close
  // the GPS screen over the satellites that did arrive.
  const count = Math.min(
    declared,
    GPS_SATELLITE_MAX_COUNT,
    Math.floor(reader.remaining() / 4),
  );
  // Betaflight Configurator uses the first byte as GNSS id only in the
  // extended (>16 entries) representation. Smaller legacy lists keep an
  // opaque channel number; labelling them as GPS would fabricate truth.
  const usesGnssIdentifiers = count > 16;
  const satellites: MspGpsSatellite[] = [];
  for (let index = 0; index < count; index += 1) {
    const channelOrGnssId = reader.readU8();
    const satelliteId = reader.readU8();
    const qualityRaw = reader.readU8();
    const signalToNoiseDbHz = reader.readU8();
    satellites.push(
      Object.freeze({
        channelOrGnssId,
        satelliteId,
        qualityRaw,
        // eslint-disable-next-line no-bitwise -- Betaflight packs used + quality in one byte.
        quality: qualityRaw & 0x07,
        // eslint-disable-next-line no-bitwise -- Betaflight packs used in bit 3.
        used: (qualityRaw & 0x08) !== 0,
        signalToNoiseDbHz,
        constellation: usesGnssIdentifiers
          ? GNSS[channelOrGnssId] ?? 'UNKNOWN'
          : 'LEGACY',
      }),
    );
  }
  return Object.freeze({
    satellites: Object.freeze(satellites),
    usesGnssIdentifiers,
  });
}
