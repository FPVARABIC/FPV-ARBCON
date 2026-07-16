import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../theme';
import type {SerialConfiguration} from '../../../platforms/react-native/transport';

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
  const {t} = useTranslation();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('serialConfiguration.sectionTitle')}</Text>

      {portCount > 1 ? (
        <View style={styles.portRow}>
          <Text style={styles.portLabel}>{t('ports.selectorLabel')}</Text>
          <View style={styles.portChips}>
            {Array.from({length: portCount}, (_, index) => index).map(index => {
              const selected = selectedPortIndex === index;
              return (
                <Pressable
                  key={index}
                  testID={`usb-port-chip-${index}`}
                  onPress={disabled ? undefined : () => onSelectPort(index)}
                  disabled={disabled}
                  accessibilityRole="radio"
                  accessibilityState={{selected, disabled}}
                  accessibilityLabel={`${t('accessibility.selectPort')}: ${t('ports.portNumber', {
                    number: index + 1,
                  })}`}
                  style={[
                    styles.portChip,
                    selected && styles.portChipSelected,
                    disabled && styles.portChipDisabled,
                  ]}>
                  <Text
                    style={[styles.portChipText, selected && styles.portChipTextSelected]}>
                    {t('ports.portNumber', {number: index + 1})}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : portCount === 1 ? (
        <ConfigRow label={t('ports.selectorLabel')} value={t('ports.portNumber', {number: 1})} />
      ) : null}

      <ConfigRow label={t('serialConfiguration.baudRate')} value={String(configuration.baudRate)} ltr />
      <ConfigRow label={t('serialConfiguration.dataBits')} value={String(configuration.dataBits)} ltr />
      <ConfigRow label={t('serialConfiguration.stopBits')} value={configuration.stopBits} ltr />
      <ConfigRow
        label={t('serialConfiguration.parity')}
        value={configuration.parity === 'none' ? t('serialConfiguration.parityNone') : configuration.parity}
      />
      <ConfigRow
        label={t('serialConfiguration.flowControl')}
        value={
          configuration.flowControl === 'off'
            ? t('serialConfiguration.flowControlOff')
            : configuration.flowControl
        }
      />

      <Text style={styles.readOnlyNote}>{t('serialConfiguration.readOnlyNote')}</Text>
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
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
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
