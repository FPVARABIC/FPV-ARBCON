/**
 * THE EXPERT TIER, IN A PILOT'S WORDS.
 *
 * =====================================================================
 * WHAT THIS FILE IS FOR
 * =====================================================================
 *
 * P-E adds around forty fields to the PID screen. Every one of them has a
 * name in the firmware - `d_max_gain`, `feedforward_smooth_factor`,
 * `iterm_relax_cutoff` - and a screen that prints those names is not an
 * Arabic application, it is a CLI with a font. This module owns the
 * translation, and the screen owns none of it.
 *
 * THE RULE IT FOLLOWS (P-E §30, §31):
 *
 *  - Terms an FPV pilot already uses stay as they are: PID, D Max,
 *    Feedforward, TPA, RPM, Gyro, D-term, Notch, Hz. Translating "D Max"
 *    into Arabic would not help anybody; it would just make the value
 *    unrecognisable next to every tuning guide ever written.
 *  - Everything AROUND those terms is Arabic, and says what the field
 *    DOES, not what it is called.
 *  - The raw wire name is carried, but only for «التفاصيل التقنية». It is
 *    never the primary label.
 *
 * =====================================================================
 * WHAT IT IS NOT
 * =====================================================================
 *
 * It holds no bounds, no defaults, no arithmetic and no capability rules.
 * Bounds live beside the fields they belong to, in `advancedPidFields` and
 * `advancedFilterFields`, each with the firmware line it was read from. A
 * second copy of a range here would be a second opinion about the
 * firmware, and the test beside this file checks that every field with a
 * bound has copy and every field with copy has a bound - so neither table
 * can quietly grow a field the other does not know about.
 */

import {
  ADVANCED_PID_FIELD_KEYS,
  type AdvancedPidFieldKey,
} from '../../core/state/advancedPidFields';
import {
  ADVANCED_FILTER_FIELD_KEYS,
  type AdvancedFilterFieldKey,
} from '../../core/state/advancedFilterFields';

export type AdvancedFieldKey = AdvancedPidFieldKey | AdvancedFilterFieldKey;

export interface AdvancedChoice {
  readonly value: number;
  readonly label: string;
}

export interface AdvancedFieldCopy {
  /** The primary label. Familiar terms kept; wire names never. */
  readonly label: string;
  /** One line under the control, in the operator's terms. */
  readonly hint: string;
  /** For «التفاصيل التقنية» - the mechanism, not the marketing. */
  readonly detail: string;
  /** Raw wire name. TECHNICAL DETAILS ONLY. */
  readonly wireName: string;
  /** Present exactly where the firmware row is a lookup table. */
  readonly choices?: readonly AdvancedChoice[];
}

/* ------------------------------------------------------------------ */
/* Shared choice tables                                                */
/* ------------------------------------------------------------------ */

/** settings.c lookupTableOffOn. */
const OFF_ON: readonly AdvancedChoice[] = Object.freeze([
  {value: 0, label: 'إيقاف'},
  {value: 1, label: 'تشغيل'},
]);

/**
 * settings.c lookupTableLowpassType / lookupTableDtermLowpassType.
 * FOUR entries. The names are the filter kinds themselves and are left
 * exactly as the firmware and every tuning guide write them.
 */
const LOWPASS_TYPES: readonly AdvancedChoice[] = Object.freeze([
  {value: 0, label: 'PT1'},
  {value: 1, label: 'BIQUAD'},
  {value: 2, label: 'PT2'},
  {value: 3, label: 'PT3'},
]);

/* ------------------------------------------------------------------ */
/* The copy table                                                      */
/* ------------------------------------------------------------------ */

const COPY: Readonly<Record<AdvancedFieldKey, AdvancedFieldCopy>> = Object.freeze({
  /* ---- D Max ------------------------------------------------------- */
  dMaxRoll: {
    label: 'D Max — Roll',
    hint: 'أعلى قيمة D يسمح المتحكم ببلوغها عند الحركة السريعة.',
    detail:
      'D Max ليس قيمة D ثانية. D العادية تعمل دائمًا؛ D Max هو السقف الذي '
      + 'يرفع المتحكم إليه التخميد مؤقتًا عند الحركات الحادة ثم يعود. القيمة 0 '
      + 'تعطّل الرفع وتُبقي D ثابتة.',
    wireName: 'd_max_roll',
  },
  dMaxPitch: {
    label: 'D Max — Pitch',
    hint: 'أعلى قيمة D يسمح المتحكم ببلوغها عند الحركة السريعة.',
    detail: 'كما في Roll، لمحور Pitch. القيمة 0 تُبقي D ثابتة على هذا المحور.',
    wireName: 'd_max_pitch',
  },
  dMaxYaw: {
    label: 'D Max — Yaw',
    hint: 'أعلى قيمة D يسمح المتحكم ببلوغها عند الحركة السريعة.',
    detail: 'كما في Roll، لمحور Yaw. القيمة 0 تُبقي D ثابتة على هذا المحور.',
    wireName: 'd_max_yaw',
  },
  dMaxGain: {
    label: 'حساسية رفع D Max',
    hint: 'كم يستجيب الرفع لسرعة تغيّر أمر العصا.',
    detail:
      'يحدد مقدار الرفع نحو D Max لكل وحدة من معدّل التغيّر. القيمة الأعلى '
      + 'تبلغ السقف أسرع. لا علاقة لهذه القيمة بشريحة D Max في الضبط المبسّط: '
      + 'تلك قيمة مخزّنة أخرى.',
    wireName: 'd_max_gain',
  },
  dMaxAdvance: {
    label: 'استباق D Max',
    hint: 'كم يبدأ الرفع مبكرًا قبل أن تصل الحركة.',
    detail:
      'يقدّم بداية الرفع بالاعتماد على معدّل تغيّر أمر العصا بدلًا من الخطأ '
      + 'المقاس، فيصل التخميد قبل الاهتزاز لا بعده.',
    wireName: 'd_max_advance',
  },

  /* ---- Feedforward ------------------------------------------------- */
  feedforwardTransition: {
    label: 'بدء Feedforward',
    hint: 'من أي انحراف للعصا يبدأ Feedforward بالعمل. 0 يعني من البداية.',
    detail:
      'نسبة من مدى العصا يُلغى فيها Feedforward قرب المنتصف، فيبقى التحويم '
      + 'هادئًا. القيمة 0 تُبقيه فعّالًا على كامل المدى.',
    wireName: 'feedforward_transition',
  },
  feedforwardSmoothFactor: {
    label: 'تنعيم Feedforward',
    hint: 'يقلّل حدّة الدفعة على حساب قليل من التأخير.',
    detail:
      'مرشّح تنعيم على مخرج Feedforward. القيم الأعلى تعطي إحساسًا سينمائيًا '
      + 'وتأخيرًا أكبر؛ الأدنى أحدّ وأسرع.',
    wireName: 'feedforward_smooth_factor',
  },
  feedforwardMaxRateLimit: {
    label: 'حدّ Feedforward عند الطرف',
    hint: 'يمنع تجاوز السرعة القصوى عند دفع العصا إلى آخرها.',
    detail:
      'يقلّص Feedforward كلما اقترب الأمر من أقصى معدّل دوران، فلا يطلب '
      + 'المتحكم سرعة تفوق ما تسمح به Rates. القيمة 0 تعطّل الحد.',
    wireName: 'feedforward_max_rate_limit',
  },

  /* ---- TPA --------------------------------------------------------- */
  tpaMode: {
    label: 'نمط TPA',
    hint: 'أي المعاملات يخفّضها TPA مع ارتفاع الخانق.',
    detail:
      'TPA يخفّض قوة التصحيح عند الخانق العالي حيث تكون الطائرة أكثر قابلية '
      + 'للاهتزاز. النمط يحدد ما يُخفَّض: P وD معًا، أو D وحدها.',
    wireName: 'tpa_mode',
    choices: Object.freeze([
      {value: 0, label: 'P وD'},
      {value: 1, label: 'D فقط'},
    ]),
  },
  tpaRate: {
    label: 'مقدار TPA',
    hint: 'كم يُخفَّض التصحيح عند أقصى خانق.',
    detail:
      'نسبة التخفيض عند بلوغ الخانق الأقصى. القيمة 0 تعطّل TPA. المتحكم يقصّ '
      + 'أي قيمة أعلى من 100 عند الكتابة.',
    wireName: 'tpa_rate',
  },
  tpaBreakpoint: {
    label: 'نقطة بدء TPA',
    hint: 'قيمة الخانق التي يبدأ عندها التخفيض، بوحدة الأمر (1000–2000).',
    detail:
      'تحت هذه النقطة لا يعمل TPA إطلاقًا؛ فوقها يتدرّج التخفيض حتى الخانق '
      + 'الأقصى. الوحدة هي وحدة أمر الاستقبال نفسها، لا نسبة مئوية.',
    wireName: 'tpa_breakpoint',
  },

  /* ---- I-term and anti-gravity ------------------------------------- */
  itermRelax: {
    label: 'تخفيف I-term',
    hint: 'يمنع تراكم I أثناء الحركات السريعة.',
    detail:
      'أثناء حركة سريعة يتراكم I على خطأ سيزول وحده، فترتد الطائرة عند التوقف. '
      + 'التخفيف يوقف التراكم على المحاور المختارة. INC يسمح بالتراكم في اتجاه '
      + 'الحركة فقط.',
    wireName: 'iterm_relax',
    choices: Object.freeze([
      {value: 0, label: 'إيقاف'},
      {value: 1, label: 'Roll وPitch'},
      {value: 2, label: 'كل المحاور'},
      {value: 3, label: 'Roll وPitch — INC'},
      {value: 4, label: 'كل المحاور — INC'},
    ]),
  },
  itermRelaxType: {
    label: 'مرجع تخفيف I-term',
    hint: 'هل يقيس التخفيف حركة العصا أم دوران الطائرة؟',
    detail:
      'SETPOINT يقيس أمر العصا، وهو الخيار المعتاد. GYRO يقيس الدوران الفعلي، '
      + 'وهو أبطأ استجابة وأكثر تحفّظًا.',
    wireName: 'iterm_relax_type',
    choices: Object.freeze([
      {value: 0, label: 'GYRO'},
      {value: 1, label: 'SETPOINT'},
    ]),
  },
  itermRelaxCutoff: {
    label: 'تردد تخفيف I-term',
    hint: 'كم يُعتبر التغيّر «سريعًا»، بالهرتز.',
    detail:
      'تردد قطع المرشّح الذي يقرر أن الحركة سريعة بما يكفي لإيقاف التراكم. '
      + 'القيم الأعلى تجعل التخفيف أقل تدخّلًا.',
    wireName: 'iterm_relax_cutoff',
  },
  itermRotation: {
    label: 'تدوير I-term مع Yaw',
    hint: 'ينقل I المتراكم بين المحاور عند الدوران حول Yaw.',
    detail:
      'عند لفّة Yaw يصبح ما تراكم على Roll مناسبًا لـPitch والعكس. التفعيل '
      + 'يدوّر القيم مع الطائرة بدل تركها على المحور الخطأ.',
    wireName: 'iterm_rotation',
    choices: OFF_ON,
  },
  antiGravityGain: {
    label: 'مقاومة الجاذبية',
    hint: 'يرفع I مؤقتًا عند تغيّر الخانق المفاجئ.',
    detail:
      'دفع الخانق يميل بالطائرة قبل أن يلحق I. القيمة ترفع I مؤقتًا بمقدار '
      + 'يتناسب مع سرعة تغيّر الخانق. القيمة 0 تعطّل الميزة.',
    wireName: 'anti_gravity_gain',
  },

  /* ---- Limits and assistance --------------------------------------- */
  angleLimit: {
    label: 'أقصى ميل في وضع Angle',
    hint: 'بالدرجات. يحدّ ميل الطائرة في الأوضاع المستوية فقط.',
    detail:
      'لا أثر له في وضع Acro. يحدّ زاوية الميل التي يصل إليها وضع Angle عند '
      + 'دفع العصا إلى آخرها.',
    wireName: 'angle_limit',
  },
  acroTrainerAngleLimit: {
    label: 'حدّ Acro Trainer',
    hint: 'بالدرجات. أقصى ميل يسمح به وضع التدريب.',
    detail:
      'يعمل فقط حين يكون وضع Acro Trainer مفعّلًا من شاشة الأوضاع. خارج ذلك '
      + 'الوضع لا أثر لهذه القيمة.',
    wireName: 'acro_trainer_angle_limit',
  },
  rateAccelLimit: {
    label: 'حدّ تسارع Roll/Pitch',
    hint: 'أقصى معدّل تغيّر للأمر، بوحدة درجة/ثانية لكل ثانية. 0 يعني بلا حد.',
    detail:
      'يمنع قفزة مفاجئة في الأمر من إجهاد المحركات. القيمة 0 هي الافتراضي '
      + 'وتعني أن المتحكم لا يفرض حدًا.',
    wireName: 'acc_limit',
  },
  yawRateAccelLimit: {
    label: 'حدّ تسارع Yaw',
    hint: 'كسابقه، لمحور Yaw وحده. 0 يعني بلا حد.',
    detail:
      'Yaw أبطأ ميكانيكيًا من المحورين الآخرين، ولذلك له حدّه المستقل.',
    wireName: 'acc_limit_yaw',
  },
  motorOutputLimit: {
    label: 'حدّ خرج المحركات',
    hint: 'نسبة مئوية من أقصى خرج. 100 تعني بلا تقييد.',
    detail:
      'يقصّ أعلى ما يصل إلى المحركات. يستخدَم لخفض القدرة عمدًا. القيمة الدنيا '
      + 'التي يقبلها المتحكم هي 1.',
    wireName: 'motor_output_limit',
  },

  /* ---- Battery and thrust ------------------------------------------ */
  throttleBoost: {
    label: 'دفعة الخانق',
    hint: 'يحدّ استجابة الخانق للتغيّر السريع. 0 يعطّلها.',
    detail:
      'مرشّح يبرز التغيّرات السريعة في الخانق، فتبدو الاستجابة أسرع دون رفع '
      + 'الخانق نفسه.',
    wireName: 'throttle_boost',
  },
  thrustLinearization: {
    label: 'تخطيط الدفع',
    hint: 'يعوّض عدم خطية الدفع عند الخانق المنخفض. 0 يعطّلها.',
    detail:
      'دفع المروحة لا يتناسب خطيًا مع أمر المحرك؛ التعويض يعيد توزيع الأمر '
      + 'ليصبح إحساس التصحيح متشابهًا عبر مدى الخانق.',
    wireName: 'thrust_linear',
  },
  vbatSagCompensation: {
    label: 'تعويض هبوط الجهد',
    hint: 'يحافظ على ثبات الإحساس مع تفريغ البطارية. 0 يعطّله.',
    detail:
      'يرفع الخرج تدريجيًا كلما هبط جهد البطارية تحت الحمل، فلا تضعف الاستجابة '
      + 'في آخر الرحلة. يحتاج قراءة جهد صحيحة.',
    wireName: 'vbat_sag_compensation',
  },
  autoProfileCellCount: {
    label: 'ربط الملف بعدد الخلايا',
    hint: 'يختار المتحكم ملف PID تلقائيًا حسب البطارية المركّبة.',
    detail:
      'القيمة ليست عددًا عاديًا: «تبديل تلقائي» تعني الانتقال دائمًا إلى الملف '
      + 'الذي يطابق عدد الخلايا المكتشف، و«بلا تبديل» تعني تعطيل الميزة، وأي '
      + 'رقم من 1 إلى 8 يعني أن هذا الملف مخصّص لذلك العدد من الخلايا.',
    wireName: 'auto_profile_cell_count',
    choices: Object.freeze([
      {value: -1, label: 'تبديل تلقائي'},
      {value: 0, label: 'بلا تبديل'},
      {value: 1, label: '1S'},
      {value: 2, label: '2S'},
      {value: 3, label: '3S'},
      {value: 4, label: '4S'},
      {value: 5, label: '5S'},
      {value: 6, label: '6S'},
      {value: 7, label: '7S'},
      {value: 8, label: '8S'},
    ]),
  },

  /* ---- Gyro filters (GLOBAL) --------------------------------------- */
  gyroLpf1Type: {
    label: 'نوع Gyro LPF1',
    hint: 'شكل المرشّح: حدّة القطع مقابل التأخير.',
    detail:
      'PT1 أخف تأخيرًا وأقل حدّة؛ BIQUAD أحدّ وأبطأ؛ PT2 وPT3 بينهما بترتيب '
      + 'متزايد الحدّة.',
    wireName: 'gyro_lpf1_type',
    choices: LOWPASS_TYPES,
  },
  gyroLpf2StaticHz: {
    label: 'Gyro LPF2 — التردد',
    hint: 'مرشّح ثانٍ ثابت بعد LPF1. 0 يعطّله.',
    detail:
      'LPF2 مرشّح ثابت لا ديناميكي، يعمل بعد LPF1 لتنظيف ما تبقّى من ضجيج '
      + 'عالي التردد.',
    wireName: 'gyro_lpf2_static_hz',
  },
  gyroLpf2Type: {
    label: 'نوع Gyro LPF2',
    hint: 'شكل المرشّح الثاني.',
    detail: 'الخيارات نفسها المتاحة لـLPF1، وبنفس المقايضة بين الحدّة والتأخير.',
    wireName: 'gyro_lpf2_type',
    choices: LOWPASS_TYPES,
  },
  gyroSoftNotchHz1: {
    label: 'Gyro Notch 1 — المركز',
    hint: 'التردد الذي يُقصّ. 0 يعطّل هذا الـnotch.',
    detail:
      'الـnotch يزيل نطاقًا ضيقًا حول تردد معروف - رنين إطار أو مروحة - دون '
      + 'التأثير على بقية الطيف.',
    wireName: 'gyro_notch1_hz',
  },
  gyroSoftNotchCutoff1: {
    label: 'Gyro Notch 1 — العرض',
    hint: 'كلما اقترب من المركز ضاق النطاق المقصوص.',
    detail:
      'إذا بلغ العرض المركز أو تجاوزه فسيعطّل المتحكم الـnotch كليًا عند '
      + 'الكتابة، وسنعرض ذلك كتصحيح من البرنامج الثابت لا كنجاح صامت.',
    wireName: 'gyro_notch1_cutoff',
  },
  gyroSoftNotchHz2: {
    label: 'Gyro Notch 2 — المركز',
    hint: 'notch ثانٍ مستقل. 0 يعطّله.',
    detail: 'يعمل بنفس قواعد الأول تمامًا، لتردد رنين ثانٍ.',
    wireName: 'gyro_notch2_hz',
  },
  gyroSoftNotchCutoff2: {
    label: 'Gyro Notch 2 — العرض',
    hint: 'كلما اقترب من المركز ضاق النطاق المقصوص.',
    detail: 'وله التصحيح نفسه إن بلغ المركز: يعطّل المتحكم الـnotch عند الكتابة.',
    wireName: 'gyro_notch2_cutoff',
  },

  /* ---- D-term filters (PID PROFILE) -------------------------------- */
  dtermLpf1Type: {
    label: 'نوع D-term LPF1',
    hint: 'شكل مرشّح D الأول.',
    detail:
      'D هو أكثر ما يضخّم الضجيج، ولذلك يميل مرشّحه إلى أن يكون أحدّ من مرشّح '
      + 'الـgyro. المقايضة نفسها: حدّة مقابل تأخير.',
    wireName: 'dterm_lpf1_type',
    choices: LOWPASS_TYPES,
  },
  dtermLpf1DynExpo: {
    label: 'انحناء D-term الديناميكي',
    hint: 'كيف يتوزّع التردد بين الحد الأدنى والأعلى مع الخانق.',
    detail:
      'القيمة 0 توزيع خطي مع الخانق. القيم الأعلى تُبقي التردد منخفضًا لمدى '
      + 'أطول ثم ترفعه بسرعة قرب الخانق العالي.',
    wireName: 'dterm_lpf1_dyn_expo',
  },
  dtermLpf2StaticHz: {
    label: 'D-term LPF2 — التردد',
    hint: 'مرشّح ثانٍ ثابت على D. 0 يعطّله.',
    detail: 'يعمل بعد LPF1 على مسار D وحده، ولا يمسّ إشارة الـgyro الأصلية.',
    wireName: 'dterm_lpf2_static_hz',
  },
  dtermLpf2Type: {
    label: 'نوع D-term LPF2',
    hint: 'شكل مرشّح D الثاني.',
    detail: 'الخيارات نفسها المتاحة لبقية المرشّحات المنخفضة.',
    wireName: 'dterm_lpf2_type',
    choices: LOWPASS_TYPES,
  },
  dtermNotchHz: {
    label: 'D-term Notch — المركز',
    hint: 'قصّ تردد بعينه من مسار D. 0 يعطّله.',
    detail:
      'يفيد حين يظهر رنين في D وحده. لا يمكن ضبط العرض عند المركز أو فوقه: '
      + 'المتحكم يقبل القيمة ثم يُلغيها عند حفظ الإعدادات، فنرفضها قبل الإرسال '
      + 'بدل الادّعاء بأنها حُفظت.',
    wireName: 'dterm_notch_hz',
  },
  dtermNotchCutoff: {
    label: 'D-term Notch — العرض',
    hint: 'يجب أن يبقى أصغر من المركز.',
    detail:
      'لإيقاف الـnotch اجعل المركز 0؛ رفع العرض إلى المركز ليس طريقة إيقاف '
      + 'صالحة على هذا المسار.',
    wireName: 'dterm_notch_cutoff',
  },
  yawLowpassHz: {
    label: 'مرشّح Yaw',
    hint: 'مرشّح منخفض إضافي على مخرج Yaw. 0 يعطّله.',
    detail:
      'Yaw أبطأ ولا يحتاج نطاقًا واسعًا، فمرشّح إضافي عليه يهدّئ المحركات دون '
      + 'أثر محسوس على القيادة.',
    wireName: 'yaw_lowpass_hz',
  },
} as const);

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export type AdvancedGroupKey =
  | 'D_MAX'
  | 'FEEDFORWARD'
  | 'TPA'
  | 'ITERM'
  | 'LIMITS'
  | 'BATTERY'
  | 'GYRO_FILTERS'
  | 'DTERM_FILTERS';

export interface AdvancedGroup {
  readonly key: AdvancedGroupKey;
  readonly title: string;
  readonly hint: string;
  readonly fields: readonly AdvancedFieldKey[];
  /**
   * Which lifetime the group's values belong to.
   *
   * P-E §13: MSP_FILTER_CONFIG carries two scopes in one command, and the
   * screen may show them together but must not SAY they are the same
   * thing. The group carries its scope so the heading can state it.
   */
  readonly scope: 'PID_PROFILE' | 'GLOBAL';
}

/**
 * The order the expert tier is presented in.
 *
 * Grouped by what a pilot is trying to DO, not by which MSP command the
 * bytes travel in: D Max and the feedforward extras ride the same payload
 * as the anti-gravity gain, and nobody tunes "MSP_PID_ADVANCED".
 */
export const ADVANCED_GROUPS: readonly AdvancedGroup[] = Object.freeze([
  Object.freeze({
    key: 'D_MAX',
    title: 'D Max',
    hint: 'سقف مؤقت لقيمة D عند الحركات الحادة. ليس قيمة D ثانية.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'dMaxRoll', 'dMaxPitch', 'dMaxYaw', 'dMaxGain', 'dMaxAdvance',
    ]),
  }),
  Object.freeze({
    key: 'FEEDFORWARD',
    title: 'Feedforward',
    hint: 'استجابة مبنية على أمر العصا مباشرة، قبل أن يقيس المتحكم أي خطأ.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'feedforwardTransition', 'feedforwardSmoothFactor', 'feedforwardMaxRateLimit',
    ]),
  }),
  Object.freeze({
    key: 'TPA',
    title: 'TPA',
    hint: 'خفض التصحيح عند الخانق العالي، حيث تكون الطائرة أكثر عرضة للاهتزاز.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>(['tpaMode', 'tpaRate', 'tpaBreakpoint']),
  }),
  Object.freeze({
    key: 'ITERM',
    title: 'I-term ومقاومة الجاذبية',
    hint: 'كيف يتعامل المتحكم مع الخطأ المتراكم أثناء الحركة وتغيّر الخانق.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'itermRelax', 'itermRelaxType', 'itermRelaxCutoff', 'itermRotation', 'antiGravityGain',
    ]),
  }),
  Object.freeze({
    key: 'LIMITS',
    title: 'الحدود والمساعدات',
    hint: 'سقوف لا تغيّر إحساس الطيران في وضع Acro، لكنها تحدّ ما يُسمح به.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'angleLimit', 'acroTrainerAngleLimit', 'rateAccelLimit', 'yawRateAccelLimit',
      'motorOutputLimit',
    ]),
  }),
  Object.freeze({
    key: 'BATTERY',
    title: 'البطارية والدفع',
    hint: 'تعويضات تحافظ على ثبات الإحساس مع تغيّر الجهد والدفع.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'throttleBoost', 'thrustLinearization', 'vbatSagCompensation', 'autoProfileCellCount',
    ]),
  }),
  Object.freeze({
    key: 'GYRO_FILTERS',
    title: 'مرشّحات Gyro',
    hint: 'مشتركة بين كل ملفات PID: تعديلها هنا يغيّرها في كل الملفات.',
    scope: 'GLOBAL',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'gyroLpf1Type', 'gyroLpf2StaticHz', 'gyroLpf2Type',
      'gyroSoftNotchHz1', 'gyroSoftNotchCutoff1', 'gyroSoftNotchHz2', 'gyroSoftNotchCutoff2',
    ]),
  }),
  Object.freeze({
    key: 'DTERM_FILTERS',
    title: 'مرشّحات D-term',
    hint: 'تخصّ ملف PID الحالي وحده، ولا تتبعها بقية الملفات.',
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'dtermLpf1Type', 'dtermLpf1DynExpo', 'dtermLpf2StaticHz', 'dtermLpf2Type',
      'dtermNotchHz', 'dtermNotchCutoff', 'yawLowpassHz',
    ]),
  }),
]);

export function advancedFieldCopy(field: AdvancedFieldKey): AdvancedFieldCopy {
  return COPY[field];
}

/** Every field the catalogues define, in the order the groups present them. */
export const ADVANCED_PRESENTED_FIELDS: readonly AdvancedFieldKey[] = Object.freeze(
  ADVANCED_GROUPS.flatMap(group => [...group.fields]),
);

/** Every field the two catalogues define. Used by the coverage test. */
export const ADVANCED_CATALOGUE_FIELDS: readonly AdvancedFieldKey[] = Object.freeze([
  ...ADVANCED_PID_FIELD_KEYS,
  ...ADVANCED_FILTER_FIELD_KEYS,
]);

/**
 * The RPM filter, which this phase READS and does not write.
 *
 * Its fields live in a tail that only exists from API 1.48 and its weights
 * are variable-length. Saying so where the values are shown is the honest
 * surface; a disabled control with no explanation is not.
 */
export const RPM_FILTER_COPY = Object.freeze({
  title: 'مرشّح RPM',
  hint: 'يعرض التطبيق القيمتين الموجودتين على كل الإصدارات، ولا يكتب شيئًا هنا.',
  readOnlyReason:
    'بقية حقول مرشّح RPM - الـQ ومدى التلاشي والأوزان - تعيش في ذيل الرسالة '
    + 'الذي لا يظهر إلا من إصدار MSP 1.48، وعدد الأوزان متغيّر. عرضها بالاعتماد '
    + 'على طول الرسالة كان سيكون تخمينًا، وكتابتها كانت ستعني إرسال أصفار على '
    + 'لوحة لا تحمل هذه الحقول أصلًا. فلا نعرضها ولا نكتبها، ونقول ذلك بدل '
    + 'تعطيل حقول دون تفسير.',
});
