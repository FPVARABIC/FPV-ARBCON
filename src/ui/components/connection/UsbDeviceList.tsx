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
  const nothingFound = !scanning && hasScannedOnce && devices.length === 0;

  /**
   * THE PERMISSION STATE, WHICH IS NOT AN ABSENCE OF HARDWARE.
   *
   * navigator.serial.getPorts() lists only ports the operator has already
   * authorized in THIS browser profile. On a first visit it returns zero
   * no matter what is plugged in. A real hardware trace showed exactly
   * this and exactly what it cost: connectionState=ready,
   * authorizedPorts=0, sent=0, received=0 - the app told the operator
   * "لم يتم العثور على جهاز USB", offered «تحديث» as the obvious action
   * (which can only ever return zero again), and left the one control
   * that could have worked as a secondary button underneath a verdict
   * that contradicted it. The board was connected the whole time.
   *
   * So when a browser has no authorized port, this is a PERMISSION state:
   * the chooser is the primary action, it is enabled, and nothing here
   * claims a device is missing.
   */
  const awaitingPermission = nothingFound && onRequestDevice !== undefined;
  const showEmptyState = nothingFound && !awaitingPermission;

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
        <View
          style={[styles.pickerSection, awaitingPermission && styles.pickerSectionPrimary]}
          testID={awaitingPermission ? 'usb-permission-required' : 'usb-picker-section'}
        >
          {awaitingPermission ? (
            <Text style={styles.permissionLead}>{t('devices.permissionLead')}</Text>
          ) : null}
          <Pressable
            testID="usb-request-device-button"
            onPress={requestDeviceDisabled ? undefined : onRequestDevice}
            disabled={requestDeviceDisabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: requestDeviceDisabled }}
            style={[
              styles.pickerButton,
              awaitingPermission && styles.pickerButtonPrimary,
              requestDeviceDisabled && styles.pickerButtonDisabled,
            ]}
          >
            <Text
              style={[
                styles.pickerButtonText,
                awaitingPermission && styles.pickerButtonTextPrimary,
                requestDeviceDisabled && styles.refreshButtonTextDisabled,
              ]}
            >
              {awaitingPermission
                ? t('devices.connectFlightController')
                : t('devices.chooseDevice')}
            </Text>
          </Pressable>
          <Text style={styles.pickerHint}>
            {awaitingPermission
              ? t('devices.permissionHint')
              : t('devices.chooseDeviceHint')}
          </Text>
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
  /* The permission state's own emphasis: this is THE action on the screen
     when a browser has authorized no port, so it reads as a filled primary
     control rather than one option among several. */
  pickerSectionPrimary: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    gap: spacing.sm,
  },
  permissionLead: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  pickerButtonPrimary: {
    alignSelf: 'flex-start',
    minHeight: 48,
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    paddingHorizontal: spacing.lg,
  },
  pickerButtonTextPrimary: {
    color: colors.accentText,
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
