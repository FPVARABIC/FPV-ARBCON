/**
 * These tests guard SENTENCES, which is unusual, and deliberate.
 *
 * P-A established two facts about simplified tuning that a friendly UI is
 * constantly tempted to soften: saving REGENERATES the stored tune from
 * compile-time defaults rather than adjusting what the pilot had, and
 * switching the feature off restores NOTHING. Both are the kind of truth
 * that gets edited away by someone making the copy warmer, so each has an
 * assertion that fails when the comfortable version comes back.
 */
import {
  SIMPLIFIED_FILTER_BLOCK_BYTES, SIMPLIFIED_PID_BLOCK_BYTES,
  SIMPLIFIED_TUNING_FILTERS_MIN, SIMPLIFIED_TUNING_MAX, SIMPLIFIED_TUNING_PIDS_MIN,
  classifySimplifiedPidsMode, decodeSimplifiedTuning, type MspSimplifiedTuning,
} from '../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import {simplifiedOwnedFields} from '../../core/state/pidWriteVerification';
import {
  GENERATOR_OWNED_NOTE, SIMPLIFIED_DTERM_FILTER, SIMPLIFIED_EXPLANATION,
  SIMPLIFIED_GYRO_FILTER, SIMPLIFIED_MORE_SLIDERS, SIMPLIFIED_OFF_CONSEQUENCE,
  SIMPLIFIED_PRIMARY_SLIDERS, SIMPLIFIED_SLIDERS, SIMPLIFIED_SUMMARY,
  SIMPLIFIED_ZERO_FILTER_NOTE, formatEffectiveRange, formatMultiplier,
  generatorOwnedDirectFields, overwriteSummary, simplifiedModeCopy,
} from './simplifiedTuningPresentation';

interface FilterBlockFixture {
  readonly enabled?: boolean;
  readonly multiplier?: number;
  readonly lpf1StaticHz?: number;
  readonly lpf2StaticHz?: number;
  readonly lpf1DynMinHz?: number;
  readonly lpf1DynMaxHz?: number;
}

/** Builds the 53 bytes by hand, in the firmware's own order. */
function tuning(options: {
  readonly modeRaw?: number;
  readonly pids?: Partial<Record<'masterMultiplier' | 'rollPitchRatio' | 'iGain' | 'dGain' | 'piGain' | 'dMaxGain' | 'feedforwardGain' | 'pitchPiGain', number>>;
  readonly dterm?: FilterBlockFixture;
  readonly gyro?: FilterBlockFixture;
} = {}): MspSimplifiedTuning {
  const payload = new Uint8Array(53);
  const view = new DataView(payload.buffer);
  payload[0] = options.modeRaw ?? 2;
  const pids = options.pids ?? {};
  payload[1] = pids.masterMultiplier ?? 100;
  payload[2] = pids.rollPitchRatio ?? 100;
  payload[3] = pids.iGain ?? 100;
  payload[4] = pids.dGain ?? 100;
  payload[5] = pids.piGain ?? 100;
  payload[6] = pids.dMaxGain ?? 100;
  payload[7] = pids.feedforwardGain ?? 100;
  payload[8] = pids.pitchPiGain ?? 100;
  const block = (base: number, spec: FilterBlockFixture | undefined) => {
    payload[base] = (spec?.enabled ?? true) ? 1 : 0;
    payload[base + 1] = spec?.multiplier ?? 100;
    view.setUint16(base + 2, spec?.lpf1StaticHz ?? 0, true);
    view.setUint16(base + 4, spec?.lpf2StaticHz ?? 0, true);
    view.setUint16(base + 6, spec?.lpf1DynMinHz ?? 0, true);
    view.setUint16(base + 8, spec?.lpf1DynMaxHz ?? 0, true);
  };
  block(SIMPLIFIED_PID_BLOCK_BYTES, options.dterm);
  block(SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES, options.gyro);
  return decodeSimplifiedTuning(payload);
}

describe('simplifiedModeCopy', () => {
  it('names the three modes the firmware defines', () => {
    expect(simplifiedModeCopy(classifySimplifiedPidsMode(0))).toEqual({label: 'موقوف', known: true});
    expect(simplifiedModeCopy(classifySimplifiedPidsMode(1)).known).toBe(true);
    expect(simplifiedModeCopy(classifySimplifiedPidsMode(2)).known).toBe(true);
  });

  it('never folds an unknown raw value into OFF', () => {
    // OFF is a CLAIM - that no regeneration is happening. A mode we cannot
    // name is not evidence for that claim.
    const unknown = simplifiedModeCopy(classifySimplifiedPidsMode(7));
    expect(unknown.known).toBe(false);
    expect(unknown.label).toContain('7');
    expect(unknown.label).not.toBe(simplifiedModeCopy(classifySimplifiedPidsMode(0)).label);
  });
});

describe('the sentences that must not soften', () => {
  it('says the flight controller RECALCULATES from the base values, not from the current tune', () => {
    expect(SIMPLIFIED_EXPLANATION).toContain('يعيد');
    expect(SIMPLIFIED_EXPLANATION).toContain('لا من ضبطك الحالي');
    // Neutral by policy, and more accurate: the generator reads the
    // firmware's own compile-time defaults, whatever project built it.
    expect(SIMPLIFIED_SUMMARY).toContain('القيم الافتراضية للبرنامج الثابت');
  });

  it('says switching the feature off does not bring the old values back', () => {
    expect(SIMPLIFIED_EXPLANATION).toContain('لا يعيد قيمك السابقة');
    expect(SIMPLIFIED_OFF_CONSEQUENCE).toContain('لا تعود');
    // "استعادة" / "استرجاع" would describe something the firmware simply
    // does not do: `disableSimplifiedTuning` clears three flags and stops.
    expect(SIMPLIFIED_OFF_CONSEQUENCE).not.toContain('استعادة');
    expect(SIMPLIFIED_OFF_CONSEQUENCE).not.toContain('استرجاع');
  });

  it('tells the pilot a filter already at zero will not be switched on by the multiplier', () => {
    expect(SIMPLIFIED_ZERO_FILTER_NOTE).toContain('معطّل');
    expect(SIMPLIFIED_ZERO_FILTER_NOTE).toContain('لن');
  });

  it('keeps the gyro block marked global and the D-term block marked profile-scoped', () => {
    expect(SIMPLIFIED_GYRO_FILTER.help).toContain('لا يخص ملف الضبط');
    expect(SIMPLIFIED_DTERM_FILTER.help).toContain('ملف الضبط الحالي');
    expect(SIMPLIFIED_GYRO_FILTER.title).not.toBe(SIMPLIFIED_DTERM_FILTER.title);
  });

  it('explains a disabled direct field by naming the generator, not the firmware', () => {
    expect(GENERATOR_OWNED_NOTE).toContain('الضبط المبسّط');
  });
});

describe('formatMultiplier', () => {
  it('renders the stored percentage as the multiplier it is', () => {
    expect(formatMultiplier(100)).toBe('1.00×');
    expect(formatMultiplier(113)).toBe('1.13×');
    expect(formatMultiplier(SIMPLIFIED_TUNING_PIDS_MIN)).toBe('0.00×');
    expect(formatMultiplier(SIMPLIFIED_TUNING_MAX)).toBe('2.00×');
    expect(formatMultiplier(SIMPLIFIED_TUNING_FILTERS_MIN)).toBe('0.10×');
  });

  it('never renders the raw byte as though it were a frequency', () => {
    expect(formatMultiplier(137)).not.toContain('Hz');
    expect(formatMultiplier(137)).toContain('×');
  });
});

describe('formatEffectiveRange', () => {
  it('shows a range when the two frequencies differ and one number when they do not', () => {
    expect(formatEffectiveRange(342, 685)).toBe('342–685 Hz');
    expect(formatEffectiveRange(150, 150)).toBe('150 Hz');
  });
});

describe('sliders', () => {
  it('covers every generator input exactly once', () => {
    const keys = SIMPLIFIED_SLIDERS.map(slider => slider.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([
      'dGain', 'dMaxGain', 'feedforwardGain', 'iGain',
      'masterMultiplier', 'piGain', 'pitchPiGain', 'rollPitchRatio',
    ]);
  });

  it('partitions into primary and secondary with nothing lost or duplicated', () => {
    expect(SIMPLIFIED_PRIMARY_SLIDERS.length + SIMPLIFIED_MORE_SLIDERS.length).toBe(SIMPLIFIED_SLIDERS.length);
    const primary = new Set(SIMPLIFIED_PRIMARY_SLIDERS.map(slider => slider.key));
    expect(SIMPLIFIED_MORE_SLIDERS.every(slider => !primary.has(slider.key))).toBe(true);
  });

  it('never leaks a wire field name onto the screen', () => {
    for (const slider of SIMPLIFIED_SLIDERS) {
      expect(slider.label).not.toMatch(/simplified_|_gain|_ratio/);
      expect(slider.help).not.toMatch(/simplified_|_gain|_ratio/);
      expect(slider.label.length).toBeGreaterThan(0);
      expect(slider.help.length).toBeGreaterThan(0);
    }
  });
});

describe('overwriteSummary', () => {
  it('reports nothing to regenerate when the generator is off', () => {
    const summary = overwriteSummary(tuning({modeRaw: 0, gyro: {enabled: false}, dterm: {enabled: false}}));
    expect(summary.fields).toEqual([]);
    expect(summary.categories).toEqual([]);
    expect(summary.touchesFilters).toBe(false);
  });

  it('answers with the generator\'s own list, never a hand-written one', () => {
    const simplified = tuning({modeRaw: 2});
    expect(summaryFields(simplified)).toEqual([...simplifiedOwnedFields(simplified)]);
  });

  it('leaves yaw alone in RP and includes it in RPY', () => {
    expect(summaryFields(tuning({modeRaw: 1})).some(field => field.startsWith('YAW.'))).toBe(false);
    expect(summaryFields(tuning({modeRaw: 2})).some(field => field.startsWith('YAW.'))).toBe(true);
  });

  it('names the filters as touched only when a filter block is enabled', () => {
    expect(overwriteSummary(tuning({gyro: {enabled: true}, dterm: {enabled: false}})).touchesFilters).toBe(true);
    expect(overwriteSummary(tuning({gyro: {enabled: false}, dterm: {enabled: true}})).touchesFilters).toBe(true);
    expect(overwriteSummary(tuning({gyro: {enabled: false}, dterm: {enabled: false}})).touchesFilters).toBe(false);
  });

  it('lists PID, Feedforward and D Max as separate categories', () => {
    const categories = overwriteSummary(tuning({modeRaw: 2, gyro: {enabled: false}, dterm: {enabled: false}})).categories;
    expect(categories).toContain('PID');
    expect(categories).toContain('Feedforward');
    expect(categories).toContain('D Max');
    expect(categories).not.toContain('الفلاتر');
  });
});

function summaryFields(simplified: MspSimplifiedTuning): readonly string[] {
  return overwriteSummary(simplified).fields;
}

describe('generatorOwnedDirectFields', () => {
  it('owns nothing when no simplified state was read', () => {
    expect(generatorOwnedDirectFields(undefined).size).toBe(0);
  });

  it('owns nothing while the generator is off, so no direct field is disabled for no reason', () => {
    expect(generatorOwnedDirectFields(tuning({modeRaw: 0})).size).toBe(0);
  });

  it('matches the controller\'s own conflict rule field for field', () => {
    const simplified = tuning({modeRaw: 1});
    expect([...generatorOwnedDirectFields(simplified)].sort())
      .toEqual([...simplifiedOwnedFields(simplified)].sort());
  });
});
