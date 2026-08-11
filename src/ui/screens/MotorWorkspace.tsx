/**
 * P3 - THE PROFESSIONAL MOTOR WORKSPACE.
 *
 * The primary Motors experience: enable motor control, move Motor 1..N
 * independently, drive them together with Master, stop with one tap.
 * Arabic-first, RTL-native, no long press, no heartbeat, no fixed
 * magnitude, no one-motor-at-a-time rule.
 *
 * SAFETY INVISIBLE, CAPABILITY VISIBLE. Every protection P2 built -
 * disarmed evidence, the FC-side arming restriction, stop domination,
 * last-value-wins coalescing, delayed-ACK invalidation, session and
 * lifecycle teardown - runs underneath this component without asking the
 * operator to acknowledge it. The screen shows ONE persistent warning and
 * otherwise gets out of the way.
 *
 * THE UI OWNS NOTHING SAFETY-CRITICAL. It renders the snapshot, and it
 * calls exactly four facade operations: setMotorValue, setMaster,
 * stopAll, and begin/end session. There is no UI-side queue, no timer, no
 * heartbeat and no protocol import - the controller's coalescing is the
 * only send discipline, and the boundary scan keeps encoders and leases
 * unreachable from here.
 *
 * NO PHYSICAL CLAIMS. Values shown are DESIRED command values (القيمة
 * المطلوبة). An acknowledgement is protocol metadata; nothing here says a
 * motor is turning or has stopped. Physical behaviour remains REQUIRES
 * HARDWARE TEST.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { MotorTestControllerSnapshot } from '../../core/state/motorTestController';
import type { MotorTestValueDomain } from '../../core/firmware-adapters/betaflightMotorDomainV147';
import { ToggleSwitch } from '../components/controls/ToggleSwitch';
import { Button } from '../components/controls/Button';
import { colors, radii, spacing, typography } from '../theme';

/* ------------------------------------------------------------------ *
 * The narrow port this workspace may call
 * ------------------------------------------------------------------ */

/**
 * Exactly the facade slice the workspace needs. Deliberately narrower
 * than MotorTestOperatorPort so a test can prove the workspace CANNOT
 * reach pulseMotor, renewPulseHold or any legacy operation.
 */
export interface MotorWorkspacePort {
  setMotorValue(
    motorIndex: number,
    value: number,
  ): { readonly kind: 'ACCEPTED' | 'REFUSED' };
  setMaster(value: number): { readonly kind: 'ACCEPTED' | 'REFUSED' };
  stopAll(): string;
  beginSession(): Promise<unknown>;
  endSession(): Promise<unknown>;
}

export interface MotorWorkspaceProps {
  readonly snapshot: MotorTestControllerSnapshot | undefined;
  readonly port: MotorWorkspacePort | undefined;
  /** True once the operator's enable intent is in flight or granted. */
  readonly enabled: boolean;
  readonly onEnableChange: (next: boolean) => void;
  /** Compact width stacks the master row; wide puts controls side-by-side. */
  readonly compact?: boolean;
}

/* ------------------------------------------------------------------ *
 * Session phase presentation
 * ------------------------------------------------------------------ */

export type MotorWorkspacePhase =
  | 'DISABLED'
  | 'ENABLING'
  | 'READY'
  | 'STOPPING'
  | 'RECOVERY_REQUIRED'
  | 'UNSUPPORTED_3D_ANALOG';

export function deriveWorkspacePhase(
  snapshot: MotorTestControllerSnapshot | undefined,
  enabled: boolean,
): MotorWorkspacePhase {
  if (snapshot?.motorRuntimeScope && !snapshot.motorRuntimeScope.eligible) {
    return 'UNSUPPORTED_3D_ANALOG';
  }
  if (!enabled) {
    return 'DISABLED';
  }
  if (snapshot === undefined || snapshot.outcome.kind === 'PENDING') {
    return 'ENABLING';
  }
  if (snapshot.outcome.kind === 'READY') {
    return snapshot.phase === 'CLOSING' ? 'STOPPING' : 'READY';
  }
  // BLOCKED / FAILED_CLOSED after an enable attempt.
  return 'RECOVERY_REQUIRED';
}

const PHASE_LABEL: Record<MotorWorkspacePhase, string> = {
  DISABLED: 'غير مفعّل',
  ENABLING: 'جارٍ التفعيل',
  READY: 'جاهز',
  STOPPING: 'جارٍ الإيقاف',
  RECOVERY_REQUIRED: 'يتطلب إعادة الاتصال',
  UNSUPPORTED_3D_ANALOG: 'غير متاح لهذا الإعداد',
};

/* ------------------------------------------------------------------ *
 * Slider
 * ------------------------------------------------------------------ */

interface MotorSliderProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly min: number;
  readonly max: number;
  readonly stopValue: number;
  readonly neutral?: number;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
  readonly testID: string;
}

/**
 * A PanResponder track slider - no external dependency, works on native
 * and react-native-web. The DESIRED value updates immediately with the
 * gesture; the controller's last-value-wins coalescing is the only send
 * discipline, so no timer or queue exists here.
 *
 * DIRECTION. The track is deliberately rendered LTR (min on the left)
 * even in RTL: throttle scales are a technical axis, like a number line,
 * and mirroring them per-locale would make عكسي/أمامي swap sides between
 * builds. Labels around it stay RTL.
 */
function MotorSlider({
  label,
  accessibilityLabel,
  min,
  max,
  stopValue,
  neutral,
  value,
  disabled,
  onChange,
  testID,
}: MotorSliderProps): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const trackWidthRef = useRef(0);
  const trackStartX = useRef(0);
  const span = Math.max(1, max - min);
  const fraction = (Math.min(Math.max(value, min), max) - min) / span;

  const valueFromX = useCallback(
    (pageX: number): number => {
      const width = trackWidthRef.current;
      if (width <= 0) {
        return value;
      }
      const raw = (pageX - trackStartX.current) / width;
      const clamped = Math.min(Math.max(raw, 0), 1);
      return Math.round(min + clamped * span);
    },
    [min, span, value],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: event => {
          onChange(valueFromX(event.nativeEvent.pageX));
        },
        onPanResponderMove: event => {
          onChange(valueFromX(event.nativeEvent.pageX));
        },
      }),
    [disabled, onChange, valueFromX],
  );

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidthRef.current = event.nativeEvent.layout.width;
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const neutralFraction =
    neutral !== undefined ? (neutral - min) / span : undefined;

  return (
    <View style={sliderStyles.row} testID={testID}>
      <View style={sliderStyles.headerRow}>
        <Text style={sliderStyles.label}>{label}</Text>
        <Text style={sliderStyles.value} testID={`${testID}-value`}>
          {String(value)}
        </Text>
      </View>
      <View
        style={[sliderStyles.trackTouch, disabled && sliderStyles.trackDisabled]}
        onLayout={onTrackLayout}
        // Measured in page coordinates once per gesture start would race
        // scrolling; pageX relative to a ref captured on layout is stable
        // enough for a test bench control.
        ref={node => {
          (node as unknown as {
            measure?: (
              callback: (
                x: number, y: number, w: number, h: number, pageX?: number,
              ) => void,
            ) => void;
          } | null)?.measure?.((_x, _y, _w, _h, pageX) => {
            trackStartX.current = pageX ?? 0;
          });
        }}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min, max, now: value }}
        accessibilityState={{ disabled }}
        {...responder.panHandlers}
      >
        <View style={sliderStyles.trackLine} />
        {neutralFraction !== undefined && trackWidth > 0 ? (
          <View
            style={[
              sliderStyles.neutralTick,
              { left: Math.max(0, neutralFraction * trackWidth - 1) },
            ]}
          />
        ) : null}
        {trackWidth > 0 ? (
          <View
            style={[
              sliderStyles.thumb,
              { left: Math.max(0, fraction * trackWidth - THUMB_SIZE / 2) },
              disabled && sliderStyles.thumbDisabled,
            ]}
          />
        ) : null}
      </View>
      {neutral !== undefined ? (
        <View style={sliderStyles.threeDLegend}>
          {/* LTR axis: reverse left of neutral, forward right of it. */}
          <Text style={sliderStyles.legendText}>عكسي</Text>
          <Text style={sliderStyles.legendText}>
            {'محايد / إيقاف '}
            {String(stopValue)}
          </Text>
          <Text style={sliderStyles.legendText}>أمامي</Text>
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

export function MotorWorkspace({
  snapshot,
  port,
  enabled,
  onEnableChange,
  compact = false,
}: MotorWorkspaceProps): React.JSX.Element {
  const domain: MotorTestValueDomain | undefined = snapshot?.motorDomain;
  const phase = deriveWorkspacePhase(snapshot, enabled);
  const commandable = phase === 'READY' && port !== undefined && domain !== undefined;

  const motorCount = domain?.motorCount ?? snapshot?.motorScope?.motorCount ?? 0;
  const min = domain?.commandDomainMin ?? 1000;
  const max = domain?.commandDomainMax ?? 2000;
  const stopValue = domain?.stopValue ?? min;
  const neutral = domain?.neutral;

  /** DESIRED values - the UI's own optimistic copy, seeded at stop. The
   * controller snapshot remains the authority; this mirror exists so the
   * thumb tracks the finger without waiting for a publish round-trip. */
  const [desired, setDesired] = useState<readonly number[]>([]);
  const desiredFor = useCallback(
    (index: number): number => desired[index] ?? stopValue,
    [desired, stopValue],
  );

  const applyMotor = useCallback(
    (index: number, value: number) => {
      if (!commandable) {
        return;
      }
      setDesired(previous => {
        const next = Array.from(
          { length: motorCount },
          (_, i) => previous[i] ?? stopValue,
        );
        next[index] = value;
        return next;
      });
      port.setMotorValue(index, value);
    },
    [commandable, motorCount, port, stopValue],
  );

  const applyMaster = useCallback(
    (value: number) => {
      if (!commandable) {
        return;
      }
      setDesired(Array.from({ length: motorCount }, () => value));
      port.setMaster(value);
    },
    [commandable, motorCount, port],
  );

  const handleStop = useCallback(() => {
    // One tap. No confirmation. Desired state snaps to the RESOLVED stop
    // value - 1500 on digital 3D, mincommand on analog - never a literal.
    setDesired(Array.from({ length: motorCount }, () => stopValue));
    port?.stopAll();
  }, [motorCount, port, stopValue]);

  /* P3: WEB ESCAPE-TO-STOP. Escape ONLY - an any-key rule would fight
   * numeric entry, keyboard navigation and assistive tech. Active only
   * while the session is commandable, and removed the moment it is not. */
  useEffect(() => {
    // The RN typings have no DOM globals; the runtime check is the guard.
    const host = (globalThis as {
      addEventListener?: (t: string, l: (e: {key?: string}) => void) => void;
      removeEventListener?: (t: string, l: (e: {key?: string}) => void) => void;
    });
    if (!commandable || typeof host.addEventListener !== 'function') {
      return undefined;
    }
    const onKeyDown = (event: {key?: string}) => {
      if (event.key === 'Escape') {
        handleStop();
      }
    };
    host.addEventListener('keydown', onKeyDown);
    return () => host.removeEventListener?.('keydown', onKeyDown);
  }, [commandable, handleStop]);

  const masterValue =
    desired.length > 0 && desired.every(value => value === desired[0])
      ? desired[0]
      : stopValue;

  if (phase === 'UNSUPPORTED_3D_ANALOG') {
    return (
      <View style={styles.card} testID="motor-workspace-unsupported">
        <Text style={styles.sectionTitle}>التحكم بالمحركات</Text>
        <Text style={styles.unsupportedText}>
          اختبار المحركات غير متاح لإعداد 3D التناظري الحالي، لأن حدود الخرج
          المطلوبة لا يمكن قراءتها من هذا الإصدار من البرنامج الثابت.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="motor-workspace">
      {/* Enable row */}
      <View style={styles.enableRow}>
        <View style={styles.enableTextBlock}>
          <Text style={styles.sectionTitle}>تفعيل التحكم بالمحركات</Text>
          <Text style={styles.phaseText} testID="motor-workspace-phase">
            {PHASE_LABEL[phase]}
          </Text>
        </View>
        <ToggleSwitch
          value={enabled}
          onValueChange={onEnableChange}
          disabled={phase === 'ENABLING' || phase === 'STOPPING'}
          accessibilityLabel="تفعيل التحكم بالمحركات"
          testID="motor-workspace-enable"
        />
      </View>

      {/* The page-level banner above the workspace is THE one propeller
          warning - repeating it here would be the ritual P3 removes. */}
      {phase === 'RECOVERY_REQUIRED' ? (
        <Text style={styles.recoveryText} testID="motor-workspace-recovery">
          تعذر تفعيل التحكم بالمحركات. أعد توصيل الطائرة ثم حاول مجددًا.
        </Text>
      ) : null}

      {/* Motor sliders - rendered from the REAL motor count. */}
      <View style={styles.slidersBlock}>
        {Array.from({ length: motorCount }, (_, index) => (
          <MotorSlider
            key={index}
            label={`محرك ${index + 1}`}
            accessibilityLabel={`محرك ${index + 1}`}
            min={min}
            max={max}
            stopValue={stopValue}
            neutral={neutral}
            value={desiredFor(index)}
            disabled={!commandable}
            onChange={value => applyMotor(index, value)}
            testID={`motor-slider-${index + 1}`}
          />
        ))}
        {motorCount === 0 ? (
          <Text style={styles.phaseText}>—</Text>
        ) : null}
      </View>

      {/* Master */}
      <View style={[styles.masterRow, compact && styles.masterRowCompact]}>
        <MotorSlider
          label="الكل"
          accessibilityLabel="الكل - جميع المحركات"
          min={min}
          max={max}
          stopValue={stopValue}
          neutral={neutral}
          value={masterValue}
          disabled={!commandable}
          onChange={applyMaster}
          testID="motor-slider-master"
        />
      </View>

      {/* STOP - the strongest control on the page. */}
      <View style={styles.stopBlock}>
        <Button
          label="إيقاف المحركات"
          onPress={handleStop}
          variant="danger"
          size="lg"
          block
          disabled={port === undefined}
          accessibilityLabel="إيقاف المحركات"
          testID="motor-workspace-stop"
        />
      </View>
    </View>
  );
}

const THUMB_SIZE = 28;

const sliderStyles = StyleSheet.create({
  row: { gap: spacing.xs, paddingVertical: spacing.xs },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  label: {
    ...typography.label,
    color: colors.textPrimary,
    fontSize: 15,
  },
  value: {
    ...typography.mono,
    color: colors.textPrimary,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  trackTouch: {
    height: 44,
    justifyContent: 'center',
    // The technical axis stays LTR in RTL builds - see MotorSlider docs.
    direction: 'ltr',
  },
  trackDisabled: { opacity: 0.45 },
  trackLine: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.borderStrong,
  },
  neutralTick: {
    position: 'absolute',
    width: 2,
    height: 18,
    borderRadius: 1,
    backgroundColor: colors.textSecondary,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  thumbDisabled: { backgroundColor: colors.borderStrong },
  threeDLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    direction: 'ltr',
  },
  legendText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
  },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  enableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  enableTextBlock: { flexShrink: 1, gap: 2 },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  phaseText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  safetyLine: {
    ...typography.caption,
    color: colors.warning,
  },
  recoveryText: {
    ...typography.body,
    color: colors.error,
  },
  slidersBlock: { gap: spacing.xs },
  masterRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
  },
  masterRowCompact: {},
  stopBlock: { paddingTop: spacing.xs },
  unsupportedText: {
    ...typography.body,
    color: colors.textSecondary,
    lineHeight: 22,
  },
});
