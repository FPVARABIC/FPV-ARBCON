import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Alert, Animated, Easing, I18nManager, Platform, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent} from 'react-native';
import {useTranslation} from 'react-i18next';
import {
  createReceiverConfigurationDraft, deriveReceiverRssi, receiverDraftsEqual,
  receiverValuesMayBeFailsafeOutput, resolveReceiverSignalState,
  validateReceiverDraft, RECEIVER_CHANNEL_MAX_COUNT,
  type MspAnalog, type MspRcChannels,
  type MspStatusExDiagnostics, type ReceiverConfigurationDraft,
  type ReceiverConfigurationSnapshot, type ReceiverMode, type ReceiverPortDependency,
  type ReceiverSignalState, type TelemetryValue,
} from '../../core';
/* P5: the NARROW Receiver facade, not the ~180-symbol platform barrel.
   The barrel also exports RNMspTransport and the live session
   coordinator; importing from it left raw wire authority one keystroke
   from a React component. receiverBoundary.test.ts enforces this. */
import {
  FC_STATUS_TELEMETRY_POLL_ID, RECEIVER_CHANNELS_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID, acquireReceiverTelemetry, getReceiverObservedRateHz,
  receiverConfigurationController, useTelemetryValue,
  type ReceiverBlockReason, type ReceiverLoadOutcome, type ReceiverRebootOutcome,
  type ReceiverModeTarget, type ReceiverRuntimeOutcome, type ReceiverRuntimeTruth,
  type ReceiverSaveOutcome, type SetupUiSessionKey,
} from '../../platforms/react-native/protocol/receiverPresentation';
import {StickyActionBar} from '../components/editing';
import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, SelectField, Stepper as SharedStepper, ToggleSwitch} from '../components/controls';
import {Icon, type IconName} from '../icons/Icon';

export interface ReceiverControllerPort {
  load(key: SetupUiSessionKey): Promise<ReceiverLoadOutcome>;
  save(key: SetupUiSessionKey, original: ReceiverConfigurationSnapshot, draft: ReceiverConfigurationDraft, modeTarget?: ReceiverModeTarget): Promise<ReceiverSaveOutcome>;
  /** P2 read-only firmware truth: active receiver mode, Ports agreement,
   * RSSI source. Optional so an existing test double stays valid. */
  readRuntime?(key: SetupUiSessionKey): Promise<ReceiverRuntimeOutcome>;
  /** P2: the canonical reboot, owned by the controller. The screen never
   * issues MSP_REBOOT itself and never infers reconnection from it. */
  requestReboot?(key: SetupUiSessionKey): Promise<ReceiverRebootOutcome>;
}
export interface ReceiverScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenPorts: () => void;
  readonly onOpenMotors: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: ReceiverControllerPort;
}
type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

/** Betaflight API 1.47 serialrx_provider enum, index === firmware value
 * (rx.h:52-70). Kept as code, not i18n: these are protocol tokens. */
const SERIAL_RX_NAMES = Object.freeze(['NONE', 'SPEKTRUM2048', 'SBUS', 'SUMD', 'SUMH', 'XBUS_MODE_B', 'XBUS_MODE_B_RJ01', 'IBUS', 'JETIEXBUS', 'CRSF', 'SRXL', 'TARGET_CUSTOM', 'FPORT', 'SRXL2', 'GHST', 'SPEKTRUM1024', 'MAVLINK']);
const CRSF_PROVIDER_INDEX = 9;

/**
 * P3-F/P3-J: ONE display domain, shared by the channel bars and the stick
 * pads.
 *
 * 800-2200us is the window Betaflight Configurator uses for its own
 * receiver bars, so a pilot reading both tools sees the same geometry.
 * It is a VISUALISATION choice, not firmware enforcement - the firmware's
 * valid pulse range is 750-2250 (rx.h:36-37) and the exact delivered
 * value is always printed next to the bar, unclipped.
 *
 * Before P3 the bars used this window while the stick pads used
 * 1000-2000, so the same 1500us sample sat at 50% on a bar and 50% on a
 * pad only by coincidence - any other value disagreed between the two
 * views of the same channel. They now share this function.
 */
const DISPLAY_MIN_US = 800;
const DISPLAY_MAX_US = 2200;
export function channelDisplayFraction(value: number): number {
  return Math.max(0, Math.min(1, (value - DISPLAY_MIN_US) / (DISPLAY_MAX_US - DISPLAY_MIN_US)));
}

/**
 * P3-G: how long a bar takes to reach a newly delivered sample.
 *
 * PRESENTATION ONLY. The integer printed beside every bar is always the
 * exact delivered MSP_RC value, never smoothed, never delayed; this
 * constant governs pixels and nothing else.
 *
 * 50ms is chosen against our own delivered cadence rather than copied:
 * live RC settles at a 40ms period (see receiverTelemetry's interval
 * note), so a 50ms ease is just longer than the gap between samples -
 * long enough to bridge the stair-step a ~25Hz stream makes on a 60Hz
 * display, short enough to stay a presentation effect rather than lag.
 *
 * Measured, not assumed. Browser step response at 60fps: the bar starts
 * moving on the frame after the sample lands and finishes exactly 50ms
 * later, ~80ms end to end once React's commit is included. Under a
 * continuous 25Hz stream driving a full 1000-2000us sweep every 500ms -
 * far faster than a pilot moves a stick - the bar trails the printed
 * integer by a median of ~10 and a worst case of ~21 percentage points
 * of the display domain, i.e. roughly one smoothing window. That trailing
 * IS the smoothing; it is why the exact value is printed unsmoothed
 * beside it.
 */
export const CHANNEL_SMOOTHING_MS = 50;

/**
 * Stick-pad geometry, hoisted out of the stylesheet so the dot's travel
 * can be computed from the same numbers the pad is drawn with.
 *
 * These are fixed style constants, not measured layout, so the dot needs
 * NO onLayout and no per-sample measurement: the travel is a compile-time
 * constant. The dot is centred on its own position (the negative margins
 * in `stickDot`), so its centre sweeps the FULL pad edge to edge - which
 * is exactly what the previous `left: '0%'..'100%'` positioning did,
 * including the half-dot clipped at each extreme by the pad's
 * `overflow: 'hidden'`.
 */
export const STICK_PAD_SIZE = 112;
export const STICK_DOT_SIZE = 14;
export const STICK_PAD_BORDER = 1;

/**
 * The dot's travel is the pad's PADDING box, not its border box.
 *
 * Measured regression, caught by the P2 responsive sweep: translating by
 * the full 112px border-box size put the dot's centre at 113px inside a
 * pad whose inner edge is at 111px, so at full deflection the dot pressed
 * 2px past the corner and was flattened by the pad's `overflow: 'hidden'`
 * instead of sitting on it - and every intermediate position was 1px out.
 *
 * The previous `left: '0%'..'100%'` did not have this problem because a
 * percentage offset on an absolutely-positioned child resolves against
 * the containing block's PADDING box, which excludes the 1px border. A
 * pixel translation has to subtract that border explicitly.
 */
export const STICK_PAD_TRAVEL = STICK_PAD_SIZE - STICK_PAD_BORDER * 2;

/** Dot centre offset, in pixels, for a 0..1 channel fraction. */
export function stickDotTranslateX(fraction: number): number {
  return fraction * STICK_PAD_TRAVEL;
}
/** Screen coordinates grow downward while stick travel grows upward. */
export function stickDotTranslateY(fraction: number): number {
  return (1 - fraction) * STICK_PAD_TRAVEL;
}

/**
 * ONE eased display position per channel, in 0..1, shared by that
 * channel's bar and by the stick pad that also draws it.
 *
 * Shared deliberately. P3 already made both views read the same
 * channelDisplayFraction so a sample cannot sit at two positions; two
 * independent animations would have reintroduced exactly that
 * disagreement transiently (measured at up to ~8 percentage points on a
 * fast stick sweep before this was unified). One Animated.Value per
 * channel makes the two views the same number by construction, and the
 * pad simply interpolates it in the opposite direction for its vertical
 * axis.
 *
 * This adds NO telemetry source, no poll, no interval and no timer of
 * the screen's own: the only clock is the animation driver's, and it
 * runs solely while a value is in motion. Because Animated drives the
 * nodes directly, a frame costs no re-render of the workspace.
 *
 * Latest-value-wins with no backlog: Animated.Value.animate() stops any
 * in-flight animation before starting the next, so a new sample takes
 * over from wherever the bar currently is, and an arbitrarily fast
 * stream can never queue work. The effect cleanup is that same stop(),
 * so unmounting halts every animation instead of leaving them running.
 *
 * `animate === false` snaps instead of gliding, and so does the first
 * sample after an empty screen. Glide is the one thing here that means
 * "samples are arriving", so a link that is no longer fresh must land on
 * its true last value immediately and stay there.
 *
 * The pool is fixed: decodeRcChannels refuses any payload with more than
 * RECEIVER_CHANNEL_MAX_COUNT channels, so it can never be outgrown.
 */
function useSmoothedChannelPositions(channels: readonly number[], animate: boolean): readonly Animated.Value[] {
  const ref = useRef<Animated.Value[] | undefined>(undefined);
  if (ref.current === undefined) {
    ref.current = Array.from({length: RECEIVER_CHANNEL_MAX_COUNT}, () => new Animated.Value(0));
  }
  const positions = ref.current;
  const seeded = useRef(false);
  // A LAYOUT effect, not a passive one: starting the ease before paint
  // rather than after it removes a whole frame of dead time between the
  // sample landing and the bar beginning to move. Measured below.
  useLayoutEffect(() => {
    const running: {stop(): void}[] = [];
    const glide = animate && seeded.current;
    channels.forEach((value, index) => {
      const position = positions[index];
      if (position === undefined) return;
      const target = channelDisplayFraction(value);
      if (!glide) { position.setValue(target); return; }
      // NATIVE DRIVER. Every style this node drives is a transform
      // (scaleX for the bars, translateX/translateY for the stick dots),
      // which is what makes `useNativeDriver: true` legal here - see
      // ChannelRow and StickPad below, and the note on CHANNEL_SMOOTHING_MS.
      const animation = Animated.timing(position, {toValue: target, duration: CHANNEL_SMOOTHING_MS, easing: Easing.out(Easing.quad), useNativeDriver: true});
      animation.start();
      running.push(animation);
    });
    seeded.current = channels.length > 0;
    return () => { for (const animation of running) animation.stop(); };
  }, [animate, channels, positions]);
  return positions;
}

function valueOf<T>(value: TelemetryValue<T>): T | undefined { return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined; }

export default function ReceiverScreen({sessionKey, active, onOpenPorts, onOpenMotors, onDirtyChange, controller = receiverConfigurationController}: ReceiverScreenProps): React.JSX.Element {
  const {t} = useTranslation();
  const {maxWidth} = useContentEnvelope(true);
  const {width, fontScale} = useWindowDimensions();
  const wide = width / Math.max(1, fontScale) >= 900;
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<ReceiverConfigurationSnapshot>();
  const [draft, setDraft] = useState<ReceiverConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] = useState<ReceiverLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<ReceiverSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);
  /* P4-R. Re-reads runtime truth ONLY. Deliberately separate from
     reloadToken: that one drives the full load effect, which clears the
     save outcome - and wiping the "reboot required" panel the instant it
     appears is exactly the false-success this phase exists to avoid. */
  const [runtimeToken, setRuntimeToken] = useState(0);
  const [runtime, setRuntime] = useState<ReceiverRuntimeTruth>();
  const [rebootOutcome, setRebootOutcome] = useState<ReceiverRebootOutcome>();
  /** P4: the PROPOSED receiver mode. undefined means "unchanged"; it is
   * never seeded from runtime so a mere page load can never look dirty. */
  const [modeDraft, setModeDraft] = useState<ReceiverMode>();

  const blockMessage = useCallback((reason: ReceiverBlockReason): string => ({
    DISCONNECTED: t('receiverScreen.blockDisconnected'),
    IDENTIFYING: t('receiverScreen.blockIdentifying'),
    UNSUPPORTED_FIRMWARE: t('receiverScreen.blockUnsupported'),
    APP_BACKGROUNDED: t('receiverScreen.blockBackgrounded'),
    LINK_RECOVERING: t('receiverScreen.blockRecovering'),
    FC_ARMED: t('receiverScreen.blockArmed'),
    ARMED_STATE_UNKNOWN: t('receiverScreen.blockArmedUnknown'),
    MOTOR_TEST_ACTIVE: t('receiverScreen.blockMotorTest'),
    CONFIGURATION_BUSY: t('receiverScreen.blockBusy'),
    STALE_BASE: t('receiverScreen.blockStaleBase'),
    INVALID_CONFIGURATION: t('receiverScreen.blockInvalid'),
    DEPENDENCY_MISSING: t('receiverScreen.blockDependencyMissing'),
    DEPENDENCY_AMBIGUOUS: t('receiverScreen.blockDependencyAmbiguous'),
    DEPENDENCY_UNKNOWN: t('receiverScreen.blockDependencyUnknown'),
    MODE_NOT_WRITABLE: t('receiverScreen.blockModeNotWritable'),
    CAPABILITY_UNAVAILABLE: t('receiverScreen.blockCapabilityUnavailable'),
    CAPABILITY_NOT_PROVEN: t('receiverScreen.blockCapabilityNotProven'),
  } as Record<ReceiverBlockReason, string>)[reason], [t]);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined); setRebootOutcome(undefined); setModeDraft(undefined);
    controller.load(sessionKey).then(outcome => { if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') { setSnapshot(outcome.snapshot); setDraft(createReceiverConfigurationDraft(outcome.snapshot)); setPhase('READY'); } else { setSnapshot(undefined); setDraft(undefined); setPhase('ERROR'); } });
    return () => { cancelled = true; };
  }, [active, controller, reloadToken, sessionKey]);

  // P2 read-only runtime truth, in its own effect so a board that cannot
  // answer MSP_FEATURE_CONFIG still loads its editable configuration.
  useEffect(() => {
    if (!active || sessionKey === undefined || controller.readRuntime === undefined) return;
    let cancelled = false;
    controller.readRuntime(sessionKey).then(outcome => {
      if (cancelled) return;
      setRuntime(outcome.kind === 'READ' ? outcome.runtime : undefined);
    });
    return () => { cancelled = true; };
  }, [active, controller, reloadToken, runtimeToken, sessionKey]);

  /* P4. The proposed mode, and whether it actually differs from what the
     flight controller is running. Selecting the current mode again is
     not a change and must not make the page dirty. */
  const activeMode = runtime?.mode;
  const targetMode: ReceiverMode | undefined = modeDraft ?? activeMode;
  const modeChanged = modeDraft !== undefined && activeMode !== undefined && modeDraft !== activeMode;
  // Memoised so `save` keeps a stable identity: a fresh object literal
  // every render would rebuild the callback on every telemetry frame.
  const modeTarget: ReceiverModeTarget | undefined = useMemo(
    () => (modeChanged && runtime !== undefined && modeDraft !== undefined
      ? {mode: modeDraft, baseFeatureMaskRaw: runtime.featureMaskRaw}
      : undefined),
    [modeChanged, modeDraft, runtime],
  );
  /* P4-V. A SERIAL target needs a Serial RX UART, and Ports is a separate
     configuration authority - this reads its verdict and never writes it.
     Only blocking when the operator is actually PROPOSING serial: an
     aircraft already running serial with an odd port table is a state to
     report, not a reason to refuse an unrelated deadband edit. */
  const dependencyBlock = modeChanged && modeDraft === 'SERIAL' && runtime !== undefined && runtime.serialTargetDependency.kind !== 'SATISFIED'
    ? runtime.serialTargetDependency
    : undefined;
  const dirty = (snapshot !== undefined && draft !== undefined && !receiverDraftsEqual(createReceiverConfigurationDraft(snapshot), draft)) || modeChanged;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined ? [] : validateReceiverDraft(draft), [draft]);
  const update = useCallback(<K extends keyof ReceiverConfigurationDraft>(key: K, value: ReceiverConfigurationDraft[K]) => { setDraft(current => current === undefined ? current : Object.freeze({...current, [key]: value})); setSaveOutcome(undefined); }, []);
  const reload = useCallback(() => { const perform = () => setReloadToken(v => v + 1); if (!dirty) return perform(); Alert.alert(t('receiverScreen.discardTitle'), t('receiverScreen.discardBody'), [{text: t('receiverScreen.cancel'), style: 'cancel'}, {text: t('receiverScreen.reload'), style: 'destructive', onPress: perform}]); }, [dirty, t]);
  const save = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0 || dependencyBlock !== undefined) return;
    setPhase('SAVING'); setRebootOutcome(undefined);
    // ONE save authority: the mode target rides along with the same call
    // the rest of the configuration already uses.
    const outcome = await controller.save(sessionKey, snapshot, draft, modeTarget);
    setSaveOutcome(outcome);
    if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES' || outcome.kind === 'SAVED_REBOOT_REQUIRED') {
      setSnapshot(outcome.snapshot);
      setDraft(createReceiverConfigurationDraft(outcome.snapshot));
      /* P4-R. A written mode is NOT applied until the FC restarts, so the
         proposal is cleared and the mode shown falls back to freshly read
         runtime truth. Nothing here claims the new mode is in force. */
      setModeDraft(undefined);
      setRuntimeToken(value => value + 1);
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, dependencyBlock, draft, issues.length, modeTarget, sessionKey, snapshot]);
  const requestReboot = useCallback(async () => { if (sessionKey === undefined || controller.requestReboot === undefined) return; setRebootOutcome(await controller.requestReboot(sessionKey)); }, [controller, sessionKey]);

  const saveMessage = (outcome: ReceiverSaveOutcome): {text: string; warning: boolean} => {
    switch (outcome.kind) {
      case 'NO_CHANGES': return {text: t('receiverScreen.noChanges'), warning: false};
      case 'SAVED_VERIFIED': return {text: t('receiverScreen.savedVerified'), warning: false};
      // P3-S: the two evidence classes are never collapsed. FC_REPORTED
      // states the flight controller said so; EXPECTED_UNCONFIRMED only
      // says a reboot may be needed, because the flag could not be read.
      case 'SAVED_REBOOT_REQUIRED': return {
        text: outcome.evidence === 'FC_REPORTED' ? t('receiverScreen.savedRebootReported')
          /* P4-P: a mode or provider change is PROVEN to need a restart
             from firmware structure, so it gets definite wording of its
             own - never the hedged "may be needed" reserved for a flag
             that could not be read. */
          : outcome.evidence === 'STRUCTURAL_REQUIRED' ? t('receiverScreen.savedRebootStructural')
          : t('receiverScreen.savedRebootExpected'),
        warning: true,
      };
      case 'SAVED_UNVERIFIED': return {text: t('receiverScreen.savedUnverified'), warning: true};
      case 'UNCONFIRMED': return {text: t('receiverScreen.unconfirmed'), warning: true};
      case 'SESSION_ENDED': return {text: t('receiverScreen.sessionEnded'), warning: true};
      case 'FAILED': return {text: t('receiverScreen.failed'), warning: true};
      case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
      /* P4-M. Deliberately NOT worded as a failure: nothing was
         persisted, but the flight controller's RAM is no longer what it
         was, and an operator who is told "save failed" will assume
         otherwise. */
      case 'PARTIAL_UNPERSISTED': return {text: t('receiverScreen.partialUnpersisted'), warning: true};
    }
  };

  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome);
  /* P4-D. Only modes the capability matrix marks WRITABLE are offered.
     The ACTIVE mode is always present even when it is read-only, so the
     control shows the truth rather than an empty or wrong selection. */
  /* P4 CLOSURE. A control is offered only for something the CONNECTED
     build proved it can run. `selectableModes` / `selectableProviders`
     are resolved in the controller from this session's MSP_BUILD_INFO
     option list; an empty list means "nothing proven", which renders as
     read-only truth rather than as an unrestricted dropdown. */
  // Memoised on `runtime` so the derived option lists keep stable
  // identities across telemetry frames.
  const selectableModes = useMemo(() => runtime?.selectableModes ?? [], [runtime]);
  const selectableProviderValues = useMemo(() => runtime?.selectableProviders ?? [], [runtime]);
  const modeIsWritable = selectableModes.length > 0;
  const modeOptions = useMemo(
    () => selectableModes.map(mode => ({key: mode, label: t(MODE_LABEL_KEYS[mode])})),
    [selectableModes, t],
  );
  /* P4-U/I + closure. Firmware enum tokens, not invented names, and only
     the ones this build reported. */
  const providerIsWritable = selectableProviderValues.length > 0;
  const providerOptions = useMemo(
    () => selectableProviderValues.map(value => ({key: String(value), label: SERIAL_RX_NAMES[value] ?? `Provider ${value}`})),
    [selectableProviderValues],
  );
  const providerIndex = snapshot?.rx.serialRxProvider;
  const provider: string = providerIndex === undefined ? '—' : SERIAL_RX_NAMES[providerIndex] ?? `Provider ${providerIndex}`;
  const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? t('receiverScreen.failed') : loadOutcome?.kind === 'SESSION_ENDED' ? t('receiverScreen.sessionEnded') : undefined;

  return <View style={styles.root} testID="receiver-screen">
    <ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
      {/* P3-A/B: compact header. No hero card, no eyebrow, no internal
          MSP jargon and no hard-coded frequency claim. */}
      <View style={styles.header}>
        <Text style={styles.title} testID="receiver-title">{t('receiverScreen.title')}</Text>
        <Text style={styles.subtitle}>{t('receiverScreen.subtitle')}</Text>
      </View>

      <ReceiverLiveWorkspace sessionKey={sessionKey} active={active} wide={wide} />

      {loadingMessage !== undefined ? <View style={styles.warning} testID="receiver-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label={t('receiverScreen.openMotors')} onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} /> : <Button label={t('receiverScreen.reload')} onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} />}</View> : null}

      {draft !== undefined && snapshot !== undefined ? <>
        {/* P3-S/T: reboot truth, immediately after the save it belongs to. */}
        {saveOutcome?.kind === 'SAVED_REBOOT_REQUIRED' ? <View style={styles.warning} testID="receiver-reboot-required">
          <Text style={styles.warningText}>{saveMessage(saveOutcome).text}</Text>
          {rebootOutcome?.kind === 'REBOOT_REQUESTED'
            ? <Text style={styles.warningText} testID="receiver-reboot-requested">{t('receiverScreen.rebootRequested')}</Text>
            : <>
                <Text style={styles.sectionHint}>{t('receiverScreen.rebootWillDisconnect')}</Text>
                <Button label={t('receiverScreen.rebootAction')} onPress={requestReboot} variant="secondary" icon="refresh-cw" style={styles.inlineAction} testID="receiver-reboot-action" />
              </>}
        </View> : null}

        <Section title={t('receiverScreen.sourceHeading')} icon="cable" testID="receiver-source-card">
          {/* P4-S: mode editing lives HERE, in the secondary configuration
              area, never above the live workspace. */}
          {runtime !== undefined ? (
            modeIsWritable ? <View testID="receiver-mode-row">
              <SelectField
                label={t('receiverScreen.modeLabel')}
                options={selectableModes.includes(runtime.mode) ? modeOptions : [{key: runtime.mode, label: t(MODE_LABEL_KEYS[runtime.mode]), disabled: true}, ...modeOptions]}
                selectedKey={targetMode ?? runtime.mode}
                onSelect={key => setModeDraft(key as ReceiverMode)}
                disabled={phase !== 'READY'}
                helper={t('receiverScreen.modeHelper')}
                testID="receiver-mode-select"
              />
            </View> : <Row label={t('receiverScreen.modeLabel')} testID="receiver-mode-row">
              <Text style={styles.rowValue}>{t(MODE_LABEL_KEYS[runtime.mode])}</Text>
            </Row>
          ) : null}
          {/* P4-D: a mode this product cannot fully configure is stated as
              read-only rather than quietly missing from the list. */}
          {runtime !== undefined && !modeIsWritable
            ? <Text style={styles.sectionHint} testID="receiver-mode-read-only">{runtime.buildOptionsKnown ? t('receiverScreen.modeReadOnly') : t('receiverScreen.capabilityNotProven')}</Text> : null}
          {/* P4-T: a warning about losing control input, shown only while
              a mode change is actually pending. */}
          {modeChanged ? <View style={styles.warning} testID="receiver-mode-change-warning">
            <View style={styles.alertHead}><Icon name="triangle-alert" size={18} color={colors.warning} /><Text style={styles.warningText}>{t('receiverScreen.modeChangeWarning')}</Text></View>
          </View> : null}

          {/* P4-J: the serial provider is presented as an active setting
              only when the receiver the FC will run is a serial one. */}
          {targetMode === 'SERIAL' && draft !== undefined && providerIsWritable ? <>
            <SelectField
              label={t('receiverScreen.providerLabel')}
              options={providerOptions}
              selectedKey={String(draft.serialRxProvider)}
              onSelect={key => update('serialRxProvider', Number(key))}
              disabled={phase !== 'READY'}
              helper={t('receiverScreen.providerHelper')}
              testID="receiver-provider-select"
            />
            <Text style={styles.rowValue} testID="receiver-provider-value">{SERIAL_RX_NAMES[draft.serialRxProvider] ?? `Provider ${draft.serialRxProvider}`}</Text>
          </> : <Row label={t('receiverScreen.providerLabel')}>
            <Text style={styles.rowValue} testID="receiver-provider-value">{provider}</Text>
          </Row>}
          {/* P4 CLOSURE: when nothing is proven the stored provider is
              still shown as truth; only AUTHORING a new one is withheld,
              and the reason is stated rather than left as a dead control. */}
          {targetMode === 'SERIAL' && !providerIsWritable
            ? <Text style={styles.sectionHint} testID="receiver-provider-not-proven">{runtime?.buildOptionsKnown === true ? t('receiverScreen.providerNoneAvailable') : t('receiverScreen.providerNotProven')}</Text> : null}
          {/* P3-O: CRSF stays CRSF. ExpressLRS is explained as a user of
              CRSF over UART, never introduced as its own provider. */}
          {(targetMode === 'SERIAL' ? draft?.serialRxProvider : providerIndex) === CRSF_PROVIDER_INDEX && runtime?.providerMeaningful !== false
            ? <Text style={styles.sectionHint} testID="receiver-provider-note">{t('receiverScreen.providerCrsfElrs')}</Text> : null}
          {runtime !== undefined && !runtime.providerMeaningful && targetMode !== 'SERIAL'
            ? <Text style={styles.sectionHint} testID="receiver-provider-stored-only">{t('receiverScreen.providerStoredOnly')}</Text> : null}

          {/* P4-V: the dependency that blocks a serial transition, named
              rather than hidden behind a disabled button. */}
          {dependencyBlock !== undefined ? <View style={styles.warning} testID="receiver-dependency-block">
            <View style={styles.alertHead}><Icon name="triangle-alert" size={18} color={colors.warning} /><Text style={styles.warningText}>{blockMessage(dependencyBlock.kind)}</Text></View>
          </View> : null}
          {runtime !== undefined ? <PortDependencyNote dependency={runtime.portDependency} /> : null}
          <Button label={t('receiverScreen.openPorts')} onPress={onOpenPorts} variant="secondary" icon="cable" style={styles.inlineAction} />
        </Section>

        {/* P3-N: the current value is a labelled field; presets are clearly
            separate actions, not three identical-looking pills. */}
        <Section title={t('receiverScreen.mapHeading')} icon="sliders-horizontal" testID="receiver-map-card">
          <Text style={styles.fieldLabel}>{t('receiverScreen.mapLabel')}</Text>
          <TextInput value={draft.channelMapText} editable={phase === 'READY'} autoCapitalize="characters" maxLength={8} onChangeText={v => update('channelMapText', v.toUpperCase())} style={[styles.mapInput, issues.includes('CHANNEL_MAP_INVALID') && styles.invalidInput]} accessibilityLabel={t('receiverScreen.mapLabel')} testID="receiver-channel-map" />
          <Text style={styles.sectionHint}>{t('receiverScreen.mapHint')}</Text>
          <Text style={styles.fieldLabel}>{t('receiverScreen.mapPresets')}</Text>
          <View style={styles.presetRow}>
            <Button label="AETR1234" onPress={() => update('channelMapText', 'AETR1234')} variant="secondary" />
            <Button label="TAER1234" onPress={() => update('channelMapText', 'TAER1234')} variant="secondary" />
          </View>
        </Section>

        <Section title={t('receiverScreen.rangeHeading')} icon="gauge" testID="receiver-range-card">
          <Text style={styles.sectionHint}>{t('receiverScreen.rangeHint')}</Text>
          <View style={styles.fieldsGrid}>
            <NumericField label={t('receiverScreen.stickMin')} value={draft.stickMin} min={1000} max={1200} disabled={phase !== 'READY'} onChange={v => update('stickMin', v)} testID="receiver-stick-min" />
            <NumericField label={t('receiverScreen.stickCenter')} value={draft.stickCenter} min={1401} max={1599} disabled={phase !== 'READY'} onChange={v => update('stickCenter', v)} testID="receiver-stick-center" />
            <NumericField label={t('receiverScreen.stickMax')} value={draft.stickMax} min={1800} max={2000} disabled={phase !== 'READY'} onChange={v => update('stickMax', v)} testID="receiver-stick-max" />
            <RssiChannelField value={draft.rssiChannel} disabled={phase !== 'READY'} onChange={v => update('rssiChannel', v)} />
          </View>
        </Section>

        <Section title={t('receiverScreen.deadbandHeading')} icon="crosshair" testID="receiver-deadband-card">
          <Text style={styles.sectionHint}>{t('receiverScreen.deadbandHint')}</Text>
          <View style={styles.fieldsGrid}>
            <NumericField label={t('receiverScreen.deadbandRollPitch')} value={draft.deadband} min={0} max={32} disabled={phase !== 'READY'} onChange={v => update('deadband', v)} testID="receiver-deadband" />
            <NumericField label={t('receiverScreen.deadbandYaw')} value={draft.yawDeadband} min={0} max={100} disabled={phase !== 'READY'} onChange={v => update('yawDeadband', v)} testID="receiver-yaw-deadband" />
            {/* P3-L: "الخانق في وضع 3D" is composed as isolated runs so the
                Latin "3D" cannot be torn apart by bidi reordering. */}
            <NumericField label={t('receiverScreen.deadband3d')} value={draft.throttle3dDeadband} min={0} max={100} disabled={phase !== 'READY'} onChange={v => update('throttle3dDeadband', v)} testID="receiver-3d-deadband" />
          </View>
        </Section>

        <Section title={t('receiverScreen.smoothingHeading')} icon="activity" testID="receiver-smoothing-card">
          <View style={styles.toggleRow}>
            {/* P3-AE: one group-level note, not a warning on every field. */}
            <Text style={[styles.sectionHint, styles.flexOne]}>{t('receiverScreen.smoothingHint')}</Text>
            <ToggleSwitch value={draft.smoothingEnabled} disabled={phase !== 'READY'} onValueChange={v => update('smoothingEnabled', v)} accessibilityLabel={t('receiverScreen.smoothingHeading')} testID="receiver-smoothing" />
          </View>
          {draft.smoothingEnabled ? <View style={styles.fieldsGrid}>
            <NumericField label={t('receiverScreen.smoothingSetpointCutoff')} value={draft.setpointCutoff} min={0} max={255} disabled={phase !== 'READY'} onChange={v => update('setpointCutoff', v)} testID="receiver-setpoint-cutoff" />
            <NumericField label={t('receiverScreen.smoothingThrottleCutoff')} value={draft.throttleCutoff} min={0} max={255} disabled={phase !== 'READY'} onChange={v => update('throttleCutoff', v)} testID="receiver-throttle-cutoff" />
            <NumericField label={t('receiverScreen.smoothingSetpointFactor')} value={draft.setpointAutoFactor} min={0} max={250} disabled={phase !== 'READY'} onChange={v => update('setpointAutoFactor', v)} testID="receiver-setpoint-factor" />
            <NumericField label={t('receiverScreen.smoothingThrottleFactor')} value={draft.throttleAutoFactor} min={0} max={250} disabled={phase !== 'READY'} onChange={v => update('throttleAutoFactor', v)} testID="receiver-throttle-factor" />
          </View> : null}
        </Section>

        {issues.length > 0 ? <View style={styles.danger}><Text style={styles.dangerTitle}>{t('receiverScreen.invalidValues')}</Text><Text style={styles.dangerText}>{issues.join(' · ')}</Text></View> : null}
        {statusCopy !== undefined && saveOutcome?.kind !== 'SAVED_REBOOT_REQUIRED' ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
      </> : phase === 'LOADING' ? <Text style={styles.loading}>{t('receiverScreen.loading')}</Text> : null}
      <View style={styles.bottomSpace} />
    </ScrollView>
    <StickyActionBar visible={dirty} summary={t('receiverScreen.saveSummary')} details={[t('receiverScreen.saveDetails')]} saveLabel={t('receiverScreen.saveLabel')} discardLabel={t('receiverScreen.discardLabel')} onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createReceiverConfigurationDraft(snapshot))} disabledReason={issues.length > 0 ? t('receiverScreen.blockInvalid') : dependencyBlock !== undefined ? blockMessage(dependencyBlock.kind) : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel={t('receiverScreen.saveLabel')} testID="receiver-save-bar" />
  </View>;
}

const MODE_LABEL_KEYS: Record<ReceiverMode, string> = {
  SERIAL: 'receiverScreen.modeSerial',
  PPM: 'receiverScreen.modePpm',
  PARALLEL_PWM: 'receiverScreen.modeParallelPwm',
  MSP: 'receiverScreen.modeMsp',
  SPI: 'receiverScreen.modeSpi',
  NONE: 'receiverScreen.modeNone',
};

const SIGNAL_TITLE_KEYS: Record<ReceiverSignalState['kind'], string> = {
  LIVE: 'receiverScreen.liveLive',
  RX_LOSS: 'receiverScreen.failsafeRxLoss',
  FAILSAFE_ACTIVE: 'receiverScreen.failsafeActive',
  BOXFAILSAFE_ACTIVE: 'receiverScreen.failsafeBox',
  UNKNOWN: 'receiverScreen.failsafeUnknown',
};

/**
 * P3-D: the live workspace - the primary content of this screen, placed
 * directly under the compact header so a pilot sees real values without
 * scrolling past configuration.
 */
const ReceiverLiveWorkspace = React.memo(function ReceiverLiveWorkspaceContent({sessionKey, active, wide}: {sessionKey?: SetupUiSessionKey; active: boolean; wide: boolean}) {
  const {t} = useTranslation();
  const sessionId = sessionKey?.sessionId ?? '';
  const channelsState = useTelemetryValue<MspRcChannels>(sessionId, RECEIVER_CHANNELS_POLL_ID, active);
  const analogState = useTelemetryValue<MspAnalog>(sessionId, RECEIVER_TELEMETRY_POLL_ID, active);
  const statusState = useTelemetryValue<MspStatusExDiagnostics>(sessionId, FC_STATUS_TELEMETRY_POLL_ID, active);
  useEffect(() => { if (active && sessionKey !== undefined) return acquireReceiverTelemetry(sessionKey); }, [active, sessionKey]);

  const channels = valueOf(channelsState)?.channels ?? [];
  const analog = valueOf(analogState);
  const rssi = analog === undefined ? undefined : deriveReceiverRssi(analog);
  const signal = resolveReceiverSignalState(valueOf(statusState)?.readiness.armingDisableFlags);
  const failsafe = receiverValuesMayBeFailsafeOutput(signal);
  const fresh = channelsState.status === 'FRESH' && channels.length > 0;
  const stale = channelsState.status === 'STALE';
  const positions = useSmoothedChannelPositions(channels, !stale);

  // P3-C: the rate is MEASURED, from delivered samples, or not shown.
  // Only quoted while genuinely fresh - a stale link must not keep
  // advertising the cadence it used to have.
  const observedHz = fresh ? getReceiverObservedRateHz(sessionId) : undefined;

  const liveLabel = fresh ? t('receiverScreen.liveLive') : stale ? t('receiverScreen.liveStale') : channels.length > 0 ? t('receiverScreen.liveDisconnected') : t('receiverScreen.liveWaiting');

  return <View style={styles.workspace} testID="receiver-live-monitor">
    {/* P3-I: one compact status strip - live/stale/waiting are visually
        distinct, and never all collapsed into a single grey badge. */}
    <View style={styles.statusStrip} testID="receiver-status-strip">
      <View style={[styles.statusPill, fresh ? styles.statusPillLive : stale ? styles.statusPillStale : styles.statusPillIdle]}>
        <View style={[styles.statusDot, fresh && styles.statusDotLive, stale && styles.statusDotStale]} />
        <Text style={styles.statusPillText} testID="receiver-live-label">{liveLabel}</Text>
      </View>
      <View style={styles.statusMetric}>
        <Text style={styles.statusMetricLabel}>{t('receiverScreen.rateLabel')}</Text>
        <Text style={styles.statusMetricValue} testID="receiver-observed-rate">{observedHz === undefined ? t('receiverScreen.rateUnavailable') : `${observedHz} Hz`}</Text>
      </View>
      <View style={styles.statusMetric}>
        <Text style={styles.statusMetricLabel}>{t('receiverScreen.channelsCount')}</Text>
        <Text style={styles.statusMetricValue} testID="receiver-channel-count">{channels.length > 0 ? String(channels.length) : '—'}</Text>
      </View>
      <View style={styles.statusMetric}>
        <Text style={styles.statusMetricLabel}>{t('receiverScreen.rssiLabel')}</Text>
        <Text style={styles.statusMetricValue} testID="receiver-rssi-value">{rssi?.kind === 'PERCENT' ? `${rssi.percent}%` : t('receiverScreen.rssiUnavailable')}</Text>
      </View>
    </View>

    {/* P3-H: failsafe is named by cause, and never hides the values. */}
    {failsafe ? <View style={styles.danger} testID="receiver-signal-alert">
      <View style={styles.alertHead}><Icon name="triangle-alert" size={18} color={colors.error} /><Text style={styles.dangerTitle}>{t(SIGNAL_TITLE_KEYS[signal.kind])}</Text></View>
      <Text style={styles.dangerText}>{t('receiverScreen.failsafeDetail')}</Text>
    </View> : null}

    <View style={[styles.workspaceRow, wide && styles.workspaceRowWide]}>
      <View style={[styles.card, styles.channelsCard, wide && styles.channelsCardWide]} testID="receiver-channels-card">
        <Text style={styles.sectionTitle}>{t('receiverScreen.liveHeading')}</Text>
        {channels.length === 0
          ? <Text style={styles.emptyText}>{t('receiverScreen.emptyChannels')}</Text>
          : <>
              {channels.slice(0, 4).map((value, index) => <ChannelRow key={index} index={index} value={value} primary stale={stale} position={positions[index]} />)}
              {channels.length > 4 ? <View style={[styles.auxGrid, wide && styles.auxGridWide]}>
                {channels.slice(4).map((value, index) => <ChannelRow key={index + 4} index={index + 4} value={value} primary={false} stale={stale} position={positions[index + 4]} />)}
              </View> : null}
            </>}
      </View>

      {/* P3-K: the stick preview is SECONDARY - beside the channels on
          wide layouts, below them on mobile, and never larger than them. */}
      <View style={[styles.card, styles.sticksCard, wide && styles.sticksCardWide]} testID="receiver-sticks-card">
        <Text style={styles.sectionTitle}>{t('receiverScreen.sticksHeading')}</Text>
        <View style={styles.sticksRow}>
          <StickPad horizontal={channels[2]} vertical={channels[3]} horizontalPosition={positions[2]} verticalPosition={positions[3]} horizontalLabel={t('receiverScreen.axisYaw')} verticalLabel={t('receiverScreen.axisThrottle')} testID="receiver-stick-left" />
          <StickPad horizontal={channels[0]} vertical={channels[1]} horizontalPosition={positions[0]} verticalPosition={positions[1]} horizontalLabel={t('receiverScreen.axisRoll')} verticalLabel={t('receiverScreen.axisPitch')} testID="receiver-stick-right" />
        </View>
        <Text style={styles.sectionHint}>{t('receiverScreen.hardwareNotice')}</Text>
      </View>
    </View>
  </View>;
});

const PRIMARY_AXIS_KEYS = ['receiverScreen.axisRoll', 'receiverScreen.axisPitch', 'receiverScreen.axisYaw', 'receiverScreen.axisThrottle'];

/**
 * P3-E/F/G: one live channel. The exact delivered integer is the loudest
 * element in the row; the bar is the supporting visualisation.
 */
/**
 * RECEIVER LIVE LATENCY P2: the fill is a FULL-WIDTH layer scaled on the
 * X axis, not a layer whose `width` is animated.
 *
 * WHY. `width` is a layout property, and React Native's native animated
 * driver supports only `opacity` and `transform`. Animating `width`
 * therefore FORCES `useNativeDriver: false`, which makes every animation
 * frame depend on the JavaScript execution path - the same path that is
 * already servicing a 25Hz MSP_RC stream and React on the device. Phase 1
 * eliminated the wire, the scheduler, the decoder, precision and sample
 * backlog as causes of the operator's reported lag, leaving JS-driven
 * layout animation as the remaining candidate. `scaleX` is
 * native-driver-capable and carries exactly the same geometry.
 *
 * ANCHORING. A transform scales about the node's CENTRE, so `scaleX(f)`
 * alone would shrink the bar toward the middle and grow it in both
 * directions. The fill is re-anchored to the track's START edge by
 * pairing the scale with a translation of half the removed width:
 *
 *     translateX = -(W / 2) * (1 - f)      (LTR: start edge is the left)
 *     translateX = +(W / 2) * (1 - f)      (RTL: start edge is the right)
 *
 * Both are LINEAR in f, so each is a plain numeric interpolation of the
 * same Animated.Value - no second node, and nothing that would disqualify
 * the native driver. W comes from one onLayout on the track (the track is
 * `flex: 1`, so its width is only known after layout); layout is measured
 * when the row is laid out, never per sample and never per frame. Before
 * the first layout W is 0, at which point the fill has no width to show
 * anyway, so there is no incorrect intermediate frame.
 */
function ChannelRow({index, value, primary, stale, position}: {index: number; value: number; primary: boolean; stale: boolean; position: Animated.Value}) {
  const {t} = useTranslation();
  const label = primary ? t(PRIMARY_AXIS_KEYS[index]) : `AUX ${index - 3}`;
  const [trackWidth, setTrackWidth] = useState(0);
  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setTrackWidth(previous => (Math.abs(previous - next) < 0.5 ? previous : next));
  }, []);
  // The physical start edge. A transform is physical and is NOT mirrored
  // by RTL, so the anchor sign is chosen explicitly rather than inherited.
  const anchorSign = I18nManager.isRTL ? 1 : -1;
  const translateX = useMemo(
    () => position.interpolate({inputRange: [0, 1], outputRange: [(anchorSign * trackWidth) / 2, 0]}),
    [position, trackWidth, anchorSign],
  );
  return <View style={[styles.channelRow, primary ? styles.channelRowPrimary : styles.channelRowAux]} testID={`receiver-channel-${index + 1}`} accessible accessibilityLabel={`${label}: ${value}`}>
    <Text style={primary ? styles.channelNamePrimary : styles.channelName} numberOfLines={1}>{label}</Text>
    <View style={styles.channelTrack} onLayout={handleTrackLayout}>
      {/* P3-G: a short ease follows real samples. It carries no data of
          its own and is dropped when the samples stop being fresh, so it
          can never imply motion that is not arriving. */}
      <Animated.View style={[styles.channelFill, stale && styles.channelFillStale, {transform: [{translateX}, {scaleX: position}]}]} testID={`receiver-channel-${index + 1}-fill`} />
      <View style={styles.channelCenter} />
    </View>
    <Text style={primary ? styles.channelValuePrimary : styles.channelValue}>{value}</Text>
  </View>;
}

/**
 * P3-J: a PHYSICAL control diagram. Its axes are deliberately NOT
 * mirrored with the surrounding RTL text - right stick right is right on
 * the transmitter regardless of the language the labels are written in -
 * so the pad is forced to an LTR coordinate system while its Arabic
 * labels stay in the page's RTL flow.
 *
 * Uses the SAME channelDisplayFraction as the bars, so one sample cannot
 * sit at two different positions in two views of the same channel - and
 * for the same reason the SAME ease, since a dot that jumped while the
 * bars glided would break that agreement for up to one smoothing window.
 */
function StickPad({horizontal, vertical, horizontalPosition, verticalPosition, horizontalLabel, verticalLabel, testID}: {horizontal?: number; vertical?: number; horizontalPosition: Animated.Value; verticalPosition: Animated.Value; horizontalLabel: string; verticalLabel: string; testID: string}) {
  const hasSample = horizontal !== undefined && vertical !== undefined;
  // RECEIVER LIVE LATENCY P2: translate, not left/top. `left` and `top`
  // are layout properties and cannot be native-driven; translateX/Y can,
  // and describe the same motion in pixels over the pad's fixed travel.
  const translateX = useMemo(
    () => horizontalPosition.interpolate({inputRange: [0, 1], outputRange: [stickDotTranslateX(0), stickDotTranslateX(1)]}),
    [horizontalPosition],
  );
  // Screen coordinates grow downward, stick travel grows upward: the SAME
  // node, read in the opposite direction, so no second value can drift.
  const translateY = useMemo(
    () => verticalPosition.interpolate({inputRange: [0, 1], outputRange: [stickDotTranslateY(0), stickDotTranslateY(1)]}),
    [verticalPosition],
  );
  return <View style={styles.stickWrap} testID={testID}>
    <View style={styles.stickPad}>
      <View style={styles.crossH} /><View style={styles.crossV} />
      {hasSample ? <Animated.View style={[styles.stickDot, {transform: [{translateX}, {translateY}]}]} testID={`${testID}-position`} /> : null}
    </View>
    {/* Each label/value pair is its own isolated run so the Latin values
        cannot be reordered into the Arabic text around them. */}
    <View style={styles.stickLabelRow}>
      <Text style={styles.stickLabel}>{horizontalLabel}</Text>
      <Text style={styles.stickLabelValue}>{horizontal ?? '—'}</Text>
      <Text style={styles.stickLabel}>{verticalLabel}</Text>
      <Text style={styles.stickLabelValue}>{vertical ?? '—'}</Text>
    </View>
  </View>;
}

function PortDependencyNote({dependency}: {dependency: ReceiverPortDependency}) {
  const {t} = useTranslation();
  if (dependency.kind === 'NOT_APPLICABLE') return null;
  const key = dependency.kind === 'SERIAL_RX_READY' ? 'receiverScreen.portReady'
    : dependency.kind === 'SERIAL_RX_UART_MISSING' ? 'receiverScreen.portMissing'
    : dependency.kind === 'MULTIPLE_SERIAL_RX_ASSIGNMENTS' ? 'receiverScreen.portMultiple'
    : 'receiverScreen.portUnknown';
  const warn = dependency.kind !== 'SERIAL_RX_READY';
  return <View testID="receiver-port-status">
    <Text style={warn ? styles.warningText : styles.sectionHint}>{t(key)}</Text>
    {/* A configured UART is not proof of a connected receiver. */}
    {dependency.kind === 'SERIAL_RX_READY' ? <Text style={styles.sectionHint}>{t('receiverScreen.portNotProof')}</Text> : null}
  </View>;
}

function Section({title, icon, testID, children}: {title: string; icon: IconName; testID: string; children: React.ReactNode}) {
  return <View style={styles.card} testID={testID}>
    <View style={styles.sectionHead}><Icon name={icon} size={18} color={colors.accentStrong} /><Text style={styles.sectionTitle}>{title}</Text></View>
    {children}
  </View>;
}

function Row({label, testID, children}: {label: string; testID?: string; children: React.ReactNode}) {
  return <View style={styles.row} testID={testID}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

function NumericField({label, value, min, max, disabled, onChange, testID}: {label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  return (
    <View style={styles.numericField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <SharedStepper value={String(value)} onDecrement={() => onChange(Math.max(min, value - 1))} onIncrement={() => onChange(Math.min(max, value + 1))} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} onChangeText={text => {const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));}} accessibilityLabel={label} testID={testID} />
      {/* P3-L: a numeric range is its own isolated LTR run. Written as a
          single Text with an explicit ltr direction it can no longer be
          reordered into "18-5" by the surrounding Arabic. */}
      <Text style={styles.rangeBounds}>{`${min}–${max}`}</Text>
    </View>
  );
}

function RssiChannelField({value, disabled, onChange}: {value: number; disabled: boolean; onChange: (value: number) => void}) {
  const {t} = useTranslation();
  return <View style={styles.numericField}>
    <Text style={styles.fieldLabel}>{t('receiverScreen.rssiChannel')}</Text>
    {/* Stepping is deliberately NOT linear: 0 means "disabled", and the
        first real channel is 5, so decrementing from 5 jumps to 0. */}
    <SharedStepper
      value={String(value)}
      onDecrement={() => onChange(value <= 5 ? 0 : value - 1)}
      onIncrement={() => onChange(value === 0 ? 5 : Math.min(RECEIVER_CHANNEL_MAX_COUNT, value + 1))}
      decrementDisabled={value === 0}
      incrementDisabled={value >= RECEIVER_CHANNEL_MAX_COUNT}
      disabled={disabled}
      onChangeText={text => { const parsed = Number(text.replace(/[^0-9]/g, '')); if (Number.isFinite(parsed)) onChange(parsed); }}
      accessibilityLabel={t('receiverScreen.rssiChannel')}
      testID="receiver-rssi-channel"
      decrementTestID="receiver-rssi-channel-minus"
      incrementTestID="receiver-rssi-channel-plus"
    />
    <Text style={styles.rangeHint}>{t('receiverScreen.rssiChannelHint')}</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md},
  header: {gap: 2},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {...typography.caption, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},

  workspace: {gap: spacing.sm},
  statusStrip: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, paddingVertical: spacing.sm, paddingHorizontal: spacing.md},
  statusPill: {flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1},
  statusPillLive: {backgroundColor: colors.successSoft, borderColor: colors.success},
  statusPillStale: {backgroundColor: colors.warningSoft, borderColor: colors.warning},
  statusPillIdle: {backgroundColor: colors.surfaceAlt, borderColor: colors.border},
  statusDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: colors.disabled},
  statusDotLive: {backgroundColor: colors.success},
  statusDotStale: {backgroundColor: colors.warning},
  statusPillText: {...typography.caption, color: colors.textPrimary, fontWeight: '700', maxWidth: PROSE_MEASURE},
  statusMetric: {alignItems: 'flex-end', gap: 1},
  statusMetricLabel: {...typography.caption, color: colors.textMuted, maxWidth: PROSE_MEASURE},
  statusMetricValue: {...typography.label, color: colors.textPrimary, fontWeight: '700', fontVariant: ['tabular-nums']},

  workspaceRow: {gap: spacing.md},
  workspaceRowWide: {flexDirection: 'row', alignItems: 'flex-start'},
  card: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm},
  // P3-AA: content-sized in column layout; proportional only side by side,
  // and the channels column always gets the larger share.
  channelsCard: {gap: 6},
  sticksCard: {gap: spacing.sm},
  // P1-M contract, preserved: `flex: N` is flex-grow with flex-basis 0, so
  // it may only be applied in the side-by-side ROW layout. In the column
  // layout both cards size to their content and cannot clip a channel.
  // Channels get the larger share - live data leads, sticks support.
  channelsCardWide: {flex: 3},
  sticksCardWide: {flex: 2},
  sectionHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'},
  sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  alertHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},

  channelRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  channelRowPrimary: {paddingVertical: 5},
  channelRowAux: {paddingVertical: 2},
  auxGrid: {gap: 2, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingTop: spacing.sm},
  auxGridWide: {flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.lg},
  // P3-M: labels follow the page's RTL flow rather than being pinned left.
  channelName: {...typography.caption, color: colors.textSecondary, width: 62, textAlign: 'right'},
  channelNamePrimary: {...typography.label, color: colors.textPrimary, fontWeight: '700', width: 62, textAlign: 'right'},
  channelTrack: {height: 14, flex: 1, minWidth: 80, borderRadius: 7, backgroundColor: colors.backgroundRaised, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft},
  /* Full width, scaled on X. See ChannelRow: `width` is a layout
     property and cannot be native-driven, `scaleX` can. */
  channelFill: {height: '100%', width: '100%', backgroundColor: colors.accent},
  channelFillStale: {backgroundColor: colors.disabled},
  channelCenter: {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, backgroundColor: colors.accentStrong},
  // P3-E: the delivered value is a prominent, tabular figure - never the
  // smallest text on the screen.
  channelValue: {...typography.label, color: colors.textPrimary, width: 52, textAlign: 'right', fontVariant: ['tabular-nums']},
  channelValuePrimary: {...typography.heading, color: colors.textPrimary, width: 52, textAlign: 'right', fontVariant: ['tabular-nums']},
  emptyText: {...typography.body, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE},

  sticksRow: {flexDirection: 'row', justifyContent: 'center', gap: spacing.md, flexWrap: 'wrap'},
  stickWrap: {alignItems: 'center', gap: 5},
  /* A physical control diagram must not mirror with the text, and the
     two platforms need opposite treatment to achieve that.

     NATIVE: Yoga swaps the `left`/`right` edges inside an RTL subtree
     (I18nManager.doLeftAndRightSwapInRTL is true by default and the app
     calls forceRTL in App.tsx), so without pinning this subtree to LTR
     the stick dot would land on the wrong side on Android.

     WEB: react-native-web has no such swap - its I18nManager is a no-op
     stub, and CSS `left` on an absolutely positioned box is physical
     whatever `direction` says - and it REJECTS `direction` outright,
     logging "Invalid style property" for a rule it then discards. So the
     pin is applied where it does something and omitted where it is only
     noise. Proven on both sides: ReceiverScreenContract asserts the
     native pin, ReceiverScreen.web asserts the web render emits no
     dropped-style error and positions the dot physically. */
  stickPad: {width: STICK_PAD_SIZE, height: STICK_PAD_SIZE, borderRadius: radii.md, borderWidth: STICK_PAD_BORDER, borderColor: colors.border, backgroundColor: colors.backgroundRaised, overflow: 'hidden', ...(Platform.OS === 'web' ? null : {direction: 'ltr' as const})},
  crossH: {position: 'absolute', left: 0, right: 0, top: '50%', height: 1, backgroundColor: colors.border},
  crossV: {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, backgroundColor: colors.border},
  /* Pinned at the pad origin and moved by transform. The negative
     margins keep the DOT'S CENTRE on the origin, exactly as the previous
     left/top percentage positioning did, so the travel and the clipping
     at the pad edges are unchanged. */
  stickDot: {position: 'absolute', left: 0, top: 0, width: STICK_DOT_SIZE, height: STICK_DOT_SIZE, borderRadius: STICK_DOT_SIZE / 2, marginLeft: -STICK_DOT_SIZE / 2, marginTop: -STICK_DOT_SIZE / 2, backgroundColor: colors.accentStrong, borderWidth: 2, borderColor: colors.accent},
  stickLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap', justifyContent: 'center'},
  stickLabel: {...typography.caption, color: colors.textMuted},
  stickLabelValue: {...typography.caption, color: colors.textPrimary, fontWeight: '700', fontVariant: ['tabular-nums']},

  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap'},
  rowValue: {...typography.heading, color: colors.accentStrong, fontVariant: ['tabular-nums']},
  fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  mapInput: {minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.backgroundRaised, color: colors.textPrimary, paddingHorizontal: spacing.md, textAlign: 'center', fontWeight: '700', letterSpacing: 3},
  invalidInput: {borderColor: colors.error, borderWidth: 2},
  presetRow: {flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap'},
  fieldsGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md},
  numericField: {flexGrow: 1, flexBasis: 180, gap: 5},
  /* A numeric span - "1000–2000". Explicitly ltr so the surrounding
     Arabic cannot reorder it into "2000–1000". */
  rangeBounds: {...typography.caption, color: colors.textMuted, textAlign: 'center', writingDirection: 'ltr'},
  /* Arabic prose, and it used to carry the ltr above by sharing a style
     with the numeric span. That made the browser lay the sentence out
     left-to-right-first, so "صفر للتعطيل، أو قناة AUX." painted its
     Latin word ahead of the Arabic that introduces it. */
  rangeHint: {...typography.caption, color: colors.textMuted, textAlign: 'center', writingDirection: 'rtl'},
  toggleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md},
  flexOne: {flex: 1},

  warning: {...noticeSurface, borderColor: colors.warning, backgroundColor: colors.warningSoft, gap: spacing.sm},
  warningText: {...typography.caption, color: colors.warning, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  danger: {...noticeSurface, borderColor: colors.error, backgroundColor: colors.errorSoft, gap: 3},
  dangerTitle: {...typography.caption, fontWeight: '700', color: colors.error, textAlign: 'right', maxWidth: PROSE_MEASURE},
  dangerText: {...typography.caption, color: colors.error, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  success: {...noticeSurface, borderColor: colors.success, backgroundColor: colors.successSoft},
  successText: {...typography.caption, color: colors.success, textAlign: 'right', maxWidth: PROSE_MEASURE},
  inlineAction: {alignSelf: 'flex-start'},
  loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl},
  bottomSpace: {height: spacing.xl},
});
