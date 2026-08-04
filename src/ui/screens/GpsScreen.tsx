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
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  SERIAL_BAUD_RATES,
  assignedGpsPorts,
  createGpsConfigurationDraft,
  gpsDraftsEqual,
  serialPortDisplayName,
  validateGpsDraft,
  type GpsConfigurationDraft,
  type GpsConfigurationSnapshot,
  type MspCompGps,
  type MspDetailedGps,
  type MspGpsSatelliteInfo,
  type TelemetryValue,
} from '../../core';
import {
  GPS_DETAIL_HOME_POLL_ID,
  GPS_DETAIL_RAW_POLL_ID,
  GPS_DETAIL_SATELLITES_POLL_ID,
  acquireGpsDetailTelemetry,
  gpsConfigurationController,
  type GpsBlockReason,
  type GpsLoadOutcome,
  type GpsSaveOutcome,
  type SetupUiSessionKey,
  useMspIdentificationState,
  useMspOwnershipState,
  useTelemetryValue,
} from '../../platforms/react-native/protocol';
import { openMapLocation } from '../../platforms/mapLink';
import { colors, radii, spacing, typography, useContentEnvelope } from '../theme';
import { StickyActionBar } from '../components/editing';

export interface GpsControllerPort {
  load(sessionKey: SetupUiSessionKey): Promise<GpsLoadOutcome>;
  save(
    sessionKey: SetupUiSessionKey,
    original: GpsConfigurationSnapshot,
    draft: GpsConfigurationDraft,
  ): Promise<GpsSaveOutcome>;
}

export interface GpsScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenPorts: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: GpsControllerPort;
}

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function blockReasonKey(reason: GpsBlockReason): string {
  return `gpsSystem.blockReason.${reason}`;
}

function outcomeKey(outcome: GpsSaveOutcome): string {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return 'gpsSystem.outcome.noChanges';
    case 'SAVED_VERIFIED':
      return 'gpsSystem.outcome.saved';
    case 'SAVED_UNVERIFIED':
      return 'gpsSystem.outcome.savedUnverified';
    case 'UNCONFIRMED':
      return 'gpsSystem.outcome.unconfirmed';
    case 'SESSION_ENDED':
      return 'gpsSystem.outcome.sessionEnded';
    case 'FAILED':
      return 'gpsSystem.outcome.failed';
    case 'REJECTED':
      return blockReasonKey(outcome.reason);
  }
}

function isDangerOutcome(outcome: GpsSaveOutcome): boolean {
  return outcome.kind !== 'NO_CHANGES' && outcome.kind !== 'SAVED_VERIFIED';
}

function valueOf<T>(telemetry: TelemetryValue<T>): T | undefined {
  return telemetry.status === 'FRESH' || telemetry.status === 'STALE'
    ? telemetry.value
    : undefined;
}

function Metric({
  label,
  value,
  unit,
  testID,
}: {
  label: string;
  value: string;
  unit?: string;
  testID?: string;
}) {
  return (
    <View style={styles.metric} testID={testID}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>
        {value}
        {unit === undefined ? '' : ` ${unit}`}
      </Text>
    </View>
  );
}

function Choice({
  label,
  selected,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.choice,
        selected && styles.choiceSelected,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function ToggleRow({
  title,
  detail,
  value,
  disabled,
  onChange,
  testID,
}: {
  title: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  testID: string;
}) {
  return (
    <View style={[styles.toggleRow, disabled && styles.disabled]}>
      <View style={styles.toggleCopy}>
        <Text style={styles.controlTitle}>{title}</Text>
        <Text style={styles.controlDetail}>{detail}</Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={title}
        trackColor={{ false: colors.disabled, true: colors.accentStrong }}
        thumbColor={value ? colors.accent : colors.textSecondary}
        testID={testID}
      />
    </View>
  );
}

export default function GpsScreen({
  sessionKey,
  active,
  onOpenPorts,
  onDirtyChange,
  controller = gpsConfigurationController,
}: GpsScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { maxWidth: contentMaxWidth } = useContentEnvelope(true);
  const { width, fontScale } = useWindowDimensions();
  const wide = width / Math.max(1, fontScale) >= 620;
  const sessionId = sessionKey?.sessionId ?? '';
  const ownership = useMspOwnershipState(sessionId);
  const identification = useMspIdentificationState(sessionId);
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;
  const loadedIdentityRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<GpsConfigurationSnapshot>();
  const [draft, setDraft] = useState<GpsConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] = useState<GpsLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<GpsSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      !active ||
      sessionKey === undefined ||
      ownership !== 'ACTIVE' ||
      identification.status !== 'SUCCEEDED'
    )
      return;
    return acquireGpsDetailTelemetry(sessionKey);
  }, [active, identification.status, ownership, sessionKey]);

  useEffect(() => {
    if (!active || sessionKey === undefined || ownership !== 'ACTIVE') return;
    if (
      identification.status === 'IDLE' ||
      identification.status === 'RUNNING'
    ) {
      setPhase('LOADING');
      return;
    }
    const loadIdentity = `${sessionKey.sessionId}:${sessionKey.generation}:${reloadToken}`;
    // A hidden tab remains mounted. Returning to it must preserve an
    // unsaved draft; only an explicit reload or a genuinely new physical
    // session may replace the operator's edits.
    if (loadedIdentityRef.current === loadIdentity) return;
    loadedIdentityRef.current = loadIdentity;
    setPhase('LOADING');
    setLoadOutcome(undefined);
    setSaveOutcome(undefined);
    controller
      .load(sessionKey)
      .then(outcome => {
        if (!mountedRef.current || loadedIdentityRef.current !== loadIdentity)
          return;
        setLoadOutcome(outcome);
        if (outcome.kind === 'LOADED') {
          setSnapshot(outcome.snapshot);
          setDraft(createGpsConfigurationDraft(outcome.snapshot));
          setPhase('READY');
        } else {
          setSnapshot(undefined);
          setDraft(undefined);
          setPhase('ERROR');
        }
      })
      .catch(error => {
        if (!mountedRef.current || loadedIdentityRef.current !== loadIdentity)
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

  const rawTelemetry = useTelemetryValue<MspDetailedGps>(
    sessionId,
    GPS_DETAIL_RAW_POLL_ID,
    active,
  );
  const homeTelemetry = useTelemetryValue<MspCompGps>(
    sessionId,
    GPS_DETAIL_HOME_POLL_ID,
    active,
  );
  const satellitesTelemetry = useTelemetryValue<MspGpsSatelliteInfo>(
    sessionId,
    GPS_DETAIL_SATELLITES_POLL_ID,
    active,
  );
  const raw = valueOf(rawTelemetry);
  const home = valueOf(homeTelemetry);
  const satellites = valueOf(satellitesTelemetry);
  const ports = snapshot === undefined ? [] : assignedGpsPorts(snapshot);
  const originalDraft = useMemo(
    () =>
      snapshot === undefined
        ? undefined
        : createGpsConfigurationDraft(snapshot),
    [snapshot],
  );
  const dirty =
    draft !== undefined &&
    originalDraft !== undefined &&
    !gpsDraftsEqual(draft, originalDraft);
  const invalid = draft === undefined ? [] : validateGpsDraft(draft);
  const busy = phase === 'LOADING' || phase === 'SAVING';

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const update = useCallback((patch: Partial<GpsConfigurationDraft>) => {
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
      invalid.length > 0
    )
      return;
    Alert.alert(t('gpsSystem.confirmTitle'), t('gpsSystem.confirmBody'), [
      { text: t('gpsSystem.cancel'), style: 'cancel' },
      {
        text: t('gpsSystem.confirmSave'),
        onPress: async () => {
          setPhase('SAVING');
          let outcome: GpsSaveOutcome;
          try {
            outcome = await controller.save(sessionKey, snapshot, draft);
          } catch (error) {
            outcome = { kind: 'FAILED', error };
          }
          setSaveOutcome(outcome);
          if (
            outcome.kind === 'SAVED_VERIFIED' &&
            ownershipRef.current === 'ACTIVE'
          ) {
            setSnapshot(outcome.snapshot);
            setDraft(createGpsConfigurationDraft(outcome.snapshot));
          }
          setPhase(
            outcome.kind === 'SESSION_ENDED' ||
              ownershipRef.current !== 'ACTIVE'
              ? 'ERROR'
              : 'READY',
          );
        },
      },
    ]);
  }, [controller, dirty, draft, invalid.length, sessionKey, snapshot, t]);

  const openMap = useCallback(() => {
    if (raw?.hasFix !== true) return;
    // Platform seam, not a behaviour change: Android still opens the same
    // `geo:` intent URI it always did, while the browser build resolves
    // mapLink.web.ts and opens OpenStreetMap over HTTPS - nothing in a
    // browser handles `geo:`. See src/platforms/mapLink.ts.
    openMapLocation({
      latitudeDegrees: raw.latitudeDegrees,
      longitudeDegrees: raw.longitudeDegrees,
    });
  }, [raw]);

  const loadMessage =
    loadOutcome?.kind === 'REJECTED'
      ? t(blockReasonKey(loadOutcome.reason))
      : loadOutcome?.kind === 'FAILED' || loadOutcome?.kind === 'SESSION_ENDED'
      ? t('gpsSystem.loadFailed')
      : undefined;

  return (
    <View style={styles.root} testID="gps-screen">
      <ScrollView
        contentContainerStyle={[styles.content, { maxWidth: contentMaxWidth }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{t('gpsSystem.eyebrow')}</Text>
          <Text style={styles.title}>{t('gpsSystem.title')}</Text>
          <Text style={styles.subtitle}>{t('gpsSystem.subtitle')}</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusPill,
                ownership === 'ACTIVE' && styles.statusGood,
              ]}
            >
              <Text style={styles.statusText}>
                {ownership === 'ACTIVE'
                  ? t('gpsSystem.connected')
                  : t('gpsSystem.disconnected')}
              </Text>
            </View>
            <View
              style={[
                styles.statusPill,
                raw?.hasFix === true && styles.statusGood,
              ]}
            >
              <Text style={styles.statusText}>
                {raw?.hasFix === true
                  ? t('gpsSystem.fix')
                  : t('gpsSystem.noFix')}
              </Text>
            </View>
            <View
              style={[
                styles.statusPill,
                draft?.enabled === true && styles.statusGood,
              ]}
            >
              <Text style={styles.statusText}>
                {draft?.enabled === true
                  ? t('gpsSystem.featureOn')
                  : t('gpsSystem.featureOff')}
              </Text>
            </View>
          </View>
        </View>

        <View
          style={[styles.card, ports.length === 0 && styles.warningCard]}
          testID="gps-port-integration"
        >
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardHeaderCopy}>
              <Text style={styles.cardEyebrow}>
                {t('gpsSystem.portEyebrow')}
              </Text>
              <Text style={styles.cardTitle}>
                {ports.length === 0
                  ? t('gpsSystem.noPort')
                  : t('gpsSystem.portReady')}
              </Text>
              <Text style={styles.cardBody}>
                {ports.length === 0
                  ? t('gpsSystem.noPortDetail')
                  : ports
                      .map(
                        port =>
                          `${serialPortDisplayName(port.identifier)} · ${
                            SERIAL_BAUD_RATES[port.gpsBaudIndex] ?? '?'
                          }`,
                      )
                      .join('، ')}
              </Text>
            </View>
            <Pressable
              style={styles.secondaryButton}
              onPress={onOpenPorts}
              accessibilityRole="button"
              testID="gps-open-ports"
            >
              <Text style={styles.secondaryButtonText}>
                {t('gpsSystem.openPorts')}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.twoColumn, !wide && styles.oneColumn]}>
          <View style={[styles.card, styles.columnCard]}>
            <Text style={styles.cardEyebrow}>{t('gpsSystem.liveEyebrow')}</Text>
            <Text style={styles.cardTitle}>{t('gpsSystem.liveTitle')}</Text>
            <View style={styles.metricGrid}>
              <Metric
                label={t('gpsSystem.satellites')}
                value={raw === undefined ? '—' : String(raw.satelliteCount)}
                testID="gps-live-satellites"
              />
              <Metric
                label={t('gpsSystem.altitude')}
                value={raw === undefined ? '—' : String(raw.altitudeMeters)}
                unit="m"
              />
              <Metric
                label={t('gpsSystem.speed')}
                value={
                  raw === undefined
                    ? '—'
                    : (raw.groundSpeedCentimetersPerSecond / 100).toFixed(1)
                }
                unit="m/s"
              />
              <Metric
                label={t('gpsSystem.course')}
                value={
                  raw === undefined
                    ? '—'
                    : (raw.groundCourseDecidegrees / 10).toFixed(1)
                }
                unit="°"
              />
              <Metric
                label="PDOP"
                value={
                  raw?.pdopHundredths === undefined
                    ? '—'
                    : (raw.pdopHundredths / 100).toFixed(2)
                }
              />
              <Metric
                label={t('gpsSystem.homeDistance')}
                value={
                  home === undefined ? '—' : String(home.distanceToHomeMeters)
                }
                unit="m"
              />
              <Metric
                label={t('gpsSystem.homeDirection')}
                value={
                  home === undefined ? '—' : String(home.directionToHomeDegrees)
                }
                unit="°"
              />
              <Metric
                label={t('gpsSystem.dataState')}
                value={
                  rawTelemetry.status === 'FRESH'
                    ? t('gpsSystem.live')
                    : rawTelemetry.status === 'STALE'
                    ? t('gpsSystem.stale')
                    : t('gpsSystem.waiting')
                }
              />
            </View>
          </View>

          <View style={[styles.card, styles.columnCard]}>
            <Text style={styles.cardEyebrow}>
              {t('gpsSystem.positionEyebrow')}
            </Text>
            <Text style={styles.cardTitle}>{t('gpsSystem.positionTitle')}</Text>
            <View style={styles.positionPanel}>
              <View
                style={[
                  styles.homeArrow,
                  {
                    transform: [
                      { rotate: `${home?.directionToHomeDegrees ?? 0}deg` },
                    ],
                  },
                ]}
              >
                <Text style={styles.homeArrowText}>↑</Text>
              </View>
              <Text style={styles.positionHint}>
                {raw?.hasFix === true
                  ? t('gpsSystem.positionReady')
                  : t('gpsSystem.positionWaiting')}
              </Text>
            </View>
            <View style={styles.coordinateRow}>
              <Metric
                label={t('gpsSystem.latitude')}
                value={
                  raw?.hasFix === true ? raw.latitudeDegrees.toFixed(7) : '—'
                }
              />
              <Metric
                label={t('gpsSystem.longitude')}
                value={
                  raw?.hasFix === true ? raw.longitudeDegrees.toFixed(7) : '—'
                }
              />
            </View>
            <Pressable
              disabled={raw?.hasFix !== true}
              onPress={openMap}
              style={[
                styles.secondaryButtonWide,
                raw?.hasFix !== true && styles.disabled,
              ]}
              testID="gps-open-map"
            >
              <Text style={styles.secondaryButtonText}>
                {t('gpsSystem.openMap')}
              </Text>
            </Pressable>
            <Text style={styles.privacyNote}>
              {t('gpsSystem.positionPrivacy')}
            </Text>
          </View>
        </View>

        <View style={styles.card} testID="gps-satellite-panel">
          <Text style={styles.cardEyebrow}>{t('gpsSystem.signalEyebrow')}</Text>
          <Text style={styles.cardTitle}>{t('gpsSystem.signalTitle')}</Text>
          <Text style={styles.cardBody}>{t('gpsSystem.signalDetail')}</Text>
          {satellites === undefined || satellites.satellites.length === 0 ? (
            <Text style={styles.emptyText}>
              {t('gpsSystem.noSatelliteDetails')}
            </Text>
          ) : (
            <View style={styles.satelliteGrid}>
              {satellites.satellites.map((satellite, index) => (
                <View
                  key={`${satellite.channelOrGnssId}-${satellite.satelliteId}-${index}`}
                  style={[
                    styles.satellite,
                    satellite.used && styles.satelliteUsed,
                  ]}
                >
                  <View style={styles.satelliteTop}>
                    <Text style={styles.satelliteId}>
                      {satellite.constellation === 'LEGACY'
                        ? t('gpsSystem.legacyChannel')
                        : satellite.constellation}{' '}
                      {satellite.satelliteId}
                    </Text>
                    <Text
                      style={[
                        styles.usedLabel,
                        satellite.used && styles.usedLabelActive,
                      ]}
                    >
                      {satellite.used
                        ? t('gpsSystem.used')
                        : t('gpsSystem.visible')}
                    </Text>
                  </View>
                  <View style={styles.signalTrack}>
                    <View
                      style={[
                        styles.signalFill,
                        {
                          width: `${Math.min(
                            100,
                            Math.max(0, satellite.signalToNoiseDbHz * 2),
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.signalValue}>
                    {satellite.signalToNoiseDbHz} dB-Hz · Q{satellite.quality}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <View style={styles.card} testID="gps-configuration-panel">
          <Text style={styles.cardEyebrow}>{t('gpsSystem.configEyebrow')}</Text>
          <Text style={styles.cardTitle}>{t('gpsSystem.configTitle')}</Text>
          <Text style={styles.cardBody}>{t('gpsSystem.configDetail')}</Text>

          {phase === 'LOADING' ? (
            <Text style={styles.stateText}>{t('gpsSystem.loading')}</Text>
          ) : null}
          {loadMessage !== undefined ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{loadMessage}</Text>
              <Pressable
                onPress={() => setReloadToken(value => value + 1)}
                style={styles.secondaryButtonWide}
                testID="gps-retry-load"
              >
                <Text style={styles.secondaryButtonText}>
                  {t('gpsSystem.reload')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {draft !== undefined ? (
            <>
              <ToggleRow
                title={t('gpsSystem.enable')}
                detail={t('gpsSystem.enableDetail')}
                value={draft.enabled}
                disabled={busy}
                onChange={enabled => update({ enabled })}
                testID="gps-enable"
              />
              <Text style={styles.groupTitle}>
                {t('gpsSystem.providerTitle')}
              </Text>
              <View style={styles.choiceWrap}>
                <Choice
                  label="UBLOX"
                  selected={draft.provider === 1}
                  disabled={busy}
                  onPress={() => update({ provider: 1 })}
                  testID="gps-provider-ublox"
                />
                <Choice
                  label="NMEA"
                  selected={draft.provider === 0}
                  disabled={busy}
                  onPress={() => update({ provider: 0 })}
                  testID="gps-provider-nmea"
                />
                <Choice
                  label="MSP"
                  selected={draft.provider === 2}
                  disabled={busy}
                  onPress={() => update({ provider: 2 })}
                  testID="gps-provider-msp"
                />
                {draft.provider === 3 ? (
                  <Choice
                    label="VIRTUAL"
                    selected
                    disabled
                    onPress={() => {}}
                    testID="gps-provider-virtual"
                  />
                ) : null}
              </View>

              <Text style={styles.groupTitle}>{t('gpsSystem.sbasTitle')}</Text>
              <View style={styles.choiceWrap}>
                {(
                  ['AUTO', 'EGNOS', 'WAAS', 'MSAS', 'GAGAN', 'NONE'] as const
                ).map((label, mode) => (
                  <Choice
                    key={label}
                    label={label}
                    selected={draft.sbasMode === mode}
                    disabled={busy}
                    onPress={() => update({ sbasMode: mode })}
                    testID={`gps-sbas-${label.toLowerCase()}`}
                  />
                ))}
              </View>

              <ToggleRow
                title={t('gpsSystem.autoConfig')}
                detail={t('gpsSystem.autoConfigDetail')}
                value={draft.autoConfig}
                disabled={busy || draft.provider !== 1}
                onChange={autoConfig => update({ autoConfig })}
                testID="gps-auto-config"
              />
              <ToggleRow
                title={t('gpsSystem.galileo')}
                detail={t('gpsSystem.galileoDetail')}
                value={draft.useGalileo}
                disabled={busy || draft.provider !== 1 || !draft.autoConfig}
                onChange={useGalileo => update({ useGalileo })}
                testID="gps-galileo"
              />
              <ToggleRow
                title={t('gpsSystem.homeOnce')}
                detail={t('gpsSystem.homeOnceDetail')}
                value={draft.homePointOnce}
                disabled={busy}
                onChange={homePointOnce => update({ homePointOnce })}
                testID="gps-home-once"
              />

              <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>
                  {t('gpsSystem.autoBaudTitle')}
                </Text>
                <Text style={styles.infoText}>
                  {t('gpsSystem.autoBaudModern')}
                </Text>
              </View>
              {invalid.length > 0 ? (
                <Text style={styles.errorText}>{t('gpsSystem.invalid')}</Text>
              ) : null}
              {saveOutcome !== undefined ? (
                <Text
                  style={[
                    styles.outcomeText,
                    saveOutcome.kind !== 'SAVED_VERIFIED' &&
                      saveOutcome.kind !== 'NO_CHANGES' &&
                      styles.errorText,
                  ]}
                  testID="gps-save-outcome"
                >
                  {t(outcomeKey(saveOutcome))}
                </Text>
              ) : null}
              <View style={styles.actionRow}>
                <Pressable
                  disabled={busy || !dirty}
                  onPress={() => setDraft(originalDraft)}
                  style={[
                    styles.secondaryButton,
                    (busy || !dirty) && styles.disabled,
                  ]}
                  testID="gps-reset"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('gpsSystem.reset')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => setReloadToken(value => value + 1)}
                  style={[styles.secondaryButton, busy && styles.disabled]}
                  testID="gps-reload"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('gpsSystem.reload')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy || !dirty || invalid.length > 0}
                  onPress={handleSave}
                  style={[
                    styles.primaryButton,
                    (busy || !dirty || invalid.length > 0) && styles.disabled,
                  ]}
                  testID="gps-save"
                >
                  <Text style={styles.primaryButtonText}>
                    {phase === 'SAVING'
                      ? t('gpsSystem.saving')
                      : t('gpsSystem.save')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
      {/* Betaflight keeps the GPS save action in a fixed bottom toolbar.
          This screen contains live telemetry before the configuration card,
          so its in-page action can otherwise be several viewports away.
          Keep the real transaction visible whenever a real draft exists. */}
      <StickyActionBar
        visible={dirty}
        summary={t('gpsSystem.pendingChanges')}
        saveLabel={t('gpsSystem.save')}
        discardLabel={t('gpsSystem.reset')}
        onSave={handleSave}
        onDiscard={() => {
          setDraft(originalDraft);
          setSaveOutcome(undefined);
        }}
        disabledReason={
          invalid.length > 0 ? t('gpsSystem.invalidPending') : undefined
        }
        statusMessage={
          saveOutcome === undefined ? undefined : t(outcomeKey(saveOutcome))
        }
        statusTone={
          saveOutcome !== undefined && isDangerOutcome(saveOutcome)
            ? 'warning'
            : 'normal'
        }
        busy={phase === 'SAVING'}
        busyLabel={t('gpsSystem.saving')}
        testID="gps-sticky-actions"
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
  title: {
    ...typography.display,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    maxWidth: 700,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  statusPill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  statusGood: {
    borderColor: colors.success,
    backgroundColor: colors.accentSoft,
  },
  statusText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  warningCard: { borderColor: colors.warning },
  cardHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
  },
  cardHeaderCopy: { flex: 1, minWidth: 220 },
  cardEyebrow: { ...typography.eyebrow, color: colors.accent },
  cardTitle: { ...typography.title, color: colors.textPrimary, marginTop: 2 },
  cardBody: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  twoColumn: { flexDirection: 'row', gap: spacing.md },
  oneColumn: { flexDirection: 'column' },
  columnCard: { flex: 1 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md },
  metric: { width: '50%', padding: spacing.sm, minWidth: 120 },
  metricLabel: { ...typography.caption, color: colors.textSecondary },
  metricValue: {
    ...typography.title,
    color: colors.textPrimary,
    marginTop: 2,
    writingDirection: 'ltr',
  },
  positionPanel: {
    height: 150,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  homeArrow: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeArrowText: {
    fontSize: 32,
    color: colors.accent,
    writingDirection: 'ltr',
  },
  positionHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  coordinateRow: { flexDirection: 'row', marginTop: spacing.sm },
  privacyNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  satelliteGrid: { gap: spacing.sm, marginTop: spacing.md },
  satellite: {
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.backgroundRaised,
  },
  satelliteUsed: { borderColor: colors.accent },
  satelliteTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  satelliteId: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  usedLabel: { ...typography.caption, color: colors.textMuted },
  usedLabelActive: { color: colors.success },
  signalTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.borderSoft,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  signalFill: { height: '100%', backgroundColor: colors.accent },
  signalValue: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    writingDirection: 'ltr',
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
  toggleRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: spacing.md,
  },
  toggleCopy: { flex: 1 },
  controlTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  controlDetail: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  groupTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    marginTop: spacing.lg,
  },
  choiceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  choice: {
    minHeight: 44,
    minWidth: 78,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  choiceSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  choiceText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  choiceTextSelected: { color: colors.accent },
  infoBox: {
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.info,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  infoTitle: { ...typography.body, color: colors.info, fontWeight: '700' },
  infoText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  errorBox: {
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  errorText: { ...typography.body, color: colors.error },
  stateText: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  outcomeText: {
    ...typography.body,
    color: colors.success,
    marginTop: spacing.md,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonWide: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  secondaryButtonText: {
    ...typography.body,
    color: colors.accent,
    fontWeight: '700',
  },
  primaryButton: {
    minHeight: 44,
    flexGrow: 1,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...typography.body,
    color: colors.accentText,
    fontWeight: '800',
  },
  disabled: { opacity: 0.45 },
});
