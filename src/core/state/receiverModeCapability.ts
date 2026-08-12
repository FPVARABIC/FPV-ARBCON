/**
 * RECEIVER P4 - what this product is allowed to WRITE about the receiver.
 *
 * P2 made the active receiver mode readable from firmware truth. Making
 * it writable is a different question, and the answer is not "every mode
 * whose feature bit exists". A feature bit is one input to `rxInit`; a
 * working receiver needs every input that mode consumes. Where we cannot
 * author all of them from the MSP endpoints we actually possess, the
 * mode stays read-only - a dropdown that produces a non-functioning
 * receiver is worse than no dropdown.
 *
 * Pure and total, like receiverRuntimeSemantics: no MSP I/O, no React,
 * no session knowledge. Every claim is quoted from the pinned Betaflight
 * API 1.47 authority (79065c96ba0bb5cdc675e67d7093e05dab8b330e), and
 * each is labelled FIRMWARE FACT (the firmware says so) or CONFIGURATION
 * POLICY (we decided so, for a stated reason).
 */

import type {MspSerialPortRecord} from '../protocol/msp/decoding/decodeSerialPorts';
import {
  resolveModeAvailability, resolveProviderAvailability, selectableProviders,
  type ReceiverBuildAvailability,
} from './receiverBuildCapability';
import {
  FEATURE_RX_MSP_BIT, FEATURE_RX_PARALLEL_PWM_BIT, FEATURE_RX_PPM_BIT,
  FEATURE_RX_SERIAL_MODE_BIT, FEATURE_RX_SPI_BIT, RECEIVER_MODE_FEATURE_MASK,
  resolveReceiverMode, resolveReceiverPortDependency,
  type ReceiverMode, type ReceiverPortDependency,
} from './receiverRuntimeSemantics';

/* ========================================================================
 * CAPABILITY MATRIX
 * ===================================================================== */

export type ReceiverModeWriteClassification =
  /** Selectable: every field this mode consumes is one we can author. */
  | 'WRITABLE'
  /** Displayed when the FC reports it, never offered as a choice. */
  | 'READ_ONLY';

export interface ReceiverModeCapability {
  readonly mode: ReceiverMode;
  /** Always true - P2 decodes all six from the feature mask. */
  readonly readable: true;
  readonly classification: ReceiverModeWriteClassification;
  /** Why, in one sentence, for a reader who did not write this. */
  readonly reason: string;
}

/**
 * FIRMWARE FACT underpinning every row - src/main/rx/rx.c:284-298 and
 * :338 @ pinned 1.47. `rxInit()` is the ONLY site that maps feature bits
 * onto `rxRuntimeState.rxProvider`, and `serialRxInit()` is called from
 * exactly one place: inside `rxInit`'s SERIAL branch. There is no
 * runtime re-initialisation path in the firmware.
 *
 * CONFIGURATION POLICY for the two READ_ONLY rows that are technically
 * authorable (MSP, NONE): both remove the radio as the control source.
 * This product never sends MSP_SET_RAW_RC, so selecting MSP would leave
 * an aircraft with no control input at all, and NONE is not even a bit -
 * it is the absence of all of them. Offering either as an ordinary menu
 * entry would be offering "disable the receiver" next to "choose a
 * receiver". They remain fully DISPLAYED when the FC reports them.
 */
export const RECEIVER_MODE_CAPABILITY: Readonly<Record<ReceiverMode, ReceiverModeCapability>> = Object.freeze({
  SERIAL: Object.freeze({
    mode: 'SERIAL' as const, readable: true as const, classification: 'WRITABLE' as const,
    reason:
      'FEATURE_RX_SERIAL plus rxConfig.serialrx_provider are both MSP-authorable, and the ' +
      'remaining input - a UART carrying FUNCTION_RX_SERIAL - is validated read-only against ' +
      'the canonical Ports truth before the write is allowed.',
  }),
  PPM: Object.freeze({
    mode: 'PPM' as const, readable: true as const, classification: 'WRITABLE' as const,
    reason:
      'FEATURE_RX_PPM is the complete configuration - rxInit consumes no further rxConfig field ' +
      'for the PPM branch - AND its presence is observable: msp_build_info.c emits ' +
      'BUILD_OPTION_RX_PPM (4102) under the same USE_RX_PPM guard as the driver, so the ' +
      'connected build reports it. Offered only when that report actually contains it.',
  }),
  PARALLEL_PWM: Object.freeze({
    mode: 'PARALLEL_PWM' as const, readable: true as const, classification: 'READ_ONLY' as const,
    reason:
      'FIRMWARE FACT: its CONFIGURATION is complete from one feature bit, but msp_build_info.c ' +
      'emits no BUILD_OPTION for parallel PWM at all - there is no BUILD_OPTION_RX_PARALLEL_PWM ' +
      'in msp_build_info.h - so whether the connected build compiled that receiver in is not ' +
      'observable over MSP. Dependency completeness is not build availability, and an ' +
      'unverifiable receiver is not offered.',
  }),
  MSP: Object.freeze({
    mode: 'MSP' as const, readable: true as const, classification: 'READ_ONLY' as const,
    reason:
      'CONFIGURATION POLICY: authorable, but it makes the configurator link the control source ' +
      'and this product never sends MSP_SET_RAW_RC, so selecting it would leave the aircraft ' +
      'with no control input.',
  }),
  SPI: Object.freeze({
    mode: 'SPI' as const, readable: true as const, classification: 'READ_ONLY' as const,
    reason:
      'FIRMWARE FACT: the SPI branch also consumes rxSpiConfig.rx_spi_protocol, rx_spi_id and ' +
      'rx_spi_rf_channel_count (msp.c MSP_SET_RX_CONFIG, rx_spi.h rx_spi_protocol_e has 20 ' +
      'board-specific values), none of which P4 authors, and no MSP endpoint reports which of ' +
      'them a given build compiled in.',
  }),
  NONE: Object.freeze({
    mode: 'NONE' as const, readable: true as const, classification: 'READ_ONLY' as const,
    reason:
      'CONFIGURATION POLICY: NONE is not a feature bit at all - rxInit falls through to it when ' +
      'no RX bit is set - so selecting it means clearing the control source. Disabling the ' +
      'aircraft control input is a destructive action and is deliberately not offered here.',
  }),
});

/**
 * DEPENDENCY completeness only - "could this product author every field
 * the mode consumes". It is a necessary condition, never a sufficient
 * one: the build must also contain the implementation. Callers that are
 * deciding what to OFFER or what to WRITE must use
 * receiverModeIsSelectable / receiverModeWriteIsPermitted instead.
 */
export function receiverModeIsWritable(mode: ReceiverMode): boolean {
  return RECEIVER_MODE_CAPABILITY[mode].classification === 'WRITABLE';
}

/**
 * The final answer for a UI: complete to configure AND proven present in
 * the connected build.
 *
 * SERIAL is special - it is not one driver. It is selectable when the
 * build proves at least one serial provider exists; which one is then a
 * second, per-provider decision (see providerWriteIsPermitted).
 */
export function receiverModeIsSelectable(mode: ReceiverMode, buildOptionIds: ReadonlySet<number> | undefined): boolean {
  if (!receiverModeIsWritable(mode)) return false;
  if (mode === 'SERIAL') return selectableProviders(buildOptionIds).length > 0;
  return resolveModeAvailability(mode, buildOptionIds) === 'AVAILABLE';
}

/** The modes a UI may offer for THIS connected build. */
export function selectableReceiverModes(buildOptionIds: ReadonlySet<number> | undefined): readonly ReceiverMode[] {
  return Object.freeze(WRITABLE_RECEIVER_MODES.filter(mode => receiverModeIsSelectable(mode, buildOptionIds)));
}

/**
 * Whether a provider may be WRITTEN. Proven-present only: NOT_PROVEN is
 * refused, because "we could not check" must never authorise a change
 * that can leave an aircraft with no receiver.
 */
export function providerWriteIsPermitted(provider: number, buildOptionIds: ReadonlySet<number> | undefined): boolean {
  return resolveProviderAvailability(provider, buildOptionIds) === 'AVAILABLE';
}

export type {ReceiverBuildAvailability};

/**
 * The modes a UI may offer, in the order `rxInit` evaluates them, so the
 * list a pilot reads matches the precedence the firmware applies.
 */
export const WRITABLE_RECEIVER_MODES: readonly ReceiverMode[] = Object.freeze(
  (['PARALLEL_PWM', 'PPM', 'SERIAL', 'MSP', 'SPI', 'NONE'] as const).filter(receiverModeIsWritable),
);

/* ========================================================================
 * FEATURE-MASK MUTATION
 * ===================================================================== */

/** The Receiver-owned slice of a feature mask, and nothing else. */
export function receiverOwnedModeBits(mask: number): number {
  // eslint-disable-next-line no-bitwise
  return (mask >>> 0) & RECEIVER_MODE_FEATURE_MASK;
}

const BIT_FOR_MODE: Readonly<Partial<Record<ReceiverMode, number>>> = Object.freeze({
  PARALLEL_PWM: FEATURE_RX_PARALLEL_PWM_BIT,
  PPM: FEATURE_RX_PPM_BIT,
  SERIAL: FEATURE_RX_SERIAL_MODE_BIT,
  MSP: FEATURE_RX_MSP_BIT,
  SPI: FEATURE_RX_SPI_BIT,
});

/**
 * The ONLY legal way this product changes the receiver mode.
 *
 * FIRMWARE FACT - msp.c:3712-3714 @ pinned 1.47: MSP_SET_FEATURE_CONFIG
 * is `featureConfigReplace(sbufReadU32(src))`. It REPLACES the entire
 * 32-bit mask; there is no merge, no partial write, no per-bit endpoint.
 * Anything omitted from the payload is not "left alone", it is cleared.
 *
 * So the mutation is: take the mask the flight controller reported a
 * moment ago, clear ONLY the five Receiver-owned bits, set ONLY the one
 * bit for the intended mode, and return the whole thing. Every unrelated
 * bit - GPS, telemetry, OSD, airmode, and any bit this build has never
 * heard of - passes through bit-for-bit.
 *
 * `current` must be a FRESH read taken inside the save transaction. A
 * cached mask would silently revert whatever another screen changed in
 * the meantime; see ReceiverConfigurationController.save.
 *
 * Throws for a mode this product refuses to write, so the capability
 * matrix cannot be bypassed by calling the mutation directly.
 */
export function applyReceiverModeToFeatureMask(current: number, target: ReceiverMode): number {
  // Dependency completeness is checked here; BUILD availability is
  // enforced by the caller before any I/O, because this function is pure
  // and has no way to see the connected build.
  if (!receiverModeIsWritable(target)) {
    throw new RangeError(`Receiver mode ${target} is not writable: ${RECEIVER_MODE_CAPABILITY[target].reason}`);
  }
  const bit = BIT_FOR_MODE[target];
  if (bit === undefined) throw new RangeError(`Receiver mode ${target} has no feature bit.`);
  // eslint-disable-next-line no-bitwise
  const preserved = (current >>> 0) & ~RECEIVER_MODE_FEATURE_MASK;
  // eslint-disable-next-line no-bitwise
  return (preserved | bit) >>> 0;
}

/**
 * Whether the Receiver-owned bits still hold what the draft was built
 * from. Compares ONLY those bits on purpose: another screen enabling GPS
 * between load and save must not make a Receiver save conflict, but
 * another authority changing the receiver mode must.
 */
export function receiverModeBaseIsStale(loadedMask: number, freshMask: number): boolean {
  return receiverOwnedModeBits(loadedMask) !== receiverOwnedModeBits(freshMask);
}

/* ========================================================================
 * REBOOT CLASSIFICATION
 * ===================================================================== */

export type ReceiverApplyRequirement =
  /** The flight controller's own reboot-required bit said so. */
  | 'FIRMWARE_REPORTED_REBOOT'
  /** Firmware structure proves a restart is needed, but the FC does not
   * raise its flag for this field. */
  | 'STRUCTURAL_REBOOT'
  | 'NO_REBOOT_REQUIRED'
  | 'UNKNOWN';

/**
 * FIRMWARE FACT, verified separately for each of the two settings rather
 * than assumed to behave alike:
 *
 *   MODE     - rx.c:284-298. `rxRuntimeState.rxProvider` is assigned from
 *              the feature bits inside `rxInit()`, which is an init-time
 *              function with no re-entry point anywhere in the firmware.
 *   PROVIDER - rx.c:299. `rxRuntimeState.serialrxProvider` is assigned
 *              from `rxConfig()->serialrx_provider` on the very next line,
 *              inside the same `rxInit()`, and rx.c:338 shows
 *              `serialRxInit()` - the function that switches on it and
 *              installs the actual driver - is called from there and
 *              nowhere else.
 *
 * They land in the same place for the same structural reason, which is
 * why they share one classification; that was established by reading
 * both, not by assuming the second from the first.
 *
 * They are STRUCTURAL_REBOOT rather than FIRMWARE_REPORTED_REBOOT because
 * the firmware does NOT raise its own flag for either: msp.c has exactly
 * five `configRebootUpdateCheckU8` call sites and all five are
 * rc_smoothing fields (msp.c:3779/3780/3781/3807/3815). Neither
 * MSP_SET_FEATURE_CONFIG nor the serialrx_provider byte calls it. So
 * MSP_STATUS_EX will report rebootRequired=0 after a perfectly successful
 * mode or provider change, and a client that trusted only that flag would
 * tell the pilot the new receiver is live when it cannot be.
 */
export const RECEIVER_MODE_APPLY_REQUIREMENT: ReceiverApplyRequirement = 'STRUCTURAL_REBOOT';
export const RECEIVER_PROVIDER_APPLY_REQUIREMENT: ReceiverApplyRequirement = 'STRUCTURAL_REBOOT';

/* ========================================================================
 * TARGET-MODE DEPENDENCY
 * ===================================================================== */

export type ReceiverDependencyVerdict =
  | {readonly kind: 'SATISFIED'}
  | {readonly kind: 'DEPENDENCY_MISSING'}
  | {readonly kind: 'DEPENDENCY_AMBIGUOUS'; readonly portIdentifiers: readonly number[]}
  | {readonly kind: 'DEPENDENCY_UNKNOWN'};

/**
 * The same read-only Ports cross-check P2 applies to the ACTIVE mode,
 * asked about the mode the operator is proposing instead.
 *
 * Reuses resolveReceiverPortDependency rather than restating the rule, so
 * "what counts as a Serial RX UART" has exactly one definition in this
 * codebase. Ports remains a separate configuration authority: this
 * function reads its state and returns a verdict, and nothing in P4
 * writes it.
 */
export function resolveReceiverTargetDependency(
  target: ReceiverMode,
  ports: readonly MspSerialPortRecord[] | undefined,
): ReceiverDependencyVerdict {
  const dependency: ReceiverPortDependency = resolveReceiverPortDependency(target, ports);
  switch (dependency.kind) {
    case 'NOT_APPLICABLE':
    case 'SERIAL_RX_READY':
      return Object.freeze({kind: 'SATISFIED' as const});
    case 'SERIAL_RX_UART_MISSING':
      return Object.freeze({kind: 'DEPENDENCY_MISSING' as const});
    case 'MULTIPLE_SERIAL_RX_ASSIGNMENTS':
      return Object.freeze({kind: 'DEPENDENCY_AMBIGUOUS' as const, portIdentifiers: dependency.portIdentifiers});
    case 'PORT_STATE_UNKNOWN':
      // CONFIGURATION POLICY: no guess. A SERIAL transition written
      // against an unknown Ports state could land on a board with no
      // Serial RX UART at all, and the operator would discover it as a
      // dead receiver after a reboot.
      return Object.freeze({kind: 'DEPENDENCY_UNKNOWN' as const});
  }
}

/**
 * Convenience for the UI: the mode the mask WOULD resolve to after this
 * mutation, computed by the same precedence function that reads it back.
 * Used to prove a proposed write and its read-back agree.
 */
export function receiverModeAfterMutation(current: number, target: ReceiverMode): ReceiverMode {
  return resolveReceiverMode(applyReceiverModeToFeatureMask(current, target));
}
