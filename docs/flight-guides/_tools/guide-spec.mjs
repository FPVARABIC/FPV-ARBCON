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
        n: 7, titleAr: 'مرسل الفيديو — قناتك ووضع الانتظار',
        screen: 'مرسل الفيديو · القناة والطاقة',
        shot: 'vtx', card: {text: 'القناة والطاقة'},
        fixture: {screen: 'vtx', band: 5, channel: 1, power: 1, pit: 1},
        note: 'في السباق **النطاق والقناة ليسا اختيارك**، بل ما يخصصه لك المنظّم — واللقطة تعرض `Raceband` كمثال على ذلك، لا كتوصية. الحقل الذي يخصّك فعلًا هو **Pit Mode**: مفعّل هنا، أي أن المرسل صامت وأنت على خط الانطلاق، فلا تفسد فيديو من يطير الآن. أطفئه عند دورك. الجدول كله مقروء من متحكم الطيران، فما تراه هو ما يدعمه مرسلك أنت.',
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
        n: 7, titleAr: 'مرسل الفيديو — الطاقة ومستوياتها الحقيقية',
        screen: 'مرسل الفيديو · القناة والطاقة',
        shot: 'vtx', card: {text: 'القناة والطاقة'},
        fixture: {screen: 'vtx', band: 1, channel: 1, power: 4, lowPower: 1},
        note: '**لا رقم رسمي هنا، والقانون هو من يقرر.** ما تعرضه اللقطة هو **أعلى مستوى يعلنه هذا المرسل** (600) — لتعرف أين تقرأ المستويات المتاحة على عتادك، لا لتنسخ الرقم. القاعدة الوحيدة في هذا الدليل: أعلى طاقة **تسمح بها قوانين مكانك**، لا أعلى طاقة موجودة.\n\nومفعَّل هنا أيضًا **طاقة منخفضة عند DISARM**: المدى الطويل يعني وقتًا طويلًا مسلَّحًا وطاقة عالية، فخفض الطاقة تلقائيًا بعد نزع التسليح يقلّل حرارة المرسل وأنت واقف. `[C]`',
        targets: [
          {testid: 'vtx-power-4', kind: 'option', expect: 'selected', source: 'C'},
          {testid: 'vtx-low-power-1', kind: 'option', expect: 'selected', source: 'C'},
        ],
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
        /* The board is CHOSEN in this picture, and the build options are
         * on screen. The earlier capture's subject was an empty USB bus
         * and a not-yet-configured build - a picture of nothing having
         * happened yet, which taught the reader nothing. */
        n: 1, titleAr: 'اللوحة والإصدار وخيارات البناء',
        screen: 'تحديث البرنامج الثابت · المرحلة 1: اللوحة والبناء',
        shot: 'flasher-board', card: null,
        prepare: [
          {click: 'target-selector'},
          {click: 'target-SPEEDYBEEF405V3', settle: 900},
          {click: 'release-selector'},
          {click: 'release-4.6.0', settle: 1200},
        ],
        note: 'الشاشة مرحلتان: **1 اللوحة والبناء**، ثم **2 التحقق والتفليش**. لا تنتقل إلى الثانية قبل أن تختار لوحة وإصدارًا.\n\nفي اللقطة اللوحة مختارة (`SPEEDYBEEF405V3`) والإصدار مختار (`4.6.0`)، ولهذا ظهرت **تهيئة البناء**: بروتوكول الراديو و Telemetry و OSD والمحركات. **هذه هي الخطوة التي تقرر ما سيوجد في لوحتك بعد التحديث** — ما لا تختاره هنا لن يكون موجودًا مهما بحثت عنه لاحقًا في الإعدادات.',
        fixture: {screen: 'flasher'},
        targets: [
          {testid: 'target-selector', kind: 'contains', expect: 'SPEEDYBEEF405V3', source: 'C'},
          {testid: 'release-selector', kind: 'contains', expect: '4.6.0', source: 'C'},
          {testid: 'build-configuration', kind: 'contains', expect: 'بروتوكول الراديو', source: 'C'},
          {testid: 'radio-protocol-selector', kind: 'contains', expect: 'CRSF', source: 'C'},
        ],
      },
      {
        /* The corner shouts "never flash with props on" in its warnings.
         * Until now it never showed where the app makes you say so. */
        n: 2, titleAr: 'بوابة الأمان قبل التفليش',
        screen: 'تحديث البرنامج الثابت · المرحلة 2 · بطاقة بوابة الأمان',
        shot: 'flasher-safety', card: {text: 'بوابة الأمان', min: 2},
        prepare: [
          {click: 'firmware-step-flash', settle: 700},
          {click: 'confirm-props-removed'},
          {click: 'confirm-usb-power-only'},
        ],
        note: 'المفتاحان في هذه البطاقة ليسا تذكيرًا — التفليش لا يبدأ قبل تفعيلهما، ولا تُتجاوَز البطاقة ضمنيًا حتى مع «Flash on connect». فعّلهما بعد أن تفعل ما يقولانه، لا قبله.',
        fixture: {screen: 'flasher'},
        targets: [
          {testid: 'confirm-props-removed', kind: 'switch', expect: 'on', source: 'C'},
          {testid: 'confirm-usb-power-only', kind: 'switch', expect: 'on', source: 'C'},
        ],
      },
      {
        n: 3, titleAr: 'الحزم الجاهزة', screen: 'الحزم الجاهزة · المكتبة الرسمية',
        shot: 'presets', card: null,
        note: 'لاحظ **الحزم المتوافقة (5)** — العدد ليس كل ما في المكتبة، بل ما يوافق إصدار **لوحتك أنت**، والإصدار مقروء من المتحكم لا مكتوب يدويًا. وسم «رسمية» بجانب كل حزمة هو حالة `OFFICIAL`.',
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
export const PREVIEW = 'http://127.0.0.1:4182/index.html';

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
    {what: 'ترددا القطع (setpoint · الخانق)', kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: 'اتركهما 0 — أي «تلقائي». الإعداد السينمائي الرسمي يضبط المعاملين التلقائيين ولا يلمس ترددي القطع.'},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: 'لا توجد Rates رسمية للسينمائي. اختر ملفًا أبطأ من ملفك المعتاد وارفع expo قليلًا لتنعيم المنتصف — ولا نفرض رقمًا واحدًا لهذا النمط.'},
    {what: 'قيم PID (P · I · D)', kind: 'KEEP_DEFAULT', source: 'S1.1',
     detail: 'الإعدادان السينمائيان الرسميان لا يلمسان P أو I أو D إطلاقًا. النعومة تأتي من إحساس العصا والتنعيم، لا من خفض PID.'},
    {what: 'الفلاتر (Gyro LPF · D-term LPF · Dynamic Notch)', kind: 'KEEP_DEFAULT', source: 'S1.11a',
     detail: 'اتبع ضبط منصتك. القيم المرجعية للسينمائي (سقف 750Hz لـ Cinelog، أدنى 125Hz لبناء نظيف) في قسم «اختياري»، والتطبيق لا يعدّلها إلا إذا أثبتت القراءة أن الميزة نشطة.'},
    {what: 'الأوضاع (Modes)', kind: 'PILOT_PREFERENCE',
     detail: 'مفتاح ARM إلزامي ويُضبط مرة واحدة لكل طائرة. ما بعده — Angle أو Beeper أو Turtle — تفضيلك.'},
    {what: 'الطاقة والبطارية', kind: 'PILOT_PREFERENCE',
     detail: 'لا توجد حدود بطارية «سينمائية». اضبطها على حزمتك أنت: عدد الخلايا، وتحذير الخلية، والسعة.'},
    {what: 'مرسل الفيديو (VTX)', kind: 'NOT_APPLICABLE',
     detail: 'لا يغيّره هذا النمط. اضبط القناة والطاقة مرة واحدة حسب مكانك وقوانينه.'},
    {what: '`thrust_linear`', kind: 'NOT_APPLICABLE', source: 'S1.11a',
     detail: 'يضبطه الإعداد الرسمي حسب تردد ESC (0 عند 24k · 20 عند 48k · 40 عند 96k)، ولا يعرضه هذا التطبيق. يُضبط من سطر الأوامر أو بتطبيق الحزمة.'},
  ],
  freestyle: [
    {what: 'ترددا القطع (setpoint · الخانق)', kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: 'اتركهما 0 — أي «تلقائي». إعداد الحر الرسمي يضبط المعاملين التلقائيين فقط.'},
    {what: 'Rates', kind: 'PILOT_PREFERENCE', source: 'S1.10b',
     detail: 'المكتبة الرسمية تعرض ثلاثة ملفات للنمط نفسه، وهذا في ذاته الجواب: لا يوجد رقم صحيح واحد. الخيارات الرسمية — RC rate 2 / expo 40 / super 80 · أو 3 / 35 / 105 · أو 25 / 45 / 108. ابدأ من الأول وارفع تدريجيًا.'},
    {what: 'قيم PID (P · I · D)', kind: 'KEEP_DEFAULT', source: 'S1.3',
     detail: 'إعداد الحر الرسمي للرابط لا يلمس P أو I أو D. حزم الضبط تستعمل منزلقات simplified التي لا يعرضها التطبيق؛ لا تعدّل القيم يدويًا لملاحقتها.'},
    {what: 'الفلاتر (Gyro LPF · D-term LPF · Dynamic Notch)', kind: 'KEEP_DEFAULT', source: 'S1.10b',
     detail: 'اتبع ضبط مقاسك. القيم المرجعية (سقف 400Hz وأدنى 90Hz لمقاس 3–5") في قسم «اختياري».'},
    {what: 'الأوضاع (Modes)', kind: 'PILOT_PREFERENCE',
     detail: 'مفتاح ARM إلزامي. Airmode و Turtle و Beeper تفضيلك.'},
    {what: 'الطاقة والبطارية', kind: 'PILOT_PREFERENCE',
     detail: 'اضبطها على حزمتك: عدد الخلايا وتحذير الخلية والسعة. لا قيمة «حرة» رسمية.'},
    {what: 'مرسل الفيديو (VTX)', kind: 'NOT_APPLICABLE',
     detail: 'لا يغيّره هذا النمط. اضبطه مرة واحدة حسب مكانك.'},
    {what: '`thrust_linear`', kind: 'NOT_APPLICABLE', source: 'S1.10b',
     detail: '30 لمقاس 5" · 40 لمقاس 3–4" · 10 لمقاس 7" في الإعداد الرسمي، ولا يعرضه هذا التطبيق.'},
  ],
  racing: [
    {what: 'ترددا القطع (setpoint · الخانق)', kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: 'اتركهما 0. إعداد السباق الرسمي يخفض المعاملين التلقائيين إلى 25 بدل استعمال ترددات قطع ثابتة.'},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: 'لا توجد Rates رسمية باسم «سباق». المكتبة تعرض ملفات مؤلفين كخيارات لا كقاعدة. المبدأ: expo أقل من الحر، لأن الدقة حول المنتصف أهم من مدى الطرف — والرقم يبقى اختيارك.'},
    {what: 'قيم PID (P · I · D)', kind: 'KEEP_DEFAULT', source: 'S1.9',
     detail: 'إعداد السباق الرسمي يضبط PID عبر منزلقات simplified ثم `simplified_tuning apply`، وهي غير معروضة في التطبيق. لا تحاكِ النتيجة بتعديل P/I/D يدويًا.'},
    {what: 'الفلاتر (Gyro LPF · D-term LPF · Dynamic Notch)', kind: 'KEEP_DEFAULT', source: 'S1.9',
     detail: 'اتبع حزمة الضبط. القيم المرجعية (سقف 650Hz، أدنى 125Hz لبناء نظيف) في قسم «اختياري».'},
    {what: 'الأوضاع (Modes)', kind: 'PILOT_PREFERENCE',
     detail: 'مفتاح ARM إلزامي. Turtle مفيد في السباق؛ بقية الأوضاع تفضيلك.'},
    {what: 'الطاقة والبطارية', kind: 'PILOT_PREFERENCE',
     detail: 'اضبطها على حزمتك. السباق لا يفرض حدود بطارية، لكن تحذير الخلية يجب أن يصلك قبل نهاية اللفة لا بعدها.'},
    {what: '`thrust_linear` · `tpa_*`', kind: 'NOT_APPLICABLE', source: 'S1.9',
     detail: 'يضبطهما الإعداد الرسمي (thrust_linear 20 · tpa_rate 70 · tpa_breakpoint 1250) ولا يعرضهما هذا التطبيق.'},
  ],
  'tiny-whoop': [
    {what: 'المستقبل · تنعيم الإشارة', kind: 'KEEP_DEFAULT', source: 'S1.13',
     detail: 'إعداد الوووب الرسمي **لا يضمّن** ملف الرابط، فالتنعيم يبقى على أصله: معاملان تلقائيان 30/30 وترددا قطع 0. لا تغيّرهما لهذا النمط.'},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: 'الإعداد الرسمي يعرض ملف rates كخيار غير معلَّم، لا كقاعدة. الوووب يميل إلى yaw أعلى لأن دورانه بطيء بطبعه — والرقم اختيارك.'},
    {what: 'قيم PID (P · I · D)', kind: 'KEEP_DEFAULT', source: 'S1.8',
     detail: 'إعداد الوووب الرسمي يضبط PID عبر منزلقات simplified، وهي غير معروضة في التطبيق. لا تعدّل P/I/D يدويًا.'},
    {what: 'الفلاتر', kind: 'KEEP_DEFAULT', source: 'S1.8',
     detail: 'الإعداد الرسمي يطفئ Gyro LPF1 و Dynamic Notch ويعتمد على فلتر RPM وحده. لا يسمح التطبيق بتفعيل أو تعطيل Dynamic Notch، وهذا هو السلوك الصحيح هنا.'},
    {what: 'وضع الطيران: Acro · Angle · Horizon', kind: 'PILOT_PREFERENCE',
     detail: '**Acro صحيح تمامًا للوووب، وليس Angle إلزاميًا.** Angle مساعدة تعلّم مفيدة داخل الغرف؛ ضعها على مفتاح إن أردت الرجوع إليها، أو اتركها.'},
    {what: 'Airmode', kind: 'PILOT_PREFERENCE', source: 'S1.8',
     detail: 'الإعداد الرسمي يقول إن إطفاءه أفضل أداءً في الطيران الداخلي، ويعرض ذلك كخيار غير معلَّم. للأكروبات في مساحة كبيرة، ضعه على مفتاح.'},
    {what: 'تعويض هبوط الجهد (`vbat_sag_compensation`)', kind: 'NOT_APPLICABLE', source: 'S1.8',
     detail: 'موصى به في الإعداد الرسمي (خيار معلَّم، القيمة 100) لأن خلية 1S تهبط بشدة تحت الحمل — لكن **هذا التطبيق لا يعرضه**. يُضبط من سطر الأوامر أو بتطبيق الحزمة الرسمية.'},
    {what: 'OSD', kind: 'PILOT_PREFERENCE',
     detail: 'لا يوجد رقم رسمي للوووب. إن كان لديك OSD، ابدأ من إنذار RSSI dBm عند −98 وعدّله بعد رحلة داخل مبناك — الجدران تغيّر الرقم أكثر من النمط.'},
    {what: 'مرسل الفيديو (VTX)', kind: 'PILOT_PREFERENCE',
     detail: 'الطيران الداخلي لا يحتاج طاقة عالية؛ ابدأ من أقل مستوى يعطيك صورة نظيفة.'},
    {what: '`cpu_late_limit_permille`', kind: 'NOT_APPLICABLE', source: 'S1.8',
     detail: 'يضبطه الإعداد الرسمي عند 15، ولا يعرضه التطبيق. غيابه لا يمنع الطيران.'},
  ],
  'long-range': [
    {what: 'المحركات و Dynamic Idle', kind: 'ACTION', source: 'S1.10c',
     detail: 'فعّل Bidirectional DShot، واضبط عدد الأقطاب على محركك، واضبط Dynamic Idle على **30** (×100 rpm) لمقاس 7". من شاشة المحركات وشاشة ضبط PID.'},
    {what: 'Rates', kind: 'PILOT_PREFERENCE',
     detail: 'لا توجد Rates رسمية للمدى الطويل. المبدأ: أبطأ من ملفك المعتاد — أنت تطير في خط مستقيم طويلًا لا تنعطف بحدة. والرقم اختيارك.'},
    {what: 'قيم PID (P · I · D)', kind: 'KEEP_DEFAULT', source: 'S1.5',
     detail: 'إعداد المدى الطويل الرسمي يغيّر إحساس العصا والتنعيم فقط، ولا يلمس P أو I أو D.'},
    {what: 'الفلاتر', kind: 'KEEP_DEFAULT', source: 'S1.10c',
     detail: 'اتبع ضبط مقاسك. القيمة المرجعية لمقاس 7" هي أدنى فلتر ديناميكي 40Hz، لأن الهيكل الطويل يرنّ عند تردد أخفض.'},
    {what: 'قراءة جودة الرابط (LQ) و RSSI بوحدة dBm', kind: 'NOT_APPLICABLE',
     detail: '**غير موجودتين في عقد MSP إطلاقًا**، فلا يستطيع أي تطبيق MSP عرضهما حيًّا. تراهما في نظارتك عبر OSD؛ التطبيق يضبط عتبة الإنذار فقط (الخطوة 8).'},
    {what: 'نوع التثبيت (2D/3D) و HDOP/VDOP', kind: 'NOT_APPLICABLE',
     detail: 'بروتوكول الاتصال مع المتحكم يرسل **بت تثبيت واحدًا و PDOP وحده** — لا 2D/3D ولا HDOP/VDOP. التطبيق يعرض PDOP بالاسم الصحيح ولا يخترع بديلًا. اسم الأمر نفسه في `_meta/sources.md` § S2.2.'},
  ],
  firmware: [
    {what: 'إعدادات الطيران', kind: 'NOT_APPLICABLE',
     detail: 'هذه ليست بطاقة نمط طيران. بعد التحديث، افتح ركن نمطك واتبعه من خطوته الأولى.'},
    {what: 'النسخة الاحتياطية قبل التحديث', kind: 'ACTION',
     detail: 'فعّل خيار النسخ الاحتياطي قبل بدء التفليش. التحديث يمسح كل إعداداتك، بما فيها Failsafe و GPS Rescue والمعايرة.'},
    {what: 'ترتيب ما بعد التحديث', kind: 'ACTION',
     detail: 'المنافذ ← المستقبل ← المحركات ← الأوضاع (مفتاح ARM أولًا) ← Failsafe ← ثم دليل نمطك.'},
  ],
};
