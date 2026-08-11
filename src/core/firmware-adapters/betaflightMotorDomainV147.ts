/**
 * P1-B - the PURE Betaflight API-1.47 MOTOR TEST VALUE DOMAIN resolver.
 *
 * WHAT THIS MODULE IS. A total, side-effect-free function from
 * already-decoded flight-controller configuration to a description of the
 * EXTERNAL VALUE DOMAIN that `MSP_SET_MOTOR` carries: which external
 * values are legal, and which external value the firmware treats as the
 * stop/neutral state. It answers a protocol question, nothing else.
 *
 * WHAT THIS MODULE IS NOT. No I/O, no transport, no MspClient, no timers,
 * no React, no mutable state, and no UI decision. It never says a value is
 * safe, sufficient, idle, or that it will produce any physical effect on
 * an ESC or a motor. Physical consequences remain REQUIRES HARDWARE TEST.
 *
 * WHY A DOMAIN TYPE AT ALL. Stop is NOT a constant. It moves with the
 * protocol family and with FEATURE_3D, and the two move it to DIFFERENT
 * places. A single hardcoded "1000 means stop" is wrong for an analog
 * board whose `mincommand` is 900, and it is dangerously wrong for a 3D
 * configuration where 1000 sits in the reverse region. Every value below
 * is therefore traced to source rather than assumed.
 *
 * ============================ SOURCE PINS ============================
 * All line references are Betaflight 2025.12.2, MSP API 1.47, commit
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e.
 *
 * PROTOCOL FAMILY - src/main/drivers/motor.c, motorGetProtocolFamily():
 *
 *     case MOTOR_PROTOCOL_PWM: case MOTOR_PROTOCOL_ONESHOT125:
 *     case MOTOR_PROTOCOL_ONESHOT42: case MOTOR_PROTOCOL_MULTISHOT:
 *     case MOTOR_PROTOCOL_BRUSHED:      return MOTOR_PROTOCOL_FAMILY_PWM;
 *     case MOTOR_PROTOCOL_DSHOT150: case MOTOR_PROTOCOL_DSHOT300:
 *     case MOTOR_PROTOCOL_DSHOT600: case MOTOR_PROTOCOL_PROSHOT1000:
 *                                       return MOTOR_PROTOCOL_FAMILY_DSHOT;
 *     default:                          return MOTOR_PROTOCOL_FAMILY_UNKNOWN;
 *
 * The raw byte compared here is the wire value from MSP_ADVANCED_CONFIG
 * offset 3, never a display-adjusted one (the official Configurator
 * offsets this enum by one for its dropdown).
 *
 * DIGITAL (DShot family) EXTERNAL MAPPING - src/main/drivers/dshot.c:75-95,
 * dshotConvertFromExternal():
 *
 *     externalValue = constrain(externalValue, PWM_RANGE_MIN, PWM_RANGE_MAX);
 *     if (featureIsEnabled(FEATURE_3D)) {
 *         if (externalValue == PWM_RANGE_MIDDLE)      motorValue = DSHOT_CMD_MOTOR_STOP;
 *         else if (externalValue < PWM_RANGE_MIDDLE)  ... reverse region ...
 *         else                                        ... forward region ...
 *     } else {
 *         motorValue = (externalValue == PWM_RANGE_MIN) ? DSHOT_CMD_MOTOR_STOP : ...;
 *     }
 *
 * with src/main/rx/rx.h:32-35 - PWM_RANGE_MIN 1000, PWM_RANGE_MAX 2000,
 * PWM_RANGE_MIDDLE 1500. Note carefully: for the DShot family the 3D
 * neutral is the PROTOCOL CONSTANT 1500, NOT `neutral3d`.
 *
 * ANALOG (PWM family) EXTERNAL MAPPING - the analog motor device passes
 * the external value straight through, e.g.
 * src/platform/STM32/pwm_output_hw.c / src/platform/APM32/pwm_output_apm32.c:
 *
 *     static float pwmConvertFromExternal(uint16_t externalValue)
 *     { return (float)externalValue; }
 *
 * There is NO constrain() on this path. The firmware therefore imposes no
 * wire bound on an analog MSP_SET_MOTOR value at all: whatever u16 arrives
 * is what the motor device receives. Any analog bound this module reports
 * is consequently a PRODUCT CONTROL POLICY taken from the FC's configured
 * endpoints - never a firmware-accepted or firmware-constrained range.
 *
 * ANALOG STOP / 3D ENDPOINTS - src/main/drivers/motor.c,
 * analogInitEndpoints():
 *
 *     if (featureIsEnabled(FEATURE_3D)) {
 *         *disarm  = flight3DConfig()->neutral3d;
 *         *outputLow  = flight3DConfig()->limit3d_low  + outputLimitOffset;
 *         *outputHigh = flight3DConfig()->limit3d_high - outputLimitOffset;
 *         *deadbandMotor3dHigh = flight3DConfig()->deadband3d_high;
 *         *deadbandMotor3dLow  = flight3DConfig()->deadband3d_low;
 *     } else {
 *         *disarm = motorConfig->mincommand;
 *         ...
 *         *outputHigh = motorConfig->maxthrottle - ...;
 *     }
 *
 * and src/main/pg/motor.h:84-85 - `maxthrottle` is "the maximum value for
 * the ESCs at full power", `mincommand` is "the value for the ESCs when
 * they are not armed ... in some cases this value must be lowered down to
 * 900". That comment is the reason this module refuses to assume 1000.
 *
 * WHAT MSP_SET_MOTOR ACTUALLY WRITES - src/main/msp/msp.c, case
 * MSP_SET_MOTOR: `motor_disarmed[i] = motorConvertFromExternal(...)`, and
 * src/main/flight/mixer.c:487 uses `motor_disarmed[i]` for the output
 * while the craft is disarmed. That is the whole scope of this domain: the
 * disarmed-output vector.
 *
 * NOT EXPOSED BY THE WIRE AT THIS API VERSION. `limit3d_low` and
 * `limit3d_high` do not appear in MSP_MOTOR_3D_CONFIG (124), which carries
 * exactly deadband3d_low, deadband3d_high and neutral3d (6 bytes - see
 * decodeMotor3dConfig.ts). The analog 3D domain therefore cannot be
 * narrowed to the firmware's 3D output endpoints from MSP alone, and this
 * module does not invent them.
 */

import {
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {
  MSP_SET_MOTOR_MAX_MOTOR_COUNT,
  MSP_SET_MOTOR_MIN_MOTOR_COUNT,
} from '../protocol/msp/encoding/encodeSetMotorPayload';

/** src/main/rx/rx.h:32 @ 79065c96 - PWM_RANGE_MIN. */
export const PWM_RANGE_MIN_AT_2025_12_2 = 1000;
/** src/main/rx/rx.h:33 @ 79065c96 - PWM_RANGE_MAX. */
export const PWM_RANGE_MAX_AT_2025_12_2 = 2000;
/** src/main/rx/rx.h:35 @ 79065c96 - PWM_RANGE_MIDDLE = MIN + RANGE/2. */
export const PWM_RANGE_MIDDLE_AT_2025_12_2 = 1500;

/** motorProtocolTypes_e raws, src/main/drivers/motor_types.h @ 79065c96. */
export const MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2 = 0;
export const MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2 = 1;
export const MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2 = 2;
export const MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2 = 3;
export const MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2 = 4;
export const MOTOR_PROTOCOL_RAW_DISABLED_AT_2025_12_2 = 9;

/** motorGetProtocolFamily() PWM-family members @ 79065c96. */
export const MOTOR_PROTOCOL_RAWS_PWM_FAMILY_AT_2025_12_2: readonly number[] =
  Object.freeze([
    MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2,
  ]);

/** motorGetProtocolFamily() DShot-family members @ 79065c96. */
export const MOTOR_PROTOCOL_RAWS_DSHOT_FAMILY_AT_2025_12_2: readonly number[] =
  Object.freeze([
    MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
    MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
  ]);

/** motorProtocolFamily_e @ 79065c96, as a discriminant rather than a number. */
export type MotorProtocolFamily = 'PWM' | 'DSHOT' | 'UNKNOWN';

/**
 * Maps a RAW MSP_ADVANCED_CONFIG offset-3 protocol byte to its firmware
 * family. `MOTOR_PROTOCOL_DISABLED` (9) and anything unrecognised map to
 * `'UNKNOWN'`, exactly as the firmware's `default:` arm does.
 */
export function resolveMotorProtocolFamily(
  motorProtocolRaw: number,
): MotorProtocolFamily {
  if (MOTOR_PROTOCOL_RAWS_DSHOT_FAMILY_AT_2025_12_2.includes(motorProtocolRaw)) {
    return 'DSHOT';
  }
  if (MOTOR_PROTOCOL_RAWS_PWM_FAMILY_AT_2025_12_2.includes(motorProtocolRaw)) {
    return 'PWM';
  }
  return 'UNKNOWN';
}

/** An inclusive external-value region. Protocol description only. */
export interface MotorExternalRegion {
  readonly min: number;
  readonly max: number;
}

/**
 * Where the command-domain bounds come from, so a consumer can never
 * mistake a product policy bound for a firmware guarantee.
 *
 *  FIRMWARE_CONSTRAIN   - the firmware itself clamps the external value to
 *                         these bounds before converting it
 *                         (dshot.c:79 `constrain(externalValue,
 *                         PWM_RANGE_MIN, PWM_RANGE_MAX)`). Stating a
 *                         firmware bound here IS proven by pinned source.
 *
 *  CONFIGURATION_POLICY - the pinned firmware conversion path does NOT
 *                         clamp (`pwmConvertFromExternal` returns the
 *                         value unchanged). The product permits motor-test
 *                         commands within the configured control domain
 *                         `mincommand`..`maxthrottle`; values outside that
 *                         domain are therefore rejected BY PRODUCT POLICY,
 *                         not by a firmware wire bound. This must never be
 *                         described as wire-accepted, firmware-accepted or
 *                         firmware-constrained.
 */
export type MotorCommandDomainSource =
  | 'FIRMWARE_CONSTRAIN'
  | 'CONFIGURATION_POLICY';

/**
 * The external-value domain of one MSP_SET_MOTOR vector element.
 *
 * THREE DIFFERENT THINGS, DELIBERATELY NOT MERGED:
 *
 *  1. COMMAND DOMAIN - `commandDomainMin`..`commandDomainMax`, plus
 *     `domainSource` saying whether the firmware enforces it
 *     (FIRMWARE_CONSTRAIN) or the product does (CONFIGURATION_POLICY).
 *     This is the only bound an encoder should validate against. It is
 *     called a COMMAND domain, not a wire-acceptance domain, because on
 *     the analog path the firmware accepts anything and the bound is
 *     ours.
 *  2. STOP / NEUTRAL - `stopValue`, the external value the pinned firmware
 *     maps to its stop/disarmed output for this exact configuration. A
 *     PROTOCOL SEMANTIC, never a claim about what an ESC or motor does.
 *  3. PROVEN ACTIVE REGIONS - `provenReverseRegion` / `provenForwardRegion`
 *     are populated ONLY where the pinned firmware's own conversion proves
 *     the split. Where it does not, they are ABSENT and the reason is
 *     listed in `notKnowableFromMsp`. They are never approximated.
 *
 * The 3D fields exist only when `feature3dEnabled` is true and are
 * deliberately not flattened into the non-3D shape: with 3D on the domain
 * has a neutral in the MIDDLE and a reverse region BELOW it, so treating
 * the lower bound as stop would describe the exact opposite of a stop.
 */
export interface MotorTestValueDomain {
  readonly motorCount: number;
  readonly protocolFamily: MotorProtocolFamily;
  readonly feature3dEnabled: boolean;
  /** Lower bound of the COMMAND domain - see `domainSource`. */
  readonly commandDomainMin: number;
  /** Upper bound of the COMMAND domain - see `domainSource`. */
  readonly commandDomainMax: number;
  /** Whether the firmware or the product enforces the bounds above. */
  readonly domainSource: MotorCommandDomainSource;
  /** The external value the firmware maps to its stop/disarmed output. */
  readonly stopValue: number;
  /** 3D only: the external value that is the stop/neutral state. */
  readonly neutral?: number;
  /** 3D only: `deadband3d_low` as reported by MSP_MOTOR_3D_CONFIG. */
  readonly deadbandLow?: number;
  /** 3D only: `deadband3d_high` as reported by MSP_MOTOR_3D_CONFIG. */
  readonly deadbandHigh?: number;
  /**
   * 3D only, and ONLY where the pinned conversion proves it: external
   * values the firmware routes to the reverse branch. Absent means the
   * split is not derivable from MSP at this API version - never that
   * there is no reverse region.
   */
  readonly provenReverseRegion?: MotorExternalRegion;
  /** 3D only, and only where proven. See `provenReverseRegion`. */
  readonly provenForwardRegion?: MotorExternalRegion;
  /**
   * Named facts this domain could NOT establish from MSP API 1.47. Empty
   * when everything the type exposes is firmware-proven. A consumer that
   * needs one of these must obtain it elsewhere; it must not be inferred
   * from the command-domain bounds.
   */
  readonly notKnowableFromMsp: readonly string[];
}

/**
 * The bounds an MSP_SET_MOTOR encoder should validate against, extracted
 * from a resolved domain. Deliberately a narrowing projection: an encoder
 * receives the command-domain bounds and nothing that could be mistaken
 * for a proven active range.
 */
export function motorCommandDomainBounds(domain: MotorTestValueDomain): {
  readonly externalMin: number;
  readonly externalMax: number;
} {
  return Object.freeze({
    externalMin: domain.commandDomainMin,
    externalMax: domain.commandDomainMax,
  });
}

/** Already-decoded configuration this resolver needs. Narrow on purpose:
 * nothing here can reach identity, session, battery or telemetry data. */
export interface MotorTestDomainInput {
  /** From MSP_MOTOR_CONFIG offset 6. Never from MSP_MOTOR's fixed slots. */
  readonly motorCount: number;
  /** RAW MSP_ADVANCED_CONFIG offset 3 byte. */
  readonly motorProtocolRaw: number;
  /** FEATURE_3D from MSP_FEATURE_CONFIG - the single authority for 3D. */
  readonly feature3dEnabled: boolean;
  /** MSP_MOTOR_CONFIG `mincommand`. */
  readonly minCommand: number;
  /** MSP_MOTOR_CONFIG `maxthrottle`. */
  readonly maxThrottle: number;
  /** MSP_MOTOR_3D_CONFIG. Required when `feature3dEnabled` is true. */
  readonly motor3d?: {
    readonly deadband3dLow: number;
    readonly deadband3dHigh: number;
    readonly neutral3d: number;
  };
}

export class MotorTestDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorTestDomainError';
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MotorTestDomainError(
      `resolveMotorTestValueDomain: ${label} must be an integer, received ${String(value)}.`,
    );
  }
}

/**
 * Resolves the external-value domain for one flight controller
 * configuration, or throws. It never clamps, defaults, substitutes or
 * infers: a configuration it cannot describe from the pinned sources is
 * rejected rather than approximated.
 */
export function resolveMotorTestValueDomain(
  input: MotorTestDomainInput,
): MotorTestValueDomain {
  assertPositiveInteger(input.motorCount, 'motorCount');
  if (
    input.motorCount < MSP_SET_MOTOR_MIN_MOTOR_COUNT ||
    input.motorCount > MSP_SET_MOTOR_MAX_MOTOR_COUNT
  ) {
    throw new MotorTestDomainError(
      `resolveMotorTestValueDomain: motorCount must be within ` +
        `${MSP_SET_MOTOR_MIN_MOTOR_COUNT}..${MSP_SET_MOTOR_MAX_MOTOR_COUNT}, received ${input.motorCount}. ` +
        'The upper bound is MAX_SUPPORTED_MOTORS (target/common_defaults_post.h:351 @ 79065c96).',
    );
  }

  const protocolFamily = resolveMotorProtocolFamily(input.motorProtocolRaw);
  if (protocolFamily === 'UNKNOWN') {
    throw new MotorTestDomainError(
      `resolveMotorTestValueDomain: raw motor protocol ${String(input.motorProtocolRaw)} has no ` +
        'external-value conversion at this pinned firmware (motorGetProtocolFamily() returns ' +
        'MOTOR_PROTOCOL_FAMILY_UNKNOWN, and MOTOR_PROTOCOL_DISABLED is one such value).',
    );
  }

  assertPositiveInteger(input.minCommand, 'minCommand');
  assertPositiveInteger(input.maxThrottle, 'maxThrottle');

  // ------------------------------------------------------------- 3D ---
  if (input.feature3dEnabled) {
    const motor3d = input.motor3d;
    if (motor3d === undefined) {
      throw new MotorTestDomainError(
        'resolveMotorTestValueDomain: FEATURE_3D is enabled but MSP_MOTOR_3D_CONFIG values were not ' +
          'supplied. With 3D on the stop state moves to a neutral in the middle of the domain, so a ' +
          'domain cannot be described without it.',
      );
    }
    assertPositiveInteger(motor3d.deadband3dLow, 'motor3d.deadband3dLow');
    assertPositiveInteger(motor3d.deadband3dHigh, 'motor3d.deadband3dHigh');
    assertPositiveInteger(motor3d.neutral3d, 'motor3d.neutral3d');

    // DShot 3D neutral is the PROTOCOL CONSTANT PWM_RANGE_MIDDLE
    // (dshot.c:82), not neutral3d. Analog 3D passes the external value
    // through, so its disarm output - neutral3d (motor.c
    // analogInitEndpoints) - IS the external stop value.
    const isDshot = protocolFamily === 'DSHOT';
    const commandDomainMin = isDshot ? PWM_RANGE_MIN_AT_2025_12_2 : input.minCommand;
    const commandDomainMax = isDshot ? PWM_RANGE_MAX_AT_2025_12_2 : input.maxThrottle;
    const neutral = isDshot ? PWM_RANGE_MIDDLE_AT_2025_12_2 : motor3d.neutral3d;

    if (commandDomainMin >= commandDomainMax) {
      throw new MotorTestDomainError(
        `resolveMotorTestValueDomain: command domain ${commandDomainMin}..${commandDomainMax} ` +
          'is empty or inverted.',
      );
    }
    if (neutral <= commandDomainMin || neutral >= commandDomainMax) {
      throw new MotorTestDomainError(
        `resolveMotorTestValueDomain: 3D neutral ${neutral} must sit strictly inside the command ` +
          `domain ${commandDomainMin}..${commandDomainMax}; a neutral at an edge would leave ` +
          'no room on one side of it.',
      );
    }
    if (!(motor3d.deadband3dLow < motor3d.deadband3dHigh)) {
      throw new MotorTestDomainError(
        `resolveMotorTestValueDomain: deadband3dLow ${motor3d.deadband3dLow} must be below ` +
          `deadband3dHigh ${motor3d.deadband3dHigh}.`,
      );
    }

    // WHAT IS PROVEN, PER FAMILY.
    //
    // DShot: dshot.c:79-88 constrains the external value to PWM_RANGE and
    // then branches on PWM_RANGE_MIDDLE, so the two regions ARE the
    // firmware's own routing and can be stated exactly.
    //
    // Analog: the external value is passed through unchanged, and the 3D
    // output endpoints the firmware actually drives are
    // flight3DConfig()->limit3d_low / limit3d_high (motor.c
    // analogInitEndpoints). MSP_MOTOR_3D_CONFIG (124) carries only
    // deadband3d_low, deadband3d_high and neutral3d - six bytes, no
    // limits - so the active regions are NOT derivable from MSP at API
    // 1.47. `mincommand`..`maxthrottle` bounds what we are willing to put
    // on the wire; it is NOT a claim about the movable range, and the
    // regions are therefore left absent rather than approximated. The
    // analog bound below is the PRODUCT's configured control domain, not a
    // firmware wire bound.
    return Object.freeze({
      motorCount: input.motorCount,
      protocolFamily,
      feature3dEnabled: true,
      commandDomainMin,
      commandDomainMax,
      domainSource: isDshot
        ? ('FIRMWARE_CONSTRAIN' as const)
        : ('CONFIGURATION_POLICY' as const),
      stopValue: neutral,
      neutral,
      deadbandLow: motor3d.deadband3dLow,
      deadbandHigh: motor3d.deadband3dHigh,
      ...(isDshot
        ? {
            provenReverseRegion: Object.freeze({
              min: commandDomainMin,
              max: neutral - 1,
            }),
            provenForwardRegion: Object.freeze({
              min: neutral + 1,
              max: commandDomainMax,
            }),
          }
        : {}),
      notKnowableFromMsp: Object.freeze(
        isDshot
          ? []
          : [
              'analog 3D active output endpoints (flight3DConfig limit3d_low / limit3d_high are not carried by MSP_MOTOR_3D_CONFIG at API 1.47)',
            ],
      ),
    });
  }

  // --------------------------------------------------------- non-3D ---
  if (protocolFamily === 'DSHOT') {
    // dshot.c:79 constrains to PWM_RANGE - a firmware-enforced bound - and
    // dshot.c:90 makes exactly PWM_RANGE_MIN the stop value.
    return Object.freeze({
      motorCount: input.motorCount,
      protocolFamily,
      feature3dEnabled: false,
      commandDomainMin: PWM_RANGE_MIN_AT_2025_12_2,
      commandDomainMax: PWM_RANGE_MAX_AT_2025_12_2,
      domainSource: 'FIRMWARE_CONSTRAIN' as const,
      stopValue: PWM_RANGE_MIN_AT_2025_12_2,
      notKnowableFromMsp: Object.freeze([]),
    });
  }

  // Analog: pass-through conversion with NO firmware constrain. The product
  // permits motor-test commands within the configured control domain
  // `mincommand`..`maxthrottle`; the pinned firmware conversion path does
  // not clamp this MSP external value, so values outside this product
  // domain are rejected by PRODUCT POLICY, not by a firmware wire bound.
  // Only the STOP value is firmware-proven here (`*disarm =
  // motorConfig->mincommand`, motor.c analogInitEndpoints).
  //
  // Deliberately NOT widened to the raw u16 range: a professional motor
  // workspace still needs a bounded control domain.
  //
  // The analog non-3D active low is `mincommand + motorIdle * 0.1f`
  // (motor.c analogInitEndpoints), which is a MOTOR-SIDE endpoint, not a
  // wire bound, and is deliberately not folded into these bounds.
  if (input.minCommand >= input.maxThrottle) {
    throw new MotorTestDomainError(
      `resolveMotorTestValueDomain: analog domain requires minCommand < maxThrottle, received ` +
        `${input.minCommand} and ${input.maxThrottle}.`,
    );
  }
  return Object.freeze({
    motorCount: input.motorCount,
    protocolFamily,
    feature3dEnabled: false,
    commandDomainMin: input.minCommand,
    commandDomainMax: input.maxThrottle,
    domainSource: 'CONFIGURATION_POLICY' as const,
    stopValue: input.minCommand,
    notKnowableFromMsp: Object.freeze([
      'analog active output low (motor.c analogInitEndpoints computes mincommand + motorIdle * 0.1f as a motor-side endpoint, not a wire bound)',
    ]),
  });
}
