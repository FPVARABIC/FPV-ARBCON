import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';
import {
  RX_FAILSAFE_MAX,
  RX_FAILSAFE_MIN,
  RX_FAILSAFE_STEP,
  createFailsafeConfigurationDraft,
  failsafeDraftsEqual,
  validateFailsafeDraft,
  type FailsafeChannelDraft,
  type FailsafeConfigurationDraft,
  type FailsafeValidationCode,
  type MspFailsafeSnapshot,
  type MspRcChannels,
  type MspStatusExDiagnostics,
  type TelemetryValue,
} from '../../core';
import {
  FC_STATUS_TELEMETRY_POLL_ID,
  RECEIVER_CHANNELS_POLL_ID,
  acquireReceiverTelemetry,
  failsafeConfigurationController,
  useTelemetryValue,
  type FailsafeBlockReason,
  type FailsafeLoadOutcome,
  type FailsafeSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {StickyActionBar} from '../components/editing';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, ChoiceChips, MIN_TOUCH_TARGET, Stepper as SharedStepper} from '../components/controls';

export interface FailsafeControllerPort {load(key: SetupUiSessionKey): Promise<FailsafeLoadOutcome>; save(key: SetupUiSessionKey, original: MspFailsafeSnapshot, draft: FailsafeConfigurationDraft): Promise<FailsafeSaveOutcome>}
export interface FailsafeScreenProps {readonly sessionKey?: SetupUiSessionKey; readonly active: boolean; readonly onOpenReceiver: () => void; readonly onOpenMotors: () => void; readonly onDirtyChange?: (dirty: boolean) => void; readonly controller?: FailsafeControllerPort}
/**
 * EVERY validation code, in the operator's language.
 *
 * The screen used to render `issues.join(' \u00b7 ')` directly, so a real
 * board produced "\u0631\u0627\u062c\u0639 \u0627\u0644\u0642\u064a\u0645: CHANNEL_VALUE_INVALID" - an internal
 * identifier shown to an Arabic operator, telling them nothing about
 * which channel or what to do. That path is now reachable far more often:
 * the RXFAIL decoder no longer refuses to load a board whose stored value
 * is off the 25\u00b5s grid, so the value arrives here to be corrected instead
 * of taking the whole screen down.
 */
const FAILSAFE_ISSUE_TEXT: Readonly<Record<FailsafeValidationCode, string>> = {
  DELAY_INVALID: 'زمن الحراسة خارج المدى المسموح (0.1\u201320 ثانية).',
  LANDING_TIME_INVALID: 'زمن الهبوط خارج المدى المسموح (0\u2013250 ثانية).',
  THROTTLE_INVALID: 'خانق الهبوط خارج مدى 750\u20132250\u00b5s.',
  SWITCH_MODE_INVALID: 'سلوك مفتاح Failsafe غير معروف؛ اختر Stage 1 أو Kill أو Stage 2.',
  THROTTLE_LOW_DELAY_INVALID: 'مدة الخانق المنخفض خارج المدى المسموح (0\u201330 ثانية).',
  PROCEDURE_INVALID: 'إجراء المرحلة 2 غير معروف؛ اختر Drop أو Land أو GPS Rescue.',
  GPS_RESCUE_UNSUPPORTED: 'GPS Rescue غير مثبت في هذا البناء؛ اختر Drop أو Land.',
  CHANNEL_COUNT_CHANGED: 'تغيّر عدد القنوات أثناء التحرير؛ أعد القراءة قبل الحفظ.',
  CHANNEL_MODE_INVALID: 'إحدى القنوات تحمل وضعًا غير معروف؛ اختر AUTO أو HOLD أو SET.',
  CHANNEL_VALUE_INVALID: 'قيمة SET لإحدى القنوات خارج 750\u20132250\u00b5s أو ليست من مضاعفات 25\u00b5s.',
  AUX_AUTO_FORBIDDEN: 'AUTO متاح للمحاور الأربعة الأولى فقط؛ استخدم HOLD أو SET لقنوات AUX.',
};

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function valueOf<T>(value: TelemetryValue<T>): T | undefined {return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined;}
function blockMessage(reason: FailsafeBlockReason): string {return ({DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.', IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.', UNSUPPORTED_FIRMWARE: 'تتطلب شاشة Failsafe إصدار Betaflight يستخدم MSP API 1.47.', APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل القراءة أو الحفظ.', LINK_RECOVERING: 'الرابط التسلسلي يتعافى. انتظر ثم أعد القراءة.', FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران ARMED.', ARMED_STATE_UNKNOWN: 'تعذر إثبات DISARMED؛ لم تُرسل الإعدادات.', MOTOR_TEST_ACTIVE: 'جلسة اختبار المحركات نشطة. افتح المحركات وأنهِ الجلسة ثم أعد القراءة.', CONFIGURATION_BUSY: 'توجد معاملة إعدادات أخرى قيد التنفيذ.', STALE_BASE: 'تغيرت إعدادات Failsafe في المتحكم. أعد القراءة قبل الحفظ.', INVALID_CONFIGURATION: 'توجد قيمة Failsafe غير صالحة.'} as const)[reason];}
function saveMessage(outcome: FailsafeSaveOutcome): {text: string; warning: boolean} {switch (outcome.kind) {case 'NO_CHANGES': return {text: 'لا توجد تغييرات.', warning: false}; case 'SAVED_VERIFIED': return {text: 'حُفظ Failsafe وتطابقت القراءة الراجعة.', warning: false}; case 'SAVED_UNVERIFIED': return {text: 'أقرّ المتحكم الحفظ لكن تعذر التحقق. أعد الاتصال واقرأ قبل محاولة أخرى.', warning: true}; case 'UNCONFIRMED': {const channel = 'index' in outcome.stage && outcome.stage.index !== undefined ? ` للقناة ${outcome.stage.index + 1}` : ''; return {text: `نتيجة الكتابة غير مؤكدة عند ${outcome.stage.group}${channel}. لا تكرر الحفظ.`, warning: true};} case 'SESSION_ENDED': return {text: 'انتهت الجلسة أثناء العملية.', warning: true}; case 'FAILED': return {text: 'فشلت العملية قبل اكتمال التحقق.', warning: true}; case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};}}

function NumberStepper({label, value, min, max, step = 1, suffix, disabled, onChange, testID}: {label: string; value: number; min: number; max: number; step?: number; suffix?: string; disabled: boolean; onChange: (value: number) => void; testID: string}) {return <View style={styles.numberField}><Text style={styles.fieldLabel}>{label}</Text><SharedStepper value={`${value}${suffix ?? ''}`} onDecrement={() => onChange(Math.max(min, value - step))} onIncrement={() => onChange(Math.min(max, value + step))} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} accessibilityLabel={label} testID={testID} /><Text style={styles.rangeText}>{min}–{max}{suffix}</Text></View>;}
function Choice<T extends number>({label, value, options, disabled, onChange, testID}: {label: string; value: T; options: readonly {value: T; label: string; help?: string}[]; disabled: boolean; onChange: (value: T) => void; testID: string}) {return <View style={styles.choiceField}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.choiceRow}>{options.map(option => <Pressable key={option.value} disabled={disabled} onPress={() => onChange(option.value)} style={[styles.choice, value === option.value && styles.choiceSelected]} testID={`${testID}-${option.value}`}><Text style={[styles.choiceText, value === option.value && styles.choiceTextSelected]}>{option.label}</Text>{option.help !== undefined ? <Text style={styles.choiceHelp}>{option.help}</Text> : null}</Pressable>)}</View></View>;}

const FailsafeLiveStatus = React.memo(function FailsafeLiveStatus({sessionKey, active}: {sessionKey?: SetupUiSessionKey; active: boolean}) {
  const statusValue = useTelemetryValue<MspStatusExDiagnostics>(sessionKey?.sessionId ?? '', FC_STATUS_TELEMETRY_POLL_ID, active);
  const channelsValue = useTelemetryValue<MspRcChannels>(sessionKey?.sessionId ?? '', RECEIVER_CHANNELS_POLL_ID, active);
  const status = valueOf(statusValue); const channels = valueOf(channelsValue);
  const blockers = status?.readiness.armingDisableFlags; const failsafe = blockers !== undefined && (Math.floor(blockers / 2) % 2 === 1 || Math.floor(blockers / 4) % 2 === 1);
  return <View style={[styles.liveCard, failsafe && styles.liveCardDanger]} testID="failsafe-live-status"><View><Text style={styles.liveLabel}>مراقبة حية من FC</Text><Text style={[styles.liveState, failsafe && styles.liveStateDanger]}>{failsafe ? 'RX LOSS / FAILSAFE نشط' : statusValue.status === 'FRESH' ? 'الرابط لا يعلن Failsafe' : 'بانتظار حالة الرابط'}</Text></View><View style={styles.liveMetric}><Text style={styles.liveMetricValue}>{channels?.channels.length ?? '—'}</Text><Text style={styles.liveMetricLabel}>قنوات MSP_RC</Text></View></View>;
});

function ChannelRow({index, draft, live, disabled, onChange}: {index: number; draft: FailsafeChannelDraft; live?: number; disabled: boolean; onChange: (value: FailsafeChannelDraft) => void}) {
  const name = ['Roll', 'Pitch', 'Yaw', 'Throttle'][index] ?? `AUX ${index - 3}`; const primary = index < 4;
  const modes = primary ? [{value: 0 as const, label: 'AUTO'}, {value: 1 as const, label: 'HOLD'}, {value: 2 as const, label: 'SET'}] : [{value: 1 as const, label: 'HOLD'}, {value: 2 as const, label: 'SET'}];
  return <View style={styles.channelRow} testID={`failsafe-channel-${index + 1}`}><View style={styles.channelHeading}><View><Text style={styles.channelName}>{name}</Text><Text style={styles.channelLive}>القيمة الحية: {live ?? '—'}</Text></View><ChoiceChips accessibilityLabel={`${name}: وضع Failsafe`} selectedKey={String(draft.mode)} onSelect={key => onChange({...draft, mode: Number(key) as FailsafeChannelDraft['mode']})} disabled={disabled} options={modes.map(mode => ({key: String(mode.value), label: mode.label, testID: `failsafe-channel-${index + 1}-mode-${mode.value}`}))} /></View>{draft.mode === 2 ? <NumberStepper label="قيمة SET" value={draft.value} min={RX_FAILSAFE_MIN} max={RX_FAILSAFE_MAX} step={RX_FAILSAFE_STEP} suffix=" µs" disabled={disabled} onChange={value => onChange({...draft, value})} testID={`failsafe-channel-${index + 1}-value`} /> : <Text style={styles.channelExplanation}>{draft.mode === 0 ? 'AUTO: يستخدم Betaflight سلوك المحور الافتراضي عند فقد النبض.' : 'HOLD: يحتفظ بآخر قيمة صالحة للقناة.'}</Text>}</View>;
}

export default function FailsafeScreen({sessionKey, active, onOpenReceiver, onOpenMotors, onDirtyChange, controller = failsafeConfigurationController}: FailsafeScreenProps): React.JSX.Element {
  const {t} = useTranslation(); const {maxWidth} = useContentEnvelope(
    // FALSE, because this screen does not split into columns - it is one
    // column of setting cards. contentEnvelope()'s own contract says a
    // screen that has not split must pass false so its text stays
    // readable however wide the window is; passing true gave it the
    // WORKSPACE envelope, so at 1920 every card stretched to ~1550px with
    // its content pinned to the reading edge and a wall of dead space
    // beside it.
    false,
  ); const {width, fontScale} = useWindowDimensions(); const wide = width / Math.max(1, fontScale) >= 900;
  const [phase, setPhase] = useState<Phase>('IDLE'); const [snapshot, setSnapshot] = useState<MspFailsafeSnapshot>(); const [draft, setDraft] = useState<FailsafeConfigurationDraft>(); const [loadOutcome, setLoadOutcome] = useState<FailsafeLoadOutcome>(); const [saveOutcome, setSaveOutcome] = useState<FailsafeSaveOutcome>(); const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {if (active && sessionKey !== undefined) return acquireReceiverTelemetry(sessionKey);}, [active, sessionKey]);
  useEffect(() => {if (!active || sessionKey === undefined) return; let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined); controller.load(sessionKey).then(outcome => {if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') {setSnapshot(outcome.snapshot); setDraft(createFailsafeConfigurationDraft(outcome.snapshot)); setPhase('READY');} else {setSnapshot(undefined); setDraft(undefined); setPhase('ERROR');}}); return () => {cancelled = true;};}, [active, controller, reloadToken, sessionKey]);
  const dirty = snapshot !== undefined && draft !== undefined && !failsafeDraftsEqual(createFailsafeConfigurationDraft(snapshot), draft); useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]); useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined || snapshot === undefined ? [] : validateFailsafeDraft(draft, snapshot), [draft, snapshot]);
  const update = useCallback(<K extends keyof Omit<FailsafeConfigurationDraft, 'channels'>>(key: K, value: FailsafeConfigurationDraft[K]) => {setDraft(current => current === undefined ? current : Object.freeze({...current, [key]: value})); setSaveOutcome(undefined);}, []);
  const updateChannel = useCallback((index: number, value: FailsafeChannelDraft) => {setDraft(current => current === undefined ? current : Object.freeze({...current, channels: Object.freeze(current.channels.map((item, itemIndex) => itemIndex === index ? Object.freeze(value) : item))})); setSaveOutcome(undefined);}, []);
  const reload = useCallback(() => {const perform = () => setReloadToken(value => value + 1); if (!dirty) return perform(); Alert.alert('تجاهل تغييرات Failsafe؟', 'ستُستبدل المسودة بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]);}, [dirty]);
  const save = useCallback(async () => {if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0) return; setPhase('SAVING'); const outcome = await controller.save(sessionKey, snapshot, draft); setSaveOutcome(outcome); if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {setSnapshot(outcome.snapshot); setDraft(createFailsafeConfigurationDraft(outcome.snapshot));} setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');}, [controller, draft, issues.length, sessionKey, snapshot]);
  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome); const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة Failsafe من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;
  const channelsTelemetry = useTelemetryValue<MspRcChannels>(sessionKey?.sessionId ?? '', RECEIVER_CHANNELS_POLL_ID, active); const liveChannels = valueOf(channelsTelemetry)?.channels ?? [];
  return <View style={styles.root} testID="failsafe-screen"><ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
    <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.title}>الأمان عند فقد الإشارة</Text><Text style={styles.subtitle}>اضبط زمن الحراسة، إجراء المرحلة الثانية، وسلوك كل قناة عند فقد النبض. لا يدّعي التطبيق أن الإعداد آمن للطيران قبل اختبار عتاد مضبوط.</Text></View>{snapshot !== undefined ? <View style={[styles.supportBadge, snapshot.supportsGpsRescue && styles.supportBadgeGood]}><Text style={styles.supportLabel}>GPS Rescue في البناء</Text><Text style={styles.supportValue}>{snapshot.supportsGpsRescue ? 'مدعوم' : 'غير مثبت'}</Text></View> : null}</View>
    <View style={styles.danger}><Text style={styles.dangerTitle}>اختبار Failsafe قد يسبب تسليحًا أو حركة غير متوقعة</Text><Text style={styles.dangerText}>انزع جميع المراوح، ثبّت الطائرة، واختبر أولًا عبر USB ومن دون LiPo إن أمكن.</Text><Text style={styles.dangerText}>{t('hardwareVerification.behaviourTitle')} — الـpayload والحفظ والتحقق مختبرة؛ سلوك المستقبل وGPS Rescue لا يثبت إلا بقطع الإشارة فعليًا.</Text></View>
    <FailsafeLiveStatus sessionKey={sessionKey} active={active} />
    {loadingMessage !== undefined ? <View style={styles.warning} testID="failsafe-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} testID="failsafe-open-motors" /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} testID="failsafe-reload" />}</View> : null}
    {draft !== undefined && snapshot !== undefined ? <>
      <View style={styles.card}><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>المرحلة 1 · كشف فقد الإشارة</Text><Text style={styles.sectionHint}>زمن الحراسة قبل إعلان RX loss، وزمن الخانق المنخفض الذي يسمح بالفصل المباشر بدل الإجراء الكامل.</Text></View><Pressable onPress={onOpenReceiver} style={styles.linkButton}><Text style={styles.linkButtonText}>فتح المستقبل والقنوات</Text></Pressable></View><View style={styles.fieldsRow}><NumberStepper label="زمن الحراسة" value={draft.delayDeciseconds} min={1} max={200} suffix=" ×0.1s" disabled={phase !== 'READY'} onChange={value => update('delayDeciseconds', value)} testID="failsafe-delay" /><NumberStepper label="مدة الخانق المنخفض" value={draft.throttleLowDelayDeciseconds} min={0} max={300} suffix=" ×0.1s" disabled={phase !== 'READY'} onChange={value => update('throttleLowDelayDeciseconds', value)} testID="failsafe-throttle-low-delay" /></View></View>
      <View style={styles.card}><Choice label="سلوك مفتاح Failsafe" value={draft.switchMode} options={[{value: 0, label: 'Stage 1', help: 'كفقد الرابط'}, {value: 1, label: 'Kill', help: 'فصل مباشر'}, {value: 2, label: 'Stage 2', help: 'الإجراء الكامل'}]} disabled={phase !== 'READY'} onChange={value => update('switchMode', value)} testID="failsafe-switch" /></View>
      <View style={styles.card}><Choice label="إجراء المرحلة 2" value={draft.procedure} options={[{value: 1, label: 'Drop', help: 'إيقاف وفصل'}, {value: 0, label: 'Land', help: 'هبوط بخانق ثابت'}, ...(snapshot.supportsGpsRescue ? [{value: 2 as const, label: 'GPS Rescue', help: 'عودة وإنقاذ'}] : [])]} disabled={phase !== 'READY'} onChange={value => update('procedure', value)} testID="failsafe-procedure" />{draft.procedure === 0 ? <View style={styles.fieldsRow}><NumberStepper label="خانق الهبوط" value={draft.throttle} min={RX_FAILSAFE_MIN} max={RX_FAILSAFE_MAX} step={1} suffix=" µs" disabled={phase !== 'READY'} onChange={value => update('throttle', value)} testID="failsafe-throttle" /><NumberStepper label="زمن الهبوط قبل الفصل" value={draft.landingTimeSeconds} min={0} max={250} suffix=" s" disabled={phase !== 'READY'} onChange={value => update('landingTimeSeconds', value)} testID="failsafe-landing-time" /></View> : null}{draft.procedure === 2 ? <View style={styles.gpsNotice}><Text style={styles.gpsNoticeText}>الدعم في البناء لا يثبت GPS fix أو Home أو صحة إعدادات Rescue. راجع شاشة GPS واختبر Rescue منفصلًا.</Text></View> : null}</View>
      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>قيم القنوات عند فقد النبض</Text><Text style={styles.sectionHint}>AUTO متاح للمحاور الأربعة فقط؛ قنوات AUX تستخدم HOLD أو SET كما يفرض Betaflight. القيمة SET تتحرك بخطوة 25µs.</Text></View>
      <View style={[styles.channelGrid, wide && styles.channelGridWide]}>{draft.channels.map((channel, index) => <ChannelRow key={index} index={index} draft={channel} live={liveChannels[index]} disabled={phase !== 'READY'} onChange={value => updateChannel(index, value)} />)}</View>
      {issues.length > 0 ? <View style={styles.warning}><Text style={styles.warningText}>{issues.map(code => FAILSAFE_ISSUE_TEXT[code]).join(' ')}</Text></View> : null}{statusCopy !== undefined ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
    </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة Failsafe والقيم الاحتياطية ودعم البناء…</Text> : null}<View style={styles.bottomSpace} />
  </ScrollView><StickyActionBar visible={dirty} summary="تغيّرت إعدادات Failsafe" details={['تُرسل الإعدادات والقنوات المتغيرة فقط، ثم EEPROM وقراءة تحقق']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createFailsafeConfigurationDraft(snapshot))} disabledReason={issues.length > 0 ? 'صحح قيم Failsafe قبل الحفظ.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ Failsafe…" testID="failsafe-save-bar" /></View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background}, content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md}, hero: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg, flexWrap: 'wrap'}, heroCopy: {flex: 1, minWidth: 280, gap: 4}, eyebrow: {...typography.eyebrow, color: colors.accentStrong}, title: {...typography.title, color: colors.textPrimary, textAlign: 'right'}, subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl'}, supportBadge: {borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radii.lg, padding: spacing.md, minWidth: 150}, supportBadgeGood: {borderColor: colors.success, backgroundColor: colors.successSoft}, supportLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, supportValue: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, danger: {borderRadius: radii.sm, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2}, dangerTitle: {...typography.caption, fontWeight: '700', color: colors.error, textAlign: 'right'}, dangerText: {...typography.caption, color: colors.error, textAlign: 'right', writingDirection: 'rtl'}, hardware: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3}, hardwareTitle: {...typography.eyebrow, color: colors.accentStrong}, hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right'}, liveCard: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.md}, liveCardDanger: {borderColor: colors.error, backgroundColor: colors.errorSoft}, liveLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, liveState: {...typography.heading, color: colors.success, textAlign: 'right'}, liveStateDanger: {color: colors.error}, liveMetric: {alignItems: 'center'}, liveMetricValue: {...typography.title, color: colors.textPrimary, fontVariant: ['tabular-nums']}, liveMetricLabel: {...typography.caption, color: colors.textMuted}, warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.md, gap: spacing.sm}, warningText: {...typography.body, color: colors.warning, textAlign: 'right'}, success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.md}, successText: {...typography.body, color: colors.success, textAlign: 'right'}, inlineAction: {alignSelf: 'flex-start'}, card: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md}, sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap'}, sectionHeading: {gap: 3}, sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, linkButton: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1.5, borderColor: colors.accentStrong}, linkButtonText: {...typography.label, color: colors.accentStrong}, fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: spacing.md}, /* CAPPED. A stepper is a normal-sized control, not a banner: with
     flexGrow alone a two-field row on a 1920px window produced two ~750px
     bars whose plus and minus sat at opposite ends of the screen with the
     value stranded in the middle - measured in Chromium, not theorised.
     It still grows on a phone, where the full row width IS the right size. */
  numberField: {flexGrow: 1, flexBasis: 180, maxWidth: 340, gap: 5}, fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'}, rangeText: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, choiceField: {gap: spacing.sm}, choiceRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, choice: {flexGrow: 1, flexBasis: 150, maxWidth: 280, minHeight: 58, padding: spacing.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.backgroundRaised}, choiceSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft}, choiceText: {...typography.bodyStrong, color: colors.textSecondary}, choiceTextSelected: {color: colors.accentStrong}, choiceHelp: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, gpsNotice: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.sm}, gpsNoticeText: {...typography.caption, color: colors.warning, textAlign: 'right'}, channelGrid: {gap: spacing.sm}, channelGridWide: {flexDirection: 'row', flexWrap: 'wrap'}, channelRow: {flexGrow: 1, flexBasis: 360, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm}, channelHeading: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm}, channelName: {...typography.bodyStrong, color: colors.textPrimary}, channelLive: {...typography.caption, color: colors.textMuted, fontVariant: ['tabular-nums']}, channelExplanation: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl}, bottomSpace: {height: spacing.xl},
});
