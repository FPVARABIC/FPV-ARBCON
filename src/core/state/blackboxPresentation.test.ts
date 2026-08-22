/**
 * THE PRESENTATION RULES, ASSERTED DIRECTLY.
 *
 * Everything here is a statement about what the screen is PERMITTED to
 * say. The screen's own tests then prove it obeys these; testing the rules
 * separately means a rule can be wrong in one obvious place rather than
 * subtly wrong in fifteen rendered trees.
 *
 * Every expected value is written from the firmware sources named in the
 * module under test, never produced by calling the module itself.
 */

import {
  BLACKBOX_FIELD_BITS,
  BYTES_PER_KIB,
  NAMED_DEBUG_MODES,
  OFFERABLE_BLACKBOX_DEVICES,
  blackboxFieldBit,
  blackboxFieldIncluded,
  dataflashSectionVisible,
  describeBlackboxDevice,
  describeBlackboxRate,
  describeDataflash,
  describeDebugMode,
  describeSdcard,
  formatBinarySize,
  kibibytesToBytes,
  offerableDebugModes,
  onlySerialRemains,
  sdcardSectionVisible,
  unnamedDisabledFieldBits,
  usedFraction,
  withBlackboxFieldIncluded,
} from './blackboxPresentation';
import {
  classifyBlackboxDevice,
  classifyBlackboxSampleRate,
  classifyDataflash,
  classifySdcard,
  type DataflashStorage,
  type SdcardStorage,
} from './blackboxStorageSemantics';

/* ------------------------------------------------------------------ *
 * Fixtures, built from the wire structures rather than by hand-editing
 * the semantic model - so a change in classification is visible here.
 * ------------------------------------------------------------------ */

const flash = (over: {
  supported: boolean;
  ready: boolean;
  totalBytes: number;
  usedBytes: number;
}): DataflashStorage =>
  classifyDataflash({
    flagsRaw: (over.ready ? 1 : 0) | (over.supported ? 2 : 0),
    supported: over.supported,
    ready: over.ready,
    sectorCount: 256,
    totalBytes: over.totalBytes,
    usedBytes: over.usedBytes,
  });

const sd = (over: {
  configured: boolean;
  stateRaw: number;
  freeKilobytes?: number;
  totalKilobytes?: number;
}): SdcardStorage =>
  classifySdcard({
    flagsRaw: over.configured ? 1 : 0,
    configured: over.configured,
    stateRaw: over.stateRaw,
    filesystemLastError: 0,
    freeKilobytes: over.freeKilobytes ?? 0,
    totalKilobytes: over.totalKilobytes ?? 0,
  });

/* ================================================================== *
 * SIZES
 * ================================================================== */

describe('binary sizes', () => {
  it('keeps whole bytes whole, so a real zero reads as a real zero', () => {
    // 0 used bytes on a READY volume is a MEASUREMENT. It must not be
    // rounded into "0.0 KiB" or dressed up as anything else.
    expect(formatBinarySize(0)).toEqual({
      amount: '0',
      unitKey: 'blackbox.units.bytes',
    });
    expect(formatBinarySize(1)).toEqual({
      amount: '1',
      unitKey: 'blackbox.units.bytes',
    });
    expect(formatBinarySize(1023)).toEqual({
      amount: '1023',
      unitKey: 'blackbox.units.bytes',
    });
  });

  it('crosses each 1024 boundary exactly where the firmware does', () => {
    // 1024 bytes is one KiB, not "1.0 KB".
    expect(formatBinarySize(1024)).toEqual({
      amount: '1',
      unitKey: 'blackbox.units.kibibytes',
    });
    // 1048576 = 1024^2
    expect(formatBinarySize(1048576)).toEqual({
      amount: '1',
      unitKey: 'blackbox.units.mebibytes',
    });
    // 1073741824 = 1024^3
    expect(formatBinarySize(1073741824)).toEqual({
      amount: '1',
      unitKey: 'blackbox.units.gibibytes',
    });
  });

  it('formats the two flash sizes this project keeps fixtures for', () => {
    // 16 MiB = 0x01000000 = 16777216, the size the B-1 fixtures use.
    expect(formatBinarySize(16777216)).toEqual({
      amount: '16',
      unitKey: 'blackbox.units.mebibytes',
    });
    // 8 MiB = 0x00800000 = 8388608.
    expect(formatBinarySize(8388608)).toEqual({
      amount: '8',
      unitKey: 'blackbox.units.mebibytes',
    });
  });

  it('shows one decimal only when the number needs one', () => {
    // 12 MiB + 512 KiB = 12.5 MiB exactly.
    expect(formatBinarySize(13107200)).toEqual({
      amount: '12.5',
      unitKey: 'blackbox.units.mebibytes',
    });
    // A whole number never gains a trailing ".0".
    expect(formatBinarySize(2097152).amount).toBe('2');
  });

  it('converts SD kibibytes with the firmware divisor, not 1000', () => {
    expect(BYTES_PER_KIB).toBe(1024);
    // A 29.7 GiB card reports 31116288 KiB of total space in the summary.
    expect(kibibytesToBytes(31116288)).toBe(31116288 * 1024);
    expect(formatBinarySize(kibibytesToBytes(31116288))).toEqual({
      amount: '29.7',
      unitKey: 'blackbox.units.gibibytes',
    });
  });

  it('refuses a negative size rather than formatting one', () => {
    expect(() => formatBinarySize(-1)).toThrow(RangeError);
    expect(() => formatBinarySize(Number.NaN)).toThrow(RangeError);
  });
});

describe('the usage bar', () => {
  it('has no fraction at all when the numbers are not measurements', () => {
    // A busy volume still reports sizes. They are not readings, and a bar
    // drawn from them would be a picture of nothing.
    const busy = flash({supported: true, ready: false, totalBytes: 16777216, usedBytes: 8388608});
    expect(busy.measurementsValid).toBe(false);
    expect(
      usedFraction({
        usedBytes: busy.usedBytes,
        totalBytes: busy.totalBytes,
        measurementsValid: busy.measurementsValid,
      }),
    ).toBeUndefined();
  });

  it('measures a real half-full volume', () => {
    const half = flash({supported: true, ready: true, totalBytes: 16777216, usedBytes: 8388608});
    expect(
      usedFraction({
        usedBytes: half.usedBytes,
        totalBytes: half.totalBytes,
        measurementsValid: half.measurementsValid,
      }),
    ).toBeCloseTo(0.5, 10);
  });

  it('draws nothing from a zero total, however valid the caller claims it is', () => {
    expect(
      usedFraction({usedBytes: 0, totalBytes: 0, measurementsValid: true}),
    ).toBeUndefined();
  });
});

/* ================================================================== *
 * DEVICE
 * ================================================================== */

describe('the logging destination', () => {
  it('names the four devices the pinned firmware defines', () => {
    expect(describeBlackboxDevice(classifyBlackboxDevice(0)).key).toBe('blackbox.device.NONE');
    expect(describeBlackboxDevice(classifyBlackboxDevice(1)).key).toBe('blackbox.device.FLASH');
    expect(describeBlackboxDevice(classifyBlackboxDevice(2)).key).toBe('blackbox.device.SDCARD');
    expect(describeBlackboxDevice(classifyBlackboxDevice(3)).key).toBe('blackbox.device.SERIAL');
  });

  it('keeps an unmodelled device as itself, raw value and all', () => {
    // 4 is VIRTUAL on master. We have never read its behaviour, so it is
    // reported as unknown WITH its number - never folded into NONE.
    const four = describeBlackboxDevice(classifyBlackboxDevice(4));
    expect(four).toEqual({key: 'blackbox.device.UNKNOWN', raw: 4});
    const nine = describeBlackboxDevice(classifyBlackboxDevice(9));
    expect(nine).toEqual({key: 'blackbox.device.UNKNOWN', raw: 9});
  });

  it('never offers VIRTUAL as a choice', () => {
    expect([...OFFERABLE_BLACKBOX_DEVICES]).toEqual([0, 1, 2, 3]);
    expect(OFFERABLE_BLACKBOX_DEVICES).not.toContain(4);
  });
});

/* ================================================================== *
 * RATE
 * ================================================================== */

describe('the logging rate', () => {
  it('calls the undivided rate full and the rest by their divider', () => {
    expect(describeBlackboxRate(classifyBlackboxSampleRate(0))).toEqual({
      key: 'blackbox.rate.full',
    });
    expect(describeBlackboxRate(classifyBlackboxSampleRate(1))).toEqual({
      key: 'blackbox.rate.fraction',
      divider: 2,
    });
    expect(describeBlackboxRate(classifyBlackboxSampleRate(2))).toEqual({
      key: 'blackbox.rate.fraction',
      divider: 4,
    });
    expect(describeBlackboxRate(classifyBlackboxSampleRate(3))).toEqual({
      key: 'blackbox.rate.fraction',
      divider: 8,
    });
    expect(describeBlackboxRate(classifyBlackboxSampleRate(4))).toEqual({
      key: 'blackbox.rate.fraction',
      divider: 16,
    });
  });

  it('carries an unmodelled rate as unknown, with its raw byte', () => {
    expect(describeBlackboxRate(classifyBlackboxSampleRate(7))).toEqual({
      key: 'blackbox.rate.unknown',
      raw: 7,
    });
  });

  it('produces no frequency of any kind, because none is on the wire', () => {
    // The kHz a person might expect needs the gyro sample rate, which this
    // session never reads. Nothing here may carry one.
    for (const raw of [0, 1, 2, 3, 4, 7]) {
      const label = describeBlackboxRate(classifyBlackboxSampleRate(raw));
      expect(Object.keys(label)).not.toContain('hertz');
      expect(Object.keys(label)).not.toContain('kilohertz');
      expect(JSON.stringify(label)).not.toMatch(/hz/i);
    }
  });
});

/* ================================================================== *
 * STORAGE COPY AND VISIBILITY
 * ================================================================== */

describe('storage sections', () => {
  it('hides the flash section entirely on a board with no flash', () => {
    const none = flash({supported: false, ready: false, totalBytes: 0, usedBytes: 0});
    expect(none.state).toBe('UNSUPPORTED');
    expect(dataflashSectionVisible(none)).toBe(false);
  });

  it('shows a flash section for a busy volume, but permits no numbers', () => {
    const busy = flash({supported: true, ready: false, totalBytes: 16777216, usedBytes: 8388608});
    expect(dataflashSectionVisible(busy)).toBe(true);
    expect(describeDataflash(busy)).toEqual({
      headlineKey: 'blackbox.flashState.BUSY_OR_NOT_READY',
      showsMeasurements: false,
    });
  });

  it('permits numbers on a ready-empty volume, where zero is a reading', () => {
    const empty = flash({supported: true, ready: true, totalBytes: 16777216, usedBytes: 0});
    expect(describeDataflash(empty)).toEqual({
      headlineKey: 'blackbox.flashState.READY_EMPTY',
      showsMeasurements: true,
    });
  });

  it('follows the storage model rather than re-deriving validity', () => {
    // used > total. The model refuses to publish measurements; so must the
    // copy, without a second opinion about which number is wrong.
    const broken = flash({supported: true, ready: true, totalBytes: 1024, usedBytes: 4096});
    expect(broken.state).toBe('INCONSISTENT');
    expect(describeDataflash(broken)).toEqual({
      headlineKey: 'blackbox.flashState.INCONSISTENT',
      showsMeasurements: false,
    });
  });

  it('hides the SD section on a board with no SD slot configured', () => {
    expect(sdcardSectionVisible(sd({configured: false, stateRaw: 0}))).toBe(false);
  });

  it('shows a configured slot with no card, and permits no capacity', () => {
    const empty = sd({configured: true, stateRaw: 0});
    expect(sdcardSectionVisible(empty)).toBe(true);
    expect(describeSdcard(empty)).toEqual({
      headlineKey: 'blackbox.sdState.NOT_PRESENT',
      showsMeasurements: false,
    });
  });

  it('permits capacity only in READY', () => {
    for (const stateRaw of [1, 2, 3]) {
      const notReady = sd({
        configured: true,
        stateRaw,
        freeKilobytes: 12000,
        totalKilobytes: 30000,
      });
      expect(describeSdcard(notReady).showsMeasurements).toBe(false);
    }
    const ready = sd({
      configured: true,
      stateRaw: 4,
      freeKilobytes: 12000,
      totalKilobytes: 30000,
    });
    expect(describeSdcard(ready)).toEqual({
      headlineKey: 'blackbox.sdState.READY',
      showsMeasurements: true,
    });
  });

  it('gives an unrecognised SD state its own copy, never a fault or an absence', () => {
    const strange = sd({configured: true, stateRaw: 9});
    expect(describeSdcard(strange)).toEqual({
      headlineKey: 'blackbox.sdState.UNKNOWN',
      showsMeasurements: false,
    });
  });

  it('recognises a board where only the serial port is left', () => {
    expect(
      onlySerialRemains(
        flash({supported: false, ready: false, totalBytes: 0, usedBytes: 0}),
        sd({configured: false, stateRaw: 0}),
      ),
    ).toBe(true);
    expect(
      onlySerialRemains(
        flash({supported: true, ready: true, totalBytes: 16777216, usedBytes: 0}),
        sd({configured: false, stateRaw: 0}),
      ),
    ).toBe(false);
  });
});

/* ================================================================== *
 * DEBUG MODE
 * ================================================================== */

describe('debug mode', () => {
  it('names the modes the two verified firmware revisions agree on', () => {
    // Spot values, read from src/main/build/debug.c and counted by index.
    expect(NAMED_DEBUG_MODES).toHaveLength(96);
    expect(describeDebugMode(0)).toEqual({name: 'NONE', raw: 0});
    expect(describeDebugMode(8)).toEqual({name: 'ESC_SENSOR', raw: 8});
    expect(describeDebugMode(45)).toEqual({name: 'DSHOT_RPM_TELEMETRY', raw: 45});
    expect(describeDebugMode(60)).toEqual({name: 'BLACKBOX_OUTPUT', raw: 60});
    expect(describeDebugMode(95)).toEqual({name: 'WING_SETPOINT', raw: 95});
  });

  /**
   * THE REASON THE TABLE STOPS. At index 96 the pinned API-1.47 firmware
   * says AUTOPILOT_POSITION and API-1.49 master says CHIRP. Naming that
   * index would mislabel one of the two.
   */
  it('refuses to name index 96, where the firmware revisions disagree', () => {
    expect(describeDebugMode(96)).toEqual({name: undefined, raw: 96});
    expect(describeDebugMode(104)).toEqual({name: undefined, raw: 104});
    expect(NAMED_DEBUG_MODES).not.toContain('AUTOPILOT_POSITION');
    expect(NAMED_DEBUG_MODES).not.toContain('CHIRP');
  });

  it('offers no more modes than the board says it has', () => {
    expect(offerableDebugModes(3)).toEqual([0, 1, 2]);
    expect(offerableDebugModes(0)).toEqual([]);
  });

  it('offers no more modes than can be named, however many the board has', () => {
    // A 1.49 board reports 102. We can name 96 of them.
    expect(offerableDebugModes(102)).toHaveLength(96);
    expect(offerableDebugModes(102)[95]).toBe(95);
    expect(offerableDebugModes(102)).not.toContain(96);
  });
});

/* ================================================================== *
 * DEBUG FIELDS - THE POLARITY
 * ================================================================== */

describe('debug fields', () => {
  it('maps every field to the bit the firmware enum gives it', () => {
    expect(BLACKBOX_FIELD_BITS).toHaveLength(16);
    expect(blackboxFieldBit('PID')).toBe(0);
    expect(blackboxFieldBit('RC_COMMANDS')).toBe(1);
    expect(blackboxFieldBit('BATTERY')).toBe(3);
    expect(blackboxFieldBit('GYRO')).toBe(7);
    expect(blackboxFieldBit('MOTOR')).toBe(11);
    expect(blackboxFieldBit('GPS')).toBe(12);
    expect(blackboxFieldBit('RPM')).toBe(13);
    expect(blackboxFieldBit('SERVO')).toBe(15);
  });

  /**
   * THE ASSERTION THIS WHOLE MODULE EXISTS FOR.
   *
   * Included (ticked) MUST mean the disable bit is CLEAR. Unticked MUST
   * mean it is SET. Reading it the natural way round is the bug.
   */
  it('treats INCLUDED as the bit being CLEARED', () => {
    // Mask 0: nothing disabled, so everything is included.
    for (const field of BLACKBOX_FIELD_BITS) {
      expect(blackboxFieldIncluded(0, field)).toBe(true);
    }
    // 0x00000009 = bits 0 and 3 set = PID and BATTERY DISABLED.
    const mask = 0x00000009;
    expect(blackboxFieldIncluded(mask, 'PID')).toBe(false);
    expect(blackboxFieldIncluded(mask, 'BATTERY')).toBe(false);
    expect(blackboxFieldIncluded(mask, 'RC_COMMANDS')).toBe(true);
    expect(blackboxFieldIncluded(mask, 'GYRO')).toBe(true);
  });

  it('clears the bit when a field is included and sets it when it is not', () => {
    // Include GPS (bit 12) into an all-disabled-for-GPS mask.
    expect(withBlackboxFieldIncluded(0x00001000, 'GPS', true)).toBe(0);
    // Exclude GPS from a clean mask: bit 12 = 4096.
    expect(withBlackboxFieldIncluded(0, 'GPS', false)).toBe(4096);
    // And the round trip leaves neighbours alone.
    const start = 0x00000009;
    const afterExcludeGyro = withBlackboxFieldIncluded(start, 'GYRO', false);
    expect(afterExcludeGyro).toBe(0x00000089); // bits 0, 3, 7
    expect(withBlackboxFieldIncluded(afterExcludeGyro, 'GYRO', true)).toBe(start);
  });

  it('keeps the mask unsigned across bit 31', () => {
    // A bit-31 mask must not surface as a negative number in any model a
    // screen reads.
    const high = withBlackboxFieldIncluded(0x80000000, 'PID', false);
    expect(high).toBeGreaterThan(0);
    expect(high).toBe(0x80000001);
  });

  it('reports bits the board disabled that this build cannot name', () => {
    // Bits 16 and 20 are beyond flightLogFieldSelect_e as we have read it.
    const mask = ((1 << 16) | (1 << 20)) >>> 0;
    expect(unnamedDisabledFieldBits(mask)).toEqual([16, 20]);
    // And none of the sixteen named bits is ever reported as unnamed.
    expect(unnamedDisabledFieldBits(0xffff)).toEqual([]);
  });
});
