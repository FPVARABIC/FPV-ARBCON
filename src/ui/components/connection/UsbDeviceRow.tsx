import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../theme';
import {isSupportedDevice} from '../../../platforms/react-native/transport';
import type {UsbSerialDeviceDescriptor} from '../../../platforms/react-native/transport';
import {formatHex} from './format';

interface Props {
  device: UsbSerialDeviceDescriptor;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  testID?: string;
}

export default function UsbDeviceRow({
  device,
  selected,
  disabled,
  onSelect,
  testID,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const supported = isSupportedDevice(device);
  const selectable = supported && !disabled;

  return (
    <Pressable
      testID={testID}
      onPress={selectable ? onSelect : undefined}
      accessibilityRole="radio"
      accessibilityState={{selected, disabled: !selectable}}
      accessibilityLabel={`${t('accessibility.selectDevice')}: ${
        device.productName ?? t('devices.unknownProductName')
      }`}
      style={[
        styles.row,
        selected && styles.rowSelected,
        !supported && styles.rowUnsupported,
      ]}>
      <View style={styles.headerLine}>
        <Text style={styles.productName} numberOfLines={1}>
          {device.productName ?? t('devices.unknownProductName')}
        </Text>
        <View
          style={[
            styles.statusBadge,
            {borderColor: supported ? colors.success : colors.disabled},
          ]}>
          <Text
            style={[
              styles.statusText,
              {color: supported ? colors.success : colors.textSecondary},
            ]}>
            {supported ? t('devices.supported') : t('devices.unsupported')}
          </Text>
        </View>
        {selected ? (
          <View style={styles.selectedBadge}>
            <Text style={styles.selectedBadgeText}>{t('devices.selectedBadge')}</Text>
          </View>
        ) : null}
      </View>

      {device.manufacturerName ? (
        <Text style={styles.manufacturer} numberOfLines={1}>
          {device.manufacturerName}
        </Text>
      ) : null}

      <View style={styles.detailsGrid}>
        <DetailItem label={t('devices.driverType')} value={device.driverType} />
        <DetailItem label={t('devices.vid')} value={formatHex(device.vendorId)} ltr />
        <DetailItem label={t('devices.pid')} value={formatHex(device.productId)} ltr />
        <DetailItem
          label={t('devices.portCount')}
          value={String(device.portCount)}
          ltr
        />
      </View>

      {!supported ? <Text style={styles.unsupportedHint}>{t('devices.unsupportedHint')}</Text> : null}
    </Pressable>
  );
}

function DetailItem({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.detailItem}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, ltr && styles.ltr]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowSelected: {
    borderColor: colors.accent,
  },
  rowUnsupported: {
    opacity: 0.7,
  },
  headerLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  productName: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    flexShrink: 1,
    flexGrow: 1,
  },
  manufacturer: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs / 2,
  },
  statusBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs,
    marginStart: spacing.sm,
  },
  statusText: {
    ...typography.caption,
    fontWeight: '600',
  },
  selectedBadge: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs,
    marginStart: spacing.xs,
  },
  selectedBadgeText: {
    ...typography.caption,
    color: colors.background,
    fontWeight: '700',
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  detailItem: {
    minWidth: 80,
  },
  detailLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  detailValue: {
    ...typography.body,
    color: colors.textPrimary,
  },
  ltr: {
    writingDirection: 'ltr',
    textAlign: 'left',
  },
  unsupportedHint: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.sm,
  },
});
