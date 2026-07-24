/**
 * TEMP — Pass 7.5B pitch/front hardware diagnostics — DO NOT MERGE
 *
 * On-screen diagnostic readout for the synchronized hardware test (see
 * docs/PASS_7_5B_PITCH_FRONT_DIAGNOSTIC_PROTOCOL.md). Purely
 * presentational: renders the OrientationDiagnosticsSnapshot it is given
 * (orientationDiagnostics.ts) and computes nothing of its own — no
 * timers, no animation, no subscription; it re-renders only when its
 * caller (SetupScreen) re-renders on a telemetry change.
 *
 * Hidden from the accessibility tree (accessibilityElementsHidden +
 * importantForAccessibility) so the rapidly-updating numbers never
 * produce screen-reader noise — this is camera-facing debug UI only.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import type {OrientationDiagnosticsSnapshot} from './orientationDiagnostics';
import {colors, radii, spacing} from '../../theme';

const DASH = '—';

function signedFixed(value: number | undefined, digits: number): string {
  if (value === undefined) {
    return DASH;
  }
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
}

function plainFixed(value: number | undefined, digits: number): string {
  return value === undefined ? DASH : value.toFixed(digits);
}

export interface TempXyzDiagnosticsPanelProps {
  snapshot: OrientationDiagnosticsSnapshot;
}

export default function TempXyzDiagnosticsPanel({snapshot}: TempXyzDiagnosticsPanelProps): React.JSX.Element {
  const {raw, converted, render, projectedFront} = snapshot;
  const ageLabel = snapshot.ageMs !== undefined ? `${Math.round(snapshot.ageMs)} ms` : DASH;

  return (
    <View
      style={styles.container}
      testID="temp-xyz-diagnostics"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Text style={styles.header}>TEMP XYZ DIAGNOSTICS — DO NOT MERGE</Text>

      <Text style={styles.line}>{`RAW  R:${signedFixed(converted?.rawRollDeg, 1)}°  P:${signedFixed(converted?.rawPitchDeg, 1)}°  H:${plainFixed(converted?.rawYawDeg, 0)}°`}</Text>
      <Text style={styles.line}>{`RAW(dd)  R:${raw ? raw.rollDecidegrees : DASH}  P:${raw ? raw.pitchDecidegrees : DASH}  H:${raw ? raw.yawDegrees : DASH}`}</Text>
      <Text style={styles.line}>{`RENDER  R:${signedFixed(render?.renderRollDeg, 1)}°  P:${signedFixed(render?.renderPitchDeg, 1)}°  Y:${plainFixed(render?.renderYawDeg, 0)}°`}</Text>
      <Text style={styles.line}>{`MODEL FRONT: ${snapshot.modelFrontAxis} / ${snapshot.frontMotors}`}</Text>
      <Text style={styles.line}>{`FRONT ΔX:${signedFixed(projectedFront?.frontScreenDeltaX, 1)}  ΔY:${signedFixed(projectedFront?.frontScreenDeltaY, 1)}  RISE:${signedFixed(projectedFront?.frontRiseFromZero, 1)}`}</Text>
      <Text style={styles.line}>{`AGE: ${ageLabel} / ${snapshot.status}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.lg,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
  },
  header: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  line: {
    color: colors.textPrimary,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    writingDirection: 'ltr',
    textAlign: 'left',
  },
});
