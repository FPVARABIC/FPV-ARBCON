/* eslint-disable no-bitwise -- MSP_STATUS_EX sensor presence is a firmware bit mask. */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
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
/**
 * SENSORS FINAL UI CORRECTION - the trace geometry, as pure functions.
 *
 * The previous sparkline drew |value| as bar height and rescaled EVERY
 * AXIS to its own rolling maximum: sign was destroyed, a 5-unit noise
 * floor looked identical to a 500-unit rotation, and X/Y/Z could not be
 * compared. These helpers define the replacement truthfully and are
 * exported so the suite asserts the mapping itself, not a picture of it.
 */
export const TRACE_CAPACITY = 48;
export const TRACE_HEIGHT = 56;
const TRACE_PAD_Y = 4;

/**
 * ONE shared bound per sensor: the three axes of a sensor measure the
 * same physical quantity in the same unit, so a shared scale is the
 * scientifically correct comparison - X/Y/Z amplitudes stay in their
 * true proportion, and nothing is normalized per axis. The bound is the
 * largest absolute value currently in the window (floor 1 so an
 * all-zero window still has a defined scale), and it is LABELED on the
 * card so the scale is stated, never implied.
 */
export function sharedTraceBound(samples: readonly Sample[]): number {
  let bound = 1;
  for (const sample of samples) {
    bound = Math.max(
      bound,
      Math.abs(sample.x),
      Math.abs(sample.y),
      Math.abs(sample.z),
    );
  }
  return bound;
}

/** Signed value -> vertical position. Zero maps exactly to the center
 * reference line; positive is ABOVE it, negative BELOW it. */
export function traceY(value: number, bound: number): number {
  const center = TRACE_HEIGHT / 2;
  const usable = center - TRACE_PAD_Y;
  const clamped = Math.max(-1, Math.min(1, value / Math.max(1, bound)));
  return center - clamped * usable;
}

export function tracePoints(
  samples: readonly Sample[],
  axis: keyof Sample,
  bound: number,
): string {
  return samples
    .map((sample, index) => `${index},${traceY(sample[axis], bound).toFixed(2)}`)
    .join(' ');
}

const AXIS_COLORS: Record<keyof Sample, string> = {
  x: colors.accentStrong,
  y: colors.success,
  z: colors.warning,
};

function AxisTrace({
  samples,
  axis,
  bound,
  suffix,
}: {
  samples: readonly Sample[];
  axis: keyof Sample;
  bound: number;
  suffix: string;
}) {
  const latest = samples.length > 0 ? samples[samples.length - 1][axis] : undefined;
  return (
    <View style={styles.trace} testID={`sensor-trace-${axis}`}>
      <View style={styles.traceMeta}>
        <View style={[styles.axisChip, { backgroundColor: AXIS_COLORS[axis] }]}>
          <Text style={styles.axisChipText}>{axis.toUpperCase()}</Text>
        </View>
        <Text
          style={styles.traceValue}
          testID={`sensor-trace-${axis}-value`}
        >
          {latest === undefined ? '—' : `${latest} ${suffix}`}
        </Text>
      </View>
      <View style={styles.traceStage}>
        {/* The zero reference: a real line, always visible, exactly at
            the signed origin. Positive samples draw above it, negative
            below it - the sign IS the geometry. */}
        <View style={styles.zeroLine} testID={`sensor-trace-${axis}-zero`} />
        {samples.length >= 2 ? (
          <Svg
            width="100%"
            height={TRACE_HEIGHT}
            viewBox={`0 0 ${TRACE_CAPACITY - 1} ${TRACE_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <Polyline
              points={tracePoints(samples, axis, bound)}
              fill="none"
              stroke={AXIS_COLORS[axis]}
              strokeWidth={1.75}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </Svg>
        ) : (
          <Text style={styles.traceWaiting}>بانتظار القراءة الحية…</Text>
        )}
      </View>
    </View>
  );
}

export function VectorCard({
  id,
  title,
  vector,
  history,
  suffix,
  detected,
}: {
  id: string;
  title: string;
  vector?: SensorVector3;
  history: readonly Sample[];
  suffix: string;
  detected?: boolean;
}) {
  const bound = sharedTraceBound(history);
  return (
    <View
      style={[styles.card, detected === false && styles.cardUnavailable]}
      testID={`sensor-card-${id}`}
    >
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
      {detected === false ? (
        /* Never simulated: an absent sensor renders NO numbers and NO
           traces. MSP_RAW_IMU still carries zero-filled fields for
           hardware the FC did not detect, and drawing those zeros as a
           live flat-line would claim a reading that does not exist. */
        <View
          style={styles.unavailablePanel}
          testID={`sensor-card-${id}-unavailable`}
        >
          <Text style={styles.unavailableText}>
            غير متاح — لم يكتشف متحكم الطيران هذا الحساس، فلا تُعرض له
            قراءات ولا رسوم.
          </Text>
        </View>
      ) : (
        <>
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
              <AxisTrace
                key={axis}
                samples={history}
                axis={axis}
                bound={bound}
                suffix={suffix}
              />
            ))}
          </View>
          <Text style={styles.scaleNote} testID={`sensor-card-${id}-scale`}>
            {`المقياس المشترك للمحاور الثلاثة: ±${bound} ${suffix} · الزمن من اليسار إلى اليمين، والموجب فوق خط الصفر.`}
          </Text>
        </>
      )}
    </View>
  );
}
export default function SensorsScreen({
  sessionKey,
  active,
  onOpenSetup,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
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
          id="gyro"
          title="الجيروسكوب"
          vector={imu?.gyroscopeDps}
          history={gyroHistory}
          suffix="dps"
          detected={present(sensorMask, 32)}
        />
        <VectorCard
          id="acc"
          title="مقياس التسارع"
          vector={imu?.accelerometer}
          history={accHistory}
          suffix="raw"
          detected={present(sensorMask, 1)}
        />
        <VectorCard
          id="mag"
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
          <Text style={styles.hardwareTitle}>
            {t('hardwareVerification.behaviourTitle')}
          </Text>
          <Text style={styles.hardwareText}>
            الحركة الفيزيائية المعروفة هي المرجع: حرّك كل محور منفردًا وتأكد من
            الإشارة، وضع الطائرة ثابتة ومستوًية لفحص الانحراف والضجيج.
          </Text>
        </View>
        <View style={styles.calibration}>
          {/* SENSORS FINAL: without flex constraints this column takes
              the intrinsic width of its longest unwrapped line (measured
              624px at 360) and overflows the phone viewport. Bounding it
              makes the hint wrap instead. */}
          <View style={styles.calibrationCopy}>
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
  traces: { gap: spacing.sm },
  trace: { gap: 4 },
  traceMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  axisChip: {
    minWidth: 26,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.sm,
    alignItems: 'center',
  },
  axisChipText: {
    ...typography.caption,
    color: colors.white,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  traceValue: {
    ...typography.caption,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    writingDirection: 'ltr',
  },
  traceStage: {
    height: TRACE_HEIGHT,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  zeroLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: TRACE_HEIGHT / 2 - 0.5,
    height: 1,
    backgroundColor: colors.textMuted,
    opacity: 0.55,
  },
  traceWaiting: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  scaleNote: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  unavailablePanel: {
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  unavailableText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
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
  calibrationCopy: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 220,
    minWidth: 0,
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
