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
import {simplifiedOwnedFields, simplifiedOwnedNames} from '../../core/state/pidWriteVerification';

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
    case 'OFF': return Object.freeze({label: "Uit", known: true});
    case 'RP': return Object.freeze({label: 'Roll + Pitch', known: true});
    case 'RPY': return Object.freeze({label: 'Roll + Pitch + Yaw', known: true});
    case 'UNKNOWN': return Object.freeze({label: `Onbekende modus (${mode.raw})`, known: false});
  }
}

/** The one-line description under the section title. */
export const SIMPLIFIED_SUMMARY =
  "Stelt meerdere waarden in het huidige afstelprofiel tegelijk in, op basis van de standaardwaarden van de firmware.";

/**
 * The expandable explanation. Two facts, both proven, both load-bearing.
 *
 * It says REGENERATES and it says the old values do not come back, because
 * a pilot who believes either the opposite will lose a tune they spent a
 * season on.
 */
export const SIMPLIFIED_EXPLANATION =
  "Bij opslaan berekent de vluchtcontroller de PID-waarden en bijbehorende filters opnieuw vanuit de ingebouwde firmwarestandaarden, niet vanuit uw huidige afstelling. Later uitschakelen voorkomt nieuwe berekeningen, maar herstelt uw vorige waarden niet.";

/**
 * What the user is told when they choose OFF.
 *
 * Deliberately not phrased as "restore" or "return to manual tune" - the
 * firmware does neither.
 */
export const SIMPLIFIED_OFF_CONSEQUENCE =
  "Uitschakelen stopt alleen het opnieuw berekenen bij toekomstige wijzigingen. De huidige waarden blijven zoals de vluchtcontroller ze heeft berekend. De waarden van vóór het inschakelen worden niet hersteld.";

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
    label: "Algemene sterkte",
    help: "Verhoogt of verlaagt alle berekende PID-waarden samen.",
  }),
  Object.freeze({
    key: 'piGain', primary: true,
    label: "P- en I-sterkte samen",
    help: "Past P en I in dezelfde richting aan.",
  }),
  Object.freeze({
    key: 'dGain', primary: true,
    label: "D-sterkte",
    help: "Wijzigt de berekende D-waarde op de betrokken assen.",
  }),
  Object.freeze({
    key: 'feedforwardGain', primary: true,
    label: "Feedforward-sterkte",
    help: "Wijzigt hoe direct de controller de stickbeweging volgt.",
  }),
  Object.freeze({
    key: 'iGain', primary: false,
    label: "I-sterkte",
    help: "Past alleen I aan, boven op de algemene instelling.",
  }),
  Object.freeze({
    key: 'dMaxGain', primary: false,
    label: "Maximale D-sterkte",
    help: "Wijzigt de bovengrens waarnaar D zo nodig stijgt.",
  }),
  Object.freeze({
    key: 'rollPitchRatio', primary: false,
    label: "Roll/Pitch-balans",
    help: "Wijzigt de verhouding tussen de berekende waarden voor beide assen.",
  }),
  Object.freeze({
    key: 'pitchPiGain', primary: false,
    label: "P en I voor de pitchas",
    help: "Past P en I alleen op Pitch aan, boven op de bovenstaande balans.",
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
  title: "Gyrofilter",
  help: "Vermenigvuldigingsfactor voor de gyrofilterfrequenties. Geldt voor de hele controller en hoort niet bij één afstelprofiel.",
});
export const SIMPLIFIED_DTERM_FILTER: SimplifiedFilterCopy = Object.freeze({
  title: "D-term-filter",
  help: "Vermenigvuldigingsfactor voor de D-term-filterfrequenties. Geldt voor het huidige afstelprofiel.",
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
  "Dit filter is uitgeschakeld. Een hogere vermenigvuldigingsfactor schakelt het niet in.";

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
  if (touchesFilters) categories.push("Filters");
  return Object.freeze({
    categories: Object.freeze(categories),
    fields: Object.freeze([...owned]),
    touchesFilters,
  });
}

/**
 * Which fields the generator currently owns, for disabling them.
 *
 * Delegates to `simplifiedOwnedNames`, which is the SAME set the
 * controller refuses a save against - PID gains, D Max, and the filter
 * frequencies. Building a shorter list here is how a control ends up
 * editable on screen and rejected on the wire.
 */
export function generatorOwnedDirectFields(simplified: MspSimplifiedTuning | undefined): ReadonlySet<string> {
  return simplified === undefined ? new Set<string>() : simplifiedOwnedNames(simplified);
}

export const GENERATOR_OWNED_NOTE = "Dit veld wordt momenteel door de eenvoudige afstelling beheerd.";

export {classifySimplifiedPidsMode};
