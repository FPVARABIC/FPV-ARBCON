import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import { isSupportedDevice } from '../../../platforms/react-native/transport';
import type { UsbSerialDeviceDescriptor } from '../../../platforms/react-native/transport';
import { formatHex } from './format';
import {
  usbManufacturerLabel,
  usbProductLabel,
} from '../../presentation/brandSafeText';

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
  const { t } = useTranslation();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const supported = isSupportedDevice(device);
  const selectable = supported && !disabled;
  const productLabel = usbProductLabel(
    device.productName,
    t('devices.unknownProductName'),
  );
  const manufacturerLabel = usbManufacturerLabel(device.manufacturerName);

  return (
    <Pressable
      testID={testID}
      onPress={selectable ? onSelect : undefined}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !selectable }}
      accessibilityLabel={`${t('accessibility.selectDevice')}: ${productLabel}`}
      style={[
        styles.row,
        selected && styles.rowSelected,
        !supported && styles.rowUnsupported,
      ]}
    >
      <View style={styles.headerLine}>
        <Text style={styles.productName} numberOfLines={1}>
          {productLabel}
        </Text>
        <View
          style={[
            styles.statusBadge,
            { borderColor: supported ? colors.success : colors.disabled },
          ]}
        >
          <Text
            style={[
              styles.statusText,
              { color: supported ? colors.success : colors.textSecondary },
            ]}
          >
            {supported ? t('devices.supported') : t('devices.unsupported')}
          </Text>
        </View>
        {selected ? (
          <View style={styles.selectedBadge}>
            <Text style={styles.selectedBadgeText}>
              {t('devices.selectedBadge')}
            </Text>
          </View>
        ) : null}
      </View>

      {manufacturerLabel ? (
        <Text style={styles.manufacturer} numberOfLines={1}>
          {manufacturerLabel}
        </Text>
      ) : null}

      {/* TECHNICAL IDENTITY, BEHIND A DISCLOSURE.
          Driver type, VID, PID and port count identify a device to a
          DEVELOPER. An operator connecting a flight controller picks it
          by its name, and four hex fields under every row turned the
          connection surface into a hardware inventory. They were already
          hidden for unselected rows; now the selected row hides them too
          until asked, so the primary surface stays compact and nothing
          is lost - the same values, one tap away. */}
      {selected ? (
        <Pressable
          onPress={() => setTechnicalOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{expanded: technicalOpen}}
          style={styles.technicalToggle}
          testID="device-technical-toggle"
        >
          <Text style={styles.technicalToggleText}>
            {technicalOpen
              ? t('devices.hideTechnical')
              : t('devices.showTechnical')}
          </Text>
        </Pressable>
      ) : null}

      <View
        style={[
          styles.detailsGrid,
          (!selected || !technicalOpen) && styles.detailsCollapsed,
        ]}
        testID="device-technical-details"
      >
        <DetailItem label={t('devices.driverType')} value={device.driverType} />
        <DetailItem
          label={t('devices.vid')}
          value={formatHex(device.vendorId)}
          ltr
        />
        <DetailItem
          label={t('devices.pid')}
          value={formatHex(device.productId)}
          ltr
        />
        <DetailItem
          label={t('devices.portCount')}
          value={String(device.portCount)}
          ltr
        />
      </View>

      {!supported ? (
        <Text style={styles.unsupportedHint}>
          {t('devices.unsupportedHint')}
        </Text>
      ) : null}
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
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  rowSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    shadowColor: colors.accent,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
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
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginStart: spacing.sm,
  },
  statusText: {
    ...typography.caption,
    fontWeight: '600',
  },
  selectedBadge: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginStart: spacing.xs,
  },
  selectedBadgeText: {
    ...typography.caption,
    color: colors.accentText,
    fontWeight: '700',
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  detailsCollapsed: {
    display: 'none',
  },
  technicalToggle: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    minHeight: 32,
    justifyContent: 'center',
  },
  technicalToggleText: {
    ...typography.caption,
    color: colors.accentStrong,
    textAlign: 'right',
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
