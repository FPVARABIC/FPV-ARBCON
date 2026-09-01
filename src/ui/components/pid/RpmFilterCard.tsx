/**
 * THE RPM FILTER CARD - THE ONE PLACE ON THIS SCREEN THAT CHANGES SHAPE
 * WITH THE FIRMWARE'S PROTOCOL VERSION.
 *
 * =====================================================================
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
 * =====================================================================
 *
 * It decides NOTHING about capability. It is handed an `RpmFilterDraft`
 * whose `tail` is either present or `undefined`, and that answer was
 * reached far upstream - from the API version the identification proved,
 * carried on the snapshot, resolved once by `rpmTailInContract`. This
 * component never measures a payload, never counts bytes, and never reads
 * meaning into a value being zero.
 *
 * That matters because a zero here proves nothing at all: from API 1.48
 * the firmware appends the tail to its reply UNCONDITIONALLY, so a board
 * built without the RPM filter compiled in still sends a fade range of 0,
 * a q of 0 and three zero weights. The version says the FIELD EXISTS. It
 * does not say the feature is running.
 *
 * =====================================================================
 * WHAT THE OPERATOR SEES ON AN OLDER BOARD
 * =====================================================================
 *
 * Two real controls and one sentence saying the rest arrive over MSP in
 * newer versions. NOT five disabled inputs showing zero - that would put
 * five numbers on screen that this board never reported, which is the
 * exact invention this whole phase exists to prevent.
 *
 * =====================================================================
 * SCOPE
 * =====================================================================
 *
 * All seven fields are GLOBAL - `PG_RPM_FILTER_CONFIG` is a MASTER_VALUE
 * parameter group. Switching PID profile changes none of them, and the
 * badge says so in the same words the eight advanced groups use.
 */

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {
  rpmFilterBoundFor,
  type RpmFilterDraft,
  type RpmFilterFieldKey,
} from '../../../core/state/rpmFilterFields';
import {RPM_FILTER_COPY, rpmFieldCopy} from '../../presentation/advancedTuningPresentation';
import {Stepper} from '../controls';
import {Icon} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';

export interface RpmFilterCardProps {
  readonly rpm: RpmFilterDraft;
  readonly disabled: boolean;
  /** Lay the controls out in a wrapping row once the viewport can carry it. */
  readonly wide: boolean;
  readonly onChange: (field: RpmFilterFieldKey, value: number) => void;
  readonly testID?: string;
}

function RpmControl({
  field, value, disabled, onChange, testID,
}: {
  field: RpmFilterFieldKey;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  testID: string;
}): React.JSX.Element {
  const copy = rpmFieldCopy(field);
  const bound = rpmFilterBoundFor(field);
  /* CLAMPED TO THE FIRMWARE'S OWN RANGE ON THE WAY IN, because
     MSP_SET_FILTER_CONFIG does not clamp - it REFUSES. A q of 249 or a
     weight of 101 makes the firmware return MSP_RESULT_ERROR rather than
     store the tail, and it does so after the rest of the payload has already
     been applied - so there is no clean failure to report afterwards. The
     control simply never offers a value the board would refuse. */
  const apply = (next: number): void => {
    onChange(Math.min(bound.max, Math.max(bound.min, Math.round(next))));
  };
  return <View style={styles.control} testID={testID}>
    <Text style={styles.label}>{copy.label}</Text>
    <Stepper
      value={String(value)}
      onDecrement={() => apply(value - 1)}
      onIncrement={() => apply(value + 1)}
      decrementDisabled={value <= bound.min}
      incrementDisabled={value >= bound.max}
      disabled={disabled}
      onChangeText={text => {
        const parsed = Number.parseInt(text, 10);
        if (Number.isFinite(parsed)) apply(parsed);
      }}
      accessibilityLabel={copy.label}
      testID={`${testID}-value`}
    />
    <Text style={styles.range}>{`${bound.min} – ${bound.max}`}</Text>
    <Text style={styles.hint}>{copy.hint}</Text>
  </View>;
}

export default function RpmFilterCard({
  rpm, disabled, wide, onChange, testID = 'pid-rpm-filter',
}: RpmFilterCardProps): React.JSX.Element {
  const [detailOpen, setDetailOpen] = useState(false);
  /*
   * ONE DECISION, AND IT IS THIS ONE.
   *
   * The list is built as (field, value) pairs straight off the draft, so
   * the tail's presence is consulted EXACTLY ONCE and every entry carries a
   * real number. An earlier version built a list of field keys and then
   * looked each value up, skipping any that came back `undefined` - two
   * guards saying the same thing, which meant either one could be broken
   * without any behaviour changing. A guarantee that survives its own
   * removal is not a guarantee.
   */
  const controls: ReadonlyArray<{field: RpmFilterFieldKey; value: number}> = [
    {field: 'harmonics', value: rpm.harmonics},
    {field: 'minHz', value: rpm.minHz},
    ...(rpm.tail === undefined ? [] : [
      {field: 'fadeRangeHz' as const, value: rpm.tail.fadeRangeHz},
      {field: 'q' as const, value: rpm.tail.q},
      {field: 'weight1' as const, value: rpm.tail.weights[0]},
      {field: 'weight2' as const, value: rpm.tail.weights[1]},
      {field: 'weight3' as const, value: rpm.tail.weights[2]},
    ]),
  ];
  return <View style={styles.card} testID={testID}>
    <View style={styles.heading}>
      <Text style={styles.title}>{RPM_FILTER_COPY.title}</Text>
      <Text style={styles.scope} testID={`${testID}-scope`}>{RPM_FILTER_COPY.scopeBadge}</Text>
    </View>
    <Text style={styles.hint}>{RPM_FILTER_COPY.hint}</Text>
    {/* A HARMONICS OF ZERO IS THE FIRMWARE'S OWN "OFF" SWITCH, said plainly
        rather than left for the operator to infer from a stopped filter. */}
    {rpm.harmonics === 0
      ? <Text style={styles.note} testID={`${testID}-disabled-note`}>{RPM_FILTER_COPY.disabledNote}</Text>
      : null}
    {/* THE WEIGHTS STACK VERTICALLY ON A PHONE (§14). `fieldsWide` is the
        only layout that puts them side by side, and it is applied only
        when the viewport was measured wide enough to carry it - there is
        no fixed-width row here that could push the page sideways. */}
    <View style={[styles.fields, wide && styles.fieldsWide]} testID={`${testID}-fields`}>
      {controls.map(({field, value}) => <RpmControl
        key={field}
        field={field}
        value={value}
        disabled={disabled}
        onChange={next => onChange(field, next)}
        testID={`${testID}-${field}`}
      />)}
    </View>
    {rpm.tail === undefined
      ? <Text style={styles.note} testID={`${testID}-tail-absent`}>{RPM_FILTER_COPY.tailAbsentNote}</Text>
      : null}
    {/* §31: wire names and firmware bounds live behind «التفاصيل التقنية»,
        exactly as they do for the eight advanced groups. This is the same
        disclosure pattern the tier already uses, not a second one. */}
    <Pressable
      onPress={() => setDetailOpen(value => !value)}
      accessibilityRole="button"
      accessibilityState={{expanded: detailOpen}}
      accessibilityLabel={RPM_FILTER_COPY.detailTitle}
      style={styles.detailToggle}
      testID={`${testID}-detail-toggle`}>
      <Text style={styles.detailToggleText}>{RPM_FILTER_COPY.detailTitle}</Text>
      <Icon name={detailOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
    </Pressable>
    {detailOpen ? <View style={styles.detail} testID={`${testID}-detail`}>
      <Text style={styles.detailText}>{RPM_FILTER_COPY.detail}</Text>
      {controls.map(({field}) => {
        const copy = rpmFieldCopy(field);
        const bound = rpmFilterBoundFor(field);
        return <Text key={field} style={styles.detailName}>
          {`${copy.label} — ${copy.wireName} (${bound.min}…${bound.max})`}
        </Text>;
      })}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  heading: {gap: 2},
  title: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  scope: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  fields: {gap: spacing.sm},
  fieldsWide: {flexDirection: 'row', flexWrap: 'wrap'},
  control: {gap: 4, flexGrow: 1, flexShrink: 1, flexBasis: 160},
  label: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  range: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  hint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  note: {...typography.caption, color: colors.textSecondary, textAlign: 'right'},
  detailToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    minHeight: 44,
  },
  detailToggleText: {...typography.caption, color: colors.textMuted},
  detail: {gap: 2},
  detailName: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  detailText: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
});
