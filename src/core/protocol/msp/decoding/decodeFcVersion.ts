import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 1C-P2 - wire decoder for MSP_FC_VERSION (3), the flight
 * controller's own FIRMWARE version. Verified against
 * src/main/msp/msp.c:642-647 @ BETAFLIGHT_2025_12_2_COMMIT
 * (79065c96ba0bb5cdc675e67d7093e05dab8b330e), quoted verbatim:
 *
 *     case MSP_FC_VERSION:
 *         sbufWriteU8(dst, (uint8_t)(FC_VERSION_YEAR - FC_CALVER_BASE_YEAR)); // year since 2000
 *         sbufWriteU8(dst, FC_VERSION_MONTH);
 *         sbufWriteU8(dst, FC_VERSION_PATCH_LEVEL);
 *         sbufWritePString(dst, FC_VERSION_STRING);
 *         break;
 *
 * and src/main/common/streambuf.c:86-91, also verbatim:
 *
 *     void sbufWritePString(sbuf_t *dst, const char *string)
 *     {
 *         const int length = MIN((int)strlen(string), 255);
 *         sbufWriteU8(dst, length);
 *         sbufWriteData(dst, string, length);
 *     }
 *
 * Payload layout:
 *   offset 0  u8   year offset from FC_CALVER_BASE_YEAR (2000)
 *   offset 1  u8   month
 *   offset 2  u8   patch level
 *   offset 3  u8   version-string byte length (Pascal prefix)
 *   offset 4  ..   exactly that many version-string bytes
 *
 * FIRMWARE VERSION IS NOT MSP API VERSION AND NOT FIRMWARE VARIANT. The
 * MSP API version (1.47) is reported identically by every 2025.12.x
 * release, and the variant ("BTFL") names the project, not the build.
 * This command is the only thing that distinguishes 2025.12.2 from
 * 2025.12.5.
 *
 * THE SUFFIX CONTRACT, read from src/main/build/version.h:36-54 @ the
 * pinned commit:
 *
 *     // Optional suffix for pre-releases (alpha, beta, rc1, etc).
 *     // Use empty value (not "") for final releases
 *     #define FC_VERSION_SUFFIX
 *     ...
 *     #if FC_PP_IS_EMPTY_SIMPLE(FC_VERSION_SUFFIX)
 *     # define FC_VERSION_SUFFIX_STR ""
 *     #else
 *     # define FC_VERSION_SUFFIX_STR "-" FC_VERSION_SUFFIX
 *     #endif
 *     #define FC_VERSION_STRING STR(FC_VERSION_YEAR) "." STR(FC_VERSION_MONTH) "." \
 *                               STR(FC_VERSION_PATCH_LEVEL) FC_VERSION_SUFFIX_STR
 *
 * So a build is either `<year>.<month>.<patch>` (final release - the
 * pinned tag defines FC_VERSION_SUFFIX empty) or that base followed by a
 * single '-' and a non-empty suffix token. The firmware does NOT
 * enumerate which suffixes are legal ("alpha, beta, rc1, etc" is an
 * illustrative comment, not a list), so this decoder imposes only the
 * STRUCTURAL rule the source actually establishes: one '-' delimiter, a
 * non-empty remainder, printable ASCII, no whitespace. Inventing a
 * closed list of accepted suffix names would reject legitimate builds
 * the firmware can genuinely produce.
 *
 * THIS DECODER TAKES NO POSITION ON WHICH VERSION IS ACCEPTABLE. A
 * coherent 2025.12.5 and a coherent 2025.12.2-RC1 both decode
 * successfully. Deciding scope belongs to a later, separate gate, which
 * will compare the full exact text - so a suffixed pre-release will be
 * rejected there, not here. Building an "only 2025.12.2" rule into a
 * generic protocol decoder would make unrelated firmware look like a
 * malformed frame.
 *
 * BOTH REPRESENTATIONS ARE KEPT. The numeric tuple and the exact received
 * text are cross-checked against each other and then BOTH retained.
 *
 * FAIL-CLOSED ON TRAILING BYTES - deliberately different from this
 * project's other decoders. Elsewhere (decodeBoardInfo, decodeStatusEx)
 * trailing bytes are permitted and ignored, because those responses grew
 * optional fields across releases. MSP_FC_VERSION is SELF-DELIMITING -
 * the Pascal length states exactly where the payload ends - so a byte
 * after the string is not a newer field, it is evidence the frame is not
 * what this decoder thinks it is.
 */

/** src/main/build/version.h:28 @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define FC_CALVER_BASE_YEAR 2000`. The wire carries the offset; the
 * full year is reconstructed from it, never guessed. */
export const FC_VERSION_CALVER_BASE_YEAR = 2000;

/** src/main/build/version.h:76 @ BETAFLIGHT_2025_12_2_COMMIT enforces
 * `FC_VERSION_MONTH >= 1 && FC_VERSION_MONTH <= 12` with a STATIC_ASSERT,
 * so any other month is a malformed response, not newer firmware. */
export const FC_VERSION_MIN_MONTH = 1;
export const FC_VERSION_MAX_MONTH = 12;

/** version.h:50 - the one delimiter the firmware places between the
 * numeric base and a non-empty suffix. */
export const FC_VERSION_SUFFIX_DELIMITER = '-';

/** Fixed bytes preceding the version string: year offset, month, patch
 * and the Pascal length prefix. */
export const MSP_FC_VERSION_FIXED_BYTES = 4;

export interface MspFcVersion {
  /** u8 exactly as sent - the offset from FC_CALVER_BASE_YEAR. Kept raw
   * so an audit can reproduce the wire bytes from the decoded model. */
  readonly yearOffsetRaw: number;
  /** FC_VERSION_CALVER_BASE_YEAR + yearOffsetRaw. */
  readonly year: number;
  readonly month: number;
  readonly patch: number;
  /** The version text EXACTLY as received, suffix included - never
   * trimmed, case-folded, normalised, stripped or repaired. */
  readonly versionString: string;
  /** The suffix WITHOUT its '-' delimiter, exactly as received, or null
   * for a final release that carries no suffix at all. */
  readonly suffix: string | null;
}

/** Semantic rejections raised by this decoder. Truncation and over-long
 * declared lengths still surface as MspPayloadReadError from the bounded
 * reader, so callers can distinguish "the bytes ran out" from "the bytes
 * were present but incoherent". */
export class MspFcVersionDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MspFcVersionDecodeError';
  }
}

/** Canonical CalVer base: three decimal groups, no signs, no padding, no
 * whitespace. Leading zeros are rejected by construction - a group is
 * either a single 0 or starts 1-9. */
const CANONICAL_BASE_TEXT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function rejectUnlessPrintableAscii(versionString: string): void {
  for (let index = 0; index < versionString.length; index++) {
    const code = versionString.charCodeAt(index);
    if (code === 0) {
      throw new MspFcVersionDecodeError(
        `decodeFcVersion: version string contains a NUL byte at index ${index}.`,
      );
    }
    if (code < 0x20 || code === 0x7f) {
      throw new MspFcVersionDecodeError(
        `decodeFcVersion: version string contains control byte 0x${code.toString(16)} at index ${index}.`,
      );
    }
    if (code > 0x7e) {
      throw new MspFcVersionDecodeError(
        `decodeFcVersion: version string contains non-ASCII byte 0x${code.toString(16)} at index ${index}; ` +
          'this response is plain ASCII CalVer text.',
      );
    }
  }
}

/** Splits on the FIRST delimiter only: version.h:50 builds the suffix as
 * `"-" FC_VERSION_SUFFIX`, so everything after that first '-' is the
 * suffix verbatim, dashes included. */
function splitBaseAndSuffix(versionString: string): {base: string; suffix: string | null} {
  const delimiterIndex = versionString.indexOf(FC_VERSION_SUFFIX_DELIMITER);
  if (delimiterIndex === -1) {
    return {base: versionString, suffix: null};
  }
  return {
    base: versionString.slice(0, delimiterIndex),
    suffix: versionString.slice(delimiterIndex + FC_VERSION_SUFFIX_DELIMITER.length),
  };
}

function rejectUnlessStructurallyValidSuffix(suffix: string): void {
  if (suffix.length === 0) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: a '${FC_VERSION_SUFFIX_DELIMITER}' delimiter is present but the suffix is empty; ` +
        'the firmware emits no delimiter at all for a final release (version.h:47-51).',
    );
  }
  if (/\s/.test(suffix)) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: suffix "${suffix}" contains whitespace; the firmware concatenates a single ` +
        'string-literal token after the delimiter.',
    );
  }
}

export function decodeFcVersion(payload: Uint8Array): MspFcVersion {
  const reader = new MspPayloadReader(payload);

  const yearOffsetRaw = reader.readU8();
  const month = reader.readU8();
  const patch = reader.readU8();
  const declaredLength = reader.readU8();

  if (declaredLength === 0) {
    throw new MspFcVersionDecodeError(
      'decodeFcVersion: the version string is empty; the firmware always reports a non-empty FC_VERSION_STRING.',
    );
  }

  // readFixedAscii bounds-checks: a declared length beyond the remaining
  // payload throws MspPayloadReadError rather than reading garbage.
  const versionString = reader.readFixedAscii(declaredLength);

  if (reader.remaining() !== 0) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: ${reader.remaining()} unexpected trailing byte(s) after a self-delimiting version string. ` +
        'This response declares its own length, so extra bytes indicate a mismatched frame, not a newer field.',
    );
  }

  rejectUnlessPrintableAscii(versionString);

  if (month < FC_VERSION_MIN_MONTH || month > FC_VERSION_MAX_MONTH) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: month ${month} is outside ${FC_VERSION_MIN_MONTH}..${FC_VERSION_MAX_MONTH}, ` +
        'which the firmware itself enforces with a STATIC_ASSERT (build/version.h:76).',
    );
  }

  const {base, suffix} = splitBaseAndSuffix(versionString);

  if (!CANONICAL_BASE_TEXT.test(base)) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: base "${base}" of version string "${versionString}" is not canonical CalVer text ` +
        '(three unpadded decimal groups, no whitespace).',
    );
  }

  if (suffix !== null) {
    rejectUnlessStructurallyValidSuffix(suffix);
  }

  const year = FC_VERSION_CALVER_BASE_YEAR + yearOffsetRaw;
  const expectedBase = `${year}.${month}.${patch}`;
  // Exact base equality, never a prefix test: "2025.12.20" must not be
  // accepted for the numeric tuple that reads "2025.12.2".
  if (base !== expectedBase) {
    throw new MspFcVersionDecodeError(
      `decodeFcVersion: version string "${versionString}" has base "${base}", which contradicts the numeric tuple ` +
        `(yearOffset ${yearOffsetRaw} -> ${year}, month ${month}, patch ${patch}), reading "${expectedBase}". ` +
        'Both representations must agree; neither is preferred over the other.',
    );
  }

  return Object.freeze({yearOffsetRaw, year, month, patch, versionString, suffix});
}
