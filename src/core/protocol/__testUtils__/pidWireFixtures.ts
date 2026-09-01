/**
 * HAND-WRITTEN PID-PAGE PAYLOADS.
 *
 * Every byte below was written out by hand from the pinned firmware
 * serialisers. None of it was produced by running our own encoder and
 * capturing the result - a fixture built that way proves only that the
 * encoder agrees with itself, and would have happily locked in a wrong
 * offset for good.
 *
 * The values are deliberately awkward: no repeats between neighbouring
 * fields, nothing round, and non-zero sentinels in the slots the firmware
 * fills with constants, so that a decoder reading one field's offset for
 * another's is caught by the value rather than by luck.
 */

/** Little-endian u16 as the two bytes the wire carries. */
function le16(value: number): readonly [number, number] {
  // This is a byte-order helper: the shift and mask ARE the little-endian
  // encoding being expressed, so writing them as arithmetic would hide it.
  // eslint-disable-next-line no-bitwise
  return [value & 0xff, (value >> 8) & 0xff];
}

/** Little-endian u32. */
function le32(value: number): readonly [number, number, number, number] {
  return [
    value % 0x100,
    Math.floor(value / 0x100) % 0x100,
    Math.floor(value / 0x10000) % 0x100,
    Math.floor(value / 0x1000000) % 0x100,
  ];
}

/* ------------------------------------------------------------------ */
/* MSP_PID - 15 bytes, five items of {P, I, D}                          */
/* ------------------------------------------------------------------ */

/**
 * ROLL 41/83/29, PITCH 43/89/31, YAW 47/97/0, LEVEL 53/101/37, MAG 59/103/41.
 *
 * LEVEL and MAG matter: our screen edits neither, so a save must return them
 * byte-for-byte. Distinct values here make a dropped tail obvious.
 */
export const MSP_PID_FIXTURE = Uint8Array.from([
  41, 83, 29,
  43, 89, 31,
  47, 97, 0,
  53, 101, 37,
  59, 103, 41,
]);

/* ------------------------------------------------------------------ */
/* MSP_PID_ADVANCED - 61 bytes at 1.47, 1.48 and 1.49 alike             */
/* ------------------------------------------------------------------ */

export const PID_ADVANCED_FIXTURE = Uint8Array.from([
  0xa1, 0xa2,             //  0 reserved u16                    sentinel
  0xa3, 0xa4,             //  2 reserved u16                    sentinel
  0xa5, 0xa6,             //  4 was yaw_p_limit u16             sentinel
  0xa7,                   //  6 reserved                        sentinel
  0xa8,                   //  7 was vbatPidCompensation         sentinel
  37,                     //  8 feedforward_transition
  0xa9,                   //  9 was dtermSetpointWeight low     sentinel
  0xaa, 0xab, 0xac,       // 10 reserved x3                     sentinel
  ...le16(1234),          // 13 rateAccelLimit
  ...le16(4321),          // 15 yawRateAccelLimit
  53,                     // 17 angle_limit
  0xad,                   // 18 was levelSensitivity            sentinel
  0xae, 0xaf,             // 19 was itermThrottleThreshold u16  sentinel
  ...le16(3800),          // 21 anti_gravity_gain
  0xb0, 0xb1,             // 23 was dtermSetpointWeight u16     sentinel
  1,                      // 25 iterm_rotation
  0xb2,                   // 26 was smart_feedforward           sentinel
  3,                      // 27 iterm_relax
  1,                      // 28 iterm_relax_type
  7,                      // 29 abs_control_gain    (retires at 1.48)
  11,                     // 30 throttle_boost
  23,                     // 31 acro_trainer_angle_limit
  ...le16(137),           // 32 feedforward roll
  ...le16(141),           // 34 feedforward pitch
  ...le16(149),           // 36 feedforward yaw
  0xb3,                   // 38 was antiGravityMode             sentinel
  43,                     // 39 d_max roll
  47,                     // 40 d_max pitch
  0,                      // 41 d_max yaw    (zero by design - yaw has none)
  29,                     // 42 d_max_gain
  31,                     // 43 d_max_advance
  1,                      // 44 use_integrated_yaw  (retires at 1.49)
  199,                    // 45 integrated_yaw_relax (retires at 1.49)
  17,                     // 46 iterm_relax_cutoff
  97,                     // 47 motor_output_limit
  0xff,                   // 48 auto_profile_cell_count - SIGNED, so -1
  61,                     // 49 dyn_idle_min_rpm
  2,                      // 50 feedforward_averaging
  63,                     // 51 feedforward_smooth_factor
  19,                     // 52 feedforward_boost
  91,                     // 53 feedforward_max_rate_limit
  13,                     // 54 feedforward_jitter_factor
  71,                     // 55 vbat_sag_compensation
  41,                     // 56 thrustLinearization
  1,                      // 57 tpa_mode
  67,                     // 58 tpa_rate
  ...le16(1350),          // 59 tpa_breakpoint
]);

/* ------------------------------------------------------------------ */
/* MSP_FILTER_CONFIG - 49 bytes at 1.47, 56 from 1.48                   */
/* ------------------------------------------------------------------ */

/**
 * Gyro LPF1 is 300 Hz here on purpose. The firmware writes it twice: a
 * truncated u8 at offset 0 and the real u16 at offsets 20-21. 300 does not
 * fit in a byte, so offset 0 holds 300 - 256 = 44 (0x2C) and only the u16 is
 * the truth. A decoder reading offset 0 gets 44 Hz and is wrong by 256.
 */
const FILTER_CONFIG_API147_BODY: readonly number[] = [
  0x2c,                   //  0 gyro_lpf1_static_hz LEGACY u8 - 300 truncated
  ...le16(111),           //  1 dterm_lpf1_static_hz
  ...le16(123),           //  3 yaw_lowpass_hz
  ...le16(233),           //  5 gyro_soft_notch_hz_1
  ...le16(147),           //  7 gyro_soft_notch_cutoff_1
  ...le16(260),           //  9 dterm_notch_hz
  ...le16(160),           // 11 dterm_notch_cutoff
  ...le16(334),           // 13 gyro_soft_notch_hz_2
  ...le16(224),           // 15 gyro_soft_notch_cutoff_2
  2,                      // 17 dterm_lpf1_type
  1,                      // 18 gyro_hardware_lpf
  0xc1,                   // 19 deprecated 32 kHz lpf           sentinel
  ...le16(300),           // 20 gyro_lpf1_static_hz AUTHORITATIVE u16
  ...le16(412),           // 22 gyro_lpf2_static_hz
  1,                      // 24 gyro_lpf1_type
  2,                      // 25 gyro_lpf2_type
  ...le16(176),           // 26 dterm_lpf2_static_hz
  1,                      // 28 dterm_lpf2_type
  ...le16(213),           // 29 gyro_lpf1_dyn_min_hz
  ...le16(517),           // 31 gyro_lpf1_dyn_max_hz
  ...le16(79),            // 33 dterm_lpf1_dyn_min_hz
  ...le16(163),           // 35 dterm_lpf1_dyn_max_hz
  0xc2,                   // 37 deprecated dyn_notch_range      sentinel
  0xc3,                   // 38 deprecated dyn_notch_width      sentinel
  ...le16(307),           // 39 dyn_notch_q
  ...le16(91),            // 41 dyn_notch_min_hz
  3,                      // 43 rpm_filter_harmonics
  87,                     // 44 rpm_filter_min_hz
  ...le16(593),           // 45 dyn_notch_max_hz
  5,                      // 47 dterm_lpf1_dyn_expo
  4,                      // 48 dyn_notch_count
];

export const FILTER_CONFIG_API147_FIXTURE = Uint8Array.from(FILTER_CONFIG_API147_BODY);

/** The 1.48 tail: u16 fade range, u16 q, three u8 harmonic weights. */
export const FILTER_CONFIG_API148_FIXTURE = Uint8Array.from([
  ...FILTER_CONFIG_API147_BODY,
  ...le16(55),            // 49 rpm_filter_fade_range_hz
  ...le16(507),           // 51 rpm_filter_q
  100, 80, 60,            // 53 rpm_filter_weights[3]
]);

/* ------------------------------------------------------------------ */
/* MSP_RC_TUNING - 24 bytes, unchanged 1.47 to 1.49                     */
/* ------------------------------------------------------------------ */

/**
 * The three retired TPA bytes carry sentinels rather than the zeros a real
 * board sends, so that a model which mistakes them for live TPA fields
 * produces an obviously wrong number instead of a plausible zero.
 *
 * Roll, pitch and yaw all differ on every axis field - a swapped pair is
 * therefore always visible.
 */
export const RC_TUNING_FIXTURE = Uint8Array.from([
  118,                    //  0 rcRate roll
  41,                     //  1 expo roll
  73,                     //  2 superRate roll
  77,                     //  3 superRate pitch
  81,                     //  4 superRate yaw
  0xd1,                   //  5 retired tpa_rate               sentinel
  47,                     //  6 throttle mid
  29,                     //  7 throttle expo
  0xd2, 0xd3,             //  8 retired tpa_breakpoint u16     sentinel
  53,                     // 10 expo yaw
  131,                    // 11 rcRate yaw
  124,                    // 12 rcRate pitch
  44,                     // 13 expo pitch
  2,                      // 14 throttle_limit_type
  88,                     // 15 throttle_limit_percent
  ...le16(1750),          // 16 rate_limit roll
  ...le16(1680),          // 18 rate_limit pitch
  ...le16(1500),          // 20 rate_limit yaw
  3,                      // 22 rates_type = ACTUAL
  39,                     // 23 throttle hover
]);

/* ------------------------------------------------------------------ */
/* MSP_SIMPLIFIED_TUNING - 53 bytes                                     */
/* ------------------------------------------------------------------ */

/**
 * The nine PID inputs are P-A's reference vector, so the generator test and
 * the codec test are checking the same numbers from opposite directions.
 *
 * Every reserved u32 holds a distinctive non-zero value. The firmware writes
 * zeros there today; a fixture that also wrote zeros could not tell a decoder
 * that preserves them from one that fabricates them.
 */
export const SIMPLIFIED_TUNING_FIXTURE = Uint8Array.from([
  /* PID block */
  2,                      //  0 mode = RPY
  113,                    //  1 master multiplier
  93,                     //  2 roll/pitch ratio
  106,                    //  3 i gain
  88,                     //  4 d gain
  97,                     //  5 pi gain
  71,                     //  6 d max gain
  124,                    //  7 feedforward gain
  107,                    //  8 pitch pi gain
  ...le32(0x11223344),    //  9 reserved u32                   sentinel
  ...le32(0x55667788),    // 13 reserved u32                   sentinel
  /* D-term block - PID-profile scoped */
  1,                      // 17 simplified_dterm_filter enabled
  83,                     // 18 multiplier
  ...le16(62),            // 19 dterm_lpf1_static_hz
  ...le16(124),           // 21 dterm_lpf2_static_hz
  ...le16(62),            // 23 dterm_lpf1_dyn_min_hz
  ...le16(124),           // 25 dterm_lpf1_dyn_max_hz
  ...le32(0x99aabbcc),    // 27 reserved u32                   sentinel
  ...le32(0xddeeff00),    // 31 reserved u32                   sentinel
  /* Gyro block - GLOBAL scope */
  1,                      // 35 simplified_gyro_filter enabled
  137,                    // 36 multiplier
  ...le16(342),           // 37 gyro_lpf1_static_hz
  ...le16(685),           // 39 gyro_lpf2_static_hz
  ...le16(342),           // 41 gyro_lpf1_dyn_min_hz
  ...le16(685),           // 43 gyro_lpf1_dyn_max_hz
  ...le32(0x0f1e2d3c),    // 45 reserved u32                   sentinel
  ...le32(0x4b5a6978),    // 49 reserved u32                   sentinel
]);

/** MSP_VALIDATE_SIMPLIFIED_TUNING: PIDs, then GYRO, then DTERM. */
export const SIMPLIFIED_VALIDITY_FIXTURE = Uint8Array.from([1, 0, 1]);

/**
 * MSP_CALCULATE_SIMPLIFIED_PID's answer: three axes of
 * {u8 P, u8 I, u8 D, u8 dMax, u16 F} = 18 bytes, a different shape from the
 * 17-byte block it is asked in.
 */
export const CALCULATED_PIDFS_FIXTURE = Uint8Array.from([
  49, 92, 29, 36, ...le16(168),
  55, 104, 31, 39, ...le16(187),
  49, 92, 0, 0, ...le16(168),
]);
