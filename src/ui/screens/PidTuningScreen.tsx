import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {
  createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft,
  type MspPidTuningSnapshot, type PidAxisDraft, type PidAxisKey, type PidTuningDraft,
} from '../../core';
import {
  pidTuningController, type PidBlockReason, type PidLoadOutcome, type PidSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {StickyActionBar} from '../components/editing';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';

export interface PidControllerPort {
  load(key: SetupUiSessionKey): Promise<PidLoadOutcome>;
  save(key: SetupUiSessionKey, original: MspPidTuningSnapshot, draft: PidTuningDraft): Promise<PidSaveOutcome>;
}
export interface PidTuningScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenMotors: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: PidControllerPort;
}
type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';
const AXES: readonly {key: PidAxisKey; title: string; subtitle: string}[] = Object.freeze([
  {key: 'roll', title: 'Roll', subtitle: 'المحور الجانبي'},
  {key: 'pitch', title: 'Pitch', subtitle: 'المحور الطولي'},
  {key: 'yaw', title: 'Yaw', subtitle: 'محور الاتجاه'},
]);

function blockMessage(reason: PidBlockReason): string {
  return ({
    DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.',
    IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.',
    UNSUPPORTED_FIRMWARE: 'هذه الدفعة تدعم Betaflight MSP API 1.47 فقط، لأن تخطيط PID يختلف بين الإصدارات.',
    APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل قراءة أو حفظ PID.',
    LINK_RECOVERING: 'رابط MSP يتعافى الآن. انتظر ثم أعد القراءة.',
    FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران مسلّح.',
    ARMED_STATE_UNKNOWN: 'تعذر إثبات أن متحكم الطيران DISARMED؛ لم يُرسل أي تعديل.',
    MOTOR_TEST_ACTIVE: 'أنه جلسة اختبار المحركات من شاشة المحركات، ثم أعد القراءة.',
    CONFIGURATION_BUSY: 'هناك معاملة إعدادات أخرى جارية. انتظر ثم أعد المحاولة.',
    STALE_BASE: 'تغيّرت قيم PID على متحكم الطيران منذ آخر قراءة. أعد القراءة قبل الحفظ.',
    INVALID_CONFIGURATION: 'هناك قيمة PID خارج الحدود الرسمية.',
  })[reason];
}
function saveMessage(outcome: PidSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'SAVED_VERIFIED': return {text: 'حُفظت قيم PID وأكدت القراءة الراجعة تطابقها.', warning: false};
    case 'NO_CHANGES': return {text: 'لا توجد تغييرات جديدة.', warning: false};
    case 'SAVED_UNVERIFIED': return {text: 'أُقر الحفظ، لكن تعذرت القراءة الراجعة. أعد القراءة قبل الطيران.', warning: true};
    case 'UNCONFIRMED': return {text: `نتيجة الكتابة غير مؤكدة عند مرحلة ${outcome.stage}. لا تعِد الحفظ تلقائيًا؛ أعد الاتصال والقراءة.`, warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء العملية.', warning: true};
    case 'FAILED': return {text: 'فشل الحفظ قبل تأكيد الاستمرار. لم يدّع التطبيق نجاحًا.', warning: true};
  }
}
function u16At(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true); }

function NumericField({label, value, max, disabled, onChange, testID}: {label: string; value: number; max: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  const apply = (next: number) => onChange(Math.max(0, Math.min(max, next)));
  return <View style={styles.numericField}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.stepper}><Pressable disabled={disabled} onPress={() => apply(value - 1)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><TextInput value={String(value)} editable={!disabled} keyboardType="number-pad" selectTextOnFocus onChangeText={text => { const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) apply(parsed); }} style={styles.numberInput} testID={testID} /><Pressable disabled={disabled} onPress={() => apply(value + 1)} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable></View><Text style={styles.rangeHint}>0–{max}</Text></View>;
}

function AxisCard({axisKey, title, subtitle, value, disabled, update}: {axisKey: PidAxisKey; title: string; subtitle: string; value: PidAxisDraft; disabled: boolean; update: (axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => void}) {
  return <View style={styles.axisCard} testID={`pid-axis-${axisKey}`}><View><Text style={styles.axisTitle}>{title}</Text><Text style={styles.axisSubtitle}>{subtitle}</Text></View><View style={styles.fieldsRow}><NumericField label="P" value={value.p} max={250} disabled={disabled} onChange={next => update(axisKey, 'p', next)} testID={`pid-${axisKey}-p`} /><NumericField label="I" value={value.i} max={250} disabled={disabled} onChange={next => update(axisKey, 'i', next)} testID={`pid-${axisKey}-i`} /><NumericField label="D" value={value.d} max={250} disabled={disabled} onChange={next => update(axisKey, 'd', next)} testID={`pid-${axisKey}-d`} /><NumericField label="F" value={value.f} max={1000} disabled={disabled} onChange={next => update(axisKey, 'f', next)} testID={`pid-${axisKey}-f`} /></View></View>;
}

export default function PidTuningScreen({sessionKey, active, onOpenMotors, onDirtyChange, controller = pidTuningController}: PidTuningScreenProps): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions(); const {maxWidth} = useContentEnvelope(true); const wide = width / Math.max(fontScale, 1) >= 1040;
  const [phase, setPhase] = useState<Phase>('IDLE'); const [snapshot, setSnapshot] = useState<MspPidTuningSnapshot>(); const [draft, setDraft] = useState<PidTuningDraft>(); const [loadOutcome, setLoadOutcome] = useState<PidLoadOutcome>(); const [saveOutcome, setSaveOutcome] = useState<PidSaveOutcome>(); const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => { if (!active || sessionKey === undefined) return; let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined); controller.load(sessionKey).then(outcome => { if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') { setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot)); setPhase('READY'); } else { setSnapshot(undefined); setDraft(undefined); setPhase('ERROR'); } }); return () => { cancelled = true; }; }, [active, controller, reloadToken, sessionKey]);
  const dirty = snapshot !== undefined && draft !== undefined && !pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]); useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined ? [] : validatePidTuningDraft(draft), [draft]);
  const update = useCallback((axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, [axis]: Object.freeze({...current[axis], [term]: value})})); setSaveOutcome(undefined); }, []);
  const reload = useCallback(() => { const perform = () => setReloadToken(value => value + 1); if (!dirty) return perform(); Alert.alert('تجاهل تغييرات PID؟', 'ستُستبدل القيم الحالية بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]); }, [dirty]);
  const save = useCallback(async () => { if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0) return; setPhase('SAVING'); const outcome = await controller.save(sessionKey, snapshot, draft); setSaveOutcome(outcome); if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') { setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot)); } setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY'); }, [controller, draft, issues.length, sessionKey, snapshot]);
  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome); const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة إعدادات PID من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;
  const ratesType = snapshot?.ratesRaw[22]; const filterSummary = snapshot === undefined ? undefined : {gyro1: u16At(snapshot.filtersRaw, 20), gyro2: u16At(snapshot.filtersRaw, 22), dterm1: u16At(snapshot.filtersRaw, 1), dterm2: u16At(snapshot.filtersRaw, 26), dynamicNotches: snapshot.filtersRaw[48]};

  return <View style={styles.root} testID="pid-screen"><ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
    <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.eyebrow}>PID TUNING · BETAFLIGHT API 1.47</Text><Text style={styles.title}>ضبط PID</Text><Text style={styles.subtitle}>اضبط معاملات الاستجابة للمحاور الثلاثة. الحفظ لا يبدأ إلا بعد إثبات DISARMED، ثم تُحفظ القيم في EEPROM وتُقرأ مجددًا للتحقق.</Text></View><View style={styles.profileBadge}><Text style={styles.profileLabel}>العقد المدعوم</Text><Text style={styles.profileValue}>MSP API 1.47</Text></View></View>
    <View style={styles.danger}><Text style={styles.dangerTitle}>تغيير PID قد يجعل الطائرة غير مستقرة</Text><Text style={styles.dangerText}>احفظ القيم الأصلية، غيّر تدريجيًا، وانزع المراوح أثناء الإعداد. لا يثبت نجاح MSP أن الضبط مناسب للطيران.</Text></View>
    <View style={styles.hardwareNotice}><Text style={styles.hardwareTitle}>REQUIRES HARDWARE TEST</Text><Text style={styles.hardwareText}>الترميز والقراءة الراجعة مختبران آليًا، لكن النتيجة الديناميكية لا يمكن اعتمادها دون Flight Controller وطائرة حقيقية واختبار متدرج آمن.</Text></View>
    {loadingMessage !== undefined ? <View style={styles.warning} testID="pid-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Pressable onPress={onOpenMotors} style={styles.inlineAction}><Text style={styles.inlineActionText}>فتح شاشة المحركات</Text></Pressable> : <Pressable onPress={reload} style={styles.inlineAction}><Text style={styles.inlineActionText}>إعادة القراءة</Text></Pressable>}</View> : null}
    {draft !== undefined ? <>
      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>المعاملات الأساسية</Text><Text style={styles.sectionHint}>P للتصحيح الحالي، I للخطأ المتراكم، D لتخميد التغير، وF لتتبع الأمر. الحدود من Betaflight 2025.12.2.</Text></View>
      <View style={[styles.axisGrid, wide && styles.axisGridWide]}>{AXES.map(axis => <AxisCard key={axis.key} axisKey={axis.key} title={axis.title} subtitle={axis.subtitle} value={draft[axis.key]} disabled={phase !== 'READY'} update={update} />)}</View>
      <View style={[styles.readOnlyGrid, wide && styles.readOnlyGridWide]}><View style={styles.card}><Text style={styles.sectionTitle}>Rates — قراءة فقط</Text><Text style={styles.sectionHint}>لم نفتح تعديل rates قبل تثبيت عقد كل خوارزمية؛ لا تُحوّل القيم إلى تفسير خاطئ.</Text><Text style={styles.readout}>نوع الخوارزمية الخام: {ratesType ?? '—'}</Text><Text style={styles.readout}>Roll / Pitch / Yaw rate: {snapshot?.ratesRaw[2] ?? '—'} / {snapshot?.ratesRaw[3] ?? '—'} / {snapshot?.ratesRaw[4] ?? '—'}</Text></View><View style={styles.card}><Text style={styles.sectionTitle}>Filters — قراءة فقط</Text><Text style={styles.sectionHint}>تغيير الفلاتر مؤجل حتى تُثبت كل حدود Nyquist وقدرات البناء.</Text><Text style={styles.readout}>Gyro LPF1/2: {filterSummary?.gyro1 ?? '—'} / {filterSummary?.gyro2 ?? '—'} Hz</Text><Text style={styles.readout}>D-term LPF1/2: {filterSummary?.dterm1 ?? '—'} / {filterSummary?.dterm2 ?? '—'} Hz</Text><Text style={styles.readout}>Dynamic notch count: {filterSummary?.dynamicNotches ?? '—'}</Text></View></View>
      {issues.length > 0 ? <View style={styles.danger}><Text style={styles.dangerTitle}>راجع القيم قبل الحفظ</Text><Text style={styles.dangerText}>{issues.join(' · ')}</Text></View> : null}
      {statusCopy !== undefined ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
    </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة PID والـrates والفلاتر…</Text> : null}<View style={styles.bottomSpace} />
  </ScrollView><StickyActionBar visible={dirty} summary="تغيّرت قيم PID" details={['Roll / Pitch / Yaw — P, I, D, F']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createPidTuningDraft(snapshot))} disabledReason={issues.length > 0 ? 'صحح القيم غير الصالحة أولًا.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ PID…" testID="pid-save-bar" /></View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background}, content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md}, hero: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.lg, flexWrap: 'wrap'}, heroCopy: {flex: 1, minWidth: 280, gap: 4}, eyebrow: {...typography.eyebrow, color: colors.accentStrong, letterSpacing: 1}, title: {...typography.title, color: colors.textPrimary, textAlign: 'right'}, subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl'}, profileBadge: {borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, borderRadius: radii.lg, padding: spacing.md, minWidth: 180}, profileLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, profileValue: {...typography.heading, color: colors.accentStrong, textAlign: 'right'}, danger: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.error, backgroundColor: '#FFF0F2', padding: spacing.md, gap: 3}, dangerTitle: {...typography.heading, color: colors.error, textAlign: 'right'}, dangerText: {...typography.body, color: colors.error, textAlign: 'right', writingDirection: 'rtl'}, hardwareNotice: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3}, hardwareTitle: {...typography.eyebrow, color: colors.accentStrong}, hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', writingDirection: 'rtl'}, sectionHeading: {gap: 3}, sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl'}, axisGrid: {gap: spacing.md}, axisGridWide: {flexDirection: 'row'}, axisCard: {flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md}, axisTitle: {...typography.title, fontSize: 24, color: colors.accentStrong, textAlign: 'right'}, axisSubtitle: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, numericField: {flexGrow: 1, flexBasis: 100, gap: 5}, fieldLabel: {...typography.heading, color: colors.textPrimary, textAlign: 'center'}, stepper: {flexDirection: 'row', alignItems: 'stretch', minHeight: 44}, stepButton: {width: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundRaised}, stepText: {fontSize: 20, color: colors.accentStrong, fontWeight: '700'}, numberInput: {flex: 1, minWidth: 52, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.textPrimary, textAlign: 'center', fontVariant: ['tabular-nums'], fontWeight: '800'}, rangeHint: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, readOnlyGrid: {gap: spacing.md}, readOnlyGridWide: {flexDirection: 'row'}, card: {flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm}, readout: {...typography.body, color: colors.textSecondary, textAlign: 'right', fontVariant: ['tabular-nums']}, warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: '#FFF7E7', padding: spacing.md, gap: spacing.sm}, warningText: {...typography.body, color: colors.warning, textAlign: 'right', writingDirection: 'rtl'}, success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: '#E8F8F1', padding: spacing.md}, successText: {...typography.body, color: colors.success, textAlign: 'right'}, inlineAction: {alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, backgroundColor: colors.warning}, inlineActionText: {...typography.body, color: colors.white, fontWeight: '700'}, loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl}, bottomSpace: {height: spacing.xl},
});
