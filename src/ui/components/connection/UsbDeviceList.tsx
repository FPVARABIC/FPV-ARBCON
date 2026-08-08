import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import type { UsbSerialDeviceDescriptor } from '../../../platforms/react-native/transport';
import { deviceKey } from './connectionTypes';
import UsbDeviceRow from './UsbDeviceRow';
import { connectionCopyKeys } from './connectionCopy';

interface Props {
  devices: UsbSerialDeviceDescriptor[];
  scanning: boolean;
  hasScannedOnce: boolean;
  refreshDisabled: boolean;
  selectedKey: string | null;
  selectionDisabled: boolean;
  onRefresh: () => void;
  onSelectDevice: (device: UsbSerialDeviceDescriptor) => void;
  /**
   * THE BROWSER'S EXPLICIT DEVICE CHOOSER, and the reason it is optional.
   *
   * A browser will not list a serial port until the user has picked it
   * once from the browser's own chooser, and that chooser may only be
   * opened from a real user gesture. So on Web this button is not a
   * convenience - without it the ordinary scan finds nothing on a first
   * visit and the app can never reach a first connection.
   *
   * Android has no equivalent: its permission dialog is raised by the
   * system during open(). It passes nothing here, the button is not
   * rendered, and the screen is unchanged.
   */
  onRequestDevice?: () => void;
  requestDeviceDisabled?: boolean;
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
  onRequestDevice,
  requestDeviceDisabled = false,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const copyKeys = connectionCopyKeys(Platform.OS);
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
          accessibilityState={{ disabled: refreshDisabled }}
          style={[
            styles.refreshButton,
            refreshDisabled && styles.refreshButtonDisabled,
          ]}
        >
          <Text
            style={[
              styles.refreshButtonText,
              refreshDisabled && styles.refreshButtonTextDisabled,
            ]}
          >
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
          {t('devices.countLabel', { count: devices.length })}
        </Text>
      ) : (
        <Text style={styles.notScannedText}>
          {t('devices.notScannedPrompt')}
        </Text>
      )}

      {onRequestDevice ? (
        <View style={styles.pickerSection}>
          <Pressable
            testID="usb-request-device-button"
            onPress={requestDeviceDisabled ? undefined : onRequestDevice}
            disabled={requestDeviceDisabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: requestDeviceDisabled }}
            style={[
              styles.pickerButton,
              requestDeviceDisabled && styles.pickerButtonDisabled,
            ]}
          >
            <Text
              style={[
                styles.pickerButtonText,
                requestDeviceDisabled && styles.refreshButtonTextDisabled,
              ]}
            >
              {t('devices.chooseDevice')}
            </Text>
          </Pressable>
          <Text style={styles.pickerHint}>{t('devices.chooseDeviceHint')}</Text>
        </View>
      ) : null}

      {showEmptyState ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyPrimary}>{t('devices.emptyPrimary')}</Text>
          <Text style={styles.emptySecondary}>
            {t(copyKeys.emptySecondary)}
          </Text>
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
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
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
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  refreshButtonDisabled: {
    borderColor: colors.disabled,
    backgroundColor: colors.backgroundRaised,
  },
  refreshButtonText: {
    ...typography.body,
    color: colors.accentStrong,
    fontWeight: '600',
  },
  refreshButtonTextDisabled: {
    color: colors.disabled,
  },
  pickerSection: {
    marginTop: spacing.md,
    gap: spacing.xs,
  },
  pickerButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.sm,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pickerButtonDisabled: {
    borderColor: colors.disabled,
    backgroundColor: colors.backgroundRaised,
  },
  pickerButtonText: {
    ...typography.body,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  pickerHint: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
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
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
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
