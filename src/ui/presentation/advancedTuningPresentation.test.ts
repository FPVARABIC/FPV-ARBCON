/**
 * THE EXPERT TIER'S COPY, HELD TO THE CATALOGUE IT DESCRIBES.
 *
 * Two tables that must agree - the fields the app can WRITE and the words
 * it shows for them - are exactly the pair that drifts. These tests make
 * a field with no copy, and copy for a field that does not exist, both
 * failures rather than surprises at runtime.
 */

import {
  ADVANCED_FILTER_BOUNDS,
  type AdvancedFilterFieldKey,
} from '../../core/state/advancedFilterFields';
import {
  ADVANCED_PID_BOUNDS,
  type AdvancedPidFieldKey,
} from '../../core/state/advancedPidFields';
import {
  ADVANCED_CATALOGUE_FIELDS,
  ADVANCED_GROUPS,
  ADVANCED_PRESENTED_FIELDS,
  RPM_FILTER_COPY,
  advancedFieldCopy,
} from './advancedTuningPresentation';

/** Wire names, which may appear ONLY in the technical detail. */
const WIRE_NAME_SHAPE = /^[a-z][a-z0-9_]*$/;

describe('advanced tuning presentation', () => {
  it('presents every field the app can write, and no field it cannot', () => {
    expect([...ADVANCED_PRESENTED_FIELDS].sort()).toEqual([...ADVANCED_CATALOGUE_FIELDS].sort());
  });

  it('presents each field exactly once', () => {
    expect(new Set(ADVANCED_PRESENTED_FIELDS).size).toBe(ADVANCED_PRESENTED_FIELDS.length);
  });

  it('gives every field a label, a hint and a technical detail', () => {
    for (const field of ADVANCED_CATALOGUE_FIELDS) {
      const copy = advancedFieldCopy(field);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.hint.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
      expect(copy.wireName).toMatch(WIRE_NAME_SHAPE);
    }
  });

  it('never uses a raw wire name as the primary label', () => {
    // §31: `d_max_gain` may appear in the technical details. It may not be
    // the words a pilot reads beside the control.
    for (const field of ADVANCED_CATALOGUE_FIELDS) {
      const copy = advancedFieldCopy(field);
      expect(copy.label).not.toMatch(WIRE_NAME_SHAPE);
      expect(copy.label).not.toContain('_');
      expect(copy.hint).not.toContain('_');
    }
  });

  it('keeps the terms pilots already use', () => {
    // §30: translating these would make every tuning guide unusable.
    expect(advancedFieldCopy('dMaxRoll').label).toContain('D Max');
    expect(advancedFieldCopy('tpaMode').label).toContain('TPA');
    expect(advancedFieldCopy('feedforwardTransition').label).toContain('Feedforward');
    expect(advancedFieldCopy('gyroLpf1Type').label).toContain('Gyro');
    expect(advancedFieldCopy('dtermLpf1Type').label).toContain('D-term');
    expect(RPM_FILTER_COPY.title).toContain('RPM');
  });

  it('says what D Max IS, so it cannot be read as a second D', () => {
    // §7 in as many words: "D Max is NOT another D value."
    expect(advancedFieldCopy('dMaxRoll').detail).toContain('ليس قيمة D ثانية');
  });

  it('names the auto-profile sentinels rather than offering a bare number', () => {
    const copy = advancedFieldCopy('autoProfileCellCount');
    expect(copy.choices?.map(choice => choice.value)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(copy.choices?.[0].label).not.toMatch(/^-?\d+$/);
  });

  describe('choices', () => {
    it('offers a choice list for exactly the fields the firmware makes a lookup', () => {
      for (const field of ADVANCED_CATALOGUE_FIELDS) {
        const bound =
          field in ADVANCED_PID_BOUNDS
            ? ADVANCED_PID_BOUNDS[field as AdvancedPidFieldKey]
            : ADVANCED_FILTER_BOUNDS[field as AdvancedFilterFieldKey];
        expect(advancedFieldCopy(field).choices === undefined).toBe(bound.choices === undefined);
      }
    });

    it('offers exactly the values the bound allows, and no others', () => {
      for (const field of ADVANCED_CATALOGUE_FIELDS) {
        const copy = advancedFieldCopy(field);
        if (copy.choices === undefined) continue;
        const bound =
          field in ADVANCED_PID_BOUNDS
            ? ADVANCED_PID_BOUNDS[field as AdvancedPidFieldKey]
            : ADVANCED_FILTER_BOUNDS[field as AdvancedFilterFieldKey];
        expect(copy.choices.map(choice => choice.value)).toEqual([...(bound.choices ?? [])]);
      }
    });

    it('labels all four lowpass types, PT3 included', () => {
      expect(advancedFieldCopy('gyroLpf2Type').choices?.map(choice => choice.label))
        .toEqual(['PT1', 'BIQUAD', 'PT2', 'PT3']);
    });
  });

  describe('groups', () => {
    it('states the SCOPE of each group, so two lifetimes are never implied to be one', () => {
      // §13: the screen may show them together; it may not call them the
      // same thing. The gyro chain is global; the D-term chain is not.
      const byKey = new Map(ADVANCED_GROUPS.map(group => [group.key, group]));
      expect(byKey.get('GYRO_FILTERS')?.scope).toBe('GLOBAL');
      expect(byKey.get('DTERM_FILTERS')?.scope).toBe('PID_PROFILE');
      expect(byKey.get('D_MAX')?.scope).toBe('PID_PROFILE');
    });

    it('gives a group scope that matches every filter field inside it', () => {
      for (const group of ADVANCED_GROUPS) {
        for (const field of group.fields) {
          const bound = ADVANCED_FILTER_BOUNDS[field as AdvancedFilterFieldKey];
          if (bound === undefined) continue;
          expect(bound.scope).toBe(group.scope);
        }
      }
    });

    it('gives every group a title and a hint, and no group is empty', () => {
      for (const group of ADVANCED_GROUPS) {
        expect(group.title.length).toBeGreaterThan(0);
        expect(group.hint.length).toBeGreaterThan(0);
        expect(group.fields.length).toBeGreaterThan(0);
      }
    });

    it('keeps the tier to a handful of groups rather than a wall of controls', () => {
      // §29. If this ever needs raising, the page needs rethinking, not
      // the number.
      expect(ADVANCED_GROUPS.length).toBeLessThanOrEqual(8);
    });
  });

  it('explains WHY the RPM filter is read-only instead of just disabling it', () => {
    expect(RPM_FILTER_COPY.readOnlyReason).toContain('1.48');
    // And why the 1.48 tail is not DISPLAYED either: deciding it is there
    // from the payload length would be a guess (§12).
    expect(RPM_FILTER_COPY.readOnlyReason).toContain('تخمينًا');
  });
});
