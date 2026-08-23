/**
 * WHAT WAS BEING WRITTEN WHEN THE ANSWER STOPPED COMING BACK.
 *
 * THE DEFECT THIS CLOSES. Five screens rendered their internal write-group
 * identifier straight into Arabic copy at the single worst moment - an
 * UNCONFIRMED save, the one outcome where the operator MUST understand
 * what happened before touching anything else. A real board produced:
 *
 *     نتيجة الكتابة غير مؤكدة عند RXFAIL_CONFIG
 *     نتيجة BATTERY_CONFIG غير مؤكدة
 *     نتيجة كتابة POWER_LEVEL غير مؤكدة
 *
 * That is our source code quoted at a pilot. It tells them nothing about
 * which setting is now in doubt, and the whole point of reporting
 * UNCONFIRMED rather than swallowing it is that the operator can act on
 * it. FailsafeScreen's own header already described exactly this bug for
 * validation codes and fixed it there; the save path kept doing it.
 *
 * ONE VOCABULARY, NOT FIVE. A shared map instead of five inline ternaries
 * so the words a pilot reads for "the failsafe settings" are the same
 * wherever they appear, and so a new write group is a compile error here
 * rather than a raw token on screen.
 *
 * EEPROM IS THE INTERESTING CASE. It is not a settings group at all - it
 * is the persist step - and an unconfirmed EEPROM write means something
 * different from an unconfirmed settings write: the values may have
 * reached the board and simply not been committed. The copy says so.
 */

/** Every write group any settings screen can report, plus the persist step. */
export type WriteStageName =
  // Failsafe
  | 'FAILSAFE_CONFIG'
  | 'RXFAIL_CONFIG'
  | 'GPS_RESCUE'
  // Power
  | 'BATTERY_CONFIG'
  | 'VOLTAGE_METER_CONFIG'
  | 'CURRENT_METER_CONFIG'
  // OSD
  | 'GENERAL'
  | 'ELEMENT'
  | 'STATISTIC'
  | 'TIMER'
  // VTX
  | 'CONFIG'
  | 'BAND'
  | 'POWER_LEVEL'
  // PID
  | 'PID'
  | 'PID_ADVANCED'
  | 'RC_TUNING'
  | 'FILTER_CONFIG'
  | 'SIMPLIFIED'
  | 'COPY_PROFILE'
  | 'SELECT_PROFILE'
  | 'RESET_PID_PROFILE'
  | 'PROFILE_NAME'
  // The persist step every screen shares.
  | 'EEPROM';

/**
 * The operator-facing name of each stage.
 *
 * Phrased as "what setting", not "which command", because that is the
 * question the pilot is actually asking when a save comes back unsure.
 */
const STAGE_TEXT: Readonly<Record<WriteStageName, string>> = {
  FAILSAFE_CONFIG: 'إعدادات فقد الإشارة',
  RXFAIL_CONFIG: 'قيم القنوات عند فقد النبض',
  GPS_RESCUE: 'معاملات GPS Rescue',

  BATTERY_CONFIG: 'حدود البطارية',
  VOLTAGE_METER_CONFIG: 'معايرة مقياس الجهد',
  CURRENT_METER_CONFIG: 'معايرة مقياس التيار',

  GENERAL: 'إعدادات OSD العامة',
  ELEMENT: 'موضع عنصر على شاشة OSD',
  STATISTIC: 'إحصائيات ما بعد الرحلة',
  TIMER: 'مؤقتات OSD',

  CONFIG: 'إعدادات مرسل الفيديو',
  BAND: 'جدول النطاقات',
  POWER_LEVEL: 'مستويات الطاقة',

  PID: 'قيم PID',
  PID_ADVANCED: 'إعدادات PID المتقدمة',
  RC_TUNING: 'معدلات الحركة ومنحنى الخانق',
  FILTER_CONFIG: 'الفلاتر',
  SIMPLIFIED: 'شرائح الضبط المبسط',
  COPY_PROFILE: 'نسخ ملف الضبط',
  SELECT_PROFILE: 'تبديل الملف النشط',
  RESET_PID_PROFILE: 'إعادة ملف PID إلى قيم المصنع',
  PROFILE_NAME: 'اسم الملف',

  EEPROM: 'حفظ الإعدادات في ذاكرة المتحكم',
};

/**
 * A complete Arabic sentence for an unconfirmed write.
 *
 * `index` is the zero-based row a screen was writing when it applies -
 * an RXFAIL channel, an OSD element, a VTX band - and is rendered
 * one-based because that is how every one of those screens numbers them
 * for the operator.
 */
export function unconfirmedWriteMessage(stage: WriteStageName, index?: number): string {
  const what = STAGE_TEXT[stage];
  const row = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? ` رقم ${index + 1}` : '';
  if (stage === 'EEPROM') {
    // Not a settings group: the values may have arrived and simply not
    // been committed, which is a different thing to tell the operator.
    return 'وصلت الإعدادات إلى المتحكم لكن لم يتأكد حفظها بشكل دائم. لا تكرر الحفظ؛ أعد الاتصال واقرأ أولًا.';
  }
  return `لم تتأكد نتيجة كتابة ${what}${row}. لا تكرر الحفظ؛ أعد الاتصال واقرأ أولًا.`;
}
