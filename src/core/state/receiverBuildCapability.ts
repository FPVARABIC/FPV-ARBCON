/**
 * RECEIVER P4 CLOSURE - can this EXACT connected firmware actually run
 * the receiver the operator is about to select?
 *
 * A writable MSP enum value and a compiled receiver driver are different
 * claims. `serialrx_provider` accepts any byte 0..16; whether the driver
 * behind that byte was compiled into the running firmware is decided at
 * build time by `#ifdef USE_SERIALRX_*`, and a board that boots into a
 * provider it has no driver for simply has no receiver.
 *
 * THE AUTHORITATIVE SOURCE, and why it is authoritative:
 *
 *   src/main/msp/msp_build_info.c @ pinned 1.47 is auto-generated from
 *   https://build.betaflight.com/api/options/2025.12 and compiled INTO
 *   the firmware. `sbufWriteBuildInfoFlags()` walks a table in which
 *   every entry is wrapped in the same `#ifdef` that guards the driver
 *   itself, so the u16 list appended to MSP_BUILD_INFO (API >= 1.46) is
 *   the running build's own preprocessor state, reported by the board we
 *   are connected to. It is not a target-family guess, not a catalogue
 *   fetched over the network, and not a Configurator list copied from
 *   another version.
 *
 * This product already trusts exactly this list elsewhere:
 * serialPortsModel gates serial ROLES by these ids and
 * generalConfigurationModel gates FEATURES by them, using the same
 * decodeBuildOptions() output and the same id space (GPS=16412,
 * LED_STRIP=16413, TELEMETRY_FRSKY_HUB=12301 all match
 * msp_build_info.h verbatim).
 *
 * Pure and total: no MSP I/O, no React, no session knowledge.
 */

import {
  FEATURE_RX_PARALLEL_PWM_BIT, FEATURE_RX_PPM_BIT,
  type ReceiverMode,
} from './receiverRuntimeSemantics';

/* ========================================================================
 * BUILD OPTION IDS - src/main/msp/msp_build_info.h @ pinned 1.47
 * ===================================================================== */

export const BUILD_OPTION_SERIALRX_CRSF = 4097;
export const BUILD_OPTION_SERIALRX_FPORT = 4098;
export const BUILD_OPTION_SERIALRX_GHST = 4099;
export const BUILD_OPTION_SERIALRX_IBUS = 4100;
export const BUILD_OPTION_SERIALRX_JETIEXBUS = 4101;
export const BUILD_OPTION_RX_PPM = 4102;
export const BUILD_OPTION_SERIALRX_SBUS = 4103;
export const BUILD_OPTION_SERIALRX_SPEKTRUM = 4104;
export const BUILD_OPTION_SERIALRX_SRXL2 = 4105;
export const BUILD_OPTION_SERIALRX_SUMD = 4106;
export const BUILD_OPTION_SERIALRX_SUMH = 4107;
export const BUILD_OPTION_SERIALRX_XBUS = 4108;
export const BUILD_OPTION_SERIALRX_MAVLINK = 4109;

/**
 * The evidence state for one selectable implementation. Three values, not
 * two, because "we asked and it is absent" and "we could not ask" are
 * different facts and lead to different, honest wording.
 */
export type ReceiverBuildAvailability =
  /** The connected build reported the option that guards this driver. */
  | 'AVAILABLE'
  /** The build reported its options and this one was NOT among them. */
  | 'UNAVAILABLE'
  /** No option list (older firmware, or a driver the list does not cover),
   * so nothing is known either way. Never rendered as "supported". */
  | 'NOT_PROVEN';

/**
 * provider enum value -> the build option that guards its driver.
 *
 * FIRMWARE FACT, read from the `#ifdef` grouping in `serialRxInit`
 * (rx.c) rather than inferred from the names: SRXL(10), SPEKTRUM1024(15)
 * and SPEKTRUM2048(1) all sit under one `USE_SERIALRX_SPEKTRUM` guard,
 * and XBUS_MODE_B(5) with XBUS_MODE_B_RJ01(6) under one
 * `USE_SERIALRX_XBUS`. Their entries therefore share one option id.
 *
 * ABSENT ON PURPOSE:
 *   NONE(0)           - not a driver at all.
 *   TARGET_CUSTOM(11) - guarded by USE_SERIALRX_TARGET_CUSTOM, for which
 *                       msp_build_info.c emits NO option, so its presence
 *                       is not reported by any firmware we can ask.
 * Both resolve to NOT_PROVEN and are never offered.
 */
const PROVIDER_BUILD_OPTION: Readonly<Record<number, number>> = Object.freeze({
  1: BUILD_OPTION_SERIALRX_SPEKTRUM,   // SPEKTRUM2048
  2: BUILD_OPTION_SERIALRX_SBUS,
  3: BUILD_OPTION_SERIALRX_SUMD,
  4: BUILD_OPTION_SERIALRX_SUMH,
  5: BUILD_OPTION_SERIALRX_XBUS,       // XBUS_MODE_B
  6: BUILD_OPTION_SERIALRX_XBUS,       // XBUS_MODE_B_RJ01
  7: BUILD_OPTION_SERIALRX_IBUS,
  8: BUILD_OPTION_SERIALRX_JETIEXBUS,
  9: BUILD_OPTION_SERIALRX_CRSF,
  10: BUILD_OPTION_SERIALRX_SPEKTRUM,  // SRXL v1
  12: BUILD_OPTION_SERIALRX_FPORT,
  13: BUILD_OPTION_SERIALRX_SRXL2,
  14: BUILD_OPTION_SERIALRX_GHST,
  15: BUILD_OPTION_SERIALRX_SPEKTRUM,  // SPEKTRUM1024
  16: BUILD_OPTION_SERIALRX_MAVLINK,
});

/**
 * An EMPTY or absent set means the board did not report a list - older
 * firmware, or a build predating API 1.46. That is NOT_PROVEN, never
 * UNAVAILABLE: the same convention serialPortsModel and
 * generalConfigurationModel already apply to this list.
 */
function evidence(optionId: number | undefined, buildOptionIds: ReadonlySet<number> | undefined): ReceiverBuildAvailability {
  if (optionId === undefined) return 'NOT_PROVEN';
  if (buildOptionIds === undefined || buildOptionIds.size === 0) return 'NOT_PROVEN';
  return buildOptionIds.has(optionId) ? 'AVAILABLE' : 'UNAVAILABLE';
}

export function resolveProviderAvailability(provider: number, buildOptionIds: ReadonlySet<number> | undefined): ReceiverBuildAvailability {
  return evidence(PROVIDER_BUILD_OPTION[provider], buildOptionIds);
}

/**
 * The providers a UI may OFFER: proven present, and nothing else.
 * NOT_PROVEN is deliberately excluded - an unverified destructive choice
 * is exactly what this closure pass exists to remove.
 */
export function selectableProviders(buildOptionIds: ReadonlySet<number> | undefined): readonly number[] {
  return Object.freeze(
    Object.keys(PROVIDER_BUILD_OPTION)
      .map(Number)
      .filter(provider => resolveProviderAvailability(provider, buildOptionIds) === 'AVAILABLE')
      .sort((left, right) => left - right),
  );
}

/* ========================================================================
 * MODE AVAILABILITY
 * ===================================================================== */

/**
 * FIRMWARE FACT, and the reason PPM and PARALLEL_PWM part company here
 * even though their CONFIGURATION is equally complete:
 *
 *   msp_build_info.c emits BUILD_OPTION_RX_PPM under `#ifdef USE_RX_PPM`,
 *   so PPM availability is reported by the connected build.
 *
 *   It emits NOTHING for parallel PWM. There is no
 *   BUILD_OPTION_RX_PARALLEL_PWM in msp_build_info.h at all, so whether
 *   the running firmware compiled that receiver in is not observable
 *   over MSP by any means this product possesses.
 *
 * SERIAL is not a single driver, so it has no option of its own; its
 * availability is the availability of the provider that will be used.
 */
export function resolveModeAvailability(mode: ReceiverMode, buildOptionIds: ReadonlySet<number> | undefined): ReceiverBuildAvailability {
  if (mode === 'PPM') return evidence(BUILD_OPTION_RX_PPM, buildOptionIds);
  if (mode === 'PARALLEL_PWM') return 'NOT_PROVEN';
  return 'NOT_PROVEN';
}

/** The feature bits whose availability this module can speak for. */
export const RECEIVER_MODE_BUILD_OPTION: Readonly<Partial<Record<ReceiverMode, number>>> = Object.freeze({
  PPM: BUILD_OPTION_RX_PPM,
});

/** Present so the PARALLEL_PWM decision is greppable from its bit. */
export const UNREPORTED_MODE_BITS: readonly number[] = Object.freeze([FEATURE_RX_PARALLEL_PWM_BIT]);
export const REPORTED_MODE_BITS: readonly number[] = Object.freeze([FEATURE_RX_PPM_BIT]);
