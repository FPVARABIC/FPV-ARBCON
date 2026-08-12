/**
 * RECEIVER P5 - the ONLY protocol surface ReceiverScreen is allowed to see.
 *
 * THE WEAKNESS THIS CLOSES, stated plainly. ReceiverScreen's imports were
 * already clean through P1-P4, but it reached them through
 * `platforms/react-native/protocol`, a barrel that re-exports ~180
 * symbols including `RNMspTransport` and the live `mspSessionCoordinator`.
 * Nothing structural stopped a future edit from adding
 * `mspSessionCoordinator` to that same import line and driving the wire
 * from a React component - it would have compiled, passed review at a
 * glance, and quietly bypassed every interlock, disarm proof and
 * capability gate the last four phases built.
 *
 * This module is the whole answer: a hand-listed surface containing the
 * facade functions and the result TYPES the screen renders, and nothing
 * else. A screen that needs something new must add it HERE, which is a
 * visible, reviewable act - and receiverBoundary.test.ts fails if the
 * surface grows a transport, a client, a scheduler, a coordinator, an
 * encoder, a decoder or a raw command constant, or if ReceiverScreen goes
 * back to importing the broad barrel.
 *
 * NOT a re-export of everything Receiver-shaped. `receiverTelemetry`'s
 * poll ids are here because the screen must name the poll it reads;
 * `MspTelemetryScheduler` is not, because the screen must never hold one.
 */

export {
  /** Live-RC acquisition (reference counted, P1). */
  acquireReceiverTelemetry,
  /** MEASURED delivered rate, or undefined. Never a computed claim (P3). */
  getReceiverObservedRateHz,
  RECEIVER_CHANNELS_POLL_ID,
} from './receiverTelemetry';

export {
  FC_STATUS_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

export {useTelemetryValue} from './useTelemetryValue';

export {
  /** The one save/load/runtime/reboot authority (P2/P4). */
  receiverConfigurationController,
  type ReceiverBlockReason,
  type ReceiverLoadOutcome,
  type ReceiverModeTarget,
  type ReceiverRebootOutcome,
  type ReceiverRuntimeOutcome,
  type ReceiverRuntimeTruth,
  type ReceiverSaveOutcome,
} from './ReceiverConfigurationController';
