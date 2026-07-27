/**
 * Pass 1C-P2 - byte-level tests for the pure MSP_FC_VERSION (3) decoder.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no transport, no MspClient, no ESC, no motor, no
 * LiPo, no timers. Every expectation is a hand-written byte array.
 *
 * A DECODED VERSION IS NOT MOTOR-TEST READINESS, SAFETY OR AUTHORIZATION.
 * Nothing here decides whether a version is in scope: a coherent
 * 2025.12.5 and a coherent 2025.12.2-RC1 both decode successfully, and
 * the scope decision belongs to a separate, later gate.
 */

import {MspPayloadReadError} from './MspPayloadReader';
import {
  decodeFcVersion,
  MspFcVersionDecodeError,
  FC_VERSION_CALVER_BASE_YEAR,
  FC_VERSION_MAX_MONTH,
  FC_VERSION_MIN_MONTH,
  FC_VERSION_SUFFIX_DELIMITER,
  MSP_FC_VERSION_FIXED_BYTES,
} from './decodeFcVersion';
import * as mspCommandsModule from '../commands/mspCommands';
import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT, MSP_FC_VERSION} from '../commands/mspCommands';

/** Builds the payload the firmware emits: three unsigned bytes then a
 * Pascal-style length-prefixed ASCII string (streambuf.c:86-91). */
function payloadFor(yearOffset: number, month: number, patch: number, text: string): number[] {
  const textBytes = Array.from(text, character => character.charCodeAt(0));
  return [yearOffset, month, patch, textBytes.length, ...textBytes];
}

/** The exact expected payload for the pinned release 2025.12.2,
 * re-derived from msp.c:642-647 + streambuf.c:86-91 @
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e. */
const FIXTURE_2025_12_2 = [25, 12, 2, 9, 50, 48, 50, 53, 46, 49, 50, 46, 50];

describe('MSP_FC_VERSION command declaration and provenance', () => {
  it('is command ID 3', () => {
    expect(MSP_FC_VERSION).toBe(3);
  });

  it('collides with no other declared command value', () => {
    const values = Object.entries(mspCommandsModule)
      .filter(([, value]) => typeof value === 'number')
      .map(([, value]) => value as number);
    expect(new Set(values).size).toBe(values.length);
  });

  it('leaves every pre-existing command value unchanged', () => {
    expect(MSP_API_VERSION).toBe(1);
    expect(MSP_FC_VARIANT).toBe(2);
    expect(MSP_BOARD_INFO).toBe(4);
  });
});

describe('decodeFcVersion - constants', () => {
  it('pins the CalVer base year, month range, delimiter and fixed-byte count', () => {
    expect(FC_VERSION_CALVER_BASE_YEAR).toBe(2000);
    expect(FC_VERSION_MIN_MONTH).toBe(1);
    expect(FC_VERSION_MAX_MONTH).toBe(12);
    expect(FC_VERSION_SUFFIX_DELIMITER).toBe('-');
    expect(MSP_FC_VERSION_FIXED_BYTES).toBe(4);
  });
});

describe('decodeFcVersion - accepted responses', () => {
  it('decodes the exact pinned 2025.12.2 fixture, with no suffix', () => {
    // Independent construction check: the specified fixture and the
    // builder must agree byte for byte.
    expect(payloadFor(25, 12, 2, '2025.12.2')).toEqual(FIXTURE_2025_12_2);

    const decoded = decodeFcVersion(Uint8Array.from(FIXTURE_2025_12_2));
    expect(decoded.yearOffsetRaw).toBe(25);
    expect(decoded.year).toBe(2025);
    expect(decoded.month).toBe(12);
    expect(decoded.patch).toBe(2);
    expect(decoded.versionString).toBe('2025.12.2');
    expect(decoded.suffix).toBeNull();
  });

  it("decodes a coherent DIFFERENT final version - scope is not the decoder's job", () => {
    const decoded = decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 5, '2025.12.5')));
    expect(decoded.year).toBe(2025);
    expect(decoded.patch).toBe(5);
    expect(decoded.versionString).toBe('2025.12.5');
    expect(decoded.suffix).toBeNull();
  });

  it('decodes an officially-shaped suffixed pre-release, preserving text and suffix exactly', () => {
    // version.h:36 documents the suffix as optional and illustrates it
    // with "alpha, beta, rc1, etc"; :50 concatenates "-" + the suffix.
    const decoded = decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.2-RC1')));
    expect(decoded.versionString).toBe('2025.12.2-RC1');
    expect(decoded.suffix).toBe('RC1');
    // The numeric base still agrees; the suffix is NOT stripped and is
    // NOT treated as equivalent to the final release.
    expect(decoded.patch).toBe(2);
    expect(decoded.versionString).not.toBe('2025.12.2');
  });

  it('accepts any structurally valid suffix - no invented allow-list of names', () => {
    for (const suffix of ['alpha', 'beta', 'rc1', 'RC1', 'nightly', 'a1b2', 'rc-2']) {
      const decoded = decodeFcVersion(
        Uint8Array.from(payloadFor(25, 12, 2, `2025.12.2-${suffix}`)),
      );
      expect(decoded.suffix).toBe(suffix);
    }
  });

  it('decodes other coherent CalVer combinations across the byte range', () => {
    expect(decodeFcVersion(Uint8Array.from(payloadFor(26, 1, 0, '2026.1.0'))).versionString).toBe(
      '2026.1.0',
    );
    expect(decodeFcVersion(Uint8Array.from(payloadFor(25, 1, 10, '2025.1.10'))).patch).toBe(10);
    expect(decodeFcVersion(Uint8Array.from(payloadFor(255, 12, 1, '2255.12.1'))).year).toBe(2255);
    expect(decodeFcVersion(Uint8Array.from(payloadFor(0, 1, 0, '2000.1.0'))).year).toBe(2000);
  });

  it('returns a frozen result and mutates no input', () => {
    const payload = Uint8Array.from(FIXTURE_2025_12_2);
    const snapshot = Array.from(payload);
    const decoded = decodeFcVersion(payload);

    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Reflect.set(decoded, 'patch', 99)).toBe(false);
    expect(decoded.patch).toBe(2);
    expect(Array.from(payload)).toEqual(snapshot);
  });

  it('returns a fresh result on every call', () => {
    const first = decodeFcVersion(Uint8Array.from(FIXTURE_2025_12_2));
    const second = decodeFcVersion(Uint8Array.from(FIXTURE_2025_12_2));
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('decodeFcVersion - truncation (bounded reader)', () => {
  it('rejects an empty payload', () => {
    expect(() => decodeFcVersion(Uint8Array.from([]))).toThrow(MspPayloadReadError);
  });

  it('rejects one-, two- and three-byte payloads, including the missing length prefix', () => {
    expect(() => decodeFcVersion(Uint8Array.from([25]))).toThrow(MspPayloadReadError);
    expect(() => decodeFcVersion(Uint8Array.from([25, 12]))).toThrow(MspPayloadReadError);
    // Three bytes = the numeric tuple with no Pascal length byte at all.
    expect(() => decodeFcVersion(Uint8Array.from([25, 12, 2]))).toThrow(MspPayloadReadError);
  });

  it('rejects a declared length greater than the remaining bytes', () => {
    expect(() => decodeFcVersion(Uint8Array.from([25, 12, 2, 9, 50, 48, 50, 53]))).toThrow(
      MspPayloadReadError,
    );
  });

  it('rejects every truncation of the valid fixture', () => {
    for (let length = 0; length < FIXTURE_2025_12_2.length; length++) {
      expect(() => decodeFcVersion(Uint8Array.from(FIXTURE_2025_12_2.slice(0, length)))).toThrow();
    }
  });
});

describe('decodeFcVersion - semantic rejections', () => {
  it('rejects a zero-length version string', () => {
    expect(() => decodeFcVersion(Uint8Array.from([25, 12, 2, 0]))).toThrow(MspFcVersionDecodeError);
  });

  it('rejects unexpected trailing bytes (documented fail-closed policy)', () => {
    expect(() => decodeFcVersion(Uint8Array.from([...FIXTURE_2025_12_2, 0x00]))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from([...FIXTURE_2025_12_2, 0xaa, 0xbb]))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects numeric/text base contradiction', () => {
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.5')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2024.12.2')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.11.2')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects PREFIX AMBIGUITY - 2025.12.20 is not 2025.12.2', () => {
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.20')))).toThrow(
      MspFcVersionDecodeError,
    );
    // ...and the coherent form of that same text decodes fine.
    expect(decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 20, '2025.12.20'))).patch).toBe(20);
  });

  it('rejects non-canonical leading zeros in the base', () => {
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.02')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 1, 2, '2025.01.2')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects leading and trailing whitespace instead of trimming it', () => {
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, ' 2025.12.2')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.2 ')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects a delimiter with an empty or whitespace suffix', () => {
    // version.h emits NO delimiter at all for a final release, so a bare
    // trailing '-' is structurally impossible firmware output.
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.2-')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.2-RC 1')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects an embedded NUL byte', () => {
    expect(() =>
      decodeFcVersion(Uint8Array.from([25, 12, 2, 10, 50, 48, 50, 53, 46, 49, 50, 46, 50, 0])),
    ).toThrow(MspFcVersionDecodeError);
  });

  it('rejects embedded control bytes', () => {
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025\n12.2')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.2\r')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('rejects non-ASCII bytes', () => {
    expect(() =>
      decodeFcVersion(Uint8Array.from([25, 12, 2, 10, 50, 48, 50, 53, 46, 49, 50, 46, 50, 0xc3])),
    ).toThrow(MspFcVersionDecodeError);
  });

  it('rejects structurally malformed base text', () => {
    for (const text of ['2025.12', '2025.12.2.1', '2025..2', 'v2025.12.2', '2025_12_2', '....']) {
      expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, text)))).toThrow(
        MspFcVersionDecodeError,
      );
    }
  });

  it('rejects an invalid month even when the text agrees with it', () => {
    // build/version.h:76 enforces 1..12 with a STATIC_ASSERT, so any
    // other month is a malformed response, not newer firmware.
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 0, 2, '2025.0.2')))).toThrow(
      MspFcVersionDecodeError,
    );
    expect(() => decodeFcVersion(Uint8Array.from(payloadFor(25, 13, 2, '2025.13.2')))).toThrow(
      MspFcVersionDecodeError,
    );
  });

  it('uses a dedicated semantic error class, distinct from the bounded-reader error', () => {
    let caught: unknown;
    try {
      decodeFcVersion(Uint8Array.from(payloadFor(25, 12, 2, '2025.12.5')));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MspFcVersionDecodeError);
    expect(caught).not.toBeInstanceOf(MspPayloadReadError);
    expect((caught as Error).name).toBe('MspFcVersionDecodeError');
    // States what was received and why it was rejected.
    expect((caught as Error).message).toContain('2025.12.5');
    expect((caught as Error).message).toContain('contradicts');
  });
});

describe('decodeFcVersion - containment', () => {
  it('exposes exactly the six documented fields and no readiness surface', () => {
    const decoded: Record<string, unknown> = {
      ...decodeFcVersion(Uint8Array.from(FIXTURE_2025_12_2)),
    };
    expect(Object.keys(decoded).sort()).toEqual([
      'month',
      'patch',
      'suffix',
      'versionString',
      'year',
      'yearOffsetRaw',
    ]);
    for (const key of Object.keys(decoded)) {
      expect(key).not.toMatch(
        /motor|pulse|safe|ready|canTest|canPulse|authorized|armed|battery|session/i,
      );
    }
  });
});
