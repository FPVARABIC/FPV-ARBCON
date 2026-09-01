/**
 * SETUP P1 - THE READ-ONLY SETUP PRESENTATION BOUNDARY.
 *
 * Before P1, SetupScreen.tsx imported `mspSessionCoordinator` directly and
 * called it at four sites, and every setup component named raw telemetry
 * poll ids. That made the coordinator's entire surface - including
 * session teardown, scheduler mutation and the motor-test capability -
 * one autocomplete away from the overview screen. P0 rated the boundary
 * PARTIAL for exactly that reason.
 *
 * This module is the whole boundary. Setup UI imports from here and from
 * `fcToolsController` (its explicit, Setup-owned COMMAND surface, kept
 * deliberately separate - see the note at the bottom of this file), and
 * from nothing else in the protocol layer.
 *
 *      Setup UI
 *       ├── setupPresentation  → READ ONLY (this file)
 *       └── fcToolsController  → explicit Setup-owned COMMANDS
 *
 * WHAT THIS FILE MAY NEVER EXPORT, and does not: MspClient, any
 * transport, MSP command constants, frame encoders/decoders,
 * `registerPoll` or any other scheduler mutation, telemetry pause leases,
 * poll-interval overrides, poll suppression, motor-test authority, or any
 * generic "send an MSP message" escape hatch. There is no wildcard
 * export anywhere in this file - every name below is hand-listed, and
 * setupPresentationBoundary.test.ts enumerates the surface so it cannot
 * quietly grow into "everything Setup might someday need".
 *
 * The poll ids stay inside this module too. Setup asks for
 * `useSetupBattery(...)`, not for a string that happens to be registered
 * somewhere; a screen that cannot name a poll cannot subscribe to one
 * that does not exist. That is not a stylistic preference - it is
 * precisely the failure P1 exists to close, where Setup subscribed for
 * years to two ids nothing ever registered.
 */

import type {
  ArmedState,
  MspAnalog,
  MspAttitude,
  MspBatteryState,
  MspClientState,
  MspRawGpsCompact,
  MspStatusExDiagnostics,
  TelemetrySchedulerDiagnostics,
  TelemetryValue,
} from '../../../core';

import {
  mspSessionCoordinator,
  ATTITUDE_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  GPS_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
} from './MspSessionCoordinator';
import type {
  AuxTelemetryChannelState,
  MspIdentificationState,
  MspSessionOwnershipState,
} from './MspSessionCoordinator';
import {useTelemetryValue} from './useTelemetryValue';
import {
  useMspIdentificationState,
  useMspOwnershipState,
  useMspRecoveryState,
} from './useMspSessionState';
import {useAuxTelemetryChannelState, useBatteryLatchedValue} from './useAuxTelemetry';
import {useSetupAppStatePhase} from './useSetupAppState';
import type {SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {setupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';
import {fcToolsController} from './FcToolsController';
/* Aliased on import so the public name below is the only one Setup ever
 * sees, and `useFcTools`'s command-adjacent exports are not re-exported
 * wholesale. */
import {useFcToolArmedState as useFcToolArmedStateInternal} from './useFcTools';

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

/**
 * The telemetry channels Setup is allowed to observe, named by DOMAIN
 * rather than by poll id. Setup never handles a poll-id string.
 *
 * There is deliberately no ARMED or ARMING_BLOCKERS channel. Those two
 * poll ids exist as reserved placeholders in the coordinator and are
 * registered by nothing; the armed truth comes from
 * `useSetupArmedState()` below, over the same BOXIDS + STATUS_EX path the
 * FC tools already gate on.
 */
export type SetupTelemetryChannel = 'RECEIVER' | 'GPS' | 'FC_STATUS';

const CHANNEL_POLL_ID: Readonly<Record<SetupTelemetryChannel, string>> = Object.freeze({
  RECEIVER: RECEIVER_TELEMETRY_POLL_ID,
  GPS: GPS_TELEMETRY_POLL_ID,
  FC_STATUS: FC_STATUS_TELEMETRY_POLL_ID,
});

/* ------------------------------------------------------------------ *
 * Connection / identity
 * ------------------------------------------------------------------ */

export function useSetupOwnershipState(sessionId: string): MspSessionOwnershipState {
  return useMspOwnershipState(sessionId);
}

/** Convenience over the ownership state - the one predicate every Setup
 * card gates on, so no component re-spells `=== 'ACTIVE'`. */
export function useSetupConnected(sessionId: string): boolean {
  return useMspOwnershipState(sessionId) === 'ACTIVE';
}

export function useSetupIdentificationState(sessionId: string): MspIdentificationState {
  return useMspIdentificationState(sessionId);
}

export function useSetupRecoveryState(sessionId: string): MspClientState | undefined {
  return useMspRecoveryState(sessionId);
}

export {useSetupAppStatePhase};
export type {SetupAppStatePhase};

/* ------------------------------------------------------------------ *
 * Telemetry reads
 * ------------------------------------------------------------------ */

export function useSetupAttitude(
  sessionId: string,
  active: boolean,
): TelemetryValue<MspAttitude> {
  return useTelemetryValue<MspAttitude>(sessionId, ATTITUDE_TELEMETRY_POLL_ID, active);
}

/**
 * The battery reading, with the coordinator's one-strike timeout latch
 * already applied: once the breaker has fired the poll is unregistered
 * and the scheduler reports UNAVAILABLE, so the latched pre-timeout
 * reading (frozen as STALE) or the read-timeout ERROR is the truthful
 * value. Folding the latch in here means no screen can forget it.
 */
export function useSetupBattery(
  sessionId: string,
  active: boolean,
): TelemetryValue<MspBatteryState> {
  const polled = useTelemetryValue<MspBatteryState>(
    sessionId,
    BATTERY_TELEMETRY_POLL_ID,
    active,
  );
  const latched = useBatteryLatchedValue(sessionId);
  return latched ?? polled;
}

export function useSetupReceiver(
  sessionId: string,
  active: boolean,
): TelemetryValue<MspAnalog> {
  return useTelemetryValue<MspAnalog>(sessionId, RECEIVER_TELEMETRY_POLL_ID, active);
}

export function useSetupGps(
  sessionId: string,
  active: boolean,
): TelemetryValue<MspRawGpsCompact> {
  return useTelemetryValue<MspRawGpsCompact>(sessionId, GPS_TELEMETRY_POLL_ID, active);
}

export function useSetupStatus(
  sessionId: string,
  active: boolean,
): TelemetryValue<MspStatusExDiagnostics> {
  return useTelemetryValue<MspStatusExDiagnostics>(
    sessionId,
    FC_STATUS_TELEMETRY_POLL_ID,
    active,
  );
}

export function useSetupChannelState(
  sessionId: string,
  channel: SetupTelemetryChannel,
): AuxTelemetryChannelState {
  return useAuxTelemetryChannelState(sessionId, CHANNEL_POLL_ID[channel]);
}

/* ------------------------------------------------------------------ *
 * Armed truth
 * ------------------------------------------------------------------ */

/**
 * THE single armed source for Setup - the same one the FC tools gate on,
 * so the safety strip, the top-bar badge and the tool buttons cannot
 * disagree about whether the aircraft is armed.
 *
 * Proven from the at-most-once MSP_BOXIDS mapping for the CURRENT
 * (physicalGeneration, mspEpoch) identity, combined with the packed
 * flight-mode flags of the supplied STATUS_EX reading. UNKNOWN whenever
 * the mapping or the reading is missing, or the session identity has
 * moved on. Never polled, never guessed, and never inferred from the
 * arming-disable flags.
 *
 * Reading it is not a command: this issues no request. The `ensure...`
 * side of the same controller stays on the command surface.
 */
export function useSetupArmedState(
  sessionId: string,
  status: MspStatusExDiagnostics | undefined,
): ArmedState {
  return useFcToolArmedStateInternal(sessionId, status);
}

/* ------------------------------------------------------------------ *
 * Explicit point-in-time reads
 * ------------------------------------------------------------------ */

/**
 * The attitude sample AT PRESS TIME, read from the authoritative
 * scheduler rather than from a render closure - a press handler captured
 * before a disconnect must not store a sample belonging to a session that
 * has since ended. Returns undefined unless the session is ACTIVE and the
 * sample is FRESH; a STALE sample is deliberately not a valid heading
 * reference.
 */
export function readSetupFreshAttitude(sessionId: string): MspAttitude | undefined {
  if (mspSessionCoordinator.getOwnershipState(sessionId) !== 'ACTIVE') {
    return undefined;
  }
  const current = mspSessionCoordinator
    .getTelemetryScheduler(sessionId)
    ?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
  return current !== undefined && current.status === 'FRESH' ? current.value : undefined;
}

export function readSetupOwnershipState(sessionId: string): MspSessionOwnershipState {
  return mspSessionCoordinator.getOwnershipState(sessionId);
}

export function readSetupIdentificationStatus(
  sessionId: string,
): MspIdentificationState['status'] {
  return mspSessionCoordinator.getIdentificationState(sessionId).status;
}

/** A read-only diagnostics snapshot for the operator-triggered telemetry
 * report. `undefined` means telemetry never started for this session - a
 * different finding from "telemetry started and sent nothing", so it is
 * not collapsed into zeros. */
export function readSetupTelemetryDiagnostics(
  sessionId: string,
): TelemetrySchedulerDiagnostics | undefined {
  return mspSessionCoordinator.getTelemetryScheduler(sessionId)?.describeDiagnostics();
}

export function readSetupAppStatePhase(): SetupAppStatePhase {
  return setupAppStateTelemetryOwner.getPhase();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Registers this session with the ONE AppState telemetry owner (a module
 * singleton) and starts it if it is not running. The screen never becomes
 * a second AppState listener or a second polling owner, and this does NOT
 * open, close or otherwise mutate the coordinator-owned physical session.
 */
export function startSetupTelemetryOwnership(sessionId: string): void {
  setupAppStateTelemetryOwner.start();
  setupAppStateTelemetryOwner.track(sessionId);
}

/**
 * Kicks the at-most-once MSP_BOXIDS acquisition for the session's current
 * identity, so `useSetupArmedState()` can be proven at all. Idempotent
 * and safe from an effect on every render: the acquisition enforces one
 * request per identity, shares the in-flight promise, and never retries
 * inside an identity. It is never polled.
 *
 * This is the ONE outbound thing on this module, and it is here rather
 * than left to the screen because the armed READ is useless without it -
 * they are two halves of one fact. It cannot arm, disarm, calibrate,
 * reboot or write any configuration; the Setup-owned COMMANDS stay on
 * fcToolsController, which Setup imports explicitly and separately.
 */
export function ensureSetupArmedStateAvailable(sessionId: string): void {
  fcToolsController.ensureBoxIdsMapping(sessionId);
}
