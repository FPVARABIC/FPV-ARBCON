import type {CarriesOperatorMessage, OperatorMessage} from './operatorMessage';
import type {FirmwareImage} from './firmwareFile';
import type {IntelHexImage, IntelHexSegment} from './intelHex';

const CUSTOM_DEFAULTS_POINTER_ADDRESS = 0x08002800;
const CUSTOM_DEFAULTS_HEADER = '# Betaflight\n';
export const MAX_UNIFIED_CONFIG_BYTES = 256 * 1024;

export class CustomDefaultsError extends Error implements Partial<CarriesOperatorMessage> {
  /** See IntelHexError: `message` is diagnostics, this is the operator line. */
  readonly operatorMessage?: OperatorMessage;

  constructor(message: string, operatorMessage?: OperatorMessage) {
    super(message);
    this.name = 'CustomDefaultsError';
    this.operatorMessage = operatorMessage;
  }
}

/** Mirrors Betaflight's unified-config cleaner while bounding untrusted input. */
export function parseUnifiedConfigText(source: string): readonly string[] {
  if (source.length === 0 || source.length > MAX_UNIFIED_CONFIG_BYTES) {
    throw new CustomDefaultsError("Unified Config is leeg of overschrijdt de beveiligde limiet 256 KiB.", {key: 'customDefaults.e01'});
  }
  const output: string[] = [];
  let inComment = false;
  const clean = source.replace(/^\uFEFF/, '');
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (character === '\n' || character === '\r') inComment = false;
    if (character === '#') inComment = true;
    const codePoint = clean.codePointAt(index) ?? 0;
    if (codePoint > 255 && !inComment) {
      throw new CustomDefaultsError("Unified Config bevat een ongeldig karakter buiten de opmerkingen.", {key: 'customDefaults.e02'});
    }
    output.push(codePoint > 255 ? '_' : character);
  }
  const lines = output.join('').replace(/\r/g, '').split('\n');
  if (!lines.some(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))) {
    throw new CustomDefaultsError("Unified Config bevat geen installeerbare oplossingen.", {key: 'customDefaults.e03'});
  }
  return lines;
}

export function normalizeConfigurationLines(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 4096) {
    throw new CustomDefaultsError("De Target-instellingenlijst van de server is niet geldig.", {key: 'customDefaults.e04'});
  }
  if (value.length === 0) return undefined;
  if (!value.every(line => typeof line === 'string')) {
    throw new CustomDefaultsError("De Target-instellingenlijst bevat een niet-tekstwaarde.", {key: 'customDefaults.e05'});
  }
  return parseUnifiedConfigText((value as string[]).join('\n'));
}

function byteAt(image: IntelHexImage, address: number): number | undefined {
  const segment = image.segments.find(item => address >= item.address && address < item.address + item.data.length);
  return segment?.data[address - segment.address];
}

function readU32LE(image: IntelHexImage, address: number): number | undefined {
  const bytes = [0, 1, 2, 3].map(offset => byteAt(image, address + offset));
  if (bytes.some(byte => byte === undefined)) return undefined;
  return (
    (bytes[0] as number) +
    (bytes[1] as number) * 0x100 +
    (bytes[2] as number) * 0x10000 +
    (bytes[3] as number) * 0x1000000
  ) >>> 0;
}

function mergeSegments(segments: readonly IntelHexSegment[]): readonly IntelHexSegment[] {
  const ordered = [...segments].sort((left, right) => left.address - right.address);
  const merged: IntelHexSegment[] = [];
  for (const segment of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && segment.address < previous.address + previous.data.length) {
      throw new CustomDefaultsError("Custom Defaults gebied overlapt met Firmware. data.", {key: 'customDefaults.e06'});
    }
    if (previous && segment.address === previous.address + previous.data.length) {
      const data = new Uint8Array(previous.data.length + segment.data.length);
      data.set(previous.data);
      data.set(segment.data, previous.data.length);
      merged[merged.length - 1] = {address: previous.address, data};
    } else {
      merged.push({address: segment.address, data: segment.data.slice()});
    }
  }
  return merged;
}

function configBytes(lines: readonly string[]): Uint8Array {
  const normalized = parseUnifiedConfigText(lines.join('\n'));
  const text = `${CUSTOM_DEFAULTS_HEADER}${normalized.join('\n')}\0`;
  if (text.length > MAX_UNIFIED_CONFIG_BYTES) {
    throw new CustomDefaultsError("Custom Defaults overschrijdt de veiligheidsgrens 256 KiB.", {key: 'customDefaults.e07'});
  }
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

export function insertCustomDefaults(image: IntelHexImage, lines: readonly string[]): IntelHexImage {
  const startAddress = readU32LE(image, CUSTOM_DEFAULTS_POINTER_ADDRESS);
  const endAddress = readU32LE(image, CUSTOM_DEFAULTS_POINTER_ADDRESS + 4);
  if (startAddress === undefined || endAddress === undefined || endAddress <= startAddress) {
    throw new CustomDefaultsError("De Firmware specifiek verklaart niet dat de Custom Defaults zone geldig is.", {key: 'customDefaults.e08'});
  }
  const payload = configBytes(lines);
  if (payload.length >= endAddress - startAddress) {
    throw new CustomDefaultsError("Het Custom Defaults gebied in Firmware is kleiner dan de gekozen instellingen.", {key: 'customDefaults.e09'});
  }
  const segments = mergeSegments([...image.segments, {address: startAddress, data: payload}]);
  const totalBytes = segments.reduce((sum, segment) => sum + segment.data.length, 0);
  const final = segments[segments.length - 1];
  return {
    segments,
    totalBytes,
    lowestAddress: segments[0].address,
    highestAddressExclusive: final.address + final.data.length,
    ...(image.entryPoint === undefined ? {} : {entryPoint: image.entryPoint}),
  };
}

function record(address: number, type: number, data: Uint8Array): string {
  const bytes = [data.length, (address >>> 8) & 0xff, address & 0xff, type, ...data];
  const checksum = (-bytes.reduce((sum, byte) => sum + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function serializeIntelHex(image: IntelHexImage): Uint8Array {
  const lines: string[] = [];
  let activeUpper = -1;
  for (const segment of image.segments) {
    let offset = 0;
    while (offset < segment.data.length) {
      const absolute = segment.address + offset;
      const upper = Math.floor(absolute / 0x10000);
      if (upper !== activeUpper) {
        lines.push(record(0, 0x04, Uint8Array.of((upper >>> 8) & 0xff, upper & 0xff)));
        activeUpper = upper;
      }
      const relative = absolute & 0xffff;
      const length = Math.min(16, segment.data.length - offset, 0x10000 - relative);
      lines.push(record(relative, 0x00, segment.data.slice(offset, offset + length)));
      offset += length;
    }
  }
  if (image.entryPoint !== undefined) {
    lines.push(record(0, 0x05, Uint8Array.of(
      image.entryPoint >>> 24,
      image.entryPoint >>> 16,
      image.entryPoint >>> 8,
      image.entryPoint,
    )));
  }
  lines.push(':00000001FF');
  const text = `${lines.join('\n')}\n`;
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

export function applyCustomDefaultsToFirmware(
  firmware: Extract<FirmwareImage, {kind: 'HEX'}>,
  lines: readonly string[],
): Extract<FirmwareImage, {kind: 'HEX'}> {
  const hex = insertCustomDefaults(firmware.hex, lines);
  return {...firmware, hex, bytes: serializeIntelHex(hex)};
}
