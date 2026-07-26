/**
 * Pass 7.7, Region 5 (أدوات وحدة التحكم) - the PURE authorization model
 * for the three source-proven FC tools. No React, no MSP traffic, no
 * timers: this decides ONLY whether a control may be enabled and, when
 * it may not, the ONE exact reason to show the user.
 *
 * A cached state is never authorization by itself - it only decides
 * whether the CONTROL is enabled. Every write additionally re-proves its
 * preconditions from a FRESH on-demand reading inside the exclusive
 * transaction (FcToolsController), using this same function so the two
 * checks can never disagree.
 *
 * Only operations whose MSP contract AND persistence behavior are proven
 * safe at the pinned API-1.47 authority exist here (see
 * mspCommandSources.ts §"PASS 7.7, REGION 5"):
 *  - ACC_CALIBRATION  (MSP_ACC_CALIBRATION 205, persists FC-side via the
 *    firmware's own saveConfigAndNotify())
 *  - MAG_CALIBRATION  (MSP_MAG_CALIBRATION 206, same; requires a
 *    magnetometer REPORTED AS DETECTED)
 *  - REBOOT           (MSP_REBOOT 68, empty payload = normal firmware
 *    reboot)
 * Nothing else is offered: no motor test/control, no arming, no factory
 * reset, no flashing, no bootloader, no CLI, no EEPROM write, and no
 * permanently dead placeholder.
 */

import type {ArmedState, SensorPresenceBit} from './armingBlockers';
import type {DiagnosticsCompatibility, DiagnosticsDataState} from './setupDiagnostics';

export type FcToolId = 'ACC_CALIBRATION' | 'MAG_CALIBRATION' | 'REBOOT';

export const FC_TOOL_IDS: readonly FcToolId[] = Object.freeze(['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']);

/** Exactly one reason is surfaced per disabled control, and every one of
 * them is a concrete, checkable fact - never a vague "unavailable". */
export type FcToolBlockReason =
  | 'DISCONNECTED'
  | 'BACKGROUNDED'
  | 'BUSY'
  | 'RECOVERING'
  | 'IDENTIFYING'
  | 'INCOMPATIBLE'
  | 'NO_READING'
  | 'STALE_READING'
  | 'ARMED'
  | 'ARMED_UNKNOWN'
  | 'SENSOR_NOT_DETECTED';

export interface FcToolAvailability {
  readonly tool: FcToolId;
  readonly enabled: boolean;
  /** Defined exactly when enabled === false. */
  readonly reason: FcToolBlockReason | undefined;
}

export interface FcToolGateInput {
  /** Ownership state is ACTIVE. */
  readonly connected: boolean;
  /** AppState is 'active'. */
  readonly appActive: boolean;
  /** Any FC-tool transaction (including an open confirmation) is
   * in progress - the SHARED mutex is held. */
  readonly busy: boolean;
  /** MspClient is mid-desync/recovery, closing or being replaced. */
  readonly recovering: boolean;
  readonly compatibility: DiagnosticsCompatibility;
  /** The Region-4 lifecycle verdict for the shared STATUS_EX channel. */
  readonly dataState: DiagnosticsDataState;
  /** Derived ONLY through the BOXIDS mapping - never from blockers. */
  readonly armedState: ArmedState;
  /** From the same reading; used only for MAG_CALIBRATION's requirement. */
  readonly sensors: readonly SensorPresenceBit[] | undefined;
}

function magnetometerDetected(sensors: readonly SensorPresenceBit[] | undefined): boolean {
  return sensors !== undefined && sensors.some(bit => bit.kind === 'KNOWN' && bit.token === 'MAG');
}

/**
 * Resolution order is deliberate and fixed: the most fundamental,
 * least-recoverable condition is reported first, so the user is never
 * told "the reading is stale" when the real situation is that the cable
 * is unplugged.
 */
export function resolveFcToolAvailability(tool: FcToolId, input: FcToolGateInput): FcToolAvailability {
  const blocked = (reason: FcToolBlockReason): FcToolAvailability => ({tool, enabled: false, reason});

  if (!input.connected) {
    return blocked('DISCONNECTED');
  }
  if (!input.appActive) {
    return blocked('BACKGROUNDED');
  }
  if (input.busy) {
    return blocked('BUSY');
  }
  if (input.recovering) {
    return blocked('RECOVERING');
  }
  if (input.compatibility === 'IDENTIFYING') {
    return blocked('IDENTIFYING');
  }
  if (input.compatibility !== 'BETAFLIGHT_API_1_47') {
    // Covers IDENTIFICATION_FAILED and any other firmware/API pair: the
    // pinned contract is the ONLY one these writes were proven against.
    return blocked('INCOMPATIBLE');
  }
  if (input.dataState !== 'FRESH' && input.dataState !== 'STALE') {
    return blocked('NO_READING');
  }
  if (input.dataState === 'STALE') {
    return blocked('STALE_READING');
  }
  if (input.armedState === 'UNKNOWN') {
    return blocked('ARMED_UNKNOWN');
  }
  if (input.armedState === 'ARMED') {
    return blocked('ARMED');
  }
  if (tool === 'MAG_CALIBRATION' && !magnetometerDetected(input.sensors)) {
    return blocked('SENSOR_NOT_DETECTED');
  }
  return {tool, enabled: true, reason: undefined};
}

export function resolveAllFcToolAvailability(input: FcToolGateInput): readonly FcToolAvailability[] {
  return Object.freeze(FC_TOOL_IDS.map(tool => resolveFcToolAvailability(tool, input)));
}
