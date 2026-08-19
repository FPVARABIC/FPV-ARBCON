/* eslint-disable no-bitwise -- feature masks and UART function masks. */
/**
 * A SECOND FLEET, BUILT TO BREAK THINGS THE FIRST ONE COULD NOT.
 *
 * The five aircraft in virtualDroneFixtures.ts prove the happy path across
 * a realistic spread. This file exists because passing that spread twice
 * is not evidence of anything new: every value here is DIFFERENT from the
 * five, and the spread is chosen for the edges rather than for the middle.
 *
 * WHAT EACH ONE IS FOR, in one line:
 *
 *   LR7_HEAVY      the maximum surface - GPS, rescue, telemetry, VTX, 6S
 *   LR4_LIGHT      long range on a 4" 4S airframe, tiny capacity
 *   RACE5_SPEC     a spec-race build: no GPS, DROP failsafe, 8 channels
 *   FREE5_TUNED    freestyle with an aggressive, unusual PID/rate pair
 *   CINE5_SMOOTH   cinematic: soft rates, low idle, heavy filtering
 *   WHOOP3_DUCT    3" cinewhoop, 90 degree stack rotation, 4S
 *   WHOOP35_DUCT   3.5" cinewhoop, 6S, opposite yaw rotation
 *   TINY65_1S      65mm 1S - the smallest legal battery profile
 *   TINY75_1S      75mm 1S with a current sensor the 65 lacks
 *   MICRO2_TOY     2" micro, 16 channels, minimum viable configuration
 *   GPS_NO_RESCUE  GPS hardware present, failsafe deliberately NOT rescue
 *   NO_GPS_AT_ALL  no GPS in the build at all - rescue must be unreachable
 *
 * NOTHING HERE IS AN INVENTED NUMBER. PID and rate values are inside the
 * ranges cli/settings.c accepts; the 3D deadbands are the firmware's own
 * PG_RESET_TEMPLATE values; failsafe procedures are the enum from
 * pg/rx.h; motor protocols are motorProtocolTypes_e; the serial function
 * masks are Betaflight's own bit positions. Where a value is deliberately
 * at a boundary, the comment says which boundary and where it comes from.
 */

import {
  FAILSAFE_DROP,
  FAILSAFE_GPS_RESCUE,
  FAILSAFE_LAND,
  FEATURE_GPS,
  FEATURE_MOTOR_STOP,
  FEATURE_OSD,
  FEATURE_TELEMETRY,
  FRAME_BUILDERS,
  FUNCTION_GPS,
  FUNCTION_MSP,
  FUNCTION_RX_SERIAL,
  FUNCTION_TELEMETRY_SMARTPORT,
  FUNCTION_VTX_MSP,
  MOTOR_DSHOT300,
  MOTOR_DSHOT600,
  type DroneSpec,
} from './virtualDroneFixtures';

const {port, USB_VCP} = FRAME_BUILDERS;

/** DShot150 - motorProtocolTypes_e index 5. The only protocol the five
 *  original aircraft never used, and the right one for a 1S whoop. */
export const MOTOR_DSHOT150 = 5;

/** serialrx_provider values, rx/rx.h SERIALRX_*. */
const RX_SPEKTRUM2048 = 1;
const RX_SBUS = 2;
const RX_IBUS = 7;
const RX_CRSF = 9;
const RX_GHST = 14;

/** GPS provider, gps.h: 0 = NMEA, 1 = UBLOX. */
const GPS_UBLOX = 1;
/** SBAS: 0 AUTO, 1 EGNOS, 2 WAAS, 3 MSAS, 4 GAGAN, 5 NONE. */
const SBAS_EGNOS = 1;
const SBAS_WAAS = 2;
const SBAS_NONE = 5;

/**
 * UART maps. Every one differs from every other, and from all five of the
 * original aircraft, because a port map that is the same everywhere never
 * catches a controller that assumes a port index.
 */
const PORTS_LR7 = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(0, FUNCTION_RX_SERIAL),
  port(1, FUNCTION_GPS, {gpsBaudIndex: 3}),
  port(2, FUNCTION_TELEMETRY_SMARTPORT),
  port(3, FUNCTION_VTX_MSP),
  port(4, 0),
]);
const PORTS_LR4 = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(1, FUNCTION_RX_SERIAL),
  port(2, FUNCTION_GPS, {gpsBaudIndex: 2}),
]);
const PORTS_RACE = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(5, FUNCTION_RX_SERIAL),
  port(3, FUNCTION_TELEMETRY_SMARTPORT),
]);
const PORTS_FREESTYLE = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(2, FUNCTION_RX_SERIAL),
  port(4, FUNCTION_VTX_MSP),
]);
const PORTS_CINE = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(0, FUNCTION_RX_SERIAL),
  port(1, FUNCTION_VTX_MSP),
  port(3, FUNCTION_TELEMETRY_SMARTPORT),
]);
const PORTS_WHOOP = Object.freeze([
  port(USB_VCP, FUNCTION_MSP),
  port(1, FUNCTION_RX_SERIAL),
]);
const PORTS_MINIMAL = Object.freeze([port(USB_VCP, FUNCTION_MSP | FUNCTION_RX_SERIAL)]);

/** Betaflight's own flight3DConfig PG_RESET_TEMPLATE, fc/rc_controls.c. */
const STOCK_3D = Object.freeze({low: 1406, neutral: 1460, high: 1514});

export const RED_TEAM_SPECS: readonly DroneSpec[] = Object.freeze([
  {
    key: 'LR7_HEAVY',
    name: '7" Long Range heavy — 6S, GPS Rescue, SmartPort, VTX',
    rationale:
      'The widest configuration surface in the fleet: six UARTs in use, ' +
      'GPS with EGNOS, rescue as the failsafe procedure, telemetry and a ' +
      'controllable VTX. If any screen leaks state into another, this is ' +
      'the aircraft with the most for it to leak into.',
    hardware: {
      board: 'S745',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: true,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 16,
      serialPorts: PORTS_LR7,
    },
    target: {
      featureMask: FEATURE_GPS | FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 400,
      battery: {
        minCellCentivolts: 320,
        maxCellCentivolts: 435,
        warningCellCentivolts: 345,
        capacityMah: 6000,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 15,
        landingTimeSeconds: 20,
        throttle: 1000,
        switchMode: 1,
        throttleLowDelay: 100,
        procedure: FAILSAFE_GPS_RESCUE,
      },
      pid: {
        rollP: 42, rollI: 74, rollD: 32,
        pitchP: 44, pitchI: 78, pitchD: 34,
        yawP: 40, yawI: 74, yawD: 0,
      },
      rates: {
        rcRate: 100, superRate: 60, expo: 15,
        throttleMid: 50, throttleExpo: 0, tpaRate: 50,
      },
      filters: {
        gyroLowpassHz: 250, dtermLowpassHz: 120,
        dynLpfMinHz: 180, dynLpfMaxHz: 480,
      },
      boardAlignment: [0, 0, 0],
      gps: {
        provider: GPS_UBLOX, sbas: SBAS_EGNOS,
        autoConfig: true, autoBaud: true, homeOnce: true, galileo: true,
      },
      gpsRescue: {
        angle: 40, returnAltitudeM: 80, descentDistanceM: 300,
        groundSpeedCmS: 900, minSatellites: 10, minStartDistM: 25,
      },
      vtx: {band: 5, channel: 3, power: 3, pitMode: false, frequency: 5800},
      osdAltitudeAlarmM: 120,
      osdCapacityAlarmMah: 5400,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 25,
    },
  },
  {
    key: 'LR4_LIGHT',
    name: '4" Long Range light — 4S, GPS, no VTX control',
    rationale:
      'Long range without the heavy-lift assumptions: three UARTs, a 4S ' +
      'pack a tenth the capacity of the 7", and a GPS present with rescue ' +
      'NOT selected. Proves nothing keys rescue availability off hardware.',
    hardware: {
      board: 'S411',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 4,
      hasGps: true,
      hasCurrentSensor: true,
      hasVtx: false,
      channels: 12,
      serialPorts: PORTS_LR4,
    },
    target: {
      featureMask: FEATURE_GPS | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 550,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 420,
        warningCellCentivolts: 350,
        capacityMah: 1500,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 10,
        landingTimeSeconds: 15,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 46, rollI: 82, rollD: 38,
        pitchP: 48, pitchI: 86, pitchD: 40,
        yawP: 44, yawI: 82, yawD: 0,
      },
      rates: {
        rcRate: 105, superRate: 66, expo: 12,
        throttleMid: 50, throttleExpo: 10, tpaRate: 60,
      },
      filters: {
        gyroLowpassHz: 300, dtermLowpassHz: 140,
        dynLpfMinHz: 200, dynLpfMaxHz: 520,
      },
      boardAlignment: [0, 0, 0],
      gps: {
        provider: GPS_UBLOX, sbas: SBAS_WAAS,
        autoConfig: true, autoBaud: false, homeOnce: true, galileo: false,
      },
      osdAltitudeAlarmM: 90,
      osdCapacityAlarmMah: 1300,
      rxSerialProvider: RX_GHST,
      fpvCamAngleDegrees: 20,
    },
  },
  {
    key: 'RACE5_SPEC',
    name: '5" spec racer — DShot600, no GPS, DROP failsafe',
    rationale:
      'A race build has the least configuration and the harshest failsafe: ' +
      'DROP rather than land, eight channels, no GPS anywhere. The ' +
      'aircraft most likely to expose a screen that assumes GPS exists.',
    hardware: {
      board: 'S722',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 8,
      serialPorts: PORTS_RACE,
    },
    target: {
      featureMask: FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 300,
      battery: {
        minCellCentivolts: 310,
        maxCellCentivolts: 440,
        warningCellCentivolts: 335,
        capacityMah: 1300,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 4,
        landingTimeSeconds: 5,
        throttle: 1000,
        switchMode: 2,
        throttleLowDelay: 50,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 58, rollI: 96, rollD: 48,
        pitchP: 62, pitchI: 102, pitchD: 52,
        yawP: 56, yawI: 96, yawD: 0,
      },
      rates: {
        rcRate: 130, superRate: 78, expo: 5,
        throttleMid: 55, throttleExpo: 20, tpaRate: 70,
      },
      filters: {
        gyroLowpassHz: 400, dtermLowpassHz: 170,
        dynLpfMinHz: 260, dynLpfMaxHz: 640,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 4, channel: 7, power: 4, pitMode: false, frequency: 5917},
      osdAltitudeAlarmM: 50,
      osdCapacityAlarmMah: 1150,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 40,
    },
  },
  {
    key: 'FREE5_TUNED',
    name: '5" freestyle — heavily retuned, SBUS receiver',
    rationale:
      'Same airframe class as the racer and a completely different tune, ' +
      'on a different receiver protocol. Two builds this similar sharing ' +
      'one app is how a fixture that leaks between boards gets caught.',
    hardware: {
      board: 'S743',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 10,
      serialPorts: PORTS_FREESTYLE,
    },
    target: {
      featureMask: FEATURE_OSD | FEATURE_MOTOR_STOP,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 600,
      battery: {
        minCellCentivolts: 325,
        maxCellCentivolts: 430,
        warningCellCentivolts: 348,
        capacityMah: 1550,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 8,
        landingTimeSeconds: 12,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 51, rollI: 88, rollD: 44,
        pitchP: 55, pitchI: 94, pitchD: 47,
        yawP: 49, yawI: 88, yawD: 3,
      },
      rates: {
        rcRate: 118, superRate: 72, expo: 8,
        throttleMid: 50, throttleExpo: 15, tpaRate: 65,
      },
      filters: {
        gyroLowpassHz: 350, dtermLowpassHz: 150,
        dynLpfMinHz: 220, dynLpfMaxHz: 580,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 3, channel: 2, power: 2, pitMode: false, frequency: 5732},
      osdAltitudeAlarmM: 70,
      osdCapacityAlarmMah: 1400,
      rxSerialProvider: RX_SBUS,
      fpvCamAngleDegrees: 35,
    },
  },
  {
    key: 'CINE5_SMOOTH',
    name: '5" cinematic — soft rates, low idle, heavy filtering',
    rationale:
      'Every tuning value pushed toward the smooth end, including the ' +
      'lowest motor idle in the fleet. Its rates and filters sit near the ' +
      'opposite bound from the racer on the same fields.',
    hardware: {
      board: 'S405',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 12,
      serialPorts: PORTS_CINE,
    },
    target: {
      featureMask: FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 250,
      battery: {
        minCellCentivolts: 335,
        maxCellCentivolts: 425,
        warningCellCentivolts: 355,
        capacityMah: 2200,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 12,
        landingTimeSeconds: 25,
        throttle: 1000,
        switchMode: 1,
        throttleLowDelay: 150,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 38, rollI: 68, rollD: 28,
        pitchP: 40, pitchI: 72, pitchD: 30,
        yawP: 36, yawI: 68, yawD: 0,
      },
      rates: {
        rcRate: 85, superRate: 45, expo: 25,
        throttleMid: 50, throttleExpo: 5, tpaRate: 40,
      },
      filters: {
        gyroLowpassHz: 180, dtermLowpassHz: 90,
        dynLpfMinHz: 140, dynLpfMaxHz: 380,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 6, channel: 1, power: 1, pitMode: true, frequency: 5658},
      osdAltitudeAlarmM: 60,
      osdCapacityAlarmMah: 2000,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 10,
    },
  },
  {
    key: 'WHOOP3_DUCT',
    name: '3" cinewhoop — 4S, stack rotated 90 degrees',
    rationale:
      'A ducted build where the stack does not face forward. Board ' +
      'alignment yaw 90 must survive every other screen s save.',
    hardware: {
      board: 'S411',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 4,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 8,
      serialPorts: PORTS_WHOOP,
    },
    target: {
      featureMask: FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 750,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 425,
        warningCellCentivolts: 350,
        capacityMah: 850,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 6,
        landingTimeSeconds: 8,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 62, rollI: 105, rollD: 42,
        pitchP: 66, pitchI: 110, pitchD: 45,
        yawP: 60, yawI: 105, yawD: 0,
      },
      rates: {
        rcRate: 95, superRate: 55, expo: 20,
        throttleMid: 50, throttleExpo: 0, tpaRate: 45,
      },
      filters: {
        gyroLowpassHz: 220, dtermLowpassHz: 110,
        dynLpfMinHz: 160, dynLpfMaxHz: 440,
      },
      // The duct forces the stack a quarter turn. align_board_yaw is in
      // whole degrees, cli/settings.c bound -180..360.
      boardAlignment: [0, 0, 90],
      vtx: {band: 2, channel: 5, power: 1, pitMode: false, frequency: 5665},
      osdAltitudeAlarmM: 30,
      osdCapacityAlarmMah: 750,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 15,
    },
  },
  {
    key: 'WHOOP35_DUCT',
    name: '3.5" cinewhoop — 6S, stack rotated the other way',
    rationale:
      'The mirror of the 3": 270 degrees rather than 90, a 6S pack on a ' +
      'ducted airframe, and a different receiver. An alignment sign error ' +
      'that survives one of these fails the other.',
    hardware: {
      board: 'S745',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 10,
      serialPorts: PORTS_WHOOP,
    },
    target: {
      featureMask: FEATURE_OSD | FEATURE_TELEMETRY,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 700,
      battery: {
        minCellCentivolts: 328,
        maxCellCentivolts: 432,
        warningCellCentivolts: 352,
        capacityMah: 1100,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 7,
        landingTimeSeconds: 10,
        throttle: 1000,
        switchMode: 1,
        throttleLowDelay: 120,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 57, rollI: 99, rollD: 39,
        pitchP: 61, pitchI: 104, pitchD: 42,
        yawP: 55, yawI: 99, yawD: 0,
      },
      rates: {
        rcRate: 92, superRate: 52, expo: 22,
        throttleMid: 52, throttleExpo: 8, tpaRate: 48,
      },
      filters: {
        gyroLowpassHz: 240, dtermLowpassHz: 115,
        dynLpfMinHz: 170, dynLpfMaxHz: 460,
      },
      boardAlignment: [0, 0, 270],
      vtx: {band: 1, channel: 8, power: 2, pitMode: false, frequency: 5945},
      osdAltitudeAlarmM: 35,
      osdCapacityAlarmMah: 950,
      rxSerialProvider: RX_IBUS,
      fpvCamAngleDegrees: 12,
    },
  },
  {
    key: 'TINY65_1S',
    name: '65mm tiny whoop — 1S, DShot150, no current sensor',
    rationale:
      'The smallest legal battery profile in the fleet and the only ' +
      'DShot150 build. One cell means the voltage warning arithmetic has ' +
      'no headroom to hide an off-by-one in.',
    hardware: {
      board: 'S411',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 1,
      hasGps: false,
      hasCurrentSensor: false,
      hasVtx: false,
      channels: 8,
      serialPorts: PORTS_MINIMAL,
    },
    target: {
      featureMask: FEATURE_OSD | FEATURE_MOTOR_STOP,
      motorProtocol: MOTOR_DSHOT150,
      motorIdlePercent: 900,
      battery: {
        // VBAT_CELL_VOTAGE_RANGE_MIN/MAX is 100..500 (sensors/battery.h);
        // 300/435/335 is a normal 1S LiHV profile inside it.
        minCellCentivolts: 300,
        maxCellCentivolts: 435,
        warningCellCentivolts: 335,
        capacityMah: 300,
        voltageMeterSource: 1,
        currentMeterSource: 0,
      },
      failsafe: {
        delayDeciseconds: 5,
        landingTimeSeconds: 5,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 70, rollI: 120, rollD: 50,
        pitchP: 74, pitchI: 126, pitchD: 53,
        yawP: 68, yawI: 120, yawD: 0,
      },
      rates: {
        rcRate: 110, superRate: 68, expo: 18,
        throttleMid: 50, throttleExpo: 0, tpaRate: 55,
      },
      filters: {
        gyroLowpassHz: 200, dtermLowpassHz: 100,
        dynLpfMinHz: 150, dynLpfMaxHz: 400,
      },
      boardAlignment: [0, 0, 0],
      osdAltitudeAlarmM: 15,
      osdCapacityAlarmMah: 260,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 30,
    },
  },
  {
    key: 'TINY75_1S',
    name: '75mm tiny whoop — 1S with a current sensor',
    rationale:
      'Identical class to the 65mm and one hardware difference: it HAS a ' +
      'current sensor. Two nearly-identical aircraft that must not end up ' +
      'with each other s power configuration.',
    hardware: {
      board: 'S411',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 1,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: false,
      channels: 8,
      serialPorts: PORTS_MINIMAL,
    },
    target: {
      featureMask: FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 850,
      battery: {
        minCellCentivolts: 305,
        maxCellCentivolts: 430,
        warningCellCentivolts: 340,
        capacityMah: 450,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 5,
        landingTimeSeconds: 6,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 66, rollI: 114, rollD: 47,
        pitchP: 70, pitchI: 120, pitchD: 50,
        yawP: 64, yawI: 114, yawD: 0,
      },
      rates: {
        rcRate: 108, superRate: 64, expo: 19,
        throttleMid: 50, throttleExpo: 0, tpaRate: 52,
      },
      filters: {
        gyroLowpassHz: 210, dtermLowpassHz: 105,
        dynLpfMinHz: 155, dynLpfMaxHz: 410,
      },
      boardAlignment: [0, 0, 0],
      osdAltitudeAlarmM: 18,
      osdCapacityAlarmMah: 400,
      rxSerialProvider: RX_SPEKTRUM2048,
      fpvCamAngleDegrees: 28,
    },
  },
  {
    key: 'MICRO2_TOY',
    name: '2" micro — 16 channels, minimum viable configuration',
    rationale:
      'The sparsest target in the fleet: one UART doing two jobs, almost ' +
      'nothing enabled, and the highest channel count. Proves the app can ' +
      'leave a configuration nearly empty rather than filling it in.',
    hardware: {
      board: 'S405',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 2,
      hasGps: false,
      hasCurrentSensor: false,
      hasVtx: false,
      channels: 16,
      serialPorts: PORTS_MINIMAL,
    },
    target: {
      featureMask: FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 800,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 420,
        warningCellCentivolts: 345,
        capacityMah: 550,
        voltageMeterSource: 1,
        currentMeterSource: 0,
      },
      failsafe: {
        delayDeciseconds: 5,
        landingTimeSeconds: 5,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 60, rollI: 100, rollD: 40,
        pitchP: 63, pitchI: 105, pitchD: 43,
        yawP: 58, yawI: 100, yawD: 0,
      },
      rates: {
        rcRate: 100, superRate: 60, expo: 20,
        throttleMid: 50, throttleExpo: 0, tpaRate: 50,
      },
      filters: {
        gyroLowpassHz: 230, dtermLowpassHz: 112,
        dynLpfMinHz: 165, dynLpfMaxHz: 430,
      },
      boardAlignment: [0, 0, 0],
      osdAltitudeAlarmM: 25,
      osdCapacityAlarmMah: 480,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 22,
    },
  },
  {
    key: 'GPS_NO_RESCUE',
    name: 'GPS build with rescue deliberately NOT selected',
    rationale:
      'GPS hardware, GPS feature, a GPS UART - and LAND as the failsafe ' +
      'procedure. Having the hardware must never be taken as having ' +
      'chosen the behaviour.',
    hardware: {
      board: 'S743',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 4,
      hasGps: true,
      hasCurrentSensor: true,
      hasVtx: false,
      channels: 12,
      serialPorts: PORTS_LR4,
    },
    target: {
      featureMask: FEATURE_GPS | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 500,
      battery: {
        minCellCentivolts: 332,
        maxCellCentivolts: 422,
        warningCellCentivolts: 351,
        capacityMah: 1800,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 9,
        landingTimeSeconds: 14,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 47, rollI: 84, rollD: 36,
        pitchP: 50, pitchI: 89, pitchD: 39,
        yawP: 45, yawI: 84, yawD: 0,
      },
      rates: {
        rcRate: 102, superRate: 62, expo: 14,
        throttleMid: 50, throttleExpo: 6, tpaRate: 58,
      },
      filters: {
        gyroLowpassHz: 280, dtermLowpassHz: 130,
        dynLpfMinHz: 190, dynLpfMaxHz: 500,
      },
      boardAlignment: [0, 0, 0],
      gps: {
        provider: GPS_UBLOX, sbas: SBAS_NONE,
        autoConfig: true, autoBaud: false, homeOnce: false, galileo: true,
      },
      osdAltitudeAlarmM: 80,
      osdCapacityAlarmMah: 1600,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 18,
    },
  },
  {
    key: 'NO_GPS_AT_ALL',
    name: 'No GPS compiled in — rescue must be unreachable',
    rationale:
      'The build has no GPS option in its BUILD_INFO at all. Any screen ' +
      'that offers GPS Rescue here is offering a procedure the aircraft ' +
      'physically cannot perform.',
    hardware: {
      board: 'S722',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 8,
      serialPorts: PORTS_RACE,
    },
    target: {
      featureMask: FEATURE_OSD | FEATURE_TELEMETRY,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 450,
      battery: {
        minCellCentivolts: 315,
        maxCellCentivolts: 438,
        warningCellCentivolts: 338,
        capacityMah: 1400,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 6,
        landingTimeSeconds: 9,
        throttle: 1000,
        switchMode: 2,
        throttleLowDelay: 80,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 53, rollI: 91, rollD: 41,
        pitchP: 57, pitchI: 97, pitchD: 44,
        yawP: 51, yawI: 91, yawD: 0,
      },
      rates: {
        rcRate: 122, superRate: 74, expo: 7,
        throttleMid: 54, throttleExpo: 18, tpaRate: 68,
      },
      filters: {
        gyroLowpassHz: 380, dtermLowpassHz: 160,
        dynLpfMinHz: 240, dynLpfMaxHz: 600,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 8, channel: 4, power: 3, pitMode: false, frequency: 5760},
      osdAltitudeAlarmM: 45,
      osdCapacityAlarmMah: 1250,
      rxSerialProvider: RX_CRSF,
      fpvCamAngleDegrees: 38,
    },
  },
]);

/** The stock 3D band, re-exported so a scenario can assert against the
 *  firmware's own defaults rather than a number typed twice. */
export const FIRMWARE_STOCK_3D_BAND = STOCK_3D;

export function redTeamSpec(key: string): DroneSpec {
  const found = RED_TEAM_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no red-team spec ${key}`);
  return found;
}
