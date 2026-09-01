/**
 * The select — a labelled trigger that opens a MODAL option sheet.
 *
 * WHY A MODAL SHEET AND NOT AN ANCHORED DROPDOWN: the class of defect
 * this replaces was "opening a control covers its own field label" —
 * anchored popovers must win at z-index, clipping, RTL mirroring and
 * viewport-edge math on every screen that embeds them, and losing any
 * one of those reproduces the bug. A modal sheet renders above the
 * screen in its own layer with a backdrop; it CANNOT collide with the
 * field, the label, or neighbouring rows, on any width, in any
 * direction. react-native-web implements Modal as a document-level
 * portal, so the guarantee holds identically in the browser.
 *
 * The sheet repeats the field label as its title, so the operator never
 * loses WHAT they are choosing — the exact information the old
 * overlapping dropdowns destroyed.
 */
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Icon} from '../../icons';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../../theme';
import {IconButton} from './IconButton';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export interface SelectOption<K extends string = string> {
  key: K;
  label: string;
  /** Secondary line under the label — e.g. a technical identifier. */
  description?: string;
  disabled?: boolean;
}

export interface SelectFieldProps<K extends string = string> {
  label: string;
  options: ReadonlyArray<SelectOption<K>>;
  selectedKey: K | null;
  onSelect: (key: K) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Optional helper line under the field. */
  helper?: string;
  testID?: string;
}

export function SelectField<K extends string = string>({
  label,
  options,
  selectedKey,
  onSelect,
  placeholder = 'اختر…',
  disabled = false,
  helper,
  testID,
}: SelectFieldProps<K>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const selected = options.find(o => o.key === selectedKey) ?? null;

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{text: selected ? selected.label : placeholder}}
        accessibilityState={{disabled, expanded: open}}
        testID={testID}
        style={state => {
          const {pressed, hovered} = readInteraction(state);
          return [
            styles.trigger,
            hovered && !disabled && styles.triggerHovered,
            pressed && !disabled && styles.triggerPressed,
            disabled && styles.triggerDisabled,
          ];
        }}>
        <Text
          style={[
            typography.bodyStrong,
            styles.triggerText,
            !selected && styles.placeholderText,
            disabled && styles.disabledText,
          ]}
          numberOfLines={1}>
          {selected ? selected.label : placeholder}
        </Text>
        <Icon
          name="chevrons-up-down"
          size={18}
          color={disabled ? colors.textMuted : colors.textSecondary}
        />
      </Pressable>
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}>
        <View style={styles.backdropLayer}>
          <Pressable
            style={styles.backdrop}
            accessibilityLabel="إغلاق القائمة"
            onPress={() => setOpen(false)}
          />
          <View style={styles.sheet} testID={testID ? `${testID}-sheet` : undefined}>
            <View style={styles.sheetHeader}>
              <Text style={[typography.sectionTitle, styles.sheetTitle]}>
                {label}
              </Text>
              <IconButton
                icon="x"
                accessibilityLabel="إغلاق"
                onPress={() => setOpen(false)}
              />
            </View>
            <ScrollView
              style={styles.optionScroll}
              contentContainerStyle={styles.optionList}>
              {options.map(option => {
                const isSelected = option.key === selectedKey;
                const optionDisabled = option.disabled === true;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => {
                      setOpen(false);
                      if (!isSelected) {
                        onSelect(option.key);
                      }
                    }}
                    disabled={optionDisabled}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{
                      selected: isSelected,
                      disabled: optionDisabled,
                    }}
                    aria-checked={isSelected}
                    aria-disabled={optionDisabled}
                    testID={
                      testID ? `${testID}-option-${option.key}` : undefined
                    }
                    style={state => {
                      const {pressed, hovered} = readInteraction(state);
                      return [
                        styles.option,
                        isSelected && styles.optionSelected,
                        hovered && !optionDisabled && styles.optionHovered,
                        pressed && !optionDisabled && styles.optionPressed,
                      ];
                    }}>
                    <View style={styles.optionTextColumn}>
                      <Text
                        style={[
                          typography.bodyStrong,
                          styles.optionLabel,
                          isSelected && styles.optionLabelSelected,
                          optionDisabled && styles.disabledText,
                        ]}>
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text style={[typography.caption, styles.optionDescription]}>
                          {option.description}
                        </Text>
                      ) : null}
                    </View>
                    {isSelected ? (
                      <Icon name="check" size={20} color={colors.accentStrong} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 6,
  },
  label: {
    ...typography.label,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  triggerHovered: {backgroundColor: colors.surfaceHover},
  triggerPressed: {backgroundColor: colors.surfacePressed},
  triggerDisabled: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSoft,
  },
  triggerText: {
    flex: 1,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  placeholderText: {
    color: colors.textMuted,
    fontWeight: '400',
  },
  disabledText: {color: colors.textMuted},
  helper: {
    ...typography.helper,
    color: colors.textMuted,
    textAlign: 'right', maxWidth: PROSE_MEASURE},
  backdropLayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(21, 34, 50, 0.45)',
  },
  sheet: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '78%',
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingStart: spacing.lg,
    paddingEnd: spacing.xs,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  sheetTitle: {
    flex: 1,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  optionScroll: {
    flexGrow: 0,
  },
  optionList: {
    padding: spacing.sm,
    gap: 2,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET + 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
  },
  optionSelected: {backgroundColor: colors.accentSoft},
  optionHovered: {backgroundColor: colors.surfaceHover},
  optionPressed: {backgroundColor: colors.surfacePressed},
  optionTextColumn: {
    flex: 1,
    gap: 1,
  },
  optionLabel: {
    color: colors.textPrimary,
    textAlign: 'right',
  },
  optionLabelSelected: {color: colors.accentStrong},
  optionDescription: {
    color: colors.textMuted,
    textAlign: 'right',
  },
});
