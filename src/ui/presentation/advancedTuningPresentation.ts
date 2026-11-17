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
import type {RpmFilterFieldKey} from '../../core/state/rpmFilterFields';

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
  {value: 0, label: "Stoppen"},
  {value: 1, label: "Inschakelen"},
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
    hint: "De hoogste waarde van D laat de controller bereiken bij snelle beweging.",
    detail:
      "D Max is geen tweede D-waarde. De normale D blijft actief. D Max is de bovengrens waarnaar de controller de demping tijdelijk verhoogt bij snelle bewegingen. De waarde 0 schakelt D Max op die as uit."
      + "De vluchtcontroller verhoogt de demping tijdelijk bij scherpe bewegingen en verlaagt deze daarna weer. Waarde 0 "
      + "gas werkt niet en D blijft stabiel.",
    wireName: 'd_max_roll',
  },
  dMaxPitch: {
    label: 'D Max — Pitch',
    hint: "De hoogste waarde van D laat de controller bereiken bij snelle beweging.",
    detail: "Zoals bij Roll, de Pitch.-axis De 0-waarde houdt D vast op deze as.",
    wireName: 'd_max_pitch',
  },
  dMaxYaw: {
    label: 'D Max — Yaw',
    hint: "De hoogste waarde van D laat de controller bereiken bij snelle beweging.",
    detail: "Zoals bij Roll, de Yaw.-axis De 0-waarde houdt D vast op deze as.",
    wireName: 'd_max_yaw',
  },
  dMaxGain: {
    label: "D Max-versterkingsgevoeligheid",
    hint: "Hoe reageert gas op de snelheid van verandering van de stick-opdracht.",
    detail:
      "De hoeveelheid gas wordt bepaald door D Max per eenheid van de variabele. De hoogste waarde."
      + "Het plafond komt sneller. Deze waarde heeft niets te maken met het D Max-diagram in de vereenvoudigde instelling:"
      + "Dat is nog een opslagwaarde.",
    wireName: 'd_max_gain',
  },
  dMaxAdvance: {
    label: "D Max-anticipatie",
    hint: "Hoe vroeg begint gas voordat de beweging komt.",
    detail:
      "Het begin van gas is gebaseerd op de veranderingspercentage van de stick in plaats van de fout."
      + "De maat, de vervulding voor de bewing en daarna.",
    wireName: 'd_max_advance',
  },

  /* ---- Feedforward ------------------------------------------------- */
  feedforwardTransition: {
    label: "Feedforward-overgang",
    hint: "Van elke afwijking van de stok begint Feedforward te werken. 0 betekent vanaf het begin.",
    detail:
      "Het percentage van stick dat Feedforward in de buurt van het midden wordt afgeschaft, blijft verdwijnen."
      + "Rustig maar. De 0-waarde houdt hem effectief op de lange termijn.",
    wireName: 'feedforward_transition',
  },
  feedforwardSmoothFactor: {
    label: "Feedforward-filtering",
    hint: "Het vermindert de uitwerking op het koste van een beetje vertraging.",
    detail:
      "Feedforward.-directeur. De hoogste waarden geven een filmgevoel."
      + "En een grotere vertraging. De kleinste en de snelste.",
    wireName: 'feedforward_smooth_factor',
  },
  feedforwardMaxRateLimit: {
    label: "Feedforward-begrenzing aan het uiteinde",
    hint: "Het verhindert de maximale snelheid te overschrijden wanneer stick naar de laatste wordt aangedreven.",
    detail:
      "Feedforward neemt af als het dicht bij de maximale rotatiepunt komt."
      + "Rates. heeft een supersnelle snelheid. De 0-waarde verstoort de grens.",
    wireName: 'feedforward_max_rate_limit',
  },

  /* ---- TPA --------------------------------------------------------- */
  tpaMode: {
    label: "TPA-modus",
    hint: "Alle transacties die TPA vermindert met gas's verhoging.",
    detail:
      "TPA vermindert de corrigerende kracht bij de hogere gas, waar het vliegtuig meer haalbaar is."
      + "Om te schudden. Het patroon bepaalt wat de afkorting is: P en D samen, of D alleen.",
    wireName: 'tpa_mode',
    choices: Object.freeze([
      {value: 0, label: "P en D"},
      {value: 1, label: "Alleen D"},
    ]),
  },
  tpaRate: {
    label: "TPA-sterkte",
    hint: "Hoe kort de correctie is bij het maximale knokken.",
    detail:
      "Vermindering bij maximaal gas. De waarde. 0 Het is kapot. TPA. De controller knipt."
      + "Een waarde hoger dan 100 bij het schrijven.",
    wireName: 'tpa_rate',
  },
  tpaBreakpoint: {
    label: "TPA-breekpunt",
    hint: "De waarde van gas die begint te dalen, in orde eenheid (1000–2000).",
    detail:
      "Onder dit punt werkt TPA helemaal niet. Hierboven gaat de afname naar gas."
      + "Het maximale. Eenheid is de eenheid van de ontvangst zelf, geen percentage.",
    wireName: 'tpa_breakpoint',
  },

  /* ---- I-term and anti-gravity ------------------------------------- */
  itermRelax: {
    label: "I-term Relax",
    hint: "I verhindert accumulatie tijdens snelle bewegingen.",
    detail:
      "Tijdens een snelle beweging verzamelt I zich per ongeluk alleen, het vliegtuig trekt bij stilstand."
      + "Verlichting stopt de accumulatie op de geselecteerde assen. INC laat zich in de richting accumuleren."
      + "Alleen de beweging.",
    wireName: 'iterm_relax',
    choices: Object.freeze([
      {value: 0, label: "Stoppen"},
      {value: 1, label: "Roll en Pitch"},
      {value: 2, label: "Alle assen"},
      {value: 3, label: "Roll en Pitch — INC"},
      {value: 4, label: "Alle assen — INC"},
    ]),
  },
  itermRelaxType: {
    label: "Referentie voor I-term Relax",
    hint: "Meten de verlichting de beweging van de stick of de rotatie van het vliegtuig?",
    detail:
      "SETPOINT meet de stick-optie, een gebruikelijke optie. GYRO meet de werkelijke rotatie."
      + "Hij is langzamer en meer conservatief.",
    wireName: 'iterm_relax_type',
    choices: Object.freeze([
      {value: 0, label: 'GYRO'},
      {value: 1, label: 'SETPOINT'},
    ]),
  },
  itermRelaxCutoff: {
    label: "I-term Relax-frequentie",
    hint: "Hoe snel is verandering, in Hz.",
    detail:
      "De frequency van de filter die besluit dat de beweging snel genoeg is om de accumulatie te stoppen."
      + "De hogere waarden maken de verlichting minder ingrijpend.",
    wireName: 'iterm_relax_cutoff',
  },
  itermRotation: {
    label: "I-term met Yaw meedraaien",
    hint: "De I verplaatst de accumulatie tussen de axes als hij rond de Yaw. draait.",
    detail:
      "Bij het opknappen van Yaw wordt wat op Roll ophoopt geschikt voor Pitch en vice versa. Activering."
      + "De waarden draaien met het vliegtuig in plaats van het op de verkeerde as te laten liggen.",
    wireName: 'iterm_rotation',
    choices: OFF_ON,
  },
  antiGravityGain: {
    label: "Anti-Gravity",
    hint: "I wordt tijdelijk opgeheven bij een onverwachte verandering van gas.",
    detail:
      "De gas-schuiving neigt naar het vliegtuig voordat de I. wordt opgevangen. I wordt tijdelijk verhoogd."
      + "Pas op de snelheid van verandering van gas. De 0-waarde verstoort het voordeel.",
    wireName: 'anti_gravity_gain',
  },

  /* ---- Limits and assistance --------------------------------------- */
  angleLimit: {
    label: "Maximale helling in Angle-modus",
    hint: "Op de graden. Hij beperkt de helling van het vliegtuig alleen op vlakte.",
    detail:
      "Geen sporen van Acro.. pitch beperkt de hoek die de Angle-positie bereikt bij"
      + "stick naar de laatste.",
    wireName: 'angle_limit',
  },
  acroTrainerAngleLimit: {
    label: "Acro Trainer-limiet",
    hint: "Op de graden. De maximale afstand die de trainingsmodus toelaat.",
    detail:
      "Het werkt alleen als de Acro Trainer-modus is geactiveerd op het modusskerm. Dat is niet waar."
      + "De situatie heeft geen invloed op deze waarde.",
    wireName: 'acro_trainer_angle_limit',
  },
  rateAccelLimit: {
    label: "Versnellingslimiet Roll/Pitch",
    hint: "Maximale wisselkoers per seconde. 0 betekent oneindig.",
    detail:
      "Een plotselinge sprong verhindert de stress van motoren. De 0 is standaard."
      + "Het betekent dat de controller geen grenzen oplegt.",
    wireName: 'acc_limit',
  },
  yawRateAccelLimit: {
    label: "Versnellingslimiet Yaw",
    hint: "Net als de vorige, Yaw-axis alleen. 0 betekent oneindig.",
    detail:
      "Yaw is mechanisch langzamer dan de andere axes, dus het heeft een onafhankelijke limiet.",
    wireName: 'acc_limit_yaw',
  },
  motorOutputLimit: {
    label: "Motoruitgangslimiet",
    hint: "Een percentage van de maxima is uitgegaan. 100 betekent onbeperkt.",
    detail:
      "Snij het hoger af tot motoren. Gebruikt om het vermogen opzettelijk te verminderen. Minderwaarde"
      + "De controleur accepteert 1.",
    wireName: 'motor_output_limit',
  },

  /* ---- Battery and thrust ------------------------------------------ */
  throttleBoost: {
    label: "Throttle Boost",
    hint: "gas beperkt de reactie op snelle verandering. 0 maakt het uit.",
    detail:
      "Een filter die de snelle veranderingen in gas onderstreept, zodat de reactie sneller lijkt te zijn zonder te verhogen."
      + "gas zelf.",
    wireName: 'throttle_boost',
  },
  thrustLinearization: {
    label: "Thrust Linearization",
    hint: "Het compenseren van de niet-linee bij de lage gas. 0 maakt het uit.",
    detail:
      "De ventilator niet lineair past bij de motor-opdracht. Compensatie redistribueert de zaak."
      + "Het correctiegevoel is gelijk over de gas-spanne.",
    wireName: 'thrust_linear',
  },
  vbatSagCompensation: {
    label: "Compensatie van spanningsdaling",
    hint: "Het behoud van de gevoelige stabiliteit met accu ontlasting. 0 maakt het uit.",
    detail:
      "De uitslag stijgt geleidelijk als de accu-spanning onder de zwangerschap daalt, laat de reactie niet afnemen."
      + "Op de laatste reis. Het heeft een goede inspanning nodig.",
    wireName: 'vbat_sag_compensation',
  },
  autoProfileCellCount: {
    label: "Profiel aan celaantal koppelen",
    hint: "De controller selecteert automatisch het PID-bestand op basis van de accu-compact.",
    detail:
      "De waarde is geen gewone getal: 'Automatisch schakelen' betekent altijd naar het bestand gaan."
      + "Dat komt overeen met het aantal ontdekte cellen, en zonder vervanging... betekent dat de functie is gestopt."
      + "Een getal van 1 tot 8 betekent dat dit bestand speciaal is voor dat aantal cellen.",
    wireName: 'auto_profile_cell_count',
    choices: Object.freeze([
      {value: -1, label: "Automatisch wisselen"},
      {value: 0, label: "Niet wisselen"},
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
    label: "Gyro LPF1-type",
    hint: "De vorm van de kandidaat: scherpheid voor vertraging.",
    detail:
      "PT1 is lichter en minder scherp. BIQUAD één en langzamer; PT2 en PT3 in volgorde."
      + "Het wordt steeds groter.",
    wireName: 'gyro_lpf1_type',
    choices: LOWPASS_TYPES,
  },
  gyroLpf2StaticHz: {
    label: "Gyro LPF2 — Frequentie",
    hint: "Een vaste tweede kandidaat na LPF1.. 0 maakt het uit.",
    detail:
      "LPF2 is een vaste, niet-dynamische filter, die na LPF1 werkt om de rest van het geluid te zuiveren."
      + "Hoge frequentie.",
    wireName: 'gyro_lpf2_static_hz',
  },
  gyroLpf2Type: {
    label: "Gyro LPF2-type",
    hint: "De vorm van de tweede kandidaat.",
    detail: "Dezelfde opties beschikbaar voor LPF1, en dezelfde wisselkoers tussen limiet en vertraging.",
    wireName: 'gyro_lpf2_type',
    choices: LOWPASS_TYPES,
  },
  gyroSoftNotchHz1: {
    label: "Gyro Notch 1 — Middenfrequentie",
    hint: "De frequentie die afneemt. 0 maakt deze notch. uit.",
    detail:
      "notch verwijdert een nauwkeurige band rond een bekende frequentie - een frame of ventilator - zonder"
      + "Het effect op de rest van het spectrum.",
    wireName: 'gyro_notch1_hz',
  },
  gyroSoftNotchCutoff1: {
    label: "Gyro Notch 1 — Bandbreedte",
    hint: "Hoe dichter je bij het centrum komt, hoe kleiner de band.",
    detail:
      "notch-controller zal volledig uitwerken als de scherpstelling het centrum bereikt of overschrijdt."
      + "Schrijven, we presenteren het als correctie van firmware en niet als een stil succes.",
    wireName: 'gyro_notch1_cutoff',
  },
  gyroSoftNotchHz2: {
    label: "Gyro Notch 2 — Middenfrequentie",
    hint: "notch is een onafhankelijke seconde. 0 maakt het uit.",
    detail: "Het werkt precies op dezelfde regels als de eerste.",
    wireName: 'gyro_notch2_hz',
  },
  gyroSoftNotchCutoff2: {
    label: "Gyro Notch 2 — Bandbreedte",
    hint: "Hoe dichter je bij het centrum komt, hoe kleiner de band.",
    detail: "Het heeft dezelfde correctie als het centrum bereikt: het notch-controller stopt bij het schrijven.",
    wireName: 'gyro_notch2_cutoff',
  },

  /* ---- D-term filters (PID PROFILE) -------------------------------- */
  dtermLpf1Type: {
    label: "D-term LPF1-type",
    hint: "De vorm van de eerste D-filter.",
    detail:
      "D maakt het meeste lawaai, dus zijn kandidaat is geneigd om een van de kandidaten te zijn."
      + "De gyro.. De ruil zelf: hardheid voor vertraging.",
    wireName: 'dterm_lpf1_type',
    choices: LOWPASS_TYPES,
  },
  dtermLpf1DynExpo: {
    label: "Dynamische D-term-curve",
    hint: "Hoe wordt de frequentie verdeeld tussen minimum en maximum met gas.",
    detail:
      "De waarde 0 is lineair verdeeld met gas. De hogere waarden houden de frequentie lang laag."
      + "Langer en dan snel bij de hoge gas.",
    wireName: 'dterm_lpf1_dyn_expo',
  },
  dtermLpf2StaticHz: {
    label: "D-term LPF2 — Frequentie",
    hint: "Een tweede kandidaat, vast op D.. 0 maakt het uit.",
    detail: "Het werkt na LPF1 alleen op het D-traject en raakt het oorspronkelijke gyro-signaal niet aan.",
    wireName: 'dterm_lpf2_static_hz',
  },
  dtermLpf2Type: {
    label: "D-term LPF2-type",
    hint: "D tweede filtervorm.",
    detail: "Dezelfde opties als voor de rest van de ondergeschikte kandidaten.",
    wireName: 'dterm_lpf2_type',
    choices: LOWPASS_TYPES,
  },
  dtermNotchHz: {
    label: "D-term Notch — Middenfrequentie",
    hint: "Een bepaalde frequentie van de D.-baan. 0 maakt het uit.",
    detail:
      "Het is nuttig als een resonant alleen in D verschijnt. Je kunt de weergave niet aanpassen bij of boven het centrum:"
      + "De controller accepteert de waarde en verwijdert die bij het opslaan van de instellingen."
      + "In plaats van te beweren dat ze bewaard waren.",
    wireName: 'dterm_notch_hz',
  },
  dtermNotchCutoff: {
    label: "D-term Notch — Bandbreedte",
    hint: "Hij moet kleiner blijven dan het centrum.",
    detail:
      "Om de notch te stoppen, zet het 0 centraal. Het aanbieden naar het centrum is geen manier om te stoppen."
      + "Geldig op deze route.",
    wireName: 'dterm_notch_cutoff',
  },
  yawLowpassHz: {
    label: "Yaw-filter",
    hint: "Een extra laag filter op de Yaw.-uitvoerder. 0 maakt het uit.",
    detail:
      "Yaw Langzamer en ruimter. Een extra kandidaat moet rustig zijn. motoren Don."
      + "Een duidelijke invloed op het bestuur.",
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
    hint: "Een tijdelijk maximum van D bij scherpe bewegingen. Niet de waarde van D een seconde.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'dMaxRoll', 'dMaxPitch', 'dMaxYaw', 'dMaxGain', 'dMaxAdvance',
    ]),
  }),
  Object.freeze({
    key: 'FEEDFORWARD',
    title: 'Feedforward',
    hint: "Een reactie gebaseerd op een stick-opdracht direct, voordat de controller een fout meet.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'feedforwardTransition', 'feedforwardSmoothFactor', 'feedforwardMaxRateLimit',
    ]),
  }),
  Object.freeze({
    key: 'TPA',
    title: 'TPA',
    hint: "Vermindering van de correctie bij een hoge gas, waarbij het vliegtuig meer gevoelig is voor trillingen.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>(['tpaMode', 'tpaRate', 'tpaBreakpoint']),
  }),
  Object.freeze({
    key: 'ITERM',
    title: "I-term en Anti-Gravity",
    hint: "Hoe de controller de accumulatie van fouten in beweging aanpakt en gas verandert.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'itermRelax', 'itermRelaxType', 'itermRelaxCutoff', 'itermRotation', 'antiGravityGain',
    ]),
  }),
  Object.freeze({
    key: 'LIMITS',
    title: "Limieten en ondersteuning",
    hint: "De daken veranderen het gevoel van vliegen niet in de Acro-modus, maar ze beperken wat toegestaan is.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'angleLimit', 'acroTrainerAngleLimit', 'rateAccelLimit', 'yawRateAccelLimit',
      'motorOutputLimit',
    ]),
  }),
  Object.freeze({
    key: 'BATTERY',
    title: "Accu en aandrijving",
    hint: "Compensatie houdt het gevoel stabiel met een verandering van spanning en druk.",
    scope: 'PID_PROFILE',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'throttleBoost', 'thrustLinearization', 'vbatSagCompensation', 'autoProfileCellCount',
    ]),
  }),
  Object.freeze({
    key: 'GYRO_FILTERS',
    title: "Gyrofilters",
    hint: "Het is gemeenschappelijk tussen alle PID:-bestanden. Het wijzigen hier verandert het in alle bestanden.",
    scope: 'GLOBAL',
    fields: Object.freeze<AdvancedFieldKey[]>([
      'gyroLpf1Type', 'gyroLpf2StaticHz', 'gyroLpf2Type',
      'gyroSoftNotchHz1', 'gyroSoftNotchCutoff1', 'gyroSoftNotchHz2', 'gyroSoftNotchCutoff2',
    ]),
  }),
  Object.freeze({
    key: 'DTERM_FILTERS',
    title: "D-term-filters",
    hint: "Het is alleen het huidige PID-bestand, niet gevolgd door de rest.",
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
 * The RPM filter.
 *
 * Two of its fields exist under every wire contract this app speaks; the
 * other five exist only from API 1.48. That difference is the ONE thing this
 * card is version-aware about, and the copy below says it in the operator's
 * terms - the settings are not in the older protocol, rather than a row of
 * greyed-out zeros with no explanation.
 */
export const RPM_FILTER_COPY = Object.freeze({
  title: "RPM-filter",
  hint: "De propellers maakt het geluid af, afhankelijk van de snelheid van elke motor, en beweegt met een verandering van snelheid.",
  scopeBadge: "Gedeeld door alle profielen",
  /** Shown ONLY under a contract whose message has no tail. §5. */
  tailAbsentNote: "Bijkomende instellingen voor de RPM-candidaten zijn beschikbaar via MSP in de nieuwste versies.",
  /** What a harmonics of zero actually means, said once. */
  disabledNote: "Een nul van de overeenkomsten betekent dat de kandidaat gestopt is.",
  detailTitle: "Technische details",
  detail:
    "De zeven velden zitten allemaal in de tekst van de filters. De eerste twee. Een getal."
    + "De compatibiliteit en de minimumfrequentie zijn aanwezig in alle ondersteunde versies. Maar hoe?"
    + "Het verdwijnen, Q en de drie gewichten verschijnen in de achterkant van het bericht vanaf de release."
    + "MSP 1.48, en de applicatie bepaalt zijn bestaan uit de versie van het protocol dat hij bij"
    + "Identificatie op het printplaat, niet van de lengte van het bericht of van het feit dat de waarde nul is.",
});

export interface RpmFieldCopy {
  readonly label: string;
  readonly hint: string;
  readonly wireName: string;
}

/**
 * Units and meanings, each taken from the firmware rather than assumed.
 *
 * The weights are stated as a percentage because two independent places in
 * the source say so: the struct comment in `pg/rpm_filter.h` - "effect or
 * 'weight' (0% - 100%) of each RPM filter harmonic" - and the MSP setter,
 * which rejects any weight above 100.
 */
export const RPM_FIELD_COPY: Readonly<Record<RpmFilterFieldKey, RpmFieldCopy>> = Object.freeze({
  harmonics: {
    label: "Aantal harmonischen",
    hint: "Hoe vaak draait de motor op de kandidaat? Nul stopt hem.",
    wireName: 'rpm_filter_harmonics',
  },
  minHz: {
    label: "Minimale frequentie (Hz)",
    hint: "De filter werkt niet onder deze frequentie, zodat hij niet te langzaam loopt.",
    wireName: 'rpm_filter_min_hz',
  },
  fadeRangeHz: {
    label: "Uitfaderingsbereik (Hz)",
    hint: "De mate waarin het effect van de filter geleidelijk afneemt bij de minimumfrequentie in plaats van plotseling te stoppen.",
    wireName: 'rpm_filter_fade_range_hz',
  },
  q: {
    label: "Filterkwaliteit Q",
    hint: "Hoe hoger het filter wordt, hoe kleiner het wordt: het verwijdert een hoger bereik rond de doelfrequentie.",
    wireName: 'rpm_filter_q',
  },
  weight1: {
    label: "Gewicht eerste harmonische %",
    hint: "De kracht van de kandidaat op de eerste verdubbeling, van nul tot honderd procent.",
    wireName: 'rpm_filter_weights[0]',
  },
  weight2: {
    label: "Gewicht tweede harmonische %",
    hint: "De kracht van de kandidaat op de tweede verdubbeling, van nul tot honderd procent.",
    wireName: 'rpm_filter_weights[1]',
  },
  weight3: {
    label: "Gewicht derde harmonische %",
    hint: "De sterkte van de kandidaat op de derde verdubbeling, van nul tot honderd procent.",
    wireName: 'rpm_filter_weights[2]',
  },
});

export function rpmFieldCopy(field: RpmFilterFieldKey): RpmFieldCopy {
  return RPM_FIELD_COPY[field];
}
