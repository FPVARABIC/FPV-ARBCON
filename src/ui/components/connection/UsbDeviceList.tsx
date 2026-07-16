import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../theme';
import type {UsbSerialDeviceDescriptor} from '../../../platforms/react-native/transport';
import {deviceKey} from './connectionTypes';
import UsbDeviceRow from './UsbDeviceRow';

interface Props {
  devices: UsbSerialDeviceDescriptor[];
  scanning: boolean;
  hasScannedOnce: boolean;
  refreshDisabled: boolean;
  selectedKey: string | null;
  selectionDisabled: boolean;
  onRefresh: () => void;
  onSelectDevice: (device: UsbSerialDeviceDescriptor) => void;
}

export default function UsbDeviceList({
  devices,
  scanning,
  hasScannedOnce,
  refreshDisabled,
  selectedKey,
  selectionDisabled,
  onRefresh,
  onSelectDevice,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const showEmptyState = !scanning && hasScannedOnce && devices.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{t('devices.sectionTitle')}</Text>
        <Pressable
          testID="usb-refresh-button"
          onPress={refreshDisabled ? undefined : onRefresh}
          disabled={refreshDisabled}
          accessibilityRole="button"
          accessibilityLabel={t('accessibility.refresh')}
          accessibilityState={{disabled: refreshDisabled}}
          style={[styles.refreshButton, refreshDisabled && styles.refreshButtonDisabled]}>
          <Text
            style={[
              styles.refreshButtonText,
              refreshDisabled && styles.refreshButtonTextDisabled,
            ]}>
            {t('devices.refresh')}
          </Text>
        </Pressable>
      </View>

      {scanning ? (
        <View style={styles.scanningRow}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.scanningText}>{t('devices.scanning')}</Text>
        </View>
      ) : hasScannedOnce ? (
        <Text style={styles.countText}>
          {t('devices.countLabel', {count: devices.length})}
        </Text>
      ) : (
        <Text style={styles.notScannedText}>{t('devices.notScannedPrompt')}</Text>
      )}

      {showEmptyState ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyPrimary}>{t('devices.emptyPrimary')}</Text>
          <Text style={styles.emptySecondary}>{t('devices.emptySecondary')}</Text>
        </View>
      ) : null}

      {devices.map(device => {
        const key = deviceKey(device);
        return (
          <UsbDeviceRow
            key={key}
            testID={`usb-device-row-${key}`}
            device={device}
            selected={selectedKey === key}
            disabled={selectionDisabled}
            onSelect={() => onSelectDevice(device)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  refreshButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  refreshButtonDisabled: {
    borderColor: colors.disabled,
  },
  refreshButtonText: {
    ...typography.body,
    color: colors.accent,
    fontWeight: '600',
  },
  refreshButtonTextDisabled: {
    color: colors.disabled,
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  scanningText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  countText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  notScannedText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  emptyState: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
  },
  emptyPrimary: {
    ...typography.body,
    color: colors.textPrimary,
  },
  emptySecondary: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});
