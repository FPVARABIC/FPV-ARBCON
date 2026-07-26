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
