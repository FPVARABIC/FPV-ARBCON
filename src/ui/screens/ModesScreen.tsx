import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';
import {
  MODE_RANGE_MAX,
  MODE_RANGE_MIN,
  MODE_RANGE_STEP,
  MODES_AUX_CHANNEL_COUNT,
  conditionsForMode,
  createModesConfigurationDraft,
  modeArabicName,
  modeIsActive,
  modesDraftsEqual,
  validateModesDraft,
  type ModeConditionDraft,
  type ModesConfigurationDraft,
  type MspModeDefinition,
  type MspModesConfiguration,
  type MspRcChannels,
  type MspStatusExDiagnostics,
  type TelemetryValue,
} from '../../core';
import {
  FC_STATUS_TELEMETRY_POLL_ID,
  RECEIVER_CHANNELS_POLL_ID,
  acquireReceiverTelemetry,
  modesConfigurationController,
  useTelemetryValue,
  type ModesBlockReason,
  type ModesLoadOutcome,
  type ModesSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {StickyActionBar} from '../components/editing';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, IconButton, Stepper as SharedStepper, ToggleSwitch} from '../components/controls';

export interface ModesControllerPort {
  load(key: SetupUiSessionKey): Promise<ModesLoadOutcome>;
  save(key: SetupUiSessionKey, original: MspModesConfiguration, draft: ModesConfigurationDraft): Promise<ModesSaveOutcome>;
}

export interface ModesScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenMotors: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: ModesControllerPort;
}

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function valueOf<T>(value: TelemetryValue<T>): T | undefined {
  return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined;
}

function blockMessage(reason: ModesBlockReason): string {
  return ({
    DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.',
    IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.',
    UNSUPPORTED_FIRMWARE: 'إصدار البرنامج الثابت في هذه اللوحة غير مدعوم لهذه الشاشة. حدّث البرنامج الثابت.',
    APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل القراءة أو الحفظ.',
    LINK_RECOVERING: 'الرابط التسلسلي يتعافى. انتظر قليلًا ثم أعد القراءة.',
    FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران ARMED. انزع المراوح ثم افصل التسليح.',
    ARMED_STATE_UNKNOWN: 'تعذر إثبات أن متحكم الطيران DISARMED؛ لم تُرسل أي كتابة.',
    MOTOR_TEST_ACTIVE: 'جلسة اختبار المحركات نشطة. افتح المحركات واضغط «إنهاء جلسة الاختبار» ثم أعد القراءة.',
    CONFIGURATION_BUSY: 'توجد معاملة إعدادات أخرى قيد التنفيذ.',
    STALE_BASE: 'تغيرت الأوضاع في المتحكم منذ القراءة. أعد القراءة وراجع القيم.',
    INVALID_CONFIGURATION: 'يوجد شرط وضع غير صالح. راجع AUX والنطاق والربط.',
  } as const)[reason];
}

function saveMessage(outcome: ModesSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES': return {text: 'لا توجد تغييرات لإرسالها.', warning: false};
    case 'SAVED_VERIFIED': return {text: 'حُفظت جميع شروط الأوضاع وتطابقت القراءة الراجعة من متحكم الطيران.', warning: false};
    case 'SAVED_UNVERIFIED': return {text: 'أقرّ المتحكم الحفظ، لكن تعذر إثبات القيم بالقراءة الراجعة. أعد الاتصال واقرأ قبل تعديل آخر.', warning: true};
    case 'UNCONFIRMED': return {text: outcome.stage.kind === 'EEPROM' ? 'نتيجة حفظ EEPROM غير مؤكدة. لا تكرر الحفظ؛ أعد الاتصال واقرأ أولًا.' : `نتيجة كتابة خانة الوضع ${outcome.stage.index + 1} غير مؤكدة. لا تكرر العملية؛ أعد الاتصال واقرأ أولًا.`, warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء العملية. أعد الاتصال واقرأ القيم.', warning: true};
    case 'FAILED': return {text: 'فشلت العملية قبل اكتمال التحقق.', warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
  }
}

const ModeActiveBadge = React.memo(function ModeActiveBadge({sessionKey, active, definition}: {sessionKey?: SetupUiSessionKey; active: boolean; definition: MspModeDefinition}) {
  const status = useTelemetryValue<MspStatusExDiagnostics>(sessionKey?.sessionId ?? '', FC_STATUS_TELEMETRY_POLL_ID, active);
  const snapshot = valueOf(status);
  const enabled = snapshot !== undefined && modeIsActive(definition, snapshot.flightModeFlagsLow32, snapshot.readiness.extraFlightModeFlagBytes);
  return <View style={[styles.activeBadge, enabled && styles.activeBadgeOn]} testID={`modes-active-${definition.permanentId}`}>
    <View style={[styles.activeDot, enabled && styles.activeDotOn]} />
    <Text style={[styles.activeText, enabled && styles.activeTextOn]}>{enabled ? 'نشط الآن' : 'غير نشط'}</Text>
  </View>;
});

const RangeLiveValue = React.memo(function RangeLiveValue({sessionKey, active, condition}: {sessionKey?: SetupUiSessionKey; active: boolean; condition: Extract<ModeConditionDraft, {kind: 'RANGE'}>}) {
  const telemetry = useTelemetryValue<MspRcChannels>(sessionKey?.sessionId ?? '', RECEIVER_CHANNELS_POLL_ID, active);
  const value = valueOf(telemetry)?.channels[condition.auxChannelIndex + 4];
  const percent = value === undefined ? 0 : Math.max(0, Math.min(100, ((value - MODE_RANGE_MIN) / (MODE_RANGE_MAX - MODE_RANGE_MIN)) * 100));
  const inside = value !== undefined && value >= condition.start && value <= condition.end;
  return <View style={styles.liveRange} testID="modes-live-range">
    <View style={styles.liveTrack}>
      <View style={[styles.selectedRange, {left: `${((condition.start - MODE_RANGE_MIN) / (MODE_RANGE_MAX - MODE_RANGE_MIN)) * 100}%`, width: `${((condition.end - condition.start) / (MODE_RANGE_MAX - MODE_RANGE_MIN)) * 100}%`}]} />
      {value !== undefined ? <View style={[styles.liveMarker, inside && styles.liveMarkerInside, {left: `${percent}%`}]} /> : null}
    </View>
    <Text style={[styles.liveRangeText, inside && styles.liveRangeTextInside]}>القيمة الحية: {value ?? '—'}{inside ? ' · داخل النطاق' : ''}</Text>
  </View>;
});

function Stepper({label, value, min, max, step, disabled, onChange, testID}: {label: string; value: number; min: number; max: number; step: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  return (
    <View style={styles.stepperField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <SharedStepper value={String(value)} onDecrement={() => onChange(Math.max(min, value - step))} onIncrement={() => onChange(Math.min(max, value + step))} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} accessibilityLabel={label} testID={testID} />
    </View>
  );
}

function LogicToggle({value, disabled, onChange}: {value: 0 | 1; disabled: boolean; onChange: (value: 0 | 1) => void}) {
  return <View style={styles.logicRow}>
    <Text style={styles.fieldLabel}>المنطق</Text>
    <View style={styles.segmented}>
      {([{value: 0 as const, label: 'OR'}, {value: 1 as const, label: 'AND'}]).map(option => <Pressable key={option.value} disabled={disabled} onPress={() => onChange(option.value)} style={[styles.segment, value === option.value && styles.segmentSelected]}><Text style={[styles.segmentText, value === option.value && styles.segmentTextSelected]}>{option.label}</Text></Pressable>)}
    </View>
  </View>;
}

function RangeConditionRow({index, condition, sessionKey, active, disabled, onChange, onRemove}: {index: number; condition: Extract<ModeConditionDraft, {kind: 'RANGE'}>; sessionKey?: SetupUiSessionKey; active: boolean; disabled: boolean; onChange: (value: ModeConditionDraft) => void; onRemove: () => void}) {
  return <View style={styles.condition} testID={`modes-condition-${index}`}>
    <View style={styles.conditionHeader}><View><Text style={styles.conditionType}>نطاق AUX</Text><Text style={styles.conditionHint}>يُفعّل عندما تدخل القناة النطاق المحدد.</Text></View><Pressable disabled={disabled} onPress={onRemove} style={styles.removeButton}><Text style={styles.removeText}>حذف</Text></Pressable></View>
    <View style={styles.fieldsRow}>
      <Stepper label="قناة AUX" value={condition.auxChannelIndex + 1} min={1} max={MODES_AUX_CHANNEL_COUNT} step={1} disabled={disabled} onChange={value => onChange({...condition, auxChannelIndex: value - 1})} testID={`modes-aux-${index}`} />
      <Stepper label="البداية µs" value={condition.start} min={MODE_RANGE_MIN} max={condition.end - MODE_RANGE_STEP} step={MODE_RANGE_STEP} disabled={disabled} onChange={value => onChange({...condition, start: value})} testID={`modes-start-${index}`} />
      <Stepper label="النهاية µs" value={condition.end} min={condition.start + MODE_RANGE_STEP} max={MODE_RANGE_MAX} step={MODE_RANGE_STEP} disabled={disabled} onChange={value => onChange({...condition, end: value})} testID={`modes-end-${index}`} />
      <LogicToggle value={condition.logic} disabled={disabled} onChange={logic => onChange({...condition, logic})} />
    </View>
    <RangeLiveValue sessionKey={sessionKey} active={active} condition={condition} />
  </View>;
}

function LinkConditionRow({index, condition, definitions, disabled, onChange, onRemove}: {index: number; condition: Extract<ModeConditionDraft, {kind: 'LINK'}>; definitions: readonly MspModeDefinition[]; disabled: boolean; onChange: (value: ModeConditionDraft) => void; onRemove: () => void}) {
  const targets = definitions.filter(definition => definition.permanentId !== 0 && definition.permanentId !== condition.permanentId);
  const targetIndex = Math.max(0, targets.findIndex(target => target.permanentId === condition.linkedTo));
  const target = targets[targetIndex];
  const cycle = (direction: number) => {
    if (targets.length === 0) return;
    const next = targets[(targetIndex + direction + targets.length) % targets.length];
    onChange({...condition, linkedTo: next.permanentId});
  };
  return <View style={styles.condition} testID={`modes-condition-${index}`}>
    <View style={styles.conditionHeader}><View><Text style={styles.conditionType}>ربط بوضع آخر</Text><Text style={styles.conditionHint}>يتبع حالة وضع موجود بدل قراءة قناة AUX مباشرة.</Text></View><Pressable disabled={disabled} onPress={onRemove} style={styles.removeButton}><Text style={styles.removeText}>حذف</Text></Pressable></View>
    <View style={styles.fieldsRow}>
      <View style={styles.linkField}><Text style={styles.fieldLabel}>الوضع المرتبط</Text><View style={styles.linkCycler}><IconButton icon="chevron-back" accessibilityLabel="الوضع السابق" onPress={() => cycle(-1)} disabled={disabled || targets.length < 2} appearance="outlined" /><Text style={styles.linkValue}>{target === undefined ? 'لا يوجد هدف صالح' : modeArabicName(target.name)}</Text><IconButton icon="chevron-forward" accessibilityLabel="الوضع التالي" onPress={() => cycle(1)} disabled={disabled || targets.length < 2} appearance="outlined" /></View></View>
      <LogicToggle value={condition.logic} disabled={disabled} onChange={logic => onChange({...condition, logic})} />
    </View>
  </View>;
}

function ModeCard({definition, snapshot, draft, sessionKey, active, disabled, onAdd, onUpdate, onRemove}: {definition: MspModeDefinition; snapshot: MspModesConfiguration; draft: ModesConfigurationDraft; sessionKey?: SetupUiSessionKey; active: boolean; disabled: boolean; onAdd: (condition: ModeConditionDraft) => void; onUpdate: (index: number, condition: ModeConditionDraft) => void; onRemove: (index: number) => void}) {
  const rows = draft.conditions.map((condition, index) => ({condition, index})).filter(item => item.condition.permanentId === definition.permanentId);
  const canAdd = draft.conditions.length < snapshot.capacity;
  const linkTargets = snapshot.definitions.filter(item => item.permanentId !== 0 && item.permanentId !== definition.permanentId);
  return <View style={styles.modeCard} testID={`modes-mode-${definition.permanentId}`}>
    <View style={styles.modeHeader}><View style={styles.modeTitleGroup}><Text style={styles.modeTitle}>{modeArabicName(definition.name)}</Text><Text style={styles.modeRaw}>{definition.name} · ID {definition.permanentId}</Text></View><ModeActiveBadge sessionKey={sessionKey} active={active} definition={definition} /></View>
    {rows.length === 0 ? <Text style={styles.emptyMode}>لا يوجد شرط لهذا الوضع.</Text> : rows.map(({condition, index}) => condition.kind === 'RANGE'
      ? <RangeConditionRow key={index} index={index} condition={condition} sessionKey={sessionKey} active={active} disabled={disabled} onChange={next => onUpdate(index, next)} onRemove={() => onRemove(index)} />
      : <LinkConditionRow key={index} index={index} condition={condition} definitions={snapshot.definitions} disabled={disabled} onChange={next => onUpdate(index, next)} onRemove={() => onRemove(index)} />)}
    <View style={styles.addRow}>
      <Pressable disabled={disabled || !canAdd} onPress={() => onAdd({kind: 'RANGE', permanentId: definition.permanentId, auxChannelIndex: 0, start: 1300, end: 1700, logic: 0})} style={[styles.addButton, (disabled || !canAdd) && styles.buttonDisabled]} testID={`modes-add-range-${definition.permanentId}`}><Text style={styles.addButtonText}>+ إضافة نطاق AUX</Text></Pressable>
      {definition.permanentId !== 0 && linkTargets.length > 0 ? <Button label="ربط بوضع" onPress={() => onAdd({kind: 'LINK', permanentId: definition.permanentId, linkedTo: linkTargets[0].permanentId, logic: 0})} variant="secondary" icon="plus" disabled={disabled || !canAdd} testID={`modes-add-link-${definition.permanentId}`} /> : null}
    </View>
  </View>;
}

export default function ModesScreen({sessionKey, active, onOpenMotors, onDirtyChange, controller = modesConfigurationController}: ModesScreenProps): React.JSX.Element {
  const {t} = useTranslation();
  const {maxWidth} = useContentEnvelope(true);
  const {width, fontScale} = useWindowDimensions();
  const wide = width / Math.max(1, fontScale) >= 920;
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<MspModesConfiguration>();
  const [draft, setDraft] = useState<ModesConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] = useState<ModesLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<ModesSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');
  const [showUnused, setShowUnused] = useState(true);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    return acquireReceiverTelemetry(sessionKey);
  }, [active, sessionKey]);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    let cancelled = false;
    setPhase('LOADING');
    setSaveOutcome(undefined);
    controller.load(sessionKey).then(outcome => {
      if (cancelled) return;
      setLoadOutcome(outcome);
      if (outcome.kind === 'LOADED') {
        setSnapshot(outcome.snapshot);
        setDraft(createModesConfigurationDraft(outcome.snapshot));
        setPhase('READY');
      } else {
        setSnapshot(undefined);
        setDraft(undefined);
        setPhase('ERROR');
      }
    });
    return () => { cancelled = true; };
  }, [active, controller, reloadToken, sessionKey]);

  const dirty = snapshot !== undefined && draft !== undefined && !modesDraftsEqual(createModesConfigurationDraft(snapshot), draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined || snapshot === undefined ? [] : validateModesDraft(draft, snapshot), [draft, snapshot]);

  const updateCondition = useCallback((index: number, condition: ModeConditionDraft) => {
    setDraft(current => current === undefined ? current : Object.freeze({conditions: Object.freeze(current.conditions.map((item, itemIndex) => itemIndex === index ? Object.freeze(condition) : item))}));
    setSaveOutcome(undefined);
  }, []);
  const addCondition = useCallback((condition: ModeConditionDraft) => {
    setDraft(current => current === undefined ? current : Object.freeze({conditions: Object.freeze([...current.conditions, Object.freeze(condition)])}));
    setSaveOutcome(undefined);
  }, []);
  const removeCondition = useCallback((index: number) => {
    setDraft(current => current === undefined ? current : Object.freeze({conditions: Object.freeze(current.conditions.filter((_, itemIndex) => itemIndex !== index))}));
    setSaveOutcome(undefined);
  }, []);

  const reload = useCallback(() => {
    const perform = () => setReloadToken(value => value + 1);
    if (!dirty) return perform();
    Alert.alert('تجاهل تغييرات الأوضاع؟', 'ستُستبدل الشروط الحالية بقراءة جديدة من متحكم الطيران.', [
      {text: 'إلغاء', style: 'cancel'},
      {text: 'إعادة القراءة', style: 'destructive', onPress: perform},
    ]);
  }, [dirty]);

  const save = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0) return;
    setPhase('SAVING');
    const outcome = await controller.save(sessionKey, snapshot, draft);
    setSaveOutcome(outcome);
    if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {
      setSnapshot(outcome.snapshot);
      setDraft(createModesConfigurationDraft(outcome.snapshot));
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, draft, issues.length, sessionKey, snapshot]);

  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome);
  const loadingMessage = loadOutcome?.kind === 'REJECTED'
    ? blockMessage(loadOutcome.reason)
    : loadOutcome?.kind === 'FAILED'
      ? 'تعذرت قراءة جدول الأوضاع من متحكم الطيران.'
      : loadOutcome?.kind === 'SESSION_ENDED'
        ? 'انتهت جلسة الاتصال.'
        : undefined;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleDefinitions = snapshot === undefined || draft === undefined ? [] : snapshot.definitions.filter(definition => {
    const matches = normalizedSearch.length === 0 || definition.name.toLowerCase().includes(normalizedSearch) || modeArabicName(definition.name).includes(search.trim());
    return matches && (showUnused || conditionsForMode(draft, definition.permanentId).length > 0);
  });

  return <View style={styles.root} testID="modes-screen">
    <ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
      <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.title}>الأوضاع ومفاتيح AUX</Text><Text style={styles.subtitle}>أنشئ نطاقات القنوات واربط الأوضاع ببعضها، مع حالة حية من متحكم الطيران وحفظ كامل لجدول الشروط ثم قراءة تحقق.</Text></View>{snapshot !== undefined && draft !== undefined ? <View style={styles.capacityBadge}><Text style={styles.capacityLabel}>خانات مستخدمة</Text><Text style={styles.capacityValue}>{draft.conditions.length} / {snapshot.capacity}</Text></View> : null}</View>
      <View style={styles.hardwareNotice}><Text style={styles.hardwareTitle}>{t('hardwareVerification.behaviourTitle')}</Text><Text style={styles.hardwareText}>القراءة والـpayload والتحقق مختبرة آليًا، لكن يجب تحريك مفاتيح جهاز الإرسال ومشاهدة القيمة والحالة الحية على FC حقيقي بعد نزع المراوح.</Text></View>
      <View style={styles.warning}><Text style={styles.warningTitle}>لا تختبر ARM والمراوح مركبة</Text><Text style={styles.warningText}>المؤشر الحي يصف علم الوضع الذي يرسله Betaflight؛ لا يعني أن الاقتراب من الطائرة آمن.</Text></View>
      {loadingMessage !== undefined ? <View style={styles.loadError} testID="modes-load-message"><Text style={styles.loadErrorText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح شاشة المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} testID="modes-open-motors" /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} testID="modes-reload" />}</View> : null}
      {snapshot !== undefined && draft !== undefined ? <>
        <View style={[styles.toolbar, wide && styles.toolbarWide]}><TextInput value={search} onChangeText={setSearch} placeholder="ابحث باسم الوضع…" placeholderTextColor={colors.textMuted} style={styles.search} testID="modes-search" /><View style={styles.showUnused}><Text style={styles.showUnusedText}>إظهار الأوضاع بلا شروط</Text><ToggleSwitch value={showUnused} onValueChange={setShowUnused} accessibilityLabel="إظهار الأوضاع بلا شروط" /></View><Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" /></View>
        {visibleDefinitions.length === 0 ? <View style={styles.emptySearch}><Text style={styles.emptySearchText}>لا توجد أوضاع تطابق البحث أو المرشح.</Text></View> : visibleDefinitions.map(definition => <ModeCard key={definition.permanentId} definition={definition} snapshot={snapshot} draft={draft} sessionKey={sessionKey} active={active} disabled={phase !== 'READY'} onAdd={addCondition} onUpdate={updateCondition} onRemove={removeCondition} />)}
        {issues.length > 0 ? <View style={styles.loadError}><Text style={styles.loadErrorText}>راجع الشروط: {issues.join(' · ')}</Text></View> : null}
        {statusCopy !== undefined ? <View style={statusCopy.warning ? styles.loadError : styles.success}><Text style={statusCopy.warning ? styles.loadErrorText : styles.successText}>{statusCopy.text}</Text></View> : null}
      </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة أسماء الأوضاع وجدول الشروط والروابط…</Text> : null}
      <View style={styles.bottomSpace} />
    </ScrollView>
    <StickyActionBar visible={dirty} summary="تغيّرت شروط الأوضاع" details={[`سيُعاد إرسال جدول الشروط كاملًا (${snapshot?.capacity ?? 20} خانة) ثم الحفظ والتحقق`]} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createModesConfigurationDraft(snapshot))} disabledReason={issues.length > 0 ? 'صحح شروط AUX أو الربط أولًا.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ الأوضاع…" testID="modes-save-bar" />
  </View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md},
  hero: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.lg, flexWrap: 'wrap'},
  heroCopy: {flex: 1, minWidth: 280, gap: 4},
  eyebrow: {...typography.eyebrow, color: colors.accentStrong},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl'},
  capacityBadge: {borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, borderRadius: radii.lg, padding: spacing.md, minWidth: 150},
  capacityLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  capacityValue: {...typography.heading, color: colors.accentStrong, textAlign: 'right', fontVariant: ['tabular-nums']},
  hardwareNotice: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3},
  hardwareTitle: {...typography.eyebrow, color: colors.accentStrong},
  hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', writingDirection: 'rtl'},
  warning: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, padding: spacing.md, gap: 3},
  warningTitle: {...typography.heading, color: colors.error, textAlign: 'right'},
  warningText: {...typography.body, color: colors.error, textAlign: 'right', writingDirection: 'rtl'},
  loadError: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.md, gap: spacing.sm},
  loadErrorText: {...typography.body, color: colors.warning, textAlign: 'right', writingDirection: 'rtl'},
  success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.md},
  successText: {...typography.body, color: colors.success, textAlign: 'right'},
  inlineAction: {alignSelf: 'flex-start'},
  toolbar: {gap: spacing.sm, padding: spacing.md, borderRadius: radii.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft},
  toolbarWide: {flexDirection: 'row', alignItems: 'center'},
  search: {flex: 1, minHeight: 44, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundRaised, paddingHorizontal: spacing.md, color: colors.textPrimary, textAlign: 'right', writingDirection: 'rtl'},
  showUnused: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  showUnusedText: {...typography.body, color: colors.textSecondary},
  modeCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md},
  modeHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap'},
  modeTitleGroup: {gap: 2},
  modeTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'},
  modeRaw: {...typography.caption, color: colors.textMuted, writingDirection: 'ltr'},
  activeBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.sm, paddingVertical: 5},
  activeBadgeOn: {borderColor: colors.success, backgroundColor: colors.successSoft},
  activeDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textMuted},
  activeDotOn: {backgroundColor: colors.success},
  activeText: {...typography.caption, color: colors.textMuted, fontWeight: '700'},
  activeTextOn: {color: colors.success},
  emptyMode: {...typography.body, color: colors.textMuted, textAlign: 'right'},
  condition: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundRaised, padding: spacing.md, gap: spacing.md},
  conditionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md},
  conditionType: {...typography.heading, color: colors.textPrimary, textAlign: 'right'},
  conditionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  removeButton: {minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.error},
  removeText: {...typography.caption, color: colors.error, fontWeight: '700'},
  fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'flex-end'},
  stepperField: {flexGrow: 1, flexBasis: 150, gap: 5},
  linkField: {flexGrow: 1, flexBasis: 250, gap: 5},
  fieldLabel: {...typography.caption, color: colors.textSecondary, textAlign: 'right', fontWeight: '700'},
  /* The link cycler keeps a bespoke row because its centre is a WORD
     (the linked mode's Arabic name), not a number, so the numeric
     Stepper would be the wrong control. Targets and states come from the
     shared IconButton. */
  linkCycler: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  linkValue: {flex: 1, minWidth: 150, textAlign: 'center', textAlignVertical: 'center', borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.textPrimary, fontWeight: '700', paddingTop: 11},
  logicRow: {gap: 5},
  segmented: {flexDirection: 'row', minHeight: 44},
  segment: {minWidth: 58, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface},
  segmentSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft},
  segmentText: {...typography.body, color: colors.textMuted, fontWeight: '700'},
  segmentTextSelected: {color: colors.accentStrong},
  liveRange: {gap: 5},
  liveTrack: {height: 12, borderRadius: 6, backgroundColor: colors.borderSoft, overflow: 'hidden'},
  selectedRange: {position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.accentSoft, borderColor: colors.accentStrong, borderWidth: 1},
  liveMarker: {position: 'absolute', top: 0, width: 4, height: 12, backgroundColor: colors.warning},
  liveMarkerInside: {backgroundColor: colors.success},
  liveRangeText: {...typography.caption, color: colors.textMuted, textAlign: 'right', fontVariant: ['tabular-nums']},
  liveRangeTextInside: {color: colors.success, fontWeight: '700'},
  addRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  addButton: {minHeight: 42, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, backgroundColor: colors.accentStrong},
  addButtonText: {...typography.body, color: colors.white, fontWeight: '700'},
  secondaryButton: {minHeight: 42, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.accentStrong},
  secondaryButtonText: {...typography.body, color: colors.accentStrong, fontWeight: '700'},
  buttonDisabled: {opacity: 0.45},
  emptySearch: {padding: spacing.xl, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surface},
  emptySearchText: {...typography.body, color: colors.textMuted, textAlign: 'center'},
  loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl},
  bottomSpace: {height: spacing.xl},
});
