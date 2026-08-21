import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  rpmIsUnprovenZero,
  visibleMotorTelemetryMetrics,
  type MotorDiagnosticsSupport,
  type MotorTelemetryVisibleMetrics,
} from '../../core/state/motorDiagnosticsSemantics';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import {
  acquireMotorDiagnosticsTelemetry,
  getMotorDiagnosticsAvailability,
  getMotorDiagnosticsSupport,
  MOTOR_ESC_TELEMETRY_POLL_ID,
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID,
  subscribeMotorDiagnosticsAvailability,
  useTelemetryValue,
  type MotorDiagnosticsAvailability,
  type MotorDiagnosticsChannelState,
} from '../../platforms/react-native/protocol';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

const DEFAULT_VISIBLE_MOTOR_COUNT = 4;
const MAX_VISIBLE_MOTOR_COUNT = 8;
const OUTPUT_STOP_VALUE = 1000;
const OUTPUT_FULL_VALUE = 2000;
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

interface ObservedDiagnostics {
  readonly availability: MotorDiagnosticsAvailability;
  /** Derived from this session's OWN MSP_MOTOR_CONFIG reply, or undefined
   * when none has arrived yet. Undefined means "not read", never "none". */
  readonly support: MotorDiagnosticsSupport | undefined;
}

function useObservedDiagnostics(
  sessionId: string,
  escTelemetryEnabled: boolean,
): ObservedDiagnostics {
  const [observed, setObserved] = useState<ObservedDiagnostics>(() => ({
    availability: getMotorDiagnosticsAvailability(sessionId),
    support: getMotorDiagnosticsSupport(sessionId),
  }));

  useEffect(() => {
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      escTelemetryEnabled,
    );
    const publish = () =>
      setObserved({
        availability: getMotorDiagnosticsAvailability(sessionId),
        support: getMotorDiagnosticsSupport(sessionId),
      });
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

  return observed;
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
  /* NOT THE SAME SENTENCE AS NOT_ENABLED, and the difference is the whole
     point of this state: "no telemetry source is enabled" is a diagnosis
     of the operator's aircraft, and it may only be said once this session
     has actually read MSP_MOTOR_CONFIG. Until then the app says what is
     true of ITSELF. */
  if (channel === 'SOURCE_UNKNOWN') {
    return t('motorDiagnostics.sourceUnknownShort');
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
  support: sessionSupport,
}: MotorDiagnosticsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  const [sourceOpen, setSourceOpen] = useState(false);
  /* THE FLAG PASSED TO THE TELEMETRY MODULE STAYS THE SESSION'S OWN.
     Feeding the module's derived support back in as the acquisition flag
     would make the reference count oscillate as the derivation arrives
     and is dropped; the module ORs its own reading in on its side. */
  const escTelemetryEnabled = hasEscTelemetrySource(sessionSupport);
  const observed = useObservedDiagnostics(sessionId, escTelemetryEnabled);
  const availability = observed.availability;
  /* AN OPEN MOTOR-TEST SESSION IS THE STRONGER EVIDENCE - it read the
     motor configuration through its own serialized lease - but it is not
     the ONLY evidence, and outside a session it does not exist at all.
     Falling back to the module's own read is what lets this panel report
     a proven source (and poll for it) on a plainly connected aircraft. */
  const support = sessionSupport ?? observed.support;
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

  /**
   * DID ANY BIDIRECTIONAL-DSHOT PACKET EVER ARRIVE?
   *
   * `rpmIsUnprovenZero` is the firmware's own discriminator - rpm 0 with
   * invalidPct still pinned at its 100.00% default - so "every motor is
   * an unproven zero" is the honest reading of "no telemetry stream", and
   * "some motor reports errors while its reading is real" is the honest
   * reading of "the stream is poor". They are never both shown.
   */
  const escMotors = escTelemetry?.motors ?? [];
  const qualityDegraded =
    support?.dshotTelemetryEnabled === true &&
    escMotors.some(
      motor =>
        !rpmIsUnprovenZero(motor, support) && motor.invalidPercentRaw >= 100,
    );
  const noDshotPacketsAtAll =
    support?.dshotTelemetryEnabled === true &&
    escMotors.length > 0 &&
    escMotors.every(motor => rpmIsUnprovenZero(motor, support));
  /** True when not one output carries a single electrical or thermal value. */
  const noMetricsAnywhere =
    escMotors.length > 0 &&
    escMotors.every(motor => {
      const m = visibleMotorTelemetryMetrics(motor, support);
      return (
        m.invalidPercentRaw === undefined &&
        m.temperatureCelsius === undefined &&
        m.voltageVolts === undefined &&
        m.currentAmps === undefined &&
        m.consumptionMah === undefined
      );
    });

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
          </View>
          <Text style={styles.channelState}>
            {channelText(t, escAvailability, escStatus)}
          </Text>
        </View>

        {/* THE SOURCE, WHERE THE SOURCE MATTERS.
            When the controller PROVED there is no source, that sentence
            is the whole answer and stays in place. When readings are
            arriving, which of the two sources produced them - and which
            extended fields that source can carry - is provenance for a
            reader who wants it, not a standing paragraph above four
            numbers. It moves behind one disclosure, with the "appears
            only when firmware and ESC support it" caption that used to
            sit under the heading. Nothing is deleted. */}
        {sourceProvenUnavailable ? (
          <Text style={styles.sourceText} testID="esc-telemetry-source">
            {support === undefined
              ? t('motorDiagnostics.sourceUnknown')
              : t(`motorDiagnostics.source.${support.escTelemetrySource}`)}
          </Text>
        ) : (
          <>
            <Pressable
              onPress={() => setSourceOpen(open => !open)}
              accessibilityRole="button"
              accessibilityState={{expanded: sourceOpen}}
              accessibilityLabel={t('motorDiagnostics.escHeading')}
              style={styles.sourceToggle}
              testID="esc-telemetry-source-toggle"
            >
              <Text style={styles.sourceToggleText}>
                {t('motorsScreen.detailsToggle')}
              </Text>
            </Pressable>
            {sourceOpen ? (
              <View style={styles.sourceDetails}>
                <Text style={styles.sourceText} testID="esc-telemetry-source">
                  {support === undefined
                    ? t('motorDiagnostics.sourceUnknown')
                    : t(`motorDiagnostics.source.${support.escTelemetrySource}`)}
                </Text>
                <Text style={styles.caption}>
                  {t('motorDiagnostics.escDetail')}
                </Text>
              </View>
            ) : null}
          </>
        )}

        {/* TWO DIFFERENT FACTS THAT USED TO SHARE ONE SENTENCE.
            The warning below claims a QUALITY problem: packets arrive and
            more than 1% of them are bad. It used to fire on
            `invalidPercentRaw >= 100` alone - which is also true of
            Betaflight's 10000 (100.00%) default, the value the firmware
            writes when NOTHING has ever arrived. So a bench whose ESCs do
            not speak bidirectional DShot at all was told to "check the
            signal quality", which is a diagnosis of a stream that does not
            exist. The unproven-zero test now separates them, and each case
            gets the sentence that is true of it. */}
        {qualityDegraded ? (
          <Text
            style={styles.qualityWarning}
            testID="esc-telemetry-quality-warning"
          >
            {t('motorDiagnostics.qualityWarning')}
          </Text>
        ) : null}
        {noDshotPacketsAtAll ? (
          <Text
            style={styles.qualityWarning}
            testID="esc-telemetry-no-packets"
          >
            {t('motorDiagnostics.rpmUnprovenHint')}
          </Text>
        ) : null}
        {/* SAID ONCE, NOT ONCE PER MOTOR. When the same sentence is true
            of every output, four copies of it are three copies of noise -
            and they are what turned "no telemetry" into a section as tall
            as one with readings in it. */}
        {noMetricsAnywhere ? (
          <Text
            style={styles.caption}
            testID="esc-telemetry-metrics-unavailable"
          >
            {t('motorDiagnostics.metricsAllUnavailableEverywhere')}
          </Text>
        ) : null}

        {escTelemetry !== undefined && escTelemetry.motors.length > 0 ? (
          <View style={styles.escList}>
            {escTelemetry.motors
              .slice(0, visibleMotorCount)
              .map((motor, index) => {
                const metrics = visibleMotorTelemetryMetrics(motor, support);
                return (
                  /* ONE ROW PER OUTPUT.
                     Each reading used to be a filled card holding a value
                     row, a progress bar and a five-cell metric grid - four
                     of them, stacked. The bar is gone: RPM has no
                     operator-meaningful full scale (the old one was a flat
                     50,000 constant this file invented), so a bar computed
                     against it could not help anyone decide anything. The
                     NUMBERS are all still here, and none of them changed. */
                  <View
                    key={index}
                    style={styles.escRow}
                    testID={`esc-telemetry-${index + 1}`}
                  >
                    <Text style={styles.slotName}>{`M${index + 1}`}</Text>
                    <Text style={styles.escReading}>
                      {metrics.rpm === undefined
                        ? '— RPM'
                        : t('motorDiagnostics.rpmValue', {rpm: metrics.rpm})}
                    </Text>
                    {noMetricsAnywhere ? null : (
                      <EscMetrics metrics={metrics} />
                    )}
                    {/* A DASH WITHOUT A REASON IS A RIDDLE - but the
                        reason is said once for the section when it is
                        true of every output, and only here when it is
                        true of this one alone. */}
                    {rpmIsUnprovenZero(motor, support) &&
                    !noDshotPacketsAtAll ? (
                      <Text
                        style={styles.caption}
                        testID={`esc-telemetry-${index + 1}-rpm-unproven`}
                      >
                        {t('motorDiagnostics.rpmUnproven')}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
          </View>
        ) : (
          /* NOT ENABLED IS A KNOWN ANSWER, NOT AN AMBIGUITY, so it gets
             the smallest surface on the screen: what is off, and what to
             turn on. No empty rows, no empty meters, no second paragraph
             restating the first. */
          <Text style={styles.caption} testID="esc-telemetry-empty">
            {t(
              sourceProvenUnavailable
                ? 'motorDiagnostics.enableEscTelemetry'
                : /* AND WHEN NOTHING HAS BEEN READ, SAY THAT. "Enable DShot
                     telemetry or an ESC sensor" is advice premised on having
                     found them switched off. With no motor configuration
                     read, that premise does not exist, and the honest line
                     is the one about this app's own state. */
                  support === undefined
                  ? 'motorDiagnostics.sourceUnknown'
                  : 'motorDiagnostics.noEscTelemetry',
            )}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * THE PER-MOTOR ELECTRICAL DETAIL - and nothing at all when there is none.
 *
 * A grid of five "—" is a large object that says one small thing, and it
 * says it five times. When the source proves that not one of these fields
 * carries a value, the grid collapses to a single short line. The claim is
 * identical; the surface is a fifth of the height.
 */
function EscMetrics({
  metrics,
}: {
  readonly metrics: MotorTelemetryVisibleMetrics;
}): React.JSX.Element | null {
  const {t} = useTranslation();
  /* ONE LINE, AND ONLY THE PARTS THAT EXIST.
     A grid of five cells - four of them "—" on a DShot-only bench - is a
     large object saying one small thing five times. Each metric is
     joined only when it carries a value, so an absent field takes no
     space at all and a present one reads exactly as before. */
  const parts = [
    metrics.invalidPercentRaw === undefined
      ? undefined
      : t('motorDiagnostics.invalidPercent', {
          value: (metrics.invalidPercentRaw / 100).toFixed(2),
        }),
    metrics.temperatureCelsius === undefined
      ? undefined
      : t('motorDiagnostics.temperature', {value: metrics.temperatureCelsius}),
    metrics.voltageVolts === undefined
      ? undefined
      : t('motorDiagnostics.voltage', {value: metrics.voltageVolts.toFixed(2)}),
    metrics.currentAmps === undefined
      ? undefined
      : t('motorDiagnostics.current', {value: metrics.currentAmps.toFixed(2)}),
    metrics.consumptionMah === undefined
      ? undefined
      : t('motorDiagnostics.consumption', {value: metrics.consumptionMah}),
  ].filter((part): part is string => part !== undefined);

  if (parts.length === 0) {
    return (
      <Text style={styles.metric}>
        {t('motorDiagnostics.metricsAllUnavailable')}
      </Text>
    );
  }
  return <Text style={styles.metric}>{parts.join(' · ')}</Text>;
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
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
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
    writingDirection: 'rtl'},
  section: { gap: spacing.sm },
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
  channelState: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  sourceText: {
    ...typography.caption,
    color: colors.textMuted,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  sourceToggle: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  sourceToggleText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  sourceDetails: {gap: spacing.xs},
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
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  numericValue: {
    ...typography.mono,
    color: colors.accentStrong,
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
  /* FOUR ROWS, NOT FOUR CARDS. A thin rule between outputs is all the
     separation a list of four readings needs; the filled, rounded,
     padded card per motor was carrying a bar and a five-cell grid that
     no longer exist. */
  escList: { gap: 0 },
  escRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  escReading: {
    ...typography.mono,
    color: colors.textPrimary,
    writingDirection: 'ltr',
  },
  metric: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  qualityWarning: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
