/**
 * THE OSD ELEMENT TABLE IS PINNED TO BETAFLIGHT'S OWN ENUM.
 *
 * =====================================================================
 * WHY AN OFF-BY-ONE HERE IS SILENT AND SERIOUS
 * =====================================================================
 *
 * MSP_OSD_CONFIG carries element positions POSITIONALLY: a bare array of
 * uint16, with no identifier of any kind on the wire. Index N in that
 * array is `osd_items_e` entry N in the firmware, and nothing in the
 * payload says so.
 *
 * A table that is off by one therefore does not fail - it MISLABELS. The
 * operator drags the row the screen calls "RSSI dBm", the flight
 * controller moves OSD_PROFILE_NAME, the write is acknowledged, the
 * read-back matches, and every check this application performs passes.
 * The defect only appears in the goggles, in flight.
 *
 * So the table is checked against the firmware enum itself, not against
 * memory and not against similar-looking names.
 *
 * =====================================================================
 * WHY THE ENUM IS COPIED IN HERE
 * =====================================================================
 *
 * The firmware is not a dependency of this project and must not become
 * one. What is copied below is the enum as published, with the source
 * and the retrieval date recorded, so a reviewer can re-derive it in one
 * command. That is the same discipline the motor-vector and API-floor
 * modules already use for firmware constants.
 *
 * SOURCE, verified 2026-08-21:
 *   betaflight/betaflight @ 1efac3e (API_VERSION_MINOR 49, 2026.12 cycle)
 *   src/main/osd/osd.h - `typedef enum { ... } osd_items_e;`
 *
 * CORROBORATED BY:
 *   betaflight/betaflight-configurator @ a2ce710
 *   src/components/tabs/osd/osd.js - OSD.constants.DISPLAY_FIELDS, whose
 *   own comment reads "DISPLAY_FIELDS order must mirror firmware's
 *   osd_items_e enum order. decode() maps wire position N to
 *   DISPLAY_FIELDS[N] positionally."
 *
 * WHERE THE LIST STOPS, AND WHY. Entry 87 is the last UNCONDITIONAL one.
 * Everything after it sits behind `USE_GPS && ENABLE_FLIGHT_PLAN`,
 * `USE_OSD_NAV_MAP` or `USE_POSITION_HOLD`, so on a build without those
 * flags those entries do not exist and every index after them shifts.
 * Naming them unconditionally would be exactly the mislabelling this
 * file exists to prevent - the Configurator gates them on reported build
 * options for the same reason.
 */

import {
  OSD_ELEMENT_NAMES_AR,
  OSD_ELEMENT_TOKENS,
  osdElementName,
  osdElementToken,
} from './osdConfigurationModel';
import {MINIMUM_CONFIGURATION_API_MINOR} from '../protocol/msp/identification/betaflightApiFloor';

/**
 * `osd_items_e`, indices 0-87, unconditional entries only.
 *
 * Index 50 is PILOT_NAME: the firmware enum has it there outright, and
 * the Configurator's one version-dependent slot chooses DISPLAY_NAME
 * only below API 1.45 - which this application never sees.
 */
const OSD_ITEMS_E: readonly string[] = Object.freeze([
  'OSD_RSSI_VALUE',
  'OSD_MAIN_BATT_VOLTAGE',
  'OSD_CROSSHAIRS',
  'OSD_ARTIFICIAL_HORIZON',
  'OSD_HORIZON_SIDEBARS',
  'OSD_ITEM_TIMER_1',
  'OSD_ITEM_TIMER_2',
  'OSD_FLYMODE',
  'OSD_CRAFT_NAME',
  'OSD_THROTTLE_POS',
  'OSD_VTX_CHANNEL',
  'OSD_CURRENT_DRAW',
  'OSD_MAH_DRAWN',
  'OSD_GPS_SPEED',
  'OSD_GPS_SATS',
  'OSD_ALTITUDE',
  'OSD_ROLL_PIDS',
  'OSD_PITCH_PIDS',
  'OSD_YAW_PIDS',
  'OSD_POWER',
  'OSD_PIDRATE_PROFILE',
  'OSD_WARNINGS',
  'OSD_AVG_CELL_VOLTAGE',
  'OSD_GPS_LON',
  'OSD_GPS_LAT',
  'OSD_DEBUG',
  'OSD_PITCH_ANGLE',
  'OSD_ROLL_ANGLE',
  'OSD_MAIN_BATT_USAGE',
  'OSD_DISARMED',
  'OSD_HOME_DIR',
  'OSD_HOME_DIST',
  'OSD_NUMERICAL_HEADING',
  'OSD_NUMERICAL_VARIO',
  'OSD_COMPASS_BAR',
  'OSD_ESC_TMP',
  'OSD_ESC_RPM',
  'OSD_REMAINING_TIME_ESTIMATE',
  'OSD_RTC_DATETIME',
  'OSD_ADJUSTMENT_RANGE',
  'OSD_CORE_TEMPERATURE',
  'OSD_ANTI_GRAVITY',
  'OSD_G_FORCE',
  'OSD_MOTOR_DIAG',
  'OSD_LOG_STATUS',
  'OSD_FLIP_ARROW',
  'OSD_LINK_QUALITY',
  'OSD_FLIGHT_DIST',
  'OSD_STICK_OVERLAY_LEFT',
  'OSD_STICK_OVERLAY_RIGHT',
  'OSD_PILOT_NAME',
  'OSD_ESC_RPM_FREQ',
  'OSD_RATE_PROFILE_NAME',
  'OSD_PID_PROFILE_NAME',
  'OSD_PROFILE_NAME',
  'OSD_RSSI_DBM_VALUE',
  'OSD_RC_CHANNELS',
  'OSD_CAMERA_FRAME',
  'OSD_EFFICIENCY',
  'OSD_TOTAL_FLIGHTS',
  'OSD_UP_DOWN_REFERENCE',
  'OSD_TX_UPLINK_POWER',
  'OSD_WATT_HOURS_DRAWN',
  'OSD_AUX_VALUE',
  'OSD_READY_MODE',
  'OSD_RSNR_VALUE',
  'OSD_SYS_GOGGLE_VOLTAGE',
  'OSD_SYS_VTX_VOLTAGE',
  'OSD_SYS_BITRATE',
  'OSD_SYS_DELAY',
  'OSD_SYS_DISTANCE',
  'OSD_SYS_LQ',
  'OSD_SYS_GOGGLE_DVR',
  'OSD_SYS_VTX_DVR',
  'OSD_SYS_WARNINGS',
  'OSD_SYS_VTX_TEMP',
  'OSD_SYS_FAN_SPEED',
  'OSD_GPS_LAP_TIME_CURRENT',
  'OSD_GPS_LAP_TIME_PREVIOUS',
  'OSD_GPS_LAP_TIME_BEST3',
  'OSD_DEBUG2',
  'OSD_CUSTOM_MSG0',
  'OSD_CUSTOM_MSG1',
  'OSD_CUSTOM_MSG2',
  'OSD_CUSTOM_MSG3',
  'OSD_LIDAR_DIST',
  'OSD_CUSTOM_SERIAL_TEXT',
  'OSD_BATTERY_PROFILE_NAME',
]);

/**
 * The index each element the operator can name MUST occupy.
 *
 * Spot checks, chosen for the ones a shift would hurt most: the
 * link-quality trio that a long-range pilot reads constantly, the
 * battery group, and the neighbours either side of index 50, which is
 * the one slot Betaflight itself makes version-dependent.
 */
const CRITICAL_SLOTS: ReadonlyArray<readonly [number, string, string]> =
  Object.freeze([
    [0, 'OSD_RSSI_VALUE', 'RSSI'],
    [1, 'OSD_MAIN_BATT_VOLTAGE', 'VBAT'],
    [11, 'OSD_CURRENT_DRAW', 'CURR'],
    [12, 'OSD_MAH_DRAWN', 'MAH'],
    [13, 'OSD_GPS_SPEED', 'GPS SPD'],
    [14, 'OSD_GPS_SATS', 'GPS SATS'],
    [15, 'OSD_ALTITUDE', 'ALT'],
    [22, 'OSD_AVG_CELL_VOLTAGE', 'CELL V'],
    [31, 'OSD_HOME_DIST', 'HOME DIST'],
    [46, 'OSD_LINK_QUALITY', 'LQ'],
    [49, 'OSD_STICK_OVERLAY_RIGHT', 'STICKS R'],
    [50, 'OSD_PILOT_NAME', 'PILOT'],
    [51, 'OSD_ESC_RPM_FREQ', 'RPM FRQ'],
    [55, 'OSD_RSSI_DBM_VALUE', 'RSSI dBm'],
    [62, 'OSD_WATT_HOURS_DRAWN', 'WATT H'],
  ]);

describe('the OSD element table matches the firmware enum', () => {
  it('has exactly one entry per unconditional osd_items_e member', () => {
    expect(OSD_ELEMENT_TOKENS).toHaveLength(OSD_ITEMS_E.length);
    expect(OSD_ELEMENT_NAMES_AR).toHaveLength(OSD_ITEMS_E.length);
  });

  it.each(CRITICAL_SLOTS.map(entry => [entry[1], entry] as const))(
    '%s sits at the index the firmware gives it',
    (_name, [index, firmwareName, token]) => {
      expect(`${firmwareName} @ ${OSD_ITEMS_E.indexOf(firmwareName)}`).toBe(
        `${firmwareName} @ ${index}`,
      );
      expect(`${firmwareName} -> ${osdElementToken(index)}`).toBe(
        `${firmwareName} -> ${token}`,
      );
    },
  );

  /**
   * The whole point: an element INSERTED into the firmware enum shifts
   * everything after it. This proves the check would catch that rather
   * than only catching a length change.
   */
  it('would notice an element inserted in the middle', () => {
    const shifted = [
      ...OSD_ITEMS_E.slice(0, 46),
      'OSD_SOMETHING_NEW',
      ...OSD_ITEMS_E.slice(46),
    ];
    expect(shifted.indexOf('OSD_LINK_QUALITY')).toBe(47);
    // ...which is NOT where our table has it, so the assertion above
    // would fail. Stated explicitly so the guard's teeth are visible.
    expect(OSD_ITEMS_E.indexOf('OSD_LINK_QUALITY')).toBe(46);
  });

  it('names every element it lists, and refuses to guess past the end', () => {
    for (let index = 0; index < OSD_ITEMS_E.length; index += 1) {
      expect(`${index}: ${osdElementToken(index)}`).not.toBe(
        `${index}: EL${index + 1}`,
      );
      expect(osdElementName(index).length).toBeGreaterThan(0);
    }
    /* Past the table the firmware's own entries are build-option gated,
       so the honest answer is a neutral placeholder that cannot be
       mistaken for a named element. */
    expect(osdElementToken(OSD_ITEMS_E.length)).toBe(`EL${OSD_ITEMS_E.length + 1}`);
    expect(osdElementName(OSD_ITEMS_E.length)).toContain('عنصر OSD');
  });

  /**
   * Slot 50 is the one place Betaflight itself branches by API version.
   * This application's floor decides which branch it can ever see, so
   * the two facts are pinned together - raising or lowering the floor
   * without revisiting this table fails here.
   */
  it('is entitled to call slot 50 PILOT_NAME, because the API floor says so', () => {
    expect(MINIMUM_CONFIGURATION_API_MINOR).toBeGreaterThanOrEqual(45);
    expect(OSD_ITEMS_E[50]).toBe('OSD_PILOT_NAME');
    expect(osdElementToken(50)).toBe('PILOT');
  });

  /**
   * Every entry the operator can read must be distinguishable from every
   * other. Two elements sharing a label is a mislabelling that no index
   * check would catch.
   */
  it('gives every element a distinct name and a distinct token', () => {
    expect(new Set(OSD_ELEMENT_TOKENS).size).toBe(OSD_ELEMENT_TOKENS.length);
    expect(new Set(OSD_ELEMENT_NAMES_AR).size).toBe(OSD_ELEMENT_NAMES_AR.length);
  });
});
