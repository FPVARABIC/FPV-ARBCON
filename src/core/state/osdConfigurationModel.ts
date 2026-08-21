/* eslint-disable no-bitwise -- Betaflight defines the OSD wire layout as bit masks. */
import type {MspOsdSnapshot} from '../protocol/msp/decoding/decodeOsdConfiguration';

export const OSD_PROFILE_BITS_POSITION = 11;
export const OSD_PROFILE_MASK = 0x3800;
export const OSD_TYPE_MASK = 0xc000;
export const OSD_POSITION_MASK = 0x07ff;

export interface OsdConfigurationDraft {
  readonly videoSystem: number;
  readonly units: number;
  readonly rssiAlarmPercent: number;
  readonly capacityAlarmMah: number;
  readonly altitudeAlarm: number;
  readonly elementPositions: readonly number[];
  readonly statistics: readonly boolean[];
  readonly timers: readonly number[];
  readonly enabledWarnings: number;
  readonly selectedProfile: number;
  readonly overlayRadioMode: number;
  readonly cameraFrameWidth: number;
  readonly cameraFrameHeight: number;
  readonly linkQualityAlarmPercent: number;
  readonly rssiDbmAlarm: number;
}

export type OsdValidationCode = 'OSD_UNAVAILABLE' | 'GENERAL_INVALID' | 'PROFILE_INVALID' | 'ELEMENT_COUNT_CHANGED' | 'STATISTIC_COUNT_CHANGED' | 'TIMER_COUNT_CHANGED' | 'ELEMENT_INVALID' | 'TIMER_INVALID';

export function createOsdConfigurationDraft(snapshot: MspOsdSnapshot): OsdConfigurationDraft {
  const c = snapshot.config;
  return Object.freeze({
    videoSystem: c.videoSystem, units: c.units, rssiAlarmPercent: c.rssiAlarmPercent,
    capacityAlarmMah: c.capacityAlarmMah, altitudeAlarm: c.altitudeAlarm,
    elementPositions: Object.freeze([...c.elementPositions]), statistics: Object.freeze([...c.statistics]),
    timers: Object.freeze([...c.timers]), enabledWarnings: c.enabledWarnings,
    selectedProfile: c.selectedProfile, overlayRadioMode: c.overlayRadioMode,
    cameraFrameWidth: c.cameraFrameWidth, cameraFrameHeight: c.cameraFrameHeight,
    linkQualityAlarmPercent: c.linkQualityAlarmPercent, rssiDbmAlarm: c.rssiDbmAlarm,
  });
}

export function osdDraftsEqual(a: OsdConfigurationDraft, b: OsdConfigurationDraft): boolean {return JSON.stringify(a) === JSON.stringify(b);}
export function osdSnapshotsEqual(a: MspOsdSnapshot, b: MspOsdSnapshot): boolean {return JSON.stringify(a) === JSON.stringify(b);}

export function osdPositionX(value: number): number {return (value & 0x1f) | ((value & 0x400) >>> 5);}
export function osdPositionY(value: number): number {return (value >>> 5) & 0x1f;}
export function osdElementType(value: number): number {return (value & OSD_TYPE_MASK) >>> 14;}
export function osdVisibleInProfile(value: number, profile: number): boolean {return profile >= 1 && profile <= 3 && (value & (1 << (profile - 1 + OSD_PROFILE_BITS_POSITION))) !== 0;}

export function setOsdPosition(value: number, x: number, y: number): number {
  const position = (x & 0x1f) | ((x << 5) & 0x400) | ((y & 0x1f) << 5);
  return ((value & ~OSD_POSITION_MASK) | position) & 0xffff;
}

export function setOsdProfileVisibility(value: number, profile: number, visible: boolean): number {
  if (profile < 1 || profile > 3) return value;
  const mask = 1 << (profile - 1 + OSD_PROFILE_BITS_POSITION);
  return visible ? (value | mask) & 0xffff : value & ~mask;
}

export function validateOsdDraft(draft: OsdConfigurationDraft, snapshot: MspOsdSnapshot): readonly OsdValidationCode[] {
  const issues: OsdValidationCode[] = [];
  const ints = [draft.videoSystem, draft.units, draft.rssiAlarmPercent, draft.capacityAlarmMah, draft.altitudeAlarm, draft.enabledWarnings, draft.selectedProfile, draft.overlayRadioMode, draft.cameraFrameWidth, draft.cameraFrameHeight, draft.linkQualityAlarmPercent, draft.rssiDbmAlarm];
  if ((snapshot.config.flags & 1) === 0) issues.push('OSD_UNAVAILABLE');
  if (!ints.every(Number.isInteger) || draft.videoSystem < 0 || draft.videoSystem > 3 || draft.units < 0 || draft.units > 2 || draft.rssiAlarmPercent < 0 || draft.rssiAlarmPercent > 100 || draft.capacityAlarmMah < 0 || draft.capacityAlarmMah > 65535 || draft.altitudeAlarm < 0 || draft.altitudeAlarm > 65535 || draft.overlayRadioMode < 0 || draft.overlayRadioMode > 255 || draft.cameraFrameWidth < 2 || draft.cameraFrameWidth > 30 || draft.cameraFrameHeight < 2 || draft.cameraFrameHeight > 16 || draft.linkQualityAlarmPercent < 0 || draft.linkQualityAlarmPercent > 100 || draft.rssiDbmAlarm < -130 || draft.rssiDbmAlarm > 0) issues.push('GENERAL_INVALID');
  if (draft.selectedProfile < 1 || draft.selectedProfile > Math.max(1, snapshot.config.profileCount)) issues.push('PROFILE_INVALID');
  if (draft.elementPositions.length !== snapshot.config.elementPositions.length) issues.push('ELEMENT_COUNT_CHANGED');
  if (draft.statistics.length !== snapshot.config.statistics.length) issues.push('STATISTIC_COUNT_CHANGED');
  if (draft.timers.length !== snapshot.config.timers.length) issues.push('TIMER_COUNT_CHANGED');
  if (draft.elementPositions.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) issues.push('ELEMENT_INVALID');
  if (draft.timers.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) issues.push('TIMER_INVALID');
  return Object.freeze([...new Set(issues)]);
}

/**
 * EVERY OSD ELEMENT BETAFLIGHT DEFINES, IN THE FIRMWARE'S OWN ORDER.
 *
 * =====================================================================
 * WHY THE ORDER IS THE WHOLE CONTRACT
 * =====================================================================
 *
 * MSP_OSD_CONFIG carries element positions POSITIONALLY - a bare array
 * of uint16 with no identifiers in it. Index N in that array IS
 * `osd_items_e` entry N in the firmware, and nothing on the wire says
 * so. A table that is off by one therefore does not fail, it MISLABELS:
 * the operator drags what the screen calls "RSSI dBm" and the flight
 * controller moves something else entirely, with no error anywhere.
 *
 * So this table is pinned against the firmware enum by
 * osdElementAuthenticity.test.ts, which fails the build if an entry is
 * inserted, removed or reordered relative to
 * betaflight/src/main/osd/osd.h.
 *
 * VERIFIED AGAINST, on 2026-08-21:
 *   betaflight/betaflight  src/main/osd/osd.h  `osd_items_e`
 *     (indices 0-87 are unconditional; 88+ sit behind USE_GPS/
 *      ENABLE_FLIGHT_PLAN, USE_OSD_NAV_MAP and USE_POSITION_HOLD and are
 *      deliberately NOT listed - a build without those compile flags
 *      would shift every entry after them)
 *   betaflight/betaflight-configurator
 *     src/components/tabs/osd/osd.js  OSD.constants.DISPLAY_FIELDS
 *     ("DISPLAY_FIELDS order must mirror firmware's osd_items_e enum
 *      order. decode() maps wire position N to DISPLAY_FIELDS[N]
 *      positionally.")
 *
 * Index 50 is PILOT_NAME, not DISPLAY_NAME: the Configurator selects
 * between them by API version at that ONE slot, and this application's
 * floor is API 1.47 (betaflightApiFloor.ts), so PILOT_NAME is the only
 * reachable answer.
 *
 * =====================================================================
 * THESE ARE NAMES, NOT READINGS
 * =====================================================================
 *
 * Nothing in this table is telemetry. The flight controller renders
 * every OSD VALUE itself, from its own sensors - this application only
 * decides which element is switched on and which character cell it
 * occupies. See OSD_ELEMENT_TOKENS below, and
 * osdPreviewIsolation.test.ts, which fails the build if the OSD surface
 * ever acquires a telemetry source.
 */
export const OSD_ELEMENT_NAMES_AR: readonly string[] = Object.freeze([
  'قوة الإشارة RSSI', 'جهد البطارية', 'علامة المنتصف', 'الأفق الاصطناعي', 'جوانب الأفق',
  'المؤقت 1', 'المؤقت 2', 'وضع الطيران', 'اسم الطائرة', 'الخانق', 'قناة VTX', 'التيار',
  'السعة المستهلكة', 'سرعة GPS', 'أقمار GPS', 'الارتفاع', 'PID Roll', 'PID Pitch', 'PID Yaw',
  'القدرة', 'ملف المعدلات', 'التحذيرات', 'متوسط جهد الخلية', 'خط طول GPS', 'خط عرض GPS',
  'Debug', 'زاوية Pitch', 'زاوية Roll', 'استخدام البطارية', 'DISARMED', 'اتجاه المنزل', 'المسافة للمنزل',
  'الاتجاه الرقمي', 'معدل الصعود', 'شريط البوصلة', 'حرارة ESC', 'RPM المحرك', 'الوقت المتبقي',
  'التاريخ والوقت', 'نطاق الضبط', 'حرارة المتحكم', 'Anti Gravity', 'قوة G', 'تشخيص المحركات',
  'حالة السجل', 'سهم القلب', 'جودة الرابط', 'مسافة الرحلة', 'عصي التحكم اليسرى', 'عصي التحكم اليمنى',
  'اسم الطيار', 'تردد RPM', 'اسم ملف المعدلات', 'اسم ملف PID', 'اسم ملف OSD', 'RSSI dBm',
  'قنوات RC', 'إطار الكاميرا', 'الكفاءة', 'إجمالي الرحلات', 'مرجع أعلى/أسفل', 'قدرة إرسال الرابط',
  'واط-ساعة مستهلكة', 'قيمة AUX', 'وضع الجاهزية', 'RSNR', 'جهد النظارة', 'جهد VTX', 'معدل البت',
  'تأخير الفيديو', 'مسافة النظام', 'جودة رابط النظام', 'DVR النظارة', 'DVR VTX', 'تحذيرات النظام',
  'حرارة VTX', 'سرعة المروحة',
  'زمن اللفة الحالية', 'زمن اللفة السابقة', 'أفضل ثلاث لفات',
  'Debug 2', 'رسالة مخصصة 1', 'رسالة مخصصة 2', 'رسالة مخصصة 3', 'رسالة مخصصة 4', 'مسافة الليدار',
  'نص تسلسلي مخصص', 'اسم ملف البطارية',
]);

export function osdElementName(index: number): string {return OSD_ELEMENT_NAMES_AR[index] ?? `عنصر OSD ${index + 1}`;}

/**
 * The short ASCII token the PREVIEW draws for each element.
 *
 * WHY A TOKEN AND NOT A VALUE. The preview exists to answer "where will
 * this sit over my video", so each element has to occupy roughly the
 * cells it will really occupy - a name in Arabic script is neither the
 * right width nor the right script for a MAX7456/HD character grid. What
 * it must NOT do is invent a reading: showing "16.8V" would be fabricated
 * telemetry from a flight controller that has told us nothing of the
 * kind. Each token therefore NAMES the element in the same technical
 * vocabulary the firmware uses, and its length is what sets the element's
 * preview width in character cells.
 *
 * Same index basis as OSD_ELEMENT_NAMES_AR - an index the firmware
 * reports beyond this table gets a neutral token rather than a guess.
 */
export const OSD_ELEMENT_TOKENS: readonly string[] = Object.freeze([
  'RSSI', 'VBAT', 'CROSS', 'HORIZON', 'SIDES',
  'TIMER1', 'TIMER2', 'MODE', 'CRAFT', 'THR', 'VTX', 'CURR',
  'MAH', 'GPS SPD', 'GPS SATS', 'ALT', 'PID R', 'PID P', 'PID Y',
  'PWR', 'RATE', 'WARN', 'CELL V', 'GPS LON', 'GPS LAT',
  'DEBUG', 'PITCH', 'ROLL', 'BAT %', 'DISARMED', 'HOME DIR', 'HOME DIST',
  'HEADING', 'VARIO', 'COMPASS', 'ESC TEMP', 'ESC RPM', 'TIME LEFT',
  'DATE TIME', 'ADJUST', 'CORE T', 'ANTIGRAV', 'G-FORCE', 'MOTORS',
  'LOG', 'FLIP', 'LQ', 'FLT DIST', 'STICKS L', 'STICKS R',
  'PILOT', 'RPM FRQ', 'RATE NAME', 'PID NAME', 'OSD PROF', 'RSSI dBm',
  'RC CH', 'CAM FRAME', 'EFFIC', 'FLIGHTS', 'UP/DOWN', 'TX PWR',
  'WATT H', 'AUX', 'READY', 'RSNR', 'SYS VBAT', 'VTX V', 'BITRATE',
  'DELAY', 'SYS DIST', 'SYS LQ', 'GOG DVR', 'VTX DVR', 'SYS WARN',
  'VTX TEMP', 'FAN',
  // 77-79: osd.h OSD_GPS_LAP_TIME_* (API 1.46)
  'LAP NOW', 'LAP PREV', 'LAP BEST3',
  // 80-85: osd.h OSD_DEBUG2 .. OSD_LIDAR_DIST (API 1.47)
  'DEBUG2', 'MSG 1', 'MSG 2', 'MSG 3', 'MSG 4', 'LIDAR',
  // 86-87: osd.h OSD_CUSTOM_SERIAL_TEXT, OSD_BATTERY_PROFILE_NAME (API 1.48)
  'SER TEXT', 'BATT PROF',
]);

export function osdElementToken(index: number): string {return OSD_ELEMENT_TOKENS[index] ?? `EL${index + 1}`;}
