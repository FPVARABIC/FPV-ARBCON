/**
 * SETUP R9 - the pure model behind the compact status area.
 *
 * =====================================================================
 * WHAT THIS ROUND CHANGED, AND WHY A MODEL WAS NEEDED FOR IT
 * =====================================================================
 *
 * Setup used to open with a 139px teal bar carrying three facts (board,
 * firmware family, arming badge) and then spend the next 1300px getting
 * to the aircraft. Battery sat at y=1403 on a 1920 desktop, the sensor
 * chips at y=1849. An operator who connects a board wants to know, in
 * this order: is it talking to me, what is it, is it armed, what is the
 * pack doing, and which sensors did it find. All five of those now sit
 * above the 3D model, in one dense strip.
 *
 * Compressing them into chips is a PRESENTATION change, but two of the
 * five carry a truth rule that must not live in a component:
 *
 *  1. THE BATTERY SUMMARY. BatteryCard already refused to print a
 *     residual voltage-divider reading as a pack voltage (Checkpoint F /
 *     HW-002: a real board reported 0.17 V with no pack attached). A chip
 *     has far less room to explain itself than a card did, so the
 *     distinction is moved OUT of the renderer and into a tested
 *     derivation - a chip cannot accidentally drop the guard when
 *     somebody shortens it later.
 *
 *  2. WHEN A WARNING STRIP IS WARRANTED. The strip used to render in all
 *     four readiness states, so "arming state not confirmed" occupied a
 *     74px full-width alert on a screen where nothing was wrong. An alert
 *     that is always on is not an alert. The rule for "is this worth
 *     interrupting the operator" is a safety decision and belongs beside
 *     the rest of the safety model, not inside a layout file.
 *
 * Pure, like every other module under src/core: no React, no i18n, no
 * clock, no I/O. It emits states and numbers; src/i18n owns the wording.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It invents nothing. There is no
 * "unknown means zero" anywhere below: every absence is its own named
 * state, so a renderer is forced to say "not available" rather than
 * print a plausible number the flight controller never sent.
 */

import type {ArmingReadiness} from './armingReadiness';
import type {BatteryFirmwareState} from './batteryTelemetry';
import {deriveBatterySemantics} from './batteryTelemetry';
import type {MspBatteryState} from '../protocol';
import type {TelemetryValue} from '../protocol';

/* ------------------------------------------------------------------ *
 * Battery, compressed to one chip without losing the HW-002 guard
 * ------------------------------------------------------------------ */

export type SetupBatterySummary =
  /** No battery reading exists for this session right now. */
  | {readonly kind: 'UNAVAILABLE'}
  /** The poll is registered and the first reading has not landed. */
  | {readonly kind: 'WAITING'}
  /** The channel itself failed. */
  | {readonly kind: 'ERROR'}
  /**
   * The FIRMWARE says there is no pack (cellCount 0, or its own
   * BATTERY_NOT_PRESENT enum member). The measured voltage is still
   * carried - hiding a genuine reading was never acceptable - but it is
   * labelled as a raw reading, never as a pack voltage.
   */
  | {
      readonly kind: 'NO_PACK';
      readonly rawVoltageVolts: number;
      readonly firmwareState: BatteryFirmwareState;
      readonly stale: boolean;
    }
  /** The firmware proved a pack, so the voltage is a pack voltage. */
  | {
      readonly kind: 'MEASURED';
      readonly voltageVolts: number;
      readonly cellCount: number;
      readonly firmwareState: BatteryFirmwareState;
      /** Reported only when the FC sent a NON-ZERO value: this command
       * cannot tell a residual register from an absent meter, so a zero
       * is withheld rather than printed as a measurement. */
      readonly amps: number | undefined;
      readonly consumedMah: number | undefined;
      readonly stale: boolean;
    };

export function deriveSetupBatterySummary(
  telemetry: TelemetryValue<MspBatteryState>,
): SetupBatterySummary {
  if (telemetry.status === 'UNAVAILABLE') {
    return Object.freeze({kind: 'UNAVAILABLE' as const});
  }
  if (telemetry.status === 'WAITING') {
    return Object.freeze({kind: 'WAITING' as const});
  }
  if (telemetry.status === 'ERROR') {
    return Object.freeze({kind: 'ERROR' as const});
  }

  const stale = telemetry.status === 'STALE';
  const semantics = deriveBatterySemantics(telemetry.value);
  /* The SAME two-part discriminator BatteryCard used, moved here
     verbatim in meaning: the firmware's own cellCount===0 ("battery not
     detected", msp.c's own encoder comment) and its own NOT_PRESENT enum
     member. No app-invented minimum-voltage threshold is introduced, and
     none may be: this module still cannot judge a voltage. */
  const measurementProven =
    semantics.detection === 'DETECTED' &&
    semantics.firmwareState !== 'NOT_PRESENT';

  if (!measurementProven) {
    return Object.freeze({
      kind: 'NO_PACK' as const,
      rawVoltageVolts: semantics.voltageVolts,
      firmwareState: semantics.firmwareState,
      stale,
    });
  }

  return Object.freeze({
    kind: 'MEASURED' as const,
    voltageVolts: semantics.voltageVolts,
    cellCount: semantics.cellCount,
    firmwareState: semantics.firmwareState,
    amps:
      semantics.current.sensorValidity === 'REPORTED_NONZERO'
        ? semantics.current.centiamps / 100
        : undefined,
    consumedMah:
      semantics.consumed.sensorValidity === 'REPORTED_NONZERO'
        ? semantics.consumed.mah
        : undefined,
    stale,
  });
}

/* ------------------------------------------------------------------ *
 * When an alert strip is actually an alert
 * ------------------------------------------------------------------ */

/**
 * TRUE only when the readiness state is something an operator must act
 * on or be physically careful around:
 *
 *   ARMED   - props may spin. A full-width hazard strip is exactly
 *             proportionate.
 *   BLOCKED - the firmware is refusing to arm and named its reasons.
 *             Those reasons are the actionable content of the strip.
 *
 * FALSE for READY and for UNKNOWN. Both still reach the operator - they
 * are rendered as a chip in the compact status area, which is where a
 * steady-state fact belongs. UNKNOWN in particular was the whole reason
 * this predicate exists: on a board that answers everything else
 * correctly, "arming state not confirmed" is the NORMAL reading whenever
 * the BOXIDS mapping has not settled, and a permanent 74px warning for a
 * normal reading teaches operators to ignore the strip.
 *
 * NOTE what this is not: it is not a claim that UNKNOWN is safe. Nothing
 * below downgrades, hides or reinterprets the readiness value - the same
 * ArmingReadiness object still drives the chip, the FC-tool gate and the
 * diagnostics list. This decides one thing only: whether the state is
 * worth an interrupt-shaped surface.
 */
export function isSetupSafetyStripWarranted(
  readiness: ArmingReadiness,
): boolean {
  return readiness.status === 'ARMED' || readiness.status === 'BLOCKED';
}
