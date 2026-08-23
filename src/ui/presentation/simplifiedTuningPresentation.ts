/**
 * SIMPLIFIED TUNING, EXPLAINED WITHOUT LYING ABOUT IT.
 *
 * P-A traced what these sliders actually do and the answer is uncomfortable
 * for a friendly UI: they are not a sensitivity preference and not a
 * preview. `applySimplifiedTuning()` REWRITES the stored PID gains, D Max,
 * feedforward and filter frequencies of the active profile, generating them
 * from COMPILE-TIME DEFAULTS rather than from whatever the pilot had tuned.
 * And `disableSimplifiedTuning()` restores nothing at all - switching the
 * mode off simply stops future regeneration.
 *
 * So this module has one job: say that in Arabic a pilot can act on, without
 * either frightening them with struct names or softening it into something
 * untrue. Every string here is checked by a mutation that puts the
 * comfortable lie back and expects a test to fail.
 *
 * NO GENERATOR MATHEMATICS LIVES HERE. Projected values come from
 * `simplifiedTuningGenerator`, which is the firmware-equivalent
 * reimplementation P-B verified against hand-derived vectors.
 */

import {
  classifySimplifiedPidsMode,
  type MspSimplifiedTuning,
  type SimplifiedPidsMode,
} from '../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import {simplifiedOwnedFields} from '../../core/state/pidWriteVerification';

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

export interface SimplifiedModeCopy {
  readonly label: string;
  /** False for a raw value no pinned tree defines. */
  readonly known: boolean;
}

/**
 * OFF / RP / RPY, and an unknown raw value kept as unknown.
 *
 * An unrecognised mode is NOT folded into OFF. The firmware would treat it
 * as something, and we do not know what - so the screen says so and stops
 * offering edits that depend on knowing.
 */
export function simplifiedModeCopy(mode: SimplifiedPidsMode): SimplifiedModeCopy {
  switch (mode.kind) {
    case 'OFF': return Object.freeze({label: 'موقوف', known: true});
    case 'RP': return Object.freeze({label: 'Roll + Pitch', known: true});
    case 'RPY': return Object.freeze({label: 'Roll + Pitch + Yaw', known: true});
    case 'UNKNOWN': return Object.freeze({label: `وضع غير معروف (${mode.raw})`, known: false});
  }
}

/** The one-line description under the section title. */
export const SIMPLIFIED_SUMMARY =
  'يضبط عدة قيم في ملف الضبط الحالي دفعة واحدة، انطلاقًا من القيم الافتراضية للبرنامج الثابت.';

/**
 * The expandable explanation. Two facts, both proven, both load-bearing.
 *
 * It says REGENERATES and it says the old values do not come back, because
 * a pilot who believes either the opposite will lose a tune they spent a
 * season on.
 */
export const SIMPLIFIED_EXPLANATION =
  'عند الحفظ، يعيد متحكم الطيران حساب قيم PID والفلاتر المرتبطة من القيم الافتراضية المدمجة في برنامجه الثابت، لا من ضبطك الحالي. وإيقاف الضبط المبسّط لاحقًا يمنع إعادة الحساب في المرات القادمة، لكنه لا يعيد قيمك السابقة.';

/**
 * What the user is told when they choose OFF.
 *
 * Deliberately not phrased as "restore" or "return to manual tune" - the
 * firmware does neither.
 */
export const SIMPLIFIED_OFF_CONSEQUENCE =
  'إيقاف الضبط المبسّط يوقف إعادة الحساب في التعديلات القادمة فقط. القيم الحالية تبقى كما ولّدها المتحكم، ولا تعود القيم التي كانت قبل تفعيله.';

/* ------------------------------------------------------------------ */
/* The master multiplier                                               */
/* ------------------------------------------------------------------ */

/**
 * The wire byte is a PERCENTAGE - 100 means "leave the defaults alone".
 *
 * Shown as a multiplier because that is what it does to every generated
 * gain at once, and because `1.13×` reads as a strength where `113` reads
 * as a raw setting. One presentation, used everywhere.
 */
export function formatMultiplier(raw: number): string {
  return `${(raw / 100).toFixed(2)}×`;
}

/* ------------------------------------------------------------------ */
/* Sliders                                                             */
/* ------------------------------------------------------------------ */

export type SimplifiedSliderKey =
  | 'masterMultiplier'
  | 'piGain'
  | 'iGain'
  | 'dGain'
  | 'dMaxGain'
  | 'feedforwardGain'
  | 'rollPitchRatio'
  | 'pitchPiGain';

export interface SimplifiedSliderCopy {
  readonly key: SimplifiedSliderKey;
  readonly label: string;
  readonly help: string;
  /** True for the handful a beginner needs before anything else. */
  readonly primary: boolean;
}

/**
 * Pilot-facing names for the generator inputs.
 *
 * The wire names - `simplified_roll_pitch_ratio`, `simplified_pitch_pi_gain`
 * - never reach the screen. The help text describes what the slider moves,
 * and stops there: promising a flight FEEL that the firmware formulas do not
 * predict would be the same overclaim in friendlier words.
 */
export const SIMPLIFIED_SLIDERS: readonly SimplifiedSliderCopy[] = Object.freeze([
  Object.freeze({
    key: 'masterMultiplier', primary: true,
    label: 'القوة العامة',
    help: 'يرفع أو يخفض قيم PID المولّدة كلها معًا.',
  }),
  Object.freeze({
    key: 'piGain', primary: true,
    label: 'قوة P و I معًا',
    help: 'يحرّك قيمتي P وI في نفس الاتجاه.',
  }),
  Object.freeze({
    key: 'dGain', primary: true,
    label: 'قوة D',
    help: 'يغيّر قيمة D المولّدة على المحاور المشمولة.',
  }),
  Object.freeze({
    key: 'feedforwardGain', primary: true,
    label: 'قوة Feedforward',
    help: 'يغيّر مقدار تتبّع المتحكم لحركة العصا مباشرة.',
  }),
  Object.freeze({
    key: 'iGain', primary: false,
    label: 'قوة I',
    help: 'يعدّل قيمة I وحدها فوق التعديل العام.',
  }),
  Object.freeze({
    key: 'dMaxGain', primary: false,
    label: 'قوة D القصوى',
    help: 'يغيّر الحد الأعلى الذي ترتفع إليه D عند الحاجة.',
  }),
  Object.freeze({
    key: 'rollPitchRatio', primary: false,
    label: 'توازن Roll / Pitch',
    help: 'يغيّر نسبة القيم المولّدة بين المحورين.',
  }),
  Object.freeze({
    key: 'pitchPiGain', primary: false,
    label: 'P و I للمحور الطولي',
    help: 'يعدّل P وI على Pitch وحده فوق التوازن أعلاه.',
  }),
]);

export const SIMPLIFIED_PRIMARY_SLIDERS: readonly SimplifiedSliderCopy[] =
  Object.freeze(SIMPLIFIED_SLIDERS.filter(slider => slider.primary));
export const SIMPLIFIED_MORE_SLIDERS: readonly SimplifiedSliderCopy[] =
  Object.freeze(SIMPLIFIED_SLIDERS.filter(slider => !slider.primary));

/* ------------------------------------------------------------------ */
/* Filter blocks                                                       */
/* ------------------------------------------------------------------ */

export interface SimplifiedFilterCopy {
  readonly title: string;
  readonly help: string;
}

/**
 * Gyro and D-term stay SEPARATE.
 *
 * They are different multipliers over different frequencies in different
 * scopes - the gyro block is global, the D-term block belongs to the PID
 * profile - so a single "filter strength" control would be one number
 * standing for two independent truths.
 */
export const SIMPLIFIED_GYRO_FILTER: SimplifiedFilterCopy = Object.freeze({
  title: 'فلتر Gyro',
  help: 'مضاعف يُطبَّق على ترددات فلتر الجيروسكوب. إعداد عام للمتحكم، لا يخص ملف الضبط.',
});
export const SIMPLIFIED_DTERM_FILTER: SimplifiedFilterCopy = Object.freeze({
  title: 'فلتر D-term',
  help: 'مضاعف يُطبَّق على ترددات فلتر D. يخص ملف الضبط الحالي.',
});

/**
 * A frequency RANGE, never a single ambiguous number.
 *
 * `1.37×` and `342–685 Hz` are two different facts and the screen shows
 * both. Printing `137 Hz` - the multiplier wearing a frequency unit - is
 * the mistake this exists to make impossible.
 */
export function formatEffectiveRange(minHz: number, maxHz: number): string {
  return minHz === maxHz ? `${minHz} Hz` : `${minHz}–${maxHz} Hz`;
}

/**
 * A block whose stored frequency is already zero stays off.
 *
 * `generateSimplifiedGyroFilters` guards every assignment on the current
 * value being non-zero, so a disabled filter is not switched on by raising
 * the multiplier - and the UI must not imply that it would.
 */
export const SIMPLIFIED_ZERO_FILTER_NOTE =
  'هذا الفلتر معطّل حاليًا، ولن يُشغّله رفع المضاعف.';

/* ------------------------------------------------------------------ */
/* Overwrite summary                                                   */
/* ------------------------------------------------------------------ */

export interface OverwriteSummary {
  /** Short category names for the one-line summary. */
  readonly categories: readonly string[];
  /** The individual field names, for the expandable detail. */
  readonly fields: readonly string[];
  readonly touchesFilters: boolean;
}

/**
 * Which categories a save will rewrite, from the generator's own answer.
 *
 * `simplifiedOwnedFields` is the same function the controller uses to refuse
 * a conflicting direct edit, so the summary and the refusal can never
 * disagree about what the generator owns.
 */
export function overwriteSummary(simplified: MspSimplifiedTuning): OverwriteSummary {
  const owned = simplifiedOwnedFields(simplified);
  const categories: string[] = [];
  if (owned.some(field => /\.(P|I|D)$/.test(field))) categories.push('PID');
  if (owned.some(field => field.endsWith('.F'))) categories.push('Feedforward');
  if (owned.some(field => field.endsWith('.D_MAX'))) categories.push('D Max');
  const touchesFilters = simplified.gyro.enabled || simplified.dterm.enabled;
  if (touchesFilters) categories.push('الفلاتر');
  return Object.freeze({
    categories: Object.freeze(categories),
    fields: Object.freeze([...owned]),
    touchesFilters,
  });
}

/** Which direct fields the generator currently owns, for disabling them. */
export function generatorOwnedDirectFields(simplified: MspSimplifiedTuning | undefined): ReadonlySet<string> {
  return new Set(simplified === undefined ? [] : simplifiedOwnedFields(simplified));
}

export const GENERATOR_OWNED_NOTE = 'تتحكم به إعدادات الضبط المبسّط حاليًا.';

export {classifySimplifiedPidsMode};
