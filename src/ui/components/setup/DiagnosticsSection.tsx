/**
 * Pass 7.7 - Setup Region 4: التشخيص والجاهزية.
 *
 * Display-only, exactly like Region 3's cards: no polling, no timers, no
 * store writes, no second STATUS_EX reader. Everything it renders comes
 * from the ONE existing FC-status poll (extended in place by
 * decodeStatusExDiagnostics) plus the existing Region-1 identification
 * state, reduced to a presentation model by the pure
 * deriveSetupDiagnostics().
 *
 * Truthfulness (enforced in the pure layer, rendered literally here):
 *  - sensors are "reported as detected" only - never "healthy";
 *  - an empty sensor mask is stated as such, never turned into an
 *    FC-health verdict;
 *  - a fresh zero blocker mask says only that the FC reported no blocker
 *    IN THAT READING - the words "ready to fly" appear nowhere;
 *  - stale/short/unsupported/failed/absent data all say blockers cannot
 *    currently be confirmed;
 *  - unknown blocker and sensor bits are shown with their bit index and
 *    hex value rather than discarded or renamed;
 *  - the only Arabic blocker explanations used are the source-proven set
 *    (BLOCKER_TOKENS_WITH_PROVEN_DESCRIPTION); anything else renders its
 *    canonical upstream token instead of an invented meaning.
 *
 * Every state is conveyed in TEXT; color is only ever an addition.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../../icons';
import { readInteraction } from '../controls/interaction';
import { useTranslation } from 'react-i18next';

import {
  BLOCKER_TOKENS_WITH_PROVEN_DESCRIPTION,
  deriveSetupSensorSummary,
} from '../../../core';
import type {
  DiagnosticsBlockers,
  DiagnosticsDataState,
  DiagnosticsSensors,
  SetupDiagnosticsView,
  SetupSensorState,
} from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';

/** The exact translate function useTranslation() hands back - keeps the
 * two pure copy helpers below out of the component without loosening
 * i18next's own option typing. */
type Translate = ReturnType<typeof useTranslation>['t'];

const STALE_OPACITY = 0.45;

/** The shared Region-3 lifecycle copy, reused verbatim so Region 4 can
 * never word the same channel state differently from the card grid. */
const DATA_STATE_LABEL_KEY: Record<DiagnosticsDataState, string> = {
  DISCONNECTED: 'telemetryCards.state.disconnected',
  UNSUPPORTED: 'telemetryCards.state.unsupported',
  UNAVAILABLE: 'telemetryCards.state.unavailable',
  WAITING: 'telemetryCards.state.waiting',
  ERROR: 'telemetryCards.state.error',
  STALE: 'telemetryCards.state.stale',
  FRESH: 'diagnostics.stateLive',
};

const DATA_STATE_COLOR: Record<DiagnosticsDataState, string> = {
  DISCONNECTED: colors.textSecondary,
  UNSUPPORTED: colors.textSecondary,
  UNAVAILABLE: colors.textSecondary,
  WAITING: colors.accent,
  ERROR: colors.error,
  STALE: colors.warning,
  FRESH: colors.success,
};

export interface DiagnosticsSectionProps {
  view: SetupDiagnosticsView;
}

export default function DiagnosticsSection({
  view,
}: DiagnosticsSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stale = view.dataState === 'STALE';

  const identityLines: string[] = [];
  if (view.identity === undefined) {
    identityLines.push(
      t(
        view.compatibility === 'IDENTIFICATION_FAILED'
          ? 'diagnostics.identityFailed'
          : 'diagnostics.identityIdentifying',
      ),
    );
  } else {
    identityLines.push(
      t('diagnostics.identityBoard', { value: view.identity.boardName }),
    );
    identityLines.push(
      t('diagnostics.identityFirmware', {
        identifier: view.identity.firmwareIdentifier,
        major: view.identity.apiVersionMajor,
        minor: view.identity.apiVersionMinor,
      }),
    );
  }

  const compatibilityText = t(
    view.compatibility === 'BETAFLIGHT_API_1_47'
      ? 'diagnostics.compatibilityBetaflight147'
      : view.compatibility === 'OTHER_FIRMWARE_OR_API'
      ? 'diagnostics.compatibilityOther'
      : view.compatibility === 'IDENTIFICATION_FAILED'
      ? 'diagnostics.compatibilityFailed'
      : 'diagnostics.compatibilityIdentifying',
  );

  const dataStateText = t(DATA_STATE_LABEL_KEY[view.dataState]);
  const sensorLines = describeSensors(view.sensors, t);
  const blockerLines = describeBlockers(view.blockers, t);

  return (
    <View style={styles.section} testID="diagnostics-section">
      <Pressable
        onPress={() => setDetailsOpen(current => !current)}
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        style={state => {
          const {pressed, hovered} = readInteraction(state);
          return [
            styles.sectionHeader,
            (hovered || pressed) && styles.sectionHeaderActive,
          ];
        }}
        testID="diagnostics-toggle"
      >
        <View style={styles.sectionHeading}>
          <Text
            style={styles.sectionTitle}
            accessibilityRole="header"
            testID="diagnostics-title"
          >
            {t('diagnostics.title')}
          </Text>
          <Text style={styles.sectionSummary}>{dataStateText}</Text>
        </View>
        <View style={styles.togglePill}>
          <Text style={styles.toggleText}>
            {t(
              detailsOpen
                ? 'diagnostics.hideDetails'
                : 'diagnostics.showDetails',
            )}
          </Text>
          <Icon
            name={detailsOpen ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.accentStrong}
          />
        </View>
      </Pressable>

      <View
        style={!detailsOpen ? styles.detailsCollapsed : undefined}
        accessibilityElementsHidden={!detailsOpen}
        importantForAccessibility={detailsOpen ? 'auto' : 'no-hide-descendants'}
        testID="diagnostics-details"
      >
        <Block
          testID="diagnostics-identity"
          heading={t('diagnostics.identityHeading')}
          lines={identityLines}
          dim={false}
        />
        <Block
          testID="diagnostics-compatibility"
          heading={t('diagnostics.compatibilityHeading')}
          lines={[compatibilityText]}
          dim={false}
        />
        <Block
          testID="diagnostics-reading-state"
          heading={t('diagnostics.stateHeading')}
          lines={[dataStateText]}
          lineColor={DATA_STATE_COLOR[view.dataState]}
          dim={false}
        />
        <Block
          testID="diagnostics-sensors"
          heading={t('diagnostics.sensorsHeading')}
          lines={sensorLines}
          dim={stale}
        />
        <Block
          testID="diagnostics-blockers"
          heading={t('diagnostics.blockersHeading')}
          lines={blockerLines}
          dim={stale}
        />
      </View>
    </View>
  );
}

/**
 * Sensor copy: DETECTION only, never health.
 *
 * SETUP P1 - the list is now EXHAUSTIVE. It used to print only the bits
 * that were set, so a flight controller reporting no gyro produced a
 * shorter list rather than a visible "GYRO — غير مكتشف": the single most
 * important sensor fact an operator can be told was rendered as the
 * absence of a line. Every canonical sensor is now named with its own
 * state, from the shared derivation
 * (src/core/state/setupSafetyModel.ts's deriveSetupSensorSummary), so
 * this section and any future sensor card cannot disagree.
 *
 * The three states are DETECTED / NOT_DETECTED / UNKNOWN. There is no
 * HEALTHY or UNHEALTHY wording anywhere, because the firmware mask
 * proves the FC found the hardware and nothing whatsoever about whether
 * it is working. Unknown bits keep their hex and are still listed.
 */
function describeSensors(sensors: DiagnosticsSensors, t: Translate): string[] {
  const summary = deriveSetupSensorSummary(sensors);
  const stateKey: Record<SetupSensorState, string> = {
    DETECTED: 'diagnostics.sensorDetected',
    NOT_DETECTED: 'diagnostics.sensorNotDetected',
    UNKNOWN: 'diagnostics.sensorUnknown',
  };
  const lines = summary.entries.map(entry =>
    t('diagnostics.sensorLine', {
      token: entry.token,
      state: t(stateKey[entry.state]),
    }),
  );
  if (summary.unconfirmed) {
    // Keep the explicit "nothing currently proves anything" sentence at
    // the top: an all-UNKNOWN list must not read as seven findings.
    return [t('diagnostics.sensorsUnconfirmed'), ...lines];
  }
  const anyDetected = summary.entries.some(entry => entry.state === 'DETECTED');
  const unknownLines = summary.unknownBits.map(bit =>
    t('diagnostics.sensorsUnknownBit', { hex: bit.hex }),
  );
  if (!anyDetected && unknownLines.length === 0) {
    // A mask that carried no set bit at all. The per-sensor lines below
    // are still true, but the leading sentence keeps the nuance the mask
    // itself has: the FC reported a mask and named nothing in it - which
    // is unusual, and is not the same claim as "this aircraft has no
    // sensors fitted".
    return [t('diagnostics.sensorsNoneInReading'), ...lines];
  }
  return [...lines, ...unknownLines];
}

/** Blocker copy: source-proven Arabic where proven, canonical token
 * otherwise, unknown bits preserved numerically AND in hex. */
function describeBlockers(
  blockers: DiagnosticsBlockers,
  t: Translate,
): string[] {
  if (blockers.kind === 'UNCONFIRMED') {
    return [t('diagnostics.blockersUnconfirmed')];
  }
  if (blockers.kind === 'MALFORMED') {
    // Inconsistent data, stated as such - never "no blockers".
    return [t('diagnostics.blockersMalformed')];
  }
  if (blockers.kind === 'NONE_IN_THIS_READING') {
    return [t('diagnostics.blockersNoneInReading')];
  }
  return blockers.bits.map(bit => {
    if (bit.kind === 'UNKNOWN') {
      return t('diagnostics.blockersUnknownBit', {
        bit: bit.bit,
        hex: bit.hex,
      });
    }
    if (!BLOCKER_TOKENS_WITH_PROVEN_DESCRIPTION.includes(bit.token)) {
      return t('diagnostics.blockerFallback', { token: bit.token });
    }
    return `${t(`diagnostics.blockerDescriptions.${bit.token}`)} (${
      bit.token
    })`;
  });
}

/** One labelled block; the whole block is a single accessibility node so
 * the reading order is heading-then-content, matching the visual order. */
function Block({
  testID,
  heading,
  lines,
  lineColor,
  dim,
}: {
  testID: string;
  heading: string;
  lines: string[];
  lineColor?: string;
  dim: boolean;
}): React.JSX.Element {
  return (
    <View
      style={[styles.block, dim ? styles.dimmed : undefined]}
      accessible
      accessibilityLabel={`${heading}، ${lines.join('، ')}`}
      testID={testID}
    >
      <Text style={styles.blockHeading}>{heading}</Text>
      {lines.map((line, index) => (
        <Text
          key={`${testID}-${index}`}
          style={[
            styles.blockLine,
            lineColor !== undefined ? { color: lineColor } : undefined,
          ]}
          testID={`${testID}-line-${index}`}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.md,
    marginHorizontal: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 4,
  },
  sectionHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderRadius: radii.sm,
  },
  sectionHeaderActive: { backgroundColor: colors.surfaceHover },
  sectionHeading: {
    flex: 1,
    gap: spacing.xs,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  sectionSummary: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  togglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.accentSoft,
    borderRadius: radii.pill,
  },
  toggleText: {
    ...typography.label,
    color: colors.accentStrong,
    writingDirection: 'rtl',
  },
  detailsCollapsed: {
    display: 'none',
  },
  block: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
  },
  dimmed: {
    opacity: STALE_OPACITY,
  },
  blockHeading: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  blockLine: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
});
