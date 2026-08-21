/**
 * THE AUXILIARY-CHANNEL STATE PRECEDENCE, kept when its card frame went.
 *
 * This rule was born in Pass 7.6c inside TelemetryCardFrame, which
 * SETUP R9 deleted along with the four elevated cards it framed. The
 * RULE is not a layout detail and had no business dying with the frame:
 * it is the order in which a channel's possible failures outrank one
 * another, and getting that order wrong is how a screen ends up printing
 * a cached number for a channel the flight controller has since said it
 * does not support.
 *
 *   1. session not ACTIVE             -> disconnected
 *   2. channel UNSUPPORTED            -> the FC rejected the command
 *   3. channel DECODE_FAILED/DISABLED -> error
 *   4. value UNAVAILABLE              -> no data
 *   5. value WAITING                  -> first reading not in yet
 *   6. value ERROR                    -> error
 *   7. FRESH / STALE                  -> undefined: render the value
 *
 * WHY IT IS NOT SIMPLY "IS THE VALUE FRESH". A channel state and a value
 * status are independent facts, and they can disagree: the scheduler can
 * still hold a STALE cached reading for a channel whose circuit breaker
 * has since tripped to UNSUPPORTED. Reading only the value status would
 * show that stale number as though the channel were merely a little
 * behind. The channel verdict outranks it, deliberately.
 *
 * Pure - no React, unit-testable without rendering.
 */

import type {TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';

export type AuxCardGateVariant =
  | 'disconnected'
  | 'unsupported'
  | 'unavailable'
  | 'waiting'
  | 'error';

/** undefined = the channel has a value worth rendering (FRESH or STALE). */
export function resolveAuxCardGate(
  connected: boolean,
  channelState: AuxTelemetryChannelState,
  valueStatus: TelemetryValue<unknown>['status'],
): AuxCardGateVariant | undefined {
  if (!connected) {
    return 'disconnected';
  }
  if (channelState === 'UNSUPPORTED') {
    return 'unsupported';
  }
  if (channelState === 'DECODE_FAILED' || channelState === 'DISABLED') {
    return 'error';
  }
  if (valueStatus === 'UNAVAILABLE') {
    return 'unavailable';
  }
  if (valueStatus === 'WAITING') {
    return 'waiting';
  }
  if (valueStatus === 'ERROR') {
    return 'error';
  }
  return undefined;
}
