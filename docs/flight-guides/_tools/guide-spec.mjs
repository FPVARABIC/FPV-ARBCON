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
    id: 'cinematic', titleAr: 'الطيران السينمائي', titleEn: 'Cinematic',
    steps: [
      {
        n: 1, titleAr: 'المستقبل', screen: 'المستقبل · بطاقة تنعيم الإشارة',
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 90, throttleFactor: 50, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '90', source: 'S1.1'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '50', source: 'S1.1'},
        ],
      },
      {
        n: 2, titleAr: 'إحساس العصا', screen: 'ضبط PID · بطاقة إحساس العصا',
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 12, boost: 15, averaging: AVERAGING.OFF},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '12', source: 'S1.1'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '15', source: 'S1.13'},
          {testid: 'pid-ff-averaging-0', kind: 'option', expect: 'selected', source: 'S1.1'},
        ],
      },
      {
        n: 3, titleAr: 'المحركات', screen: 'المحركات · إعدادات ESC',
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.11a'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.10b'},
          {testid: 'motor-config-poles', kind: 'input', expect: '14', source: 'C'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: 'ضبط PID · بطاقة Dynamic Idle',
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 35},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '35', source: 'S1.11a'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: 'Failsafe · إجراء المرحلة 2',
        shot: 'failsafe', card: {text: 'إجراء المرحلة 2'},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.LAND, rescue: 0},
        targets: [{testid: 'failsafe-procedure-0', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: 'OSD · بطاقة التنبيهات',
        shot: 'osd-alarms', card: {text: 'التنبيهات'},
        fixture: {screen: 'osd', rssiDbm: -102},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-102 dBm', source: 'S1.1'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'freestyle', titleAr: 'الطيران الحر', titleEn: 'Freestyle',
    steps: [
      {
        n: 1, titleAr: 'المستقبل', screen: 'المستقبل · بطاقة تنعيم الإشارة',
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 50, throttleFactor: 50, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '50', source: 'S1.3'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '50', source: 'S1.3'},
        ],
      },
      {
        n: 2, titleAr: 'إحساس العصا', screen: 'ضبط PID · بطاقة إحساس العصا',
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 8, boost: 15, averaging: AVERAGING.TWO_POINT},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '8', source: 'S1.3'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '15', source: 'S1.13'},
          {testid: 'pid-ff-averaging-1', kind: 'option', expect: 'selected', source: 'S1.3'},
        ],
      },
      {
        n: 3, titleAr: 'المحركات', screen: 'المحركات · إعدادات ESC',
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.10b'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.10b'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: 'ضبط PID · بطاقة Dynamic Idle',
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 30},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '30', source: 'S1.10a–c'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: 'Failsafe · إجراء المرحلة 2',
        shot: 'failsafe', card: {text: 'إجراء المرحلة 2'},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: 'OSD · بطاقة التنبيهات',
        shot: 'osd-alarms', card: {text: 'التنبيهات'},
        fixture: {screen: 'osd', rssiDbm: -98},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-98 dBm', source: 'S1.3'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'racing', titleAr: 'السباق', titleEn: 'Racing',
    steps: [
      {
        n: 1, titleAr: 'المستقبل', screen: 'المستقبل · بطاقة تنعيم الإشارة',
        shot: 'receiver-smoothing', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 25, throttleFactor: 25, setpointCutoff: 0, throttleCutoff: 0},
        targets: [
          {testid: 'receiver-setpoint-factor', kind: 'stepper', expect: '25', source: 'S1.4'},
          {testid: 'receiver-throttle-factor', kind: 'stepper', expect: '25', source: 'S1.4'},
        ],
      },
      {
        n: 2, titleAr: 'إحساس العصا', screen: 'ضبط PID · بطاقة إحساس العصا',
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '3', source: 'S1.4'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '18', source: 'S1.4'},
          {testid: 'pid-ff-averaging-1', kind: 'option', expect: 'selected', source: 'S1.4'},
        ],
      },
      {
        n: 3, titleAr: 'المحركات', screen: 'المحركات · إعدادات ESC',
        shot: 'motors', card: 'motor-configuration-panel',
        fixture: {screen: 'motors', protocol: PROTOCOL.DSHOT600, poles: 14, bidir: 1},
        targets: [
          {testid: 'motor-config-protocol-7', kind: 'option', expect: 'selected', source: 'S1.9'},
          {testid: 'motor-config-bidirectional-dshot', kind: 'switch', expect: 'on', source: 'S1.9'},
        ],
      },
      {
        n: 4, titleAr: 'Dynamic Idle', screen: 'ضبط PID · بطاقة Dynamic Idle',
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 40},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '40', source: 'S1.9'}],
      },
      {
        n: 5, titleAr: 'Failsafe', screen: 'Failsafe · إجراء المرحلة 2',
        shot: 'failsafe', card: {text: 'إجراء المرحلة 2'},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
      {
        n: 6, titleAr: 'OSD', screen: 'OSD · بطاقة التنبيهات',
        shot: 'osd-alarms', card: {text: 'التنبيهات'},
        fixture: {screen: 'osd', rssiDbm: -95},
        targets: [{testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-95 dBm', source: 'S1.4'}],
      },
      {
        n: 7, titleAr: 'مرسل الفيديو', screen: 'مرسل الفيديو · القناة والطاقة',
        shot: 'vtx', card: null,
        fixture: {screen: 'vtx'},
        targets: [],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'tiny-whoop', titleAr: 'الوووب والطيران الداخلي', titleEn: 'Tiny Whoop / Indoor',
    steps: [
      {
        n: 1, titleAr: 'المحركات', screen: 'المحركات · إعدادات ESC',
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
        n: 2, titleAr: 'Dynamic Idle', screen: 'ضبط PID · بطاقة Dynamic Idle',
        shot: 'dynamic-idle', card: 'pid-dynamic-idle',
        fixture: {screen: 'pid-feel', idle: 120, jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT},
        targets: [{testid: 'pid-idle-min-rpm', kind: 'stepper', expect: '120', source: 'S1.8'}],
      },
      {
        n: 3, titleAr: 'إحساس العصا', screen: 'ضبط PID · بطاقة إحساس العصا',
        shot: 'pid-feel', card: 'pid-feel',
        fixture: {screen: 'pid-feel', jitter: 3, boost: 18, averaging: AVERAGING.TWO_POINT, idle: 120},
        targets: [
          {testid: 'pid-ff-jitter', kind: 'stepper', expect: '3', source: 'S1.8'},
          {testid: 'pid-ff-boost', kind: 'stepper', expect: '18', source: 'S1.8'},
        ],
      },
      {
        n: 4, titleAr: 'الطاقة والبطارية', screen: 'الطاقة · حدود بطارية 1S',
        shot: 'power', card: {text: 'حدود البطارية'},
        fixture: {screen: 'power', cells: 1, min: 320, warn: 340, max: 445, capacity: 450, voltage: 415},
        targets: [
          {testid: 'power-cell-max', kind: 'stepper', expect: '4.45 V', source: 'S1.8'},
          {testid: 'power-capacity', kind: 'stepper', expect: '450 mAh', source: 'C'},
          {testid: 'power-live', kind: 'contains', expect: '1S', source: 'C'},
        ],
      },
      {
        n: 5, titleAr: 'منحنى الخانق', screen: 'ضبط PID · منحنى وحدّ الخانق',
        shot: 'throttle-curve', card: 'pid-throttle-rates',
        fixture: {screen: 'pid-feel', thrMid: 30, thrHover: 30, thrExpo: 65, idle: 120, jitter: 3, boost: 18},
        targets: [
          {testid: 'pid-throttle-mid', kind: 'stepper', expect: '30', source: 'S1.8'},
          {testid: 'pid-throttle-expo', kind: 'stepper', expect: '65', source: 'S1.8'},
          {testid: 'pid-throttle-hover', kind: 'stepper', expect: '30', source: 'S1.8'},
        ],
      },
      {
        n: 6, titleAr: 'Failsafe', screen: 'Failsafe · إجراء المرحلة 2',
        shot: 'failsafe', card: {text: 'إجراء المرحلة 2'},
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.DROP, rescue: 0},
        targets: [{testid: 'failsafe-procedure-1', kind: 'option', expect: 'selected', source: 'C'}],
      },
    ],
  },
  /* ================================================================= */
  {
    id: 'long-range', titleAr: 'المدى الطويل', titleEn: 'Long Range',
    steps: [
      {
        n: 1, titleAr: 'المنافذ', screen: 'المنافذ · منفذ GPS',
        shot: 'ports', card: null,
        fixture: {screen: 'ports'},
        targets: [{testid: 'ports-screen', kind: 'contains', expect: 'GPS / GNSS', source: 'C'}],
      },
      {
        n: 2, titleAr: 'المستقبل', screen: 'المستقبل · المصدر و RSSI',
        shot: 'receiver-cutoffs', card: 'receiver-smoothing-card',
        fixture: {screen: 'receiver', autoFactor: 30, throttleFactor: 30, setpointCutoff: 10, throttleCutoff: 15},
        targets: [
          {testid: 'receiver-setpoint-cutoff', kind: 'stepper', expect: '10', source: 'S1.5'},
          {testid: 'receiver-throttle-cutoff', kind: 'stepper', expect: '15', source: 'S1.5'},
        ],
      },
      {
        n: 3, titleAr: 'GPS', screen: 'GPS · التفعيل و Home والدقة',
        shot: 'gps', card: null,
        fixture: {screen: 'gps'},
        targets: [{testid: 'gps-screen', kind: 'contains', expect: 'UART2', source: 'C'}],
      },
      {
        n: 4, titleAr: 'GPS Rescue', screen: 'Failsafe · معاملات GPS Rescue',
        shot: 'gps-rescue', card: 'failsafe-gps-rescue',
        fixture: {screen: 'failsafe', procedure: FAILSAFE_PROCEDURE.GPS_RESCUE, rescue: 1},
        targets: [
          {testid: 'failsafe-gps-return-altitude', kind: 'stepper', expect: '30 م', source: 'S1.12d'},
          {testid: 'failsafe-gps-ground-speed', kind: 'stepper', expect: '7.5 م/ث', source: 'S1.12d'},
          {testid: 'failsafe-gps-descend-rate', kind: 'stepper', expect: '1.5 م/ث', source: 'S1.12d'},
          {testid: 'failsafe-gps-min-sats', kind: 'stepper', expect: '8', source: 'S1.12d'},
          {testid: 'failsafe-gps-allow-arming-0', kind: 'option', expect: 'selected', source: 'S1.12d'},
          {testid: 'failsafe-gps-allow-arming-1', kind: 'option', expect: 'not-selected', source: 'S1.12d'},
          {testid: 'failsafe-gps-sanity-2', kind: 'option', expect: 'selected', source: 'S1.12d'},
        ],
      },
      {
        n: 5, titleAr: 'الأوضاع', screen: 'الأوضاع · GPS Rescue على مفتاح',
        shot: 'modes', card: null,
        fixture: {screen: 'modes'},
        targets: [{testid: 'modes-screen', kind: 'contains', expect: 'GPS RESCUE', source: 'C'}],
      },
      {
        n: 6, titleAr: 'الطاقة والبطارية', screen: 'الطاقة · مثال 6S',
        shot: 'power', card: {text: 'حدود البطارية'},
        fixture: {screen: 'power', cells: 6, min: 330, warn: 350, max: 435, capacity: 1300, voltage: 2430},
        targets: [
          {testid: 'power-cell-warning', kind: 'stepper', expect: '3.50 V', source: 'C'},
          {testid: 'power-live', kind: 'contains', expect: '6S', source: 'C'},
        ],
      },
      {
        n: 7, titleAr: 'مرسل الفيديو', screen: 'مرسل الفيديو · الطاقة',
        shot: 'vtx', card: null,
        fixture: {screen: 'vtx'},
        targets: [],
      },
      {
        n: 8, titleAr: 'OSD', screen: 'OSD · إنذارات السلامة',
        shot: 'osd-alarms', card: {text: 'التنبيهات'},
        fixture: {screen: 'osd', rssiDbm: -100, lq: 60, capacity: 1100, altitude: 300},
        targets: [
          {testid: 'osd-rssi-dbm', kind: 'stepper', expect: '-100 dBm', source: 'C'},
          {testid: 'osd-lq', kind: 'stepper', expect: '60%', source: 'C'},
        ],
      },
      {
        n: 9, titleAr: 'إحساس العصا', screen: 'ضبط PID · بطاقة إحساس العصا',
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
    id: 'firmware', titleAr: 'البرنامج الثابت', titleEn: 'Firmware',
    steps: [
      {
        n: 1, titleAr: 'قبل التحديث', screen: 'تحديث البرنامج الثابت · اللوحة والبناء',
        shot: 'flasher', card: null,
        fixture: {screen: 'flasher'},
        targets: [{testid: 'firmware-flasher-screen', kind: 'not-contains', expect: 'القائمة غير متاحة', source: 'C'}],
      },
      {
        n: 2, titleAr: 'الحزم الجاهزة', screen: 'الحزم الجاهزة · المكتبة الرسمية',
        shot: 'presets', card: null,
        fixture: {screen: 'presets'},
        targets: [{testid: 'presets-screen', kind: 'contains', expect: 'الحزم المتوافقة (5)', source: 'S1'}],
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
export const REVIEW_DIR = 'docs/flight-guides/_shared/review';
export const PREVIEW = 'http://127.0.0.1:4182/index.html';
