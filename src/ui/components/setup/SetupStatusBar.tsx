/**
 * SETUP R9 - THE COMPACT SYSTEM STATUS AREA.
 *
 * =====================================================================
 * THE MEASUREMENT THAT MADE THIS NECESSARY
 * =====================================================================
 *
 * On the previous revision, with a fully populated board attached, a
 * 1920px desktop had to scroll to reach the aircraft's own state:
 *
 *     139  the teal TopSystemBar (board, firmware family, arming)
 *      90  orientation section heading (84px tall)
 *    1311  "live summary" heading
 *    1403  Battery card
 *    1849  Sensors card
 *    3353  total scroll height
 *
 * The five facts an operator checks the instant a board answers - is it
 * connected, what is it, is it armed, what is the pack doing, which
 * sensors did it find - were spread from y=139 to y=2006. Betaflight's
 * own Setup tab puts every one of them in a status column that is
 * visible with the model, and that is the hierarchy being matched here.
 * Not its CSS and not its look: the same facts, in the same place in the
 * reading order, in this application's own Arabic-first design.
 *
 * =====================================================================
 * DENSITY IS THE POINT, SO NOTHING HERE IS A CARD
 * =====================================================================
 *
 * Every fact is a chip: one line, a label and a value, a hairline
 * border. There is deliberately no per-sensor card, no elevation, no
 * shadow and no section heading. Seven sensors as cards is 534px of
 * tower; seven sensors as chips is one wrapping row.
 *
 * NOTHING WAS ENLARGED TO FILL THE ROW. Every text style below is
 * typography.caption (13px) or typography.helper (12px) - the two
 * smallest tokens in the scale, and the same ones the cards this
 * replaces already used for their captions. Emphasis is carried by
 * WEIGHT and COLOUR rather than by size: a value is caption/700 against
 * its helper/400 label. aircraftOverviewDensity.test.ts enumerates the
 * tokens this file uses and fails if a third one appears, so "make it
 * stand out" cannot quietly become "make it bigger".
 *
 * =====================================================================
 * SENSOR PRESENCE IS DETECTION, FROM THE FC'S OWN MASK
 * =====================================================================
 *
 * The chips render deriveSetupSensorSummary(diagnosticsView.sensors) -
 * the same derivation DiagnosticsSection renders lower down, fed by
 * decodeSensorPresence(MSP_STATUS_EX.sensorPresenceMask). That is the
 * flight controller's own `sensors(SENSOR_x)` bitmask: it proves the
 * firmware DETECTED the hardware. It is not a feature flag, it is not
 * configuration, and it is not health.
 *
 * The three states are kept structurally distinct and none of them is
 * ever collapsed into another:
 *
 *   DETECTED     - the bit is set in a reading we actually hold.
 *   NOT_DETECTED - we hold a reading and the bit is clear.
 *   UNKNOWN      - we hold no reading at all, so nothing is proven
 *                  either way. Rendered in the warning colour with its
 *                  own word, never as "not detected".
 *
 * That last distinction is the one the round asked for by name: when
 * unavailable and not-detected cannot be told apart, the honest answer
 * is UNKNOWN, and the summary already refuses to guess (it returns
 * `unconfirmed: true` with every entry UNKNOWN when the STATUS_EX
 * reading is absent, stale-free or unsupported).
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {
  ArmingReadiness,
  SetupBatterySummary,
  SetupSensorState,
  SetupSensorSummary,
} from '../../../core';
import type {SetupDiagnosticsView} from '../../../core';
import {firmwareFamilyLabel} from '../../presentation/brandSafeText';
import {deriveConnectionIndicatorState} from './connectionIndicator';
import type {SetupConnectionIndicatorState} from './connectionIndicator';
import {useTopBarNotice} from './useTopBarNotice';
import {
  useSetupIdentificationState,
  useSetupOwnershipState,
  useSetupRecoveryState,
} from '../../../platforms/react-native/protocol/setupPresentation';
import {colors, radii, spacing, typography} from '../../theme';
import {PROSE_MEASURE} from '../../theme';

const INDICATOR_COLOR: Record<SetupConnectionIndicatorState, string> = {
  CONNECTED: colors.success,
  ACTIVATING: colors.accent,
  RECOVERING: colors.warning,
  RECOVERY_FAILED: colors.error,
  DISCONNECTED: colors.textSecondary,
};

const INDICATOR_LABEL_KEY: Record<SetupConnectionIndicatorState, string> = {
  CONNECTED: 'setupTopBar.connectionState.connected',
  ACTIVATING: 'setupTopBar.connectionState.activating',
  RECOVERING: 'setupTopBar.connectionState.recovering',
  RECOVERY_FAILED: 'setupTopBar.connectionState.recoveryFailed',
  DISCONNECTED: 'setupTopBar.connectionState.disconnected',
};

const ARMING_COLOR: Record<ArmingReadiness['status'], string> = {
  ARMED: colors.error,
  READY: colors.success,
  BLOCKED: colors.error,
  UNKNOWN: colors.warning,
};

const ARMING_LABEL_KEY: Record<ArmingReadiness['status'], string> = {
  ARMED: 'setupTopBar.armingBadge.armed',
  READY: 'setupTopBar.armingBadge.ready',
  BLOCKED: 'setupTopBar.armingBadge.blocked',
  UNKNOWN: 'setupTopBar.armingBadge.unknown',
};

const SENSOR_STATE_KEY: Record<SetupSensorState, string> = {
  DETECTED: 'diagnostics.sensorDetected',
  NOT_DETECTED: 'diagnostics.sensorNotDetected',
  UNKNOWN: 'diagnostics.sensorUnknown',
};

/** Never colour-alone: each sensor chip also carries its state as TEXT,
 * so the distinction survives a monochrome screen and a screen reader
 * alike. Same rule the card this replaces followed. */
const SENSOR_STATE_COLOR: Record<SetupSensorState, string> = {
  DETECTED: colors.success,
  NOT_DETECTED: colors.textSecondary,
  UNKNOWN: colors.warning,
};

const NOTICE_COLOR: Record<'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO', string> = {
  CRITICAL: colors.error,
  ERROR: colors.error,
  WARNING: colors.warning,
  INFO: colors.accent,
};

export interface SetupStatusBarProps {
  sessionId: string;
  /** The ONE readiness object the whole screen shares, so this chip, the
   * safety strip and the FC-tool gate cannot disagree. */
  armingReadiness: ArmingReadiness;
  battery: SetupBatterySummary;
  sensors: SetupSensorSummary;
  /** For the board / firmware / API facts. Passed rather than re-derived
   * so the status area and the build column below read one object. */
  diagnostics: SetupDiagnosticsView;
}

/**
 * One label-and-value chip. The whole vocabulary of this component.
 *
 * The prop is `chipTestID`, not `testID`, on purpose: react-test-renderer's
 * findAllByProps({testID}) matches the COMPOSITE element first when a
 * component takes a prop of that name, so a test would get this function
 * rather than the host View underneath it - and read `undefined` for
 * every accessibility prop the View actually carries.
 */
function Chip({
  label,
  value,
  valueColor,
  chipTestID,
  ltrValue = false,
}: {
  label: string;
  value: string;
  valueColor?: string;
  chipTestID: string;
  ltrValue?: boolean;
}): React.JSX.Element {
  return (
    <View
      style={styles.chip}
      accessible
      accessibilityRole="text"
      /* Read as one fact rather than as two adjacent fragments: a screen
         reader announcing "battery" and then, separately, "16.42 V · 4S"
         loses the association a sighted reader gets from the chip's own
         border. */
      accessibilityLabel={`${label}: ${value}`}
      testID={chipTestID}
    >
      <Text style={styles.chipLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[
          styles.chipValue,
          valueColor === undefined ? undefined : {color: valueColor},
          ltrValue ? styles.ltr : undefined,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

export default function SetupStatusBar({
  sessionId,
  armingReadiness,
  battery,
  sensors,
  diagnostics,
}: SetupStatusBarProps): React.JSX.Element {
  const {t} = useTranslation();
  const ownership = useSetupOwnershipState(sessionId);
  const recovery = useSetupRecoveryState(sessionId);
  const identification = useSetupIdentificationState(sessionId);
  const indicator = deriveConnectionIndicatorState(ownership, recovery);
  /* The connection/recovery/identification notice TopSystemBar used to
     host. It is retained rather than dropped - it is the only surface
     that reports a recovery in progress or a failed identification - but
     it renders ONLY when there is something to say, so the normal state
     costs nothing. */
  const notice = useTopBarNotice(ownership, recovery, identification);

  const identity = diagnostics.identity;
  const unavailable = t('setupStatusBar.unavailable');

  /* WHAT THE BUILD FACTS ARE ALLOWED TO SAY. Identification issues
     exactly three commands - MSP_API_VERSION, MSP_FC_VARIANT,
     MSP_BOARD_INFO - so those are the only build facts this screen has
     without asking the board for more. Anything absent renders as the
     unavailable word, never as a dash that could read as a value. */
  /* A TRUNCATED MSP_BOARD_INFO IS NOT AN ERROR, and Betaflight itself
     treats board metadata as optional (see mspIdentificationTypes.ts):
     a board can identify successfully and still carry no name. The
     `string` type says it is always present; the wire says otherwise
     when the response ends inside the prefix, so this reads defensively
     and reports the unavailable word rather than throwing on a board
     that is otherwise talking perfectly well. */
  const boardName =
    typeof identity?.boardName === 'string' && identity.boardName.length > 0
      ? identity.boardName
      : undefined;
  /**
   * THE FIRMWARE CHIP NAMES NO PROJECT.
   *
   * It used to read "BTFL · BETAFLIGHT" - the wire identifier and the
   * decoded family, both rendered raw. That is a third party's name on
   * this application's status bar, which reads as an affiliation this
   * application does not have. firmwareFamilyLabel reports the
   * CAPABILITY instead: whether the board's MSP dialect is one this
   * application verifies against. The family value itself is untouched
   * and still gates every capability check - see brandSafeText.ts.
   */
  const firmwareText =
    identity?.family === undefined
      ? undefined
      : firmwareFamilyLabel(identity.family);
  const apiText =
    typeof identity?.apiVersionMajor === 'number' &&
    typeof identity.apiVersionMinor === 'number'
      ? `${identity.apiVersionMajor}.${identity.apiVersionMinor}`
      : undefined;

  /* The chip's testID carries the STATE, not just the field, so a test
     can tell "16.42 V from a proven pack" from "16.42 V measured on a
     board that reports no pack" without matching Arabic prose. Same
     discipline the card this replaces used (battery-card-live /
     -stale / -unavailable / -error). */
  const batteryValue = ((): {
    text: string;
    color?: string;
    testID: string;
  } => {
    switch (battery.kind) {
      case 'UNAVAILABLE':
        return {text: unavailable, testID: 'setup-status-battery-unavailable'};
      case 'WAITING':
        return {
          text: t('setupStatusBar.waiting'),
          testID: 'setup-status-battery-waiting',
        };
      case 'ERROR':
        return {
          text: t('setupStatusBar.error'),
          color: colors.error,
          testID: 'setup-status-battery-error',
        };
      case 'NO_PACK':
        // The measured value is still shown - hiding a real reading was
        // never acceptable - but it is never presented as a pack voltage.
        return {
          text: t('setupStatusBar.batteryNoPack', {
            value: battery.rawVoltageVolts.toFixed(2),
          }),
          color: colors.textSecondary,
          testID: 'setup-status-battery-no-pack',
        };
      case 'MEASURED':
        return {
          /* NEVER COLOUR-ALONE: a stale reading says so in words as well
             as in the warning tint, so the distinction survives a
             monochrome screen and a screen reader. Same rule the card
             this replaces followed with its own stale label. */
          text: t(
            battery.stale
              ? 'setupStatusBar.batteryMeasuredStale'
              : 'setupStatusBar.batteryMeasured',
            {
              volts: battery.voltageVolts.toFixed(2),
              cells: battery.cellCount,
              stale: t('telemetryCards.state.stale'),
            },
          ),
          color: battery.stale ? colors.warning : colors.textPrimary,
          testID: battery.stale
            ? 'setup-status-battery-stale'
            : 'setup-status-battery-live',
        };
    }
  })();

  return (
    <View style={styles.container} testID="setup-status-bar">
      <View style={styles.chipRow}>
        <Chip
          label={t('setupStatusBar.connection')}
          value={t(INDICATOR_LABEL_KEY[indicator])}
          valueColor={INDICATOR_COLOR[indicator]}
          chipTestID="setup-status-connection"
        />
        <Chip
          label={t('setupStatusBar.board')}
          value={boardName ?? unavailable}
          valueColor={boardName === undefined ? colors.textSecondary : undefined}
          ltrValue
          chipTestID="setup-status-board"
        />
        <Chip
          label={t('setupStatusBar.firmware')}
          value={firmwareText ?? unavailable}
          valueColor={
            firmwareText === undefined ? colors.textSecondary : undefined
          }
          ltrValue
          chipTestID="setup-status-firmware"
        />
        <Chip
          label={t('setupStatusBar.api')}
          value={apiText ?? unavailable}
          valueColor={apiText === undefined ? colors.textSecondary : undefined}
          ltrValue
          chipTestID="setup-status-api"
        />
        <Chip
          label={t('setupStatusBar.arming')}
          value={t(ARMING_LABEL_KEY[armingReadiness.status])}
          valueColor={ARMING_COLOR[armingReadiness.status]}
          chipTestID="setup-status-arming"
        />
        <Chip
          label={t('setupStatusBar.battery')}
          value={batteryValue.text}
          valueColor={batteryValue.color}
          chipTestID={batteryValue.testID}
        />
      </View>

      <View style={styles.sensorRow} testID="setup-status-sensors">
        <Text style={styles.sensorRowLabel}>
          {t('setupStatusBar.sensors')}
        </Text>
        {sensors.entries.map(entry => (
          <View
            key={entry.token}
            style={[
              styles.sensorChip,
              {borderColor: SENSOR_STATE_COLOR[entry.state]},
            ]}
            accessible
            accessibilityLabel={`${entry.token} ${t(
              SENSOR_STATE_KEY[entry.state],
            )}`}
            testID={`setup-status-sensor-${entry.token}`}
          >
            {/* Latin technical token, pinned LTR so it cannot be
                re-ordered by the surrounding Arabic paragraph, and
                allowed one line only so GYRO/OPTICALFLOW never break
                mid-word on a 390px phone. */}
            <Text style={styles.sensorToken} numberOfLines={1}>
              {entry.token}
            </Text>
            <Text
              style={[
                styles.sensorState,
                {color: SENSOR_STATE_COLOR[entry.state]},
              ]}
              numberOfLines={1}
            >
              {t(SENSOR_STATE_KEY[entry.state])}
            </Text>
          </View>
        ))}
      </View>

      {/* Set bits above the pinned mapping, preserved rather than
          discarded - a future firmware sensor must not vanish silently. */}
      {sensors.unknownBits.length > 0 ? (
        <Text style={styles.footnote} testID="setup-status-unknown-bits">
          {sensors.unknownBits
            .map(bit => t('diagnostics.sensorsUnknownBit', {hex: bit.hex}))
            .join('، ')}
        </Text>
      ) : null}

      {notice ? (
        <View
          style={[
            styles.notice,
            {borderColor: NOTICE_COLOR[notice.severity]},
          ]}
          accessibilityRole="alert"
          testID="setup-status-notice"
        >
          <Text
            style={[
              styles.noticeTitle,
              {color: NOTICE_COLOR[notice.severity]},
            ]}
          >
            {notice.title}
          </Text>
          {notice.message ? (
            <Text style={styles.noticeMessage}>{notice.message}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
    minWidth: 0,
    flexShrink: 1,
  },
  chipLabel: {
    ...typography.helper,
    color: colors.textSecondary,
  },
  chipValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    flexShrink: 1,
  },
  ltr: {
    writingDirection: 'ltr',
  },
  sensorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sensorRowLabel: {
    ...typography.helper,
    color: colors.textSecondary,
  },
  sensorChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    backgroundColor: colors.backgroundRaised,
  },
  sensorToken: {
    ...typography.helper,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  sensorState: {
    ...typography.helper,
    fontWeight: '600',
  },
  footnote: {
    ...typography.helper,
    color: colors.textSecondary,
    maxWidth: PROSE_MEASURE,
  },
  notice: {
    marginTop: spacing.xs,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.backgroundRaised,
  },
  noticeTitle: {
    ...typography.caption,
    fontWeight: '700',
  },
  noticeMessage: {
    ...typography.helper,
    color: colors.textSecondary,
    maxWidth: PROSE_MEASURE,
  },
});
