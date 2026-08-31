/* eslint-disable no-bitwise -- OSD timers and warning flags are firmware bit fields. */
/**
 * OSD - the layout the flight controller will actually fly.
 *
 * WHAT CHANGED AND WHY. The operator could see elements on the preview
 * but could not move them: every preview item was a Pressable whose only
 * handler selected it, and the sole way to change a position was a pair
 * of steppers below the fold. The preview is now the working surface -
 * elements are dragged directly on it (see osd/OsdPreview.tsx for how the
 * gesture is owned) and the steppers remain only as the precise way to
 * nudge a single cell.
 *
 * NOTHING HERE IS DECORATIVE. Every element drawn comes from the count
 * the firmware reported in MSP_OSD_CONFIG, its position is the character
 * cell stored in that element's 16-bit word, its enabled state is that
 * word's profile bit, and the canvas is what MSP_OSD_CANVAS answered.
 * Dragging edits the draft; SAVE is the only thing that writes, and it
 * writes through the same audited controller path as before: changed
 * groups only, then EEPROM, then a read-back that must match before the
 * screen calls itself clean.
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {
  createOsdConfigurationDraft,
  isCellWithinCanvas,
  osdDraftsEqual,
  osdElementName,
  osdElementToken,
  osdPositionX,
  osdPositionY,
  osdVisibleInProfile,
  resolveOsdCanvas,
  setOsdPosition,
  setOsdProfileVisibility,
  validateOsdDraft,
  type MspOsdSnapshot,
  type OsdCell,
  type OsdConfigurationDraft,
} from '../../core';
import {
  osdConfigurationController,
  type OsdBlockReason,
  type OsdLoadOutcome,
  type OsdSaveOutcome,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {isOwnedByDifferentConfigurationSession} from '../../core/state/configurationSessionOwnership';
import {StickyActionBar} from '../components/editing';
import {MIN_TOUCH_TARGET} from '../components/controls/interaction';
import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography, useContentEnvelope} from '../theme';
import {
  Button,
  ChoiceChips,
  NoticeBox,
  Stepper as SharedStepper,
  ToggleSwitch,
} from '../components/controls';
import {OsdPreview, type OsdPreviewElement} from './osd/OsdPreview';
import {partialApplyMessage, unconfirmedWriteMessage} from '../presentation/writeStageNames';

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

export interface OsdControllerPort {
  load(key: SetupUiSessionKey): Promise<OsdLoadOutcome>;
  save(
    key: SetupUiSessionKey,
    original: MspOsdSnapshot,
    draft: OsdConfigurationDraft,
  ): Promise<OsdSaveOutcome>;
}

interface OsdScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenMotors?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: OsdControllerPort;
}

const VIDEO_SYSTEMS = ['تلقائي', 'PAL', 'NTSC', 'HD'] as const;
const UNITS = ['إمبراطوري', 'متري', 'بريطاني'] as const;

function blockMessage(reason: OsdBlockReason): string {
  return (
    {
      DISCONNECTED: 'لا توجد جلسة متصلة.',
      IDENTIFYING: 'بانتظار التحقق من المتحكم.',
      UNSUPPORTED_FIRMWARE: 'إصدار البرنامج الثابت في هذه اللوحة غير مدعوم لهذه الشاشة. حدّث البرنامج الثابت.',
      APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة.',
      LINK_RECOVERING: 'الرابط يتعافى؛ انتظر ثم أعد القراءة.',
      FC_ARMED: 'رُفض الحفظ لأن المتحكم ARMED.',
      ARMED_STATE_UNKNOWN: 'تعذر إثبات DISARMED؛ لم يُرسل شيء.',
      MOTOR_TEST_ACTIVE:
        'جلسة المحركات نشطة. افتح شاشة المحركات واضغط إنهاء جلسة الاختبار.',
      CONFIGURATION_BUSY: 'توجد معاملة إعدادات أخرى قيد التنفيذ.',
      STALE_BASE: 'تغير OSD في المتحكم. أعد القراءة.',
      INVALID_CONFIGURATION: 'توجد قيمة OSD غير صالحة.',
      SESSION_CHANGED: 'تغيّرت جلسة المتحكم منذ إنشاء هذه التعديلات. أعد تحميل الإعدادات قبل الحفظ.',
    } as const
  )[reason];
}

function saveMessage(outcome: OsdSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return {text: 'لا توجد تغييرات.', warning: false};
    case 'SAVED_VERIFIED':
      return {text: 'حُفظ OSD وتطابقت القراءة الراجعة.', warning: false};
    case 'SAVED_UNVERIFIED':
      return {
        text: 'أقر المتحكم الحفظ لكن تعذرت القراءة الراجعة؛ أعد الاتصال ولا تكرر الحفظ.',
        warning: true,
      };
    case 'UNCONFIRMED':
      return {
        text: unconfirmedWriteMessage(outcome.stage.group, 'index' in outcome.stage ? outcome.stage.index : undefined),
        warning: true,
      };
    /* U-R1. RAM moved and flash did not - never «فشل الحفظ». */
    case 'PARTIAL_UNPERSISTED':
      return {
        text: partialApplyMessage(outcome.failedStage.group === 'EEPROM'),
        warning: true,
      };
    case 'SESSION_ENDED':
      return {text: 'انتهت الجلسة أثناء العملية.', warning: true};
    case 'FAILED':
      return {text: 'فشلت العملية قبل التحقق.', warning: true};
    case 'REJECTED':
      return {text: blockMessage(outcome.reason), warning: true};
  }
}

function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  disabled,
  onChange,
  testID,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <SharedStepper
        value={`${value}${suffix}`}
        onDecrement={() => onChange(Math.max(min, value - step))}
        onIncrement={() => onChange(Math.min(max, value + step))}
        decrementDisabled={value <= min}
        incrementDisabled={value >= max}
        disabled={disabled}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

function Choices({
  label,
  value,
  options,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  value: number;
  options: readonly string[];
  disabled: boolean;
  onChange: (value: number) => void;
  testID: string;
}) {
  return (
    <View style={styles.fieldWide}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <ChoiceChips
        accessibilityLabel={label}
        selectedKey={String(value)}
        onSelect={key => onChange(Number(key))}
        disabled={disabled}
        options={options.map((option, index) => ({
          key: String(index),
          label: option,
          testID: `${testID}-${index}`,
        }))}
      />
    </View>
  );
}

export default function OsdScreen({
  sessionKey,
  active,
  onOpenMotors,
  onDirtyChange,
  controller = osdConfigurationController,
}: OsdScreenProps): React.JSX.Element {
  const {t} = useTranslation();
  const {maxWidth} = useContentEnvelope(true);
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<MspOsdSnapshot>();
  const [draft, setDraft] = useState<OsdConfigurationDraft>();
  const [loadOutcome, setLoadOutcome] = useState<OsdLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<OsdSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedElement, setSelectedElement] = useState(0);
  const [dragging, setDragging] = useState(false);

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
        setDraft(createOsdConfigurationDraft(outcome.snapshot));
        setSelectedElement(0);
        setPhase('READY');
      } else {
        setSnapshot(undefined);
        setDraft(undefined);
        setPhase('ERROR');
      }
    }).catch(error => {
      /* load() returns an outcome; a rejection is the case nobody
         planned for, and without this the layout editor stays on its
         loading text with no message and no way to retry. */
      if (cancelled) return;
      setLoadOutcome({kind: 'FAILED', error});
      setSnapshot(undefined);
      setDraft(undefined);
      setPhase('ERROR');
    });
    return () => {
      cancelled = true;
    };
  }, [active, controller, reloadToken, sessionKey]);

  const dirty =
    snapshot !== undefined &&
    draft !== undefined &&
    !osdDraftsEqual(createOsdConfigurationDraft(snapshot), draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(
    () =>
      draft === undefined || snapshot === undefined
        ? []
        : validateOsdDraft(draft, snapshot),
    [draft, snapshot],
  );
  /* DOES THIS SCREEN'S BASELINE BELONG TO THE SESSION IT WOULD WRITE
     THROUGH? `sessionKey` is a prop; the snapshot and the draft are state
     that outlive a prop change by at least one render - and by the entire
     reload if that reload is slow, or forever if it is refused. In that
     window `dirty` is still true and the Save button is still live, over
     a draft built against a DIFFERENT aircraft. The controller refuses
     this too; both layers are required, and this is the one the operator
     can see. See core/state/configurationSessionOwnership. */
  const saveBlockedBySession = isOwnedByDifferentConfigurationSession(snapshot, sessionKey);

  const update = useCallback(
    <K extends keyof Omit<OsdConfigurationDraft, 'elementPositions' | 'statistics' | 'timers'>>(
      key: K,
      value: OsdConfigurationDraft[K],
    ) => {
      setDraft(current =>
        current === undefined ? current : Object.freeze({...current, [key]: value}),
      );
      setSaveOutcome(undefined);
    },
    [],
  );

  const updateElement = useCallback(
    (index: number, transform: (value: number) => number) => {
      setDraft(current =>
        current === undefined
          ? current
          : Object.freeze({
              ...current,
              elementPositions: Object.freeze(
                current.elementPositions.map((value, itemIndex) =>
                  itemIndex === index ? transform(value) : value,
                ),
              ),
            }),
      );
      setSaveOutcome(undefined);
    },
    [],
  );

  const updateStatistic = useCallback((index: number) => {
    setDraft(current =>
      current === undefined
        ? current
        : Object.freeze({
            ...current,
            statistics: Object.freeze(
              current.statistics.map((value, itemIndex) =>
                itemIndex === index ? !value : value,
              ),
            ),
          }),
    );
    setSaveOutcome(undefined);
  }, []);

  const updateTimer = useCallback((index: number, transform: (value: number) => number) => {
    setDraft(current =>
      current === undefined
        ? current
        : Object.freeze({
            ...current,
            timers: Object.freeze(
              current.timers.map((value, itemIndex) =>
                itemIndex === index ? transform(value) & 0xffff : value,
              ),
            ),
          }),
    );
    setSaveOutcome(undefined);
  }, []);

  const reload = useCallback(() => {
    const perform = () => setReloadToken(value => value + 1);
    if (!dirty) return perform();
    Alert.alert('تجاهل تغييرات OSD؟', 'ستُستبدل المسودة بقراءة جديدة من المتحكم.', [
      {text: 'إلغاء', style: 'cancel'},
      {text: 'إعادة القراءة', style: 'destructive', onPress: perform},
    ]);
  }, [dirty]);

  const save = useCallback(async () => {
    if (
      sessionKey === undefined ||
      snapshot === undefined ||
      draft === undefined ||
      issues.length > 0 ||
      saveBlockedBySession
    )
      return;
    setPhase('SAVING');
    let outcome: OsdSaveOutcome;
    try {
      outcome = await controller.save(sessionKey, snapshot, draft);
    } catch (error) {
      outcome = {kind: 'FAILED', error};
    }
    setSaveOutcome(outcome);
    // The draft is replaced by the flight controller's own read-back, and
    // ONLY when the controller proved the write: every other outcome
    // leaves the edits in place and the screen dirty.
    if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {
      setSnapshot(outcome.snapshot);
      setDraft(createOsdConfigurationDraft(outcome.snapshot));
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [saveBlockedBySession, controller, draft, issues.length, sessionKey, snapshot]);

  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome);
  const loadingMessage =
    loadOutcome?.kind === 'REJECTED'
      ? blockMessage(loadOutcome.reason)
      : loadOutcome?.kind === 'FAILED'
        ? 'تعذرت قراءة OSD؛ قد لا يكون OSD موجودًا في بناء البرنامج الثابت.'
        : loadOutcome?.kind === 'SESSION_ENDED'
          ? 'انتهت الجلسة.'
          : undefined;

  const editable = phase === 'READY';
  const activeCanvas = useMemo(
    () =>
      snapshot === undefined
        ? {columns: 30, rows: 16}
        : resolveOsdCanvas(draft?.videoSystem ?? snapshot.config.videoSystem, snapshot.canvas),
    [draft?.videoSystem, snapshot],
  );

  const previewElements = useMemo<readonly OsdPreviewElement[]>(() => {
    if (draft === undefined) return [];
    return draft.elementPositions
      .map((value, index) => ({value, index}))
      .filter(item => osdVisibleInProfile(item.value, draft.selectedProfile))
      .map(item => ({
        index: item.index,
        cell: {column: osdPositionX(item.value), row: osdPositionY(item.value)},
      }));
  }, [draft]);

  const outsideCanvas = useMemo(
    () => previewElements.filter(element => !isCellWithinCanvas(element.cell, activeCanvas)).length,
    [activeCanvas, previewElements],
  );

  const moveElement = useCallback(
    (index: number, cell: OsdCell) => {
      updateElement(index, value => setOsdPosition(value, cell.column, cell.row));
    },
    [updateElement],
  );

  const selectedValue = draft?.elementPositions[selectedElement];
  const selectedVisible =
    selectedValue !== undefined &&
    draft !== undefined &&
    osdVisibleInProfile(selectedValue, draft.selectedProfile);

  return (
    <View style={styles.root} testID="osd-screen">
      <ScrollView
        // A drag owns the pointer; letting the page scroll underneath it
        // would both move the canvas out from under the finger and give
        // the ScrollView a reason to steal the responder.
        scrollEnabled={!dragging}
        contentContainerStyle={[styles.content, {maxWidth}]}>
        <View style={styles.hero}>
          <Text style={styles.title}>العرض على الشاشة</Text>
          <Text style={styles.subtitle}>
            اسحب أي عنصر داخل المعاينة لتغيير موضعه، ثم احفظ ليُكتب في متحكم الطيران.
          </Text>
        </View>

        {loadingMessage !== undefined ? (
          <View style={styles.warning} testID="osd-load-message">
            <Text style={styles.warningText}>{loadingMessage}</Text>
            {loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? (
              <Button
                label="فتح المحركات"
                onPress={() => onOpenMotors?.()}
                variant="secondary"
                icon="fan"
                style={styles.inlineAction}
              />
            ) : (
              <Button
                label="إعادة القراءة"
                onPress={reload}
                variant="secondary"
                icon="refresh-cw"
                style={styles.inlineAction}
              />
            )}
          </View>
        ) : null}

        {draft !== undefined && snapshot !== undefined ? (
          <>
            <OsdPreview
              canvas={activeCanvas}
              elements={previewElements}
              selectedIndex={selectedElement}
              interactive={editable}
              onSelect={setSelectedElement}
              onMove={moveElement}
              onDragStateChange={setDragging}
            />
            <Text style={styles.canvasCaption} testID="osd-canvas-caption">
              {activeCanvas.columns}×{activeCanvas.rows} · الملف {draft.selectedProfile} ·
              العناصر الظاهرة {previewElements.length}
            </Text>
            {outsideCanvas > 0 ? (
              <View style={styles.warning} testID="osd-outside-canvas">
                <Text style={styles.warningText}>
                  {outsideCanvas} عنصرًا خارج حدود اللوحة الحالية؛ اسحبها إلى الداخل أو غيّر نظام
                  الفيديو. لم يُغيَّر أي موضع تلقائيًا.
                </Text>
              </View>
            ) : null}

            {selectedValue !== undefined ? (
              <View style={styles.card} testID="osd-selected-element">
                <View style={styles.cardHeading}>
                  <View style={styles.flexOne}>
                    <Text style={styles.sectionTitle}>{osdElementName(selectedElement)}</Text>
                    <Text style={styles.sectionHint}>
                      {osdElementToken(selectedElement)} · الموضع{' '}
                      <Text style={styles.positionValue} testID="osd-selected-position">
                        {osdPositionX(selectedValue)},{osdPositionY(selectedValue)}
                      </Text>
                    </Text>
                  </View>
                  <View style={styles.visibilityRow}>
                    <Text style={styles.fieldLabel}>{selectedVisible ? 'ظاهر' : 'مخفي'}</Text>
                    <ToggleSwitch
                      value={selectedVisible}
                      disabled={!editable}
                      onValueChange={() =>
                        updateElement(selectedElement, value =>
                          setOsdProfileVisibility(
                            value,
                            draft.selectedProfile,
                            !osdVisibleInProfile(value, draft.selectedProfile),
                          ),
                        )
                      }
                      accessibilityLabel={`إظهار ${osdElementName(selectedElement)}`}
                      testID="osd-element-visible"
                    />
                  </View>
                </View>
                <View style={styles.fieldsRow}>
                  <Stepper
                    label="العمود X"
                    value={osdPositionX(selectedValue)}
                    min={0}
                    max={activeCanvas.columns - 1}
                    disabled={!editable}
                    onChange={x =>
                      updateElement(selectedElement, value =>
                        setOsdPosition(value, x, osdPositionY(value)),
                      )
                    }
                    testID="osd-element-x"
                  />
                  <Stepper
                    label="الصف Y"
                    value={osdPositionY(selectedValue)}
                    min={0}
                    max={activeCanvas.rows - 1}
                    disabled={!editable}
                    onChange={y =>
                      updateElement(selectedElement, value =>
                        setOsdPosition(value, osdPositionX(value), y),
                      )
                    }
                    testID="osd-element-y"
                  />
                </View>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>العناصر</Text>
              <Text style={styles.sectionHint}>
                القائمة مشتقة من عدد العناصر الذي أرسله البرنامج الثابت. اضغط عنصرًا لتحديده، أو
                بدّل الظهور في الملف الحالي.
              </Text>
              <View style={styles.elementGrid}>
                {draft.elementPositions.map((value, index) => {
                  const visible = osdVisibleInProfile(value, draft.selectedProfile);
                  return (
                    <Pressable
                      key={index}
                      onPress={() => setSelectedElement(index)}
                      style={[
                        styles.elementChip,
                        selectedElement === index && styles.elementChipSelected,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{selected: selectedElement === index}}
                      testID={`osd-element-${index}`}>
                      <Pressable
                        disabled={!editable}
                        onPress={() =>
                          updateElement(index, current =>
                            setOsdProfileVisibility(current, draft.selectedProfile, !visible),
                          )
                        }
                        accessibilityRole="switch"
                        accessibilityState={{checked: visible, disabled: !editable}}
                        accessibilityLabel={`إظهار ${osdElementName(index)}`}
                        /* The DOT stays 22px; the TARGET is 44. The dot
                           was the whole control and measured 22x22 - half
                           the minimum - which is a real miss on a phone.
                           react-native-web's Pressable ignores hitSlop
                           (only the legacy Touchable reads it), so the
                           touch area has to be a real box rather than a
                           prop, and the visible dot moves inside it
                           unchanged. */
                        style={styles.elementDotHit}
                        testID={`osd-element-${index}-toggle`}>
                        <View
                          style={[styles.elementDot, visible && styles.elementDotOn]}
                        />
                      </Pressable>
                      <Text numberOfLines={1} style={styles.elementChipText}>
                        {osdElementName(index)}
                      </Text>
                      <Text
                        style={styles.elementPosition}
                        testID={`osd-element-${index}-position`}>
                        {osdPositionX(value)},{osdPositionY(value)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>الملف ونظام الفيديو</Text>
              <View style={styles.choices}>
                {Array.from(
                  {length: Math.max(1, snapshot.config.profileCount)},
                  (_, index) => index + 1,
                ).map(profile => (
                  <Pressable
                    key={profile}
                    disabled={!editable}
                    onPress={() => update('selectedProfile', profile)}
                    style={[
                      styles.choice,
                      draft.selectedProfile === profile && styles.choiceSelected,
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{selected: draft.selectedProfile === profile}}
                    testID={`osd-profile-${profile}`}>
                    <Text
                      style={[
                        styles.choiceText,
                        draft.selectedProfile === profile && styles.choiceTextSelected,
                      ]}>
                      ملف {profile}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.fieldsRow}>
                <Choices
                  label="نظام الفيديو"
                  value={draft.videoSystem}
                  options={VIDEO_SYSTEMS}
                  disabled={!editable}
                  onChange={value => update('videoSystem', value)}
                  testID="osd-video"
                />
                <Choices
                  label="الوحدات"
                  value={draft.units}
                  options={UNITS}
                  disabled={!editable}
                  onChange={value => update('units', value)}
                  testID="osd-units"
                />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>التنبيهات</Text>
              <View style={styles.fieldsRow}>
                <Stepper
                  label="إنذار RSSI"
                  value={draft.rssiAlarmPercent}
                  min={0}
                  max={100}
                  suffix="%"
                  disabled={!editable}
                  onChange={value => update('rssiAlarmPercent', value)}
                  testID="osd-rssi"
                />
                <Stepper
                  label="إنذار جودة الرابط"
                  value={draft.linkQualityAlarmPercent}
                  min={0}
                  max={100}
                  suffix="%"
                  disabled={!editable}
                  onChange={value => update('linkQualityAlarmPercent', value)}
                  testID="osd-lq"
                />
                <Stepper
                  label="إنذار RSSI dBm"
                  value={draft.rssiDbmAlarm}
                  min={-130}
                  max={0}
                  suffix=" dBm"
                  disabled={!editable}
                  onChange={value => update('rssiDbmAlarm', value)}
                  testID="osd-rssi-dbm"
                />
                <Stepper
                  label="إنذار السعة"
                  value={draft.capacityAlarmMah}
                  min={0}
                  max={65535}
                  step={50}
                  suffix=" mAh"
                  disabled={!editable}
                  onChange={value => update('capacityAlarmMah', value)}
                  testID="osd-capacity"
                />
                <Stepper
                  label="إنذار الارتفاع"
                  value={draft.altitudeAlarm}
                  min={0}
                  max={65535}
                  suffix=" m"
                  disabled={!editable}
                  onChange={value => update('altitudeAlarm', value)}
                  testID="osd-altitude"
                />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>إحصاءات ما بعد الرحلة</Text>
              <View style={styles.switchGrid}>
                {draft.statistics.map((enabled, index) => (
                  <Pressable
                    key={index}
                    disabled={!editable}
                    onPress={() => updateStatistic(index)}
                    style={[styles.switchRow, enabled && styles.switchRowOn]}
                    accessibilityRole="switch"
                    accessibilityState={{checked: enabled, disabled: !editable}}
                    testID={`osd-stat-${index}`}>
                    <Text style={styles.switchLabel}>إحصاء {index + 1}</Text>
                    <Text style={[styles.switchState, enabled && styles.switchStateOn]}>
                      {enabled ? 'مفعّل' : 'معطّل'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>المؤقتات</Text>
              {draft.timers.map((timer, index) => (
                <View key={index} style={styles.timerRow}>
                  <Text style={styles.fieldLabel}>المؤقت {index + 1}</Text>
                  <View style={styles.fieldsRow}>
                    <Stepper
                      label="المصدر"
                      value={timer & 0x0f}
                      min={0}
                      max={15}
                      disabled={!editable}
                      onChange={value => updateTimer(index, raw => (raw & 0xfff0) | value)}
                      testID={`osd-timer-${index}-source`}
                    />
                    <Stepper
                      label="الدقة"
                      value={(timer >>> 4) & 0x0f}
                      min={0}
                      max={15}
                      disabled={!editable}
                      onChange={value => updateTimer(index, raw => (raw & 0xff0f) | (value << 4))}
                      testID={`osd-timer-${index}-precision`}
                    />
                    <Stepper
                      label="الإنذار"
                      value={(timer >>> 8) & 0xff}
                      min={0}
                      max={255}
                      suffix=" s"
                      disabled={!editable}
                      onChange={value => updateTimer(index, raw => (raw & 0x00ff) | (value << 8))}
                      testID={`osd-timer-${index}-alarm`}
                    />
                  </View>
                </View>
              ))}
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>التحذيرات</Text>
              <View style={styles.switchGrid}>
                {Array.from(
                  {length: Math.min(32, snapshot.config.warningCount)},
                  (_, index) => index,
                ).map(index => {
                  const enabled = (draft.enabledWarnings & (1 << index)) !== 0;
                  return (
                    <Pressable
                      key={index}
                      disabled={!editable}
                      onPress={() =>
                        update('enabledWarnings', (draft.enabledWarnings ^ (1 << index)) >>> 0)
                      }
                      style={[styles.switchRow, enabled && styles.switchRowOn]}
                      accessibilityRole="switch"
                      accessibilityState={{checked: enabled, disabled: !editable}}
                      testID={`osd-warning-${index}`}>
                      <Text style={styles.switchLabel}>تحذير {index + 1}</Text>
                      <Text style={[styles.switchState, enabled && styles.switchStateOn]}>
                        {enabled ? 'مفعّل' : 'معطّل'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {issues.length > 0 ? (
              <View style={styles.warning}>
                <Text style={styles.warningText}>لا يمكن الحفظ: {issues.join(' · ')}</Text>
              </View>
            ) : null}
            {statusCopy !== undefined ? (
              <View style={statusCopy.warning ? styles.warning : styles.success}>
                <Text style={statusCopy.warning ? styles.warningText : styles.successText}>
                  {statusCopy.text}
                </Text>
              </View>
            ) : null}
          </>
        ) : phase === 'LOADING' ? (
          <Text style={styles.loading}>جارٍ قراءة OSD والـCanvas من المتحكم…</Text>
        ) : null}

        {/* BELOW the preview, and unconditional. Every screen in the
            product carries its hardware-verification notice whether or
            not a controller is attached; putting it here keeps that
            contract without stacking a warning card above the working
            surface. */}
        <NoticeBox variant="hardware" title={t('hardwareVerification.title')}>
          المعاينة تعرض شبكة المحارف والمواضع فوق صورة ثابتة للتقدير البصري فقط؛ الخط النهائي
          والرموز والقص الفعلي تُتحقق في النظارة أو شاشة الفيديو.
        </NoticeBox>
        <View style={styles.bottomSpace} />
      </ScrollView>
      <StickyActionBar
        visible={dirty}
        summary="تغيّر تخطيط OSD"
        details={['تُكتب المجموعات المتغيرة فقط، ثم تُحفظ في ذاكرة المتحكم وتُقرأ للتأكد']}
        saveLabel="حفظ والتحقق"
        discardLabel="تجاهل"
        onSave={save}
        onDiscard={() =>
          snapshot !== undefined && setDraft(createOsdConfigurationDraft(snapshot))
        }
        disabledReason={saveBlockedBySession ? blockMessage('SESSION_CHANGED') : issues.length > 0 ? 'صحح إعدادات OSD أولًا.' : undefined}
        statusMessage={statusCopy?.text}
        statusTone={statusCopy?.warning ? 'warning' : 'normal'}
        busy={phase === 'SAVING'}
        busyLabel="جارٍ حفظ OSD…"
        testID="osd-save-bar"
      />
    </View>
  );
}

/**
 * HOW WIDE AN ELEMENT CHIP HAS TO BE BEFORE ITS LABEL STOPS TRUNCATING.
 *
 * The element grid wraps, and every chip declares `flexGrow: 1` over
 * this basis. `flexGrow` only shares out LEFTOVER space, so the more
 * columns fit, the closer every chip sits to the basis itself - which
 * made a WIDER window produce NARROWER chips and newly ellipsized
 * labels. Measured in Chromium at the shipped widths, with the basis at
 * its previous 180:
 *
 *     768  ->  3 columns, chip 229px, label 149px, 0 truncated
 *    1024  ->  5 columns, chip 187px, label 107px, 4 truncated
 *    1366  ->  7 columns, chip 181px, label 101px, 10 truncated
 *    1920  -> 10 columns, chip 181px, label 101px, 10 truncated
 *
 * The number is derived, not chosen. The widest element name the product
 * actually ships - «نص تسلسلي مخصص» - measures 115.58px, and a chip
 * spends a measured 94.56px on the 44px visibility target, the x,y
 * readout, the gaps and the horizontal padding. A chip therefore needs
 * 210.14px before the longest real label fits, and 180 was ~30px short
 * of that. Because a wrapped flex line always satisfies
 * `chip >= flexBasis`, stating a sufficient basis is what makes the
 * guarantee hold at EVERY width rather than at the ones sampled here.
 *
 * 216 = 116 (widest label) + 95 (measured chip overhead) + 5 slack for
 * font-metric variation between platforms. Raising it further would cost
 * columns for no readability gain; lowering it re-opens the defect,
 * which `scripts/verify-osd-labels.mjs` fails on.
 */
const OSD_ELEMENT_CHIP_BASIS = 216;

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md},
  hero: {gap: 4},
  eyebrow: {...typography.eyebrow, color: colors.accentStrong},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', maxWidth: PROSE_MEASURE},
  flexOne: {flex: 1},
  warning: {...noticeSurface, borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    gap: spacing.sm},
  warningText: {...typography.caption, color: colors.warning, textAlign: 'right', maxWidth: PROSE_MEASURE},
  success: {...noticeSurface, borderColor: colors.success,
    backgroundColor: colors.successSoft},
  successText: {...typography.caption, color: colors.success, textAlign: 'right', maxWidth: PROSE_MEASURE},
  inlineAction: {alignSelf: 'flex-start'},
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'},
  sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE},
  positionValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  canvasCaption: {...typography.caption, color: colors.textMuted, textAlign: 'center'},
  choices: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  choice: {
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
  },
  choiceSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft},
  choiceText: {...typography.label, color: colors.textSecondary},
  choiceTextSelected: {color: colors.accentStrong},
  visibilityRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md},
  field: {flexGrow: 1, flexBasis: 156, minWidth: 156, gap: 5},
  fieldWide: {flexGrow: 1, flexBasis: 260, gap: 5},
  fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  elementGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  elementChip: {
    flexBasis: OSD_ELEMENT_CHIP_BASIS,
    flexGrow: 1,
    /* A basis is a STARTING width, not a floor, and React Native
       defaults `flexShrink` to 0 - so a basis wider than the line makes
       the chip overhang instead of fitting. That is not hypothetical:
       at 390 with the page zoomed to 200% the usable line is ~157px,
       and a rigid 216px chip put the label at x=-52.8, clipped off the
       left edge by an `overflow-x: hidden` ancestor that cannot be
       scrolled. Shrinking costs nothing where it is not needed: a
       wrapped line never overflows on its own, so at every ordinary
       width the chip still gets its full basis and the label still
       fits. Where the line genuinely IS narrower than one chip, an
       ellipsis inside the viewport beats correct text off the side of
       it. */
    flexShrink: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
  },
  elementChipSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft},
  elementDotHit: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    /* The chip is already MIN_TOUCH_TARGET tall and its label is
       flex: 1, so claiming a full-size target here costs the row no
       height and only borrows width the label can spare. */
    marginHorizontal: -spacing.xs,
  },
  elementDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  elementDotOn: {backgroundColor: colors.success, borderColor: colors.success},
  elementChipText: {...typography.caption, flex: 1, color: colors.textPrimary, textAlign: 'right', maxWidth: PROSE_MEASURE},
  elementPosition: {...typography.caption, color: colors.textMuted, fontVariant: ['tabular-nums']},
  switchGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  switchRow: {
    flexBasis: 170,
    flexGrow: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
  },
  switchRowOn: {borderColor: colors.success, backgroundColor: colors.successSoft},
  switchLabel: {...typography.label, color: colors.textPrimary},
  switchState: {...typography.caption, color: colors.textMuted},
  switchStateOn: {color: colors.success, fontWeight: '600'},
  timerRow: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl},
  bottomSpace: {height: spacing.xl},
});
