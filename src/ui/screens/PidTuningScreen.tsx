/**
 * THE TUNING PAGE, ORGANISED AROUND THE QUESTION A PILOT ACTUALLY ASKS.
 *
 * The previous version opened with three cards of P/I/D/F bytes. That is a
 * struct editor: it presents the hardest, most dangerous numbers in the
 * subsystem first, to a person whose question is "how do I make it fly the
 * way I want?". The order here answers that question instead -
 *
 *   who am I tuning        the profile bar
 *   how strong             Simplified Tuning, the generator the firmware
 *                          itself offers
 *   how fast               Rates, with a bounded picture of the curve
 *   commit                 one save bar that names what it will write
 *   everything else        behind «الإعدادات المتقدمة»
 *
 * NOTHING WAS DELETED. Every direct PID, feel, throttle, Dynamic Idle and
 * filter control that worked before still works; they moved under the
 * disclosure, and they open automatically whenever the simplified workspace
 * cannot function, because then they ARE the workspace.
 *
 * THREE INDEPENDENT DIRTY SCOPES, NOT ONE FLAG. Values, the rates formula
 * and the simplified sliders travel to the board through three different
 * transactions with three different failure modes, so the screen tracks and
 * reports them separately and saves them in a fixed order (formula, then
 * values, then generator) with each step rebased on the snapshot the
 * previous one returned.
 *
 * NO PRESENTATION LOGIC OF ITS OWN. Rate names, field labels, display
 * scales, curve sampling and every sentence about what the simplified
 * sliders do live in `src/ui/presentation`; the mathematics behind them
 * lives in `rateFormulaEngine` and `simplifiedTuningGenerator`. The inline
 * `RATE_TYPES` table this file used to carry was a second opinion about a
 * subsystem already pinned to firmware source, and it is gone.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTranslation} from 'react-i18next';
import {
  createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft,
  type FiltersDraft, type MspPidTuningSnapshot, type PidAxisDraft, type PidAxisKey,
  type PidTuningDraft, type RateAxisDraft, type RatesDraft,
} from '../../core';
import {
  pidTuningController, type PidBlockReason, type PidLoadOutcome,
  type PidProfileCopyOutcome, type PidProfileKind, type PidProfileNameOutcome,
  type PidProfileResetOutcome, type PidProfileSwitchOutcome, type PidResetResource,
  type PidRatesTypeOutcome, type PidSaveOutcome, type PidSimplifiedLoadOutcome,
  type PidSimplifiedSaveOutcome, type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import type {AdvancedPidFieldKey} from '../../core/state/advancedPidFields';
import type {AdvancedFilterFieldKey} from '../../core/state/advancedFilterFields';
import {withRpmFilterValue, type RpmFilterFieldKey} from '../../core/state/rpmFilterFields';
import type {CopyProfileRequest} from '../../core/protocol/msp/encoding/encodeProfileCommands';
import RpmFilterCard from '../components/pid/RpmFilterCard';
import AdvancedTuningGroups from '../components/pid/AdvancedTuningGroups';
import ProfileManagementCard from '../components/pid/ProfileManagementCard';
import {isOwnedByDifferentConfigurationSession} from '../../core/state/configurationSessionOwnership';
import {StickyActionBar} from '../components/editing';
import {PROSE_MEASURE, colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Button, ChoiceChips, NoticeBox, Stepper as SharedStepper, ToggleSwitch} from '../components/controls';
import {Icon} from '../icons';
import RateResponsePreview from '../components/pid/RateResponsePreview';
import {partialApplyMessage, unconfirmedWriteMessage} from '../presentation/writeStageNames';
import {
  formatRateField, rateAxisPresentation, ratesTypeName,
  type RateAxisPresentation,
} from '../presentation/ratesPresentation';
import {
  GENERATOR_OWNED_NOTE, SIMPLIFIED_DTERM_FILTER, SIMPLIFIED_EXPLANATION,
  SIMPLIFIED_GYRO_FILTER, SIMPLIFIED_MORE_SLIDERS, SIMPLIFIED_OFF_CONSEQUENCE,
  SIMPLIFIED_PRIMARY_SLIDERS, SIMPLIFIED_SUMMARY, SIMPLIFIED_ZERO_FILTER_NOTE,
  formatEffectiveRange, formatMultiplier, generatorOwnedDirectFields,
  overwriteSummary, simplifiedModeCopy,
  type SimplifiedSliderCopy, type SimplifiedSliderKey,
} from '../presentation/simplifiedTuningPresentation';
import {FEEDFORWARD_BOOST_MAX, FEEDFORWARD_JITTER_FACTOR_MAX} from '../../core/state/pidTuningModel';
import {classifyRatesType, type RateAxisSettings} from '../../core/state/rateFormulaEngine';
import {
  SIMPLIFIED_TUNING_FILTERS_MIN, SIMPLIFIED_TUNING_MAX, SIMPLIFIED_TUNING_PIDS_MIN,
  decodeSimplifiedTuning, type MspSimplifiedTuning,
} from '../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import {
  encodeSimplifiedTuning,
  type SimplifiedFilterPatch, type SimplifiedPidInputPatch, type SimplifiedTuningPatch,
} from '../../core/protocol/msp/encoding/encodeSimplifiedTuning';
import {
  generateSimplifiedDtermFilters, generateSimplifiedGyroFilters, simplifiedDefaultsFor,
  type GeneratedFilterFrequencies, type ObservedFilterFrequencies,
} from '../../core/state/simplifiedTuningGenerator';

/**
 * Everything after `save` is OPTIONAL so that a host - or a test double -
 * that only knows how to read and write values stays valid. A capability the
 * host does not supply is not drawn as a working control and is never
 * described to the pilot as a firmware limitation.
 */
export interface PidControllerPort {
  load(key: SetupUiSessionKey): Promise<PidLoadOutcome>;
  save(key: SetupUiSessionKey, original: MspPidTuningSnapshot, draft: PidTuningDraft): Promise<PidSaveOutcome>;
  selectProfile?(key: SetupUiSessionKey, kind: PidProfileKind, index: number): Promise<PidProfileSwitchOutcome>;
  loadSimplified?(key: SetupUiSessionKey): Promise<PidSimplifiedLoadOutcome>;
  saveSimplified?(key: SetupUiSessionKey, original: MspPidTuningSnapshot, patch: SimplifiedTuningPatch): Promise<PidSimplifiedSaveOutcome>;
  setRatesType?(key: SetupUiSessionKey, original: MspPidTuningSnapshot, ratesTypeRaw: number): Promise<PidRatesTypeOutcome>;
  readProfileName?(key: SetupUiSessionKey, kind: PidProfileKind): Promise<PidProfileNameOutcome>;
  setProfileName?(key: SetupUiSessionKey, kind: PidProfileKind, name: string): Promise<PidProfileNameOutcome>;
  copyProfile?(key: SetupUiSessionKey, request: CopyProfileRequest): Promise<PidProfileCopyOutcome>;
  resetPidProfile?(key: SetupUiSessionKey): Promise<PidProfileResetOutcome>;
}
export interface PidTuningScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenMotors: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: PidControllerPort;
}
type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

/**
 * `PORT_ABSENT` is deliberately NOT `UNSUPPORTED`.
 *
 * UNSUPPORTED is a claim about the flight controller - the command family is
 * missing from its build. "This host has no implementation" is a claim about
 * US, and printing our own gap as the board's would be inventing evidence.
 */
type SimplifiedState = {readonly kind: 'READING'} | {readonly kind: 'PORT_ABSENT'} | PidSimplifiedLoadOutcome;

const AXES: readonly {key: PidAxisKey; title: string; subtitle: string}[] = Object.freeze([
  {key: 'roll', title: 'Roll', subtitle: 'المحور الجانبي'},
  {key: 'pitch', title: 'Pitch', subtitle: 'المحور الطولي'},
  {key: 'yaw', title: 'Yaw', subtitle: 'محور الاتجاه'},
]);
const EMPTY_PATCH: SimplifiedTuningPatch = Object.freeze({});
const GENERATOR_DEFAULTS = simplifiedDefaultsFor('API_1_47');
/** Percentage points per press. One-by-one would take forty presses to
 * cross the range; five keeps a deliberate change deliberate. */
const MULTIPLIER_STEP = 5;

function blockMessage(reason: PidBlockReason): string {
  return ({
    DISCONNECTED: 'انتهى الاتصال بمتحكم الطيران. أعد الاتصال ثم أعد القراءة.',
    IDENTIFYING: 'ما زال التطبيق يتحقق من هوية متحكم الطيران.',
    UNSUPPORTED_FIRMWARE: 'إصدار البرنامج الثابت في هذه اللوحة غير مدعوم لضبط PID، لأن تخطيط القيم يختلف بين الإصدارات.',
    APP_BACKGROUNDED: 'أعد التطبيق إلى الواجهة قبل قراءة أو حفظ PID.',
    LINK_RECOVERING: 'الاتصال قيد الاستعادة. انتظر ثم أعد القراءة.',
    FC_ARMED: 'رُفض الحفظ لأن متحكم الطيران مسلّح.',
    ARMED_STATE_UNKNOWN: 'تعذر إثبات أن متحكم الطيران DISARMED؛ لم يُرسل أي تعديل.',
    MOTOR_TEST_ACTIVE: 'أنهِ جلسة اختبار المحركات من الزر الثابت أسفل شاشة المحركات، ثم أعد القراءة.',
    CONFIGURATION_BUSY: 'هناك معاملة إعدادات أخرى جارية. انتظر ثم أعد المحاولة.',
    STALE_BASE: 'تغيّرت قيم PID على متحكم الطيران منذ آخر قراءة. أعد القراءة قبل الحفظ.',
    INVALID_CONFIGURATION: 'هناك قيمة PID أو Rates أو Filters خارج الحدود الرسمية أو حد Nyquist الآمن.',
    SESSION_CHANGED: 'تغيّرت جلسة المتحكم منذ إنشاء هذه التعديلات. أعد تحميل الإعدادات قبل الحفظ.',
    UNVERIFIED_FUTURE_API: 'إصدار البرنامج الثابت أحدث من أي تخطيط تحقّقنا منه من المصدر، لذلك لا نكتب أي ضبط إليه.',
    PROFILE_CHANGED: 'تغيّر الملف النشط على متحكم الطيران بعد قراءة القيم. لم يُرسل أي تعديل؛ أعد القراءة أولًا.',
    DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED: 'الضبط المبسّط نشط ويملك هذه القيم؛ تعديلها يدويًا سيُلغى فورًا. لم يُرسل شيء.',
    ACTIVE_DESTINATION_COPY_UNSAFE: 'لا ننسخ فوق الملف النشط، لأن المتحكم لا يعيد تهيئة نفسه بعد النسخ.',
    SIMPLIFIED_TUNING_UNSUPPORTED: 'هذا البناء من البرنامج الثابت لا يتضمّن الضبط المبسّط.',
    SIMPLIFIED_PROJECTION_ORACLE_DISAGREES: 'حساب المتحكم لنتيجة الشرائح لا يطابق حسابنا، فلم نكتب شيئًا.',
    UNKNOWN_RATES_TYPE: 'نوع المعدلات المطلوب ليس من الأنواع الخمسة التي تحققنا منها من المصدر.',
  })[reason];
}
function saveMessage(outcome: PidSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'SAVED_VERIFIED': return {text: 'حُفظت القيم المتغيرة، وأكدت القراءة الراجعة تطابقها.', warning: false};
    case 'NO_CHANGES': return {text: 'لا توجد تغييرات جديدة.', warning: false};
    case 'SAVED_UNVERIFIED': return {text: 'أُقر الحفظ، لكن تعذرت القراءة الراجعة. أعد القراءة قبل الطيران.', warning: true};
    case 'APPLIED_PERSISTENCE_UNVERIFIED': return {text: 'طُبّقت القيم وأكدتها القراءة، لكن لم يثبت حفظها في ذاكرة المتحكم. لا تعتمد عليها بعد إعادة التشغيل.', warning: true};
    case 'READBACK_MISMATCH': return {text: 'أعادت اللوحة قيمًا لا تطابق ما طُلب ولا ما يتوقعه المصدر. لم يُدّع نجاح.', warning: true};
    case 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE': return {text: 'غيّر المتحكم إعدادًا خارج هذه الشاشة بطريقة لا يفسّرها المصدر. أعد قراءة إعدادات المحركات.', warning: true};
    case 'SIDE_EFFECT_PREDICTION_NOT_PROVEN': return {text: 'غيّر المتحكم إعدادًا خارج هذه الشاشة، ولا يمكننا حساب القيمة المتوقعة له من بيانات MSP وحدها. لم يُحفظ التغيير؛ أعد قراءة إعدادات المحركات.', warning: true};
    case 'UNCONFIRMED': return {text: unconfirmedWriteMessage(outcome.stage), warning: true};
    /* U-R1. RAM moved and flash did not - never «فشل الحفظ». */
    case 'PARTIAL_UNPERSISTED': return {text: partialApplyMessage(outcome.failedStage === 'EEPROM'), warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء العملية.', warning: true};
    case 'FAILED': return {text: 'فشل الحفظ قبل تأكيد الاستمرار. لم يدّع التطبيق نجاحًا.', warning: true};
  }
}
/**
 * Switching profiles is not saving, so it gets its own copy.
 *
 * NOT_APPLIED is the important one: the board acknowledged and did not
 * change. Telling the pilot it worked would leave them tuning a profile
 * that is not flying.
 */
function profileSwitchMessage(outcome: PidProfileSwitchOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'SWITCHED': return {text: 'تم تفعيل الملف المطلوب، وأعيدت قراءة قيمه من متحكم الطيران.', warning: false};
    case 'NOT_APPLIED': return {text: 'أقرّ المتحكم الأمر لكنه ما زال يعمل على الملف السابق. لم يتغيّر شيء؛ أعد المحاولة أو تحقق من البرنامج الثابت.', warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة تبديل الملف. أعد القراءة قبل الاعتماد على القيم المعروضة.', warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء تبديل الملف.', warning: true};
    case 'FAILED': return {text: 'فشل تبديل الملف قبل أن يصل إلى المتحكم.', warning: true};
  }
}
/**
 * Changing the FORMULA is a different act from changing a value, and the
 * success line says the one thing a pilot must not misunderstand: the stored
 * numbers were not converted.
 */
function ratesTypeMessage(outcome: PidRatesTypeOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES': return {text: 'خوارزمية Rates المطلوبة هي المفعّلة أصلًا على المتحكم.', warning: false};
    case 'PERSISTED_VERIFIED': return {text: 'بُدّلت خوارزمية Rates وحُفظت. الأرقام المخزّنة لم تُحوّل؛ صارت تُقرأ بمعادلة أخرى.', warning: false};
    case 'APPLIED_PERSISTENCE_UNVERIFIED': return {text: 'طُبّقت الخوارزمية الجديدة لكن لم يثبت حفظها في ذاكرة المتحكم. لا تعتمد عليها بعد إعادة التشغيل.', warning: true};
    case 'READBACK_MISMATCH': return {text: 'بعد كتابة نوع الخوارزمية أعادت اللوحة قيم Rates مختلفة عمّا كان مخزّنًا. توقفنا قبل إكمال الحفظ.', warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة تبديل خوارزمية Rates. أعد القراءة قبل الطيران.', warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء تبديل خوارزمية Rates.', warning: true};
    case 'FAILED': return {text: 'فشل تبديل خوارزمية Rates قبل أن يصل إلى المتحكم.', warning: true};
  }
}
/**
 * A simplified save is reported as a REGENERATION, because that is what the
 * firmware did. "حُفظت الإعدادات" would describe a preference being stored;
 * what actually happened is that the board recomputed a tune.
 */
function simplifiedSaveMessage(outcome: PidSimplifiedSaveOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES': return {text: 'لا تغييرات في الضبط المبسّط.', warning: false};
    case 'SAVED_VERIFIED': return {text: 'أعاد المتحكم حساب القيم من الشرائح وحفظها، وطابقت القراءة الراجعة ما توقّعناه.', warning: false};
    case 'APPLIED_PERSISTENCE_UNVERIFIED': return {text: 'أعاد المتحكم الحساب وأكدته القراءة، لكن لم يثبت حفظه في الذاكرة. لا تعتمد عليه بعد إعادة التشغيل.', warning: true};
    case 'READBACK_MISMATCH': return {text: 'القيم التي ولّدها المتحكم لا تطابق ما يحسبه المصدر. لم يُدّع نجاح؛ أعد القراءة.', warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة الضبط المبسّط. أعد القراءة قبل الطيران.', warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء الضبط المبسّط.', warning: true};
    case 'FAILED': return {text: 'فشل الضبط المبسّط قبل أن يصل إلى المتحكم.', warning: true};
  }
}
function simplifiedLoadMessage(state: SimplifiedState): string | undefined {
  switch (state.kind) {
    case 'READING': case 'LOADED': return undefined;
    case 'PORT_ABSENT': return 'لا يقرأ هذا الإصدار من التطبيق الضبط المبسّط. هذه حدود التطبيق، لا حدود المتحكم.';
    case 'UNSUPPORTED': return 'بناء البرنامج الثابت في هذه اللوحة لا يتضمّن الضبط المبسّط، فاستخدم الإعدادات المتقدمة أدناه.';
    case 'REJECTED': return blockMessage(state.reason);
    case 'SESSION_ENDED': return 'انتهت جلسة الاتصال قبل قراءة الضبط المبسّط.';
    case 'FAILED': return 'تعذّرت قراءة الضبط المبسّط من متحكم الطيران.';
  }
}
/**
 * A rename is reported on the READBACK, never on the acknowledgement.
 *
 * The firmware truncates a long name silently and acknowledges, so "it
 * said OK" proves nothing about what is stored. NAME_MISMATCH names both
 * strings rather than telling the operator it worked.
 */
function profileNameMessage(outcome: PidProfileNameOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NAMED_VERIFIED': return {text: `حُفظ الاسم «${outcome.name}» وطابقته القراءة الراجعة.`, warning: false};
    case 'NAME': return {text: `الاسم الحالي: «${outcome.name}».`, warning: false};
    case 'NAME_MISMATCH': return {text: `طلبنا «${outcome.requested}» فأعاد المتحكم «${outcome.observed}». لم يُحفظ الاسم كما طُلب.`, warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة تسمية الملف. أعد القراءة قبل الاعتماد عليها.', warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء تسمية الملف.', warning: true};
    case 'FAILED': return {text: 'فشلت تسمية الملف قبل أن تصل إلى المتحكم.', warning: true};
  }
}

/**
 * A copy is reported field by field, and a board left on the wrong profile
 * is never silent - that is the outcome the copy lifecycle re-reads
 * MSP_STATUS_EX after every selection in order to catch.
 */
function profileCopyMessage(outcome: PidProfileCopyOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'COPIED_VERIFIED': return {text: `نُسخ الملف ${outcome.sourceIndex + 1} إلى الملف ${outcome.destinationIndex + 1}، وطابقت القراءة الراجعة المصدر.`, warning: false};
    case 'COPY_MISMATCH': return {text: `الملف ${outcome.destinationIndex + 1} لا يطابق المصدر بعد النسخ (${outcome.fields.length} حقلًا). لم يُدّع نجاح.`, warning: true};
    case 'LEFT_ON_ANOTHER_PROFILE': return {text: `المتحكم يعمل الآن على الملف ${outcome.activeIndex + 1} بدل الملف ${outcome.requestedIndex + 1} الذي طلبناه. أعد اختيار الملف قبل الطيران.`, warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة النسخ. أعد القراءة قبل الاعتماد عليها.', warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء النسخ.', warning: true};
    case 'FAILED': return {text: 'فشل النسخ قبل أن يصل إلى المتحكم.', warning: true};
  }
}

/** What each observable reset resource is called in the operator's words. */
const RESET_RESOURCE_LABELS: Readonly<Record<PidResetResource, string>> = Object.freeze({
  PID: 'قيم P/I/D للمحاور الخمسة',
  PID_ADVANCED: 'الإعدادات المتقدمة: F و D Max و TPA و Dynamic Idle',
  FILTER_CONFIG: 'مرشّحات D-term وترشيح Yaw',
  PROFILE_NAME: 'اسم الملف',
  SIMPLIFIED_TUNING: 'وضع الضبط المبسّط',
});

const resetResourceList = (resources: readonly PidResetResource[]): string =>
  resources.map(resource => RESET_RESOURCE_LABELS[resource]).join(' · ');

/**
 * A reset is reported as APPLIED and PARTIALLY VERIFIED, and as NOT
 * PERSISTED - because that is what the firmware command does. Naming it
 * "restored to defaults and saved" would be a claim the operator would
 * discover was false on the next power cycle.
 *
 * «تحقّقنا من» LISTS ONLY WHAT WAS ACTUALLY READ BACK. It used to render a
 * static capability list, so a profile-name read that failed was still
 * reported to the operator as verified. Anything the reset could not check
 * now gets its own sentence instead, because "we did not look" and "we
 * looked and it was right" are different things to tell a pilot.
 */
function profileResetMessage(outcome: PidProfileResetOutcome): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'RESET_APPLIED_PARTIALLY_VERIFIED': return {
      text: `أُعيد الملف إلى قيم المصنع في الذاكرة العاملة. تحقّقنا من: ${resetResourceList(outcome.verifiedScope)}. `
        + (outcome.verificationGaps.length > 0
          ? `تعذّر التحقق من: ${resetResourceList(outcome.verificationGaps.map(gap => gap.resource))}`
            + ' لأن قراءتها لم تُجب، ولا ندّعي صحتها. '
          : '')
        + 'بقية الحقول لم نقرأها ولا ندّعي صحتها. الأمر نفسه لا يحفظ حفظًا دائمًا؛ احفظ إن أردت بقاءه بعد فصل البطارية.',
      warning: true,
    };
    case 'READBACK_MISMATCH': return {text: `القراءة بعد الإعادة لا تطابق قيم المصنع في ${outcome.fields.length} حقلًا. لم يُدّع نجاح.`, warning: true};
    case 'REJECTED': return {text: blockMessage(outcome.reason), warning: true};
    case 'UNCONFIRMED': return {text: 'لم تتأكد نتيجة الإعادة. أعد القراءة قبل الاعتماد عليها.', warning: true};
    case 'SESSION_ENDED': return {text: 'انتهت جلسة الاتصال أثناء الإعادة.', warning: true};
    case 'FAILED': return {text: 'فشلت الإعادة قبل أن تصل إلى المتحكم.', warning: true};
  }
}

function issueMessage(issue: ReturnType<typeof validatePidTuningDraft>[number]): string {
  return ({
    PID_GAIN_INVALID: 'إحدى قيم P/I/D خارج 0–250',
    IDLE_MIN_RPM_INVALID: 'قيمة Dynamic Idle خارج 0–200',
    FEEDFORWARD_INVALID: 'إحدى قيم F خارج 0–1000',
    FEEDFORWARD_AVERAGING_INVALID: 'وضع تنعيم Feedforward غير معروف',
    FEEDFORWARD_BOOST_INVALID: 'قيمة Feedforward boost خارج 0–50',
    FEEDFORWARD_JITTER_INVALID: 'قيمة تجاهل ارتجاف العصا خارج 0–20',
    RATES_TYPE_INVALID: 'نوع Rates المقروء غير مدعوم للتحرير الآمن',
    /* Reachable only if the draft's type drifts from the board's. The
       selector keeps them equal and routes a real change through the
       separate rates-type transaction, so this reads as the defect it is. */
    RATES_TYPE_CHANGE_UNSUPPORTED: 'نوع Rates في المسودة لا يطابق ما على المتحكم؛ أعد القراءة',
    RATE_VALUE_INVALID: 'إحدى قيم Rates خارج حدود الخوارزمية الحالية',
    THROTTLE_CURVE_INVALID: 'منحنى أو حد الخانق خارج المدى المسموح',
    FILTER_VALUE_INVALID: 'إحدى قيم الفلاتر خارج حدود البرنامج الثابت',
    FILTER_ORDER_INVALID: 'حدود Min/Max للفلاتر غير متناسقة',
    FILTER_CAPABILITY_UNPROVEN: 'لا يمكن تفعيل أو تعطيل وضع فلتر لم تثبته القراءة الحالية',
    FILTER_RATE_UNKNOWN: 'لا يمكن تعديل الفلاتر دون معرفة Gyro وPID loop rate',
    FILTER_EXCEEDS_NYQUIST: 'أحد ترددات الفلاتر يبلغ أو يتجاوز حد Nyquist',
    ADVANCED_PID_VALUE_INVALID: 'إحدى قيم الإعدادات المتقدمة خارج حدود البرنامج الثابت',
    ADVANCED_FILTER_VALUE_INVALID: 'إحدى قيم الفلاتر المتقدمة خارج حدود البرنامج الثابت',
    RPM_FILTER_VALUE_INVALID: 'إحدى قيم مرشّح RPM خارج حدود البرنامج الثابت، والمتحكم يرفض الرسالة كاملة',
  })[issue];
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** A section that can be folded away. Used for explanations, the secondary
 * sliders and the whole advanced block, so the main page stays short. */
function Disclosure({label, open, onToggle, testID, tone = 'plain', children}: {label: string; open: boolean; onToggle: () => void; testID: string; tone?: 'plain' | 'card'; children: React.ReactNode}) {
  return <View style={tone === 'card' ? styles.disclosureCard : undefined} testID={testID}>
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{expanded: open}} accessibilityLabel={label} style={styles.disclosureHeader} testID={`${testID}-toggle`}>
      <Text style={styles.disclosureLabel}>{label}</Text>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accentStrong} />
    </Pressable>
    {open ? <View style={styles.disclosureBody} testID={`${testID}-body`}>{children}</View> : null}
  </View>;
}

function NumericField({label, value, min = 0, max, disabled, note, onChange, testID}: {label: string; value: number; min?: number; max: number; disabled: boolean; note?: string; onChange: (value: number) => void; testID: string}) {
  const apply = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next))));
  return <View style={styles.numericField}><Text style={styles.fieldLabel}>{label}</Text><SharedStepper value={String(value)} onDecrement={() => apply(value - 1)} onIncrement={() => apply(value + 1)} decrementDisabled={value <= min} incrementDisabled={value >= max} disabled={disabled} onChangeText={text => { const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) apply(parsed); }} accessibilityLabel={label} testID={testID} /><Text style={styles.rangeHint}>{`${min} – ${max}`}</Text>{note === undefined ? null : <Text style={styles.fieldNote}>{note}</Text>}</View>;
}

/**
 * One rate field, told entirely by `ratesPresentation`.
 *
 * The label, the display scale, the bounds and the unit all arrive as data,
 * because all four change meaning when the formula changes and the screen
 * has no business holding a second copy of that table.
 */
function RateField({field, rawValue, disabled, onChange, testID}: {field: RateAxisPresentation[keyof RateAxisPresentation]; rawValue: number; disabled: boolean; onChange: (value: number) => void; testID: string}) {
  const apply = (next: number) => onChange(Math.min(field.max, Math.max(field.min, Math.round(next))));
  const label = field.unit === undefined ? field.label : `${field.label} ${field.unit}`;
  const decimals = field.scale < 1 ? 2 : 0;
  return <View style={styles.numericField}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <SharedStepper value={(rawValue * field.scale).toFixed(decimals)} onDecrement={() => apply(rawValue - 1)} onIncrement={() => apply(rawValue + 1)} decrementDisabled={rawValue <= field.min} incrementDisabled={rawValue >= field.max} disabled={disabled} keyboardType="decimal-pad" onChangeText={text => { const parsed = Number.parseFloat(text.replace(',', '.')); if (Number.isFinite(parsed)) apply(parsed / field.scale); }} accessibilityLabel={label} testID={testID} />
    <Text style={styles.rangeHint}>{`${formatRateField(field, field.min)} – ${formatRateField(field, field.max)}`}</Text>
  </View>;
}

/**
 * A generator input, shown as the multiplier it is.
 *
 * The centre is READ-ONLY on purpose. `1.13×` is a rendering of the stored
 * byte 113, and letting the pilot type into a rendering invites the two to
 * disagree - the ambiguity that `formatMultiplier` exists to remove.
 */
function MultiplierStepper({label, raw, min, disabled, onChange, testID}: {label: string; raw: number; min: number; disabled: boolean; onChange: (raw: number) => void; testID: string}) {
  const apply = (next: number) => onChange(Math.min(SIMPLIFIED_TUNING_MAX, Math.max(min, next)));
  return <SharedStepper value={formatMultiplier(raw)} onDecrement={() => apply(raw - MULTIPLIER_STEP)} onIncrement={() => apply(raw + MULTIPLIER_STEP)} decrementDisabled={raw <= min} incrementDisabled={raw >= SIMPLIFIED_TUNING_MAX} disabled={disabled} accessibilityLabel={label} testID={testID} />;
}

/**
 * The active profile, and the way to change it.
 *
 * It renders the BOARD's reported index, never a local selection: a press
 * asks the flight controller to switch and the component only moves once the
 * re-read says it did. The name beside the number comes from the board too -
 * when it sends none, the row shows none rather than inventing one, which is
 * still better than the bare `1 | 1` this bar used to be.
 */
function ProfileSelector({label, hint, name, count, active, disabled, onSelect, testID}: {label: string; hint: string; name?: string; count?: number; active?: number; disabled: boolean; onSelect: (index: number) => void; testID: string}) {
  const total = count ?? 0;
  return <View style={styles.profileBadge} testID={testID}>
    <Text style={styles.profileLabel}>{label}</Text>
    {name === undefined || name.length === 0 ? null : <Text style={styles.profileName} testID={`${testID}-name`}>{name}</Text>}
    {active === undefined || total < 1
      ? <Text style={styles.profileValue}>—</Text>
      : <View style={styles.choiceRow}>{Array.from({length: total}, (_, index) => <Pressable key={index} accessibilityRole="button" accessibilityState={{selected: index === active, disabled}} accessibilityLabel={`${label} ${index + 1}`} disabled={disabled || index === active} onPress={() => onSelect(index)} style={[styles.profileChoice, index === active && styles.choiceSelected]} testID={`${testID}-${index + 1}`}><Text style={[styles.choiceText, index === active && styles.choiceTextSelected]}>{index + 1}</Text></Pressable>)}</View>}
    <Text style={styles.profileHint}>{hint}</Text>
  </View>;
}

function AxisCard({axisKey, title, subtitle, value, disabled, ownedFields, update}: {axisKey: PidAxisKey; title: string; subtitle: string; value: PidAxisDraft; disabled: boolean; ownedFields: ReadonlySet<string>; update: (axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => void}) {
  const owned = (term: 'P' | 'I' | 'D' | 'F') => ownedFields.has(`${axisKey.toUpperCase()}.${term}`);
  const field = (term: 'p' | 'i' | 'd' | 'f', upper: 'P' | 'I' | 'D' | 'F', max: number) =>
    <NumericField key={term} label={upper} value={value[term]} max={max} disabled={disabled || owned(upper)} note={owned(upper) ? GENERATOR_OWNED_NOTE : undefined} onChange={next => update(axisKey, term, next)} testID={`pid-${axisKey}-${term}`} />;
  return <View style={styles.axisCard} testID={`pid-axis-${axisKey}`}><View><Text style={styles.axisTitle}>{title}</Text><Text style={styles.axisSubtitle}>{subtitle}</Text></View><View style={styles.fieldsRow}>{field('p', 'P', 250)}{field('i', 'I', 250)}{field('d', 'D', 250)}{field('f', 'F', 1000)}</View></View>;
}

function RateAxisCard({axisKey, title, value, presentation, disabled, update}: {axisKey: PidAxisKey; title: string; value: RateAxisDraft; presentation: RateAxisPresentation; disabled: boolean; update: (axis: PidAxisKey, term: keyof RateAxisDraft, value: number) => void}) {
  return <View style={styles.axisCard} testID={`pid-rate-axis-${axisKey}`}><Text style={styles.axisTitle}>{title}</Text><View style={styles.fieldsRow}>
    <RateField field={presentation.rcRate} rawValue={value.rcRate} disabled={disabled} onChange={next => update(axisKey, 'rcRate', next)} testID={`pid-rate-${axisKey}-rc`} />
    <RateField field={presentation.superRate} rawValue={value.superRate} disabled={disabled} onChange={next => update(axisKey, 'superRate', next)} testID={`pid-rate-${axisKey}-super`} />
    <RateField field={presentation.expo} rawValue={value.expo} disabled={disabled} onChange={next => update(axisKey, 'expo', next)} testID={`pid-rate-${axisKey}-expo`} />
    <RateField field={presentation.rateLimit} rawValue={value.limit} disabled={disabled} onChange={next => update(axisKey, 'limit', next)} testID={`pid-rate-${axisKey}-limit`} />
  </View></View>;
}

/**
 * A simplified filter block: the switch, the multiplier, and the frequencies
 * those two would actually produce.
 *
 * The range is projected by `simplifiedTuningGenerator` - the same code the
 * controller's verification uses - so the number on screen and the number the
 * write expects can never come from two different opinions. A block whose
 * stored frequency is zero says so instead of pretending the multiplier will
 * switch it on.
 */
function SimplifiedFilterCard({copy, block, observed, disabled, onToggle, onMultiplier, testID}: {copy: {title: string; help: string}; block: {enabled: boolean; multiplier: number}; observed: ObservedFilterFrequencies; disabled: boolean; onToggle: (next: boolean) => void; onMultiplier: (raw: number) => void; testID: string}) {
  const generated: GeneratedFilterFrequencies = testID.includes('gyro')
    ? generateSimplifiedGyroFilters(block.enabled, block.multiplier, observed, GENERATOR_DEFAULTS)
    : generateSimplifiedDtermFilters(block.enabled, block.multiplier, observed, GENERATOR_DEFAULTS);
  const lpf1 = generated.lpf1DynMinHz > 0
    ? formatEffectiveRange(generated.lpf1DynMinHz, generated.lpf1DynMaxHz)
    : generated.lpf1StaticHz > 0 ? formatEffectiveRange(generated.lpf1StaticHz, generated.lpf1StaticHz) : undefined;
  return <View style={styles.filterCard} testID={testID}>
    <View style={styles.filterHead}>
      <View style={styles.filterCopy}><Text style={styles.fieldLabel}>{copy.title}</Text><Text style={styles.sectionHint}>{copy.help}</Text></View>
      <ToggleSwitch value={block.enabled} onValueChange={onToggle} disabled={disabled} accessibilityLabel={copy.title} testID={`${testID}-toggle`} />
    </View>
    {block.enabled ? <>
      <MultiplierStepper label={`${copy.title}: قوة الفلترة`} raw={block.multiplier} min={SIMPLIFIED_TUNING_FILTERS_MIN} disabled={disabled} onChange={onMultiplier} testID={`${testID}-multiplier`} />
      {lpf1 === undefined
        ? <Text style={styles.fieldNote} testID={`${testID}-zero`}>{SIMPLIFIED_ZERO_FILTER_NOTE}</Text>
        : <Text style={styles.effectiveRange} testID={`${testID}-range`}>{`التردد الفعّال: ${lpf1}`}</Text>}
      {generated.lpf2StaticHz > 0 ? <Text style={styles.fieldNote} testID={`${testID}-lpf2`}>{`المرحلة الثانية: ${formatEffectiveRange(generated.lpf2StaticHz, generated.lpf2StaticHz)}`}</Text> : null}
    </> : null}
  </View>;
}

export default function PidTuningScreen({sessionKey, active, onOpenMotors, onDirtyChange, controller = pidTuningController}: PidTuningScreenProps): React.JSX.Element {
  const {t} = useTranslation(); const {width, fontScale} = useWindowDimensions(); const {maxWidth} = useContentEnvelope(true); const wide = width / Math.max(fontScale, 1) >= 1040;
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<MspPidTuningSnapshot>();
  const [draft, setDraft] = useState<PidTuningDraft>();
  const [loadOutcome, setLoadOutcome] = useState<PidLoadOutcome>();
  const [simplifiedState, setSimplifiedState] = useState<SimplifiedState>({kind: 'READING'});
  const [simplifiedPatch, setSimplifiedPatch] = useState<SimplifiedTuningPatch>(EMPTY_PATCH);
  const [pendingRatesType, setPendingRatesType] = useState<number>();
  const [profileNames, setProfileNames] = useState<{pid?: string; rate?: string}>({});
  const [reloadToken, setReloadToken] = useState(0);
  const [previewAxis, setPreviewAxis] = useState<'roll' | 'pitch' | 'yaw'>('roll');
  const [moreSlidersOpen, setMoreSlidersOpen] = useState(false);
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [overwriteDetailOpen, setOverwriteDetailOpen] = useState(false);
  const [advancedChoice, setAdvancedChoice] = useState<boolean>();
  /**
   * ONE STATUS SLOT, NOT ONE PER OPERATION.
   *
   * The screen used to keep a save result and a switch result side by side
   * and render whichever it found first, so retiring the newer one UNCOVERED
   * the older: switch, edit, save, edit - and the profile-switch message from
   * three actions ago came back as if it had just happened. The status line
   * can only ever be about one thing, whatever the operator did last, so
   * there is exactly one place to put it and any edit clears it.
   */
  const [status, setStatus] = useState<{text: string; warning: boolean}>();
  const retireStatus = useCallback(() => setStatus(undefined), []);

  /**
   * The reads that belong to the ACTIVE PROFILE rather than to the session.
   *
   * Both the simplified block and the profile name move when the board
   * switches profile, so a switch has to refresh them - but NOT by re-running
   * the whole load, which clears the status line and would erase the very
   * message explaining what just happened.
   */
  const refreshProfileScoped = useCallback(async (key: SetupUiSessionKey, alive: () => boolean): Promise<void> => {
    if (controller.loadSimplified === undefined) { setSimplifiedState({kind: 'PORT_ABSENT'}); }
    else {
      let simplified: PidSimplifiedLoadOutcome;
      try { simplified = await controller.loadSimplified(key); } catch (error) { simplified = {kind: 'FAILED', error}; }
      if (!alive()) return;
      setSimplifiedState(simplified);
    }
    // Names are decoration: a failure to read one must never disturb the
    // page, and an absent name is left absent rather than filled in.
    if (controller.readProfileName === undefined) return;
    for (const kind of ['PID', 'RATE'] as const) {
      try {
        const named = await controller.readProfileName(key, kind);
        if (!alive()) return;
        if (named.kind === 'NAME') setProfileNames(current => ({...current, [kind === 'PID' ? 'pid' : 'rate']: named.name}));
      } catch { /* an unreadable name is simply not shown */ }
    }
  }, [controller]);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    let cancelled = false;
    setPhase('LOADING'); retireStatus();
    setSimplifiedState({kind: 'READING'}); setSimplifiedPatch(EMPTY_PATCH); setPendingRatesType(undefined); setProfileNames({});
    const run = async (): Promise<void> => {
      let outcome: PidLoadOutcome;
      try { outcome = await controller.load(sessionKey); } catch (error) { outcome = {kind: 'FAILED', error}; }
      if (cancelled) return;
      setLoadOutcome(outcome);
      if (outcome.kind !== 'LOADED') { setSnapshot(undefined); setDraft(undefined); setPhase('ERROR'); setSimplifiedState({kind: 'READING'}); return; }
      setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot)); setPhase('READY');
      await refreshProfileScoped(sessionKey, () => !cancelled);
    };
    // Every step above converts its own failure into a rendered outcome, so
    // the only thing that can reach here is a defect in this component.
    run().catch(error => { if (!cancelled) { setLoadOutcome({kind: 'FAILED', error}); setPhase('ERROR'); } });
    return () => { cancelled = true; };
  }, [active, controller, refreshProfileScoped, reloadToken, retireStatus, sessionKey]);

  /* ---------------------------------------------------------------- */
  /* Derived state                                                     */
  /* ---------------------------------------------------------------- */

  const observedSimplified: MspSimplifiedTuning | undefined = simplifiedState.kind === 'LOADED' ? simplifiedState.simplified : undefined;
  /**
   * The draft simplified block, built by ENCODING the patch and DECODING it
   * back - the exact round trip the controller will perform. Deriving it any
   * other way would create a second interpretation of the same 53 bytes.
   */
  const draftSimplified = useMemo(() => {
    if (observedSimplified === undefined) return undefined;
    try { return decodeSimplifiedTuning(encodeSimplifiedTuning(observedSimplified, simplifiedPatch)); }
    catch { return undefined; }
  }, [observedSimplified, simplifiedPatch]);
  const simplifiedDirty = draftSimplified !== undefined && observedSimplified !== undefined
    && !draftSimplified.raw.every((byte, index) => byte === observedSimplified.raw[index]);
  const simplifiedMode = draftSimplified === undefined ? undefined : simplifiedModeCopy(draftSimplified.pids.mode);
  const simplifiedGenerating = draftSimplified !== undefined && (draftSimplified.pids.mode.kind === 'RP' || draftSimplified.pids.mode.kind === 'RPY');
  const ownedDirectFields = useMemo(() => generatorOwnedDirectFields(draftSimplified), [draftSimplified]);

  const boardRatesTypeRaw = snapshot?.rcTuning.ratesType;
  const effectiveRatesTypeRaw = pendingRatesType ?? boardRatesTypeRaw;
  const effectiveRatesType = effectiveRatesTypeRaw === undefined ? undefined : classifyRatesType(effectiveRatesTypeRaw);
  const ratePresentation = effectiveRatesType === undefined ? undefined : rateAxisPresentation(effectiveRatesType);
  const ratesTypeDirty = pendingRatesType !== undefined && boardRatesTypeRaw !== undefined && pendingRatesType !== boardRatesTypeRaw;
  /**
   * A value that is legal under the current formula can be illegal under the
   * one being selected - the bounds table differs per type. Caught here so
   * the pilot fixes it before the write, instead of the controller refusing
   * a transaction it already started.
   */
  const pendingRangeIssue = useMemo(() => {
    if (!ratesTypeDirty || draft === undefined || ratePresentation === undefined) return false;
    return AXES.some(axis => {
      const value = draft.rates[axis.key];
      return value.rcRate < ratePresentation.rcRate.min || value.rcRate > ratePresentation.rcRate.max
        || value.superRate < ratePresentation.superRate.min || value.superRate > ratePresentation.superRate.max
        || value.expo < ratePresentation.expo.min || value.expo > ratePresentation.expo.max;
    });
  }, [draft, ratePresentation, ratesTypeDirty]);

  const valuesDirty = snapshot !== undefined && draft !== undefined && !pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft);
  const dirty = valuesDirty || simplifiedDirty || ratesTypeDirty;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const issues = useMemo(() => draft === undefined ? [] : validatePidTuningDraft(draft, snapshot), [draft, snapshot]);
  const blocked = issues.length > 0 || pendingRangeIssue;
  /* DOES THIS SCREEN'S BASELINE BELONG TO THE SESSION IT WOULD WRITE
     THROUGH? `sessionKey` is a prop; the snapshot and the draft are state
     that outlive a prop change by at least one render - and by the entire
     reload if that reload is slow, or forever if it is refused. In that
     window `dirty` is still true and the Save button is still live, over
     a draft built against a DIFFERENT aircraft. This screen's save chains
     THREE writes (rates algorithm, values, simplified), so the check has
     to sit in front of the chain rather than in front of one call. The
     controller refuses each of the three as well; both layers are
     required, and this is the one the operator can see.
     See core/state/configurationSessionOwnership. */
  const saveBlockedBySession = isOwnedByDifferentConfigurationSession(snapshot, sessionKey);

  /**
   * ADVANCED OPENS ITSELF WHEN THE SIMPLIFIED WORKSPACE CANNOT WORK.
   *
   * Not a convenience: with no readable generator - or a mode no pinned tree
   * defines - the direct controls are the only tuning surface left, and a
   * page whose main section is an apology with everything else folded away
   * reads as broken. The operator's own choice always wins once made.
   */
  const advancedDefaultOpen = simplifiedState.kind !== 'READING'
    && (simplifiedState.kind !== 'LOADED' || simplifiedMode?.known === false);
  const advancedOpen = advancedChoice ?? advancedDefaultOpen;

  /* ---------------------------------------------------------------- */
  /* Edits                                                             */
  /* ---------------------------------------------------------------- */

  const updateFeel = useCallback((key: 'feedforwardAveraging' | 'feedforwardBoost' | 'feedforwardJitterFactor', value: number) => {
    setDraft(current => current === undefined ? current : Object.freeze({...current, [key]: value}));
    retireStatus();
  }, [retireStatus]);
  const update = useCallback((axis: PidAxisKey, term: keyof PidAxisDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, [axis]: Object.freeze({...current[axis], [term]: value})})); retireStatus(); }, [retireStatus]);
  const updateRate = useCallback((axis: PidAxisKey, term: keyof RateAxisDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, rates: Object.freeze({...current.rates, [axis]: Object.freeze({...current.rates[axis], [term]: value})})})); retireStatus(); }, [retireStatus]);
  const updateThrottle = useCallback((term: keyof Omit<RatesDraft, PidAxisKey | 'type'>, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, rates: Object.freeze({...current.rates, [term]: value})})); retireStatus(); }, [retireStatus]);
  const updateFilter = useCallback((term: keyof FiltersDraft, value: number) => { setDraft(current => current === undefined ? current : Object.freeze({...current, filters: Object.freeze({...current.filters, [term]: value})})); retireStatus(); }, [retireStatus]);
  /* The two P-E advanced groups. Kept as their own setters rather than one
     generic patcher, because the two sub-drafts live in different MSP
     payloads with different scopes and merging them would invite code that
     forgets which is which. */
  const updateAdvanced = useCallback((field: AdvancedPidFieldKey, value: number) => {
    setDraft(current => current === undefined ? current : Object.freeze({...current, advanced: Object.freeze({...current.advanced, [field]: value})}));
    retireStatus();
  }, [retireStatus]);
  const updateAdvancedFilter = useCallback((field: AdvancedFilterFieldKey, value: number) => {
    setDraft(current => current === undefined ? current : Object.freeze({...current, advancedFilters: Object.freeze({...current.advancedFilters, [field]: value})}));
    retireStatus();
  }, [retireStatus]);
  /* The RPM group needs `withRpmFilterValue` rather than a spread, because
     three of its fields live inside a fixed-length weights tuple and five of
     them may not exist at all under this board's wire contract. That helper
     is also the thing that DROPS a tail edit on a contract with no tail,
     instead of materialising the tail a spread would have created. */
  const updateRpmFilter = useCallback((field: RpmFilterFieldKey, value: number) => {
    setDraft(current => current === undefined
      ? current
      : Object.freeze({...current, rpmFilter: withRpmFilterValue(current.rpmFilter, field, value)}));
    retireStatus();
  }, [retireStatus]);
  const patchPids = useCallback((patch: SimplifiedPidInputPatch) => { setSimplifiedPatch(current => Object.freeze({...current, pids: {...current.pids, ...patch}})); retireStatus(); }, [retireStatus]);
  const patchBlock = useCallback((block: 'gyro' | 'dterm', patch: SimplifiedFilterPatch) => { setSimplifiedPatch(current => Object.freeze({...current, [block]: {...current[block], ...patch}})); retireStatus(); }, [retireStatus]);

  const discard = useCallback(() => {
    if (snapshot !== undefined) setDraft(createPidTuningDraft(snapshot));
    setSimplifiedPatch(EMPTY_PATCH); setPendingRatesType(undefined); retireStatus();
  }, [retireStatus, snapshot]);
  const reload = useCallback(() => { const perform = () => setReloadToken(value => value + 1); if (!dirty) return perform(); Alert.alert('تجاهل تغييرات الضبط؟', 'ستُستبدل القيم الحالية بقراءة جديدة من متحكم الطيران.', [{text: 'إلغاء', style: 'cancel'}, {text: 'إعادة القراءة', style: 'destructive', onPress: perform}]); }, [dirty]);

  /* ---------------------------------------------------------------- */
  /* The save chain                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * THREE WRITES, IN ONE ORDER, EACH REBASED ON THE LAST.
   *
   * 1. The rates FORMULA, because the value validator refuses a draft whose
   *    type differs from the board's - the type has to land before the
   *    numbers under it can be checked at all.
   * 2. The values, against the snapshot step 1 returned.
   * 3. The simplified sliders LAST, because a simplified write makes the
   *    flight controller REGENERATE the very PID values step 2 just wrote.
   *    Running it first would leave step 2 sending stale numbers back over
   *    the generation and silently undoing it.
   *
   * Any step that does not clearly succeed ends the chain: a half-applied
   * tune reported as success is the failure mode this ordering exists to
   * prevent.
   */
  const save = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || draft === undefined || blocked || saveBlockedBySession) return;
    setPhase('SAVING'); retireStatus();
    let base = snapshot;
    let working = draft;
    let last: {text: string; warning: boolean} | undefined;
    let halted = false;
    /** Only a dead link or a thrown error leaves the SCREEN in an error
     * phase; a refusal or a mismatch is a rendered result, not a broken page. */
    let terminal = false;

    if (ratesTypeDirty && pendingRatesType !== undefined && controller.setRatesType !== undefined) {
      let outcome: PidRatesTypeOutcome;
      try { outcome = await controller.setRatesType(sessionKey, base, pendingRatesType); }
      catch (error) { outcome = {kind: 'FAILED', error}; }
      last = ratesTypeMessage(outcome);
      if (outcome.kind === 'PERSISTED_VERIFIED' || outcome.kind === 'NO_CHANGES') {
        base = outcome.snapshot;
        working = Object.freeze({...working, rates: Object.freeze({...working.rates, type: base.rcTuning.ratesType})});
        setSnapshot(base); setPendingRatesType(undefined);
      } else { halted = true; terminal = outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED'; }
    }

    if (!halted && !pidTuningDraftsEqual(createPidTuningDraft(base), working)) {
      let outcome: PidSaveOutcome;
      try { outcome = await controller.save(sessionKey, base, working); }
      catch (error) { outcome = {kind: 'FAILED', error}; }
      last = saveMessage(outcome);
      if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') { base = outcome.snapshot; setSnapshot(base); }
      else { halted = true; terminal = outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED'; }
    }

    if (!halted && simplifiedDirty && controller.saveSimplified !== undefined) {
      let outcome: PidSimplifiedSaveOutcome;
      try { outcome = await controller.saveSimplified(sessionKey, base, simplifiedPatch); }
      catch (error) { outcome = {kind: 'FAILED', error}; }
      last = simplifiedSaveMessage(outcome);
      if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {
        base = outcome.snapshot; setSnapshot(base); setSimplifiedPatch(EMPTY_PATCH);
        // The generator rewrote the effective filter frequencies, so the
        // block on screen is now stale. Re-read it rather than display our
        // own projection as if the board had confirmed it.
        if (controller.loadSimplified !== undefined) {
          try { setSimplifiedState(await controller.loadSimplified(sessionKey)); }
          catch (error) { setSimplifiedState({kind: 'FAILED', error}); }
        }
      } else { halted = true; terminal = outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED'; }
    }

    setDraft(createPidTuningDraft(base));
    setStatus(last ?? {text: 'لا توجد تغييرات جديدة.', warning: false});
    setPhase(terminal ? 'ERROR' : 'READY');
  }, [saveBlockedBySession, blocked, controller, draft, pendingRatesType, ratesTypeDirty, retireStatus, sessionKey, simplifiedDirty, simplifiedPatch, snapshot]);

  /**
   * SWITCHES THE ACTIVE PROFILE ON THE BOARD, not in this component.
   *
   * The snapshot that comes back is the board's own re-read, so the screen
   * renders what is ACTUALLY active - including the case where the board
   * acknowledged and did not move (NOT_APPLIED), which must never look like
   * success. Unsaved edits are refused rather than silently discarded:
   * switching profiles replaces every value shown, and pretending an edit
   * followed the pilot to the new profile would be a lie about which tune
   * is flying.
   */
  const selectProfile = useCallback(async (kind: PidProfileKind, index: number) => {
    if (sessionKey === undefined || controller.selectProfile === undefined) return;
    if (dirty) {
      Alert.alert('لديك تغييرات غير محفوظة', 'تبديل الملف سيستبدل كل ما هو معروض بقيم الملف الجديد، ولن تنتقل تعديلاتك معه. احفظ أولًا أو تجاهل التغييرات.', [{text: 'حسنًا', style: 'cancel'}]);
      return;
    }
    setPhase('SAVING'); retireStatus();
    let outcome: PidProfileSwitchOutcome;
    try { outcome = await controller.selectProfile(sessionKey, kind, index); }
    catch (error) { outcome = {kind: 'FAILED', error}; }
    setStatus(profileSwitchMessage(outcome));
    if (outcome.kind === 'SWITCHED' || outcome.kind === 'NOT_APPLIED') {
      setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot));
      setSimplifiedPatch(EMPTY_PATCH); setPendingRatesType(undefined);
      // The simplified block and the profile name belong to the profile that
      // just moved underneath us, so they are re-read HERE rather than by
      // re-running the whole load - which would clear the status line and
      // erase the very message describing what just happened.
      setPhase('READY');
      await refreshProfileScoped(sessionKey, () => true);
      return;
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, dirty, refreshProfileScoped, retireStatus, sessionKey]);

  /**
   * THE THREE WHOLE-PROFILE OPERATIONS.
   *
   * Each refuses to run over unsaved edits for the same reason profile
   * switching does: all three replace values that are on screen, and
   * carrying a draft across that would be a lie about which tune is
   * stored. Each reports the controller's own outcome verbatim - a rename
   * that came back different is NAME_MISMATCH, a reset is
   * RESET_APPLIED_PARTIALLY_VERIFIED and says which part was checked.
   */
  const guardUnsaved = useCallback((): boolean => {
    if (!dirty) return true;
    Alert.alert('لديك تغييرات غير محفوظة', 'هذه العملية تستبدل قيم الملف. احفظ أولًا أو تجاهل التغييرات.', [{text: 'حسنًا', style: 'cancel'}]);
    return false;
  }, [dirty]);

  const renameProfile = useCallback(async (name: string) => {
    if (sessionKey === undefined || controller.setProfileName === undefined) return;
    if (!guardUnsaved()) return;
    setPhase('SAVING'); retireStatus();
    let outcome: PidProfileNameOutcome;
    try { outcome = await controller.setProfileName(sessionKey, 'PID', name); }
    catch (error) { outcome = {kind: 'FAILED', error}; }
    setStatus(profileNameMessage(outcome));
    if (outcome.kind === 'NAMED_VERIFIED' || outcome.kind === 'NAME') {
      setProfileNames(current => ({...current, pid: outcome.name}));
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, guardUnsaved, retireStatus, sessionKey]);

  const copyProfile = useCallback(async (sourceIndex: number, destinationIndex: number) => {
    if (sessionKey === undefined || controller.copyProfile === undefined) return;
    if (!guardUnsaved()) return;
    setPhase('SAVING'); retireStatus();
    let outcome: PidProfileCopyOutcome;
    try { outcome = await controller.copyProfile(sessionKey, {kind: 'PID', sourceIndex, destinationIndex}); }
    catch (error) { outcome = {kind: 'FAILED', error}; }
    setStatus(profileCopyMessage(outcome));
    if (outcome.kind === 'COPIED_VERIFIED') {
      setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot));
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, guardUnsaved, retireStatus, sessionKey]);

  const resetProfile = useCallback(async () => {
    if (sessionKey === undefined || controller.resetPidProfile === undefined) return;
    if (!guardUnsaved()) return;
    setPhase('SAVING'); retireStatus();
    let outcome: PidProfileResetOutcome;
    try { outcome = await controller.resetPidProfile(sessionKey); }
    catch (error) { outcome = {kind: 'FAILED', error}; }
    setStatus(profileResetMessage(outcome));
    if (outcome.kind === 'RESET_APPLIED_PARTIALLY_VERIFIED') {
      setSnapshot(outcome.snapshot); setDraft(createPidTuningDraft(outcome.snapshot));
      setSimplifiedPatch(EMPTY_PATCH); setPendingRatesType(undefined);
      // The reset rewrote the name and the simplified sliders too, so both
      // are re-read rather than left showing what they were before.
      await refreshProfileScoped(sessionKey, () => true);
    }
    setPhase(outcome.kind === 'FAILED' || outcome.kind === 'SESSION_ENDED' ? 'ERROR' : 'READY');
  }, [controller, guardUnsaved, refreshProfileScoped, retireStatus, sessionKey]);

  const loadingMessage = loadOutcome?.kind === 'REJECTED' ? blockMessage(loadOutcome.reason) : loadOutcome?.kind === 'FAILED' ? 'تعذرت قراءة إعدادات PID من متحكم الطيران.' : loadOutcome?.kind === 'SESSION_ENDED' ? 'انتهت جلسة الاتصال.' : undefined;
  const gyroNyquist = snapshot?.gyroSampleRateHz === undefined ? undefined : snapshot.gyroSampleRateHz / 2;
  const pidNyquist = snapshot?.gyroSampleRateHz === undefined || snapshot.pidProcessDenom === undefined || snapshot.pidProcessDenom < 1 ? undefined : snapshot.gyroSampleRateHz / snapshot.pidProcessDenom / 2;
  const filtersEditable = gyroNyquist !== undefined && pidNyquist !== undefined;
  const busy = phase !== 'READY';
  const simplifiedNotice = simplifiedLoadMessage(simplifiedState);
  const overwrite = draftSimplified !== undefined && simplifiedDirty ? overwriteSummary(draftSimplified) : undefined;
  const axisSettings = (axis: RateAxisDraft): RateAxisSettings => ({rcRate: axis.rcRate, superRate: axis.superRate, expo: axis.expo, rateLimit: axis.limit});
  const dirtyScopes = [
    ...(simplifiedDirty ? ['الضبط المبسّط'] : []),
    ...(ratesTypeDirty ? ['خوارزمية Rates'] : []),
    ...(valuesDirty ? ['القيم'] : []),
  ];

  const sliderRow = (slider: SimplifiedSliderCopy) => {
    if (draftSimplified === undefined) return null;
    const raw = draftSimplified.pids[slider.key as Exclude<SimplifiedSliderKey, never>];
    return <View key={slider.key} style={styles.sliderRow} testID={`pid-simplified-${slider.key}`}>
      <View style={styles.sliderCopy}><Text style={styles.fieldLabel}>{slider.label}</Text><Text style={styles.sectionHint}>{slider.help}</Text></View>
      <MultiplierStepper label={slider.label} raw={raw} min={SIMPLIFIED_TUNING_PIDS_MIN} disabled={busy} onChange={next => patchPids({[slider.key]: next})} testID={`pid-simplified-${slider.key}-value`} />
    </View>;
  };

  return <View style={styles.root} testID="pid-screen"><ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
    {/* 1. WHAT THIS PAGE IS. One line, not a paragraph - the safety notice
        below carries the warning, and repeating it in the header would just
        push the first control further down. */}
    <View style={styles.hero}><Text style={styles.title}>ضبط PID</Text><Text style={styles.subtitle}>اضبط قوة تصحيح المتحكم وسرعة استجابة الطائرة. لا يُرسل أي تعديل قبل إثبات أن المتحكم DISARMED، وتُقرأ كل كتابة مرة أخرى للتحقق.</Text></View>

    <NoticeBox variant="danger" title="تغيير الضبط قد يجعل الطائرة غير مستقرة" testID="pid-danger">
      <Text style={styles.dangerText}>انزع المراوح أثناء الإعداد، وغيّر تدريجيًا، واحتفظ بنسخة من القيم الأصلية. نجاح أمر MSP لا يعني أن الضبط مناسب للطيران.</Text>
    </NoticeBox>

    {/* THE HARDWARE-VERIFICATION NOTICE STAYS AT PAGE LEVEL.
        It was briefly moved inside «الإعدادات المتقدمة» while the hierarchy
        was rebuilt, and `hardwareVerificationNotice.test.tsx` - the app-wide
        wall that requires every screen to carry it - failed immediately.
        Rightly: a disclosure a pilot never opens is the same as not saying
        it. The statement is about the WHOLE page, so it sits with the other
        page-level warning and is never folded away. */}
    <View style={styles.hardwareNotice} testID="pid-hardware-notice">
      <Text style={styles.hardwareTitle}>{t('hardwareVerification.behaviourTitle')}</Text>
      <Text style={styles.hardwareText}>الترميز والقراءة الراجعة مختبران آليًا، لكن النتيجة الديناميكية لا يمكن اعتمادها دون Flight Controller وطائرة حقيقية واختبار متدرج آمن.</Text>
    </View>

    {loadingMessage !== undefined ? <View style={styles.warning} testID="pid-load-message"><Text style={styles.warningText}>{loadingMessage}</Text>{loadOutcome?.kind === 'REJECTED' && loadOutcome.reason === 'MOTOR_TEST_ACTIVE' ? <Button label="فتح شاشة المحركات" onPress={onOpenMotors} variant="secondary" icon="fan" style={styles.inlineAction} /> : <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} />}</View> : null}

    {draft !== undefined ? <>
      {/* 2. WHO AM I TUNING. Two selectors that used to read `1 | 1`; each
          now carries what it governs and, when the board sends one, its
          name. */}
      <View style={styles.profileBadges}>
        <ProfileSelector label="ملف PID" hint="يحكم قوة التصحيح والفلاتر" name={profileNames.pid} testID="pid-active-profile" count={snapshot?.pidProfileCount} active={snapshot?.pidProfileIndex} disabled={busy || controller.selectProfile === undefined} onSelect={index => selectProfile('PID', index)} />
        <ProfileSelector label="ملف Rates" hint="يحكم سرعة الدوران واستجابة العصا" name={profileNames.rate} testID="pid-active-rates-profile" count={snapshot?.rateProfileCount} active={snapshot?.controlRateProfileIndex} disabled={busy || controller.selectProfile === undefined} onSelect={index => selectProfile('RATE', index)} />
      </View>

      {/* 3. THE MAIN WORKSPACE. */}
      <View style={styles.section} testID="pid-simplified">
        <Text style={styles.sectionTitle}>الضبط المبسّط</Text>
        <Text style={styles.sectionHint}>{SIMPLIFIED_SUMMARY}</Text>
        <Disclosure label="كيف يعمل الضبط المبسّط؟" open={explanationOpen} onToggle={() => setExplanationOpen(value => !value)} testID="pid-simplified-explanation">
          <Text style={styles.bodyText}>{SIMPLIFIED_EXPLANATION}</Text>
        </Disclosure>

        {simplifiedNotice !== undefined ? <NoticeBox variant="warning" testID="pid-simplified-unavailable"><Text style={styles.warningText}>{simplifiedNotice}</Text></NoticeBox> : null}

        {draftSimplified !== undefined && simplifiedMode !== undefined ? <>
          {simplifiedMode.known ? <>
            <ChoiceChips
              options={[{key: 'OFF', label: 'موقوف'}, {key: 'RP', label: 'Roll + Pitch'}, {key: 'RPY', label: 'Roll + Pitch + Yaw'}]}
              selectedKey={draftSimplified.pids.mode.kind === 'OFF' ? 'OFF' : draftSimplified.pids.mode.kind === 'RP' ? 'RP' : 'RPY'}
              onSelect={key => patchPids({modeRaw: key === 'OFF' ? 0 : key === 'RP' ? 1 : 2})}
              disabled={busy}
              accessibilityLabel="المحاور التي يولّدها الضبط المبسّط"
              testID="pid-simplified-mode"
            />
            {draftSimplified.pids.mode.kind === 'OFF' && observedSimplified?.pids.mode.kind !== 'OFF'
              ? <NoticeBox variant="warning" testID="pid-simplified-off-consequence"><Text style={styles.warningText}>{SIMPLIFIED_OFF_CONSEQUENCE}</Text></NoticeBox>
              : null}
            {simplifiedGenerating ? <>
              {SIMPLIFIED_PRIMARY_SLIDERS.map(sliderRow)}
              <Disclosure label="مؤثرات إضافية" open={moreSlidersOpen} onToggle={() => setMoreSlidersOpen(value => !value)} testID="pid-simplified-more">
                {SIMPLIFIED_MORE_SLIDERS.map(sliderRow)}
              </Disclosure>
            </> : null}
          </> : <NoticeBox variant="warning" title={simplifiedMode.label} testID="pid-simplified-unknown-mode">
            <Text style={styles.warningText}>لا نعرف ما الذي يولّده هذا الوضع، فلن نعرضه كـ«موقوف» ولن نعدّله. استخدم الإعدادات المتقدمة أدناه.</Text>
          </NoticeBox>}

          {simplifiedMode.known ? <View style={[styles.filterGrid, wide && styles.filterGridWide]}>
            <SimplifiedFilterCard copy={SIMPLIFIED_GYRO_FILTER} block={draftSimplified.gyro} observed={observedSimplified?.gyro.effectiveHz ?? draftSimplified.gyro.effectiveHz} disabled={busy} onToggle={next => patchBlock('gyro', {enabled: next})} onMultiplier={next => patchBlock('gyro', {multiplier: next})} testID="pid-simplified-gyro" />
            <SimplifiedFilterCard copy={SIMPLIFIED_DTERM_FILTER} block={draftSimplified.dterm} observed={observedSimplified?.dterm.effectiveHz ?? draftSimplified.dterm.effectiveHz} disabled={busy} onToggle={next => patchBlock('dterm', {enabled: next})} onMultiplier={next => patchBlock('dterm', {multiplier: next})} testID="pid-simplified-dterm" />
          </View> : null}

          {overwrite !== undefined ? <View style={styles.overwrite} testID="pid-simplified-overwrite">
            <Text style={styles.overwriteTitle}>{overwrite.categories.length === 0 ? 'سيغيّر الحفظ إعدادات الضبط المبسّط فقط.' : `سيعيد الحفظ حساب: ${overwrite.categories.join(' · ')}`}</Text>
            {overwrite.fields.length === 0 ? null : <Disclosure label={`القيم التي ستُستبدل (${overwrite.fields.length})`} open={overwriteDetailOpen} onToggle={() => setOverwriteDetailOpen(value => !value)} testID="pid-simplified-overwrite-detail">
              <Text style={styles.overwriteFields}>{overwrite.fields.join(' · ')}</Text>
            </Disclosure>}
          </View> : null}
        </> : null}
      </View>

      {/* 4. RATES. The formula selector is a DRAFT: selecting it writes
          nothing until the save bar is used, and the notice says plainly
          that the stored numbers are not converted. */}
      <View style={styles.section} testID="pid-rates">
        <Text style={styles.sectionTitle}>سرعة الدوران (Rates)</Text>
        <Text style={styles.sectionHint}>تحدّد كم درجة في الثانية تدور الطائرة عند دفع العصا بالكامل، وكيف تتوزع الاستجابة بين المركز والطرف.</Text>
        <ChoiceChips
          options={[{key: '0', label: ratesTypeName(classifyRatesType(0))}, {key: '1', label: ratesTypeName(classifyRatesType(1))}, {key: '2', label: ratesTypeName(classifyRatesType(2))}, {key: '3', label: ratesTypeName(classifyRatesType(3))}, {key: '4', label: ratesTypeName(classifyRatesType(4))}]}
          selectedKey={effectiveRatesTypeRaw === undefined || effectiveRatesTypeRaw > 4 ? null : String(effectiveRatesTypeRaw)}
          onSelect={key => { setPendingRatesType(Number.parseInt(key, 10)); retireStatus(); }}
          disabled={busy || controller.setRatesType === undefined}
          accessibilityLabel="خوارزمية Rates"
          testID="pid-rates-type"
        />
        {effectiveRatesType?.kind === 'UNKNOWN' ? <NoticeBox variant="warning" testID="pid-rates-type-unknown"><Text style={styles.warningText}>{`المتحكم يستخدم خوارزمية Rates لا نعرفها (${effectiveRatesType.raw}). لن نعدّل قيم Rates بمعادلة لا نملكها.`}</Text></NoticeBox> : null}
        {ratesTypeDirty ? <NoticeBox variant="warning" testID="pid-rates-type-pending">
          <Text style={styles.warningText}>سيُكتب هذا التغيير عند الحفظ. الأرقام المخزّنة لا تُحوَّل: تبقى كما هي وتُفسَّر بالمعادلة الجديدة، فراجع القيم والمعاينة قبل الطيران.</Text>
        </NoticeBox> : null}
        {pendingRangeIssue ? <NoticeBox variant="danger" testID="pid-rates-range-issue">
          <Text style={styles.dangerText}>إحدى القيم الحالية خارج حدود الخوارزمية المختارة. صحّحها أولًا؛ لن نغيّرها نيابةً عنك.</Text>
        </NoticeBox> : null}

        {ratePresentation !== undefined ? <View style={[styles.axisGrid, wide && styles.axisGridWide]}>{AXES.map(axis => <RateAxisCard key={axis.key} axisKey={axis.key} title={axis.title} value={draft.rates[axis.key]} presentation={ratePresentation} disabled={busy} update={updateRate} />)}</View> : null}

        {/* THE CURVE COMES AFTER THE FIELDS IT DESCRIBES.
            Measured, not assumed: with the preview above them, the first
            editable rate field on a 390px phone started 630px below the
            section heading - and 842px once a formula-change notice was up,
            within two pixels of the whole viewport. The visual has a height
            budget precisely so it never costs the controls their place, and
            putting it first spent that budget anyway. */}
        {effectiveRatesType !== undefined ? <RateResponsePreview
          type={effectiveRatesType}
          axes={{roll: axisSettings(draft.rates.roll), pitch: axisSettings(draft.rates.pitch), yaw: axisSettings(draft.rates.yaw)}}
          baseline={snapshot === undefined ? undefined : (() => { const stored = createPidTuningDraft(snapshot).rates; return {roll: axisSettings(stored.roll), pitch: axisSettings(stored.pitch), yaw: axisSettings(stored.yaw)}; })()}
          selectedAxis={previewAxis}
          onSelectAxis={setPreviewAxis}
        /> : null}
      </View>

      {issues.length > 0 ? <NoticeBox variant="danger" title="راجع القيم قبل الحفظ" testID="pid-issues"><Text style={styles.dangerText}>{issues.map(issueMessage).join(' · ')}</Text></NoticeBox> : null}
      {/* A terminal failure freezes every control until the values are read
          again - so the way OUT of that state has to be on the page. Without
          it the pilot is left with a disabled screen and no next step. */}
      {status !== undefined ? <NoticeBox variant={status.warning ? 'warning' : 'success'} testID="pid-status">
        <Text style={status.warning ? styles.warningText : styles.successText}>{status.text}</Text>
        {phase === 'ERROR' ? <Button label="إعادة القراءة" onPress={reload} variant="secondary" icon="refresh-cw" style={styles.inlineAction} testID="pid-status-reload" /> : null}
      </NoticeBox> : null}

      {/* 6. EVERYTHING ELSE. Nothing here was removed when the page was
          reorganised; it simply stopped being the first thing a beginner
          meets. */}
      <Disclosure label="الإعدادات المتقدمة" open={advancedOpen} onToggle={() => setAdvancedChoice(!advancedOpen)} tone="card" testID="pid-advanced">
        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>المعاملات الأساسية</Text><Text style={styles.sectionHint}>P للتصحيح الحالي، I للخطأ المتراكم، D لتخميد التغير، وF لتتبع الأمر. الحدود من البرنامج الثابت 2025.12.2.</Text></View>
        {simplifiedGenerating ? <NoticeBox variant="info" testID="pid-generator-owns"><Text style={styles.bodyText}>الضبط المبسّط نشط ويولّد بعض هذه القيم؛ الحقول التي يملكها معطّلة هنا لأن تعديلها سيُلغى عند الحفظ.</Text></NoticeBox> : null}
        <View style={[styles.axisGrid, wide && styles.axisGridWide]}>{AXES.map(axis => <AxisCard key={axis.key} axisKey={axis.key} title={axis.title} subtitle={axis.subtitle} value={draft[axis.key]} disabled={busy} ownedFields={ownedDirectFields} update={update} />)}</View>

        {/* THE FEEL CARD. These three bytes are what the official presets
            change to turn one aircraft into a cinematic rig and another into
            a race quad - not the P/I/D gains above. Grouped and labelled by
            EFFECT, because "feedforward jitter factor" means nothing to a
            pilot deciding how smooth they want the sticks to feel. */}
        <View style={styles.card} testID="pid-feel"><Text style={styles.sectionTitle}>إحساس العصا</Text><Text style={styles.sectionHint}>تتحكم في نعومة الاستجابة لا في قوتها. ارفع التنعيم للتصوير، واخفضه للسباق.</Text><View style={styles.fieldsRow}><NumericField label="تجاهل ارتجاف العصا" value={draft.feedforwardJitterFactor} max={FEEDFORWARD_JITTER_FACTOR_MAX} disabled={busy} onChange={next => updateFeel('feedforwardJitterFactor', next)} testID="pid-ff-jitter" /><NumericField label="دفعة الاستجابة" value={draft.feedforwardBoost} max={FEEDFORWARD_BOOST_MAX} disabled={busy} onChange={next => updateFeel('feedforwardBoost', next)} testID="pid-ff-boost" /></View><View style={styles.choiceRow}>{[{value: 0, label: 'بلا تنعيم'}, {value: 1, label: 'نقطتان'}, {value: 2, label: '3 نقاط'}, {value: 3, label: '4 نقاط'}].map(option => <Pressable key={option.value} disabled={busy} onPress={() => updateFeel('feedforwardAveraging', option.value)} style={[styles.choice, draft.feedforwardAveraging === option.value && styles.choiceSelected]} testID={`pid-ff-averaging-${option.value}`} accessibilityState={{selected: draft.feedforwardAveraging === option.value}}><Text style={[styles.choiceText, draft.feedforwardAveraging === option.value && styles.choiceTextSelected]}>{option.label}</Text></Pressable>)}</View></View>

        <View style={styles.card} testID="pid-throttle-rates"><Text style={styles.sectionTitle}>منحنى وحدّ الخانق</Text><Text style={styles.sectionHint}>القيم نسب مئوية كما يخزّنها متحكم الطيران. تغيير حد الخانق قد يقلل الدفع الأقصى.</Text><View style={styles.fieldsRow}><NumericField label="Throttle mid %" value={draft.rates.throttleMid} max={100} disabled={busy} onChange={next => updateThrottle('throttleMid', next)} testID="pid-throttle-mid" /><NumericField label="Throttle expo %" value={draft.rates.throttleExpo} max={100} disabled={busy} onChange={next => updateThrottle('throttleExpo', next)} testID="pid-throttle-expo" /><NumericField label="Hover %" value={draft.rates.throttleHover} max={100} disabled={busy} onChange={next => updateThrottle('throttleHover', next)} testID="pid-throttle-hover" /><NumericField label="Limit %" value={draft.rates.throttleLimitPercent} min={25} max={100} disabled={busy} onChange={next => updateThrottle('throttleLimitPercent', next)} testID="pid-throttle-limit-percent" /></View><View style={styles.choiceRow}>{[{value: 0, label: 'إيقاف'}, {value: 1, label: 'Scale'}, {value: 2, label: 'Clip'}].map(option => <Pressable key={option.value} disabled={busy} onPress={() => updateThrottle('throttleLimitType', option.value)} style={[styles.choice, draft.rates.throttleLimitType === option.value && styles.choiceSelected]} testID={`pid-throttle-limit-${option.value}`}><Text style={[styles.choiceText, draft.rates.throttleLimitType === option.value && styles.choiceTextSelected]}>{option.label}</Text></Pressable>)}</View></View>

        {/* DYNAMIC IDLE lives on this page because the value rides in
            MSP_PID_ADVANCED, whose sole writer in this app is this screen's
            transaction. Editing it anywhere else would mean two writers for
            one payload and a way to clobber tuning. */}
        <View style={styles.card} testID="pid-dynamic-idle"><Text style={styles.sectionTitle}>Dynamic Idle</Text><Text style={styles.sectionHint}>أدنى دوران يحافظ عليه المتحكم بوحدة 100 دورة/دقيقة. يتطلب تفعيل Bidirectional DShot من شاشة المحركات؛ بدون قياس RPM لا يملك المتحكم قراءة يحافظ عليها. القيمة 0 تعني تعطيل الميزة.</Text><View style={styles.fieldsRow}><NumericField label="Dynamic Idle (×100 rpm)" value={draft.idleMinRpm} min={0} max={200} disabled={busy} onChange={next => setDraft(current => current === undefined ? current : {...current, idleMinRpm: next})} testID="pid-idle-min-rpm" /></View></View>

        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Filters</Text><Text style={styles.sectionHint}>تُعدّل فقط أوضاع الفلاتر النشطة التي أثبتتها القراءة. لا يفعّل التطبيق ميزة غير مثبتة في بناء الـFC ولا يغيّر نوع الفلتر.</Text></View>
        {!filtersEditable ? <View style={styles.warning}><Text style={styles.warningText}>تعذرت معرفة Gyro/PID loop rate؛ الفلاتر معروضة للقراءة فقط ولن يُسمح بكتابتها دون حد Nyquist موثوق.</Text></View> : <View style={styles.rateEvidence}><Text style={styles.readout}>Gyro Nyquist: {gyroNyquist} Hz</Text><Text style={styles.readout}>D-term Nyquist: {pidNyquist} Hz</Text></View>}
        <View style={[styles.readOnlyGrid, wide && styles.readOnlyGridWide]}>
          <View style={[styles.card, wide && styles.cardInRow]} testID="pid-gyro-filter"><Text style={styles.sectionTitle}>Gyro LPF1</Text>{snapshot?.filterConfig.gyroLpf1DynamicMinHz !== undefined && snapshot.filterConfig.gyroLpf1DynamicMinHz > 0 ? <><Text style={styles.sectionHint}>الوضع الديناميكي مثبت من القراءة؛ Min يجب أن يبقى أصغر من Max وحد Nyquist.</Text><View style={styles.fieldsRow}><NumericField label="Dynamic min Hz" value={draft.filters.gyroLpf1DynamicMinHz} min={1} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('gyroLpf1DynamicMinHz', next)} testID="pid-gyro-dynamic-min" /><NumericField label="Dynamic max Hz" value={draft.filters.gyroLpf1DynamicMaxHz} min={1} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('gyroLpf1DynamicMaxHz', next)} testID="pid-gyro-dynamic-max" /></View></> : <><Text style={styles.sectionHint}>الوضع الثابت مثبت من القراءة؛ 0 يعطّل LPF1.</Text><NumericField label="Static cutoff Hz" value={draft.filters.gyroLpf1StaticHz} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('gyroLpf1StaticHz', next)} testID="pid-gyro-static" /></>}</View>
          <View style={[styles.card, wide && styles.cardInRow]} testID="pid-dterm-filter"><Text style={styles.sectionTitle}>D-term LPF1</Text>{snapshot?.filterConfig.dtermLpf1DynamicMinHz !== undefined && snapshot.filterConfig.dtermLpf1DynamicMinHz > 0 ? <><Text style={styles.sectionHint}>الوضع الديناميكي مثبت من القراءة؛ يحكمه PID loop Nyquist.</Text><View style={styles.fieldsRow}><NumericField label="Dynamic min Hz" value={draft.filters.dtermLpf1DynamicMinHz} min={1} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('dtermLpf1DynamicMinHz', next)} testID="pid-dterm-dynamic-min" /><NumericField label="Dynamic max Hz" value={draft.filters.dtermLpf1DynamicMaxHz} min={1} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('dtermLpf1DynamicMaxHz', next)} testID="pid-dterm-dynamic-max" /></View></> : <><Text style={styles.sectionHint}>الوضع الثابت مثبت من القراءة؛ 0 يعطّل LPF1.</Text><NumericField label="Static cutoff Hz" value={draft.filters.dtermLpf1StaticHz} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('dtermLpf1StaticHz', next)} testID="pid-dterm-static" /></>}</View>
        </View>
        <View style={styles.card} testID="pid-dynamic-notch"><Text style={styles.sectionTitle}>Dynamic Notch</Text>{snapshot?.filterConfig.dynamicNotchCount !== undefined && snapshot.filterConfig.dynamicNotchCount > 0 ? <><Text style={styles.sectionHint}>الميزة نشطة ومثبتة من القراءة. لا تسمح هذه المرحلة بتعطيلها أو تفعيلها على بناء لم يثبت دعمه.</Text><View style={styles.fieldsRow}><NumericField label="عدد الفلاتر" value={draft.filters.dynamicNotchCount} min={1} max={7} disabled={busy || !filtersEditable} onChange={next => updateFilter('dynamicNotchCount', next)} testID="pid-notch-count" /><NumericField label="Q ×100" value={draft.filters.dynamicNotchQ} min={1} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('dynamicNotchQ', next)} testID="pid-notch-q" /><NumericField label="Min Hz" value={draft.filters.dynamicNotchMinHz} min={20} max={250} disabled={busy || !filtersEditable} onChange={next => updateFilter('dynamicNotchMinHz', next)} testID="pid-notch-min" /><NumericField label="Max Hz" value={draft.filters.dynamicNotchMaxHz} min={200} max={1000} disabled={busy || !filtersEditable} onChange={next => updateFilter('dynamicNotchMaxHz', next)} testID="pid-notch-max" /></View></> : <Text style={styles.sectionHint}>القراءة الحالية لا تثبت أن Dynamic Notch نشط؛ لذلك لن نخمن دعم البناء أو نرسِل قيم تفعيل.</Text>}</View>

        {/* THE EXPERT TIER. Grouped and folded rather than poured onto the
            page: opening «الإعدادات المتقدمة» must not drop forty controls
            into a phone screen (§29). Two balanced columns once the
            viewport can carry them (§27). */}
        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>إعدادات الخبراء</Text><Text style={styles.sectionHint}>مجموعات مطويّة، كل واحدة تذكر نطاقها: ما يخصّ هذا الملف وما هو مشترك بين كل الملفات.</Text></View>
        <AdvancedTuningGroups
          advanced={draft.advanced}
          filters={draft.advancedFilters}
          disabled={busy}
          wide={wide}
          ownedFields={ownedDirectFields}
          onChangeAdvanced={updateAdvanced}
          onChangeFilter={updateAdvancedFilter}
        />

        {/* THE RPM FILTER. The one card whose SHAPE depends on the board's
            protocol version - and it is told that shape by the draft, which
            got it from the contract the identification proved. This screen
            does not decide it, does not measure a payload, and does not
            read capability into a zero. */}
        <RpmFilterCard
          rpm={draft.rpmFilter}
          disabled={busy}
          wide={wide}
          onChange={updateRpmFilter}
        />

        {/* WHOLE-PROFILE OPERATIONS, last: they are the ones that lose work. */}
        <ProfileManagementCard
          profileCount={snapshot?.pidProfileCount}
          activeIndex={snapshot?.pidProfileIndex}
          currentName={profileNames.pid}
          busy={busy}
          canRename={controller.setProfileName !== undefined && profileNames.pid !== undefined}
          canCopy={controller.copyProfile !== undefined}
          canReset={controller.resetPidProfile !== undefined}
          onRename={name => { renameProfile(name).catch(() => undefined); }}
          onCopy={(from, to) => { copyProfile(from, to).catch(() => undefined); }}
          onReset={() => { resetProfile().catch(() => undefined); }}
        />
      </Disclosure>
    </> : phase === 'LOADING' ? <Text style={styles.loading}>جارٍ قراءة الضبط من متحكم الطيران…</Text> : null}<View style={styles.bottomSpace} />
  </ScrollView>
  {/* 5. COMMIT. The bar names the scopes that changed, so a pilot who edited
      one thing is not told "الإعدادات تغيّرت" and left to guess which. */}
  <StickyActionBar visible={dirty} summary={dirtyScopes.length === 0 ? 'تغيّرت إعدادات الضبط' : `تغيّر: ${dirtyScopes.join(' · ')}`} details={['تُكتب المجموعات المتغيرة فقط، بالترتيب: خوارزمية Rates ثم القيم ثم الضبط المبسّط، وتُقرأ كل خطوة للتحقق']} saveLabel="حفظ والتحقق" discardLabel="تجاهل" onSave={save} onDiscard={discard} disabledReason={saveBlockedBySession ? blockMessage('SESSION_CHANGED') : blocked ? 'صحح القيم أو حدود Nyquist أولًا.' : undefined} statusMessage={status?.text} statusTone={status?.warning ? 'warning' : 'normal'} busy={phase === 'SAVING'} busyLabel="جارٍ حفظ إعدادات الضبط…" testID="pid-save-bar" /></View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {width: '100%', alignSelf: 'center', padding: spacing.lg, gap: spacing.md},
  hero: {gap: 4},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  profileBadges: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  profileBadge: {flexGrow: 1, flexBasis: 240, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, borderRadius: radii.lg, padding: spacing.md, gap: 4},
  profileLabel: {...typography.label, color: colors.accentText, textAlign: 'right'},
  profileName: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  profileHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE},
  profileValue: {...typography.heading, color: colors.accentStrong, textAlign: 'right'},
  profileChoice: {minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.backgroundRaised, paddingHorizontal: spacing.sm},
  section: {gap: spacing.sm},
  sectionHeading: {gap: 3},
  sectionTitle: {...typography.heading, color: colors.textPrimary, textAlign: 'right'},
  sectionHint: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  bodyText: {...typography.body, color: colors.textSecondary, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  hardwareNotice: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.accentStrong, backgroundColor: colors.accentSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2},
  hardwareTitle: {...typography.eyebrow, color: colors.accentStrong, textAlign: 'right'},
  hardwareText: {...typography.caption, color: colors.accentText, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  dangerText: {...typography.body, color: colors.error, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  disclosureCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, paddingHorizontal: spacing.md},
  disclosureHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 44},
  disclosureLabel: {...typography.label, color: colors.accentStrong, textAlign: 'right', flexShrink: 1},
  disclosureBody: {gap: spacing.md, paddingBottom: spacing.md},
  sliderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap', borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md},
  sliderCopy: {flexGrow: 1, flexBasis: 200, gap: 2},
  filterGrid: {gap: spacing.sm},
  filterGridWide: {flexDirection: 'row'},
  filterCard: {flex: 1, gap: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md},
  filterHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md},
  filterCopy: {flexShrink: 1, gap: 2},
  effectiveRange: {...typography.label, color: colors.accentStrong, textAlign: 'right', fontVariant: ['tabular-nums']},
  overwrite: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2},
  overwriteTitle: {...typography.label, color: colors.warning, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  overwriteFields: {...typography.caption, color: colors.warning, textAlign: 'right', writingDirection: 'ltr'},
  axisGrid: {gap: spacing.md},
  axisGridWide: {flexDirection: 'row'},
  axisCard: {flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md},
  axisTitle: {...typography.title, color: colors.accentStrong, textAlign: 'right'},
  axisSubtitle: {...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE},
  fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  numericField: {flexGrow: 1, flexBasis: 156, minWidth: 156, gap: 5},
  fieldLabel: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  fieldNote: {...typography.caption, color: colors.textMuted, textAlign: 'right', writingDirection: 'rtl'},
  /* A range is left-to-right by nature. It is ONE string node here for the
     same reason: as three nodes inside a right-to-left box the parts laid
     out right to left and "0 - 200" painted as "200 - 0". */
  rangeHint: {...typography.caption, color: colors.textMuted, textAlign: 'center', writingDirection: 'ltr'},
  readOnlyGrid: {gap: spacing.md},
  readOnlyGridWide: {flexDirection: 'row'},
  /*
   * NO `flex: 1` HERE - that was a measured defect, not a style opinion.
   *
   * `flex: 1` means `flex-basis: 0`, so every card using it grew to the
   * SAME height regardless of what it held: at 1366 the feel, throttle,
   * Dynamic Idle, Dynamic Notch and RPM cards all measured exactly 211px
   * for between 93px and 211px of content. The short ones were carrying
   * up to 118px of dead space each. A card in a COLUMN sizes to its
   * content; `cardInRow` restores the growth only where cards genuinely
   * share a row and must match.
   */
  card: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm},
  cardInRow: {flex: 1},
  readout: {...typography.body, color: colors.textSecondary, textAlign: 'right', fontVariant: ['tabular-nums'], maxWidth: PROSE_MEASURE},
  choiceRow: {flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap'},
  choice: {minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.backgroundRaised, paddingHorizontal: spacing.md},
  choiceSelected: {borderColor: colors.accentStrong, backgroundColor: colors.accentSoft},
  choiceText: {...typography.label, color: colors.textSecondary},
  choiceTextSelected: {color: colors.accentStrong},
  rateEvidence: {flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, flexWrap: 'wrap', borderRadius: radii.md, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft, padding: spacing.sm},
  warning: {borderRadius: radii.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm},
  warningText: {...typography.body, color: colors.warning, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  successText: {...typography.body, color: colors.success, textAlign: 'right', maxWidth: PROSE_MEASURE},
  inlineAction: {alignSelf: 'flex-start'},
  loading: {...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl},
  /* No extra room is reserved for the save bar, and that is deliberate:
     `StickyActionBar` is a flex SIBLING of the ScrollView inside a
     `flex: 1` root, not an overlay, so raising it shrinks the scroll
     viewport instead of covering it. The geometry sweep confirms the last
     control clears the bar at maximum scroll at all five widths. */
  bottomSpace: {height: spacing.xl},
});
