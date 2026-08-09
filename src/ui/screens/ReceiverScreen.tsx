import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {
  createReceiverConfigurationDraft, deriveReceiverRssi, receiverDraftsEqual,
  validateReceiverDraft, RECEIVER_CHANNEL_MAX_COUNT, type MspAnalog, type MspRcChannels,
  type MspStatusExDiagnostics, type ReceiverConfigurationDraft,
  type ReceiverConfigurationSnapshot, type TelemetryValue,
} from '../../core';
import {
  FC_STATUS_TELEMETRY_POLL_ID, RECEIVER_CHANNELS_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID, acquireReceiverTelemetry,
  receiverConfigurationController, useTelemetryValue,
  type ReceiverBlockReason, type ReceiverLoadOutcome, type ReceiverSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {StickyActionBar} from '../components/editing';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, Stepper as SharedStepper, ToggleSwitch} from '../components/controls';

export interface ReceiverControllerPort {
  load(key: SetupUiSessionKey): Promise<ReceiverLoadOutcome>;
  save(key: SetupUiSessionKey, original: ReceiverConfigurationSnapshot, draft: ReceiverConfigurationDraft): Promise<ReceiverSaveOutcome>;
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
const SERIAL_RX_NAMES = Object.freeze(['NONE', 'SPEKTRUM2048', 'SBUS', 'SUMD', 'SUMH', 'XBUS_MODE_B', 'XBUS_MODE_B_RJ01', 'IBUS', 'JETIEXBUS', 'CRSF', 'SPEKTRUM2048/SRXL', 'TARGET_CUSTOM', 'FPORT', 'SPEKTRUM SRXL2', 'IRC GHOST', 'SPEKTRUM1024', 'MAVLINK']);

function valueOf<T>(value: TelemetryValue<T>): T | undefined { return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined; }
function blockMessage(reason: ReceiverBlockReason): string {
  return ({
    DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.',
    IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.',
    UNSUPPORTED_FIRMWARE: 'تتطلب هذه الشاشة Betaflight مع MSP API 1.47.',
    APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل القراءة أو الحفظ.',
    LINK_RECOVERING: 'الرابط التسلسلي يتعافى. انتظر قليلًا ثم أعد القراءة.',
    FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران ARMED. انزع المراوح ثم افصل التسليح.',
    ARMED_STATE_UNKNOWN: 'تعذر إثبات أن متحكم الطيران DISARMED؛ لم تُرسل الإعدادات.',
    MOTOR_TEST_ACTIVE: 'جلسة اختبار المحركات نشطة. افتح المحركات واضغط «إنهاء جلسة الاختبار» ثم أعد القراءة.',
    CONFIGURATION_BUSY: 'توجد معاملة إعدادات أخرى قيد التنفيذ.',
    STALE_BASE: 'تغيرت إعدادات المستقبل في المتحكم. أعد القراءة وراجع القيم.',
    INVALID_CONFIGURATION: 'توجد قيمة غير صالحة. راجع الحقول قبل الحفظ.',
  } as Record<ReceiverBlockReason, string>)[reason];
}
function saveMessage(outcome: ReceiverSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES': return {text: 'لا توجد تغييرات لإرسالها.', warning: false};
    case 'SAVED_VERIFIED': return {text: 'حُفظت إعدادات المستقبل وتطابقت إعادة القراءة من متحكم الطيران.', warning: false};
    case 'SAVED_UNVERIFIED': return {text: 'أقرّ المتحكم الحفظ، لكن تعذرت إعادة القراءة التحققية. أعد الاتصال قبل أي محاولة أخرى.', warning: true};
    case 'UNCONFIRMED': return {text: `نتيجة الكتابة غير مؤكدة عند مرحلة ${outcome.stage}. لا تكرر الحفظ؛ أعد الاتصال واقرأ القيم أولًا.`, warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت الجلسة أثناء العملية. أعد الاتصال واقرأ القيم.', warning: true};
    case 'FAILED': return {text: 'فشلت العملية قبل اكتمال التحقق.', warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
  }
}

function NumericField({label, value, min, max, disabled, onChange, testID}: {label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  return (
    <View style={styles.numericField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <SharedStepper value={String(value)} onDecrement={() => onChange(Math.max(min, value - 1))} onIncrement={() => onChange(Math.min(max, value + 1))} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} onChangeText={text => {const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));}} accessibilityLabel={label} testID={testID} />
      <Text style={styles.rangeHint}>{min}–{max}</Text>
    </View>
  );
}
function RssiChannelField({value, disabled, onChange}: {value: number; disabled: boolean; onChange: (value: number) => void}) {
  return <View style={styles.numericField}>
    <Text style={styles.fieldLabel}>قناة RSSI (0 أو AUX 5–18)</Text>
    {/* Stepping is deliberately NOT linear: 0 means "disabled", and the
        first real channel is 5, so decrementing from 5 jumps to 0 rather
        than walking through 4..1. That rule is unchanged - only the
        control surface is now the shared one. */}
    <SharedStepper
      value={String(value)}
      onDecrement={() => onChange(value <= 5 ? 0 : value - 1)}
      onIncrement={() => onChange(value === 0 ? 5 : Math.min(RECEIVER_CHANNEL_MAX_COUNT, value + 1))}
      decrementDisabled={value === 0}
      incrementDisabled={value >= RECEIVER_CHANNEL_MAX_COUNT}
      disabled={disabled}
      onChangeText={text => { const parsed = Number(text.replace(/[^0-9]/g, '')); if (Number.isFinite(parsed)) onChange(parsed); }}
      accessibilityLabel="قناة RSSI"
      testID="receiver-rssi-channel"
      decrementTestID="receiver-rssi-channel-minus"
      incrementTestID="receiver-rssi-channel-plus"
    />
    <Text style={styles.rangeHint}>0 للتعطيل · 5–18 لقنوات AUX</Text>
  </View>;
}

function StickPad({horizontal, vertical, horizontalLabel, verticalLabel, testID}: {horizontal?: number; vertical?: number; horizontalLabel: string; verticalLabel: string; testID: string}) {
  const hasSample = horizontal !== undefined && vertical !== undefined;
  const x = Math.max(0, Math.min(100, (((horizontal ?? 1000) - 1000) / 1000) * 100));
  const y = 100 - Math.max(0, Math.min(100, (((vertical ?? 1000) - 1000) / 1000) * 100));
  return <View style={styles.stickWrap} testID={testID}>
    <View style={styles.stickPad}><View style={styles.crossH} /><View style={styles.crossV} />{hasSample ? <View style={[styles.stickDot, {left: `${x}%`, top: `${y}%`}]} testID={`${testID}-position`} /> : null}</View>
    <Text style={styles.stickLabel}>{horizontalLabel}: {horizontal ?? '—'} · {verticalLabel}: {vertical ?? '—'}</Text>
  </View>;
}

function ChannelBar({index, value}: {index: number; value: number}) {
  const label = ['Roll', 'Pitch', 'Yaw', 'Throttle'][index] ?? `AUX ${index - 3}`;
  const percent = Math.max(0, Math.min(100, ((value - 800) / 1400) * 100));
  return <View style={styles.channelRow} testID={`receiver-channel-${index + 1}`}><Text style={styles.channelName}>{label}</Text><View style={styles.channelTrack}><View style={[styles.channelFill, {width: `${percent}%`}]} /><View style={styles.channelCenter} /></View><Text style={styles.channelValue}>{value}</Text></View>;
}

const ReceiverLiveMonitor = React.memo(function ReceiverLiveMonitorContent({sessionKey, active, wide}: {sessionKey?: SetupUiSessionKey; active: boolean; wide: boolean}) {
  const sessionId = sessionKey?.sessionId ?? '';
  const channelsState = useTelemetryValue<MspRcChannels>(sessionId, RECEIVER_CHANNELS_POLL_ID, active);
  const analogState = useTelemetryValue<MspAnalog>(sessionId, RECEIVER_TELEMETRY_POLL_ID, active);
  const statusState = useTelemetryValue<MspStatusExDiagnostics>(sessionId, FC_STATUS_TELEMETRY_POLL_ID, active);
  useEffect(() => { if (active && sessionKey !== undefined) return acquireReceiverTelemetry(sessionKey); }, [active, sessionKey]);

  const channels = valueOf(channelsState)?.channels ?? [];
  const analog = valueOf(analogState);
  const rssi = analog === undefined ? undefined : deriveReceiverRssi(analog);
  const blockers = valueOf(statusState)?.readiness.armingDisableFlags;
  const failsafe = blockers !== undefined && (Math.floor(blockers / 2) % 2 === 1 || Math.floor(blockers / 4) % 2 === 1);
  const live = channelsState.status === 'FRESH' && channels.length > 0;
  const stale = channelsState.status === 'STALE';

  return <View style={styles.liveMonitor} testID="receiver-live-monitor">
    <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.eyebrow}>RECEIVER · MSP_RC LIVE · TARGET 20 HZ</Text><Text style={styles.title}>المستقبل والقنوات</Text><Text style={styles.subtitle}>راقب استجابة جهاز الإرسال لحظيًا، واضبط الخريطة والنطاق والـdeadband واحفظ بتحقق إعادة قراءة.</Text></View><View style={[styles.liveBadge, live ? styles.liveBadgeGood : styles.liveBadgeMuted]}><View style={[styles.liveDot, live && styles.liveDotGood]} /><Text style={styles.liveText}>{live ? 'بيانات حية' : stale ? 'بيانات قديمة' : 'بانتظار القنوات'}</Text></View></View>
    <View style={styles.hardwareNotice}><Text style={styles.hardwareTitle}>REQUIRES HARDWARE TEST</Text><Text style={styles.hardwareText}>لا تولّد الشاشة قنوات تجريبية. حرّك العصي والمفاتيح وتأكد أن القيم تتحرك فعلًا. انزع المراوح قبل العمل.</Text></View>
    {failsafe ? <View style={styles.danger}><Text style={styles.dangerTitle}>فقد إشارة / Failsafe نشط</Text><Text style={styles.dangerText}>القيم قد تكون مخارج failsafe وليست أوامر حية.</Text></View> : null}
    <View style={[styles.primaryGrid, wide && styles.primaryGridWide]}>
      <View style={[styles.card, styles.previewCard]}><Heading title="حركة العصي" hint="القيم الطبيعية تقارب 1000–2000 والمنتصف 1500" /><View style={styles.sticksRow}><StickPad horizontal={channels[2]} vertical={channels[3]} horizontalLabel="Yaw" verticalLabel="Throttle" testID="receiver-stick-left" /><StickPad horizontal={channels[0]} vertical={channels[1]} horizontalLabel="Roll" verticalLabel="Pitch" testID="receiver-stick-right" /></View><View style={styles.signalSummary}><Text style={styles.signalLabel}>RSSI</Text><Text style={styles.signalValue}>{rssi?.kind === 'PERCENT' ? `${rssi.percent}%` : 'غير متاح'}</Text><Text style={styles.signalLabel}>القنوات</Text><Text style={styles.signalValue}>{channels.length || '—'}</Text></View></View>
      <View style={[styles.card, styles.channelsCard]}><Heading title="مراقبة القنوات" hint="كل صف يتحدث من رد MSP_RC الحقيقي" />{channels.length === 0 ? <Text style={styles.emptyText}>شغّل جهاز الإرسال وتأكد من توصيل المستقبل وضبط المنفذ والبروتوكول.</Text> : channels.map((v, i) => <ChannelBar key={i} index={i} value={v} />)}</View>
    </View>
  </View>;
});

export default function ReceiverScreen({sessionKey, active, onOpenPorts, onOpenMotors, onDirtyChange, controller = receiverConfigurationController}: ReceiverScreenProps): React.JSX.Element {
  const {maxWidth} = useContentEnvelope(true);
  const {width, fontScale} = useWindowDimensions();
  const wide = width / Math.max(1, fontScale) >= 900;
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<ReceiverConfigurationSnapshot>();
  const [draft, setDraft] = useState<ReceiverConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] = useState<ReceiverLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<ReceiverSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined);
    controller.load(sessionKey).then(outcome => { if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') { setSnapshot(outcome.snapshot); setDraft(createReceiverConfigurationDraft(outcome.snapshot)); setPhase('READY'); } else { setSnapshot(undefined); setDraft(undefined); setPhase('ERROR'); } });
    return () => { cancelled = true; };
  }, [active, controller, reloadToken, sessionKey]);

  const dirty = snapshot !== undefined && draft !== undefined && !receiverDraftsEqual(createReceiverConfigurationDraft(snapshot), draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined ? [] : validateReceiverDraft(draft), [draft]);
  const update = useCallback(<K extends keyof ReceiverConfigurationDraft>(key: K, value: ReceiverConfigurationDraft[K]) => { setDraft(current => current === undefined ? current : Object.freeze({...current, [key]: value})); setSaveOutcome(undefined); }, []);
  const reload = useCallback(() => { const perform = () => setReloadToken(v => v + 1); if (!dirty) return perform(); Alert.alert('تجاهل التغييرات؟', 'ستُستبدل القيم الحالية بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]); }, [dirty]);
  const save = useCallback(async () => { if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0) return; setPhase('SAVING'); const outcome = await controller.save(sessionKey, snapshot, draft); setSaveOutcome(outcome); if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') { setSnapshot(outcome.snapshot); setDraft(createReceiverConfigurationDraft(outcome.snapshot)); } setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY'); }, [controller, draft, issues.length, sessionKey, snapshot]);
  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome);
  const provider = snapshot === undefined ? '—' : SERIAL_RX_NAMES[snapshot.rx.serialRxProvider] ?? `Provider ${snapshot.rx.serialRxProvider}`;
  const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة إعدادات المستقبل من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;

  return <View style={styles.root} testID="receiver-screen">
    <ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
      <ReceiverLiveMonitor sessionKey={sessionKey} active={active} wide={wide} />
      {loadingMessage !== undefined ? <View style={styles.warning} testID="receiver-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح شاشة المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} />}</View> : null}

      {draft !== undefined && snapshot !== undefined ? <>
        <View style={styles.card}><Heading title="مصدر المستقبل" hint="قراءة من MSP_RX_CONFIG. تعيين منفذ Serial RX يتم من شاشة المنافذ؛ لا يغيّر هذا الزر البروتوكول." /><View style={styles.providerRow}><View><Text style={styles.fieldLabel}>البروتوكول الحالي</Text><Text style={styles.providerValue}>{provider}</Text></View><Button label="فتح المنافذ" onPress={onOpenPorts} variant="secondary" icon="cable" /></View></View>
        <View style={styles.card}><Heading title="خريطة القنوات" hint="كل حرف مرة واحدة: Aileron, Elevator, Rudder, Throttle ثم AUX." /><View style={styles.mapRow}><TextInput value={draft.channelMapText} editable={phase === 'READY'} autoCapitalize="characters" maxLength={8} onChangeText={v => update('channelMapText', v.toUpperCase())} style={[styles.mapInput, issues.includes('CHANNEL_MAP_INVALID') && styles.invalidInput]} testID="receiver-channel-map" /><Button label="AETR1234" onPress={() => update('channelMapText', 'AETR1234')} variant="secondary" /><Button label="TAER1234" onPress={() => update('channelMapText', 'TAER1234')} variant="secondary" /></View></View>
        <View style={styles.card}><Heading title="نطاق العصا وRSSI" hint="حدود تعرف المتحكم على وضع العصا؛ ليست معايرة جهاز الإرسال. RSSI: صفر للتعطيل أو قناة AUX من 5 إلى 18." /><View style={styles.fieldsGrid}><NumericField label="الحد الأدنى" value={draft.stickMin} min={1000} max={1200} disabled={phase !== 'READY'} onChange={v => update('stickMin', v)} testID="receiver-stick-min" /><NumericField label="المنتصف" value={draft.stickCenter} min={1401} max={1599} disabled={phase !== 'READY'} onChange={v => update('stickCenter', v)} testID="receiver-stick-center" /><NumericField label="الحد الأعلى" value={draft.stickMax} min={1800} max={2000} disabled={phase !== 'READY'} onChange={v => update('stickMax', v)} testID="receiver-stick-max" /><RssiChannelField value={draft.rssiChannel} disabled={phase !== 'READY'} onChange={v => update('rssiChannel', v)} /></View></View>
        <View style={styles.card}><Heading title="Deadband" hint="ارفع القيم فقط إذا كانت القنوات تهتز حول المنتصف." /><View style={styles.fieldsGrid}><NumericField label="Roll / Pitch" value={draft.deadband} min={0} max={32} disabled={phase !== 'READY'} onChange={v => update('deadband', v)} testID="receiver-deadband" /><NumericField label="Yaw" value={draft.yawDeadband} min={0} max={100} disabled={phase !== 'READY'} onChange={v => update('yawDeadband', v)} testID="receiver-yaw-deadband" /><NumericField label="Throttle في وضع 3D" value={draft.throttle3dDeadband} min={0} max={100} disabled={phase !== 'READY'} onChange={v => update('throttle3dDeadband', v)} testID="receiver-3d-deadband" /></View></View>
        <View style={styles.card}><View style={styles.toggleRow}><View style={styles.toggleCopy}><Text style={styles.sectionTitle}>RC Smoothing</Text><Text style={styles.sectionHint}>تنعيم setpoint وthrottle من Betaflight API 1.47.</Text></View><ToggleSwitch value={draft.smoothingEnabled} disabled={phase !== 'READY'} onValueChange={v => update('smoothingEnabled', v)} accessibilityLabel="RC Smoothing" testID="receiver-smoothing" /></View>{draft.smoothingEnabled ? <View style={styles.fieldsGrid}><NumericField label="Setpoint cutoff Hz (0=Auto)" value={draft.setpointCutoff} min={0} max={255} disabled={phase !== 'READY'} onChange={v => update('setpointCutoff', v)} testID="receiver-setpoint-cutoff" /><NumericField label="Throttle cutoff Hz (0=Auto)" value={draft.throttleCutoff} min={0} max={255} disabled={phase !== 'READY'} onChange={v => update('throttleCutoff', v)} testID="receiver-throttle-cutoff" /><NumericField label="Setpoint auto factor" value={draft.setpointAutoFactor} min={0} max={250} disabled={phase !== 'READY'} onChange={v => update('setpointAutoFactor', v)} testID="receiver-setpoint-factor" /><NumericField label="Throttle auto factor" value={draft.throttleAutoFactor} min={0} max={250} disabled={phase !== 'READY'} onChange={v => update('throttleAutoFactor', v)} testID="receiver-throttle-factor" /></View> : null}</View>
        {issues.length > 0 ? <View style={styles.danger}><Text style={styles.dangerTitle}>راجع القيم قبل الحفظ</Text><Text style={styles.dangerText}>{issues.join(' · ')}</Text></View> : null}
        {statusCopy !== undefined ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
      </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة إعدادات المستقبل…</Text> : null}
      <View style={styles.bottomSpace} />
    </ScrollView>
    <StickyActionBar visible={dirty} summary="إعدادات المستقبل تغيّرت" details={['خريطة القنوات، نطاق العصا، RSSI، deadband وRC smoothing']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createReceiverConfigurationDraft(snapshot))} disabledReason={issues.length > 0 ? 'صحح القيم غير الصالحة أولًا.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ الحفظ…" testID="receiver-save-bar" />
  </View>;
}

function Heading({title, hint}: {title: string; hint: string}) { return <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionHint}>{hint}</Text></View>; }

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background}, content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md}, liveMonitor: {gap: spacing.md},
  hero: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.lg, flexWrap: 'wrap'}, heroCopy: {flex: 1, minWidth: 260, gap: 4}, eyebrow: {...typography.eyebrow, color: colors.accentStrong}, title: {...typography.title, color: colors.textPrimary, textAlign: 'right'}, subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl'},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1}, liveBadgeGood: {backgroundColor: colors.successSoft, borderColor: colors.success}, liveBadgeMuted: {backgroundColor: colors.surfaceAlt, borderColor: colors.border}, liveDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: colors.disabled}, liveDotGood: {backgroundColor: colors.success}, liveText: {...typography.caption, color: colors.textPrimary, fontWeight: '700'},
  hardwareNotice: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3}, hardwareTitle: {...typography.eyebrow, color: colors.accentStrong}, hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', writingDirection: 'rtl'},
  primaryGrid: {gap: spacing.md}, primaryGridWide: {flexDirection: 'row'}, card: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md}, previewCard: {flex: 4}, channelsCard: {flex: 5}, sectionHeading: {gap: 3}, sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl'},
  sticksRow: {flexDirection: 'row', justifyContent: 'center', gap: spacing.lg, flexWrap: 'wrap'}, stickWrap: {alignItems: 'center', gap: 7}, stickPad: {width: 150, height: 150, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundRaised, overflow: 'hidden'}, crossH: {position: 'absolute', left: 0, right: 0, top: '50%', height: 1, backgroundColor: colors.border}, crossV: {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, backgroundColor: colors.border}, stickDot: {position: 'absolute', width: 18, height: 18, borderRadius: 9, marginLeft: -9, marginTop: -9, backgroundColor: colors.accentStrong, borderWidth: 3, borderColor: colors.accent}, stickLabel: {...typography.caption, color: colors.textSecondary, fontVariant: ['tabular-nums']},
  signalSummary: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap'}, signalLabel: {...typography.caption, color: colors.textMuted}, signalValue: {...typography.body, color: colors.accentStrong, fontWeight: '700', fontVariant: ['tabular-nums']},
  channelRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm}, channelName: {...typography.caption, color: colors.textSecondary, width: 70, textAlign: 'left'}, channelTrack: {height: 18, flex: 1, borderRadius: 9, backgroundColor: colors.backgroundRaised, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft}, channelFill: {height: '100%', backgroundColor: colors.accent}, channelCenter: {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, backgroundColor: colors.accentStrong}, channelValue: {...typography.caption, color: colors.textPrimary, width: 48, textAlign: 'right', fontVariant: ['tabular-nums']}, emptyText: {...typography.body, color: colors.textMuted, textAlign: 'right'},
  providerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap'}, fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'}, providerValue: {...typography.heading, color: colors.accentStrong, textAlign: 'left'}, 
  mapRow: {flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center'}, mapInput: {minWidth: 150, minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.backgroundRaised, color: colors.textPrimary, paddingHorizontal: spacing.md, textAlign: 'center', fontWeight: '700', letterSpacing: 2}, invalidInput: {borderColor: colors.error, borderWidth: 2}, preset: {minHeight: 42, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceRaised}, presetText: {...typography.caption, color: colors.accentStrong, fontWeight: '700'},
  fieldsGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md}, numericField: {flexGrow: 1, flexBasis: 190, gap: 5}, rangeHint: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, toggleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md}, toggleCopy: {flex: 1, gap: 3},
  warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.md, gap: spacing.sm}, warningText: {...typography.body, color: colors.warning, textAlign: 'right', writingDirection: 'rtl'}, danger: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, padding: spacing.md, gap: 3}, dangerTitle: {...typography.heading, color: colors.error, textAlign: 'right'}, dangerText: {...typography.body, color: colors.error, textAlign: 'right', writingDirection: 'rtl'}, success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.md}, successText: {...typography.body, color: colors.success, textAlign: 'right'}, inlineAction: {alignSelf: 'flex-start'}, loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl}, bottomSpace: {height: spacing.xl},
});
