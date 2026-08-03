import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

/** Full GPS-tab-only decode. The compact Setup decoder intentionally stays coordinate-free. */
export interface MspDetailedGps {
  readonly hasFix: boolean;
  readonly fixFlagRaw: number;
  readonly satelliteCount: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeMeters: number;
  readonly groundSpeedCentimetersPerSecond: number;
  readonly groundCourseDecidegrees: number;
  /** Hundredths, when emitted by API >= 1.44. */
  readonly pdopHundredths?: number;
}

function signed32(value: number): number {
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

export function decodeDetailedGps(payload: Uint8Array): MspDetailedGps {
  const reader = new MspPayloadReader(payload);
  const fixFlagRaw = reader.readU8();
  const satelliteCount = reader.readU8();
  const latitudeDegrees = signed32(reader.readU32LE()) / 10_000_000;
  const longitudeDegrees = signed32(reader.readU32LE()) / 10_000_000;
  const altitudeMeters = reader.readU16LE();
  const groundSpeedCentimetersPerSecond = reader.readU16LE();
  const groundCourseDecidegrees = reader.readU16LE();
  if (reader.remaining() === 1) {
    throw new MspPayloadReadError(
      'MSP_RAW_GPS contains a truncated PDOP field.',
    );
  }
  const pdopHundredths =
    reader.remaining() >= 2 ? reader.readU16LE() : undefined;
  return Object.freeze({
    hasFix: fixFlagRaw !== 0,
    fixFlagRaw,
    satelliteCount,
    latitudeDegrees,
    longitudeDegrees,
    altitudeMeters,
    groundSpeedCentimetersPerSecond,
    groundCourseDecidegrees,
    pdopHundredths,
  });
}
