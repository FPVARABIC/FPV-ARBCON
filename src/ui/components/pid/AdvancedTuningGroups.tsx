/**
 * THE EXPERT TIER, AS A SHORT LIST OF GROUPS RATHER THAN A WALL.
 *
 * =====================================================================
 * WHY THIS IS NOT JUST FORTY MORE FIELDS ON THE PAGE
 * =====================================================================
 *
 * P-E §29 is explicit: the point is not to make the page look
 * complicated. Opening «الإعدادات المتقدمة» must not drop forty controls
 * into a phone screen. So the tier is a list of GROUP HEADERS - eight of
 * them, each one line - and a group opens only when the operator asks for
 * it. Everything is still there; nothing is more than one tap away; and
 * the page stays navigable.
 *
 * §3 forbids scattering five different "advanced" disclosures around the
 * screen, and this does not: there is still exactly ONE entry point on
 * the page. What is inside it is structured, which is the opposite
 * problem from being scattered.
 *
 * =====================================================================
 * WHAT EACH GROUP SAYS ABOUT ITSELF
 * =====================================================================
 *
 * Its SCOPE, always. MSP_FILTER_CONFIG carries two lifetimes in one
 * command - the gyro chain is global, the D-term chain belongs to this
 * PID profile - and a screen that shows them side by side without saying
 * so is teaching the operator something false (§13). The badge is not
 * decoration; it is the difference between changing one tune and changing
 * every tune on the board.
 *
 * Its TECHNICAL DETAIL, on request. Wire names, firmware bounds and the
 * settings.c row each bound came from live behind «التفاصيل التقنية» and
 * never in the label (§31).
 *
 * =====================================================================
 * WHAT IT REFUSES TO DO
 * =====================================================================
 *
 * A field the active simplified generator owns is DISABLED here, with the
 * reason written next to it. It is not silently editable-and-then-
 * overwritten, and it is not greyed out with no explanation (§5).
 */

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {
  ADVANCED_FILTER_BOUNDS,
  type AdvancedFilterDraft,
  type AdvancedFilterFieldKey,
} from '../../../core/state/advancedFilterFields';
import {
  ADVANCED_PID_BOUNDS,
  type AdvancedPidDraft,
  type AdvancedPidFieldKey,
} from '../../../core/state/advancedPidFields';
import {
  ADVANCED_GROUPS,
  advancedFieldCopy,
  type AdvancedFieldKey,
  type AdvancedGroup,
} from '../../presentation/advancedTuningPresentation';
import {ChoiceChips, Stepper} from '../controls';
import {Icon} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';

/**
 * Which generator-owned name a field answers to.
 *
 * The conflict detector speaks the generator's vocabulary - `ROLL.D_MAX`,
 * `gyroLpf2StaticHz` - and this is the only place that translates a draft
 * key into it. Anything absent here is simply not generator-owned.
 */
const GENERATOR_NAME: Partial<Record<AdvancedFieldKey, string>> = Object.freeze({
  dMaxRoll: 'ROLL.D_MAX',
  dMaxPitch: 'PITCH.D_MAX',
  dMaxYaw: 'YAW.D_MAX',
  gyroLpf2StaticHz: 'gyroLpf2StaticHz',
  dtermLpf2StaticHz: 'dtermLpf2StaticHz',
});

const SCOPE_BADGE = Object.freeze({
  PID_PROFILE: 'يخصّ ملف PID الحالي',
  GLOBAL: 'مشترك بين كل الملفات',
});

export const GENERATOR_OWNED_FIELD_NOTE =
  'الضبط المبسّط نشط ويولّد هذه القيمة؛ تعديلها هنا سيُلغى عند الحفظ.';

export interface AdvancedTuningGroupsProps {
  readonly advanced: AdvancedPidDraft;
  readonly filters: AdvancedFilterDraft;
  readonly disabled: boolean;
  /** Two balanced columns when the viewport can carry them (§27). */
  readonly wide: boolean;
  /** Generator-owned names, in the conflict detector's vocabulary. */
  readonly ownedFields: ReadonlySet<string>;
  readonly onChangeAdvanced: (field: AdvancedPidFieldKey, value: number) => void;
  readonly onChangeFilter: (field: AdvancedFilterFieldKey, value: number) => void;
  readonly testID?: string;
}

function boundFor(field: AdvancedFieldKey): {min: number; max: number; choices?: readonly number[]} {
  return field in ADVANCED_PID_BOUNDS
    ? ADVANCED_PID_BOUNDS[field as AdvancedPidFieldKey]
    : ADVANCED_FILTER_BOUNDS[field as AdvancedFilterFieldKey];
}

function AdvancedControl({
  field, value, disabled, ownedReason, onChange, testID,
}: {
  field: AdvancedFieldKey;
  value: number;
  disabled: boolean;
  ownedReason?: string;
  onChange: (value: number) => void;
  testID: string;
}): React.JSX.Element {
  const copy = advancedFieldCopy(field);
  const bound = boundFor(field);
  const locked = disabled || ownedReason !== undefined;
  const apply = (next: number): void => {
    onChange(Math.min(bound.max, Math.max(bound.min, Math.round(next))));
  };
  return <View style={styles.control} testID={testID}>
    <Text style={styles.label}>{copy.label}</Text>
    {copy.choices === undefined
      ? <>
        <Stepper
          value={String(value)}
          onDecrement={() => apply(value - 1)}
          onIncrement={() => apply(value + 1)}
          decrementDisabled={value <= bound.min}
          incrementDisabled={value >= bound.max}
          disabled={locked}
          onChangeText={text => {
            const parsed = Number.parseInt(text, 10);
            if (Number.isFinite(parsed)) apply(parsed);
          }}
          accessibilityLabel={copy.label}
          testID={`${testID}-value`}
        />
        <Text style={styles.range}>{`${bound.min} – ${bound.max}`}</Text>
      </>
      : <ChoiceChips
        options={copy.choices.map(choice => ({key: String(choice.value), label: choice.label}))}
        selectedKey={String(value)}
        onSelect={key => {
          const parsed = Number.parseInt(key, 10);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        disabled={locked}
        accessibilityLabel={copy.label}
        testID={`${testID}-choices`}
      />}
    <Text style={styles.hint}>{copy.hint}</Text>
    {ownedReason === undefined
      ? null
      : <Text style={styles.owned} testID={`${testID}-owned`}>{ownedReason}</Text>}
  </View>;
}

function GroupCard({
  group, advanced, filters, disabled, wide, ownedFields, onChangeAdvanced, onChangeFilter, testID,
}: {
  group: AdvancedGroup;
} & AdvancedTuningGroupsProps & {testID: string}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  return <View style={[styles.group, wide && styles.groupWide]} testID={testID}>
    <Pressable
      onPress={() => setOpen(value => !value)}
      accessibilityRole="button"
      accessibilityState={{expanded: open}}
      accessibilityLabel={group.title}
      style={styles.groupHeader}
      testID={`${testID}-toggle`}>
      <View style={styles.groupHeading}>
        <Text style={styles.groupTitle}>{group.title}</Text>
        <Text style={styles.groupScope} testID={`${testID}-scope`}>{SCOPE_BADGE[group.scope]}</Text>
      </View>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accentStrong} />
    </Pressable>
    {open ? <View style={styles.groupBody} testID={`${testID}-body`}>
      <Text style={styles.groupHint}>{group.hint}</Text>
      <View style={[styles.fields, wide && styles.fieldsWide]}>
        {group.fields.map(field => {
          const generatorName = GENERATOR_NAME[field];
          const owned = generatorName !== undefined && ownedFields.has(generatorName);
          return field in ADVANCED_PID_BOUNDS
            ? <AdvancedControl
              key={field}
              field={field}
              value={advanced[field as AdvancedPidFieldKey]}
              disabled={disabled}
              ownedReason={owned ? GENERATOR_OWNED_FIELD_NOTE : undefined}
              onChange={next => onChangeAdvanced(field as AdvancedPidFieldKey, next)}
              testID={`pid-advanced-${field}`}
            />
            : <AdvancedControl
              key={field}
              field={field}
              value={filters[field as AdvancedFilterFieldKey]}
              disabled={disabled}
              ownedReason={owned ? GENERATOR_OWNED_FIELD_NOTE : undefined}
              onChange={next => onChangeFilter(field as AdvancedFilterFieldKey, next)}
              testID={`pid-advanced-${field}`}
            />;
        })}
      </View>
      {/* §31: raw wire names and firmware rows belong HERE and nowhere
          else on the page. */}
      <Pressable
        onPress={() => setDetailOpen(value => !value)}
        accessibilityRole="button"
        accessibilityState={{expanded: detailOpen}}
        accessibilityLabel="التفاصيل التقنية"
        style={styles.detailToggle}
        testID={`${testID}-detail-toggle`}>
        <Text style={styles.detailToggleText}>التفاصيل التقنية</Text>
        <Icon name={detailOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
      </Pressable>
      {detailOpen ? <View style={styles.detail} testID={`${testID}-detail`}>
        {group.fields.map(field => {
          const copy = advancedFieldCopy(field);
          const bound = boundFor(field);
          return <View key={field} style={styles.detailRow}>
            <Text style={styles.detailName}>{`${copy.label} — ${copy.wireName} (${bound.min}…${bound.max})`}</Text>
            <Text style={styles.detailText}>{copy.detail}</Text>
          </View>;
        })}
      </View> : null}
    </View> : null}
  </View>;
}

export default function AdvancedTuningGroups(
  props: AdvancedTuningGroupsProps,
): React.JSX.Element {
  const testID = props.testID ?? 'pid-advanced-groups';
  const card = (group: AdvancedGroup): React.JSX.Element => (
    <GroupCard
      key={group.key}
      group={group}
      {...props}
      testID={`${testID}-${group.key}`}
    />
  );
  if (!props.wide) {
    return <View style={styles.root} testID={testID}>{ADVANCED_GROUPS.map(card)}</View>;
  }
  /*
   * TWO INDEPENDENT COLUMNS, NOT A WRAPPING ROW.
   *
   * A wrapped row couples the two cards that share a row: opening one to
   * 500px leaves its partner's cell 500px tall with 420px of blank
   * underneath. Two columns that flow separately have no such coupling,
   * so an open group pushes only the groups BELOW IT in its own column -
   * which is what "balanced" has to mean once the contents can change
   * height (§27).
   */
  const columns: AdvancedGroup[][] = [[], []];
  ADVANCED_GROUPS.forEach((group, index) => columns[index % 2].push(group));
  return <View style={styles.rootWide} testID={testID}>
    {columns.map((groups, index) => (
      <View key={index} style={styles.column} testID={`${testID}-column-${index}`}>
        {groups.map(card)}
      </View>
    ))}
  </View>;
}

const styles = StyleSheet.create({
  root: {gap: spacing.sm},
  /* TWO BALANCED COLUMNS ON DESKTOP (§27). The groups are independent
     cards of similar height, so a wrapping row balances without any
     per-column bookkeeping - and collapses back to one column the moment
     the viewport cannot carry two. */
  rootWide: {flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm},
  column: {flex: 1, gap: spacing.sm},
  group: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  /* The column container already fixes the width; the card only needs to
     fill it. An explicit flex-basis here would fight the column. */
  groupWide: {alignSelf: 'stretch'},
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    /* ≥44px touch target (§28) without a fixed height that could clip a
       long title at a large font scale. */
    paddingVertical: spacing.sm + 2,
    minHeight: 48,
  },
  groupHeading: {flex: 1, gap: 2},
  groupTitle: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  groupScope: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  groupBody: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  groupHint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  fields: {gap: spacing.sm},
  fieldsWide: {flexDirection: 'row', flexWrap: 'wrap'},
  control: {gap: 4, flexGrow: 1, flexShrink: 1, flexBasis: 160},
  label: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  range: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  hint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  owned: {...typography.caption, color: colors.warning, textAlign: 'right'},
  detailToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    minHeight: 44,
  },
  detailToggleText: {...typography.caption, color: colors.textMuted},
  detail: {gap: spacing.sm},
  detailRow: {gap: 2},
  detailName: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  detailText: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
});
