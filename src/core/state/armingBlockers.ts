/**
 * Pass 7.7 - arming-blocker and armed-state semantics, taken ONLY from the
 * pinned immutable API-1.47 authority
 * (BETAFLIGHT_API147_COMMIT = 7348054f268f0058574719c134e9f149565bb8ea).
 * No master, no neighbouring release, no Configurator, no sandwich
 * inference.
 *
 * Blocker enum - src/main/fc/runtime_config.h:42-72 verbatim, in order:
 *   NO_GYRO(1<<0) FAILSAFE(1<<1) RX_FAILSAFE(1<<2) NOT_DISARMED(1<<3)
 *   BOXFAILSAFE(1<<4) RUNAWAY_TAKEOFF(1<<5) CRASH_DETECTED(1<<6)
 *   THROTTLE(1<<7) ANGLE(1<<8) BOOT_GRACE_TIME(1<<9) NOPREARM(1<<10)
 *   LOAD(1<<11) CALIBRATING(1<<12) CLI(1<<13) CMS_MENU(1<<14) BST(1<<15)
 *   MSP(1<<16) PARALYZE(1<<17) GPS(1<<18) RESC(1<<19) DSHOT_TELEM(1<<20)
 *   REBOOT_REQUIRED(1<<21) DSHOT_BITBANG(1<<22) ACC_CALIBRATION(1<<23)
 *   MOTOR_PROTOCOL(1<<24) CRASHFLIP(1<<25) ALTHOLD(1<<26) POSHOLD(1<<27)
 *   ARM_SWITCH(1<<28)   (runtime_config.h:74 -> COUNT = 29)
 *
 * ARMED state - NOT derivable from the blocker mask. The authority is
 * msp_box.c:391-392: `if (boxid == BOXARM) return ARMING_FLAG(ARMED);`
 * combined with packFlightModeFlags (msp_box.c:402-418), which packs bits
 * by ACTIVE-BOX INDEX (configuration dependent), and MSP_BOXIDS (119,
 * msp.c:2336-2341) which returns the permanent IDs in exactly that same
 * order. BOXARM's permanentId is 0 (msp_box.c:49). Therefore: armed =
 * bit(index of permanentId 0 in the BOXIDS reply) of the packed
 * flight-mode flags. Without a valid BOXIDS mapping the armed state is
 * UNKNOWN - never guessed, and never inferred from arming-disable flags.
 *
 * All bit tests are arithmetic: JavaScript's bitwise operators are
 * signed-32-bit and would corrupt bit 31 of an unsigned u32 mask.
 */

/** Canonical upstream tokens, index === bit position. Order is the pinned
 * enum order and must not be re-sorted. */
export const ARMING_DISABLE_FLAG_TOKENS: readonly string[] = Object.freeze([
  'NO_GYRO',
  'FAILSAFE',
  'RX_FAILSAFE',
  'NOT_DISARMED',
  'BOXFAILSAFE',
  'RUNAWAY_TAKEOFF',
  'CRASH_DETECTED',
  'THROTTLE',
  'ANGLE',
  'BOOT_GRACE_TIME',
  'NOPREARM',
  'LOAD',
  'CALIBRATING',
  'CLI',
  'CMS_MENU',
  'BST',
  'MSP',
  'PARALYZE',
  'GPS',
  'RESC',
  'DSHOT_TELEM',
  'REBOOT_REQUIRED',
  'DSHOT_BITBANG',
  'ACC_CALIBRATION',
  'MOTOR_PROTOCOL',
  'CRASHFLIP',
  'ALTHOLD',
  'POSHOLD',
  'ARM_SWITCH',
]);

/** runtime_config.h:74 - LOG2(ARMING_DISABLED_ARM_SWITCH) + 1. */
export const ARMING_DISABLE_FLAGS_COUNT = 29;

export type ArmingBlockerBit =
  | {readonly kind: 'KNOWN'; readonly bit: number; readonly token: string}
  /** A set bit with no mapping at the pinned authority - preserved
   * numerically/in hex, NEVER discarded and never renamed. */
  | {readonly kind: 'UNKNOWN'; readonly bit: number; readonly hex: string};

/** Arithmetic (not bitwise) test of bit `index` of an unsigned mask. */
function isBitSet(mask: number, index: number): boolean {
  return Math.floor(mask / Math.pow(2, index)) % 2 === 1;
}

/**
 * Splits an UNSIGNED u32 arming-disable mask into known and unknown bits.
 * Every set bit above the pinned count is preserved as UNKNOWN with its
 * own hex value; nothing is dropped.
 */
export function decodeArmingBlockers(mask: number): readonly ArmingBlockerBit[] {
  const bits: ArmingBlockerBit[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if (!isBitSet(mask, bit)) {
      continue;
    }
    const token = ARMING_DISABLE_FLAG_TOKENS[bit];
    if (token !== undefined) {
      bits.push({kind: 'KNOWN', bit, token});
    } else {
      bits.push({kind: 'UNKNOWN', bit, hex: `0x${Math.pow(2, bit).toString(16)}`});
    }
  }
  return Object.freeze(bits);
}

/** Sensor-presence mapping - msp.c's own bit packing at the pinned
 * authority: ACC | BARO<<1 | MAG<<2 | GPS<<3 | RANGEFINDER<<4 | GYRO<<5 |
 * OPTICALFLOW<<6. A set bit means DETECTED, never healthy. */
export const SENSOR_PRESENCE_TOKENS: readonly string[] = Object.freeze([
  'ACC',
  'BARO',
  'MAG',
  'GPS',
  'RANGEFINDER',
  'GYRO',
  'OPTICALFLOW',
]);

export type SensorPresenceBit =
  | {readonly kind: 'KNOWN'; readonly bit: number; readonly token: string}
  | {readonly kind: 'UNKNOWN'; readonly bit: number; readonly hex: string};

export function decodeSensorPresence(mask: number): readonly SensorPresenceBit[] {
  const bits: SensorPresenceBit[] = [];
  for (let bit = 0; bit < 16; bit++) {
    if (!isBitSet(mask, bit)) {
      continue;
    }
    const token = SENSOR_PRESENCE_TOKENS[bit];
    bits.push(
      token !== undefined
        ? {kind: 'KNOWN', bit, token}
        : {kind: 'UNKNOWN', bit, hex: `0x${Math.pow(2, bit).toString(16)}`},
    );
  }
  return Object.freeze(bits);
}

/**
 * Pass 7.7, Region 4: the blocker tokens whose MEANING (not merely whose
 * name) was read at the pinned authority, so an Arabic description of
 * the condition is source-proven rather than inferred. Each entry below
 * names the exact set-site that proves it:
 *
 *   NO_GYRO          fc/init.c:668      (!sensorsAutodetect())
 *   FAILSAFE         flight/failsafe.c:390
 *   RX_FAILSAFE      flight/failsafe.c:183,202,219
 *   NOT_DISARMED     fc/core.c:331      (RX returned with the arm switch on)
 *   BOXFAILSAFE      fc/core.c:349      (IS_RC_MODE_ACTIVE(BOXFAILSAFE))
 *   RUNAWAY_TAKEOFF  fc/core.c:1227
 *   CRASH_DETECTED   flight/pid.c:691
 *   THROTTLE         fc/core.c:367      (calculateThrottleStatus() != THROTTLE_LOW)
 *   ANGLE            fc/core.c:373      (!isUpright())
 *   BOOT_GRACE_TIME  fc/init.c:969 + fc/core.c:311-320
 *   NOPREARM         fc/core.c:394-396  (BOXPREARM not active)
 *   LOAD             fc/core.c:380      (getCpuPercentageLate() > limit)
 *   CALIBRATING      fc/core.c:387      (isCalibrating())
 *   CLI              cli/cli.c:6944
 *   CMS_MENU         cms/cms.c:907
 *   MSP              msp/msp.c:3636     (arming disabled while an MSP link is used)
 *   PARALYZE         fc/core.c:434      (IS_RC_MODE_ACTIVE(BOXPARALYZE))
 *   GPS              fc/core.c:404-406  (GPS-rescue fix/sat requirement unmet)
 *   RESC             fc/core.c:409      (IS_RC_MODE_ACTIVE(BOXGPSRESCUE))
 *   DSHOT_TELEM      fc/core.c:419      (DShot telemetry enabled but inactive)
 *   REBOOT_REQUIRED  config/config.c:806 (setRebootRequired())
 *   DSHOT_BITBANG    fc/core.c:427      (bitbang status != DSHOT_BITBANG_STATUS_OK)
 *   ACC_CALIBRATION  fc/core.c:439      (accNeedsCalibration())
 *   MOTOR_PROTOCOL   fc/core.c:446      (!isMotorProtocolEnabled())
 *   CRASHFLIP        fc/core.c:292      (manual re-arm required after crashflip)
 *   ALTHOLD          fc/core.c:355      (IS_RC_MODE_ACTIVE(BOXALTHOLD))
 *   POSHOLD          fc/core.c:361      (IS_RC_MODE_ACTIVE(BOXPOSHOLD))
 *   ARM_SWITCH       fc/core.c:472 + runtime_config.h:72 (set when the arm
 *                    switch is on while another blocker is active)
 *
 * BST is deliberately ABSENT: no set-site was located at the pinned
 * authority in this pass, so the UI shows its canonical token only and
 * invents no Arabic explanation for it.
 */
export const BLOCKER_TOKENS_WITH_PROVEN_DESCRIPTION: readonly string[] = Object.freeze(
  ARMING_DISABLE_FLAG_TOKENS.filter(token => token !== 'BST'),
);

/** BOXARM's permanent id at the pinned authority (msp_box.c:49). */
export const BOXARM_PERMANENT_ID = 0;

export type ArmedState = 'ARMED' | 'DISARMED' | 'UNKNOWN';

/**
 * Derives the ACTUAL armed state.
 *
 * @param flightModeFlagsLow32 the first 32 packed flight-mode bits from
 *        MSP_STATUS_EX (offset 6), unsigned.
 * @param extraFlightModeFlagBytes the optional extension bytes (bits 32+).
 * @param boxIdsPermanentIds the MSP_BOXIDS reply, in wire order; the index
 *        of a permanent id IS its bit position in the packed flags.
 *
 * Returns UNKNOWN - never a guess - when the mapping is absent, empty, or
 * does not contain BOXARM, or when the resolved bit lies beyond the bits
 * the frame actually carried.
 */
export function deriveArmedState(
  flightModeFlagsLow32: number | undefined,
  extraFlightModeFlagBytes: readonly number[] | undefined,
  boxIdsPermanentIds: readonly number[] | undefined,
): ArmedState {
  if (flightModeFlagsLow32 === undefined || boxIdsPermanentIds === undefined || boxIdsPermanentIds.length === 0) {
    return 'UNKNOWN';
  }
  const armIndex = boxIdsPermanentIds.indexOf(BOXARM_PERMANENT_ID);
  if (armIndex < 0) {
    return 'UNKNOWN'; // BOXARM not active/reported: cannot prove either way
  }
  if (armIndex < 32) {
    return isBitSet(flightModeFlagsLow32, armIndex) ? 'ARMED' : 'DISARMED';
  }
  const extension = extraFlightModeFlagBytes ?? [];
  const byteIndex = Math.floor((armIndex - 32) / 8);
  if (byteIndex >= extension.length) {
    return 'UNKNOWN'; // the frame did not carry that bit at all
  }
  return isBitSet(extension[byteIndex], (armIndex - 32) % 8) ? 'ARMED' : 'DISARMED';
}
