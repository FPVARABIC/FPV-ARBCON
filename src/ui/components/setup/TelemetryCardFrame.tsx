/**
 * Pass 7.6c - the shared shell for Region 3's auxiliary summary cards
 * (Receiver / GPS / Flight controller). Display-only, no polling, no
 * timers, no store state - exactly BatteryCard's contract, factored out
 * so the three new cards render their shared lifecycle states (the
 * approved Arabic copy in telemetryCards.state) and stale treatment
 * identically instead of re-implementing them three times.
 *
 * BatteryCard itself deliberately does NOT use this frame: its Pass 7.6b
 * copy (battery-specific state wording) is preserved verbatim, and
 * rewording it to the shared strings was explicitly out of scope.
 *
 * State precedence, resolved by resolveAuxCardGate() below:
 *   1. session not ACTIVE            -> "غير متصل"
 *   2. channel UNSUPPORTED           -> "غير مدعوم" (the FC rejected it)
 *   3. channel DECODE_FAILED/DISABLED-> "تعذرت قراءة البيانات"
 *   4. value UNAVAILABLE             -> "البيانات غير متاحة"
 *   5. value WAITING                 -> "بانتظار أول قراءة"
 *   6. value ERROR                   -> "تعذرت قراءة البيانات"
 *   7. FRESH/STALE                   -> real content (stale: dimmed +
 *      "القراءة غير محدثة" label, mirroring OrientationHero/BatteryCard).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { TelemetryValue } from '../../../core';
import type { AuxTelemetryChannelState } from '../../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../../theme';

const STALE_OPACITY = 0.45;

export type AuxCardGateVariant =
  | 'disconnected'
  | 'unsupported'
  | 'unavailable'
  | 'waiting'
  | 'error';

/** The shared lifecycle-state precedence above; undefined = render real
 * content (FRESH or STALE). Pure - unit-testable without rendering. */
export function resolveAuxCardGate(
  connected: boolean,
  channelState: AuxTelemetryChannelState,
  valueStatus: TelemetryValue<unknown>['status'],
): AuxCardGateVariant | undefined {
  if (!connected) {
    return 'disconnected';
  }
  if (channelState === 'UNSUPPORTED') {
    return 'unsupported';
  }
  if (channelState === 'DECODE_FAILED' || channelState === 'DISABLED') {
    return 'error';
  }
  if (valueStatus === 'UNAVAILABLE') {
    return 'unavailable';
  }
  if (valueStatus === 'WAITING') {
    return 'waiting';
  }
  if (valueStatus === 'ERROR') {
    return 'error';
  }
  return undefined;
}

export interface TelemetryCardFrameProps {
  title: string;
  /** testID prefix, e.g. 'receiver-card' -> 'receiver-card-live' /
   * 'receiver-card-stale' / 'receiver-card-<gate variant>'. */
  testIDPrefix: string;
  /** A resolved gate variant renders the shared message body; undefined
   * renders children as live/stale content. */
  gate: AuxCardGateVariant | undefined;
  stale: boolean;
  /** Complete Arabic accessibility label for the content state (the
   * frame appends the shared stale suffix itself). */
  contentAccessibilityLabel: string;
  children?: React.ReactNode;
}

export default function TelemetryCardFrame({
  title,
  testIDPrefix,
  gate,
  stale,
  contentAccessibilityLabel,
  children,
}: TelemetryCardFrameProps): React.JSX.Element {
  const { t } = useTranslation();

  if (gate !== undefined) {
    const message = t(`telemetryCards.state.${gate}`);
    return (
      <View
        style={styles.container}
        accessible
        accessibilityLabel={`${title}، ${message}`}
        testID={`${testIDPrefix}-${gate}`}
      >
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.messageText}>{message}</Text>
      </View>
    );
  }

  const staleText = t('telemetryCards.state.stale');
  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={
        stale
          ? `${contentAccessibilityLabel}، ${staleText}`
          : contentAccessibilityLabel
      }
      testID={stale ? `${testIDPrefix}-stale` : `${testIDPrefix}-live`}
    >
      <View style={stale ? styles.staleContent : undefined}>
        <Text style={styles.title}>{title}</Text>
        {children}
      </View>
      {stale && (
        <Text style={styles.staleLabel} testID={`${testIDPrefix}-stale-label`}>
          {staleText}
        </Text>
      )}
    </View>
  );
}

/** Shared inner-content styles the three aux cards compose from - kept
 * here so value/caption typography matches BatteryCard's establishment
 * exactly (tabular LTR numerals inside the RTL layout, etc.). */
export const telemetryCardContentStyles = StyleSheet.create({
  /** For Latin/numeric-only primary values (e.g. "RSSI: 53%") - LTR like
   * BatteryCard's voltage. NEVER for Arabic-led strings. */
  primaryValueText: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
    writingDirection: 'ltr',
    marginTop: spacing.sm,
  },
  /** For Arabic-led primary values with embedded digits (e.g.
   * "استخدام المعالج: 42%") - natural RTL, tabular digits. */
  primaryValueArabicText: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
    marginTop: spacing.sm,
  },
  bodyText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  captionText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    fontVariant: ['tabular-nums'],
  },
});

/**
 * COMPACT BY DEFAULT - these are status tiles, not articles.
 *
 * Battery, Receiver, GPS and Sensors share this frame, and it used to
 * spend `spacing.lg` of padding and a section-title-sized heading on each
 * of them. Four cards at that scale filled the screen an operator had
 * just connected to, so the thing they came to check - is there a
 * battery, is the receiver alive, how many satellites, which sensors were
 * detected - could not be taken in at a glance and needed scrolling.
 *
 * The padding, the heading size and the message spacing come down; the
 * VALUES inside each card are untouched, so nothing about what is
 * reported or how it is worded changes - only how much room the frame
 * takes to report it.
 */
const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    flex: 1,
    shadowColor: colors.shadow,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  title: {
    ...typography.label,
    color: colors.accentStrong,
  },
  messageText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  staleContent: {
    opacity: STALE_OPACITY,
  },
  staleLabel: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    marginTop: 2,
  },
});
