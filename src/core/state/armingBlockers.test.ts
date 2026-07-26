import {
  ARMING_DISABLE_FLAGS_COUNT,
  ARMING_DISABLE_FLAG_TOKENS,
  BOXARM_PERMANENT_ID,
  decodeArmingBlockers,
  decodeSensorPresence,
  deriveArmedState,
} from './armingBlockers';
import {decodeStatusExReadiness, STATUS_EX_FIXED_PREFIX_BYTES} from '../protocol';

/** Builds a STATUS_EX payload: 13-byte fixed prefix + the exact optional
 * tail layout proven at the pinned API-1.47 authority. */
function statusExPayload(options: {
  extraFlightModeBytes?: number[];
  armingDisableFlags?: number;
  declaredExtraCount?: number;
  configState?: number;
  includeCoreTemp?: boolean;
  truncateTo?: number;
}): Uint8Array {
  const bytes: number[] = [
    0x84, 0x03, // cycle time
    0x00, 0x00, // i2c errors
    0x29, 0x00, // sensor mask 41
    0, 0, 0, 0, // flight mode flags low 32
    1, // pid profile index
    0x2a, 0x00, // cpu load
  ];
  bytes.push(3); // PID_PROFILE_COUNT
  bytes.push(0); // rate profile index
  const extra = options.extraFlightModeBytes ?? [];
  bytes.push(options.declaredExtraCount ?? extra.length);
  bytes.push(...extra);
  if (options.armingDisableFlags !== undefined) {
    bytes.push(ARMING_DISABLE_FLAGS_COUNT);
    const mask = options.armingDisableFlags;
    bytes.push(
      mask % 256,
      Math.floor(mask / 256) % 256,
      Math.floor(mask / 65536) % 256,
      Math.floor(mask / 16777216) % 256,
    );
    bytes.push(options.configState ?? 0);
    if (options.includeCoreTemp) {
      bytes.push(30, 0);
    }
  }
  const full = Uint8Array.from(bytes);
  return options.truncateTo === undefined ? full : full.subarray(0, options.truncateTo);
}

describe('decodeStatusExReadiness - bounded optional-tail parsing (pinned API 1.47)', () => {
  it('a prefix-only payload is VALID and simply carries no readiness tail', () => {
    const prefixOnly = statusExPayload({}).subarray(0, STATUS_EX_FIXED_PREFIX_BYTES);
    expect(STATUS_EX_FIXED_PREFIX_BYTES).toBe(13);
    expect(decodeStatusExReadiness(prefixOnly)).toEqual({});
  });

  it('decodes the full tail: profiles, extension bytes, blocker mask and reboot-required', () => {
    const decoded = decodeStatusExReadiness(
      statusExPayload({
        extraFlightModeBytes: [0b0000_0011],
        armingDisableFlags: 0,
        configState: 1,
        includeCoreTemp: true,
      }),
    );
    expect(decoded.pidProfileCount).toBe(3);
    expect(decoded.controlRateProfileIndex).toBe(0);
    expect(decoded.extraFlightModeFlagBytes).toEqual([0b0000_0011]);
    expect(decoded.armingDisableFlagsCount).toBe(29);
    expect(decoded.armingDisableFlags).toBe(0);
    expect(decoded.rebootRequired).toBe(true);
  });

  it('supports every supported optional-tail boundary (0..15 extension bytes)', () => {
    for (const count of [0, 1, 4, 15]) {
      const decoded = decodeStatusExReadiness(
        statusExPayload({extraFlightModeBytes: new Array(count).fill(0xaa), armingDisableFlags: 1}),
      );
      expect(decoded.extraFlightModeFlagBytes).toHaveLength(count);
      expect(decoded.armingDisableFlags).toBe(1);
    }
  });

  it('a shorter VALID payload that stops before the blocker mask reports it absent, never invented', () => {
    const decoded = decodeStatusExReadiness(statusExPayload({extraFlightModeBytes: []}));
    expect(decoded.pidProfileCount).toBe(3);
    expect(decoded.armingDisableFlags).toBeUndefined();
    expect(decoded.rebootRequired).toBeUndefined();
  });

  it('a malformed partial blocker mask is rejected as absent - no out-of-bounds read, no partial value', () => {
    const full = statusExPayload({armingDisableFlags: 0xffffffff});
    // Cut two bytes out of the middle of the 4-byte mask.
    const decoded = decodeStatusExReadiness(full.subarray(0, full.length - 4));
    expect(decoded.armingDisableFlags).toBeUndefined();
    expect(decoded.pidProfileCount).toBe(3);
  });

  it('an extension byteCount larger than the frame is rejected without reading out of bounds', () => {
    const decoded = decodeStatusExReadiness(statusExPayload({extraFlightModeBytes: [1], declaredExtraCount: 12}));
    expect(decoded.extraFlightModeFlagBytes).toBeUndefined();
    expect(decoded.pidProfileCount).toBe(3);
  });

  it('preserves the mask UNSIGNED - bit 31 must not become negative', () => {
    const decoded = decodeStatusExReadiness(statusExPayload({armingDisableFlags: 0x80000000}));
    expect(decoded.armingDisableFlags).toBe(2147483648);
    expect(decoded.armingDisableFlags).toBeGreaterThan(0);
  });
});

describe('decodeArmingBlockers - exact pinned enum order', () => {
  it('exposes all 29 flags in the pinned order with the canonical tokens', () => {
    expect(ARMING_DISABLE_FLAGS_COUNT).toBe(29);
    expect(ARMING_DISABLE_FLAG_TOKENS).toHaveLength(29);
    expect(ARMING_DISABLE_FLAG_TOKENS[0]).toBe('NO_GYRO');
    expect(ARMING_DISABLE_FLAG_TOKENS[3]).toBe('NOT_DISARMED');
    expect(ARMING_DISABLE_FLAG_TOKENS[23]).toBe('ACC_CALIBRATION');
    expect(ARMING_DISABLE_FLAG_TOKENS[28]).toBe('ARM_SWITCH');
  });

  it('maps EVERY known bit individually', () => {
    ARMING_DISABLE_FLAG_TOKENS.forEach((token, bit) => {
      const decoded = decodeArmingBlockers(Math.pow(2, bit));
      expect(decoded).toEqual([{kind: 'KNOWN', bit, token}]);
    });
  });

  it('reports multiple simultaneous blockers, in ascending bit order', () => {
    const decoded = decodeArmingBlockers(Math.pow(2, 0) + Math.pow(2, 7) + Math.pow(2, 28));
    expect(decoded.map(b => (b.kind === 'KNOWN' ? b.token : b.hex))).toEqual(['NO_GYRO', 'THROTTLE', 'ARM_SWITCH']);
  });

  it('zero blockers decode to an empty list - the caller decides the (truthful) wording', () => {
    expect(decodeArmingBlockers(0)).toEqual([]);
  });

  it('preserves UNKNOWN higher bits numerically/in hex instead of discarding them', () => {
    const decoded = decodeArmingBlockers(Math.pow(2, 29) + Math.pow(2, 31));
    expect(decoded).toEqual([
      {kind: 'UNKNOWN', bit: 29, hex: '0x20000000'},
      {kind: 'UNKNOWN', bit: 31, hex: '0x80000000'},
    ]);
  });

  it('handles a mixed known/unknown mask without losing either side', () => {
    const decoded = decodeArmingBlockers(Math.pow(2, 8) + Math.pow(2, 30));
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual({kind: 'KNOWN', bit: 8, token: 'ANGLE'});
    expect(decoded[1].kind).toBe('UNKNOWN');
  });
});

describe('decodeSensorPresence', () => {
  it('maps the pinned sensor bits and preserves unknown ones', () => {
    expect(decodeSensorPresence(41)).toEqual([
      {kind: 'KNOWN', bit: 0, token: 'ACC'},
      {kind: 'KNOWN', bit: 3, token: 'GPS'},
      {kind: 'KNOWN', bit: 5, token: 'GYRO'},
    ]);
    expect(decodeSensorPresence(Math.pow(2, 9))).toEqual([{kind: 'UNKNOWN', bit: 9, hex: '0x200'}]);
    expect(decodeSensorPresence(0)).toEqual([]);
  });
});

describe('deriveArmedState - BOXIDS-mapped, never inferred from blockers', () => {
  it('BOXARM permanent id is 0 at the pinned authority', () => {
    expect(BOXARM_PERMANENT_ID).toBe(0);
  });

  it('DISARMED when the BOXARM bit is clear', () => {
    expect(deriveArmedState(0, [], [0, 1, 2])).toBe('DISARMED');
  });

  it('ARMED when the BOXARM bit is set at its mapped index', () => {
    // BOXARM is the third active box here -> bit index 2.
    expect(deriveArmedState(Math.pow(2, 2), [], [5, 1, 0])).toBe('ARMED');
  });

  it('UNKNOWN without a mapping, with an empty mapping, or when BOXARM is absent', () => {
    expect(deriveArmedState(0, [], undefined)).toBe('UNKNOWN');
    expect(deriveArmedState(0, [], [])).toBe('UNKNOWN');
    expect(deriveArmedState(0, [], [1, 2, 3])).toBe('UNKNOWN');
  });

  it('UNKNOWN when the flight-mode flags themselves are absent', () => {
    expect(deriveArmedState(undefined, [], [0])).toBe('UNKNOWN');
  });

  it('resolves a BOXARM index beyond bit 31 from the extension bytes, and is UNKNOWN when they are missing', () => {
    const mapping = new Array(35).fill(9);
    mapping[33] = 0; // BOXARM at index 33 -> extension byte 0, bit 1
    expect(deriveArmedState(0, [0b0000_0010], mapping)).toBe('ARMED');
    expect(deriveArmedState(0, [0b0000_0000], mapping)).toBe('DISARMED');
    expect(deriveArmedState(0, [], mapping)).toBe('UNKNOWN');
    expect(deriveArmedState(0, undefined, mapping)).toBe('UNKNOWN');
  });

  it('is NEVER derived from the arming-disable mask: a fully-blocked FC with a clear ARM bit is DISARMED', () => {
    const everyBlocker = 0x1fffffff;
    expect(decodeArmingBlockers(everyBlocker).length).toBe(29);
    expect(deriveArmedState(0, [], [0])).toBe('DISARMED');
  });
});
