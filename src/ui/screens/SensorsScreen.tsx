/**
 * THE «المستشعرات» SCREEN.
 *
 * ==================================================================
 * WHAT THE FIRST VIEWPORT HAS TO ANSWER
 * ==================================================================
 *
 * Not "which dropdowns are there". Five questions, in this order:
 *
 *   1. which sensors are present?
 *   2. what did the firmware find?
 *   3. does what it found differ from what was configured?
 *   4. does the accelerometer need calibrating?
 *   5. is anything contradicting itself?
 *
 * So the page opens with the status board and the disagreements, then
 * calibration, and only then the settings. A configuration screen that
 * opens on a selector is asking the operator to change something before
 * telling them anything.
 *
 * ==================================================================
 * THREE ANSWERS, NEVER ONE BADGE
 * ==================================================================
 *
 * Configured, detected and present are three different questions with
 * three different sources, and they disagree routinely without either
 * side being wrong. Each row leads with one headline and keeps all three
 * underneath; nothing here collapses them, and nothing here says
 * "healthy" - none of the three measures whether a sensor works.
 *
 * ==================================================================
 * WHAT THIS SCREEN DOES NOT OWN
 * ==================================================================
 *
 * Board alignment - how the flight controller itself is mounted - belongs
 * to Setup. This screen points at it and does not duplicate the controls.
 * The gyro has no hardware selector because MSP_SENSOR_CONFIG has no gyro
 * byte, and the gyro enable mask inside the alignment frame is carried
 * across by the controller rather than authored here.
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {LayoutChangeEvent} from 'react-native';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Line, Polyline} from 'react-native-svg';
import {useTranslation} from 'react-i18next';

import type {
  MspAltitude,
  MspRawImu,
  SensorVector3,
  TelemetryValue,
} from '../../core';
import {
  ACC_TRIM_LIMIT,
  LIVE_VECTOR_UNIT_KEYS,
  SENSOR_DISPLAY_ORDER,
  accTrimText,
  calibrationBlock,
  calibrationOutcomeSeverity,
  declinationDegreesText,
  describeCalibrationBlock,
  describeCalibrationOutcome,
  describeCalibrationStage,
  describeConfigured,
  describeContradiction,
  describeDetected,
  describeHardwareSaveStage,
  describeHeadline,
  describeMismatchPair,
  describePresent,
  describeSaveOutcome,
  editableHardwareFamilies,
  elapsedSecondsText,
  hardwareOptions,
  parseDeclinationDegrees,
  sensorFamilyLabelKey,
  sensorRowVisible,
  type SensorCalibrationOutcomeId,
  type SensorCalibrationTargetId,
  type SensorHardwareSaveStageId,
  type SensorPhrase,
  type SensorSaveOutcomeId,
} from '../../core/state/sensorPresentation';
import type {
  SensorContradiction,
  SensorTruth,
} from '../../core/state/sensorTruthSemantics';
import type {SensorHardwareValue} from '../../core';
import {
  acquireSensorsTelemetry,
  SENSOR_ALTITUDE_POLL_ID,
  SENSOR_IMU_POLL_ID,
  sensorsConfigurationController,
  useTelemetryValue,
  type SensorsCalibrationObservation,
  type SensorsCalibrationOutcome,
  type SensorsCalibrationProgress,
  type SensorsHardwareDraft,
  type SensorsLoadOutcome,
  type SensorsMagAlignmentDraft,
  type SensorsPendingHardware,
  type SensorsSnapshot,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {Button, NoticeBox, SelectField, type SelectOption} from '../components/controls';
import {StickyActionBar} from '../components/editing';
import {Icon} from '../icons';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {sensorsPendingSave, useSensorsPendingSave} from '../session/sensorsPendingSave';

/* ================================================================== *
 * PORT
 * ================================================================== */

/** The controller surface this screen uses, and the seam tests inject
 *  through. Nothing else about the screen is mockable. */
export interface SensorsControllerPort {
  load(key: SetupUiSessionKey): Promise<SensorsLoadOutcome>;
  saveHardwareSelection(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsHardwareDraft,
    onProgress?: (stage: 'SENDING' | 'VERIFYING_APPLY' | 'PERSISTING' | 'VERIFYING_PERSISTED') => void,
  ): Promise<Awaited<ReturnType<typeof sensorsConfigurationController.saveHardwareSelection>>>;
  verifyHardwarePersistence(
    key: SetupUiSessionKey,
    pending: SensorsPendingHardware,
  ): Promise<Awaited<ReturnType<typeof sensorsConfigurationController.verifyHardwarePersistence>>>;
  saveMagAlignment(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: SensorsMagAlignmentDraft,
  ): Promise<Awaited<ReturnType<typeof sensorsConfigurationController.saveMagAlignment>>>;
  saveAccTrim(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: {readonly pitch: number; readonly roll: number},
  ): Promise<Awaited<ReturnType<typeof sensorsConfigurationController.saveAccTrim>>>;
  saveCompassDeclination(
    key: SetupUiSessionKey,
    observed: SensorsSnapshot,
    draft: {readonly magDeclinationDecidegrees: number},
  ): Promise<Awaited<ReturnType<typeof sensorsConfigurationController.saveCompassDeclination>>>;
  calibrateAccelerometer(
    key: SetupUiSessionKey,
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): SensorsCalibrationObservation;
  calibrateMagnetometer(
    key: SetupUiSessionKey,
    onProgress?: (progress: SensorsCalibrationProgress) => void,
  ): SensorsCalibrationObservation;
}

interface Props {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenSetup: () => void;
  readonly controller?: SensorsControllerPort;
  /** Injected only so an elapsed clock can be driven in a test. */
  readonly now?: () => number;
}

/* ================================================================== *
 * LIVE TRACES - unchanged geometry, corrected units
 * ================================================================== */

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const TRACE_CAPACITY = 48;
export const TRACE_HEIGHT = 44;
const TRACE_PAD_Y = 4;

/** One shared bound per sensor: the three axes measure the same quantity
 *  in the same unit, so a shared scale keeps their true proportion. */
export function sharedTraceBound(samples: readonly Sample[]): number {
  let bound = 1;
  for (const sample of samples) {
    bound = Math.max(bound, Math.abs(sample.x), Math.abs(sample.y), Math.abs(sample.z));
  }
  return bound;
}

/** Signed value to vertical position. Zero is the centre line exactly. */
export function traceY(value: number, bound: number): number {
  const centre = TRACE_HEIGHT / 2;
  const usable = centre - TRACE_PAD_Y;
  const clamped = Math.max(-1, Math.min(1, value / Math.max(1, bound)));
  return centre - clamped * usable;
}

/**
 * Horizontal position of ONE sample, in plot pixels.
 *
 * THE DEFECT THIS FUNCTION EXISTS TO CLOSE. `tracePoints()` used to emit
 * the array index as the x coordinate, and the <Svg> it feeds is sized
 * `width="100%"` with no viewBox - so one user unit is one CSS pixel. A
 * full 48-sample window therefore drew 47px wide no matter how wide the
 * card was, and inside a ~600px desktop card the whole trace collapsed
 * into a smear against one edge. Nothing about the DATA was wrong; the
 * sample axis simply had no relationship to the space it was drawn in.
 *
 * The window, not the sample count, is the axis. The buffer is a rolling
 * TRACE_CAPACITY window and the plot is that whole window: the newest
 * sample is pinned to the right edge and every earlier one steps back by
 * exactly one slot. A sample therefore keeps its horizontal position for
 * its whole life in the window and the time axis never rescales as the
 * buffer fills - a window that is not full yet starts partway in and
 * grows leftwards, which is what a filling scope looks like. Mapping by
 * `samples.length` instead would slide every existing sample sideways on
 * every new frame, which is a different (and wrong) claim about time.
 *
 * Left is older, right is newer, in every writing direction: these are
 * SVG user-space coordinates, which an RTL container does not mirror.
 */
export function traceX(index: number, count: number, width: number): number {
  const step = width / (TRACE_CAPACITY - 1);
  return width - (count - 1 - index) * step;
}

/**
 * The polyline for one axis, in plot pixels.
 *
 * `width` is the MEASURED width of the plot box (see TraceCard's
 * onLayout), so the trace uses whatever space the card actually has at
 * 390, 768 or 1366 without a fixed desktop width anywhere. Before layout
 * has reported a width there is no honest place to put a point, so the
 * polyline is empty rather than degenerate.
 */
export function tracePoints(
  samples: readonly Sample[],
  axis: keyof Sample,
  bound: number,
  width: number,
): string {
  if (samples.length === 0 || !(width > 0)) {
    return '';
  }
  return samples
    .map(
      (sample, index) =>
        `${traceX(index, samples.length, width).toFixed(2)},` +
        `${traceY(sample[axis], bound).toFixed(2)}`,
    )
    .join(' ');
}

const AXIS_COLORS: Record<keyof Sample, string> = {
  x: colors.accentStrong,
  y: colors.success,
  z: colors.warning,
};

function valueOf<T>(value: TelemetryValue<T>): T | undefined {
  return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined;
}

/* ================================================================== *
 * SMALL PIECES
 * ================================================================== */

/** Label + value on one line. Never renders a dash in place of a fact -
 *  every value it is given is a sentence somebody can act on. */
function Fact({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/** COLOUR IS NEVER THE ONLY SIGNAL: every state carries an icon and a
 *  word, so it survives a monochrome screen and a colour-blind reader. */
function StateMark({
  tone,
  testID,
}: {
  tone: 'present' | 'absent' | 'attention' | 'unknown';
  testID?: string;
}): React.JSX.Element {
  const icon =
    tone === 'present'
      ? 'circle-check'
      : tone === 'attention'
        ? 'triangle-alert'
        : tone === 'absent'
          ? 'circle-x'
          : 'circle-question-mark';
  const colour =
    tone === 'present'
      ? colors.success
      : tone === 'attention'
        ? colors.warning
        : colors.textMuted;
  return <Icon name={icon} size={16} color={colour} testID={testID} />;
}

/* ================================================================== *
 * THE SCREEN
 * ================================================================== */

type Busy =
  | {readonly kind: 'IDLE'}
  | {readonly kind: 'LOADING'}
  | {readonly kind: 'HARDWARE_SAVE'; readonly stage: SensorHardwareSaveStageId}
  | {readonly kind: 'FIELD_SAVE'; readonly field: 'TRIM' | 'DECLINATION' | 'ALIGNMENT'}
  | {
      readonly kind: 'CALIBRATING';
      readonly target: SensorCalibrationTargetId;
      readonly progress: SensorsCalibrationProgress;
      readonly startedAt: number;
    };

interface CalibrationResult {
  readonly target: SensorCalibrationTargetId;
  readonly outcome: SensorCalibrationOutcomeId;
}

export default function SensorsScreen({
  sessionKey,
  active,
  onOpenSetup,
  controller = sensorsConfigurationController,
  now = Date.now,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const {maxWidth, tier} = useContentEnvelope(true);
  const wide = tier !== 'compact';
  const sessionId = sessionKey?.sessionId ?? '';

  const [snapshot, setSnapshot] = useState<SensorsSnapshot | undefined>(undefined);
  const [busy, setBusy] = useState<Busy>({kind: 'IDLE'});
  const [saveOutcome, setSaveOutcome] = useState<SensorSaveOutcomeId | undefined>(undefined);
  const [runtimeMismatch, setRuntimeMismatch] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationResult | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [advanced, setAdvanced] = useState(false);

  const [hardwareDraft, setHardwareDraft] = useState<SensorsHardwareDraft>({});
  const [trimDraft, setTrimDraft] = useState<{pitch: number; roll: number} | undefined>(undefined);
  const [declinationText, setDeclinationText] = useState<string | undefined>(undefined);
  const [alignmentDraft, setAlignmentDraft] = useState<SensorsMagAlignmentDraft | undefined>(undefined);

  const observation = useRef<SensorsCalibrationObservation | undefined>(undefined);
  const pending = useSensorsPendingSave();

  /* ---------------------------------------------------------------- *
   * LOAD, AND THE POST-REBOOT VERIFICATION THAT OWNS THE FIRST READ
   * ---------------------------------------------------------------- */

  /**
   * A pending token means a hardware save reached the reboot and this is
   * a new session. Verification must own the FIRST read of that session -
   * running load() alongside it would take the controller's one
   * per-session operation slot and the verification would come back
   * refused, telling the operator a save failed when nothing had.
   */
  const awaitingVerification =
    pending !== null &&
    sessionKey !== undefined &&
    pending.sessionId === sessionKey.sessionId &&
    pending.writtenOnGeneration !== sessionKey.generation;

  const applyLoaded = useCallback((outcome: SensorsLoadOutcome) => {
    if (outcome.kind === 'LOADED') {
      setSnapshot(outcome.snapshot);
      setHardwareDraft({});
      setTrimDraft(undefined);
      setDeclinationText(undefined);
      setAlignmentDraft(undefined);
    }
  }, []);

  /**
   * EVERY CONTROLLER CALL ON THIS SCREEN IS GUARDED, AND THE BUSY STATE
   * IS CLEARED IN A `finally`.
   *
   * The controller returns a discriminated outcome for everything it can
   * classify, so a REJECTION here is the unexpected case - which is
   * exactly why it was the one that used to strand a screen: `setBusy`
   * had already run and the throw skipped every line that would have
   * cleared it. An unexpected failure is classified conservatively as
   * FAILED: never a success, and never a claim about what the board did.
   */
  const reload = useCallback(async () => {
    if (sessionKey === undefined) return;
    setBusy({kind: 'LOADING'});
    try {
      applyLoaded(await controller.load(sessionKey));
    } catch {
      // Nothing is applied: a load that threw produced no snapshot to
      // trust, and the previous one stays on screen unchanged.
    } finally {
      setBusy({kind: 'IDLE'});
    }
  }, [applyLoaded, controller, sessionKey]);

  useEffect(() => {
    if (!active || sessionKey === undefined || awaitingVerification) return;
    let cancelled = false;
    setBusy({kind: 'LOADING'});
    controller
      .load(sessionKey)
      .then(outcome => {
        if (cancelled) return;
        applyLoaded(outcome);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBusy({kind: 'IDLE'});
      });
    return () => {
      cancelled = true;
    };
  }, [active, applyLoaded, awaitingVerification, controller, sessionKey]);

  useEffect(() => {
    if (!active || sessionKey === undefined || !awaitingVerification || pending === null) return;
    let cancelled = false;
    setBusy({kind: 'HARDWARE_SAVE', stage: 'VERIFYING_AFTER_REBOOT'});
    controller
      .verifyHardwarePersistence(sessionKey, pending)
      .then(outcome => {
        if (cancelled) return;
        if (outcome.kind === 'SUCCEEDED') {
          setSnapshot(outcome.snapshot);
          setSaveOutcome('SUCCEEDED');
          /* PERSISTENCE AND DETECTION ARE TWO ANSWERS. The setting stored
             exactly as asked; whether the board then FOUND that part is a
             separate sentence and must not turn a successful save into a
             failed one. */
          setRuntimeMismatch(outcome.runtime.contradictions.length > 0);
          return;
        }
        setSaveOutcome(outcome.kind as SensorSaveOutcomeId);
        setRuntimeMismatch(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSaveOutcome('FAILED');
        setRuntimeMismatch(false);
      })
      .finally(() => {
        /* The token is ANSWERED either way - verified, mismatched or
           refused. One that outlived its answer would make the next
           session verify a save that had already been reported. */
        sensorsPendingSave.clear();
        if (!cancelled) setBusy({kind: 'IDLE'});
      });
    return () => {
      cancelled = true;
    };
  }, [active, awaitingVerification, controller, pending, sessionKey]);

  /* ---------------------------------------------------------------- *
   * LIVE TELEMETRY - the existing polls, no new scheduler
   * ---------------------------------------------------------------- */

  const imuState = useTelemetryValue<MspRawImu>(sessionId, SENSOR_IMU_POLL_ID, active);
  const altitudeState = useTelemetryValue<MspAltitude>(sessionId, SENSOR_ALTITUDE_POLL_ID, active);
  const imu = valueOf(imuState);
  const altitude = valueOf(altitudeState);
  const [history, setHistory] = useState<
    Readonly<Record<'GYRO' | 'ACC' | 'MAG', readonly Sample[]>>
  >({GYRO: [], ACC: [], MAG: []});

  useEffect(() => {
    if (active && sessionKey !== undefined) return acquireSensorsTelemetry(sessionKey);
  }, [active, sessionKey]);

  useEffect(() => {
    if (imu === undefined) return;
    const push = (list: readonly Sample[], sample: SensorVector3): readonly Sample[] => [
      ...list.slice(-(TRACE_CAPACITY - 1)),
      sample,
    ];
    setHistory(current => ({
      GYRO: push(current.GYRO, imu.gyroscopeDps),
      ACC: push(current.ACC, imu.accelerometer),
      MAG: push(current.MAG, imu.magnetometer),
    }));
  }, [imu]);

  /* A TRACE BELONGS TO ONE AIRCRAFT.
     This used to clear only when the screen went inactive, so a session
     change under a mounted screen - a pilot unplugging one quad and
     plugging in the next - left the previous aircraft's samples on the
     trace and appended the new board's to the same line. The screen
     already treats `sessionId` as something that changes: it re-acquires
     telemetry on it, two effects above. The history it accumulated for
     the old session has to go the same way, or the plot is a picture of
     two aircraft with a step in the middle that belongs to neither. */
  useEffect(() => {
    setHistory({GYRO: [], ACC: [], MAG: []});
  }, [active, sessionId]);

  /* ---------------------------------------------------------------- *
   * ELAPSED CLOCK - real seconds, never a percentage
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (busy.kind !== 'CALIBRATING') {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(now() - busy.startedAt);
    const handle = setInterval(() => setElapsedMs(now() - busy.startedAt), 1000);
    return () => clearInterval(handle);
  }, [busy, now]);

  useEffect(
    () => () => {
      observation.current?.cancel();
    },
    [],
  );

  /* ---------------------------------------------------------------- *
   * DERIVED
   * ---------------------------------------------------------------- */

  const truthRows = useMemo(() => {
    if (snapshot === undefined) return [];
    return SENSOR_DISPLAY_ORDER.map(family => snapshot.truth[family]).filter(sensorRowVisible);
  }, [snapshot]);

  const contradictions = useMemo(
    () => truthRows.filter(row => row.contradictions.length > 0),
    [truthRows],
  );

  const editableFamilies = useMemo(
    () => (snapshot === undefined ? [] : editableHardwareFamilies(snapshot.configured.contract)),
    [snapshot],
  );

  const operationBusy = busy.kind !== 'IDLE';
  const say = useCallback((p: SensorPhrase): string => t(p.key, p.params ?? {}), [t]);

  const hardwareDirty = useMemo(() => {
    if (snapshot === undefined) return false;
    const current = snapshot.configured;
    const raws: Record<string, number | undefined> = {
      ACC: current.acc.raw,
      BARO: current.baro.raw,
      MAG: current.mag.raw,
      RANGEFINDER: typeof current.rangefinder === 'string' ? undefined : current.rangefinder.raw,
      OPTICALFLOW: typeof current.opticalflow === 'string' ? undefined : current.opticalflow.raw,
    };
    return (Object.keys(hardwareDraft) as (keyof SensorsHardwareDraft)[]).some(key => {
      const next = hardwareDraft[key];
      const held = raws[String(key).toUpperCase()];
      return next !== undefined && next !== held;
    });
  }, [hardwareDraft, snapshot]);

  /* ---------------------------------------------------------------- *
   * ACTIONS
   * ---------------------------------------------------------------- */

  const runCalibration = useCallback(
    (target: SensorCalibrationTargetId) => {
      if (sessionKey === undefined) return;
      /* THE PREVIOUS RUN'S RESULT GOES FIRST, BEFORE ANYTHING ELSE.
         Leaving it on screen beside a run that is starting would tell an
         operator "calibrated" about a calibration that is happening right
         now - the exact confusion the whole observation model exists to
         avoid. Clearing here is what makes the card's outcome always
         belong to the run that produced it. */
      setCalibration(undefined);
      setBusy({kind: 'CALIBRATING', target, progress: 'REQUESTED', startedAt: now()});
      const started = now();
      const handle =
        target === 'ACCELEROMETER'
          ? controller.calibrateAccelerometer(sessionKey, progress =>
              setBusy({kind: 'CALIBRATING', target, progress, startedAt: started}),
            )
          : controller.calibrateMagnetometer(sessionKey, progress =>
              setBusy({kind: 'CALIBRATING', target, progress, startedAt: started}),
            );
      observation.current = handle;
      void handle.result.then((outcome: SensorsCalibrationOutcome) => {
        observation.current = undefined;
        setBusy({kind: 'IDLE'});
        setCalibration({target, outcome: outcome.kind as SensorCalibrationOutcomeId});
        // Presence, the ACC blocker and the detected values can all have
        // moved; re-read rather than leaving a stale board on screen.
        void reload();
      });
    },
    [controller, now, reload, sessionKey],
  );

  const saveHardware = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined) return;
    setSaveOutcome(undefined);
    setRuntimeMismatch(false);
    setBusy({kind: 'HARDWARE_SAVE', stage: 'READING'});
    let result: Awaited<ReturnType<SensorsControllerPort['saveHardwareSelection']>>;
    try {
      result = await controller.saveHardwareSelection(
        sessionKey,
        snapshot,
        hardwareDraft,
        stage => {
          const mapped: SensorHardwareSaveStageId =
            stage === 'SENDING'
              ? 'SENDING'
              : stage === 'VERIFYING_APPLY'
                ? 'VERIFYING_APPLY'
                : 'PERSISTING';
          setBusy({kind: 'HARDWARE_SAVE', stage: mapped});
        },
      );
    } catch {
      setBusy({kind: 'IDLE'});
      setSaveOutcome('FAILED');
      return;
    }
    if (result.kind === 'AWAITING_REBOOT_VERIFICATION') {
      // The screen is about to be unmounted by the reboot; the token has
      // to outlive it.
      sensorsPendingSave.set(result.pending);
      setSaveOutcome('AWAITING_REBOOT_VERIFICATION');
      setBusy({kind: 'HARDWARE_SAVE', stage: 'VERIFYING_AFTER_REBOOT'});
      return;
    }
    setBusy({kind: 'IDLE'});
    setSaveOutcome(result.kind as SensorSaveOutcomeId);
    if (result.kind === 'NO_CHANGES') setHardwareDraft({});
  }, [controller, hardwareDraft, sessionKey, snapshot]);

  const saveTrim = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || trimDraft === undefined) return;
    setSaveOutcome(undefined);
    setBusy({kind: 'FIELD_SAVE', field: 'TRIM'});
    try {
      const result = await controller.saveAccTrim(sessionKey, snapshot, trimDraft);
      setSaveOutcome(result.kind as SensorSaveOutcomeId);
      if (result.kind === 'SUCCEEDED' || result.kind === 'NO_CHANGES') void reload();
    } catch {
      setSaveOutcome('FAILED');
    } finally {
      setBusy({kind: 'IDLE'});
    }
  }, [controller, reload, sessionKey, snapshot, trimDraft]);

  const saveDeclination = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || declinationText === undefined) return;
    const decidegrees = parseDeclinationDegrees(declinationText);
    if (decidegrees === undefined) return;
    setSaveOutcome(undefined);
    setBusy({kind: 'FIELD_SAVE', field: 'DECLINATION'});
    try {
      const result = await controller.saveCompassDeclination(sessionKey, snapshot, {
        magDeclinationDecidegrees: decidegrees,
      });
      setSaveOutcome(result.kind as SensorSaveOutcomeId);
      if (result.kind === 'SUCCEEDED' || result.kind === 'NO_CHANGES') void reload();
    } catch {
      setSaveOutcome('FAILED');
    } finally {
      setBusy({kind: 'IDLE'});
    }
  }, [controller, declinationText, reload, sessionKey, snapshot]);

  const saveAlignment = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || alignmentDraft === undefined) return;
    setSaveOutcome(undefined);
    setBusy({kind: 'FIELD_SAVE', field: 'ALIGNMENT'});
    try {
      const result = await controller.saveMagAlignment(sessionKey, snapshot, alignmentDraft);
      setSaveOutcome(result.kind as SensorSaveOutcomeId);
      if (result.kind === 'SUCCEEDED' || result.kind === 'NO_CHANGES') void reload();
    } catch {
      setSaveOutcome('FAILED');
    } finally {
      setBusy({kind: 'IDLE'});
    }
  }, [alignmentDraft, controller, reload, sessionKey, snapshot]);

  /* ---------------------------------------------------------------- *
   * RENDER
   * ---------------------------------------------------------------- */

  const loading = snapshot === undefined && (busy.kind === 'LOADING' || busy.kind === 'HARDWARE_SAVE');

  return (
    <View style={styles.root} testID="sensors-screen">
      <ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
        <View style={styles.hero}>
          <Text style={styles.title} accessibilityRole="header">
            {t('sensorsScreen.title')}
          </Text>
          <Text style={styles.subtitle}>{t('sensorsScreen.subtitle')}</Text>
        </View>

        {loading ? (
          <View style={styles.loading} testID="sensors-loading">
            <Text style={styles.loadingText}>{t('sensorsScreen.loading')}</Text>
          </View>
        ) : null}

        {/* 1. STATUS - the first thing on the page, deliberately. */}
        {snapshot !== undefined ? (
          <View style={styles.section} testID="sensors-status">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.sectionStatus')}
            </Text>
            <View style={[styles.rows, wide && styles.rowsWide]}>
              {truthRows.map(row => (
                <SensorRow key={row.family} truth={row} say={say} t={t} />
              ))}
            </View>
          </View>
        ) : null}

        {/* 2. DISAGREEMENTS - compact, never a red hero. */}
        {contradictions.length > 0 ? (
          <View style={styles.section} testID="sensors-contradictions">
            <NoticeBox variant="warning" title={t('sensorsScreen.contradictionsTitle')}>
              <View style={styles.contradictionList}>
                {contradictions.map(row =>
                  row.contradictions.map((kind: SensorContradiction) => (
                    <View key={`${row.family}-${kind}`} style={styles.contradictionItem}>
                      <Text
                        style={styles.contradictionText}
                        testID={`sensors-contradiction-${row.family}-${kind}`}>
                        {`${t(sensorFamilyLabelKey(row.family))} — ${say(describeContradiction(kind))}`}
                      </Text>
                      {kind === 'CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED'
                        ? renderMismatchPair(row, say, t)
                        : null}
                    </View>
                  )),
                )}
              </View>
            </NoticeBox>
          </View>
        ) : null}

        {/* 3. CALIBRATION */}
        {snapshot !== undefined ? (
          <View style={styles.section} testID="sensors-calibration">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.sectionCalibration')}
            </Text>
            <View style={[styles.rows, wide && styles.rowsWide]}>
              <CalibrationCard
                target="ACCELEROMETER"
                truth={snapshot.truth.ACC}
                busy={operationBusy}
                state={busy}
                elapsedMs={elapsedMs}
                result={calibration}
                onStart={() => runCalibration('ACCELEROMETER')}
                onStop={() => observation.current?.cancel()}
                say={say}
                t={t}
              />
              <CalibrationCard
                target="MAGNETOMETER"
                truth={snapshot.truth.MAG}
                busy={operationBusy}
                state={busy}
                elapsedMs={elapsedMs}
                result={calibration}
                onStart={() => runCalibration('MAGNETOMETER')}
                onStop={() => observation.current?.cancel()}
                say={say}
                t={t}
              />
            </View>
          </View>
        ) : null}

        {/* 4. LIVE READINGS */}
        {snapshot !== undefined ? (
          <View style={styles.section} testID="sensors-live">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.sectionLive')}
            </Text>
            {imuState.status === 'STALE' || altitudeState.status === 'STALE' ? (
              <Text style={styles.stale} testID="sensors-live-stale">
                {t('sensorsScreen.liveStale')}
              </Text>
            ) : null}
            <View style={[styles.rows, wide && styles.rowsWide]}>
              {(['GYRO', 'ACC', 'MAG'] as const)
                .filter(family => snapshot.truth[family].present.kind === 'PRESENT')
                .map(family => (
                  <TraceCard
                    key={family}
                    family={family}
                    samples={history[family]}
                    title={t(sensorFamilyLabelKey(family))}
                    unit={t(LIVE_VECTOR_UNIT_KEYS[family])}
                    t={t}
                  />
                ))}
            </View>
            {altitude !== undefined && snapshot.truth.BARO.present.kind === 'PRESENT' ? (
              <View style={styles.card} testID="sensors-altitude">
                <Fact
                  label={t('sensorsScreen.family.BARO')}
                  value={`${(altitude.altitudeCm / 100).toFixed(2)} m`}
                  testID="sensors-altitude-value"
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 5. HARDWARE SELECTORS - only what the board's own frame carries. */}
        {snapshot !== undefined && editableFamilies.length > 0 ? (
          <View style={styles.section} testID="sensors-hardware">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.sectionHardware')}
            </Text>
            <Text style={styles.hint}>{t('sensorsScreen.hardwareIntro')}</Text>
            {editableFamilies.map(family => {
              const currentRaw = currentHardwareRaw(snapshot, family);
              if (currentRaw === undefined) return null;
              const draftRaw = hardwareDraft[draftKeyFor(family)] ?? currentRaw;
              const options: SelectOption[] = hardwareOptions(family, currentRaw).map(
                option => ({key: String(option.raw), label: say(option.label)}),
              );
              return (
                <SelectField
                  key={family}
                  label={t(sensorFamilyLabelKey(family as never))}
                  selectedKey={String(draftRaw)}
                  options={options}
                  onSelect={next =>
                    setHardwareDraft(current => ({
                      ...current,
                      [draftKeyFor(family)]: Number(next),
                    }))
                  }
                  disabled={operationBusy}
                  testID={`sensors-hardware-${family.toLowerCase()}`}
                />
              );
            })}
          </View>
        ) : null}

        {/* 6. TRIM AND DECLINATION */}
        {snapshot !== undefined && snapshot.accTrim.kind === 'READ' ? (
          <View style={styles.section} testID="sensors-trim">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.trimTitle')}
            </Text>
            <Text style={styles.hint}>
              {t('sensorsScreen.trimRange', {min: -ACC_TRIM_LIMIT, max: ACC_TRIM_LIMIT})}
            </Text>
            <View style={styles.inlineFields}>
              <NumberField
                label={t('sensorsScreen.trimPitch')}
                value={accTrimText(trimDraft?.pitch ?? snapshot.accTrim.value.pitch)}
                disabled={operationBusy}
                testID="sensors-trim-pitch"
                onChange={text =>
                  setTrimDraft(current => ({
                    pitch: Number(text) || 0,
                    roll: current?.roll ?? (snapshot.accTrim.kind === 'READ' ? snapshot.accTrim.value.roll : 0),
                  }))
                }
              />
              <NumberField
                label={t('sensorsScreen.trimRoll')}
                value={accTrimText(trimDraft?.roll ?? snapshot.accTrim.value.roll)}
                disabled={operationBusy}
                testID="sensors-trim-roll"
                onChange={text =>
                  setTrimDraft(current => ({
                    pitch: current?.pitch ?? (snapshot.accTrim.kind === 'READ' ? snapshot.accTrim.value.pitch : 0),
                    roll: Number(text) || 0,
                  }))
                }
              />
            </View>
            <Button
              label={t('sensorsScreen.trimSave')}
              onPress={() => void saveTrim()}
              variant="secondary"
              disabled={operationBusy || trimDraft === undefined}
              testID="sensors-trim-save"
            />
          </View>
        ) : null}

        {snapshot !== undefined && snapshot.compass.kind === 'READ' ? (
          <View style={styles.section} testID="sensors-declination">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('sensorsScreen.declinationTitle')}
            </Text>
            <Text style={styles.hint}>{t('sensorsScreen.declinationRange')}</Text>
            <NumberField
              label={t('sensorsScreen.declinationLabel')}
              value={
                declinationText ??
                declinationDegreesText(snapshot.compass.value.magDeclinationDecidegrees)
              }
              disabled={operationBusy}
              testID="sensors-declination-input"
              onChange={setDeclinationText}
            />
            {declinationText !== undefined && parseDeclinationDegrees(declinationText) === undefined ? (
              <Text style={styles.error} testID="sensors-declination-invalid">
                {t('sensorsScreen.declinationInvalid')}
              </Text>
            ) : null}
            <Button
              label={t('sensorsScreen.declinationSave')}
              onPress={() => void saveDeclination()}
              variant="secondary"
              disabled={
                operationBusy ||
                declinationText === undefined ||
                parseDeclinationDegrees(declinationText) === undefined
              }
              testID="sensors-declination-save"
            />
          </View>
        ) : null}

        {/* 7. MAG ALIGNMENT - the magnetometer's fields only. */}
        {snapshot !== undefined && snapshot.compass.kind === 'READ' ? (
          <AlignmentSection
            snapshot={snapshot}
            draft={alignmentDraft}
            disabled={operationBusy}
            onChange={setAlignmentDraft}
            onSave={() => void saveAlignment()}
            t={t}
          />
        ) : null}

        {/* Board alignment lives in Setup. Pointed at, never duplicated. */}
        <View style={styles.section} testID="sensors-board-alignment-pointer">
          <Text style={styles.hint}>{t('sensorsScreen.boardAlignmentPointer')}</Text>
          <Button
            label={t('sensorsScreen.boardAlignmentOpen')}
            onPress={onOpenSetup}
            variant="ghost"
            icon="compass"
            testID="sensors-open-setup"
          />
        </View>

        {/* NOTHING ON THIS SCREEN IS HARDWARE EVIDENCE. Every reading
            here is what the board REPORTED over MSP; whether the sensors
            themselves are right is decided by moving the aircraft and
            watching, and only there. The unconditional notice the other
            eight screens carry says so in the same words. */}
        <View style={styles.section} testID="sensors-hardware-verification">
          <Text style={styles.sectionTitle} accessibilityRole="header">
            {t('hardwareVerification.behaviourTitle')}
          </Text>
          <Text style={styles.hint}>{t('sensorsScreen.hardwareVerificationBody')}</Text>
        </View>

        {/* 8. TECHNICAL DETAILS, collapsed. */}
        {snapshot !== undefined ? (
          <View style={styles.section} testID="sensors-advanced">
            <Button
              label={t(advanced ? 'sensorsScreen.advancedHide' : 'sensorsScreen.advancedShow')}
              onPress={() => setAdvanced(value => !value)}
              variant="ghost"
              testID="sensors-advanced-toggle"
            />
            {advanced ? (
              <View style={styles.card} testID="sensors-advanced-body">
                {truthRows.map(row => (
                  <Fact
                    key={row.family}
                    label={t(sensorFamilyLabelKey(row.family))}
                    value={`${t('sensorsScreen.labelConfigured')}: ${say(
                      describeConfigured(row),
                    )} · ${t('sensorsScreen.labelDetected')}: ${say(describeDetected(row))}`}
                    testID={`sensors-advanced-${row.family}`}
                  />
                ))}
                {snapshot.gyros.kind === 'READ' && snapshot.gyros.value.kind === 'REPORTED' ? (
                  <View testID="sensors-gyro-slots">
                    {snapshot.gyros.value.gyros.map((gyro: SensorHardwareValue, index: number) => (
                      <Fact
                        key={`gyro-${index}`}
                        label={t('sensorsScreen.gyroSlot', {index: index + 1})}
                        value={say({
                          key:
                            gyro.kind === 'UNKNOWN'
                              ? 'sensorsScreen.hardware.unknown'
                              : gyro.kind === 'NONE'
                                ? 'sensorsScreen.hardware.none'
                                : 'sensorsScreen.hardware.part',
                          params:
                            gyro.kind === 'UNKNOWN'
                              ? {raw: gyro.raw}
                              : {name: gyro.modelled.replace(/^GYRO_/, '')},
                        })}
                        testID={`sensors-gyro-slot-${index}`}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.bottom} />
      </ScrollView>

      <StickyActionBar
        visible={hardwareDirty || busy.kind === 'HARDWARE_SAVE' || saveOutcome !== undefined}
        summary={t('sensorsScreen.sectionHardware')}
        saveLabel={t('sensorsScreen.hardwareSave')}
        discardLabel={t('sensorsScreen.hardwareDiscard')}
        onSave={() => void saveHardware()}
        onDiscard={() => {
          setHardwareDraft({});
          setSaveOutcome(undefined);
          setRuntimeMismatch(false);
        }}
        busy={busy.kind === 'HARDWARE_SAVE'}
        busyLabel={
          busy.kind === 'HARDWARE_SAVE' ? say(describeHardwareSaveStage(busy.stage)) : undefined
        }
        disabledReason={
          hardwareDirty ? undefined : t('sensorsScreen.save.outcome.NO_CHANGES')
        }
        statusMessage={
          saveOutcome === undefined
            ? undefined
            : runtimeMismatch && saveOutcome === 'SUCCEEDED'
              ? `${say(describeSaveOutcome(saveOutcome))} — ${t('sensorsScreen.save.runtimeMismatch')}`
              : say(describeSaveOutcome(saveOutcome))
        }
        statusTone={
          saveOutcome === 'SUCCEEDED' || saveOutcome === 'NO_CHANGES' ? 'normal' : 'warning'
        }
        testID="sensors-save-bar"
      />
    </View>
  );
}

/* ================================================================== *
 * SUB-COMPONENTS
 * ================================================================== */

type Translate = ReturnType<typeof useTranslation>['t'];

function renderMismatchPair(
  truth: SensorTruth,
  say: (phrase: SensorPhrase) => string,
  t: Translate,
): React.JSX.Element | null {
  const pair = describeMismatchPair(truth);
  if (pair === undefined) return null;
  return (
    <Text style={styles.contradictionDetail} testID={`sensors-mismatch-${truth.family}`}>
      {`${t('sensorsScreen.labelStored')}: ${say(pair.stored)} · ${t(
        'sensorsScreen.labelFound',
      )}: ${say(pair.found)}`}
    </Text>
  );
}

function SensorRow({
  truth,
  say,
  t,
}: {
  truth: SensorTruth;
  say: (phrase: SensorPhrase) => string;
  t: Translate;
}): React.JSX.Element {
  const tone =
    truth.contradictions.length > 0
      ? 'attention'
      : truth.present.kind === 'PRESENT'
        ? 'present'
        : truth.present.kind === 'ABSENT'
          ? 'absent'
          : 'unknown';
  return (
    <View style={styles.card} testID={`sensors-row-${truth.family}`}>
      <View style={styles.rowHead}>
        <StateMark tone={tone} testID={`sensors-row-${truth.family}-mark`} />
        <Text style={styles.rowTitle}>{t(sensorFamilyLabelKey(truth.family))}</Text>
      </View>
      <Text style={styles.rowHeadline} testID={`sensors-row-${truth.family}-headline`}>
        {say(describeHeadline(truth))}
      </Text>
      <Fact
        label={t('sensorsScreen.labelConfigured')}
        value={say(describeConfigured(truth))}
        testID={`sensors-row-${truth.family}-configured`}
      />
      <Fact
        label={t('sensorsScreen.labelDetected')}
        value={say(describeDetected(truth))}
        testID={`sensors-row-${truth.family}-detected`}
      />
      <Fact
        label={t('sensorsScreen.labelPresent')}
        value={say(describePresent(truth))}
        testID={`sensors-row-${truth.family}-present`}
      />
    </View>
  );
}

function CalibrationCard({
  target,
  truth,
  busy,
  state,
  elapsedMs,
  result,
  onStart,
  onStop,
  say,
  t,
}: {
  target: SensorCalibrationTargetId;
  truth: SensorTruth;
  busy: boolean;
  state: Busy;
  elapsedMs: number;
  result: CalibrationResult | undefined;
  onStart: () => void;
  onStop: () => void;
  say: (phrase: SensorPhrase) => string;
  t: Translate;
}): React.JSX.Element | null {
  const block = calibrationBlock(truth, busy);
  // A sensor that is not there gets no calibration card at all rather
  // than a disabled button nobody can explain.
  if (block === 'SENSOR_NOT_PRESENT' || block === 'DISABLED_BY_CONFIGURATION') {
    return null;
  }
  const running = state.kind === 'CALIBRATING' && state.target === target;
  const id = target === 'ACCELEROMETER' ? 'acc' : 'mag';
  const outcome = result?.target === target ? result.outcome : undefined;
  return (
    <View style={styles.card} testID={`sensors-calibrate-${id}`}>
      <Text style={styles.rowTitle}>
        {t(target === 'ACCELEROMETER' ? 'sensorsScreen.calibration.accTitle' : 'sensorsScreen.calibration.magTitle')}
      </Text>
      <Text style={styles.hint}>
        {t(
          target === 'ACCELEROMETER'
            ? 'sensorsScreen.calibration.accInstruction'
            : 'sensorsScreen.calibration.magInstruction',
        )}
      </Text>
      {running ? (
        <View style={styles.runningRow}>
          <Text style={styles.runningText} testID={`sensors-calibrate-${id}-stage`}>
            {say(describeCalibrationStage(state.progress))}
          </Text>
          <Text style={styles.elapsed} testID={`sensors-calibrate-${id}-elapsed`}>
            {t('sensorsScreen.calibration.elapsed', {seconds: elapsedSecondsText(elapsedMs)})}
          </Text>
        </View>
      ) : null}
      {outcome !== undefined ? (
        <View testID={`sensors-calibrate-${id}-outcome`}>
          <Text
            style={[
              styles.outcome,
              calibrationOutcomeSeverity(outcome) === 'SUCCESS' && styles.outcomeGood,
              calibrationOutcomeSeverity(outcome) === 'ATTENTION' && styles.outcomeWarn,
            ]}
            accessibilityRole="alert">
            {say(describeCalibrationOutcome(target, outcome))}
          </Text>
          {outcome === 'NO_MOVEMENT_DETECTED' ? (
            <Text style={styles.hint} testID={`sensors-calibrate-${id}-hint`}>
              {t('sensorsScreen.calibration.outcome.NO_MOVEMENT_DETECTED_HINT')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {block !== undefined && block !== 'BUSY' ? (
        <Text style={styles.hint} testID={`sensors-calibrate-${id}-blocked`}>
          {say(describeCalibrationBlock(block))}
        </Text>
      ) : null}
      {running ? (
        <Button
          label={t('sensorsScreen.calibration.stop')}
          onPress={onStop}
          variant="secondary"
          testID={`sensors-calibrate-${id}-stop`}
        />
      ) : (
        <Button
          label={t(
            target === 'ACCELEROMETER'
              ? 'sensorsScreen.calibration.accStart'
              : 'sensorsScreen.calibration.magStart',
          )}
          onPress={onStart}
          variant="primary"
          disabled={block !== undefined}
          testID={`sensors-calibrate-${id}-start`}
        />
      )}
    </View>
  );
}

/** Exported for the trace-geometry regression tests, which mount ONE
 *  card with a known sample window and a known measured width. Nothing
 *  else imports it; the screen composes it directly. */
export function TraceCard({
  family,
  samples,
  title,
  unit,
  t,
}: {
  family: 'GYRO' | 'ACC' | 'MAG';
  samples: readonly Sample[];
  title: string;
  unit: string;
  t: Translate;
}): React.JSX.Element {
  const bound = sharedTraceBound(samples);
  /* THE PLOT MEASURES ITSELF. The <Svg> is `width="100%"` with no
     viewBox, so its user units are CSS pixels of whatever the card ended
     up being - which is exactly the number the sample axis needs and the
     only one no stylesheet can get wrong. onLayout also re-fires when the
     container resizes, so the trace stays correct across 390/768/1366
     without a breakpoint. All three axes read this one width, so the
     series share one coordinate space by construction. */
  const [plotWidth, setPlotWidth] = useState(0);
  const measurePlot = useCallback((event: LayoutChangeEvent) => {
    setPlotWidth(event.nativeEvent.layout.width);
  }, []);
  return (
    <View style={styles.card} testID={`sensors-trace-${family}`}>
      <View style={styles.rowHead}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.unit} testID={`sensors-trace-${family}-unit`}>
          {unit}
        </Text>
      </View>
      <View
        style={styles.tracePlot}
        onLayout={measurePlot}
        testID={`sensors-trace-${family}-plot`}>
        <Svg width="100%" height={TRACE_HEIGHT} testID={`sensors-trace-${family}-svg`}>
          <Line
            x1="0"
            y1={TRACE_HEIGHT / 2}
            x2="100%"
            y2={TRACE_HEIGHT / 2}
            stroke={colors.border}
            strokeWidth={1}
          />
          {(['x', 'y', 'z'] as const).map(axis => (
            <Polyline
              key={axis}
              points={tracePoints(samples, axis, bound, plotWidth)}
              fill="none"
              stroke={AXIS_COLORS[axis]}
              strokeWidth={1.5}
            />
          ))}
        </Svg>
      </View>
      <Text style={styles.scaleNote} testID={`sensors-trace-${family}-scale`}>
        {t('sensorsScreen.liveScale', {bound, unit})}
      </Text>
    </View>
  );
}

function AlignmentSection({
  snapshot,
  draft,
  disabled,
  onChange,
  onSave,
  t,
}: {
  snapshot: SensorsSnapshot;
  draft: SensorsMagAlignmentDraft | undefined;
  disabled: boolean;
  onChange: (draft: SensorsMagAlignmentDraft) => void;
  onSave: () => void;
  t: Translate;
}): React.JSX.Element {
  const current = snapshot.alignment;
  const presetRaw = draft?.magAlignmentRaw ?? current.mag.raw;
  const options: SelectOption[] = ALIGNMENT_PRESETS.map(raw => ({
    key: String(raw),
    label: t(`sensorsScreen.alignmentOption.${ALIGNMENT_NAMES[raw]}`),
  }));
  if (!ALIGNMENT_PRESETS.includes(presetRaw)) {
    options.push({
      key: String(presetRaw),
      label: t('sensorsScreen.alignmentOption.UNKNOWN', {raw: presetRaw}),
    });
  }
  return (
    <View style={styles.section} testID="sensors-alignment">
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {t('sensorsScreen.alignmentTitle')}
      </Text>
      <SelectField
        label={t('sensorsScreen.alignmentPreset')}
        selectedKey={String(presetRaw)}
        options={options}
        onSelect={next => onChange({...draft, magAlignmentRaw: Number(next)})}
        disabled={disabled}
        testID="sensors-alignment-preset"
      />
      <Text style={styles.hint}>{t('sensorsScreen.alignmentCustomHint')}</Text>
      <Button
        label={t('sensorsScreen.alignmentSave')}
        onPress={onSave}
        variant="secondary"
        disabled={disabled || draft === undefined}
        testID="sensors-alignment-save"
      />
    </View>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
  testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} nativeID={`${testID}-label`}>
        {label}
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        keyboardType="numbers-and-punctuation"
        accessibilityLabel={label}
        accessibilityLabelledBy={`${testID}-label`}
        testID={testID}
      />
    </View>
  );
}

/* ================================================================== *
 * SMALL MAPS
 * ================================================================== */

const ALIGNMENT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'ALIGN_DEFAULT',
  1: 'CW0_DEG',
  2: 'CW90_DEG',
  3: 'CW180_DEG',
  4: 'CW270_DEG',
  5: 'CW0_DEG_FLIP',
  6: 'CW90_DEG_FLIP',
  7: 'CW180_DEG_FLIP',
  8: 'CW270_DEG_FLIP',
  9: 'ALIGN_CUSTOM',
});

const ALIGNMENT_PRESETS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** The draft key for a hardware family. The families are upper-case
 *  because they are firmware enum names; the draft fields are lower-case
 *  because they are our own. */
function draftKeyFor(family: string): keyof SensorsHardwareDraft {
  return family.toLowerCase() as keyof SensorsHardwareDraft;
}

function currentHardwareRaw(
  snapshot: SensorsSnapshot,
  family: string,
): number | undefined {
  const config = snapshot.configured;
  switch (family) {
    case 'ACC':
      return config.acc.raw;
    case 'BARO':
      return config.baro.raw;
    case 'MAG':
      return config.mag.raw;
    case 'RANGEFINDER':
      return typeof config.rangefinder === 'string' ? undefined : config.rangefinder.raw;
    case 'OPTICALFLOW':
      return typeof config.opticalflow === 'string' ? undefined : config.opticalflow.raw;
    default:
      return undefined;
  }
}

/* ================================================================== *
 * STYLES
 * ================================================================== */

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.lg},
  hero: {gap: 4},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right'},
  loading: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  loadingText: {...typography.body, color: colors.textSecondary, textAlign: 'right'},
  section: {gap: spacing.sm},
  sectionTitle: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  hint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  error: {...typography.caption, color: colors.warning, textAlign: 'right'},
  rows: {gap: spacing.sm},
  rowsWide: {flexDirection: 'row', flexWrap: 'wrap'},
  card: {
    flexGrow: 1,
    flexBasis: 260,
    minWidth: 0,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 6,
  },
  rowHead: {flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.xs},
  rowTitle: {...typography.bodyStrong, color: colors.textPrimary, textAlign: 'right', flexShrink: 1},
  rowHeadline: {...typography.caption, color: colors.textSecondary, textAlign: 'right'},
  fact: {flexDirection: 'row-reverse', justifyContent: 'space-between', gap: spacing.sm},
  factLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  factValue: {
    ...typography.caption,
    color: colors.textPrimary,
    textAlign: 'left',
    flexShrink: 1,
  },
  unit: {...typography.caption, color: colors.textMuted},
  /* The box the sample axis is measured against: full card width, the
     plot's own height, and no horizontal padding of its own so the
     measured width IS the drawable width. */
  tracePlot: {alignSelf: 'stretch', height: TRACE_HEIGHT},
  scaleNote: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  stale: {...typography.caption, color: colors.warning, textAlign: 'right'},
  contradictionList: {gap: spacing.xs},
  contradictionItem: {gap: 2},
  contradictionText: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  contradictionDetail: {...typography.caption, color: colors.textSecondary, textAlign: 'right'},
  runningRow: {flexDirection: 'row-reverse', justifyContent: 'space-between', gap: spacing.sm},
  runningText: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  elapsed: {...typography.caption, color: colors.textMuted},
  outcome: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  outcomeGood: {color: colors.success},
  outcomeWarn: {color: colors.warning},
  inlineFields: {flexDirection: 'row-reverse', gap: spacing.sm, flexWrap: 'wrap'},
  field: {flexGrow: 1, flexBasis: 140, minWidth: 0, gap: 4},
  fieldLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    color: colors.textPrimary,
    textAlign: 'right',
    ...typography.body,
  },
  bottom: {height: spacing.xl},
});
