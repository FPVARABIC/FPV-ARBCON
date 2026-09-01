/**
 * P-E2 §4 - ONE VERSION TRUTH, ALL THE WAY DOWN.
 *
 * The RPM tail's presence is decided ONCE, from the API version the
 * identification proved, and carried on the snapshot. This file exists to
 * prove that no layer downstream forms its own opinion - specifically, that
 * none of them falls back to the one piece of evidence that is always
 * lying around and always wrong: the length of the payload in hand.
 *
 * WHY THAT MATTERS EVEN THOUGH THE TWO USUALLY AGREE. On a well-behaved
 * board the contract and the length say the same thing, so a length-sniffing
 * implementation passes every happy-path test. The place they part company
 * is a board that answers LONGER than its announced contract - which the
 * decoder tolerates on purpose, because Betaflight's own readers do, so a
 * future firmware appending a field cannot take this screen down. That
 * tolerance is exactly the hole a length sniff would fall through.
 *
 * Fixtures here are hand-written from the firmware's serializer order, never
 * produced by the encoder under test.
 */

import {
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
} from '../protocol/msp/decoding/pidWireContracts';
import {decodePidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {
  createPidTuningDraft,
  validatePidTuningDraft,
} from './pidTuningModel';
import {withRpmFilterValue} from './rpmFilterFields';

const PROFILES = {pidProfileIndex: 0, pidProfileCount: 3, controlRateProfileIndex: 0} as const;

/** A 56-byte MSP_FILTER_CONFIG with a recognisable RPM group. */
function filters56(): Uint8Array {
  const bytes = new Uint8Array(MSP_FILTER_CONFIG_BYTES_API148);
  const view = new DataView(bytes.buffer);
  /* A COHERENT DYNAMIC NOTCH, because `validatePidTuningDraft` judges the
     whole draft: a notch count above zero with a q of zero is refused on
     its own account, and the encoder would then never reach the RPM code
     these tests are about. */
  view.setUint16(39, 300, true); // dyn_notch_q
  view.setUint16(41, 100, true); // dyn_notch_min_hz
  bytes[43] = 2;   // rpm_filter_harmonics
  bytes[44] = 120; // rpm_filter_min_hz
  view.setUint16(45, 600, true); // dyn_notch_max_hz - a neighbour, not ours
  bytes[48] = 4;                 // dyn_notch_count  - a neighbour, not ours
  view.setUint16(49, 640, true); // rpm_filter_fade_range_hz
  view.setUint16(51, 1250, true); // rpm_filter_q
  bytes[53] = 90; bytes[54] = 55; bytes[55] = 10; // rpm_filter_weights
  return bytes;
}

/**
 * A LEGAL RATE CURVE. Zeroed rates fail `validatePidTuningDraft` on their
 * own account - rcRate has a floor of 1, the rate limits a floor of 200 -
 * and the encoder refuses an invalid draft before it reaches any RPM code.
 * These are the firmware's own defaults, so the only thing the tests below
 * can be refused for is the RPM group they are actually about.
 */
function rates24(): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 100; bytes[12] = 100; bytes[11] = 100;  // rcRate roll/pitch/yaw
  bytes[2] = 70; bytes[3] = 70; bytes[4] = 70;       // super rate
  bytes[6] = 50;                                     // throttle mid
  bytes[15] = 100;                                   // throttle limit percent
  bytes[23] = 50;                                    // throttle hover
  view.setUint16(16, 1998, true);
  view.setUint16(18, 1998, true);
  view.setUint16(20, 1998, true);
  return bytes;
}

function snapshot(contract: 'API_1_47' | 'API_1_48' | 'API_1_49', filters: Uint8Array) {
  return decodePidTuningSnapshot({
    contract,
    pid: new Uint8Array(15),
    advanced: new Uint8Array(61),
    rates: rates24(),
    filters,
    gyroSampleRateHz: 8000,
    pidProcessDenom: 2,
    ...PROFILES,
  });
}

describe('the contract travels with the bytes', () => {
  it('is carried on the snapshot, not re-derived from it', () => {
    expect(snapshot('API_1_47', new Uint8Array(49)).contract).toBe('API_1_47');
    expect(snapshot('API_1_49', filters56()).contract).toBe('API_1_49');
  });

  it('refuses a payload SHORTER than the contract it was announced as', () => {
    /* From 1.48 the firmware appends the RPM tail unconditionally, so a
       board claiming 1.48 and sending 49 bytes has contradicted itself.
       Reading the tail out of it would run off the end; padding it with
       zeros would invent five values. */
    for (const contract of ['API_1_48', 'API_1_49'] as const) {
      expect(() => snapshot(contract, new Uint8Array(MSP_FILTER_CONFIG_BYTES_API147)))
        .toThrow(new RegExp(`requires at least 56 bytes for ${contract}`));
    }
    // And 1.47 is satisfied by 49, which is what its firmware really sends.
    expect(() => snapshot('API_1_47', new Uint8Array(49))).not.toThrow();
  });
});

describe('the draft asks the contract, never the length', () => {
  it('has no tail on a 1.47 contract even when the payload carries one', () => {
    /* THE CASE THAT SEPARATES THE TWO IMPLEMENTATIONS. A 1.47 board that
       answers with 56 bytes - a fork, a vendor build, a future firmware -
       is accepted by the decoder on purpose. A length sniff would decide
       that board has a writable RPM tail; the contract says it does not,
       and the contract is what was proven. */
    const draft = createPidTuningDraft(snapshot('API_1_47', filters56()));
    expect(draft.rpmFilter.tail).toBeUndefined();
    expect(draft.rpmFilter.harmonics).toBe(2);
    expect(draft.rpmFilter.minHz).toBe(120);
  });

  it('has the tail on a 1.48 contract, read at the firmware\'s offsets', () => {
    expect(createPidTuningDraft(snapshot('API_1_48', filters56())).rpmFilter).toEqual({
      harmonics: 2,
      minHz: 120,
      tail: {fadeRangeHz: 640, q: 1250, weights: [90, 55, 10]},
    });
  });
});

describe('the encoder asks the same contract', () => {
  it('never writes the tail for a 1.47 board, whatever the payload length', () => {
    const stored = snapshot('API_1_47', filters56());
    const base = createPidTuningDraft(stored);
    /* Head edited, and a tail edit attempted. The tail edit is dropped by
       the draft itself, so what reaches the encoder carries no tail - and
       the encoder is ALSO told the contract, so bytes 49-55 stay put even
       if a future caller hands it one. */
    const draft = withRpmFilterValue(
      withRpmFilterValue(base.rpmFilter, 'harmonics', 1), 'q', 2000,
    );
    const writes = encodeChangedPidTuning(stored, {...base, rpmFilter: draft});
    const filters = writes.find(write => write.group === 'FILTER_CONFIG')?.payload;
    expect(filters).toBeDefined();
    expect(filters![43]).toBe(1);
    // Everything from dyn_notch_max_hz onward, including the tail, verbatim.
    expect([...filters!.subarray(45)]).toEqual([...stored.filtersRaw.subarray(45)]);
  });

  it('refuses the tail bytes for a 1.47 board even when handed a tail draft', () => {
    /* The companion to the case above. There the draft had no tail because
       `withRpmFilterValue` refused to make one; here the draft is built by
       hand WITH one, which is what a future caller could do by mistake.
       The encoder is told the contract, so the answer does not change:
       bytes 49-55 are not this board's. */
    const stored = snapshot('API_1_47', filters56());
    const base = createPidTuningDraft(stored);
    const writes = encodeChangedPidTuning(stored, {
      ...base,
      rpmFilter: {
        harmonics: 1,
        minHz: 60,
        tail: {fadeRangeHz: 999, q: 2999, weights: [11, 22, 33] as const},
      },
    });
    const filters = writes.find(write => write.group === 'FILTER_CONFIG')?.payload;
    expect(filters).toBeDefined();
    expect(filters![43]).toBe(1);
    expect(filters![44]).toBe(60);
    expect([...filters!.subarray(45)]).toEqual([...stored.filtersRaw.subarray(45)]);
  });

  it('writes the tail for a 1.49 board and leaves its neighbours alone', () => {
    const stored = snapshot('API_1_49', filters56());
    const base = createPidTuningDraft(stored);
    const writes = encodeChangedPidTuning(stored, {
      ...base,
      rpmFilter: withRpmFilterValue(base.rpmFilter, 'q', 2000),
    });
    const filters = writes.find(write => write.group === 'FILTER_CONFIG')?.payload;
    expect(filters).toBeDefined();
    const view = new DataView(filters!.buffer, filters!.byteOffset, filters!.byteLength);
    expect(view.getUint16(51, true)).toBe(2000);
    expect(view.getUint16(45, true)).toBe(600); // dyn_notch_max_hz untouched
    expect(filters![48]).toBe(4);               // dyn_notch_count untouched
  });
});

describe('validation reaches the save path', () => {
  it('refuses a draft the firmware would reject, and the encoder refuses too', () => {
    const stored = snapshot('API_1_49', filters56());
    const base = createPidTuningDraft(stored);
    /* MSP_SET_FILTER_CONFIG returns MSP_RESULT_ERROR for a q outside
       {250, 3000} - after the rest of the payload has already been applied.
       So the refusal has to happen HERE, before the payload is built. */
    const draft = {...base, rpmFilter: {
      ...base.rpmFilter,
      tail: {fadeRangeHz: 640, q: 3001, weights: [90, 55, 10] as const},
    }};
    expect(validatePidTuningDraft(draft, stored)).toContain('RPM_FILTER_VALUE_INVALID');
    expect(() => encodeChangedPidTuning(stored, draft)).toThrow(RangeError);
  });

  it('accepts the firmware\'s own edges', () => {
    const stored = snapshot('API_1_49', filters56());
    const base = createPidTuningDraft(stored);
    for (const q of [250, 3000]) {
      const draft = {...base, rpmFilter: {
        ...base.rpmFilter,
        tail: {fadeRangeHz: 1000, q, weights: [0, 100, 50] as const},
      }};
      expect(validatePidTuningDraft(draft, stored)).not.toContain('RPM_FILTER_VALUE_INVALID');
    }
  });

  it('judges nothing on a contract that carries no tail', () => {
    const stored = snapshot('API_1_47', new Uint8Array(49));
    const base = createPidTuningDraft(stored);
    expect(validatePidTuningDraft(base, stored)).not.toContain('RPM_FILTER_VALUE_INVALID');
  });
});
