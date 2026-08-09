/* eslint-disable no-bitwise -- MSP_STATUS_EX sensor presence is a firmware bit mask. */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  MspAltitude,
  MspRawImu,
  MspStatusExCompact,
  SensorVector3,
  TelemetryValue,
} from '../../core';
import {
  acquireSensorsTelemetry,
  FC_STATUS_TELEMETRY_POLL_ID,
  SENSOR_ALTITUDE_POLL_ID,
  SENSOR_IMU_POLL_ID,
  useTelemetryValue,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  colors,
  radii,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';
import { Button } from '../components/controls';
interface Props {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenSetup: () => void;
}
interface Sample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
function valueOf<T>(value: TelemetryValue<T>): T | undefined {
  return value.status === 'FRESH' || value.status === 'STALE'
    ? value.value
    : undefined;
}
function present(mask: number | undefined, bit: number): boolean | undefined {
  return mask === undefined ? undefined : (mask & bit) !== 0;
}
function Sparkline({
  samples,
  axis,
}: {
  samples: readonly Sample[];
  axis: keyof Sample;
}) {
  const max = Math.max(1, ...samples.map(sample => Math.abs(sample[axis])));
  return (
    <View style={styles.spark} testID={`sensor-trace-${axis}`}>
      {samples.map((sample, index) => {
        const value = sample[axis];
        const height = Math.max(2, Math.round((Math.abs(value) / max) * 34));
        return (
          <View
            key={index}
            style={[
              styles.sparkBar,
              axis === 'y' && styles.sparkY,
              axis === 'z' && styles.sparkZ,
              {
                height,
                opacity:
                  0.35 + (index / Math.max(1, samples.length - 1)) * 0.65,
              },
            ]}
          />
        );
      })}
    </View>
  );
}
function VectorCard({
  title,
  vector,
  history,
  suffix,
  detected,
}: {
  title: string;
  vector?: SensorVector3;
  history: readonly Sample[];
  suffix: string;
  detected?: boolean;
}) {
  return (
    <View style={[styles.card, detected === false && styles.cardUnavailable]}>
      <View style={styles.cardHead}>
        <View>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.hint}>
            {detected === false
              ? 'غير مكتشف في MSP_STATUS_EX'
              : detected === true
              ? 'مكتشف · قراءة حية'
              : 'بانتظار حالة الحساس'}
          </Text>
        </View>
        <View style={[styles.dot, detected && styles.dotOn]} />
      </View>
      <View style={styles.metrics}>
        {(['x', 'y', 'z'] as const).map(axis => (
          <View key={axis} style={styles.metric}>
            <Text style={styles.metricValue}>{vector?.[axis] ?? '—'}</Text>
            <Text style={styles.metricLabel}>
              {axis.toUpperCase()} {suffix}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.traces}>
        {(['x', 'y', 'z'] as const).map(axis => (
          <Sparkline key={axis} samples={history} axis={axis} />
        ))}
      </View>
    </View>
  );
}
export default function SensorsScreen({
  sessionKey,
  active,
  onOpenSetup,
}: Props): React.JSX.Element {
  const { maxWidth } = useContentEnvelope(true);
  const sessionId = sessionKey?.sessionId ?? '';
  const imuState = useTelemetryValue<MspRawImu>(
    sessionId,
    SENSOR_IMU_POLL_ID,
    active,
  );
  const altitudeState = useTelemetryValue<MspAltitude>(
    sessionId,
    SENSOR_ALTITUDE_POLL_ID,
    active,
  );
  const statusState = useTelemetryValue<MspStatusExCompact>(
    sessionId,
    FC_STATUS_TELEMETRY_POLL_ID,
    active,
  );
  const imu = valueOf(imuState);
  const altitude = valueOf(altitudeState);
  const status = valueOf(statusState);
  const [accHistory, setAccHistory] = useState<readonly Sample[]>([]);
  const [gyroHistory, setGyroHistory] = useState<readonly Sample[]>([]);
  const [magHistory, setMagHistory] = useState<readonly Sample[]>([]);
  useEffect(() => {
    if (active && sessionKey !== undefined)
      return acquireSensorsTelemetry(sessionKey);
  }, [active, sessionKey]);
  useEffect(() => {
    if (imu === undefined) return;
    setAccHistory(current => [...current.slice(-47), imu.accelerometer]);
    setGyroHistory(current => [...current.slice(-47), imu.gyroscopeDps]);
    setMagHistory(current => [...current.slice(-47), imu.magnetometer]);
  }, [imu]);
  useEffect(() => {
    if (!active) {
      setAccHistory([]);
      setGyroHistory([]);
      setMagHistory([]);
    }
  }, [active]);
  const sensorMask = status?.sensorPresenceMask;
  const states = useMemo(
    () => [
      { label: 'Gyro', value: present(sensorMask, 32) },
      { label: 'ACC', value: present(sensorMask, 1) },
      { label: 'MAG', value: present(sensorMask, 4) },
      { label: 'Baro', value: present(sensorMask, 2) },
    ],
    [sensorMask],
  );
  const stale = imuState.status === 'STALE' || altitudeState.status === 'STALE';
  return (
    <View style={styles.root} testID="sensors-screen">
      <ScrollView contentContainerStyle={[styles.content, { maxWidth }]}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            SENSORS · MSP_RAW_IMU 20 HZ · MSP_ALTITUDE 5 HZ
          </Text>
          <Text style={styles.title}>الحساسات</Text>
          <Text style={styles.subtitle}>
            راقب القيم الخام واتجاه الحركة لحظيًا، واستخدمها لاكتشاف محور مقلوب
            أو حساس ساكن قبل الطيران.
          </Text>
        </View>
        <View style={styles.presence}>
          {states.map(state => (
            <View
              key={state.label}
              style={[styles.presenceItem, state.value && styles.presenceOn]}
            >
              <View style={[styles.dot, state.value && styles.dotOn]} />
              <Text style={styles.presenceText}>{state.label}</Text>
              <Text style={styles.presenceState}>
                {state.value === undefined
                  ? '—'
                  : state.value
                  ? 'Detected'
                  : 'Absent'}
              </Text>
            </View>
          ))}
        </View>
        {stale ? (
          <View style={styles.warning}>
            <Text style={styles.warningText}>
              البيانات قديمة؛ لا تعتمد عليها حتى تعود القراءة الحية.
            </Text>
          </View>
        ) : null}
        <VectorCard
          title="الجيروسكوب"
          vector={imu?.gyroscopeDps}
          history={gyroHistory}
          suffix="dps"
          detected={present(sensorMask, 32)}
        />
        <VectorCard
          title="مقياس التسارع"
          vector={imu?.accelerometer}
          history={accHistory}
          suffix="raw"
          detected={present(sensorMask, 1)}
        />
        <VectorCard
          title="البوصلة المغناطيسية"
          vector={imu?.magnetometer}
          history={magHistory}
          suffix="raw"
          detected={present(sensorMask, 4)}
        />
        <View
          style={[
            styles.card,
            present(sensorMask, 2) === false && styles.cardUnavailable,
          ]}
        >
          <View style={styles.cardHead}>
            <View>
              <Text style={styles.sectionTitle}>الارتفاع والـVariometer</Text>
              <Text style={styles.hint}>
                القيمة المقدّرة التي يرسلها FC، وليست ضغطًا خامًا.
              </Text>
            </View>
            <View
              style={[styles.dot, present(sensorMask, 2) && styles.dotOn]}
            />
          </View>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {altitude === undefined
                  ? '—'
                  : (altitude.altitudeCm / 100).toFixed(2)}
              </Text>
              <Text style={styles.metricLabel}>m altitude</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {altitude === undefined
                  ? '—'
                  : (altitude.variometerCms / 100).toFixed(2)}
              </Text>
              <Text style={styles.metricLabel}>m/s vario</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {status?.i2cErrorCount ?? '—'}
              </Text>
              <Text style={styles.metricLabel}>I²C since boot</Text>
            </View>
          </View>
        </View>
        <View style={styles.hardware}>
          <Text style={styles.hardwareTitle}>REQUIRES HARDWARE TEST</Text>
          <Text style={styles.hardwareText}>
            الحركة الفيزيائية المعروفة هي المرجع: حرّك كل محور منفردًا وتأكد من
            الإشارة، وضع الطائرة ثابتة ومستوًية لفحص الانحراف والضجيج.
          </Text>
        </View>
        <View style={styles.calibration}>
          <View>
            <Text style={styles.sectionTitle}>المعايرة الآمنة</Text>
            <Text style={styles.hint}>
              معايرة ACC وMAG موجودة في شاشة الإعداد وتستخدم نفس الحراسة:
              DISARMED، تأكيد، وإيقاف telemetry أثناء الأمر.
            </Text>
          </View>
          <Button
            label="فتح أدوات المعايرة"
            onPress={onOpenSetup}
            variant="primary"
            icon="compass"
            testID="sensors-open-setup"
          />
        </View>
        <View style={styles.bottom} />
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    width: '100%',
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  hero: { gap: 4 },
  eyebrow: { ...typography.eyebrow, color: colors.accentStrong },
  title: { ...typography.title, color: colors.textPrimary, textAlign: 'right' },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  presence: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  presenceItem: {
    flexGrow: 1,
    flexBasis: 140,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  presenceOn: { borderColor: colors.success, backgroundColor: colors.successSoft },
  presenceText: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
  },
  presenceState: {
    ...typography.caption,
    color: colors.textMuted,
    marginStart: 'auto',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textMuted,
  },
  dotOn: { backgroundColor: colors.success },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardUnavailable: { opacity: 0.62 },
  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    ...typography.heading,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  hint: { ...typography.caption, color: colors.textMuted, textAlign: 'right' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metric: {
    flexGrow: 1,
    flexBasis: 130,
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
  },
  metricValue: {
    ...typography.heading,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  metricLabel: { ...typography.caption, color: colors.textMuted },
  traces: { gap: 4 },
  spark: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    overflow: 'hidden',
    backgroundColor: colors.backgroundRaised,
    borderRadius: radii.sm,
    paddingHorizontal: 3,
  },
  sparkBar: { flex: 1, minWidth: 2, backgroundColor: colors.accentStrong },
  sparkY: { backgroundColor: colors.success },
  sparkZ: { backgroundColor: colors.warning },
  hardware: {
    borderWidth: 1,
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  hardwareTitle: { ...typography.eyebrow, color: colors.accentStrong },
  hardwareText: {
    ...typography.caption,
    color: colors.accentText,
    textAlign: 'right',
  },
  calibration: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  warning: {
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  warningText: {
    ...typography.body,
    color: colors.warning,
    textAlign: 'right',
  },
  bottom: { height: spacing.xl },
});
