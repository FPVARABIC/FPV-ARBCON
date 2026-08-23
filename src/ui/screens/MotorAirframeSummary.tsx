/**
 * M-D §2 ① ② - WHAT THE OPERATOR SEES FIRST.
 *
 * THE PROBLEM THIS REGION EXISTS TO SOLVE. The Motors screen opened on a
 * safety header and then a two-column workspace: a motor selector, a
 * drawing, sliders. All of it useful, none of it answering the questions
 * a person actually arrives with. Which aircraft does this flight
 * controller think it is driving? How many motors did it report? Can I
 * test them right now, or is something in the way? Those were answerable
 * only by reading a diagram that, until M-D, was a quad whatever the
 * aircraft was.
 *
 * Six questions, answered before anything can be commanded:
 *
 *   1. ما نوع الهيكل؟                   the mixer, read from command 42
 *   2. كم عدد المحركات المبلّغ عنها؟      MSP_MOTOR_CONFIG offset 6, alone
 *   3. هل اختبار المحركات متاح؟          the controller's own activation gate
 *   4. ما بروتوكول المحركات؟             MSP_ADVANCED_CONFIG offset 3, raw
 *   5. هل هناك تناقض topology؟           named disagreements, with severity
 *   6. هل الهيكل يستخدم سيرفو أيضًا؟      informational; nothing commandable
 *
 * IT COMPUTES NO TRUTH. Every value arrives decoded, and the sentences
 * come from motorTopologyPresentation, which returns i18n keys rather
 * than text. This file decides LAYOUT. It does not decide how many motors
 * exist, and it cannot: it never sees a count except through
 * commandableMotorScope, whose list comes from the controller's own
 * motorTestPulseMotorNumbers.
 *
 * NO DASHES (M-D §46). A value that is not available says which kind of
 * not-available it is. An em dash in a metric slot reads as "zero, or
 * broken, or loading" and is none of those.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  commandableMotorScope,
  describeAirframe,
  describeExpectedMotorCount,
  describeRuntimeMotorCount,
  describeServoInvolvement,
  highestTopologyNoticeSeverity,
  topologyNotices,
  type TopologyNoticeSeverity,
} from '../../core/state/motorTopologyPresentation';
import {
  deriveMotorTopologyTruth,
  type MotorTopologyTruth,
} from '../../core/state/motorTopologyTruth';
import type { MotorVectorScope } from '../../core/firmware-adapters/betaflightMotorVectorsV147';
import { PROSE_MEASURE, colors, radii, spacing, typography } from '../theme';
import { formatMotorProtocol } from './MotorConfigurationSummary';

export interface MotorAirframeSummaryProps {
  /** MSP_MIXER_CONFIG offset 0, raw. Undefined until the read lands. */
  readonly mixerModeRaw: number | undefined;
  /** MSP_MOTOR_CONFIG offset 6. THE motor count, and the only one. */
  readonly runtimeMotorCount: number | undefined;
  /**
   * The decoded command-safety scope, passed whole.
   *
   * DELIBERATELY NOT A RAW PROTOCOL NUMBER. MotorsScreen carries a
   * containment guard - `re-derives no safety condition of its own` -
   * that refuses to let the screen name motorProtocolRaw, feature3dEnabled
   * or isArmed at all, because a screen that can read those can start
   * deciding with them. Presentation components read the fields; the
   * screen passes the object. Only the protocol NAME is taken from it
   * here, and nothing is decided.
   */
  readonly scope: MotorVectorScope | undefined;
  /** MSP_MOTOR_TELEMETRY's own leading byte, when a frame has arrived.
   *  Reported so a disagreement with the runtime count can be NAMED - it
   *  never redefines the topology. */
  readonly telemetryFrameMotorCount?: number;
  /** The controller's verdict, passed through. This component evaluates
   *  no gate of its own; it only says which way the gate is pointing. */
  readonly motorTestAvailable: boolean;
}

/** Tone per severity. Every one also carries its own words, so meaning
 *  never depends on colour (M-D §47). */
function noticeTone(severity: TopologyNoticeSeverity) {
  switch (severity) {
    case 'CONTRADICTION':
      return styles.noticeContradiction;
    case 'DIAGNOSTIC':
      return styles.noticeDiagnostic;
    case 'INFORMATIONAL':
      return styles.noticeInformational;
  }
}

export function MotorAirframeSummary({
  mixerModeRaw,
  runtimeMotorCount,
  scope,
  telemetryFrameMotorCount,
  motorTestAvailable,
}: MotorAirframeSummaryProps): React.JSX.Element | null {
  const { t } = useTranslation();

  // Nothing has been read yet. Rendering an empty card of unknowns would
  // be worse than rendering nothing: it looks like a machine that
  // answered and had nothing to say.
  if (mixerModeRaw === undefined && runtimeMotorCount === undefined) {
    return null;
  }

  const truth: MotorTopologyTruth = deriveMotorTopologyTruth({
    // A mixer byte that has not arrived is carried as an out-of-table
    // value rather than as a quad, so the airframe reads as unknown -
    // which is exactly what it is.
    mixerModeRaw: mixerModeRaw ?? -1,
    runtimeMotorCount,
    telemetryFrameMotorCount,
  });
  const commandable = commandableMotorScope(truth);
  const notices = topologyNotices(truth);
  const servo = describeServoInvolvement(truth);
  const airframe = describeAirframe(truth);
  const highest = highestTopologyNoticeSeverity(notices);

  const facts: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: string;
  }[] = [
    {
      id: 'count',
      label: t('motorsScreen.summary.motorCountLabel'),
      value: t(
        describeRuntimeMotorCount(commandable).key,
        describeRuntimeMotorCount(commandable).params,
      ),
    },
    {
      id: 'protocol',
      label: t('motorsScreen.summary.protocolLabel'),
      value:
        scope === undefined
          ? t('motorsScreen.summary.protocolNotRead')
          : formatMotorProtocol(scope.motorProtocolRaw),
    },
    {
      id: 'test',
      label: t('motorsScreen.summary.testLabel'),
      value: motorTestAvailable
        ? t('motorsScreen.summary.testAvailable')
        : t('motorsScreen.summary.testUnavailable'),
    },
  ];

  return (
    <View style={styles.root} testID="motors-airframe-summary">
      <View style={styles.headRow}>
        <Text style={styles.eyebrow}>
          {t('motorsScreen.summary.airframeLabel')}
        </Text>
        <Text style={styles.airframe} testID="motors-summary-airframe">
          {t(airframe.key, airframe.params)}
        </Text>
      </View>

      <View style={styles.factRow}>
        {facts.map(fact => (
          <View key={fact.id} style={styles.fact} testID={`motors-summary-${fact.id}`}>
            <Text style={styles.factLabel}>{fact.label}</Text>
            <Text style={styles.factValue}>{fact.value}</Text>
          </View>
        ))}
      </View>

      {/* THE MIXER'S OWN EXPECTATION, and only where it disagrees. On a
          machine whose count matches, repeating "expected 6, reported 6"
          is noise; where they differ it is the whole story, so it is
          shown beside the disagreement rather than as a permanent row. */}
      {highest !== undefined ? (
        <View style={styles.notices} testID="motors-summary-notices">
          {notices.map(notice => (
            <View
              key={notice.id}
              style={[styles.notice, noticeTone(notice.severity)]}
              testID={`motors-summary-notice-${notice.id}`}
            >
              <Text style={styles.noticeText}>
                {t(notice.phrase.key, notice.phrase.params)}
              </Text>
              {notice.comparison !== undefined ? (
                <View style={styles.comparison}>
                  <Text style={styles.comparisonLine}>
                    {t(
                      notice.comparison.expected.key,
                      notice.comparison.expected.params,
                    )}
                  </Text>
                  <Text style={styles.comparisonLine}>
                    {t('motorsScreen.summary.reportedPrefix', {
                      value: t(
                        notice.comparison.reported.key,
                        notice.comparison.reported.params,
                      ),
                    })}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* SERVOS ARE NAMED, NEVER OFFERED (M-D §32). On a tricopter the
          yaw comes from a tail servo; an operator who sees three motor
          controls and nothing else cannot tell whether a fourth output is
          missing or simply is not a motor. */}
      {servo.kind === 'SERVO_OUTPUTS' ? (
        <Text style={styles.servo} testID="motors-summary-servo">
          {t(servo.phrase.key, servo.phrase.params)}
        </Text>
      ) : null}

      {/* The expectation, stated once, where it is not already on a
          notice. Kept out of the fact row on purpose: it is a property of
          the MIXER, and the row above is what the BOARD reported. */}
      {highest === undefined && truth.mixer !== undefined ? (
        <Text style={styles.expected} testID="motors-summary-expected">
          {t(
            describeExpectedMotorCount(truth).key,
            describeExpectedMotorCount(truth).params,
          )}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    maxWidth: PROSE_MEASURE,
    width: '100%',
    alignSelf: 'center',
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.textMuted,
  },
  airframe: {
    ...typography.title,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  fact: {
    minWidth: 96,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 96,
    gap: 2,
  },
  factLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  factValue: {
    ...typography.body,
    color: colors.textPrimary,
  },
  notices: {
    gap: spacing.xs,
  },
  notice: {
    borderRadius: radii.md,
    borderStartWidth: 3,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    gap: 2,
  },
  noticeInformational: {
    borderStartColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  noticeDiagnostic: {
    borderStartColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  noticeContradiction: {
    borderStartColor: colors.error,
    backgroundColor: colors.surfaceAlt,
  },
  noticeText: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  comparison: {
    gap: 0,
  },
  comparisonLine: {
    ...typography.caption,
    color: colors.textMuted,
  },
  servo: {
    ...typography.caption,
    color: colors.textMuted,
  },
  expected: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
