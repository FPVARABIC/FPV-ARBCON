/**
 * THE SINGLE SOURCE OF TRUTH for the guide package's pictures.
 *
 * One file drives four things that used to drift apart:
 *   capture.mjs   - takes the screenshots
 *   validate.mjs  - asserts the CONTROL holds the value, and that an
 *                   option is SELECTED, not merely present on screen
 *   sheets.mjs    - builds the per-style contact sheets
 *   guide.json    - the machine-readable step list beside each guide
 *
 * If a value changes, it changes HERE and everything downstream follows.
 * That is the whole reason this file exists: the earlier round kept the
 * numbers in five places and they disagreed.
 *
 * ---------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------
 * Every official RC_LINK preset begins by including
 * presets/2025.12/rc_link/defaults.txt (S1.13), which sets:
 *
 *     feedforward_averaging = 2_POINT      rc_smoothing_auto_factor = 30
 *     feedforward_jitter_factor = 7        rc_smoothing_auto_factor_throttle = 30
 *     feedforward_boost = 15               rc_smoothing_setpoint_cutoff = 0
 *                                          rc_smoothing_throttle_cutoff = 0
 *
 * The firmware's own PG defaults agree (pid.c: averaging 2_POINT,
 * jitter 7, boost 15). So a style preset that does not mention a field
 * still PRODUCES the value above - it does not produce zero, and it does
 * not produce "unset". Each style below therefore lists the value it
 * actually ends up with, marking which ones its own preset overrides.
 */

/** Enumerated indices, from the firmware's own lookup tables. */
export const AVERAGING = {OFF: 0, TWO_POINT: 1, THREE_POINT: 2, FOUR_POINT: 3};
export const PROTOCOL = {DSHOT150: 5, DSHOT300: 6, DSHOT600: 7};
export const FAILSAFE_PROCEDURE = {LAND: 0, DROP: 1, GPS_RESCUE: 2};

/** What S1.13 leaves behind when a preset says nothing. */
export const LINK_DEFAULTS = Object.freeze({
  averaging: AVERAGING.TWO_POINT, jitter: 7, boost: 15,
  autoFactor: 30, throttleFactor: 30, setpointCutoff: 0, throttleCutoff: 0,
});

export const STYLES = [
  /* ================================================================= */
  {
    id: 'cinematic', titleAr: "Cinematisch vliegen", titleEn: 'Cinematic',
    steps: [
      {
        n: 1, titleAr: "Ontvanger", screen: "Ontvanger · Signaalfiltering",
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 90, throttleFactor: 50, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '90', source: 'S1.1'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '50', source: 'S1.1'},
        ],
      },
      {
        n: 2, titleAr: "Stickrespons", screen: "PID-afstelling · Stickrespons",
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 12, boost: 15, averaging: AVERAGING.OFF},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '12', source: 'S1.1'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '15', source: 'S1.13'},
          {testid: 'pid-ff-averaging-0', kind: 'option', expect: 'selected', source: 'S1.1'},
        ],
      },
      {
        n: 3, titleAr: "Motoren", screen: "Motoren · ESC-instellingen",
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.11a'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.10b'},
          {testid: 'motor-config-poles', kind: 'input', expect: '14', source: 'C'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: "PID-afstelling · Dynamic Idle",
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 35},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '35', source: 'S1.11a'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: "Failsafe · Actie in fase 2",
        shot: 'failsafe', card: {text: "Actie in fase 2"},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.LAND, rescue: 0},
        targets: [{testid: 'failsafe-procedure-0', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: "OSD · Waarschuwingen",
        shot: 'osd-alarms', card: {text: "Meldingen"},
        fixture: {screen: 'osd', rssiDbm: -102},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-102 dBm', source: 'S1.1'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'freestyle', titleAr: "Freestyle", titleEn: 'Freestyle',
    steps: [
      {
        n: 1, titleAr: "Ontvanger", screen: "Ontvanger · Signaalfiltering",
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 50, throttleFactor: 50, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '50', source: 'S1.3'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '50', source: 'S1.3'},
        ],
      },
      {
        n: 2, titleAr: "Stickrespons", screen: "PID-afstelling · Stickrespons",
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 8, boost: 15, averaging: AVERAGING.TWO_POINT},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '8', source: 'S1.3'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '15', source: 'S1.13'},
          {testid: 'pid-ff-averaging-1', kind: 'option', expect: 'selected', source: 'S1.3'},
        ],
      },
      {
        n: 3, titleAr: "Motoren", screen: "Motoren · ESC-instellingen",
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.10b'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.10b'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: "PID-afstelling · Dynamic Idle",
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 30},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '30', source: 'S1.10a–c'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: "Failsafe · Actie in fase 2",
        shot: 'failsafe', card: {text: "Actie in fase 2"},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: "OSD · Waarschuwingen",
        shot: 'osd-alarms', card: {text: "Meldingen"},
        fixture: {screen: 'osd', rssiDbm: -98},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-98 dBm', source: 'S1.3'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'racing', titleAr: "Racen", titleEn: 'Racing',
    steps: [
      {
        n: 1, titleAr: "Ontvanger", screen: "Ontvanger · Signaalfiltering",
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 25, throttleFactor: 25, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '25', source: 'S1.4'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '25', source: 'S1.4'},
        ],
      },
      {
        n: 2, titleAr: "Stickrespons", screen: "PID-afstelling · Stickrespons",
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '3', source: 'S1.4'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '18', source: 'S1.4'},
          {testid: 'pid-ff-averaging-1', kind: 'option', expect: 'selected', source: 'S1.4'},
        ],
      },
      {
        n: 3, titleAr: "Motoren", screen: "Motoren · ESC-instellingen",
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.9'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.9'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: "PID-afstelling · Dynamic Idle",
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 40},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '40', source: 'S1.9'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: "Failsafe · Actie in fase 2",
        shot: 'failsafe', card: {text: "Actie in fase 2"},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: "OSD · Waarschuwingen",
        shot: 'osd-alarms', card: {text: "Meldingen"},
        fixture: {screen: 'osd', rssiDbm: -95},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-95 dBm', source: 'S1.4'}],
      },
      {
        n: 7, titleAr: "Videozender — Kanaal en stand-bymodus",
        screen: "Videozender · Kanaal en zendvermogen",
        shot: 'vtx', card: {text: "Kanaal en zendvermogen"},
        fixture: {screen: 'vtx', band: 5, channel: 1, power: 1, pit: 1},
        note: "In de race is de band en het kanaal niet jouw keuze, maar wat de organisator voor je geeft en de opname toont `Raceband` als voorbeeld, niet als aanbeveling. Het veld dat echt van jou is, is Pit Mode: geactiveerd hier, dus zender is stil terwijl je op de startlijn bent, verpest geen video van wie nu vliegt. Doe het uit als het jouw beurt is. De hele tabel is afgelezen van vluchtcontroller, dus wat je ziet is wat je zender ondersteunt.",
        targets: [
          {testid: 'vtx-band-5', kind: 'option', expect: 'selected', source: 'C'},
          {testid: 'vtx-channel-1', kind: 'option', expect: 'selected', source: 'C'},
          {testid: 'vtx-pit', kind: 'switch', expect: 'on', source: 'C'},
        ],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'tiny-whoop', titleAr: "Whoops en binnen vliegen", titleEn: 'Tiny Whoop / Indoor',
    steps: [
      {
        n: 1, titleAr: "Motoren", screen: "Motoren · ESC-instellingen",
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT300, poles: 12, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-6', kind: 'option', expect: 'selected', source: 'S1.8'},
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'not-selected', source: 'S1.8'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.8'},
          {testid: 'motor-config-poles', kind: 'input', expect: '12', source: 'S1.8'},
        ],
      },
      {
        n: 2, titleAr: 'Dynamic Idle', screen: "PID-afstelling · Dynamic Idle",
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 120, jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '120', source: 'S1.8'}],
      },
      {
        n: 3, titleAr: "Stickrespons", screen: "PID-afstelling · Stickrespons",
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT, idle: 120},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '3', source: 'S1.8'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '18', source: 'S1.8'},
        ],
      },
      {
        n: 4, titleAr: "Voeding en accu", screen: "Voeding · Accugrenzen voor 1S",
        shot: 'power', card: {text: "Accugrenzen"},
        fixture: {screen: 'power', cells: 1, min: 320, warn: 340, max: 445, capacity: 450, voltage: 415},
        targets: [
          {testid: 'power-cell-max', kind: 'stepper', expect: '4.45 V', source: 'S1.8'},
          {testid: 'power-capacity', kind: 'stepper', expect: '450 mAh', source: 'C'},
          {testid: 'power-live', kind: 'contains', expect: '1S', source: 'C'},
        ],
      },
      {
        n: 5, titleAr: "Gascurve", screen: "PID-afstelling · Gascurve en gasbegrenzing",
        shot: 'throttle-curve', card: 'pid-throttle-rates',
        fixture: {screen: 'pid-feel', thrMid: 30, thrHover: 30, thrExpo: 65, idle: 120, jitter: 3, boost: 18},
        targets: [
          {testid: 'pid-throttle-mid', kind: 'stepper', expect: '30', source: 'S1.8'},
          {testid: 'pid-throttle-expo', kind: 'stepper', expect: '65', source: 'S1.8'},
          {testid: 'pid-throttle-hover', kind: 'stepper', expect: '30', source: 'S1.8'},
        ],
      },
      {
        n: 6, titleAr: 'Failsafe', screen: "Failsafe · Actie in fase 2",
        shot: 'failsafe', card: {text: "Actie in fase 2"},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'long-range', titleAr: "Lange afstand", titleEn: 'Long Range',
    steps: [
      {
        n: 1, titleAr: "Poorten", screen: "Poorten · GPS-poort",
        shot: 'ports', card: null,
        fixture: {screen: 'ports'},
        targets: [{testid: 'ports-screen', kind: 'contains', expect: 'GPS / GNSS', source: 'C'}],
      },
      {
        n: 2, titleAr: "Ontvanger", screen: "Ontvanger · Bron en RSSI",
        shot: 'receiver-cutoffs', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 30, throttleFactor: 30, setpointCutoff: 10, throttleCutoff: 15},
        targets: [
          {testid: 'receiver-setpoint-cutoff', kind: 'stepper', expect: '10', source: 'S1.5'},
          {testid: 'receiver-throttle-cutoff', kind: 'stepper', expect: '15', source: 'S1.5'},
        ],
      },
      {
        n: 3, titleAr: 'GPS', screen: "GPS · Inschakelen, thuispositie en nauwkeurigheid",
        shot: 'gps', card: null,
        fixture: {screen: 'gps'},
        targets: [{testid: 'gps-screen', kind: 'contains', expect: 'UART2', source: 'C'}],
      },
      {
        n: 4, titleAr: 'GPS Rescue', screen: "Failsafe · GPS Rescue-instellingen",
        shot: 'gps-rescue', card: 'failsafe-gps-rescue',
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.GPS_RESCUE, rescue: 1},
        targets: [
          {testid: 'failsafe-gps-return-altitude', kind: 'stepper', expect: "30 m", source: 'S1.12d'},
          {testid: 'failsafe-gps-ground-speed', kind: 'stepper', expect: "7.5 m/s", source: 'S1.12d'},
          {testid: 'failsafe-gps-descend-rate', kind: 'stepper', expect: "1.5 m/s", source: 'S1.12d'},
          {testid: 'failsafe-gps-min-sats', kind: 'stepper', expect: '8', source: 'S1.12d'},
          {testid: 'failsafe-gps-allow-arming-0', kind: 'option', expect: 'selected', source: 'S1.12d'},
          {testid: 'failsafe-gps-allow-arming-1', kind: 'option', expect: 'not-selected', source: 'S1.12d'},
          {testid: 'failsafe-gps-sanity-2', kind: 'option', expect: 'selected', source: 'S1.12d'},
        ],
      },
      {
        n: 5, titleAr: "Vliegmodi", screen: "Vliegmodi · GPS Rescue op een schakelaar",
        shot: 'modes', card: null,
        fixture: {screen: 'modes'},
        targets: [{testid: 'modes-screen', kind: 'contains', expect: 'GPS Rescue', source: 'C'}],
      },
      {
        n: 6, titleAr: "Voeding en accu", screen: "Voeding · Voorbeeld voor 6S",
        shot: 'power', card: {text: "Accugrenzen"},
        fixture: {screen: 'power', cells: 6, min: 330, warn: 350, max: 435, capacity: 1300, voltage: 2430},
        targets: [
          {testid: 'power-cell-warning', kind: 'stepper', expect: '3.50 V', source: 'C'},
          {testid: 'power-live', kind: 'contains', expect: '6S', source: 'C'},
        ],
      },
      {
        n: 7, titleAr: "videozender  —  Energie en de werkelijke niveaus",
        screen: "Videozender · Kanaal en zendvermogen",
        shot: 'vtx', card: {text: "Kanaal en zendvermogen"},
        fixture: {screen: 'vtx', band: 1, channel: 1, power: 4, lowPower: 1},
        note: "Er is geen officiële cijfer hier, en het is de wet die bepaalt. Wat de opname toont is het hoogste niveau dat dit zender (600) aankondigt om te weten waar je de beschikbare niveaus op je computer leest, niet om het cijfer te kopiëren. De enige regel in deze handleiding: de hoogste energie die de wetten van je plaats toestaan, geen hoogste energie die bestaat. Hier wordt ook geactiveerd ** lage energie bij DISARM**: langdurig betekent lang gewapende tijd en hoge energie, het verminderen van de energie automatisch na het ontdoen van armen vermindert de temperatuur van zender terwijl u staande bent. `[C]`",
        targets: [
          {testid: 'vtx-power-4', kind: 'option', expect: 'selected', source: 'C'},
          {testid: 'vtx-low-power-1', kind: 'option', expect: 'selected', source: 'C'},
        ],
      },
      {
        n: 8, titleAr: 'OSD', screen: "OSD · Veiligheidswaarschuwingen",
        shot: 'osd-alarms', card: {text: "Meldingen"},
        fixture: {screen: 'osd', rssiDbm: -100, lq: 60, capacity: 1100, altitude: 300},
        targets: [
          {testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-100 dBm', source: 'C'},
          {testid: 'osd-lq', kind: 'stepper', expect: '60%', source: 'C'},
        ],
      },
      {
        n: 9, titleAr: "Stickrespons", screen: "PID-afstelling · Stickrespons",
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 10, boost: 0, averaging: AVERAGING.OFF, idle: 30},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '10', source: 'S1.5'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '0', source: 'S1.5'},
          {testid: 'pid-ff-averaging-0', kind: 'option', expect: 'selected', source: 'S1.5'},
        ],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'firmware', titleAr: "Firmware", titleEn: 'Firmware',
    steps: [
      {
        /* The board is CHOSEN in this picture, and the build options are
         * on screen. The earlier capture's subject was an empty USB bus
         * and a not-yet-configured build - a picture of nothing having
         * happened yet, which taught the reader nothing. */
        n: 1, titleAr: "Printplaat, versie en bouwopties",
        screen: "firmware update · fase 1: printplaat en bouw",
        shot: 'flasher-board', card: null,
        prepare: [
          {click: 'target-selector'},
          {click: 'target-SPEEDYBEEF405V3', settle: 900},
          {click: 'release-selector'},
          {click: 'release-4.6.0', settle: 1200},
        ],
        note: "Het scherm is in twee fasen: 1 scherm en bouw, dan 2 verificatie en flashen. Verplaats je niet tot een seconde voordat je een printplaat en een versie kiest. In de opname is het panel geselecteerd (`SPEEDYBEEF405V3`) en de versie geselecteerd (`4.6.0`), en daarom verscheen **constructie**: het radioprotocol, Telemetry, OSD en motoren. Dit is de stap om te bepalen wat er in je plank zal zijn na de update. Wat je hier niet kiest, zal niet zijn, hoe later je ook zoekt in de instellingen.",
        fixture: {screen: 'flasher'},
        targets: [
          {testid: 'target-selector', kind: 'contains', expect: 'SPEEDYBEEF405V3', source: 'C'},
          {testid: 'release-selector', kind: 'contains', expect: '4.6.0', source: 'C'},
          {testid: 'build-configuration', kind: 'contains', expect: "Radioprotocol", source: 'C'},
          {testid: 'radio-protocol-selector', kind: 'contains', expect: 'CRSF', source: 'C'},
        ],
      },
      {
        /* The corner shouts "never flash with props on" in its warnings.
         * Until now it never showed where the app makes you say so. */
        n: 2, titleAr: "Veiligheidscontrole vóór het flashen",
        screen: "firmware update · fase 2 · beveiligingspoortkaart",
        shot: 'flasher-safety', card: {text: "Veiligheidscontrole", min: 2},
        prepare: [
          {click: 'firmware-step-flash', settle: 700},
          {click: 'confirm-props-removed'},
          {click: 'confirm-usb-power-only'},
        ],
        note: "De twee sleutels op deze kaart zijn geen herinnering  —  flashen begint niet voordat ze worden geactiveerd, en de kaart wordt ook niet met  —  Flash on connect  —  doorgeslagen. Doe het nadat je hebt gedaan wat ze zeggen, niet voordat.",
        fixture: {screen: 'flasher'},
        targets: [
          {testid: 'confirm-props-removed', kind: 'switch', expect: 'on', source: 'C'},
          {testid: 'confirm-usb-power-only', kind: 'switch', expect: 'on', source: 'C'},
        ],
      },
      {
        n: 3, titleAr: "Presets", screen: "Presets · Officiële bibliotheek",
        shot: 'presets', card: null,
        note: "Let op de overeenkomstige pakketten. 5 Het nummer is niet alles wat er in de bibliotheek is, maar het versie van je plaatje, en de versie van de handschrift, die niet met de hand wordt gelezen. De officiële naam naast elk pakket is `OFFICIAL`.",
        fixture: {screen: 'presets'},
        targets: [{testid: 'presets-screen', kind: 'contains', expect: "Compatibele presets (5)", source: 'S1'}],
      },
    ],
  },
];

/** `?a=1&b=2` from a fixture description. */
export function query(fixture) {
  return Object.entries(fixture)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export const IMAGE_ROOT = 'docs/flight-guides';
export const PREVIEW = process.env.GUIDE_PREVIEW_URL ?? 'http://127.0.0.1:4182/index.html';

/** Each style owns its review sheet, like it owns its pictures. */
export const reviewDir = styleId => `docs/flight-guides/${styleId}/review`;

/* =====================================================================
 * DECISIONS - the other half of a self-contained corner.
 * =====================================================================
 *
 * A guide that only lists what to CHANGE leaves the reader wondering
 * about everything it never mentions. Each style therefore carries a
 * verdict on every requirement in the matrix, not just the illustrated
 * ones:
 *
 *   STEP              an illustrated step in this style's own sequence
 *   ACTION            do it, but one line beats a screenshot
 *   PILOT_PREFERENCE  no single right value exists; say so plainly
 *   KEEP_DEFAULT      reviewed, and the answer is "do not touch it"
 *   NOT_APPLICABLE    this style does not use it, or this app cannot
 *
 * Written per style ON PURPOSE, with no "same as Freestyle" pointers.
 * Code may be shared; guidance may not - a reader inside one corner must
 * never have to open another to learn what to do.
 */
export const DECISIONS = {
  cinematic: [
    {what: "Afkapfrequenties (setpoint · gas)", kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: "Laat ze 0  —  geen  —  Automatisch  —. De officiële filmopstelling regelt de automatische processors zonder de frequentie van de stukken aan te raken."},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: "Er is geen officiële Rates voor de bioscoop. Kies een langzamer bestand dan je gewone en verhoog de expo een beetje om het midden te verlichten."},
    {what: "PID-waarden (P · I · D)", kind: 'KEEP_DEFAULT', source: 'S1.1',
     detail: "De twee officiële bioscopen hebben helemaal geen P, I of D. De flexibiliteit komt van de stickrespons en de verlichting, niet van de PID.."},
    {what: "Gyro LPF · D-term LPF · Dynamic Notch", kind: 'KEEP_DEFAULT', source: 'S1.11a',
     detail: "Volg je platform. De filmreferentiewaarden (750Hz dak voor Cinelog, minimum 125Hz voor schone bouw) zijn in de sectie  — optie —, en de toepassing wijzigt ze alleen als de leeswijze bewijst dat de functie actief is."},
    {what: "Vliegmodi (Modes)", kind: 'PILOT_PREFERENCE',
     detail: "De ARM-sleutel is verplicht en wordt één keer per vliegtuig ingesteld. Vervolgens  —  Angle of Beeper of Turtle  —  uw voorkeur."},
    {what: "Voeding en accu", kind: 'PILOT_PREFERENCE',
     detail: "Er zijn geen grenzen aan accu. Pas ze aan op je pakket: aantal cellen, cel waarschuwing, capaciteit."},
    {what: "Videozender (VTX)", kind: 'NOT_APPLICABLE',
     detail: "Dat stijl verandert niet. Pas het kanaal en de stroom één keer aan volgens je locatie en de regels."},
    {what: '`thrust_linear`', kind: 'NOT_APPLICABLE', source: 'S1.11a',
     detail: "Het is geregeld door de officiële opstelling volgens de frequentie ESC (0 bij 24k · 20 bij 48k · 40 bij 96k), en wordt niet weergegeven door deze toepassing. Het wordt ingesteld vanaf de opdrachtlijn of via de pakkettoepassing."},
  ],
  freestyle: [
    {what: "Afkapfrequenties (setpoint · gas)", kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: "Laat ze 0  —  geen  —  Automatisch  —. De formele freestyle-instelling regelt alleen de automatische factoren."},
    {what: 'Rates', kind: 'PILOT_PREFERENCE', source: 'S1.10b',
     detail: "De officiële bibliotheek toont drie bestanden van hetzelfde patroon, en dat is hetzelfde antwoord: er is geen enkel echt getal. RC rate 2 / expo 40 / super 80 · of 3 / 35 / 105 · of 25 / 45 / 108. Begin bij het begin en stap voor stap."},
    {what: "PID-waarden (P · I · D)", kind: 'KEEP_DEFAULT', source: 'S1.3',
     detail: "P of I of D. niet aanraken simplified-rollers die niet door de app worden weergegeven; Verander de waarden niet handmatig om ze te volgen."},
    {what: "Gyro LPF · D-term LPF · Dynamic Notch", kind: 'KEEP_DEFAULT', source: 'S1.10b',
     detail: "Volg je maat. Referentiewaarden (loof 400Hz en minimum 90Hz voor maat 3–5\") in de sectie  — Optional —."},
    {what: "Vliegmodi (Modes)", kind: 'PILOT_PREFERENCE',
     detail: "De ARM-sleutel is verplicht. Airmode, Turtle en Beeper."},
    {what: "Voeding en accu", kind: 'PILOT_PREFERENCE',
     detail: "Zet het op je pakket: aantal cellen, celwaarschuwing en capaciteit. Geen officiële gratis waarde."},
    {what: "Videozender (VTX)", kind: 'NOT_APPLICABLE',
     detail: "Dat stijl verandert niet. Haal hem een keer naar je plaats."},
    {what: '`thrust_linear`', kind: 'NOT_APPLICABLE', source: 'S1.10b',
     detail: "30 voor 5' · 40 voor 3–4' · 10 voor 7' in de officiële instelling, wordt niet getoond in deze toepassing."},
  ],
  racing: [
    {what: "Afkapfrequenties (setpoint · gas)", kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: "Laat ze 0. De officiële race-opstelling verlaagt de automatische processors naar 25 in plaats van het gebruik van vaste snijfrequenties."},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: "Er is geen officiële Rates als race. De bibliotheek laat auteursbestanden zien als opties, niet als regel. Beginsel: expo is minder vrij, omdat de nauwkeurigheid rond het midden belangrijker is dan de reikwijdte  —  en het getal blijft uw keuze."},
    {what: "PID-waarden (P · I · D)", kind: 'KEEP_DEFAULT', source: 'S1.9',
     detail: "PID wordt geconfigureerd via de simplified-slippers en vervolgens `simplified_tuning apply`, die niet in de app worden weergegeven. P/I/D niet handmatig aanpassen."},
    {what: "Gyro LPF · D-term LPF · Dynamic Notch", kind: 'KEEP_DEFAULT', source: 'S1.9',
     detail: "Volg het aanpassingspakket. Referentiewaarden (dak 650Hz, minimum 125Hz voor schone bouw) in de sectie  — voorkeur —."},
    {what: "Vliegmodi (Modes)", kind: 'PILOT_PREFERENCE',
     detail: "De ARM-sleutel is verplicht. Turtle is nuttig in de race; De rest is jouw keuze."},
    {what: "Voeding en accu", kind: 'PILOT_PREFERENCE',
     detail: "Zet ze op je pak. De race stelt geen accu-grens op, maar de cel moet je waarschuwen voor het einde van roll en niet later."},
    {what: '`thrust_linear` · `tpa_*`', kind: 'NOT_APPLICABLE', source: 'S1.9',
     detail: "Ze worden geregeld door de officiële opstelling (thrust_linear 20 · tpa_rate 70 · tpa_breakpoint 1250) en worden niet getoond door deze toepassing."},
  ],
  'tiny-whoop': [
    {what: "Ontvanger · Signaalfiltering", kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: "De officiële setup van de WOOP ** bevat geen ** linkfile, dus de vergoeding blijft op zijn oorspronkelijke: 30/30 automatische transacties en 0 stukkenfrequentie. Verander ze niet in die stijl."},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: "De formele opstelling toont het rates-bestand als een onopgeleide optie, niet als regel. Waub is geneigd tot een hoger yaw omdat zijn rotatie traag is met een  —  en een getal van uw keuze."},
    {what: "PID-waarden (P · I · D)", kind: 'KEEP_DEFAULT', source: 'S1.8',
     detail: "PID wordt via de simplified-sliders geconfigureerd door de officiële WOOP-instelling, die niet in de toepassing wordt weergegeven. P/I/D mag niet handmatig worden aangepast."},
    {what: "Filters", kind: 'KEEP_DEFAULT', source: 'S1.8',
     detail: "De officiële opstelling schakelt Gyro LPF1 en Dynamic Notch uit en is alleen afhankelijk van de RPM filter. De app laat Dynamic Notch niet activeren of uitschakelen, dat is het juiste gedrag hier."},
    {what: "Vliegmodus: Acro · Angle · Horizon", kind: 'PILOT_PREFERENCE',
     detail: "Acro is volledig geldig voor Woop, Angle is niet verplicht. Angle is een nuttig leerhulp binnen de kamer. Zet het op de sleutel als je naar haar terug wilt, of laat het."},
    {what: 'Airmode', kind: 'PILOT_PREFERENCE', source: 'S1.8',
     detail: "De officiële opstelling zegt dat het uitsteken het beste is in het binnenvliegen, en dat is een ongeletterde optie. Voor acrobaten in een grote ruimte, zet het op een sleutel."},
    {what: "`vbat_sag_compensation` compensatie.", kind: 'NOT_APPLICABLE', source: 'S1.8',
     detail: "Het wordt aanbevolen in de officiële instelling (optie leraar, waarde 100) omdat de 1S-cel zwaar onder de zwangerschap valt  —  maar ** deze applicatie laat het niet zien**. Opgesteld vanaf de opdrachtlijn of via het officiële pakket."},
    {what: 'OSD', kind: 'PILOT_PREFERENCE',
     detail: "Er is geen officieel nummer voor Woop. Als je een OSD hebt, begin dan met een RSSI dBm alarm bij −98 en verander het na een vlucht in een gebouw."},
    {what: "Videozender (VTX)", kind: 'PILOT_PREFERENCE',
     detail: "Inlandvliegen heeft geen hoge energie nodig; Begin op het laagste niveau dat je een schoon beeld geeft."},
    {what: '`cpu_late_limit_permille`', kind: 'NOT_APPLICABLE', source: 'S1.8',
     detail: "Het wordt gecontroleerd door de officiële instelling bij 15 en wordt niet getoond door de applicatie. Zijn afwezigheid verhindert de vlucht niet."},
  ],
  'long-range': [
    {what: "Motoren en Dynamic Idle", kind: 'ACTION', source: 'S1.10c',
     detail: "Doe het. Bidirectional DShot En stel het aantal polen op je motor aan, en stel het aan. Dynamic Idle Op de ** 30 ** (× 100 rpm Voor de maat. 7 \". Van het motoren-scherm en het PID.-scherm."},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: "Er is geen officiële Rates in de lange termijn. Beginsel: Langzamer dan je normaal. Je vliegt in een lange rechte lijn. En het nummer is jouw keuze."},
    {what: "PID-waarden (P · I · D)", kind: 'KEEP_DEFAULT', source: 'S1.5',
     detail: "De lange termijn opstelling verandert alleen stickrespons en de verlichting, niet aan P of I of D.."},
    {what: "Filters", kind: 'KEEP_DEFAULT', source: 'S1.10c',
     detail: "Volg je maat. De referentiewaarde van de 7 is de laagste dynamische 40Hz filter, omdat de lange structuur bij een lagere frequentie tritelt."},
    {what: "Lees linkkwaliteit (LQ) en RSSI in dBm-eenheid", kind: 'NOT_APPLICABLE',
     detail: "Ze zijn helemaal niet in de MSP-contract. Geen MSP-app kan ze live laten zien. Je ziet ze in je bril via OSD; De app zet alleen de alarmgrens aan (stap 8)."},
    {what: "Type positiebepaling (2D/3D) en HDOP/VDOP", kind: 'NOT_APPLICABLE',
     detail: "Het contactprotocol met de controller stuurt een installatie- PDOP Alleen. 2 D/3D Nee, nee. HDOP/VDOP. De app geeft PDOP de juiste naam en bedenkt geen alternatief. Dezelfde naam in `_meta/sources.md` § S2.2."},
  ],
  firmware: [
    {what: "Vlieginstellingen", kind: 'NOT_APPLICABLE',
     detail: "Dit is geen vluchtkaart. Na het updaten, maak een hoek van je patroon open en volg hem bij zijn eerste stappen."},
    {what: "Back-up vóór het bijwerken", kind: 'ACTION',
     detail: "Zet de back-up optie in voordat flashen wordt gestart. De update verwijdert al uw instellingen, inclusief Failsafe, GPS, Rescue en standaard."},
    {what: "Stappen na het bijwerken", kind: 'ACTION',
     detail: "poorten ← ontvanger ← motoren ← Mode (ARM sleutel eerst) ← Failsafe ← dan uw stijl handleiding."},
  ],
};
