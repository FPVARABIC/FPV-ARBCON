import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import type { SerialConfiguration } from '../../../platforms/react-native/transport';

interface Props {
  configuration: SerialConfiguration;
  portCount: number;
  selectedPortIndex: number | null;
  disabled: boolean;
  onSelectPort: (portIndex: number) => void;
}

/**
 * Read-only for this hardware-validation pass (approved choice - see the
 * implementation report): every value openDevice() will actually receive is
 * shown, but none of them are editable yet. Only port selection is
 * interactive, since portCount is the one value that genuinely varies per
 * device.
 */
export default function SerialConfigurationPanel({
  configuration,
  portCount,
  selectedPortIndex,
  disabled,
  onSelectPort,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [technicalOpen, setTechnicalOpen] = useState(false);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>
            {t('serialConfiguration.automaticLabel')}
          </Text>
          <Text style={styles.title}>
            {t('serialConfiguration.sectionTitle')}
          </Text>
        </View>
        <Pressable
          onPress={() => setTechnicalOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: technicalOpen }}
          style={styles.detailsButton}
          testID="serial-technical-toggle"
        >
          <Text style={styles.detailsButtonText}>
            {technicalOpen
              ? t('serialConfiguration.hideTechnical')
              : t('serialConfiguration.showTechnical')}
          </Text>
        </Pressable>
      </View>

      {portCount > 1 ? (
        <View style={styles.portRow}>
          <Text style={styles.portLabel}>{t('ports.selectorLabel')}</Text>
          <View style={styles.portChips}>
            {Array.from({ length: portCount }, (_, index) => index).map(
              index => {
                const selected = selectedPortIndex === index;
                return (
                  <Pressable
                    key={index}
                    testID={`usb-port-chip-${index}`}
                    onPress={disabled ? undefined : () => onSelectPort(index)}
                    disabled={disabled}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled }}
                    accessibilityLabel={`${t('accessibility.selectPort')}: ${t(
                      'ports.portNumber',
                      {
                        number: index + 1,
                      },
                    )}`}
                    style={[
                      styles.portChip,
                      selected && styles.portChipSelected,
                      disabled && styles.portChipDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        styles.portChipText,
                        selected && styles.portChipTextSelected,
                      ]}
                    >
                      {t('ports.portNumber', { number: index + 1 })}
                    </Text>
                  </Pressable>
                );
              },
            )}
          </View>
        </View>
      ) : portCount === 1 ? (
        <ConfigRow
          label={t('ports.selectorLabel')}
          value={t('ports.portNumber', { number: 1 })}
        />
      ) : null}

      <View style={!technicalOpen && styles.technicalHidden}>
        <ConfigRow
          label={t('serialConfiguration.baudRate')}
          value={String(configuration.baudRate)}
          ltr
        />
        <ConfigRow
          label={t('serialConfiguration.dataBits')}
          value={String(configuration.dataBits)}
          ltr
        />
        <ConfigRow
          label={t('serialConfiguration.stopBits')}
          value={configuration.stopBits}
          ltr
        />
        <ConfigRow
          label={t('serialConfiguration.parity')}
          value={
            configuration.parity === 'none'
              ? t('serialConfiguration.parityNone')
              : configuration.parity
          }
        />
        <ConfigRow
          label={t('serialConfiguration.flowControl')}
          value={
            configuration.flowControl === 'off'
              ? t('serialConfiguration.flowControlOff')
              : configuration.flowControl
          }
        />
        <Text style={styles.readOnlyNote}>
          {t('serialConfiguration.readOnlyNote')}
        </Text>
      </View>
    </View>
  );
}

function ConfigRow({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.configRow}>
      <Text style={styles.configLabel}>{label}</Text>
      <Text style={[styles.configValue, ltr && styles.ltr]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.success,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: 2,
  },
  detailsButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  detailsButtonText: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
  },
  technicalHidden: {
    display: 'none',
  },
  configRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  configLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  configValue: {
    ...typography.body,
    color: colors.textPrimary,
  },
  ltr: {
    writingDirection: 'ltr',
    textAlign: 'left',
  },
  readOnlyNote: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  portRow: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  portLabel: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  portChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  portChip: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  portChipSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceAlt,
  },
  portChipDisabled: {
    opacity: 0.5,
  },
  portChipText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  portChipTextSelected: {
    color: colors.accent,
    fontWeight: '600',
  },
});
