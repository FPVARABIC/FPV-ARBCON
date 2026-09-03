import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';
import {
  GPS_RESCUE_RANGES,
  RX_FAILSAFE_MAX,
  RX_FAILSAFE_MIN,
  RX_FAILSAFE_STEP,
  createFailsafeConfigurationDraft,
  failsafeDraftsEqual,
  gpsRescueSupportsInitialClimb,
  gpsRescueSupportsMinStartDistance,
  gpsRescueSupportsRates,
  validateFailsafeDraft,
  type FailsafeChannelDraft,
  type FailsafeConfigurationDraft,
  type FailsafeValidationCode,
  type GpsRescueAltitudeMode,
  type GpsRescueAvailability,
  type GpsRescueDraft,
  type GpsRescueSanityCheck,
  type MspFailsafeSnapshot,
  type MspGpsRescueConfiguration,
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
import {isOwnedByDifferentConfigurationSession} from '../../core/state/configurationSessionOwnership';
import {StickyActionBar} from '../components/editing';
import {PROSE_MEASURE, colors, isDesktopTier, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, ChoiceChips, MIN_TOUCH_TARGET, Stepper as SharedStepper} from '../components/controls';
import {partialApplyMessage, unconfirmedWriteMessage} from '../presentation/writeStageNames';

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
  GPS_RESCUE_NOT_READABLE: 'لم تُقرأ معاملات GPS Rescue من هذه اللوحة؛ لا يمكن حفظها.',
  RETURN_ALTITUDE_INVALID: `ارتفاع العودة خارج مدى ${GPS_RESCUE_RANGES.returnAltitudeM.min}–${GPS_RESCUE_RANGES.returnAltitudeM.max} متر.`,
  DESCENT_DISTANCE_INVALID: `مسافة بدء الهبوط خارج مدى ${GPS_RESCUE_RANGES.descentDistanceM.min}–${GPS_RESCUE_RANGES.descentDistanceM.max} متر.`,
  GROUND_SPEED_INVALID: 'سرعة العودة خارج مدى 0–30 متر/ثانية.',
  SANITY_CHECKS_INVALID: 'قيمة فحوص السلامة غير معروفة؛ اختر إيقاف أو تشغيل أو عند Failsafe فقط.',
  MIN_SATS_INVALID: `أقل عدد أقمار خارج مدى ${GPS_RESCUE_RANGES.minSats.min}–${GPS_RESCUE_RANGES.minSats.max}.`,
  ASCEND_RATE_INVALID: 'معدل الصعود خارج مدى 0.5–25 متر/ثانية.',
  DESCEND_RATE_INVALID: 'معدل الهبوط خارج مدى 0.25–5 متر/ثانية.',
  ALLOW_ARMING_INVALID: 'قيمة «السماح بالتسليح دون Fix» غير معروفة.',
  ALTITUDE_MODE_INVALID: 'وضع ارتفاع العودة غير معروف؛ اختر أقصى أو ثابت أو الحالي.',
  MIN_START_DISTANCE_INVALID: `أقل مسافة لبدء الإنقاذ خارج مدى ${GPS_RESCUE_RANGES.minStartDistM.min}–${GPS_RESCUE_RANGES.minStartDistM.max} متر.`,
  INITIAL_CLIMB_INVALID: `الصعود الابتدائي خارج مدى ${GPS_RESCUE_RANGES.initialClimbM.min}–${GPS_RESCUE_RANGES.initialClimbM.max} متر.`,
};

/** Why the GPS Rescue card is not on screen, in the operator's language.
 * Three different facts, not one - a wing build and a decode failure are
 * not the same problem and must not read as the same message. */
const GPS_RESCUE_ABSENT_TEXT: Readonly<Record<Exclude<GpsRescueAvailability, 'PRESENT'>, string>> = {
  NO_GPS_IN_BUILD: 'هذا البناء لا يحتوي GPS، فلا توجد معاملات GPS Rescue لضبطها.',
  COMMAND_UNSUPPORTED: 'البناء يحتوي GPS لكن اللوحة لا تستجيب لأمر معاملات GPS Rescue. اضبطها من CLI إن احتجتها.',
  UNREADABLE: 'وصلت معاملات GPS Rescue بشكل يتعذّر قراءته. لم يُعرض أي رقم لأن عرض قيمة غير مؤكدة أسوأ من عدم عرضها.',
};

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function valueOf<T>(value: TelemetryValue<T>): T | undefined {return value.status === 'FRESH' || value.status === 'STALE' ? value.value : undefined;}
function blockMessage(reason: FailsafeBlockReason): string {return ({DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.', IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.', UNSUPPORTED_FIRMWARE: 'إصدار البرنامج الثابت في هذه اللوحة غير مدعوم لهذه الشاشة. حدّث البرنامج الثابت.', APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل القراءة أو الحفظ.', LINK_RECOVERING: 'الرابط التسلسلي يتعافى. انتظر ثم أعد القراءة.', FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران ARMED.', ARMED_STATE_UNKNOWN: 'تعذر إثبات DISARMED؛ لم تُرسل الإعدادات.', MOTOR_TEST_ACTIVE: 'جلسة اختبار المحركات نشطة. افتح المحركات وأنهِ الجلسة ثم أعد القراءة.', CONFIGURATION_BUSY: 'توجد معاملة إعدادات أخرى قيد التنفيذ.', STALE_BASE: 'تغيرت إعدادات Failsafe في المتحكم. أعد القراءة قبل الحفظ.', INVALID_CONFIGURATION: 'توجد قيمة Failsafe غير صالحة.', SESSION_CHANGED: 'تغيّرت جلسة المتحكم منذ إنشاء هذه التعديلات. أعد تحميل الإعدادات قبل الحفظ.'} as const)[reason];}
function saveMessage(outcome: FailsafeSaveOutcome): {text: string; warning: boolean} {switch (outcome.kind) {case 'NO_CHANGES': return {text: 'لا توجد تغييرات.', warning: false}; case 'SAVED_VERIFIED': return {text: 'حُفظ Failsafe وتطابقت القراءة الراجعة.', warning: false}; case 'SAVED_UNVERIFIED': return {text: 'أقرّ المتحكم الحفظ لكن تعذر التحقق. أعد الاتصال واقرأ قبل محاولة أخرى.', warning: true}; case 'UNCONFIRMED': return {text: unconfirmedWriteMessage(outcome.stage.group, 'index' in outcome.stage ? outcome.stage.index : undefined), warning: true};
 /* U-R1. RAM MOVED AND FLASH DID NOT. A stop at EEPROM means every
    change is live on the aircraft and simply was not written to flash;
    a stop at a settings group means only PART of it is live, which is
    the more alarming of the two and must not borrow the calmer
    sentence. Neither may be called «فشل الحفظ» - something did happen. */
 case 'PARTIAL_UNPERSISTED': return {text: partialApplyMessage(outcome.failedStage.group === 'EEPROM'), warning: true}; case 'SESSION_ENDED': return {text: 'انتهت الجلسة أثناء العملية.', warning: true}; case 'FAILED': return {text: 'فشلت العملية قبل اكتمال التحقق.', warning: true}; case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};}}

/**
 * CLAMPS INTO the range, not just against it.
 *
 * `Math.max(min, value - step)` alone is not enough once a stored value
 * can start OUTSIDE the range - which it can, both for an RXFAIL value
 * off the 25µs grid and for a GPS Rescue parameter stored under a
 * firmware whose limits have since moved. From 100 with a max of 30, a
 * one-sided clamp walks down one step at a time; clamping on BOTH sides
 * snaps to the nearest legal value on the first press, which is what an
 * operator correcting a flagged field expects.
 */
function clampInto(value: number, min: number, max: number): number {return Math.min(max, Math.max(min, value));}
function NumberStepper({label, value, min, max, step = 1, suffix, disabled, onChange, testID, format, rangeLabel, hint}: {label: string; value: number; min: number; max: number; step?: number; suffix?: string; disabled: boolean; onChange: (value: number) => void; testID: string; format?: (value: number) => string; rangeLabel?: string; hint?: string}) {return <View style={styles.numberField}><Text style={styles.fieldLabel}>{label}</Text><SharedStepper value={format !== undefined ? format(value) : `${value}${suffix ?? ''}`} onDecrement={() => onChange(clampInto(value - step, min, max))} onIncrement={() => onChange(clampInto(value + step, min, max))} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} accessibilityLabel={label} testID={testID} /><Text style={styles.rangeText}>{rangeLabel ?? `${min}–${max}${suffix ?? ''}`}</Text>{hint !== undefined ? <Text style={styles.fieldHint}>{hint}</Text> : null}</View>;}
function Choice<T extends number>({label, value, options, disabled, onChange, testID}: {label: string; value: T; options: readonly {value: T; label: string; help?: string}[]; disabled: boolean; onChange: (value: T) => void; testID: string}) {return <View style={styles.choiceField}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.choiceRow}>{options.map(option => <Pressable accessibilityRole="radio" accessibilityState={{selected: value === option.value}} key={option.value} disabled={disabled} onPress={() => onChange(option.value)} style={[styles.choice, value === option.value && styles.choiceSelected]} testID={`${testID}-${option.value}`}><Text style={[styles.choiceText, value === option.value && styles.choiceTextSelected]}>{option.label}</Text>{option.help !== undefined ? <Text style={styles.choiceHelp}>{option.help}</Text> : null}</Pressable>)}</View></View>;}

const FailsafeLiveStatus = React.memo(function FailsafeLiveStatus({sessionKey, active}: {sessionKey?: SetupUiSessionKey; active: boolean}) {
  const statusValue = useTelemetryValue<MspStatusExDiagnostics>(sessionKey?.sessionId ?? '', FC_STATUS_TELEMETRY_POLL_ID, active);
  const channelsValue = useTelemetryValue<MspRcChannels>(sessionKey?.sessionId ?? '', RECEIVER_CHANNELS_POLL_ID, active);
  const status = valueOf(statusValue); const channels = valueOf(channelsValue);
  const blockers = status?.readiness.armingDisableFlags; const failsafe = blockers !== undefined && (Math.floor(blockers / 2) % 2 === 1 || Math.floor(blockers / 4) % 2 === 1);
  return <View style={[styles.liveCard, failsafe && styles.liveCardDanger]} testID="failsafe-live-status"><View><Text style={styles.liveLabel}>{statusValue.status === 'STALE' || channelsValue.status === 'STALE' ? 'القراءة غير محدثة' : 'مراقبة حية من FC'}</Text>{/* A CHANNEL COUNT THAT STOPPED ARRIVING IS NOT A LIVE ONE. On the
    one screen whose subject is what happens when the link fails, a
    frozen reading drawn as live is the worst place for it. */}{statusValue.status === 'STALE' || channelsValue.status === 'STALE' ? <Text style={styles.liveStale} testID="failsafe-live-stale">آخر قيمة وصلت من المتحكم؛ لم تصل قراءة جديدة.</Text> : null}<Text style={[styles.liveState, failsafe && styles.liveStateDanger]}>{failsafe ? 'RX LOSS / FAILSAFE نشط' : statusValue.status === 'FRESH' ? 'الرابط لا يعلن Failsafe' : 'بانتظار حالة الرابط'}</Text></View><View style={styles.liveMetric}><Text style={styles.liveMetricValue}>{channels?.channels.length ?? '—'}</Text><Text style={styles.liveMetricLabel}>قنوات المستقبل</Text></View></View>;
});

/**
 * cm/s on the wire, m/s to a pilot - EXACTLY, not rounded to a step.
 *
 * The step this screen offers is 10 cm/s, but a board can hold any value:
 * the firmware's own minimum descent rate is 25 cm/s. Forcing one decimal
 * showed that 0.25 m/s minimum as "0.3", which is a different number from
 * the one the firmware will refuse to go below. So the conversion is
 * exact and only the trailing zeros are trimmed - 850 reads 8.5, 155
 * reads 1.55, 0 reads 0.
 */
/**
 * Deciseconds on the wire, SECONDS to a pilot.
 *
 * The board stores failsafe timings in tenths of a second, and the screen
 * used to show that storage unit directly: "15 ×0.1s". A pilot setting a
 * guard time thinks in seconds, and "×0.1s" asks them to do the firmware's
 * arithmetic. The DRAFT still carries deciseconds - nothing about the
 * payload changes - only the label the operator reads.
 */
const DECISECONDS_PER_SECOND = 10;
function secondsFromDeciseconds(deciseconds: number): string {
  return String(Math.round(deciseconds) / DECISECONDS_PER_SECOND);
}
function seconds(deciseconds: number): string {return `${secondsFromDeciseconds(deciseconds)} ثانية`;}
function secondsRange(min: number, max: number): string {return `${secondsFromDeciseconds(min)}–${secondsFromDeciseconds(max)} ثانية`;}

const CM_S_PER_M_S = 100;
const RATE_STEP_CM_S = 10;
function metresFromCentimetres(centimetres: number): string {
  return String(Math.round(centimetres) / CM_S_PER_M_S);
}
function metresPerSecond(centimetresPerSecond: number): string {return `${metresFromCentimetres(centimetresPerSecond)} م/ث`;}
function rateRangeLabel(min: number, max: number): string {return `${metresFromCentimetres(min)}–${metresFromCentimetres(max)} م/ث`;}

/**
 * THE PARAMETERS THAT DECIDE WHETHER A LOST AIRCRAFT COMES HOME.
 *
 * Until now the screen could SELECT GPS Rescue as the stage-2 procedure
 * and could not configure a single one of its parameters, so a long-range
 * pilot enabled it and flew on whatever defaults the board happened to
 * carry - including a return altitude that may sit below the trees.
 *
 * WHAT IS DELIBERATELY NOT HERE. Maximum pitch angle and the three
 * throttle values travel in the same MSP payload but belong to the shared
 * autopilot block that also drives Altitude Hold and Position Hold (see
 * decodeGpsRescue.ts). Editing them from a card headed "GPS Rescue" would
 * change a subsystem the operator did not open. They are preserved
 * byte-for-byte on save and shown nowhere.
 *
 * FIELDS APPEAR ONLY IF THE BOARD SENT THEM. A board on an older payload
 * length has no ascend rate and no altitude mode; a control for one would
 * be a control that cannot reach the aircraft.
 */
function GpsRescueCard({snapshot, draft, disabled, onChange}: {snapshot: MspGpsRescueConfiguration; draft: GpsRescueDraft; disabled: boolean; onChange: (value: GpsRescueDraft) => void}) {
  const set = <K extends keyof GpsRescueDraft>(key: K, value: GpsRescueDraft[K]) => onChange(Object.freeze({...draft, [key]: value}));
  const hasRates = gpsRescueSupportsRates(snapshot);
  return <View style={styles.card} testID="failsafe-gps-rescue">
    <View><Text style={styles.sectionTitle}>معاملات GPS Rescue</Text><Text style={styles.sectionHint}>تُقرأ من متحكم الطيران وتُكتب إليه. تُستخدم عند اختيار GPS Rescue إجراءً للمرحلة 2 أو عند تفعيله كوضع طيران.</Text></View>
    {hasRates ? <Choice label="ارتفاع العودة" value={draft.altitudeMode} options={[{value: 0 as GpsRescueAltitudeMode, label: 'الأقصى', help: 'الأعلى بين المسجّل والثابت'}, {value: 1 as GpsRescueAltitudeMode, label: 'ثابت', help: 'الارتفاع المحدد أدناه'}, {value: 2 as GpsRescueAltitudeMode, label: 'الحالي', help: 'ارتفاع لحظة الإنقاذ'}]} disabled={disabled} onChange={value => set('altitudeMode', value)} testID="failsafe-gps-altitude-mode" /> : null}
    <View style={styles.fieldsRow}>
      <NumberStepper label="ارتفاع العودة الثابت" value={draft.returnAltitudeM} min={GPS_RESCUE_RANGES.returnAltitudeM.min} max={GPS_RESCUE_RANGES.returnAltitudeM.max} suffix=" م" disabled={disabled} onChange={value => set('returnAltitudeM', value)} testID="failsafe-gps-return-altitude" hint={hasRates && draft.altitudeMode !== 1 ? 'يُستخدم في وضع الارتفاع الثابت، ويدخل في حساب وضع «الأقصى».' : undefined} />
      {gpsRescueSupportsInitialClimb(snapshot) ? <NumberStepper label="الصعود الابتدائي" value={draft.initialClimbM} min={GPS_RESCUE_RANGES.initialClimbM.min} max={GPS_RESCUE_RANGES.initialClimbM.max} suffix=" م" disabled={disabled} onChange={value => set('initialClimbM', value)} testID="failsafe-gps-initial-climb" hint="يُضاف فوق الارتفاع الحالي عند بدء الإنقاذ في وضع «الحالي»، ويُضاف كذلك في وضع «الأقصى»." /> : null}
    </View>
    <View style={styles.fieldsRow}>
      <NumberStepper label="مسافة بدء الهبوط" value={draft.descentDistanceM} min={GPS_RESCUE_RANGES.descentDistanceM.min} max={GPS_RESCUE_RANGES.descentDistanceM.max} suffix=" م" disabled={disabled} onChange={value => set('descentDistanceM', value)} testID="failsafe-gps-descent-distance" hint="المسافة من نقطة الانطلاق التي يبدأ عندها النزول." />
      <NumberStepper label="سرعة العودة" value={draft.groundSpeedCmS} min={GPS_RESCUE_RANGES.groundSpeedCmS.min} max={GPS_RESCUE_RANGES.groundSpeedCmS.max} step={RATE_STEP_CM_S} disabled={disabled} onChange={value => set('groundSpeedCmS', value)} testID="failsafe-gps-ground-speed" format={metresPerSecond} rangeLabel={rateRangeLabel(GPS_RESCUE_RANGES.groundSpeedCmS.min, GPS_RESCUE_RANGES.groundSpeedCmS.max)} />
    </View>
    {hasRates ? <View style={styles.fieldsRow}>
      <NumberStepper label="معدل الصعود" value={draft.ascendRate} min={GPS_RESCUE_RANGES.ascendRate.min} max={GPS_RESCUE_RANGES.ascendRate.max} step={RATE_STEP_CM_S} disabled={disabled} onChange={value => set('ascendRate', value)} testID="failsafe-gps-ascend-rate" format={metresPerSecond} rangeLabel={rateRangeLabel(GPS_RESCUE_RANGES.ascendRate.min, GPS_RESCUE_RANGES.ascendRate.max)} />
      <NumberStepper label="معدل الهبوط" value={draft.descendRate} min={GPS_RESCUE_RANGES.descendRate.min} max={GPS_RESCUE_RANGES.descendRate.max} step={RATE_STEP_CM_S} disabled={disabled} onChange={value => set('descendRate', value)} testID="failsafe-gps-descend-rate" format={metresPerSecond} rangeLabel={rateRangeLabel(GPS_RESCUE_RANGES.descendRate.min, GPS_RESCUE_RANGES.descendRate.max)} hint="يبدأ النزول بثلاثة أضعاف هذه القيمة ثم يتناقص إليها عند ارتفاع الهبوط." />
    </View> : null}
    <View style={styles.fieldsRow}>
      {/* No unit suffix: Arabic pluralisation of "قمر" changes with the
          number (9 أقمار, 11 قمرًا), and a fixed suffix gets it wrong for
          most of the 5..50 range. The label already names the unit. */}
      <NumberStepper label="أقل عدد أقمار" value={draft.minSats} min={GPS_RESCUE_RANGES.minSats.min} max={GPS_RESCUE_RANGES.minSats.max} disabled={disabled} onChange={value => set('minSats', value)} testID="failsafe-gps-min-sats" />
      {gpsRescueSupportsMinStartDistance(snapshot) ? <NumberStepper label="أقل مسافة لبدء الإنقاذ" value={draft.minStartDistM} min={GPS_RESCUE_RANGES.minStartDistM.min} max={GPS_RESCUE_RANGES.minStartDistM.max} suffix=" م" disabled={disabled} onChange={value => set('minStartDistM', value)} testID="failsafe-gps-min-start-distance" hint="إذا بدأ الإنقاذ أقرب من هذه المسافة، تبتعد الطائرة على اتجاهها الحالي حتى تتجاوزها ثم تبدأ العودة." /> : null}
    </View>
    <Choice label="فحوص السلامة أثناء الإنقاذ" value={draft.sanityChecks} options={[{value: 0 as GpsRescueSanityCheck, label: 'إيقاف'}, {value: 1 as GpsRescueSanityCheck, label: 'تشغيل'}, {value: 2 as GpsRescueSanityCheck, label: 'عند Failsafe فقط'}]} disabled={disabled} onChange={value => set('sanityChecks', value)} testID="failsafe-gps-sanity" />
    {hasRates ? <><Choice label="السماح بالتسليح دون GPS Fix" value={draft.allowArmingWithoutFix} options={[{value: 0, label: 'لا'}, {value: 1, label: 'نعم'}]} disabled={disabled} onChange={value => set('allowArmingWithoutFix', value)} testID="failsafe-gps-allow-arming" />
      {draft.allowArmingWithoutFix === 1 ? <View style={styles.gpsNotice}><Text style={styles.gpsNoticeText}>غير موصى به: بلا نقطة Home مسجّلة سيُلغى التسليح وتسقط الطائرة عند فقد إشارة حقيقي.</Text></View> : null}</> : null}
  </View>;
}

function ChannelRow({index, draft, live, disabled, onChange}: {index: number; draft: FailsafeChannelDraft; live?: number; disabled: boolean; onChange: (value: FailsafeChannelDraft) => void}) {
  const name = ['Roll', 'Pitch', 'Yaw', 'Throttle'][index] ?? `AUX ${index - 3}`; const primary = index < 4;
  const modes = primary ? [{value: 0 as const, label: 'AUTO'}, {value: 1 as const, label: 'HOLD'}, {value: 2 as const, label: 'SET'}] : [{value: 1 as const, label: 'HOLD'}, {value: 2 as const, label: 'SET'}];
  return <View style={styles.channelRow} testID={`failsafe-channel-${index + 1}`}><View style={styles.channelHeading}><View><Text style={styles.channelName}>{name}</Text><Text style={styles.channelLive}>القيمة الحية: {live ?? '—'}</Text></View><ChoiceChips accessibilityLabel={`${name}: وضع Failsafe`} selectedKey={String(draft.mode)} onSelect={key => onChange({...draft, mode: Number(key) as FailsafeChannelDraft['mode']})} disabled={disabled} options={modes.map(mode => ({key: String(mode.value), label: mode.label, testID: `failsafe-channel-${index + 1}-mode-${mode.value}`}))} /></View>{draft.mode === 2 ? <NumberStepper label="قيمة SET" value={draft.value} min={RX_FAILSAFE_MIN} max={RX_FAILSAFE_MAX} step={RX_FAILSAFE_STEP} suffix=" µs" disabled={disabled} onChange={value => onChange({...draft, value})} testID={`failsafe-channel-${index + 1}-value`} /> : <Text style={styles.channelExplanation}>{draft.mode === 0 ? 'AUTO: يستخدم البرنامج الثابت سلوك المحور الافتراضي عند فقد النبض.' : 'HOLD: يحتفظ بآخر قيمة صالحة للقناة.'}</Text>}</View>;
}

export default function FailsafeScreen({sessionKey, active, onOpenReceiver, onOpenMotors, onDirtyChange, controller = failsafeConfigurationController}: FailsafeScreenProps): React.JSX.Element {
  const {t} = useTranslation(); const {tier, maxWidth} = useContentEnvelope(
    /*
     * TRUE NOW, and only because the screen genuinely changed.
     *
     * It used to pass false with a good reason: it was ONE column of
     * setting cards, and the workspace envelope simply stretched every
     * card to ~1550px with its content pinned to the reading edge. The
     * fix then was to stop claiming a split that did not exist.
     *
     * It now really does split - detection and behaviour down one
     * column, live state and the per-channel grid down the other (see
     * `columns` below) - so the wider envelope buys parallel
     * information rather than longer cards. Measured: 67% of a 1920
     * window used before, and 49% of a 2560 one, with ~600px of dead
     * ground down each side.
     */
    true,
  ); const {width, fontScale} = useWindowDimensions(); const wide = width / Math.max(1, fontScale) >= 900;
  /* The split itself. Below the desktop tier there is not enough room
     for two readable columns, so the screen stays exactly as it was. */
  const twoColumn = isDesktopTier(tier);
  const [phase, setPhase] = useState<Phase>('IDLE'); const [snapshot, setSnapshot] = useState<MspFailsafeSnapshot>(); const [draft, setDraft] = useState<FailsafeConfigurationDraft>(); const [loadOutcome, setLoadOutcome] = useState<FailsafeLoadOutcome>(); const [saveOutcome, setSaveOutcome] = useState<FailsafeSaveOutcome>(); const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {if (active && sessionKey !== undefined) return acquireReceiverTelemetry(sessionKey);}, [active, sessionKey]);
  useEffect(() => {if (!active || sessionKey === undefined) return; let cancelled = false; setPhase('LOADING'); setSaveOutcome(undefined); controller.load(sessionKey).then(outcome => {if (cancelled) return; setLoadOutcome(outcome); if (outcome.kind === 'LOADED') {setSnapshot(outcome.snapshot); setDraft(createFailsafeConfigurationDraft(outcome.snapshot)); setPhase('READY');} else {setSnapshot(undefined); setDraft(undefined); setPhase('ERROR');}}).catch(error => {if (cancelled) return; setLoadOutcome({kind: 'FAILED', error}); setSnapshot(undefined); setDraft(undefined); setPhase('ERROR');}); return () => {cancelled = true;};}, [active, controller, reloadToken, sessionKey]);
  const dirty = snapshot !== undefined && draft !== undefined && !failsafeDraftsEqual(createFailsafeConfigurationDraft(snapshot), draft); useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]); useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  /* DOES THIS SCREEN'S BASELINE BELONG TO THE SESSION IT WOULD WRITE
     THROUGH? `sessionKey` is a prop; the snapshot and the draft are state
     that outlive a prop change by at least one render - and by the entire
     reload if that reload is slow, or forever if it is refused. In that
     window `dirty` is still true and the Save button is still live, over
     a draft built against a DIFFERENT aircraft. The controller refuses
     this too; both layers are required, and this is the one the operator
     can see. See core/state/configurationSessionOwnership. */
  const saveBlockedBySession = isOwnedByDifferentConfigurationSession(snapshot, sessionKey);
  const issues = useMemo(() => draft === undefined || snapshot === undefined ? [] : validateFailsafeDraft(draft, snapshot), [draft, snapshot]);
  const update = useCallback(<K extends keyof Omit<FailsafeConfigurationDraft, 'channels'>>(key: K, value: FailsafeConfigurationDraft[K]) => {setDraft(current => current === undefined ? current : Object.freeze({...current, [key]: value})); setSaveOutcome(undefined);}, []);
  const updateGpsRescue = useCallback((value: GpsRescueDraft) => {setDraft(current => current === undefined ? current : Object.freeze({...current, gpsRescue: value})); setSaveOutcome(undefined);}, []);
  const updateChannel = useCallback((index: number, value: FailsafeChannelDraft) => {setDraft(current => current === undefined ? current : Object.freeze({...current, channels: Object.freeze(current.channels.map((item, itemIndex) => itemIndex === index ? Object.freeze(value) : item))})); setSaveOutcome(undefined);}, []);
  const reload = useCallback(() => {const perform = () => setReloadToken(value => value + 1); if (!dirty) return perform(); Alert.alert('تجاهل تغييرات Failsafe؟', 'ستُستبدل المسودة بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]);}, [dirty]);
  const save = useCallback(async () => {if (sessionKey === undefined || snapshot === undefined || draft === undefined || issues.length > 0 || saveBlockedBySession) return; setPhase('SAVING'); let outcome: FailsafeSaveOutcome; try {outcome = await controller.save(sessionKey, snapshot, draft);} catch (error) {outcome = {kind: 'FAILED', error};} setSaveOutcome(outcome); if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {setSnapshot(outcome.snapshot); setDraft(createFailsafeConfigurationDraft(outcome.snapshot));} setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');}, [saveBlockedBySession, controller, draft, issues.length, sessionKey, snapshot]);
  const statusCopy = saveOutcome === undefined ? undefined : saveMessage(saveOutcome); const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة Failsafe من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;
  const channelsTelemetry = useTelemetryValue<MspRcChannels>(sessionKey?.sessionId ?? '', RECEIVER_CHANNELS_POLL_ID, active); const liveChannels = valueOf(channelsTelemetry)?.channels ?? [];
  return <View style={styles.root} testID="failsafe-screen"><ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
    <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.title}>الأمان عند فقد الإشارة</Text><Text style={styles.subtitle}>اضبط زمن الحراسة، إجراء المرحلة الثانية، وسلوك كل قناة عند فقد النبض. لا يدّعي التطبيق أن الإعداد آمن للطيران قبل اختبار عتاد مضبوط.</Text></View>{snapshot !== undefined ? <View style={[styles.supportBadge, snapshot.supportsGpsRescue && styles.supportBadgeGood]}><Text style={styles.supportLabel}>GPS Rescue في البناء</Text><Text style={styles.supportValue}>{snapshot.supportsGpsRescue ? 'مدعوم' : 'غير مثبت'}</Text></View> : null}</View>
    <View style={styles.danger}><Text style={styles.dangerTitle}>اختبار Failsafe قد يسبب تسليحًا أو حركة غير متوقعة</Text><Text style={styles.dangerText}>انزع جميع المراوح، ثبّت الطائرة، واختبر أولًا عبر USB ومن دون LiPo إن أمكن.</Text><Text style={styles.dangerText}>{t('hardwareVerification.behaviourTitle')} — القراءة والحفظ والتحقق مختبرة؛ سلوك المستقبل وGPS Rescue لا يثبت إلا بقطع الإشارة فعليًا.</Text></View>
    <FailsafeLiveStatus sessionKey={sessionKey} active={active} />
    {loadingMessage !== undefined ? <View style={styles.warning} testID="failsafe-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} testID="failsafe-open-motors" /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} testID="failsafe-reload" />}</View> : null}
    {draft !== undefined && snapshot !== undefined ? <View style={twoColumn ? styles.columns : styles.stack}>
      <View style={twoColumn ? styles.column : styles.stack}>
      <View style={styles.card}><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>المرحلة 1 · كشف فقد الإشارة</Text><Text style={styles.sectionHint}>زمن الحراسة قبل إعلان RX loss، وزمن الخانق المنخفض الذي يسمح بالفصل المباشر بدل الإجراء الكامل.</Text></View><Pressable onPress={onOpenReceiver} style={styles.linkButton}><Text style={styles.linkButtonText}>فتح المستقبل والقنوات</Text></Pressable></View><View style={styles.fieldsRow}><NumberStepper label="زمن الحراسة" value={draft.delayDeciseconds} min={1} max={200} disabled={phase !== 'READY'} onChange={value => update('delayDeciseconds', value)} testID="failsafe-delay" format={seconds} rangeLabel={secondsRange(1, 200)} hint="المهلة قبل أن يعلن المتحكم فقد الإشارة." /><NumberStepper label="مدة الخانق المنخفض" value={draft.throttleLowDelayDeciseconds} min={0} max={300} disabled={phase !== 'READY'} onChange={value => update('throttleLowDelayDeciseconds', value)} testID="failsafe-throttle-low-delay" format={seconds} rangeLabel={secondsRange(0, 300)} hint="إذا بقي الخانق منخفضًا هذه المدة، يُفصل مباشرة بدل الإجراء الكامل." /></View></View>
      <View style={styles.card}><Choice label="سلوك مفتاح Failsafe" value={draft.switchMode} options={[{value: 0, label: 'Stage 1', help: 'كفقد الرابط'}, {value: 1, label: 'Kill', help: 'فصل مباشر'}, {value: 2, label: 'Stage 2', help: 'الإجراء الكامل'}]} disabled={phase !== 'READY'} onChange={value => update('switchMode', value)} testID="failsafe-switch" /></View>
      <View style={styles.card}><Choice label="إجراء المرحلة 2" value={draft.procedure} options={[{value: 1, label: 'Drop', help: 'إيقاف وفصل'}, {value: 0, label: 'Land', help: 'هبوط بخانق ثابت'}, ...(snapshot.supportsGpsRescue ? [{value: 2 as const, label: 'GPS Rescue', help: 'عودة وإنقاذ'}] : [])]} disabled={phase !== 'READY'} onChange={value => update('procedure', value)} testID="failsafe-procedure" />{draft.procedure === 0 ? <View style={styles.fieldsRow}><NumberStepper label="خانق الهبوط" value={draft.throttle} min={RX_FAILSAFE_MIN} max={RX_FAILSAFE_MAX} step={1} suffix=" µs" disabled={phase !== 'READY'} onChange={value => update('throttle', value)} testID="failsafe-throttle" /><NumberStepper label="زمن الهبوط قبل الفصل" value={draft.landingTimeSeconds} min={0} max={250} suffix=" ثانية" disabled={phase !== 'READY'} onChange={value => update('landingTimeSeconds', value)} testID="failsafe-landing-time" /></View> : null}{draft.procedure === 2 ? <View style={styles.gpsNotice}><Text style={styles.gpsNoticeText}>الدعم في البناء لا يثبت GPS fix أو Home أو صحة إعدادات Rescue. راجع شاشة GPS واختبر Rescue منفصلًا.</Text></View> : null}</View>
      {snapshot.gpsRescue !== undefined && draft.gpsRescue !== undefined
        ? <GpsRescueCard snapshot={snapshot.gpsRescue} draft={draft.gpsRescue} disabled={phase !== 'READY'} onChange={updateGpsRescue} />
        // Shown only when the operator has a reason to look for it: the
        // build carries GPS, so its absence is a fact about this board
        // rather than a screen that simply has nothing to say.
        : snapshot.supportsGpsRescue && snapshot.gpsRescueAvailability !== 'PRESENT'
          ? <View style={styles.warning} testID="failsafe-gps-rescue-absent"><Text style={styles.warningText}>{GPS_RESCUE_ABSENT_TEXT[snapshot.gpsRescueAvailability]}</Text></View>
          : null}
      </View>
      <View style={twoColumn ? styles.column : styles.stack}>
      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>قيم القنوات عند فقد النبض</Text><Text style={styles.sectionHint}>AUTO متاح للمحاور الأربعة فقط؛ قنوات AUX تستخدم HOLD أو SET كما يفرض البرنامج الثابت. القيمة SET تتحرك بخطوة 25µs.</Text></View>
      <View style={[styles.channelGrid, wide && styles.channelGridWide]}>{draft.channels.map((channel, index) => <ChannelRow key={index} index={index} draft={channel} live={liveChannels[index]} disabled={phase !== 'READY'} onChange={value => updateChannel(index, value)} />)}</View>
      {issues.length > 0 ? <View style={styles.warning}><Text style={styles.warningText}>{issues.map(code => FAILSAFE_ISSUE_TEXT[code]).join(' ')}</Text></View> : null}{statusCopy !== undefined ? <View style={statusCopy.warning ? styles.warning : styles.success}><Text style={statusCopy.warning ? styles.warningText : styles.successText}>{statusCopy.text}</Text></View> : null}
      </View>
    </View> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة Failsafe والقيم الاحتياطية ودعم البناء…</Text> : null}<View style={styles.bottomSpace} />
  </ScrollView><StickyActionBar visible={dirty} summary="تغيّرت إعدادات Failsafe" details={['يُرسَل المتغيّر فقط، ثم يُحفظ في ذاكرة المتحكم ويُقرأ مرة أخرى للتأكد']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={() => snapshot !== undefined && setDraft(createFailsafeConfigurationDraft(snapshot))} disabledReason={saveBlockedBySession ? blockMessage('SESSION_CHANGED') : issues.length > 0 ? 'صحح قيم Failsafe قبل الحفظ.' : undefined} statusMessage={statusCopy?.text} statusTone={statusCopy?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ Failsafe…" testID="failsafe-save-bar" /></View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background}, content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md},
  /* THE SPLIT. `stack` is the phone/tablet shape and is exactly what the
     screen has always been: one column, cards in order. `columns` is the
     desktop shape - two real columns, each with a minimum width, so the
     row WRAPS back to a stack rather than squeezing two unreadable
     columns into a window that cannot hold them. */
  stack: {gap: spacing.md},
  /* THE TWO COLUMNS WRAP, BECAUSE AT THE NARROWEST DESKTOP THEY DO
     NOT BOTH FIT. Each column carries `minWidth: 400`, and the first
     width that turns this layout on is 1024 - where the side rail
     leaves 780. 400 + 400 + an 18px gap is 818, so a non-wrapping row
     pushed 38px off the left edge of an RTL layout and took the third
     mode chip of all sixteen channels with it, clipped by an ancestor
     nothing can scroll. Measured in Chromium by
     verify-responsive-interaction.mjs; wrapping stacks them at 1024
     and leaves 1366 and wider exactly as they were. */
  columns: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: spacing.lg},
  column: {flex: 1, flexBasis: 460, minWidth: 400, gap: spacing.md}, hero: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg, flexWrap: 'wrap'}, heroCopy: {flex: 1, minWidth: 280, gap: 4}, eyebrow: {...typography.eyebrow, color: colors.accentStrong}, title: {...typography.title, color: colors.textPrimary, textAlign: 'right'}, subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE}, supportBadge: {borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radii.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minWidth: 150}, supportBadgeGood: {borderColor: colors.success, backgroundColor: colors.successSoft}, supportLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, supportValue: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, danger: {borderRadius: radii.sm, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2}, dangerTitle: {...typography.caption, fontWeight: '700', color: colors.error, textAlign: 'right', maxWidth: PROSE_MEASURE}, dangerText: {...typography.caption, color: colors.error, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE}, hardware: {borderRadius: radii.lg, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, padding: spacing.md, gap: 3}, hardwareTitle: {...typography.eyebrow, color: colors.accentStrong}, hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', maxWidth: PROSE_MEASURE}, liveCard: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm}, liveCardDanger: {borderColor: colors.error, backgroundColor: colors.errorSoft}, liveLabel: {...typography.caption, color: colors.textMuted, textAlign: 'right'}, liveStale: {...typography.caption, color: colors.warning}, liveState: {...typography.heading, color: colors.success, textAlign: 'right'}, liveStateDanger: {color: colors.error}, liveMetric: {alignItems: 'center'}, liveMetricValue: {...typography.title, color: colors.textPrimary, fontVariant: ['tabular-nums']}, liveMetricLabel: {...typography.caption, color: colors.textMuted}, warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm}, warningText: {...typography.body, color: colors.warning, textAlign: 'right', maxWidth: PROSE_MEASURE}, success: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm}, successText: {...typography.body, color: colors.success, textAlign: 'right', maxWidth: PROSE_MEASURE}, inlineAction: {alignSelf: 'flex-start'}, card: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md}, sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap'}, sectionHeading: {gap: 3}, sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'}, sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE}, linkButton: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1.5, borderColor: colors.accentStrong}, linkButtonText: {...typography.label, color: colors.accentStrong}, fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: spacing.md}, /* CAPPED. A stepper is a normal-sized control, not a banner: with
     flexGrow alone a two-field row on a 1920px window produced two ~750px
     bars whose plus and minus sat at opposite ends of the screen with the
     value stranded in the middle - measured in Chromium, not theorised.
     It still grows on a phone, where the full row width IS the right size. */
  numberField: {flexGrow: 1, flexBasis: 180, maxWidth: 340, gap: 5}, fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'}, rangeText: {...typography.caption, color: colors.textMuted, textAlign: 'center', writingDirection: 'ltr'}, fieldHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE}, choiceField: {gap: spacing.sm}, choiceRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, choice: {flexGrow: 1, flexBasis: 150, maxWidth: 280, minHeight: 58, padding: spacing.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.backgroundRaised}, choiceSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft}, choiceText: {...typography.bodyStrong, color: colors.textSecondary}, choiceTextSelected: {color: colors.accentStrong}, choiceHelp: {...typography.caption, color: colors.textMuted, textAlign: 'center'}, gpsNotice: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, padding: spacing.sm}, gpsNoticeText: {...typography.caption, color: colors.warning, textAlign: 'right', maxWidth: PROSE_MEASURE}, channelGrid: {gap: spacing.sm}, channelGridWide: {flexDirection: 'row', flexWrap: 'wrap'}, channelRow: {flexGrow: 1, flexBasis: 360, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm}, /* WRAPS, because at 360 it genuinely does not fit: the name and live
   value plus three 72px mode chips need 338px of a 298px row, and with
   the default nowrap the chips were pushed 9px off the left edge of the
   screen (measured on every channel). Wrapping drops the chip group
   under the label instead; at every wider width the row still fits on
   one line and nothing moves. */
channelHeading: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm}, channelName: {...typography.bodyStrong, color: colors.textPrimary}, channelLive: {...typography.caption, color: colors.textMuted, fontVariant: ['tabular-nums']}, channelExplanation: {...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE}, loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl}, bottomSpace: {height: spacing.xl},
});
