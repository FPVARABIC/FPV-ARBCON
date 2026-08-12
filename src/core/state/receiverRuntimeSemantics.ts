/**
 * RECEIVER P2 - firmware truth for Receiver runtime state.
 *
 * Pure and total. No MSP I/O, no React, no session knowledge: every
 * function here maps values the flight controller already reported onto
 * a semantic this product can display honestly. Everything that needs a
 * transport lives in ReceiverConfigurationController.
 *
 * EVIDENCE. Every constant below is quoted from the pinned Betaflight
 * API 1.47 authority (commit 79065c96ba0bb5cdc675e67d7093e05dab8b330e),
 * the same pin mspCommandSources.ts records. 1.48 is used only where
 * explicitly noted as forward parity.
 */

import type {MspSerialPortRecord} from '../protocol/msp/decoding/decodeSerialPorts';
import {hasSerialRole} from './serialPortsModel';

/* ========================================================================
 * RECEIVER MODE
 * ===================================================================== */

/**
 * FIRMWARE FACT - src/main/config/feature.h:46-66 @ pinned 1.47.
 *
 *   FEATURE_RX_PPM          = 1 << 0
 *   FEATURE_RX_SERIAL       = 1 << 3
 *   FEATURE_RX_PARALLEL_PWM = 1 << 13
 *   FEATURE_RX_MSP          = 1 << 14
 *   FEATURE_RX_SPI          = 1 << 25
 *
 * Written as `2 ** n` rather than `1 << n` so the CONSTANTS need no lint
 * suppression; the values are identical and the exponent still reads as
 * the bit position the firmware declares. This mirrors
 * decodeFeatureConfig.ts's own FEATURE_3D_BIT precedent.
 *
 * NOTE these are FEATURE bits, not the serialrx_provider enum. Receiver
 * MODE and serial PROVIDER are different concepts in this firmware and
 * are deliberately kept apart throughout this module.
 */
export const FEATURE_RX_PPM_BIT = 2 ** 0;
export const FEATURE_RX_SERIAL_MODE_BIT = 2 ** 3;
export const FEATURE_RX_PARALLEL_PWM_BIT = 2 ** 13;
export const FEATURE_RX_MSP_BIT = 2 ** 14;
export const FEATURE_RX_SPI_BIT = 2 ** 25;

export type ReceiverMode =
  | 'PARALLEL_PWM'
  | 'PPM'
  | 'SERIAL'
  | 'MSP'
  | 'SPI'
  | 'NONE';

/**
 * The complete set of feature bits this module claims authority over.
 * Used by any future mask mutation to know exactly which bits are
 * "Receiver mode" and therefore mutually exclusive; every other bit in
 * the mask belongs to somebody else and must survive untouched.
 */
export const RECEIVER_MODE_FEATURE_MASK =
  FEATURE_RX_PPM_BIT |
  FEATURE_RX_SERIAL_MODE_BIT |
  FEATURE_RX_PARALLEL_PWM_BIT |
  FEATURE_RX_MSP_BIT |
  FEATURE_RX_SPI_BIT;

function bitIsSet(mask: number, bit: number): boolean {
  // A genuine bitmask test against a verified firmware bit; suppressed
  // narrowly rather than widening the repository's no-bitwise baseline.
  // eslint-disable-next-line no-bitwise
  return ((mask >>> 0) & bit) !== 0;
}

/**
 * FIRMWARE FACT - src/main/rx/rx.c:284-298 @ pinned 1.47, quoted:
 *
 *   if (featureIsEnabled(FEATURE_RX_PARALLEL_PWM))      PARALLEL_PWM
 *   else if (featureIsEnabled(FEATURE_RX_PPM))          PPM
 *   else if (featureIsEnabled(FEATURE_RX_SERIAL))       SERIAL
 *   else if (featureIsEnabled(FEATURE_RX_MSP))          MSP
 *   else if (featureIsEnabled(FEATURE_RX_SPI))          SPI
 *   else                                                NONE
 *
 * The bits are NOT mutually exclusive in storage - nothing stops several
 * being set at once - so the FIRST MATCH in this exact order is what the
 * flight controller actually runs. Reproducing the order is the whole
 * point: a client that reports "SPI" because it checked that bit first
 * would be describing a receiver the FC is not using.
 *
 * Deliberately NOT derived from serialrx_provider: that value persists in
 * the RX_CONFIG payload whatever the active mode is, so a board running
 * RX_SPI can still report a stored provider of CRSF. See
 * receiverProviderIsMeaningful().
 */
export function resolveReceiverMode(enabledFeaturesRaw: number): ReceiverMode {
  if (bitIsSet(enabledFeaturesRaw, FEATURE_RX_PARALLEL_PWM_BIT)) {
    return 'PARALLEL_PWM';
  }
  if (bitIsSet(enabledFeaturesRaw, FEATURE_RX_PPM_BIT)) {
    return 'PPM';
  }
  if (bitIsSet(enabledFeaturesRaw, FEATURE_RX_SERIAL_MODE_BIT)) {
    return 'SERIAL';
  }
  if (bitIsSet(enabledFeaturesRaw, FEATURE_RX_MSP_BIT)) {
    return 'MSP';
  }
  if (bitIsSet(enabledFeaturesRaw, FEATURE_RX_SPI_BIT)) {
    return 'SPI';
  }
  return 'NONE';
}

/**
 * Whether the stored serialrx_provider describes the receiver the FC is
 * ACTUALLY running. True only in SERIAL mode.
 *
 * This is not an error condition. A stored provider alongside a non-
 * serial active mode is ordinary firmware state (the value is simply not
 * consulted by rxInit for that mode), and labelling it a fault would be
 * inventing a problem the firmware does not have.
 */
export function receiverProviderIsMeaningful(mode: ReceiverMode): boolean {
  return mode === 'SERIAL';
}

/* ========================================================================
 * PORTS / UART DEPENDENCY
 * ===================================================================== */

export type ReceiverPortDependency =
  /** The active mode does not use a serial UART at all. */
  | {readonly kind: 'NOT_APPLICABLE'; readonly mode: ReceiverMode}
  /** Serial receiver mode, exactly one UART carries Serial RX. */
  | {readonly kind: 'SERIAL_RX_READY'; readonly portIdentifier: number}
  /** Serial receiver mode, but no UART has the Serial RX function. */
  | {readonly kind: 'SERIAL_RX_UART_MISSING'}
  /** More than one UART claims Serial RX. */
  | {readonly kind: 'MULTIPLE_SERIAL_RX_ASSIGNMENTS'; readonly portIdentifiers: readonly number[]}
  /** Ports could not be read, so no claim is made either way. */
  | {readonly kind: 'PORT_STATE_UNKNOWN'};

/**
 * Cross-checks the ACTIVE receiver mode against the REAL serial port
 * configuration. Read-only by construction - this function returns a
 * verdict and mutates nothing; Receiver never writes Ports.
 *
 * IMPORTANT SEMANTIC LIMIT, stated because a UI must not overstate it: a
 * UART configured for Serial RX proves only that the FC is listening on
 * that port. It does NOT prove a receiver is physically connected,
 * powered, bound, or transmitting. This verdict is about CONFIGURATION
 * consistency, never about wiring.
 *
 * FIRMWARE FACT for the role bit - src/main/io/serial.h:43 @ pinned 1.47:
 * `FUNCTION_RX_SERIAL = (1 << 6)`. Tested here through the existing
 * canonical serialPortsModel role table rather than a second copy of the
 * bit, so Ports remains the single authority on port semantics.
 *
 * CONFIGURATION POLICY for the multiple-assignment verdict: the firmware
 * itself does not reject two ports both claiming Serial RX, but only one
 * receiver can be active, so reporting the ambiguity is more truthful
 * than silently picking one. serialPortsModel already declares
 * `maxPorts: 1` for this role.
 */
export function resolveReceiverPortDependency(
  mode: ReceiverMode,
  ports: readonly MspSerialPortRecord[] | undefined,
): ReceiverPortDependency {
  if (mode !== 'SERIAL') {
    return Object.freeze({kind: 'NOT_APPLICABLE' as const, mode});
  }
  if (ports === undefined) {
    return Object.freeze({kind: 'PORT_STATE_UNKNOWN' as const});
  }
  const assigned = ports.filter(port => hasSerialRole(port, 'RX_SERIAL'));
  if (assigned.length === 0) {
    return Object.freeze({kind: 'SERIAL_RX_UART_MISSING' as const});
  }
  if (assigned.length > 1) {
    return Object.freeze({
      kind: 'MULTIPLE_SERIAL_RX_ASSIGNMENTS' as const,
      portIdentifiers: Object.freeze(assigned.map(port => port.identifier)),
    });
  }
  return Object.freeze({
    kind: 'SERIAL_RX_READY' as const,
    portIdentifier: assigned[0].identifier,
  });
}

/* ========================================================================
 * SIGNAL / FAILSAFE INDICATION
 * ===================================================================== */

/**
 * FIRMWARE FACT - src/main/fc/runtime_config.h:43-47 @ pinned 1.47:
 *
 *   ARMING_DISABLED_FAILSAFE    = (1 << 1)
 *   ARMING_DISABLED_RX_FAILSAFE = (1 << 2)   // "RXLOSS" in the UI/OSD
 *   ARMING_DISABLED_BOXFAILSAFE = (1 << 4)
 *
 * The pre-P2 screen tested bits 1 and 2 with inline arithmetic and MISSED
 * bit 4 entirely, so an operator-induced failsafe (the BOXFAILSAFE switch)
 * displayed as a normal live link. Betaflight Configurator's own receiver
 * tab tests all three.
 *
 * Index === bit position, matching armingBlockers.ts's canonical token
 * table, so these stay verifiable against one ordering rather than two.
 */
export const RECEIVER_FAILSAFE_BIT = 2 ** 1;
export const RECEIVER_RXLOSS_BIT = 2 ** 2;
export const RECEIVER_BOXFAILSAFE_BIT = 2 ** 4;

export type ReceiverSignalState =
  /** Status was read and none of the failsafe-related flags are set. */
  | {readonly kind: 'LIVE'}
  /** The receiver is not delivering a valid frame (RX_FAILSAFE / RXLOSS). */
  | {readonly kind: 'RX_LOSS'}
  /** The flight controller's failsafe stage is engaged. */
  | {readonly kind: 'FAILSAFE_ACTIVE'}
  /** Failsafe was induced deliberately through the BOXFAILSAFE mode. */
  | {readonly kind: 'BOXFAILSAFE_ACTIVE'}
  /** No usable status sample - never rendered as "fine". */
  | {readonly kind: 'UNKNOWN'};

/**
 * Resolves the operator-visible signal state from the arming-disable
 * mask.
 *
 * Precedence is UI POLICY, not firmware: the flags are independent and
 * several can be set at once. The order below reports the most specific
 * CAUSE first - a deliberate BOXFAILSAFE is more informative than the
 * generic FAILSAFE it necessarily also raises, and a genuine RX loss is
 * more informative still, because it is the one the pilot did not choose.
 *
 * `undefined` means "no status sample", which is deliberately its own
 * state: a Receiver screen that cannot read status must not imply the
 * link is healthy.
 */
export function resolveReceiverSignalState(
  armingDisableFlags: number | undefined,
): ReceiverSignalState {
  if (armingDisableFlags === undefined || !Number.isFinite(armingDisableFlags)) {
    return Object.freeze({kind: 'UNKNOWN' as const});
  }
  if (bitIsSet(armingDisableFlags, RECEIVER_RXLOSS_BIT)) {
    return Object.freeze({kind: 'RX_LOSS' as const});
  }
  if (bitIsSet(armingDisableFlags, RECEIVER_BOXFAILSAFE_BIT)) {
    return Object.freeze({kind: 'BOXFAILSAFE_ACTIVE' as const});
  }
  if (bitIsSet(armingDisableFlags, RECEIVER_FAILSAFE_BIT)) {
    return Object.freeze({kind: 'FAILSAFE_ACTIVE' as const});
  }
  return Object.freeze({kind: 'LIVE' as const});
}

/** True when the displayed channel values may be failsafe OUTPUT rather
 * than live receiver data - the fact a pilot most needs stated plainly. */
export function receiverValuesMayBeFailsafeOutput(state: ReceiverSignalState): boolean {
  return state.kind === 'RX_LOSS' || state.kind === 'FAILSAFE_ACTIVE' || state.kind === 'BOXFAILSAFE_ACTIVE';
}

/* ========================================================================
 * RSSI SOURCE
 * ===================================================================== */

/**
 * FIRMWARE FACT - src/main/rx/rx.h:152-161 @ pinned 1.47, the
 * `rssiSource_e` enum, reported by MSP_TX_INFO (187) byte 0
 * (src/main/msp/msp.c:2164-2176).
 *
 * This is the SOURCE the firmware is using, not a signal value and not a
 * link quality. Index === enum value.
 */
export const RSSI_SOURCE_TOKENS: readonly string[] = Object.freeze([
  'NONE',
  'ADC',
  'RX_CHANNEL',
  'RX_PROTOCOL',
  'MSP',
  'FRAME_ERRORS',
  'RX_PROTOCOL_CRSF',
  'RX_PROTOCOL_MAVLINK',
]);

export type ReceiverRssiSource =
  | {readonly kind: 'KNOWN'; readonly token: string; readonly value: number}
  /** The FC answered, but with a value this pinned API does not define. */
  | {readonly kind: 'UNRECOGNISED'; readonly value: number}
  /** The command was not answered or was never attempted. */
  | {readonly kind: 'UNAVAILABLE'};

export function resolveRssiSource(value: number | undefined): ReceiverRssiSource {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return Object.freeze({kind: 'UNAVAILABLE' as const});
  }
  const token = RSSI_SOURCE_TOKENS[value];
  return token === undefined
    ? Object.freeze({kind: 'UNRECOGNISED' as const, value})
    : Object.freeze({kind: 'KNOWN' as const, token, value});
}
