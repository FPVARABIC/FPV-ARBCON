import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {
  createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft,
  type FiltersDraft, type MspPidTuningSnapshot, type PidAxisDraft, type PidAxisKey,
  type PidTuningDraft, type RateAxisDraft, type RatesDraft,
} from '../../core';
import {
  pidTuningController, type PidBlockReason, type PidLoadOutcome, type PidSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {StickyActionBar} from '../components/editing';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, Stepper as SharedStepper} from '../components/controls';

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
const RATE_TYPES = Object.freeze([
  Object.freeze({name: 'Betaflight', rcMax: 255, superMax: 100, rcScale: 0.01, superScale: 0.01, expoScale: 0.01}),
  Object.freeze({name: 'Raceflight', rcMax: 200, superMax: 255, rcScale: 10, superScale: 1, expoScale: 1}),
  Object.freeze({name: 'KISS', rcMax: 255, superMax: 99, rcScale: 0.01, superScale: 0.01, expoScale: 0.01}),
  Object.freeze({name: 'Actual', rcMax: 200, superMax: 200, rcScale: 10, superScale: 10, expoScale: 0.01}),
  Object.freeze({name: 'Quick', rcMax: 255, superMax: 200, rcScale: 0.01, superScale: 10, expoScale: 0.01}),
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
    MOTOR_TEST_ACTIVE: 'أنهِ جلسة اختبار المحركات من الزر الثابت أسفل شاشة المحركات، ثم أعد القراءة.',
    CONFIGURATION_BUSY: 'هناك معاملة إعدادات أخرى جارية. انتظر ثم أعد المحاولة.',
    STALE_BASE: 'تغيّرت قيم PID على متحكم الطيران منذ آخر قراءة. أعد القراءة قبل الحفظ.',
    INVALID_CONFIGURATION: 'هناك قيمة PID أو Rates أو Filters خارج الحدود الرسمية أو حد Nyquist الآمن.',
  })[reason];
}
function saveMessage(outcome: PidSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'SAVED_VERIFIED': return {text: 'حُفظت إعدادات PID وRates وFilters المتغيرة، وأكدت القراءة الراجعة تطابقها.', warning: false};
    case 'NO_CHANGES': return {text: 'لا توجد تغييرات جديدة.', warning: false};
    case 'SAVED_UNVERIFIED': return {text: 'أُقر الحفظ، لكن تعذرت القراءة الراجعة. أعد القراءة قبل الطيران.', warning: true};
    case 'UNCONFIRMED': return {text: `نتيجة الكتابة غير مؤكدة عند مرحلة ${outcome.stage}. لا تعِد الحفظ تلقائيًا؛ أعد الاتصال والقراءة.`, warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء العملية.', warning: true};
    case 'FAILED': return {text: 'فشل الحفظ قبل تأكيد الاستمرار. لم يدّع التطبيق نجاحًا.', warning: true};
  }
}
function issueMessage(issue: ReturnType<typeof validatePidTuningDraft>[number]): string {
  return ({
    PID_GAIN_INVALID: 'إحدى قيم P/I/D خارج 0–250',
    FEEDFORWARD_INVALID: 'إحدى قيم F خارج 0–1000',
    RATES_TYPE_INVALID: 'نوع Rates المقروء غير مدعوم للتحرير الآمن',
    RATES_TYPE_CHANGE_UNSUPPORTED: 'تبديل خوارزمية Rates غير متاح في هذه المرحلة الآمنة',
    RATE_VALUE_INVALID: 'إحدى قيم Rates خارج حدود الخوارزمية الحالية',
    THROTTLE_CURVE_INVALID: 'منحنى أو حد الخانق خارج المدى المسموح',
    FILTER_VALUE_INVALID: 'إحدى قيم الفلاتر خارج حدود Betaflight',
    FILTER_ORDER_INVALID: 'حدود Min/Max للفلاتر غير متناسقة',
    FILTER_CAPABILITY_UNPROVEN: 'لا يمكن تفعيل أو تعطيل وضع فلتر لم تثبته القراءة الحالية',
    FILTER_RATE_UNKNOWN: 'لا يمكن تعديل الفلاتر دون معرفة Gyro وPID loop rate',
    FILTER_EXCEEDS_NYQUIST: 'أحد ترددات الفلاتر يبلغ أو يتجاوز حد Nyquist',
  })[issue];
}
function NumericField({label, value, min = 0, max, disabled, onChange, testID}: {label: string; value: number; min?: number; max: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  const apply = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next))));
  return <View style={styles.numericField}><Text style={styles.fieldLabel}>{label}</Text><SharedStepper value={String(value)} onDecrement={() => apply(value - 1)} onIncrement={() => apply(value + 1)} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} onChangeText={text => { const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) apply(parsed); }} accessibilityLabel={label} testID={testID} /><Text style={styles.rangeHint}>{min}–{max}</Text></View>;
}
function ScaledNumericField({label, rawValue, rawMin, rawMax, scale, disabled, onChange, testID}: {label: string; rawValue: number; rawMin: number; rawMax: number; scale: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  const decimals = scale < 1 ? 2 : 0;
  const apply = (next: number) => onChange(Math.min(rawMax, Math.max(rawMin, Math.round(next))));
  return <View style={styles.numericField}><Text style={styles.fieldLabel}>{label}</Text><SharedStepper value={(rawValue * scale).toFixed(decimals)} onDecrement={() => apply(rawValue - 1)} onIncrement={() => apply(rawValue + 1)} decrementDisabled={rawValue <= rawMin} incrementDisabled={rawValue >= rawMax} disabled={disabled} keyboardType="decimal-pad" onChangeText={text => { const parsed = Number.parseFloat(text.replace(',', '.')); if (Number.isFinite(parsed)) apply(parsed / scale); }} accessibilityLabel={label} testID={testID} /><Text style={styles.rangeHint}>{(rawMin * scale).toFixed(decimals)}–{(rawMax * scale).toFixed(decimals)}</Text></View>;
}

function AxisCard({axisKey, title, subtitle, value, disabled, update}: {axisKey: PidAxisKey; title: string; subtitle: string; value: PidAxisDraft; disabled: boolean; update: (axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => void}) {
  return <View style={styles.axisCard} testID={`pid-axis-${axisKey}`}><View><Text style={styles.axisTitle}>{title}</Text><Text style={styles.axisSubtitle}>{subtitle}</Text></View><View style={styles.fieldsRow}><NumericField label="P" value={value.p} max={250} disabled={disabled} onChange={next => update(axisKey, 'p', next)} testID={`pid-${axisKey}-p`} /><NumericField label="I" value={value.i} max={250} disabled={disabled} onChange={next => update(axisKey, 'i', next)} testID={`pid-${axisKey}-i`} /><NumericField label="D" value={value.d} max={250} disabled={disabled} onChange={next => update(axisKey, 'd', next)} testID={`pid-${axisKey}-d`} /><NumericField label="F" value={value.f} max={1000} disabled={disabled} onChange={next => update(axisKey, 'f', next)} testID={`pid-${axisKey}-f`} /></View></View>;
}

function RateAxisCard({axisKey, title, value, rates, disabled, update}: {axisKey: PidAxisKey; title: string; value: RateAxisDraft; rates: RatesDraft; disabled: boolean; update: (axis: PidAxisKey, term: keyof RateAxisDraft, value: number) => void}) {
  const definition = RATE_TYPES[rates.type];
  if (definition === undefined) return null;
  const actualLike = rates.type === 1 || rates.type === 3;
  const maxRateLike = rates.type === 3 || rates.type === 4;
  return <View style={styles.axisCard} testID={`pid-rate-axis-${axisKey}`}><Text style={styles.axisTitle}>{title}</Text><View style={styles.fieldsRow}><ScaledNumericField label={actualLike ? 'حساسية المركز °/s' : 'RC Rate'} rawValue={value.rcRate} rawMin={1} rawMax={definition.rcMax} scale={definition.rcScale} disabled={disabled} onChange={next => update(axisKey, 'rcRate', next)} testID={`pid-rate-${axisKey}-rc`} /><ScaledNumericField label={maxRateLike ? 'أقصى معدل °/s' : 'Rate'} rawValue={value.superRate} rawMin={0} rawMax={definition.superMax} scale={definition.superScale} disabled={disabled} onChange={next => update(axisKey, 'superRate', next)} testID={`pid-rate-${axisKey}-super`} /><ScaledNumericField label={rates.type === 1 ? 'Expo %' : 'Expo'} rawValue={value.expo} rawMin={0} rawMax={100} scale={definition.expoScale} disabled={disabled} onChange={next => update(axisKey, 'expo', next)} testID={`pid-rate-${axisKey}-expo`} /><NumericField label="Rate limit °/s" value={value.limit} min={200} max={1998} disabled={disabled} onChange={next => update(axisKey, 'limit', next)} testID={`pid-rate-${axisKey}-limit`} /></View></View>;
}

export default function PidTuningScreen({sessionKey, active, onOpenMotors, onDirtyChange, controller = pidTuningController}: PidTuningScreenProps): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions(); const {maxWidth} = useContentEnvelope(true); const wide = width / Math.max(fontScale, 1) >= 1040;
  const [phase, setPhase] = useState<Phase>('IDLE'); const [snapshot, setSnapshot] = useState<MspPidTuningSnapshot>(); const [draft, setDraft] = useState<PidTuningDraft>(); const [loadOutcome, setLoadOutcome] = useState<PidLoadOutcome>(); const [saveOutcome, setSaveOutcome] = useState<PidSaveOutcome>(); const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => { if (!active || sessionKey === undefined) return; let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined); controller.load(sessionKey).then(outcome => { if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') { setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot)); setPhase('READY'); } else { setSnapshot(undefined); setDraft(undefined); setPhase('ERROR'); } }); return () => { cancelled = true; }; }, [active, controller, reloadToken, sessionKey]);
  const dirty = snapshot !== undefined && draft !== undefined && !pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]); useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined ? [] : validatePidTuningDraft(draft, snapshot), [draft, snapshot]);
  const update = useCallback((axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, [axis]: Object.freeze({...current[axis], [term]: value})})); setSaveOutcome(undefined); }, []);
  const updateRate = useCallback((axis: PidAxisKey, term: keyof RateAxisDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, rates: Object.freeze({...current.rates, [axis]: Object.freeze({...current.rates[axis], [term]: value})})})); setSaveOutcome(undefined); }, []);
  const updateThrottle = useCallback((term: keyof Omit<RatesDraft, PidAxisKey | 'type'>, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, rates: Object.freeze({...current.rates, [term]: value})})); setSaveOutcome(undefined); }, []);
  const updateFilter = useCallback((term: keyof FiltersDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, filters: Object.freeze({...current.filters, [term]: value})})); setSaveOutcome(undefined); }, []);
  const reload = useCallback(() => { const perform = () => setReloadToken(value => value + 1); if (!dirty) return perform(); Alert.alert('تجاهل تغييرات PID؟', 'ستُستبدل القيم الحالية بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]); }, [dirty]);
  const save = useCallback(async () => { if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0) return; setPhase('SAVING'); const outcome = await controller.save(sessionKey, snapshot, draft); setSaveOutcome(outcome); if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') { setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot)); } setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY'); }, [controller, draft, issues.length, sessionKey, snapshot]);
  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome); const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة إعدادات PID من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;
  const gyroNyquist = snapshot?.gyroSampleRateHz === undefined ? undefined : snapshot.gyroSampleRateHz / 2;
  const pidNyquist = snapshot?.gyroSampleRateHz === undefined || snapshot.pidProcessDenom === undefined || snapshot.pidProcessDenom < 1 ? undefined : snapshot.gyroSampleRateHz / snapshot.pidProcessDenom / 2;
  const filtersEditable = gyroNyquist !== undefined && pidNyquist !== undefined;

  return <View style={styles.root} testID="pid-screen"><ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
    <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.eyebrow}>PID TUNING · BETAFLIGHT API 1.47</Text><Text style={styles.title}>ضبط PID وRates والفلاتر</Text><Text style={styles.subtitle}>اضبط استجابة المحاور ومعدلات الحركة والفلاتر الفعالة. الحفظ لا يبدأ إلا بعد إثبات DISARMED، ثم تُحفظ المجموعات المتغيرة فقط في EEPROM وتُقرأ مجددًا للتحقق.</Text></View><View style={styles.profileBadges}><View style={styles.profileBadge} testID="pid-active-profile"><Text style={styles.profileLabel}>PID Profile النشط</Text><Text style={styles.profileValue}>{snapshot === undefined ? '—' : `${snapshot.pidProfileIndex + 1} / ${snapshot.pidProfileCount}`}</Text></View><View style={styles.profileBadge} testID="pid-active-rates-profile"><Text style={styles.profileLabel}>Rates Profile النشط</Text><Text style={styles.profileValue}>{snapshot === undefined ? '—' : snapshot.controlRateProfileIndex + 1}</Text></View></View></View>
    <View style={styles.danger}><Text style={styles.dangerTitle}>تغيير PID قد يجعل الطائرة غير مستقرة</Text><Text style={styles.dangerText}>احفظ القيم الأصلية، غيّر تدريجيًا، وانزع المراوح أثناء الإعداد. لا يثبت نجاح MSP أن الضبط مناسب للطيران.</Text></View>
    <View style={styles.hardwareNotice}><Text style={styles.hardwareTitle}>REQUIRES HARDWARE TEST</Text><Text style={styles.hardwareText}>الترميز والقراءة الراجعة مختبران آليًا، لكن النتيجة الديناميكية لا يمكن اعتمادها دون Flight Controller وطائرة حقيقية واختبار متدرج آمن.</Text></View>
    {loadingMessage !== undefined ? <View style={styles.warning} testID="pid-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح شاشة المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} />}</View> : null}
    {draft !== undefined ? <>
      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>المعاملات الأساسية</Text><Text style={styles.sectionHint}>P للتصحيح الحالي، I للخطأ المتراكم، D لتخميد التغير، وF لتتبع الأمر. الحدود من Betaflight 2025.12.2.</Text></View>
      <View style={[styles.axisGrid, wide && styles.axisGridWide]}>{AXES.map(axis => <AxisCard key={axis.key} axisKey={axis.key} title={axis.title} subtitle={axis.subtitle} value={draft[axis.key]} disabled={phase !== 'READY'} update={update} />)}</View>
      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Rates</Text><Text style={styles.sectionHint}>الخوارزمية الحالية: {RATE_TYPES[draft.rates.type]?.name ?? `غير معروفة (${draft.rates.type})`}. لا نبدّل نوع الخوارزمية تلقائيًا لأن المعاني والمدى يتغيران جذريًا بين الأنواع.</Text></View>
      <View style={[styles.axisGrid, wide && styles.axisGridWide]}>{AXES.map(axis => <RateAxisCard key={axis.key} axisKey={axis.key} title={axis.title} value={draft.rates[axis.key]} rates={draft.rates} disabled={phase !== 'READY'} update={updateRate} />)}</View>
      <View style={styles.card} testID="pid-throttle-rates"><Text style={styles.sectionTitle}>منحنى وحدّ الخانق</Text><Text style={styles.sectionHint}>القيم نسب مئوية خام موثقة في MSP_RC_TUNING. تغيير حد الخانق قد يقلل الدفع الأقصى.</Text><View style={styles.fieldsRow}><NumericField label="Throttle mid %" value={draft.rates.throttleMid} max={100} disabled={phase !== 'READY'} onChange={next => updateThrottle('throttleMid', next)} testID="pid-throttle-mid" /><NumericField label="Throttle expo %" value={draft.rates.throttleExpo} max={100} disabled={phase !== 'READY'} onChange={next => updateThrottle('throttleExpo', next)} testID="pid-throttle-expo" /><NumericField label="Hover %" value={draft.rates.throttleHover} max={100} disabled={phase !== 'READY'} onChange={next => updateThrottle('throttleHover', next)} testID="pid-throttle-hover" /><NumericField label="Limit %" value={draft.rates.throttleLimitPercent} min={25} max={100} disabled={phase !== 'READY'} onChange={next => updateThrottle('throttleLimitPercent', next)} testID="pid-throttle-limit-percent" /></View><View style={styles.choiceRow}>{[{value: 0, label: 'إيقاف'}, {value: 1, label: 'Scale'}, {value: 2, label: 'Clip'}].map(option => <Pressable key={option.value} disabled={phase !== 'READY'} onPress={() => updateThrottle('throttleLimitType', option.value)} style={[styles.choice, draft.rates.throttleLimitType === option.value && styles.choiceSelected]} testID={`pid-throttle-limit-${option.value}`}><Text style={[styles.choiceText, draft.rates.throttleLimitType === option.value && styles.choiceTextSelected]}>{option.label}</Text></Pressable>)}</View></View>

      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Filters</Text><Text style={styles.sectionHint}>تُعدّل فقط أوضاع الفلاتر النشطة التي أثبتتها القراءة. لا يفعّل التطبيق ميزة غير مثبتة في بناء الـFC ولا يغيّر نوع الفلتر.</Text></View>
      {!filtersEditable ? <View style={styles.warning}><Text style={styles.warningText}>تعذرت معرفة Gyro/PID loop rate؛ الفلاتر معروضة للقراءة فقط ولن يُسمح بكتابتها دون حد Nyquist موثوق.</Text></View> : <View style={styles.rateEvidence}><Text style={styles.readout}>Gyro Nyquist: {gyroNyquist} Hz</Text><Text style={styles.readout}>D-term Nyquist: {pidNyquist} Hz</Text></View>}
      <View style={[styles.readOnlyGrid, wide && styles.readOnlyGridWide]}>
        <View style={styles.card} testID="pid-gyro-filter"><Text style={styles.sectionTitle}>Gyro LPF1</Text>{snapshot?.filterConfig.gyroLpf1DynamicMinHz !== undefined && snapshot.filterConfig.gyroLpf1DynamicMinHz > 0 ? <><Text style={styles.sectionHint}>الوضع الديناميكي مثبت من القراءة؛ Min يجب أن يبقى أصغر من Max وحد Nyquist.</Text><View style={styles.fieldsRow}><NumericField label="Dynamic min Hz" value={draft.filters.gyroLpf1DynamicMinHz} min={1} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('gyroLpf1DynamicMinHz', next)} testID="pid-gyro-dynamic-min" /><NumericField label="Dynamic max Hz" value={draft.filters.gyroLpf1DynamicMaxHz} min={1} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('gyroLpf1DynamicMaxHz', next)} testID="pid-gyro-dynamic-max" /></View></> : <><Text style={styles.sectionHint}>الوضع الثابت مثبت من القراءة؛ 0 يعطّل LPF1.</Text><NumericField label="Static cutoff Hz" value={draft.filters.gyroLpf1StaticHz} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('gyroLpf1StaticHz', next)} testID="pid-gyro-static" /></>}</View>
        <View style={styles.card} testID="pid-dterm-filter"><Text style={styles.sectionTitle}>D-term LPF1</Text>{snapshot?.filterConfig.dtermLpf1DynamicMinHz !== undefined && snapshot.filterConfig.dtermLpf1DynamicMinHz > 0 ? <><Text style={styles.sectionHint}>الوضع الديناميكي مثبت من القراءة؛ يحكمه PID loop Nyquist.</Text><View style={styles.fieldsRow}><NumericField label="Dynamic min Hz" value={draft.filters.dtermLpf1DynamicMinHz} min={1} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dtermLpf1DynamicMinHz', next)} testID="pid-dterm-dynamic-min" /><NumericField label="Dynamic max Hz" value={draft.filters.dtermLpf1DynamicMaxHz} min={1} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dtermLpf1DynamicMaxHz', next)} testID="pid-dterm-dynamic-max" /></View></> : <><Text style={styles.sectionHint}>الوضع الثابت مثبت من القراءة؛ 0 يعطّل LPF1.</Text><NumericField label="Static cutoff Hz" value={draft.filters.dtermLpf1StaticHz} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dtermLpf1StaticHz', next)} testID="pid-dterm-static" /></>}</View>
      </View>
      <View style={styles.card} testID="pid-dynamic-notch"><Text style={styles.sectionTitle}>Dynamic Notch</Text>{snapshot?.filterConfig.dynamicNotchCount !== undefined && snapshot.filterConfig.dynamicNotchCount > 0 ? <><Text style={styles.sectionHint}>الميزة نشطة ومثبتة من القراءة. لا تسمح هذه المرحلة بتعطيلها أو تفعيلها على بناء لم يثبت دعمه.</Text><View style={styles.fieldsRow}><NumericField label="عدد الفلاتر" value={draft.filters.dynamicNotchCount} min={1} max={7} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dynamicNotchCount', next)} testID="pid-notch-count" /><NumericField label="Q ×100" value={draft.filters.dynamicNotchQ} min={1} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dynamicNotchQ', next)} testID="pid-notch-q" /><NumericField label="Min Hz" value={draft.filters.dynamicNotchMinHz} min={20} max={250} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dynamicNotchMinHz', next)} testID="pid-notch-min" /><NumericField label="Max Hz" value={draft.filters.dynamicNotchMaxHz} min={200} max={1000} disabled={phase !== 'READY' || !filtersEditable} onChange={next => updateFilter('dynamicNotchMaxHz', next)} testID="pid-notch-max" /></View></> : <Text style={styles.sectionHint}>القراءة الحالية لا تثبت أن Dynamic Notch نشط؛ لذلك لن نخمن دعم البناء أو نرسِل قيم تفعيل.</Text>}</View>
      {issues.length > 0 ? <View style={styles.danger}><Text style={styles.dangerTitle}>راجع القيم قبل الحفظ</Text><Text style={styles.dangerText}>{issues.map(issueMessage).join(' · ')}</Text></View> : null}
      {statusCopy !== undefined ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
    </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة PID والـrates والفلاتر…</Text> : null}<View style={styles.bottomSpace} />
  </ScrollView><StickyActionBar visible={dirty} summary="تغيّرت إعدادات الضبط" details={['PID · Rates · Filters — تُكتب المجموعات المتغيرة فقط ثم تُقرأ للتحقق']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createPidTuningDraft(snapshot))} disabledReason={issues.length > 0 ? 'صحح القيم أو حدود Nyquist أولًا.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ إعدادات الضبط…" testID="pid-save-bar" /></View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background}, content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md}, hero: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.lg, flexWrap: 'wrap'}, heroCopy: {flex: 1, minWidth: 280, gap: 4}, eyebrow: {...typography.eyebrow, color: colors.accentStrong}, title: {...typography.title, color: colors.textPrimary, textAlign: 'right'}, subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl'}, profileBadges: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, profileBadge: {borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, borderRadius: radii.lg, padding: spacing.md, minWidth: 150}, profileLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, profileValue: {...typography.heading, color: colors.accentStrong, textAlign: 'right'}, danger: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, padding: spacing.md, gap: 3}, dangerTitle: {...typography.heading, color: colors.error, textAlign: 'right'}, dangerText: {...typography.body, color: colors.error, textAlign: 'right', writingDirection: 'rtl'}, hardwareNotice: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3}, hardwareTitle: {...typography.eyebrow, color: colors.accentStrong}, hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', writingDirection: 'rtl'}, sectionHeading: {gap: 3}, sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl'}, axisGrid: {gap: spacing.md}, axisGridWide: {flexDirection: 'row'}, axisCard: {flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md}, axisTitle: {...typography.title, color: colors.accentStrong, textAlign: 'right'}, axisSubtitle: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, numericField: {flexGrow: 1, flexBasis: 100, gap: 5}, fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'center'}, rangeHint: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, readOnlyGrid: {gap: spacing.md}, readOnlyGridWide: {flexDirection: 'row'}, card: {flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm}, readout: {...typography.body, color: colors.textSecondary, textAlign: 'right', fontVariant: ['tabular-nums']}, choiceRow: {flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap'}, choice: {minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.backgroundRaised, paddingHorizontal: spacing.md}, choiceSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft}, choiceText: {...typography.label, color: colors.textSecondary}, choiceTextSelected: {color: colors.accentStrong}, rateEvidence: {flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, flexWrap: 'wrap', borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.sm}, warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.md, gap: spacing.sm}, warningText: {...typography.body, color: colors.warning, textAlign: 'right', writingDirection: 'rtl'}, success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.md}, successText: {...typography.body, color: colors.success, textAlign: 'right'}, inlineAction: {alignSelf: 'flex-start'}, loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl}, bottomSpace: {height: spacing.xl},
});
