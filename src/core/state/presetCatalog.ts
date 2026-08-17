/* eslint-disable no-bitwise -- SHA-256 is defined in 32-bit bitwise operations. */

export type FirmwarePresetStatus = 'OFFICIAL' | 'COMMUNITY' | 'EXPERIMENTAL';
export type FirmwarePresetCategory =
  | 'TUNE'
  | 'RATES'
  | 'OSD'
  | 'VTX'
  | 'LEDS'
  | 'MODES'
  | 'FILTERS'
  | 'RC_LINK'
  | 'BNF'
  | 'OTHER';

export interface FirmwarePresetSummary {
  readonly fullPath: string;
  readonly hash: string;
  readonly title: string;
  readonly firmwareVersions: readonly string[];
  readonly category: FirmwarePresetCategory;
  readonly status: FirmwarePresetStatus;
  /** The catalogue's own words when they are not one of ours. */
  readonly rawCategory: string;
  readonly rawStatus: string;
  readonly keywords: readonly string[];
  readonly author?: string;
  readonly forceOptionsReview: boolean;
  readonly priority: number;
}

export interface FirmwarePresetIndex {
  readonly majorVersion: 1;
  readonly minorVersion: number;
  readonly presets: readonly FirmwarePresetSummary[];
  /**
   * Entries the catalogue offered that we refused to make downloadable - an
   * unsafe path or a malformed hash. Reported so the screen can say so
   * instead of quietly showing a shorter list.
   */
  readonly rejectedCount: number;
}

export interface FirmwarePresetOption {
  readonly name: string;
  readonly checkedByDefault: boolean;
  readonly group?: string;
  readonly exclusive: boolean;
}

export interface FirmwarePresetDocument {
  readonly lines: readonly string[];
  readonly descriptions: readonly string[];
  readonly warning?: string;
  readonly disclaimer?: string;
  readonly discussion?: string;
  readonly includeWarnings: readonly string[];
  readonly includeDisclaimers: readonly string[];
  readonly options: readonly FirmwarePresetOption[];
}

const CATEGORY = new Set<FirmwarePresetCategory>([
  'TUNE',
  'RATES',
  'OSD',
  'VTX',
  'LEDS',
  'MODES',
  'FILTERS',
  'RC_LINK',
  'BNF',
  'OTHER',
]);
const STATUS = new Set<FirmwarePresetStatus>([
  'OFFICIAL',
  'COMMUNITY',
  'EXPERIMENTAL',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^presets\/[A-Za-z0-9._/-]+\.txt$/;
const MAX_INDEX_PRESETS = 10_000;
const MAX_PRESET_LINES = 10_000;
const MAX_INCLUDE_DEPTH = 8;
const MAX_INCLUDED_FILES = 64;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('فهرس Presets ليس كائن JSON صالحًا.');
  }
  return value as Record<string, unknown>;
}



export function isSafePresetPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes('..') && !path.includes('//');
}

/** Descriptive text we will show but never act on. Missing is not fatal. */
function optionalStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
}

/**
 * ONE UNKNOWN WORD MUST NOT EMPTY THE CATALOGUE.
 *
 * This index is remote data maintained on Betaflight's own schedule, and the
 * pinned Configurator validates none of it: PresetsRepoIndexed.loadIndex is
 * `res.json()` straight into `this._index`, and the search filters simply read
 * whatever fields happen to be there. The moment a new category or status word
 * appears upstream - which is a normal catalogue edit, not a breaking change -
 * a build that rejected the whole document would show an empty Presets screen
 * with no way for the operator to tell why.
 *
 * So the taxonomy fails OPEN: an unrecognized category or status is preserved
 * verbatim in rawCategory/rawStatus and mapped to a safe typed value for the
 * filter chips. Security fails CLOSED and is unchanged: an entry whose path is
 * unsafe or whose hash is malformed is DROPPED, because those two fields are
 * what decide which file we will download and turn into CLI commands. A
 * dropped entry is counted, never silently swallowed.
 */
export function parseFirmwarePresetIndex(value: unknown): FirmwarePresetIndex {
  const root = record(value);
  if (
    root.majorVersion !== 1 ||
    !Number.isInteger(root.minorVersion) ||
    (root.minorVersion as number) < 0
  ) {
    throw new Error('إصدار فهرس Presets غير مدعوم.');
  }
  if (!Array.isArray(root.presets) || root.presets.length > MAX_INDEX_PRESETS) {
    throw new Error('قائمة Presets مفقودة أو أكبر من الحد الآمن.');
  }
  let rejectedCount = 0;
  const presets: FirmwarePresetSummary[] = [];
  for (const item of root.presets) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      rejectedCount += 1;
      continue;
    }
    const source = item as Record<string, unknown>;
    const fullPath = typeof source.fullPath === 'string' ? source.fullPath : '';
    const hash =
      typeof source.hash === 'string' ? source.hash.toLowerCase() : '';
    // FAIL CLOSED: these two decide what we download and execute.
    if (!isSafePresetPath(fullPath) || !SHA256.test(hash)) {
      rejectedCount += 1;
      continue;
    }
    const rawCategory =
      typeof source.category === 'string' ? source.category.trim() : '';
    const rawStatus =
      typeof source.status === 'string' ? source.status.trim() : '';
    const category = rawCategory.toUpperCase() as FirmwarePresetCategory;
    const status = rawStatus.toUpperCase() as FirmwarePresetStatus;
    const title =
      typeof source.title === 'string' && source.title.trim()
        ? source.title
        : fullPath.split('/').pop() ?? fullPath;
    presets.push(
      Object.freeze({
        fullPath,
        hash,
        title,
        firmwareVersions: Object.freeze(
          optionalStrings(source.firmware_version),
        ),
        // An unrecognized category lands in OTHER so the chips still work;
        // an unrecognized status is treated as COMMUNITY, the cautious
        // reading - never OFFICIAL, which would overstate its provenance.
        category: CATEGORY.has(category) ? category : 'OTHER',
        status: STATUS.has(status) ? status : 'COMMUNITY',
        rawCategory,
        rawStatus,
        keywords: Object.freeze(optionalStrings(source.keywords)),
        author:
          typeof source.author === 'string' && source.author.trim()
            ? source.author
            : undefined,
        forceOptionsReview: source.force_options_review === true,
        priority:
          typeof source.priority === 'number' &&
          Number.isFinite(source.priority)
            ? source.priority
            : 0,
      }),
    );
  }
  return Object.freeze({
    majorVersion: 1,
    minorVersion: root.minorVersion as number,
    presets: Object.freeze(presets),
    rejectedCount,
  });
}

export function presetFirmwareFamily(
  versionString: string,
): string | undefined {
  const match = /^(\d{1,4})\.(\d{1,2})(?:\.|$)/.exec(versionString.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

/**
 * Does this catalogue entry claim to fit the firmware the board reported?
 *
 * Betaflight's rule is a PREFIX match against the whole reported version
 * string - `currentVersion.startsWith(bfVersion)` in presets.preselectFilterFields
 * - not an equality test on a derived major.minor. Requiring equality on the
 * family hid every catalogue entry that lists a patch-level version: an entry
 * for "4.5.0" simply never appeared on a board running 4.5.0, because "4.5.0"
 * is not equal to the family "4.5".
 */
function presetFitsFirmware(listed: string, firmwareVersion: string): boolean {
  const version = firmwareVersion.trim();
  const wanted = listed.trim();
  if (wanted === '') return false;
  if (version.startsWith(wanted)) return true;
  // ...and the reverse, so an entry listing "4.5" still matches a board that
  // reports only "4.5", and a family-level entry matches a family-level read.
  const family = presetFirmwareFamily(version);
  return family !== undefined && family === presetFirmwareFamily(wanted);
}

export function filterCompatiblePresets(
  index: FirmwarePresetIndex,
  firmwareVersion: string,
): readonly FirmwarePresetSummary[] {
  return index.presets
    .filter(preset =>
      preset.firmwareVersions.some(listed =>
        presetFitsFirmware(listed, firmwareVersion),
      ),
    )
    .sort(
      (left, right) =>
        right.priority - left.priority || left.title.localeCompare(right.title),
    );
}

/**
 * Betaflight does not hardcode these words. PresetsRepoIndexed.loadIndex sets
 * `this._settings = this._index.settings` and hands them to PresetParser, so
 * the directive vocabulary is data the catalogue itself ships - meaning it is
 * expected to vary. Accepting both the underscored and the spaced spelling
 * removes the single point of failure a hardcoded guess would be: if the
 * catalogue ever writes the other one, exclusive groups would otherwise stop
 * being recognized and the screen would let an operator tick two mutually
 * exclusive tunes and send both.
 */
const GROUP_BEGIN = /^OPTION[_ ]GROUP BEGIN\s*(?:\(EXCLUSIVE\))?/i;
const GROUP_END = /^OPTION[_ ]GROUP END$/i;

function metadata(line: string): { key: string; value: string } | undefined {
  const match = /^#\$\s*([^:]+?)(?::\s*(.*))?$/i.exec(line.trim());
  if (!match) return undefined;
  return { key: match[1].trim().toUpperCase(), value: (match[2] ?? '').trim() };
}

export function parseFirmwarePresetDocument(
  text: string,
): FirmwarePresetDocument {
  if (text.length > 1024 * 1024)
    throw new Error('ملف Preset أكبر من الحد الآمن.');
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > MAX_PRESET_LINES)
    throw new Error('ملف Preset يحتوي أسطرًا أكثر من الحد الآمن.');
  const descriptions: string[] = [];
  const includeWarnings: string[] = [];
  const includeDisclaimers: string[] = [];
  const options: FirmwarePresetOption[] = [];
  let warning: string | undefined;
  let disclaimer: string | undefined;
  let discussion: string | undefined;
  let group: { name: string; exclusive: boolean } | undefined;
  for (const line of lines) {
    const item = metadata(line);
    if (!item) continue;
    if (item.key === 'DESCRIPTION') descriptions.push(item.value);
    else if (item.key === 'WARNING') warning = item.value;
    else if (item.key === 'DISCLAIMER') disclaimer = item.value;
    else if (item.key === 'DISCUSSION') discussion = item.value;
    else if (item.key === 'INCLUDE_WARNING' && isSafePresetPath(item.value))
      includeWarnings.push(item.value);
    else if (item.key === 'INCLUDE_DISCLAIMER' && isSafePresetPath(item.value))
      includeDisclaimers.push(item.value);
    else if (GROUP_BEGIN.test(item.key)) {
      const exclusive = /\(EXCLUSIVE\)/i.test(`${item.key} ${item.value}`);
      group = {
        name: (item.value || item.key.replace(GROUP_BEGIN, '').trim())
          .replace(/\(EXCLUSIVE\)/i, '')
          .trim(),
        exclusive,
      };
    } else if (GROUP_END.test(item.key)) {
      group = undefined;
    } else if (item.key.startsWith('OPTION BEGIN')) {
      const checked = /\(CHECKED\)/i.test(item.key);
      const unchecked = /\(UNCHECKED\)/i.test(item.key);
      const name =
        item.value ||
        item.key.replace(/^OPTION BEGIN\s*(?:\((?:UN)?CHECKED\))?/i, '').trim();
      if (!name || (!checked && !unchecked))
        throw new Error('تعريف خيار Preset غير صالح.');
      options.push(
        Object.freeze({
          name,
          checkedByDefault: checked,
          group: group?.name,
          exclusive: group?.exclusive ?? false,
        }),
      );
    }
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    descriptions: Object.freeze(descriptions),
    warning,
    disclaimer,
    discussion,
    includeWarnings: Object.freeze(includeWarnings),
    includeDisclaimers: Object.freeze(includeDisclaimers),
    options: Object.freeze(options),
  });
}

function includePath(line: string): string | undefined {
  const match = /^#\$\s*INCLUDE:\s*(\S+)\s*$/i.exec(line.trim());
  return match?.[1];
}

export async function expandFirmwarePresetIncludes(
  lines: readonly string[],
  load: (path: string) => Promise<string>,
  depth = 0,
  visited = new Set<string>(),
): Promise<readonly string[]> {
  if (depth > MAX_INCLUDE_DEPTH)
    throw new Error('تداخل INCLUDE في Preset أعمق من الحد الآمن.');
  const result: string[] = [];
  for (const line of lines) {
    const path = includePath(line);
    if (path === undefined) {
      result.push(line);
      continue;
    }
    if (!isSafePresetPath(path))
      throw new Error(`مسار INCLUDE غير آمن: ${path}`);
    if (visited.has(path)) throw new Error(`حلقة INCLUDE مكتشفة: ${path}`);
    if (visited.size >= MAX_INCLUDED_FILES)
      throw new Error('عدد ملفات INCLUDE أكبر من الحد الآمن.');
    visited.add(path);
    const nested = parseFirmwarePresetDocument(await load(path));
    result.push(
      ...(await expandFirmwarePresetIncludes(
        nested.lines,
        load,
        depth + 1,
        visited,
      )),
    );
    visited.delete(path);
  }
  return Object.freeze(result);
}

/**
 * Which CLI lines does this preset contribute, given the options the operator
 * actually ticked?
 *
 * The comparison is CASE-INSENSITIVE because Betaflight's is: PresetParser
 * .removeUncheckedOptions lowercases both the checked-option list and the name
 * it reads out of each `OPTION BEGIN` line. Comparing exactly meant a preset
 * that wrote its option name in one case in the group header and another in
 * the body silently sent the wrong set of commands - either dropping lines the
 * operator had approved, or including lines they had unticked. On a screen
 * whose whole output is CLI commands written to a flight controller, either
 * direction is unacceptable, and neither was visible to the operator.
 */
export function commandsForPreset(
  lines: readonly string[],
  selectedOptions: ReadonlySet<string>,
): readonly string[] {
  const selected = new Set(
    [...selectedOptions].map(name => name.trim().toLowerCase()),
  );
  const result: string[] = [];
  let include = true;
  for (const raw of lines) {
    const item = metadata(raw);
    if (item?.key.startsWith('OPTION BEGIN')) {
      const name =
        item.value ||
        item.key.replace(/^OPTION BEGIN\s*(?:\((?:UN)?CHECKED\))?/i, '').trim();
      include = selected.has(name.trim().toLowerCase());
      continue;
    }
    if (item?.key === 'OPTION END') {
      include = true;
      continue;
    }
    if (item !== undefined || !include) continue;
    const line = raw.trim();
    // `save` and `exit` are withheld deliberately, and this is the one place
    // we do not follow Betaflight: it forwards whatever the file contains and
    // then issues its own `save` afterwards. A stray `exit` inside a preset
    // would close the CLI session mid-batch and send every remaining command
    // into a closed channel, with the operator told the batch had been
    // applied. Both commands are issued by this app explicitly, after the
    // batch, under the operator's own confirmation.
    if (line && !line.startsWith('#') && !/^(?:save|exit)\b/i.test(line))
      result.push(line);
  }
  return Object.freeze(result);
}

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Small dependency-free SHA-256 used identically by Hermes and browsers. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1)
      w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rightRotate(w[i - 15], 7) ^
        rightRotate(w[i - 15], 18) ^
        (w[i - 15] >>> 3);
      const s1 =
        rightRotate(w[i - 2], 17) ^
        rightRotate(w[i - 2], 19) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(value => value.toString(16).padStart(8, '0')).join('');
}
