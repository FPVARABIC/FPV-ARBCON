import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type {
  MspMotorOutputs,
  MspMotorTelemetry,
  TelemetryValue,
} from '../../core';
import type {
  MotorTestDiagnosticsChannelState as ControllerDiagnosticsChannelState,
  MotorTestDiagnosticsSnapshot,
} from '../../core/state/motorTestController';
import {
  hasEscTelemetrySource,
  visibleMotorTelemetryMetrics,
  type MotorDiagnosticsSupport,
  type MotorTelemetryVisibleMetrics,
} from '../../core/state/motorDiagnosticsSemantics';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import {
  acquireMotorDiagnosticsTelemetry,
  getMotorDiagnosticsAvailability,
  MOTOR_ESC_TELEMETRY_POLL_ID,
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
  subscribeMotorDiagnosticsAvailability,
  useTelemetryValue,
  type MotorDiagnosticsAvailability,
  type MotorDiagnosticsChannelState,
} from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../theme';

const DEFAULT_VISIBLE_MOTOR_COUNT = 4;
const MAX_VISIBLE_MOTOR_COUNT = 8;
const OUTPUT_STOP_VALUE = 1000;
const OUTPUT_FULL_VALUE = 2000;
const RPM_METER_MAX = 50_000;
const LEASED_DIAGNOSTICS_STALE_AFTER_MILLIS = 2_000;

export function motorOutputPercent(value: number): number {
  return Math.max(
    0,
    Math.min(
      100,
      ((value - OUTPUT_STOP_VALUE) / (OUTPUT_FULL_VALUE - OUTPUT_STOP_VALUE)) *
        100,
    ),
  );
}

export function rpmMeterPercent(rpm: number): number {
  return Math.max(0, Math.min(100, (rpm / RPM_METER_MAX) * 100));
}

function useAvailability(
  sessionId: string,
  escTelemetryEnabled: boolean,
): MotorDiagnosticsAvailability {
  const [availability, setAvailability] = useState(() =>
    getMotorDiagnosticsAvailability(sessionId),
  );

  useEffect(() => {
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      escTelemetryEnabled,
    );
    const publish = () =>
      setAvailability(getMotorDiagnosticsAvailability(sessionId));
    const unsubscribe = subscribeMotorDiagnosticsAvailability(
      sessionId,
      publish,
    );
    publish();
    return () => {
      unsubscribe();
      release();
    };
  }, [escTelemetryEnabled, sessionId]);

  return availability;
}

function channelText(
  t: (key: string) => string,
  channel: MotorDiagnosticsChannelState,
  valueStatus: TelemetryValue<unknown>['status'],
): string {
  if (channel === 'UNSUPPORTED') {
    return t('motorDiagnostics.unsupported');
  }
  if (channel === 'NOT_ENABLED') {
    return t('motorDiagnostics.notEnabled');
  }
  if (channel === 'MALFORMED_RESPONSE') {
    return t('motorDiagnostics.malformed');
  }
  if (channel === 'LINK_FAILED') {
    return t('motorDiagnostics.linkFailed');
  }
  if (channel === 'WAITING_FOR_SESSION' || valueStatus === 'UNAVAILABLE') {
    return t('motorDiagnostics.unavailable');
  }
  if (valueStatus === 'WAITING') {
    return t('motorDiagnostics.waiting');
  }
  if (valueStatus === 'STALE') {
    return t('motorDiagnostics.stale');
  }
  if (valueStatus === 'ERROR') {
    return t('motorDiagnostics.linkFailed');
  }
  return t('motorDiagnostics.live');
}

function visibleValue<T>(value: TelemetryValue<T>): T | undefined {
  return value.status === 'FRESH' ? value.value : undefined;
}

function leasedAvailability(
  channel: {readonly state: ControllerDiagnosticsChannelState} | undefined,
): MotorDiagnosticsChannelState {
  if (channel === undefined || channel.state === 'WAITING') {
    return 'WAITING_FOR_SESSION';
  }
  return channel.state === 'FRESH' ? 'ACTIVE' : channel.state;
}

function Meter({ percent, danger }: { percent: number; danger?: boolean }) {
  return (
    <View style={styles.meterTrack}>
      <View
        style={[
          styles.meterFill,
          danger && styles.meterFillDanger,
          { width: `${percent}%` },
        ]}
      />
    </View>
  );
}

export interface MotorDiagnosticsPanelProps {
  readonly sessionId: string;
  readonly operator?: MotorTestOperatorPort;
  readonly activeMotorTest?: boolean;
  readonly motorTestDiagnostics?: MotorTestDiagnosticsSnapshot;
  readonly support?: MotorDiagnosticsSupport;
}

export function MotorDiagnosticsPanel({
  sessionId,
  operator,
  activeMotorTest = false,
  motorTestDiagnostics,
  support,
}: MotorDiagnosticsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  const escTelemetryEnabled = hasEscTelemetrySource(support);
  const availability = useAvailability(sessionId, escTelemetryEnabled);
  const outputsValue = useTelemetryValue<MspMotorOutputs>(
    sessionId,
    MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
  );
  const escValue = useTelemetryValue<MspMotorTelemetry>(
    sessionId,
    MOTOR_ESC_TELEMETRY_POLL_ID,
  );

  useEffect(() => {
    if (!activeMotorTest || operator === undefined) {
      return;
    }
    let active = true;
    const refresh = () => {
      setNowMillis(Date.now());
      operator
        .refreshDiagnostics()
        .catch(() => undefined)
        .finally(() => {
          if (active) {
            setNowMillis(Date.now());
          }
        });
    };
    refresh();
    const timer = setInterval(refresh, 650);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeMotorTest, operator]);

  const leasedOutputs = motorTestDiagnostics?.outputs;
  const leasedEsc = motorTestDiagnostics?.escTelemetry;
  const leasedOutputsFresh =
    leasedOutputs?.state === 'FRESH' &&
    leasedOutputs.observedAtMillis !== undefined &&
    Math.max(0, nowMillis - leasedOutputs.observedAtMillis) <=
      LEASED_DIAGNOSTICS_STALE_AFTER_MILLIS;
  const leasedEscFresh =
    leasedEsc?.state === 'FRESH' &&
    leasedEsc.observedAtMillis !== undefined &&
    Math.max(0, nowMillis - leasedEsc.observedAtMillis) <=
      LEASED_DIAGNOSTICS_STALE_AFTER_MILLIS;
  const outputs = activeMotorTest
    ? leasedOutputsFresh
      ? leasedOutputs.value
      : undefined
    : visibleValue(outputsValue);
  const sourceProvenUnavailable = support?.escTelemetrySource === 'NONE';
  const escTelemetry = sourceProvenUnavailable
    ? undefined
    : activeMotorTest
    ? leasedEscFresh
      ? leasedEsc.value
      : undefined
    : visibleValue(escValue);
  const outputsAvailability: MotorDiagnosticsChannelState = activeMotorTest
    ? leasedAvailability(leasedOutputs)
    : availability.outputs;
  const escAvailability: MotorDiagnosticsChannelState =
    sourceProvenUnavailable
      ? 'NOT_ENABLED'
      : activeMotorTest
        ? leasedAvailability(leasedEsc)
        : availability.escTelemetry;
  const outputsStatus: TelemetryValue<unknown>['status'] = activeMotorTest
    ? leasedOutputsFresh
      ? 'FRESH'
      : leasedOutputs?.state === 'FRESH'
        ? 'STALE'
        : leasedOutputs?.state === 'WAITING' || leasedOutputs === undefined
          ? 'WAITING'
          : 'ERROR'
    : outputsValue.status;
  const escStatus: TelemetryValue<unknown>['status'] =
    sourceProvenUnavailable
      ? 'UNAVAILABLE'
      : activeMotorTest
        ? leasedEscFresh
          ? 'FRESH'
          : leasedEsc?.state === 'FRESH'
            ? 'STALE'
            : leasedEsc?.state === 'WAITING' || leasedEsc === undefined
              ? 'WAITING'
              : 'ERROR'
        : escValue.status;

  const visibleMotorCount =
    support !== undefined &&
    Number.isInteger(support.motorCount) &&
    support.motorCount > 0
      ? Math.min(MAX_VISIBLE_MOTOR_COUNT, support.motorCount)
      : DEFAULT_VISIBLE_MOTOR_COUNT;

  const outputSlots = useMemo(
    () =>
      Array.from({ length: visibleMotorCount }, (_, index) => ({
        slot: index + 1,
        value: outputs?.values[index],
      })),
    [outputs, visibleMotorCount],
  );

  return (
    <View style={styles.root} testID="motor-diagnostics-panel">
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t('motorDiagnostics.eyebrow')}</Text>
          <Text style={styles.title}>{t('motorDiagnostics.title')}</Text>
          <Text style={styles.caption}>{t('motorDiagnostics.subtitle')}</Text>
        </View>
        <View style={styles.liveBadge}>
          <View
            style={[
              styles.statusDot,
              outputsAvailability === 'ACTIVE' && outputsStatus === 'FRESH'
                ? styles.statusDotLive
                : styles.statusDotIdle,
            ]}
          />
          <Text style={styles.badgeText}>
            {channelText(t, outputsAvailability, outputsStatus)}
          </Text>
        </View>
      </View>

      <View style={styles.section} testID="motor-output-readings">
        <Text style={styles.sectionTitle}>
          {t('motorDiagnostics.outputsHeading')}
        </Text>
        <Text style={styles.caption}>
          {t('motorDiagnostics.outputsDisclaimer')}
        </Text>
        <View style={styles.outputGrid}>
          {outputSlots.map(output => (
            <View
              key={output.slot}
              style={styles.outputCard}
              testID={`motor-output-reading-${output.slot}`}
            >
              <View style={styles.valueRow}>
                <Text style={styles.slotName}>{`M${output.slot}`}</Text>
                <Text style={styles.numericValue}>
                  {output.value === undefined ? '—' : output.value}
                </Text>
              </View>
              <Meter
                percent={
                  output.value === undefined
                    ? 0
                    : motorOutputPercent(output.value)
                }
              />
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section} testID="esc-telemetry-readings">
        <View style={styles.sectionHeadingRow}>
          <View style={styles.headerCopy}>
            <Text style={styles.sectionTitle}>
              {t('motorDiagnostics.escHeading')}
            </Text>
            <Text style={styles.caption}>
              {t('motorDiagnostics.escDetail')}
            </Text>
          </View>
          <Text style={styles.channelState}>
            {channelText(t, escAvailability, escStatus)}
          </Text>
        </View>

        <Text style={styles.sourceText} testID="esc-telemetry-source">
          {support === undefined
            ? t('motorDiagnostics.sourceUnknown')
            : t(
                `motorDiagnostics.source.${support.escTelemetrySource}`,
              )}
        </Text>

        {support?.dshotTelemetryEnabled === true &&
        escTelemetry?.motors.some(motor => motor.invalidPercentRaw >= 100) ? (
          <Text
            style={styles.qualityWarning}
            testID="esc-telemetry-quality-warning"
          >
            {t('motorDiagnostics.qualityWarning')}
          </Text>
        ) : null}

        {escTelemetry !== undefined && escTelemetry.motors.length > 0 ? (
          <View style={styles.escList}>
            {escTelemetry.motors
              .slice(0, visibleMotorCount)
              .map((motor, index) => {
                const metrics = visibleMotorTelemetryMetrics(motor, support);
                const invalidPercent =
                  metrics.invalidPercentRaw === undefined
                    ? undefined
                    : metrics.invalidPercentRaw / 100;
                return (
                  <View
                    key={index}
                    style={styles.escCard}
                    testID={`esc-telemetry-${index + 1}`}
                  >
                    <View style={styles.valueRow}>
                      <Text style={styles.slotName}>{`M${index + 1}`}</Text>
                      <Text style={styles.rpmValue}>
                        {metrics.rpm === undefined
                          ? '— RPM'
                          : t('motorDiagnostics.rpmValue', {
                              rpm: metrics.rpm,
                            })}
                      </Text>
                    </View>
                    <Meter
                      percent={
                        metrics.rpm === undefined
                          ? 0
                          : rpmMeterPercent(metrics.rpm)
                      }
                      danger={
                        invalidPercent !== undefined && invalidPercent >= 1
                      }
                    />
                    <EscMetrics metrics={metrics} />
                  </View>
                );
              })}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {channelText(t, escAvailability, escStatus)}
            </Text>
            <Text style={styles.caption}>
              {t('motorDiagnostics.noEscTelemetry')}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function EscMetrics({
  metrics,
}: {
  readonly metrics: MotorTelemetryVisibleMetrics;
}): React.JSX.Element {
  const {t} = useTranslation();
  const unavailable = t('motorDiagnostics.metricUnavailable');
  return (
    <View style={styles.metricGrid}>
      <Text style={styles.metric}>
        {metrics.invalidPercentRaw === undefined
          ? t('motorDiagnostics.invalidPercentUnavailable', {
              value: unavailable,
            })
          : t('motorDiagnostics.invalidPercent', {
              value: (metrics.invalidPercentRaw / 100).toFixed(2),
            })}
      </Text>
      <Text style={styles.metric}>
        {t('motorDiagnostics.temperature', {
          value: metrics.temperatureCelsius ?? unavailable,
        })}
      </Text>
      <Text style={styles.metric}>
        {t('motorDiagnostics.voltage', {
          value:
            metrics.voltageVolts === undefined
              ? unavailable
              : metrics.voltageVolts.toFixed(2),
        })}
      </Text>
      <Text style={styles.metric}>
        {t('motorDiagnostics.current', {
          value:
            metrics.currentAmps === undefined
              ? unavailable
              : metrics.currentAmps.toFixed(2),
        })}
      </Text>
      <Text style={styles.metric}>
        {t('motorDiagnostics.consumption', {
          value: metrics.consumptionMah ?? unavailable,
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.lg,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headerCopy: { flex: 1, gap: spacing.xs },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotLive: { backgroundColor: colors.success },
  statusDotIdle: { backgroundColor: colors.textMuted },
  badgeText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  section: { gap: spacing.sm },
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  channelState: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  sourceText: {
    ...typography.caption,
    color: colors.textMuted,
    writingDirection: 'rtl',
  },
  outputGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  outputCard: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 130,
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  slotName: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '900',
    writingDirection: 'ltr',
  },
  numericValue: {
    ...typography.mono,
    color: colors.accent,
    writingDirection: 'ltr',
  },
  meterTrack: {
    height: 8,
    backgroundColor: colors.borderSoft,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
  },
  meterFillDanger: { backgroundColor: colors.warning },
  escList: { gap: spacing.sm },
  escCard: {
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  rpmValue: {
    ...typography.mono,
    color: colors.textPrimary,
    writingDirection: 'ltr',
  },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metric: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  emptyState: {
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  emptyTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  qualityWarning: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});
