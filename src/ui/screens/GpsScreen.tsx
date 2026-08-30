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
import {colors, noticeSurface, radii, spacing, typography, useContentEnvelope} from '../theme';
import {PROSE_MEASURE} from '../theme';
import {
  Button,
  MIN_TOUCH_TARGET,
  ToggleSwitch,
} from '../components/controls';
import { readInteraction } from '../components/controls/interaction';
import { Icon } from '../icons';
import { StickyActionBar } from '../components/editing';
import {classifyGpsPositionQuality, type GpsPositionQuality} from '../../core';

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
    /*
     * PERSISTENCE AND REBOOT ACKNOWLEDGEMENT ARE TWO DIFFERENT FACTS.
     *
     * The save persists to EEPROM and then asks the flight controller to
     * restart. That second frame can go unanswered - a timeout, a link
     * that vanishes - and the app then knows only that IT DID NOT
     * RECEIVE THE ACKNOWLEDGEMENT. It does not know the reboot failed;
     * a disappearing link is itself consistent with a board rebooting.
     *
     * Reporting «إعادة تشغيل المتحكم متوقعة» on that evidence stated a
     * restart the app never confirmed. `rebootAcknowledged` was sitting
     * on the outcome the whole time and this mapping ignored it.
     *
     * So the language is CONFIRMED ACKNOWLEDGEMENT vs NOT CONFIRMED -
     * never "rebooted" vs "reboot failed" - and it never touches the
     * persistence claim, which is already established by the EEPROM
     * acknowledgement and stays true either way.
     */
    case 'SAVED_VERIFIED':
      return outcome.rebootAcknowledged
        ? 'gpsSystem.outcome.saved'
        : 'gpsSystem.outcome.savedRebootUnconfirmed';
    /* Readback uncertainty and reboot uncertainty stay separate. */
    case 'SAVED_UNVERIFIED':
      return outcome.rebootAcknowledged
        ? 'gpsSystem.outcome.savedUnverified'
        : 'gpsSystem.outcome.savedUnverifiedRebootUnconfirmed';
    case 'UNCONFIRMED':
      return 'gpsSystem.outcome.unconfirmed';
    /* U-R1. RAM moved and flash did not. A stop at EEPROM means every
       change is live and only persistence was missed; a stop at a
       configuration group means only PART of it is live. Neither is
       «فشل الحفظ». */
    case 'PARTIAL_UNPERSISTED':
      return outcome.failedStage === 'EEPROM'
        ? 'gpsSystem.outcome.appliedNotPersisted'
        : 'gpsSystem.outcome.partiallyApplied';
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
      style={state => {
        const { pressed, hovered } = readInteraction(state);
        return [
          styles.choice,
          selected && styles.choiceSelected,
          (hovered || pressed) && !disabled && styles.choiceActive,
          disabled && styles.disabled,
        ];
      }}
      testID={testID}
    >
      {selected ? (
        <Icon name="check" size={16} color={colors.accentStrong} />
      ) : null}
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
      <ToggleSwitch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={title}
        testID={testID}
      />
    </View>
  );
}

/**
 * Betaflight's five-star DOP scale, in words instead of stars.
 *
 * UNKNOWN is deliberately not "سيئة": a board that never sent the field
 * has told us nothing about the fix, and reporting that as a bad fix
 * would be as wrong as reporting it as a good one.
 */
const GPS_QUALITY_TEXT: Readonly<Record<GpsPositionQuality, string>> = {
  IDEAL: 'مثالية',
  EXCELLENT: 'ممتازة',
  GOOD: 'جيدة',
  MODERATE: 'متوسطة',
  FAIR: 'ضعيفة',
  POOR: 'رديئة',
  UNKNOWN: 'غير معروفة',
};

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
  /**
   * POSITION IS ONLY A POSITION WHILE IT IS FRESH.
   *
   * valueOf() deliberately returns the last value for STALE as well as
   * FRESH - most readings on this screen are still worth showing while
   * they age, clearly labelled. Position is the exception, because a
   * COORDINATE that is merely old is not a weaker fact, it is a wrong
   * one: it names a place the aircraft is no longer at.
   *
   * So the coordinate block, the home bearing and the map link are gated
   * on FRESH, not on `hasFix` alone. Before this, a link that went stale
   * left the last known position on screen looking exactly like a live
   * one, with «فتح الموقع في تطبيق الخرائط» still enabled - one press away
   * from sending someone to where the aircraft used to be.
   */
  const positionIsLive = rawTelemetry.status === 'FRESH' && raw?.hasFix === true;
  const homeIsLive = homeTelemetry.status === 'FRESH' && home !== undefined;
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

  const reloadNow = useCallback(() => {
    setSaveOutcome(undefined);
    setReloadToken(value => value + 1);
  }, []);
  const requestReload = useCallback(() => {
    if (!dirty) return reloadNow();
    Alert.alert(t('gpsSystem.discardChangesTitle'), t('gpsSystem.discardChangesBody'), [
      { text: t('gpsSystem.cancel'), style: 'cancel' },
      { text: t('gpsSystem.discardAndReload'), style: 'destructive', onPress: reloadNow },
    ]);
  }, [dirty, reloadNow, t]);

  const openMap = useCallback(() => {
    // FRESH, not merely fixed. Handing a stale coordinate to a map
    // application is the one failure on this screen that sends a person
    // to the wrong place, so the handler re-checks rather than trusting
    // the disabled prop.
    if (rawTelemetry.status !== 'FRESH' || raw?.hasFix !== true) return;
    // Platform seam, not a behaviour change: Android still opens the same
    // `geo:` intent URI it always did, while the browser build resolves
    // mapLink.web.ts and opens OpenStreetMap over HTTPS - nothing in a
    // browser handles `geo:`. See src/platforms/mapLink.ts.
    openMapLocation({
      latitudeDegrees: raw.latitudeDegrees,
      longitudeDegrees: raw.longitudeDegrees,
    });
  }, [raw, rawTelemetry.status]);

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
            <Button
              label={t('gpsSystem.openPorts')}
              onPress={onOpenPorts}
              variant="secondary"
              icon="cable"
              testID="gps-open-ports"
            />
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
              {/* Not a bare acronym any more. The number is the board's
                  own PDOP; the word beside it is Betaflight's own verdict
                  on that number, and the hint states the direction,
                  because this is the one metric on the screen where
                  LOWER is better. */}
              <Metric
                label="دقة تحديد الموقع"
                value={
                  raw?.pdopHundredths === undefined
                    ? '—'
                    : `${(raw.pdopHundredths / 100).toFixed(2)} · ${GPS_QUALITY_TEXT[classifyGpsPositionQuality(raw.pdopHundredths)]}`
                }
                testID="gps-position-quality"
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
              {/* NO DATUM, NO ARROW.
                  This used to rotate by `home?.directionToHomeDegrees ?? 0`,
                  so with no home reading at all it pointed due north and
                  looked exactly like a real bearing - a fabricated
                  direction an operator could have walked in. The arrow now
                  renders only when the flight controller has actually
                  reported a direction; otherwise the hint below says the
                  reading has not arrived, which is the truth. */}
              {!homeIsLive ? (
                <View style={styles.homeArrowAbsent} testID="gps-home-arrow-absent">
                  <Icon name="navigation" size={30} color={colors.textMuted} />
                </View>
              ) : (
                <View
                  testID="gps-home-arrow"
                  style={[
                    styles.homeArrow,
                    {
                      transform: [
                        { rotate: `${home.directionToHomeDegrees}deg` },
                      ],
                    },
                  ]}
                >
                  {/* A physical compass bearing: raw geometry, never an
                      RTL-mirrored alias. */}
                  <Icon name="navigation" size={30} color={colors.accentStrong} />
                </View>
              )}
              <Text style={styles.positionHint} testID="gps-position-hint">
                {positionIsLive
                  ? t('gpsSystem.positionReady')
                  : rawTelemetry.status === 'STALE'
                  ? t('gpsSystem.positionStale')
                  : t('gpsSystem.positionWaiting')}
              </Text>
            </View>
            <View style={styles.coordinateRow}>
              {/* A coordinate that is merely old is not a weaker fact, it
                  is a wrong one - so it is withheld rather than shown
                  next to a small "stale" label the eye skips. */}
              <Metric
                label={t('gpsSystem.latitude')}
                value={positionIsLive ? raw.latitudeDegrees.toFixed(7) : '—'}
              />
              <Metric
                label={t('gpsSystem.longitude')}
                value={positionIsLive ? raw.longitudeDegrees.toFixed(7) : '—'}
              />
            </View>
            <Button
              label={t('gpsSystem.openMap')}
              onPress={openMap}
              variant="secondary"
              icon="map-pin"
              disabled={!positionIsLive}
              style={styles.blockActionSpacing}
              testID="gps-open-map"
            />
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
              <Button
                label={t('gpsSystem.reload')}
                onPress={requestReload}
                variant="secondary"
                icon="refresh-cw"
                style={styles.blockActionSpacing}
                testID="gps-retry-load"
              />
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
              {/* One sentence per issue, naming the setting - the same
                  contract Failsafe and Ports use. A generic "something is
                  invalid" leaves the operator hunting through the screen for
                  which of two dropdowns it means. */}
              {invalid.map(code => (
                <Text key={code} style={styles.errorText}>
                  {t(`gpsSystem.validation.${code}`)}
                </Text>
              ))}
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
                <Button
                  label={t('gpsSystem.reset')}
                  onPress={() => setDraft(originalDraft)}
                  variant="secondary"
                  icon="rotate-ccw"
                  disabled={busy || !dirty}
                  testID="gps-reset"
                />
                <Button
                  label={t('gpsSystem.reload')}
                  onPress={requestReload}
                  variant="secondary"
                  icon="refresh-cw"
                  disabled={busy}
                  testID="gps-reload"
                />
                <Button
                  label={
                    phase === 'SAVING'
                      ? t('gpsSystem.saving')
                      : t('gpsSystem.save')
                  }
                  onPress={handleSave}
                  variant="primary"
                  icon="save"
                  disabled={busy || !dirty || invalid.length > 0}
                  accessibilityLabel={t('gpsSystem.save')}
                  style={styles.saveGrow}
                  testID="gps-save"
                />
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
  eyebrow: { ...typography.eyebrow, color: colors.accentStrong },
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
    fontWeight: '700', maxWidth: PROSE_MEASURE},
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
  cardEyebrow: { ...typography.eyebrow, color: colors.accentStrong },
  cardTitle: { ...typography.title, color: colors.textPrimary, marginTop: 2 },
  cardBody: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs, maxWidth: PROSE_MEASURE},
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
  /* The same dial, drawn as UNKNOWN: muted, unrotated, and visibly not a
     reading. Keeping the shape stops the card reflowing when a fix
     arrives; the colour is what says there is nothing to point at. */
  homeArrowAbsent: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.borderSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeArrow: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.accentSoft,
    borderWidth: 1.5,
    borderColor: colors.accentStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  positionHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm, maxWidth: PROSE_MEASURE},
  coordinateRow: { flexDirection: 'row', marginTop: spacing.sm },
  privacyNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.sm, maxWidth: PROSE_MEASURE},
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
    marginTop: spacing.md, maxWidth: PROSE_MEASURE},
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
    marginTop: 2, maxWidth: PROSE_MEASURE},
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
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 78,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  choiceSelected: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
  },
  choiceActive: { backgroundColor: colors.surfaceHover },
  choiceText: {
    ...typography.label,
    color: colors.textSecondary,
    writingDirection: 'ltr',
  },
  choiceTextSelected: { color: colors.accentStrong },
  infoBox: {...noticeSurface, backgroundColor: colors.infoSoft,
    borderColor: colors.info,
    marginTop: spacing.md},
  infoTitle: { ...typography.bodyStrong, color: colors.info },
  infoText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  errorBox: {...noticeSurface, borderColor: colors.error,
    backgroundColor: colors.errorSoft,
    marginTop: spacing.md},
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
  blockActionSpacing: { marginTop: spacing.md },
  saveGrow: { flexGrow: 1 },
  disabled: { opacity: 0.45 },
});
