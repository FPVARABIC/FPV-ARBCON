/**
 * SETUP R9 - THE DENSE INFORMATION GRID, directly under the model.
 *
 * =====================================================================
 * WHAT THIS REPLACES, AND WHY IT IS ROWS RATHER THAN CARDS
 * =====================================================================
 *
 * Four elevated cards used to carry this: BatteryCard (240px tall),
 * ReceiverCard (141px), GpsCard (190px) and FlightControllerCard (121px),
 * spread across a grid with two section headings, over roughly 900px of
 * a 1920px desktop - to show, in total, eleven numbers.
 *
 * Betaflight's Setup tab groups the same class of information into three
 * dense columns and gets all of it into one screenful. This grid follows
 * that HIERARCHY - Status / GPS / Build, three columns on a desktop,
 * stacking on a phone - in this application's own visual language. No
 * Betaflight CSS, no imitation of its look; the same facts in the same
 * logical grouping, close enough to read together.
 *
 * A row is a label and a value on one line, 22px tall. There is no
 * shadow, no elevation, no per-value card and no per-column heading
 * larger than typography.label.
 *
 * =====================================================================
 * A ROW THAT HAS NO VALUE SAYS SO
 * =====================================================================
 *
 * Two rules, applied without exception:
 *
 *   1. A value that cannot be proven renders the unavailable word in the
 *      secondary colour. It never renders 0, and it never renders a dash
 *      that could be read as a measurement.
 *
 *   2. A row whose absence is not itself informative is not rendered at
 *      all (`omitWhenAbsent`). Current draw and consumed mAh are the
 *      examples: MSP_BATTERY_STATE cannot distinguish a residual
 *      register from a board with no current meter fitted, so a zero is
 *      withheld entirely rather than shown as "0.00 A" or as
 *      "unavailable" on a board that simply has no sensor.
 *
 * =====================================================================
 * WHAT IS DELIBERATELY NOT HERE, AND WHY
 * =====================================================================
 *
 * MCU TYPE. MSP_BOARD_INFO does carry an mcuTypeId byte, and this
 * application decodes it. On current firmware that byte is the constant
 * MCU_TYPE_ID_PROVIDED_BY_NAME (src/main/msp/msp.c, `case
 * MSP_BOARD_INFO:` @ betaflight/betaflight 1efac3e) - a sentinel meaning
 * "the real name comes from MSP2_MCU_INFO", which this session does not
 * request. Mapping that sentinel through an MCU table would print a
 * confident, wrong processor name. That is precisely the mislabelling
 * class of defect, so the row is absent rather than fabricated.
 *
 * CPU TEMPERATURE. Nothing in MSP_STATUS_EX carries it and this screen
 * issues no other command. There is no row for it.
 *
 * GPS COORDINATES. decodeRawGps.ts skips latitude and longitude
 * structurally, for privacy, and has since it was written - the compact
 * model cannot carry them. Fix, satellites, altitude, ground speed and
 * course are what this screen's GPS poll genuinely produces, and they
 * are all here. Position lives on the GPS screen, which reads the
 * detailed command for it.
 *
 * FIRMWARE BUILD VERSION (e.g. 2025.12.5) and BUILD DATE. Identification
 * issues exactly three commands - MSP_API_VERSION, MSP_FC_VARIANT,
 * MSP_BOARD_INFO. The build version is MSP_FC_VERSION and the build date
 * is MSP_BUILD_INFO; neither is requested by this screen, and adding a
 * command to the connection sequence is not a layout change. What the
 * board actually told us - its firmware identifier, its family and its
 * MSP API version - is what is shown.
 */

import React from 'react';
import {Pressable, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {
  ArmingReadiness,
  MspAnalog,
  MspRawGpsCompact,
  MspStatusExCompact,
  SetupBatterySummary,
  SetupDiagnosticsView,
  TelemetryValue,
} from '../../../core';
import {
  deriveGpsCard,
  deriveReceiverRssi,
  rankArmingBlockReasons,
} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';
import {resolveAuxCardGate} from './auxChannelGate';
import {colors, radii, spacing, typography} from '../../theme';
import {PROSE_MEASURE} from '../../theme';

/** Effective width at which three columns genuinely fit without the
 * values wrapping under their labels. Below it the grid goes to two, and
 * below the phone threshold to one. */
const THREE_COLUMN_MIN_WIDTH = 940;
const TWO_COLUMN_MIN_WIDTH = 560;

export function resolveSetupInfoColumns(
  windowWidth: number,
  fontScale: number,
): 1 | 2 | 3 {
  const safeScale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const effective = Number.isFinite(windowWidth) ? windowWidth / safeScale : 0;
  if (effective >= THREE_COLUMN_MIN_WIDTH) {
    return 3;
  }
  return effective >= TWO_COLUMN_MIN_WIDTH ? 2 : 1;
}

interface InfoRow {
  readonly key: string;
  readonly label: string;
  /** undefined means "not proven". See the header: it becomes the
   * unavailable word, or the row disappears when `omitWhenAbsent`. */
  readonly value: string | undefined;
  /**
   * What an ABSENT value says instead of the generic unavailable word.
   * The four cards this grid replaces distinguished disconnected /
   * unsupported / waiting / no-data / error, and that distinction is
   * information: "the first reading has not arrived" and "the flight
   * controller rejected this command" are different facts and an
   * operator acts differently on each. auxChannelGate.ts resolves which
   * one applies; this carries it into the row.
   */
  readonly absentText?: string;
  readonly ltr?: boolean;
  readonly color?: string;
  readonly omitWhenAbsent?: boolean;
}

export interface SetupInfoGridProps {
  armingReadiness: ArmingReadiness;
  battery: SetupBatterySummary;
  /** Ownership state is ACTIVE. Outranks every value status below. */
  connected: boolean;
  receiver: TelemetryValue<MspAnalog>;
  receiverChannelState: AuxTelemetryChannelState;
  gps: TelemetryValue<MspRawGpsCompact>;
  gpsChannelState: AuxTelemetryChannelState;
  /** From the SHARED MSP_STATUS_EX decode; undefined = not provable. */
  gpsPresent: boolean | undefined;
  fcStatus: TelemetryValue<MspStatusExCompact>;
  fcChannelState: AuxTelemetryChannelState;
  diagnostics: SetupDiagnosticsView;
  /**
   * THE FOUR SHORTCUTS THE DELETED CARDS USED TO CARRY. Each card was
   * wrapped in a SetupSummaryLink that opened the screen owning that
   * configuration; the cards are gone, so the shortcuts are one compact
   * row of text links instead of four card-sized touch targets. Every
   * destination is also a workspace tab, so an absent callback means
   * "no owner screen reachable in this host" and the link is simply not
   * rendered - never rendered inert.
   */
  onOpenPower?: () => void;
  onOpenReceiver?: () => void;
  onOpenGps?: () => void;
  onOpenSensors?: () => void;
}

export default function SetupInfoGrid({
  armingReadiness,
  battery,
  connected,
  receiver,
  receiverChannelState,
  gps,
  gpsChannelState,
  gpsPresent,
  fcStatus,
  fcChannelState,
  diagnostics,
  onOpenPower,
  onOpenReceiver,
  onOpenGps,
  onOpenSensors,
}: SetupInfoGridProps): React.JSX.Element {
  const {t} = useTranslation();
  const {width: windowWidth, fontScale} = useWindowDimensions();
  const columns = resolveSetupInfoColumns(windowWidth, fontScale);

  /* A tripped channel outranks a cached value - see auxChannelGate.ts.
     Without this, a STALE reading held by the scheduler for a channel
     the FC has since rejected would print as an ordinary number. */
  const fcGate = resolveAuxCardGate(connected, fcChannelState, fcStatus.status);
  const receiverGate = resolveAuxCardGate(
    connected,
    receiverChannelState,
    receiver.status,
  );
  const gpsGate = resolveAuxCardGate(connected, gpsChannelState, gps.status);
  const gateText = (
    gate: ReturnType<typeof resolveAuxCardGate>,
  ): string | undefined =>
    gate === undefined ? undefined : t(`telemetryCards.state.${gate}`);
  const fcAbsent = gateText(fcGate);
  const receiverAbsent = gateText(receiverGate);
  const gpsAbsent = gateText(gpsGate);

  const statusValue =
    fcGate === undefined &&
    (fcStatus.status === 'FRESH' || fcStatus.status === 'STALE')
      ? fcStatus.value
      : undefined;
  const analogValue =
    receiverGate === undefined &&
    (receiver.status === 'FRESH' || receiver.status === 'STALE')
      ? receiver.value
      : undefined;
  const gpsValue =
    gpsGate === undefined && (gps.status === 'FRESH' || gps.status === 'STALE')
      ? gps.value
      : undefined;

  /* ---------------- Status ---------------- */

  const armingDetail =
    armingReadiness.status === 'BLOCKED'
      ? rankArmingBlockReasons(armingReadiness.reasons)[0]
      : undefined;

  const rssi = analogValue === undefined ? undefined : deriveReceiverRssi(analogValue);

  const statusRows: readonly InfoRow[] = [
    {
      key: 'arming',
      label: t('setupInfo.status.arming'),
      value: t(`setupTopBar.armingBadge.${armingReadiness.status.toLowerCase()}`),
      color:
        armingReadiness.status === 'READY'
          ? colors.success
          : armingReadiness.status === 'UNKNOWN'
          ? colors.warning
          : colors.error,
    },
    {
      key: 'arming-reason',
      label: t('setupInfo.status.armingReason'),
      value:
        armingDetail === undefined
          ? undefined
          : t(armingDetail.messageKey, armingDetail.messageParams),
      omitWhenAbsent: true,
    },
    {
      key: 'voltage',
      label: t('setupInfo.status.voltage'),
      value:
        battery.kind === 'MEASURED'
          ? `${battery.voltageVolts.toFixed(2)} V`
          : battery.kind === 'NO_PACK'
          ? t('setupStatusBar.batteryNoPack', {
              value: battery.rawVoltageVolts.toFixed(2),
            })
          : undefined,
      ltr: battery.kind === 'MEASURED',
    },
    {
      key: 'cells',
      label: t('setupInfo.status.cells'),
      value: battery.kind === 'MEASURED' ? `${battery.cellCount}` : undefined,
      omitWhenAbsent: true,
      ltr: true,
    },
    {
      /* THE FIRMWARE'S OWN battery enum - the only supporting state this
         application will report. An unrecognised raw value stays
         {kind:'UNKNOWN'} in the model and renders the "state unknown"
         word here, never a false all-clear. */
      key: 'battery-state',
      label: t('setupInfo.status.batteryState'),
      value:
        battery.kind === 'MEASURED' || battery.kind === 'NO_PACK'
          ? typeof battery.firmwareState === 'string'
            ? t(`batteryCard.state.${battery.firmwareState}`)
            : t('batteryCard.stateUnknown')
          : undefined,
      omitWhenAbsent: true,
    },
    {
      key: 'battery-reading',
      label: t('setupInfo.status.batteryReading'),
      value:
        (battery.kind === 'MEASURED' || battery.kind === 'NO_PACK') &&
        battery.stale
          ? t('telemetryCards.state.stale')
          : undefined,
      color: colors.warning,
      omitWhenAbsent: true,
    },
    {
      key: 'current',
      label: t('setupInfo.status.current'),
      value:
        battery.kind === 'MEASURED' && battery.amps !== undefined
          ? `${battery.amps.toFixed(2)} A`
          : undefined,
      omitWhenAbsent: true,
      ltr: true,
    },
    {
      key: 'consumed',
      label: t('setupInfo.status.consumed'),
      value:
        battery.kind === 'MEASURED' && battery.consumedMah !== undefined
          ? `${battery.consumedMah} mAh`
          : undefined,
      omitWhenAbsent: true,
      ltr: true,
    },
    {
      /* THE LIVE/STALE LINK CONDITION, IN WORDS. The receiver card this
         replaces stated it as a sentence rather than only as a dimmed
         opacity, precisely so "the number you are looking at stopped
         updating" never had to be inferred from a shade of grey. The row
         is omitted when there is no receiver reading at all, which is
         exactly when the card showed nothing either. */
      key: 'link-state',
      label: t('setupInfo.status.linkState'),
      value:
        analogValue === undefined
          ? undefined
          : t(
              receiver.status === 'STALE'
                ? 'telemetryCards.receiver.linkStale'
                : 'telemetryCards.receiver.linkLive',
            ),
      color: receiver.status === 'STALE' ? colors.warning : undefined,
      omitWhenAbsent: true,
    },
    {
      key: 'rssi',
      label: t('setupInfo.status.rssi'),
      // A wire zero is NOT 0%: an unconfigured RSSI source and genuine
      // zero signal are indistinguishable on this command, so the honest
      // answer is that it cannot be told.
      value: rssi?.kind === 'PERCENT' ? `${rssi.percent}%` : undefined,
      absentText: receiverAbsent,
      ltr: true,
    },
    {
      key: 'cpu',
      label: t('setupInfo.status.cpuLoad'),
      value:
        statusValue === undefined ? undefined : `${statusValue.cpuLoadPercent}%`,
      absentText: fcAbsent,
      ltr: true,
    },
    {
      key: 'cycle',
      label: t('setupInfo.status.cycleTime'),
      value:
        statusValue === undefined ? undefined : `${statusValue.cycleTimeUs} µs`,
      absentText: fcAbsent,
      ltr: true,
    },
    {
      /* Same rule for the flight-controller counters: an aged reading
         says so rather than sitting there looking current. */
      key: 'fc-reading',
      label: t('setupInfo.status.fcReading'),
      value:
        statusValue !== undefined && fcStatus.status === 'STALE'
          ? t('telemetryCards.state.stale')
          : undefined,
      color: colors.warning,
      omitWhenAbsent: true,
    },
    {
      key: 'i2c',
      // Cumulative since boot, and labelled as such - never a live fault
      // indicator. Shown only when nonzero.
      label: t('setupInfo.status.i2cErrors'),
      value:
        statusValue !== undefined && statusValue.i2cErrorCount > 0
          ? `${statusValue.i2cErrorCount}`
          : undefined,
      omitWhenAbsent: true,
      ltr: true,
    },
  ];

  /* ---------------- GPS ---------------- */

  const gpsModel =
    gpsValue === undefined ? undefined : deriveGpsCard(gpsValue, gpsPresent);
  const hasFix = gpsModel?.kind === 'FIX';

  const gpsRows: readonly InfoRow[] = [
    {
      key: 'fix',
      label: t('setupInfo.gps.fix'),
      value:
        gpsModel === undefined || gpsModel.kind === 'NO_PRESENCE_PROOF'
          ? undefined
          : t(hasFix ? 'telemetryCards.gps.fix' : 'telemetryCards.gps.noFix'),
      absentText:
        gpsAbsent ??
        (gpsModel?.kind === 'NO_PRESENCE_PROOF'
          ? t('telemetryCards.state.unavailable')
          : undefined),
      color: hasFix ? colors.success : colors.textSecondary,
    },
    {
      key: 'satellites',
      label: t('setupInfo.gps.satellites'),
      value:
        gpsModel === undefined || gpsModel.kind === 'NO_PRESENCE_PROOF'
          ? undefined
          : `${gpsModel.satelliteCount}`,
      absentText: gpsAbsent,
      ltr: true,
    },
    {
      key: 'altitude',
      label: t('setupInfo.gps.altitude'),
      value:
        gpsModel?.kind === 'FIX' && gpsModel.altitudeMeters !== undefined
          ? `${gpsModel.altitudeMeters} m`
          : undefined,
      absentText: gpsAbsent,
      ltr: true,
    },
    {
      key: 'speed',
      label: t('setupInfo.gps.speed'),
      value:
        gpsModel?.kind === 'FIX' &&
        gpsModel.groundSpeedMetersPerSecond !== undefined
          ? `${gpsModel.groundSpeedMetersPerSecond.toFixed(1)} m/s`
          : undefined,
      absentText: gpsAbsent,
      ltr: true,
    },
    {
      key: 'course',
      label: t('setupInfo.gps.course'),
      // Course is meaningless at a standstill, so it is withheld rather
      // than printed as a heading the aircraft is not travelling on.
      value:
        gpsModel?.kind === 'FIX' &&
        gpsModel.groundCourseDegrees !== undefined &&
        gpsModel.groundSpeedMetersPerSecond !== undefined &&
        gpsModel.groundSpeedMetersPerSecond > 0
          ? `${gpsModel.groundCourseDegrees.toFixed(1)}°`
          : undefined,
      omitWhenAbsent: true,
      ltr: true,
    },
  ];

  /* ---------------- Build ---------------- */

  const identity = diagnostics.identity;
  const buildRows: readonly InfoRow[] = [
    {
      key: 'board',
      label: t('setupInfo.build.board'),
      /* Defensive for the same reason SetupStatusBar is: a truncated
         MSP_BOARD_INFO is a board that identified without a name, not an
         error, and it must read as unavailable rather than crash. */
      value:
        typeof identity?.boardName === 'string' && identity.boardName.length > 0
          ? identity.boardName
          : undefined,
      ltr: true,
    },
    {
      key: 'firmware',
      label: t('setupInfo.build.firmware'),
      value:
        typeof identity?.firmwareIdentifier === 'string' &&
        identity.firmwareIdentifier.length > 0
          ? identity.firmwareIdentifier
          : undefined,
      ltr: true,
    },
    {
      key: 'family',
      label: t('setupInfo.build.family'),
      value:
        identity?.family === undefined || identity.family === 'UNKNOWN'
          ? undefined
          : identity.family,
      ltr: true,
    },
    {
      key: 'api',
      label: t('setupInfo.build.api'),
      value:
        typeof identity?.apiVersionMajor === 'number' &&
        typeof identity.apiVersionMinor === 'number'
          ? `${identity.apiVersionMajor}.${identity.apiVersionMinor}`
          : undefined,
      ltr: true,
    },
    {
      key: 'compatibility',
      label: t('setupInfo.build.compatibility'),
      value: t(`setupInfo.compatibility.${diagnostics.compatibility}`),
      color:
        diagnostics.compatibility === 'BETAFLIGHT_API_1_47'
          ? colors.success
          : diagnostics.compatibility === 'IDENTIFICATION_FAILED'
          ? colors.error
          : colors.textSecondary,
    },
    {
      key: 'reading',
      label: t('setupInfo.build.reading'),
      value: t(`setupInfo.dataState.${diagnostics.dataState}`),
      color:
        diagnostics.dataState === 'FRESH'
          ? colors.success
          : diagnostics.dataState === 'STALE'
          ? colors.warning
          : colors.textSecondary,
    },
  ];

  const columnStyle = [
    styles.column,
    columns === 3 && styles.columnThird,
    columns === 2 && styles.columnHalf,
  ];

  /* Short visible text, full sentence for the screen reader: a compact
     row must stay one line at 390px, and "GPS" alone is not a
     destination an assistive technology can announce. */
  const links: ReadonlyArray<{
    key: string;
    label: string;
    accessibilityLabel: string;
    onPress: (() => void) | undefined;
  }> = [
    {
      key: 'power',
      label: t('setupInfo.links.power'),
      accessibilityLabel: t('setupNavigation.openPower'),
      onPress: onOpenPower,
    },
    {
      key: 'receiver',
      label: t('setupInfo.links.receiver'),
      accessibilityLabel: t('setupNavigation.openReceiver'),
      onPress: onOpenReceiver,
    },
    {
      key: 'gps',
      label: t('setupInfo.links.gps'),
      accessibilityLabel: t('setupNavigation.openGps'),
      onPress: onOpenGps,
    },
    {
      key: 'sensors',
      label: t('setupInfo.links.sensors'),
      accessibilityLabel: t('setupNavigation.openSensors'),
      onPress: onOpenSensors,
    },
  ];
  const visibleLinks = links.filter(link => link.onPress !== undefined);

  return (
    <View testID="setup-info-grid-region">
      <View style={styles.grid} testID="setup-info-grid">
        <Column
          title={t('setupInfo.status.title')}
          rows={statusRows}
          style={columnStyle}
          columnTestID="setup-info-status"
        />
        <Column
          title={t('setupInfo.gps.title')}
          rows={gpsRows}
          style={columnStyle}
          columnTestID="setup-info-gps"
          /* When the whole channel is gated, say WHY once at the top of
             the column rather than repeating "unavailable" five times
             with no reason attached. */
          /* One line at the top of the column saying why it is empty, or
             that its numbers have aged - rather than repeating a word
             five times with no reason attached. */
          note={
            gpsGate !== undefined
              ? t(`telemetryCards.state.${gpsGate}`)
              : gpsModel?.kind === 'NO_PRESENCE_PROOF'
              ? t('setupInfo.gps.noPresence')
              : gps.status === 'STALE'
              ? t('telemetryCards.state.stale')
              : undefined
          }
          footnote={t('setupInfo.gps.positionElsewhere')}
        />
        <Column
          title={t('setupInfo.build.title')}
          rows={buildRows}
          style={columnStyle}
          columnTestID="setup-info-build"
        />
      </View>
      {visibleLinks.length > 0 ? (
        <View style={styles.linkRow} testID="setup-info-links">
          {visibleLinks.map(link => (
            <Pressable
              key={link.key}
              onPress={link.onPress}
              accessibilityRole="link"
              accessibilityLabel={link.accessibilityLabel}
              style={styles.link}
              testID={`setup-open-${link.key}`}
            >
              <Text style={styles.linkText} numberOfLines={1}>
                {link.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * `columnTestID`, not `testID`, for the same reason Chip uses
 * `chipTestID`: a composite that accepts a prop named testID is what
 * findAllByProps({testID}) returns, hiding the host View that actually
 * carries the accessibility props.
 */
function Column({
  title,
  rows,
  style,
  columnTestID: testID,
  note,
  footnote,
}: {
  title: string;
  rows: readonly InfoRow[];
  style: unknown;
  columnTestID: string;
  note?: string;
  footnote?: string;
}): React.JSX.Element {
  const {t} = useTranslation();
  const unavailable = t('setupStatusBar.unavailable');
  const visible = rows.filter(
    row => row.value !== undefined || row.omitWhenAbsent !== true,
  );
  return (
    <View style={style as never} testID={testID}>
      <Text style={styles.columnTitle} accessibilityRole="header">
        {title}
      </Text>
      {note === undefined ? null : (
        <Text style={styles.columnNote} testID={`${testID}-note`}>
          {note}
        </Text>
      )}
      {visible.map(row => {
        const absent = row.value === undefined;
        return (
          <View
            key={row.key}
            style={styles.row}
            accessible
            accessibilityLabel={`${row.label}: ${
              row.value ?? row.absentText ?? unavailable
            }`}
            testID={`${testID}-${row.key}`}
          >
            <Text style={styles.rowLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text
              style={[
                styles.rowValue,
                absent ? styles.rowValueAbsent : undefined,
                !absent && row.color !== undefined
                  ? {color: row.color}
                  : undefined,
                !absent && row.ltr ? styles.ltr : undefined,
              ]}
              numberOfLines={2}
            >
              {row.value ?? row.absentText ?? unavailable}
            </Text>
          </View>
        );
      })}
      {footnote === undefined ? null : (
        <Text style={styles.footnote}>{footnote}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  column: {
    flexGrow: 1,
    flexBasis: '100%',
    minWidth: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  /* flexBasis is deliberately a hair under the true fraction: the gap
     between columns is real width, and an exact 33.333% basis wraps the
     third column onto its own line. */
  columnThird: {flexBasis: '31%'},
  columnHalf: {flexBasis: '47%'},
  columnTitle: {
    ...typography.label,
    color: colors.accentStrong,
    marginBottom: 2,
  },
  columnNote: {
    ...typography.helper,
    color: colors.textSecondary,
    marginBottom: 2,
    maxWidth: PROSE_MEASURE,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 22,
  },
  rowLabel: {
    ...typography.helper,
    color: colors.textSecondary,
    flexShrink: 0,
  },
  rowValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
    flexShrink: 1,
  },
  rowValueAbsent: {
    color: colors.textSecondary,
    fontWeight: '500',
  },
  ltr: {
    writingDirection: 'ltr',
  },
  footnote: {
    ...typography.helper,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    maxWidth: PROSE_MEASURE,
  },
  linkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  /* 44px, the same minimum touch target SafetyStrip's own MIN_TOUCH_TARGET
     pins and the same one the card-sized shortcuts these replaced met.
     The census caught this: shrinking a control while compacting a
     layout is exactly the trade this round was told not to make. */
  link: {
    minHeight: 44,
    justifyContent: 'center',
  },
  linkText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600',
  },
});
