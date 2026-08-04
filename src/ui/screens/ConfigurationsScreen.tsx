import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  BEEPER_CONDITIONS,
  DSHOT_BEACON_CONDITIONS,
  GENERAL_FEATURES,
  bitEnabled,
  createGeneralConfigurationDraft,
  featureIsAvailable,
  generalConfigurationChangedCount,
  generalConfigurationDraftsEqual,
  setMaskBit,
  validateGeneralConfigurationDraft,
  type GeneralConfigurationDraft,
  type GeneralConfigurationSnapshot,
  type MspStatusExDiagnostics,
  type TelemetryValue,
} from '../../core';
import {
  FC_STATUS_TELEMETRY_POLL_ID,
  generalConfigurationController,
  type GeneralConfigurationBlockReason,
  type GeneralConfigurationLoadOutcome,
  type GeneralConfigurationSaveOutcome,
  type SetupUiSessionKey,
  useMspIdentificationState,
  useMspOwnershipState,
  useTelemetryValue,
} from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography, useContentEnvelope } from '../theme';
import { StickyActionBar } from '../components/editing';

export interface GeneralConfigurationControllerPort {
  load(
    sessionKey: SetupUiSessionKey,
  ): Promise<GeneralConfigurationLoadOutcome>;
  save(
    sessionKey: SetupUiSessionKey,
    original: GeneralConfigurationSnapshot,
    draft: GeneralConfigurationDraft,
  ): Promise<GeneralConfigurationSaveOutcome>;
}

export interface ConfigurationsScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenSetup: () => void;
  readonly onOpenMotors: () => void;
  readonly onOpenPorts: () => void;
  readonly onOpenGps: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: GeneralConfigurationControllerPort;
}

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function blockReasonKey(reason: GeneralConfigurationBlockReason): string {
  return `configurationsSystem.blockReason.${reason}`;
}

function outcomeKey(outcome: GeneralConfigurationSaveOutcome): string {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return 'configurationsSystem.outcome.noChanges';
    case 'SAVED_VERIFIED':
      return 'configurationsSystem.outcome.saved';
    case 'SAVED_UNVERIFIED':
      return 'configurationsSystem.outcome.savedUnverified';
    case 'UNCONFIRMED':
      return 'configurationsSystem.outcome.unconfirmed';
    case 'SESSION_ENDED':
      return 'configurationsSystem.outcome.sessionEnded';
    case 'FAILED':
      return 'configurationsSystem.outcome.failed';
    case 'REJECTED':
      return blockReasonKey(outcome.reason);
  }
}

function telemetryValue<T>(value: TelemetryValue<T>): T | undefined {
  return value.status === 'FRESH' || value.status === 'STALE'
    ? value.value
    : undefined;
}

function ToggleRow({
  title,
  detail,
  value,
  disabled,
  testID,
  onChange,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly testID: string;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.controlRow, disabled && styles.disabled]}>
      <View style={styles.controlCopy}>
        <Text style={styles.controlTitle}>{title}</Text>
        {detail === undefined ? null : (
          <Text style={styles.controlDetail}>{detail}</Text>
        )}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={title}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        trackColor={{ false: colors.disabled, true: colors.accentStrong }}
        thumbColor={value ? colors.accent : colors.textSecondary}
        testID={testID}
      />
    </View>
  );
}

function NumberControl({
  title,
  detail,
  value,
  minimum,
  maximum,
  unit,
  disabled,
  testID,
  onChange,
}: {
  readonly title: string;
  readonly detail: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: string;
  readonly disabled: boolean;
  readonly testID: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <View style={[styles.numberRow, disabled && styles.disabled]}>
      <View style={styles.controlCopy}>
        <Text style={styles.controlTitle}>{title}</Text>
        <Text style={styles.controlDetail}>{detail}</Text>
      </View>
      <View style={styles.stepper}>
        <Pressable
          disabled={disabled || value <= minimum}
          onPress={() => onChange(Math.max(minimum, value - 1))}
          style={styles.stepButton}
          accessibilityRole="button"
          testID={`${testID}-decrement`}
        >
          <Text style={styles.stepButtonText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue} testID={`${testID}-value`}>
          {value} {unit}
        </Text>
        <Pressable
          disabled={disabled || value >= maximum}
          onPress={() => onChange(Math.min(maximum, value + 1))}
          style={styles.stepButton}
          accessibilityRole="button"
          testID={`${testID}-increment`}
        >
          <Text style={styles.stepButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function DestinationCard({
  title,
  detail,
  onPress,
  testID,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  return (
    <Pressable
      style={styles.destination}
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
    >
      <View style={styles.destinationCopy}>
        <Text style={styles.destinationTitle}>{title}</Text>
        <Text style={styles.destinationDetail}>{detail}</Text>
      </View>
      <Text style={styles.destinationArrow}>‹</Text>
    </Pressable>
  );
}

export default function ConfigurationsScreen({
  sessionKey,
  active,
  onOpenSetup,
  onOpenMotors,
  onOpenPorts,
  onOpenGps,
  onDirtyChange,
  controller = generalConfigurationController,
}: ConfigurationsScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { maxWidth: contentMaxWidth } = useContentEnvelope(true);
  const { width, fontScale } = useWindowDimensions();
  const wide = width / Math.max(1, fontScale) >= 760;
  const sessionId = sessionKey?.sessionId ?? '';
  const ownership = useMspOwnershipState(sessionId);
  const identification = useMspIdentificationState(sessionId);
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;
  const mountedRef = useRef(true);
  const loadedIdentityRef = useRef<string | undefined>(undefined);

  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<GeneralConfigurationSnapshot>();
  const [draft, setDraft] = useState<GeneralConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] =
    useState<GeneralConfigurationLoadOutcome>();
  const [saveOutcome, setSaveOutcome] =
    useState<GeneralConfigurationSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || sessionKey === undefined || ownership !== 'ACTIVE') return;
    if (
      identification.status === 'IDLE' ||
      identification.status === 'RUNNING'
    ) {
      setPhase('LOADING');
      return;
    }
    const identity = `${sessionKey.sessionId}:${sessionKey.generation}:${reloadToken}`;
    if (loadedIdentityRef.current === identity) return;
    loadedIdentityRef.current = identity;
    setPhase('LOADING');
    setLoadOutcome(undefined);
    setSaveOutcome(undefined);
    controller
      .load(sessionKey)
      .then(outcome => {
        if (!mountedRef.current || loadedIdentityRef.current !== identity)
          return;
        setLoadOutcome(outcome);
        if (outcome.kind === 'LOADED') {
          setSnapshot(outcome.snapshot);
          setDraft(createGeneralConfigurationDraft(outcome.snapshot));
          setPhase('READY');
        } else {
          setSnapshot(undefined);
          setDraft(undefined);
          setPhase('ERROR');
        }
      })
      .catch(error => {
        if (!mountedRef.current || loadedIdentityRef.current !== identity)
          return;
        setLoadOutcome({ kind: 'FAILED', error });
        setPhase('ERROR');
      });
  }, [
    active,
    controller,
    identification.status,
    ownership,
    reloadToken,
    sessionKey,
  ]);

  const statusTelemetry = useTelemetryValue<MspStatusExDiagnostics>(
    sessionId,
    FC_STATUS_TELEMETRY_POLL_ID,
    active,
  );
  const status = telemetryValue(statusTelemetry);
  const originalDraft = useMemo(
    () =>
      snapshot === undefined
        ? undefined
        : createGeneralConfigurationDraft(snapshot),
    [snapshot],
  );
  const dirty =
    draft !== undefined &&
    originalDraft !== undefined &&
    !generalConfigurationDraftsEqual(originalDraft, draft);
  const changedCount =
    draft === undefined || originalDraft === undefined
      ? 0
      : generalConfigurationChangedCount(originalDraft, draft);
  const issues =
    snapshot === undefined || draft === undefined
      ? []
      : validateGeneralConfigurationDraft(snapshot, draft);
  const busy = phase === 'LOADING' || phase === 'SAVING';

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const update = useCallback((patch: Partial<GeneralConfigurationDraft>) => {
    setSaveOutcome(undefined);
    setDraft(current =>
      current === undefined ? current : Object.freeze({ ...current, ...patch }),
    );
  }, []);

  const handleSave = useCallback(() => {
    if (
      sessionKey === undefined ||
      snapshot === undefined ||
      draft === undefined ||
      !dirty ||
      issues.length > 0
    )
      return;
    Alert.alert(
      t('configurationsSystem.confirmTitle'),
      t('configurationsSystem.confirmBody', { count: changedCount }),
      [
        { text: t('configurationsSystem.cancel'), style: 'cancel' },
        {
          text: t('configurationsSystem.confirmSave'),
          onPress: async () => {
            setPhase('SAVING');
            let outcome: GeneralConfigurationSaveOutcome;
            try {
              outcome = await controller.save(sessionKey, snapshot, draft);
            } catch (error) {
              outcome = { kind: 'FAILED', error };
            }
            if (!mountedRef.current) return;
            setSaveOutcome(outcome);
            if (
              outcome.kind === 'SAVED_VERIFIED' &&
              ownershipRef.current === 'ACTIVE'
            ) {
              setSnapshot(outcome.snapshot);
              setDraft(createGeneralConfigurationDraft(outcome.snapshot));
            }
            setPhase(
              outcome.kind === 'SESSION_ENDED' ||
                ownershipRef.current !== 'ACTIVE'
                ? 'ERROR'
                : 'READY',
            );
          },
        },
      ],
    );
  }, [
    changedCount,
    controller,
    dirty,
    draft,
    issues.length,
    sessionKey,
    snapshot,
    t,
  ]);

  const loadMessage =
    loadOutcome?.kind === 'REJECTED'
      ? t(blockReasonKey(loadOutcome.reason))
      : loadOutcome?.kind === 'FAILED' || loadOutcome?.kind === 'SESSION_ENDED'
      ? t('configurationsSystem.loadFailed')
      : undefined;
  const pidRate =
    snapshot?.gyroSampleRateHz === undefined || draft === undefined
      ? undefined
      : Math.round(snapshot.gyroSampleRateHz / draft.pidProcessDenom);
  const availableFeatures =
    snapshot === undefined
      ? []
      : GENERAL_FEATURES.filter(feature =>
          featureIsAvailable(feature, snapshot.buildOptionIds),
        );
  const motorStopEnabled =
    snapshot !== undefined && bitEnabled(snapshot.featureMaskRaw, 4);
  const dshotCapable =
    snapshot !== undefined &&
    [5, 6, 7, 8].includes(snapshot.advanced.motorProtocolRaw);

  return (
    <View style={styles.root} testID="configurations-screen">
      <ScrollView
        contentContainerStyle={[styles.content, { maxWidth: contentMaxWidth }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            {t('configurationsSystem.eyebrow')}
          </Text>
          <Text style={styles.title}>{t('configurationsSystem.title')}</Text>
          <Text style={styles.subtitle}>
            {t('configurationsSystem.subtitle')}
          </Text>
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.badge,
                ownership === 'ACTIVE' && styles.badgeGood,
              ]}
            >
              <Text style={styles.badgeText}>
                {ownership === 'ACTIVE'
                  ? t('configurationsSystem.connected')
                  : t('configurationsSystem.disconnected')}
              </Text>
            </View>
            <View style={[styles.badge, dirty && styles.badgeWarning]}>
              <Text style={styles.badgeText}>
                {dirty
                  ? t('configurationsSystem.changedCount', {
                      count: changedCount,
                    })
                  : t('configurationsSystem.synchronized')}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.card} testID="configurations-system-summary">
          <Text style={styles.cardEyebrow}>
            {t('configurationsSystem.systemEyebrow')}
          </Text>
          <Text style={styles.cardTitle}>
            {t('configurationsSystem.systemTitle')}
          </Text>
          <View style={styles.metrics}>
            <Metric
              label={t('configurationsSystem.gyroRate')}
              value={
                snapshot?.gyroSampleRateHz === undefined
                  ? '—'
                  : `${snapshot.gyroSampleRateHz} Hz`
              }
            />
            <Metric
              label={t('configurationsSystem.pidRate')}
              value={pidRate === undefined ? '—' : `${pidRate} Hz`}
            />
            <Metric
              label={t('configurationsSystem.cycleTime')}
              value={status === undefined ? '—' : `${status.cycleTimeUs} µs`}
            />
            <Metric
              label={t('configurationsSystem.cpuLoad')}
              value={status === undefined ? '—' : `${status.cpuLoadPercent}%`}
            />
          </View>
          <Text style={styles.readOnlyNote}>
            {t('configurationsSystem.telemetryReuse')}
          </Text>
        </View>

        {phase === 'LOADING' ? (
          <View style={styles.card}>
            <Text style={styles.stateText}>
              {t('configurationsSystem.loading')}
            </Text>
          </View>
        ) : null}
        {loadMessage === undefined ? null : (
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.errorText}>{loadMessage}</Text>
            <Pressable
              onPress={() => setReloadToken(value => value + 1)}
              style={styles.secondaryButtonWide}
              testID="configurations-retry"
            >
              <Text style={styles.secondaryButtonText}>
                {t('configurationsSystem.reload')}
              </Text>
            </Pressable>
          </View>
        )}

        {draft === undefined || snapshot === undefined ? null : (
          <>
            <View style={[styles.columns, !wide && styles.singleColumn]}>
              <View style={[styles.card, styles.column]}>
                <Text style={styles.cardEyebrow}>
                  {t('configurationsSystem.identityEyebrow')}
                </Text>
                <Text style={styles.cardTitle}>
                  {t('configurationsSystem.identityTitle')}
                </Text>
                <Text style={styles.cardBody}>
                  {t('configurationsSystem.identityDetail')}
                </Text>
                <Text style={styles.inputLabel}>
                  {t('configurationsSystem.craftName')}
                </Text>
                <TextInput
                  value={draft.craftName}
                  onChangeText={craftName => update({ craftName })}
                  editable={!busy}
                  maxLength={16}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.input}
                  placeholder="FPV-QUAD"
                  placeholderTextColor={colors.textMuted}
                  testID="configurations-craft-name"
                />
                <Text style={styles.inputLabel}>
                  {t('configurationsSystem.pilotName')}
                </Text>
                <TextInput
                  value={draft.pilotName}
                  onChangeText={pilotName => update({ pilotName })}
                  editable={!busy}
                  maxLength={16}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.input}
                  placeholder="PILOT"
                  placeholderTextColor={colors.textMuted}
                  testID="configurations-pilot-name"
                />
                <Text style={styles.limitNote}>
                  {t('configurationsSystem.asciiLimit')}
                </Text>
                <NumberControl
                  title={t('configurationsSystem.cameraAngle')}
                  detail={t('configurationsSystem.cameraAngleDetail')}
                  value={draft.fpvCameraAngleDegrees}
                  minimum={0}
                  maximum={90}
                  unit="°"
                  disabled={busy}
                  onChange={fpvCameraAngleDegrees =>
                    update({ fpvCameraAngleDegrees })
                  }
                  testID="configurations-camera-angle"
                />
              </View>

              <View style={[styles.card, styles.column]}>
                <Text style={styles.cardEyebrow}>
                  {t('configurationsSystem.armingEyebrow')}
                </Text>
                <Text style={styles.cardTitle}>
                  {t('configurationsSystem.armingTitle')}
                </Text>
                <Text style={styles.cardBody}>
                  {t('configurationsSystem.armingDetail')}
                </Text>
                <NumberControl
                  title={t('configurationsSystem.smallAngle')}
                  detail={t('configurationsSystem.smallAngleDetail')}
                  value={draft.smallAngleDegrees}
                  minimum={0}
                  maximum={180}
                  unit="°"
                  disabled={busy}
                  onChange={smallAngleDegrees => update({ smallAngleDegrees })}
                  testID="configurations-small-angle"
                />
                <ToggleRow
                  title={t('configurationsSystem.gyroFirstArm')}
                  detail={t('configurationsSystem.gyroFirstArmDetail')}
                  value={draft.gyroCalibrationOnFirstArm}
                  disabled={busy}
                  onChange={gyroCalibrationOnFirstArm =>
                    update({ gyroCalibrationOnFirstArm })
                  }
                  testID="configurations-gyro-first-arm"
                />
                <NumberControl
                  title={t('configurationsSystem.autoDisarm')}
                  detail={t(
                    motorStopEnabled
                      ? 'configurationsSystem.autoDisarmDetail'
                      : 'configurationsSystem.autoDisarmUnavailable',
                  )}
                  value={draft.autoDisarmDelaySeconds}
                  minimum={0}
                  maximum={60}
                  unit="s"
                  disabled={busy || !motorStopEnabled}
                  onChange={autoDisarmDelaySeconds =>
                    update({ autoDisarmDelaySeconds })
                  }
                  testID="configurations-auto-disarm"
                />
                <NumberControl
                  title={t('configurationsSystem.pidDenom')}
                  detail={t('configurationsSystem.pidDenomDetail')}
                  value={draft.pidProcessDenom}
                  minimum={1}
                  maximum={16}
                  unit="×"
                  disabled={busy}
                  onChange={pidProcessDenom => update({ pidProcessDenom })}
                  testID="configurations-pid-denom"
                />
              </View>
            </View>

            <View style={styles.card} testID="configurations-features">
              <Text style={styles.cardEyebrow}>
                {t('configurationsSystem.featuresEyebrow')}
              </Text>
              <Text style={styles.cardTitle}>
                {t('configurationsSystem.featuresTitle')}
              </Text>
              <Text style={styles.cardBody}>
                {t('configurationsSystem.featuresDetail')}
              </Text>
              {availableFeatures.map(feature => (
                <ToggleRow
                  key={feature.key}
                  title={t(
                    `configurationsSystem.feature.${feature.key}.title`,
                  )}
                  detail={t(
                    `configurationsSystem.feature.${feature.key}.detail`,
                  )}
                  value={bitEnabled(draft.featureMaskRaw, feature.bit)}
                  disabled={busy}
                  onChange={enabled =>
                    update({
                      featureMaskRaw: setMaskBit(
                        draft.featureMaskRaw,
                        feature.bit,
                        enabled,
                      ),
                    })
                  }
                  testID={`configurations-feature-${feature.key}`}
                />
              ))}
              {availableFeatures.length < GENERAL_FEATURES.length ? (
                <Text style={styles.limitNote}>
                  {t('configurationsSystem.compiledFilter')}
                </Text>
              ) : null}
            </View>

            <View style={[styles.columns, !wide && styles.singleColumn]}>
              <View style={[styles.card, styles.column]}>
                <Text style={styles.cardEyebrow}>
                  {t('configurationsSystem.beeperEyebrow')}
                </Text>
                <Text style={styles.cardTitle}>
                  {t('configurationsSystem.beeperTitle')}
                </Text>
                <Text style={styles.cardBody}>
                  {t('configurationsSystem.beeperDetail')}
                </Text>
                {BEEPER_CONDITIONS.map(condition => (
                  <ToggleRow
                    key={condition.key}
                    title={t(
                      `configurationsSystem.beeper.${condition.key}`,
                    )}
                    value={
                      !bitEnabled(draft.disabledBeeperMask, condition.bit)
                    }
                    disabled={busy}
                    onChange={enabled =>
                      update({
                        disabledBeeperMask: setMaskBit(
                          draft.disabledBeeperMask,
                          condition.bit,
                          !enabled,
                        ),
                      })
                    }
                    testID={`configurations-beeper-${condition.key}`}
                  />
                ))}
              </View>

              <View style={[styles.card, styles.column]}>
                <Text style={styles.cardEyebrow}>
                  {t('configurationsSystem.dshotEyebrow')}
                </Text>
                <Text style={styles.cardTitle}>
                  {t('configurationsSystem.dshotTitle')}
                </Text>
                <Text style={styles.cardBody}>
                  {t('configurationsSystem.dshotDetail')}
                </Text>
                {!dshotCapable ? (
                  <Text style={styles.limitNote}>
                    {t('configurationsSystem.dshotUnavailable')}
                  </Text>
                ) : null}
                <Text style={styles.groupTitle}>
                  {t('configurationsSystem.dshotTone')}
                </Text>
                <View style={styles.choiceRow}>
                  {[0, 1, 2, 3, 4, 5].map(tone => (
                    <Pressable
                      key={tone}
                      disabled={busy || !dshotCapable}
                      onPress={() => update({ dshotBeaconTone: tone })}
                      style={[
                        styles.choice,
                        draft.dshotBeaconTone === tone && styles.choiceActive,
                      ]}
                      accessibilityRole="radio"
                      accessibilityState={{
                        selected: draft.dshotBeaconTone === tone,
                        disabled: busy || !dshotCapable,
                      }}
                      testID={`configurations-dshot-tone-${tone}`}
                    >
                      <Text
                        style={[
                          styles.choiceText,
                          draft.dshotBeaconTone === tone &&
                            styles.choiceTextActive,
                        ]}
                      >
                        {tone === 0
                          ? t('configurationsSystem.off')
                          : String(tone)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {DSHOT_BEACON_CONDITIONS.map(condition => (
                  <ToggleRow
                    key={condition.key}
                    title={t(
                      `configurationsSystem.dshot.${condition.key}`,
                    )}
                    value={
                      !bitEnabled(
                        draft.disabledDshotBeaconMask,
                        condition.bit,
                      )
                    }
                    disabled={
                      busy || !dshotCapable || draft.dshotBeaconTone === 0
                    }
                    onChange={enabled =>
                      update({
                        disabledDshotBeaconMask: setMaskBit(
                          draft.disabledDshotBeaconMask,
                          condition.bit,
                          !enabled,
                        ),
                      })
                    }
                    testID={`configurations-dshot-${condition.key}`}
                  />
                ))}
              </View>
            </View>

            <View style={styles.card} testID="configurations-destinations">
              <Text style={styles.cardEyebrow}>
                {t('configurationsSystem.integratedEyebrow')}
              </Text>
              <Text style={styles.cardTitle}>
                {t('configurationsSystem.integratedTitle')}
              </Text>
              <Text style={styles.cardBody}>
                {t('configurationsSystem.integratedDetail')}
              </Text>
              <View style={[styles.destinationGrid, !wide && styles.singleColumn]}>
                <DestinationCard
                  title={t('tabs.setup')}
                  detail={t('configurationsSystem.destination.setup')}
                  onPress={onOpenSetup}
                  testID="configurations-open-setup"
                />
                <DestinationCard
                  title={t('tabs.motors')}
                  detail={t('configurationsSystem.destination.motors')}
                  onPress={onOpenMotors}
                  testID="configurations-open-motors"
                />
                <DestinationCard
                  title={t('tabs.ports')}
                  detail={t('configurationsSystem.destination.ports')}
                  onPress={onOpenPorts}
                  testID="configurations-open-ports"
                />
                <DestinationCard
                  title={t('tabs.gps')}
                  detail={t('configurationsSystem.destination.gps')}
                  onPress={onOpenGps}
                  testID="configurations-open-gps"
                />
              </View>
            </View>

            <View style={[styles.card, dirty && styles.reviewCard]}>
              <Text style={styles.cardEyebrow}>
                {t('configurationsSystem.reviewEyebrow')}
              </Text>
              <Text style={styles.cardTitle}>
                {t('configurationsSystem.reviewTitle')}
              </Text>
              <Text style={styles.cardBody}>
                {dirty
                  ? t('configurationsSystem.reviewChanged', {
                      count: changedCount,
                    })
                  : t('configurationsSystem.reviewClean')}
              </Text>
              {issues.length > 0 ? (
                <Text style={styles.errorText} testID="configurations-invalid">
                  {t('configurationsSystem.invalid')}
                </Text>
              ) : null}
              {saveOutcome === undefined ? null : (
                <Text
                  style={[
                    styles.outcomeText,
                    saveOutcome.kind !== 'SAVED_VERIFIED' &&
                      saveOutcome.kind !== 'NO_CHANGES' &&
                      styles.errorText,
                  ]}
                  testID="configurations-save-outcome"
                >
                  {t(outcomeKey(saveOutcome))}
                </Text>
              )}
              <View style={styles.actionRow}>
                <Pressable
                  disabled={busy || !dirty}
                  onPress={() => setDraft(originalDraft)}
                  style={[
                    styles.secondaryButton,
                    (busy || !dirty) && styles.disabled,
                  ]}
                  testID="configurations-reset"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('configurationsSystem.reset')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => setReloadToken(value => value + 1)}
                  style={[styles.secondaryButton, busy && styles.disabled]}
                  testID="configurations-reload"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('configurationsSystem.reload')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy || !dirty || issues.length > 0}
                  onPress={handleSave}
                  style={[
                    styles.primaryButton,
                    (busy || !dirty || issues.length > 0) && styles.disabled,
                  ]}
                  testID="configurations-save"
                >
                  <Text style={styles.primaryButtonText}>
                    {phase === 'SAVING'
                      ? t('configurationsSystem.saving')
                      : t('configurationsSystem.save')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
      </ScrollView>
      {/* OUTSIDE the ScrollView, for the same reason Ports needs it: the
          in-scroll actions sit below every settings card. */}
      <StickyActionBar
        visible={dirty}
        summary={t('configurationsSystem.pendingCount', {
          count: changedCount,
        })}
        saveLabel={t('configurationsSystem.save')}
        discardLabel={t('configurationsSystem.reset')}
        onSave={handleSave}
        onDiscard={() => setDraft(originalDraft)}
        disabledReason={
          issues.length > 0
            ? t('configurationsSystem.invalidPending')
            : undefined
        }
        busy={phase === 'SAVING'}
        busyLabel={t('configurationsSystem.saving')}
        testID="configurations-sticky-actions"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  hero: { paddingHorizontal: spacing.sm, paddingVertical: spacing.lg },
  eyebrow: { ...typography.eyebrow, color: colors.accent },
  title: { ...typography.display, color: colors.textPrimary, marginTop: 2 },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    maxWidth: 740,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  badge: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeGood: { borderColor: colors.success, backgroundColor: colors.accentSoft },
  badgeWarning: { borderColor: colors.warning },
  badgeText: { ...typography.caption, color: colors.textPrimary, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  errorCard: { borderColor: colors.error },
  reviewCard: { borderColor: colors.warning },
  cardEyebrow: { ...typography.eyebrow, color: colors.accent },
  cardTitle: { ...typography.title, color: colors.textPrimary, marginTop: 2 },
  cardBody: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  singleColumn: { flexDirection: 'column' },
  column: { flex: 1, width: '100%' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md },
  metric: { width: '25%', minWidth: 135, padding: spacing.sm },
  metricLabel: { ...typography.caption, color: colors.textSecondary },
  metricValue: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'ltr',
    marginTop: 2,
  },
  readOnlyNote: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  stateText: { ...typography.body, color: colors.textSecondary },
  controlRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: spacing.md,
  },
  numberRow: {
    minHeight: 78,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: spacing.md,
  },
  controlCopy: { flex: 1, minWidth: 190 },
  controlTitle: { ...typography.body, color: colors.textPrimary, fontWeight: '700' },
  controlDetail: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  stepper: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  stepButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepButtonText: { fontSize: 22, color: colors.accent, writingDirection: 'ltr' },
  stepValue: {
    ...typography.body,
    color: colors.textPrimary,
    minWidth: 76,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  inputLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    ...typography.body,
    writingDirection: 'ltr',
    textAlign: 'left',
  },
  limitNote: { ...typography.caption, color: colors.warning, marginTop: spacing.sm },
  groupTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    marginTop: spacing.lg,
  },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  choice: {
    minWidth: 54,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  choiceActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  choiceText: { ...typography.caption, color: colors.textSecondary, fontWeight: '700' },
  choiceTextActive: { color: colors.accent },
  destinationGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  destination: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
    padding: spacing.md,
    gap: spacing.sm,
  },
  destinationCopy: { flex: 1 },
  destinationTitle: { ...typography.body, color: colors.accent, fontWeight: '800' },
  destinationDetail: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  destinationArrow: { fontSize: 26, color: colors.accent },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  secondaryButton: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  secondaryButtonWide: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  secondaryButtonText: { ...typography.body, color: colors.accent, fontWeight: '700' },
  primaryButton: {
    minHeight: 44,
    flexGrow: 1,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryButtonText: { ...typography.body, color: colors.accentText, fontWeight: '800' },
  outcomeText: { ...typography.body, color: colors.success, marginTop: spacing.md },
  errorText: { ...typography.body, color: colors.error, marginTop: spacing.md },
  disabled: { opacity: 0.45 },
});
