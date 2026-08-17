import { MspPayloadReader } from './MspPayloadReader';

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
  const reader = new MspPayloadReader(payload, {lenient: true});
  const fixFlagRaw = reader.readU8();
  const satelliteCount = reader.readU8();
  const latitudeDegrees = signed32(reader.readU32LE()) / 10_000_000;
  const longitudeDegrees = signed32(reader.readU32LE()) / 10_000_000;
  const altitudeMeters = reader.readU16LE();
  const groundSpeedCentimetersPerSecond = reader.readU16LE();
  const groundCourseDecidegrees = reader.readU16LE();
  // Betaflight version-gates PDOP on API >= 1.46 and ignores anything else
  // that follows (src/js/msp/MSPHelper.js case MSP_RAW_GPS). A single odd
  // trailing byte is not a reason to refuse to show position and satellites.
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
