import {MspPayloadReader} from './MspPayloadReader';
import {RECEIVER_CHANNEL_MAX_COUNT} from './decodeReceiver';
import type {MspGpsRescueConfiguration} from './decodeGpsRescue';

export const RX_FAILSAFE_MIN = 750;
export const RX_FAILSAFE_MAX = 2250;
export const RX_FAILSAFE_STEP = 25;
export const BUILD_OPTION_GPS = 16412;

export type FailsafeProcedure = 0 | 1 | 2;
export type FailsafeSwitchMode = 0 | 1 | 2;
export type RxFailsafeMode = 0 | 1 | 2;

export interface MspFailsafeConfiguration {
  readonly delayDeciseconds: number;
  readonly landingTimeSeconds: number;
  readonly throttle: number;
  readonly switchMode: FailsafeSwitchMode;
  /** Exactly what the firmware reported, before clamping - so an
   * unrecognized value can be shown as unrecognized instead of silently
   * becoming a different setting. Equal to switchMode in the normal case. */
  readonly rawSwitchMode: number;
  readonly throttleLowDelayDeciseconds: number;
  readonly procedure: FailsafeProcedure;
  /** As rawSwitchMode, for the stage-2 procedure. */
  readonly rawProcedure: number;
  /** The response ended before all six fields; the tail kept its default. */
  readonly truncated: boolean;
}

export interface MspRxFailsafeChannel {
  readonly mode: RxFailsafeMode;
  /** The mode byte exactly as stored, before clamping. */
  readonly rawMode: number;
  readonly value: number;
  /** The stored value is outside 750-2250us or off the 25us grid. Shown,
   * never hidden, and corrected on save rather than on read. */
  readonly outOfRange: boolean;
}

/**
 * Why the GPS Rescue parameters are absent, when they are.
 *
 * Three genuinely different situations that must not be shown as one
 * message: the build has no GPS at all; the build has GPS but the board
 * did not answer MSP_GPS_RESCUE (a wing build, or GPS_RESCUE compiled
 * out); or it answered with something this decoder could not read.
 */
export type GpsRescueAvailability = 'PRESENT' | 'NO_GPS_IN_BUILD' | 'COMMAND_UNSUPPORTED' | 'UNREADABLE';

export interface MspFailsafeSnapshot {
  readonly config: MspFailsafeConfiguration;
  readonly channels: readonly MspRxFailsafeChannel[];
  readonly supportsGpsRescue: boolean;
  /**
   * The stage-2 GPS Rescue parameters, when the board has them.
   *
   * Deliberately part of the FAILSAFE snapshot rather than a screen of
   * its own: choosing GPS Rescue as the stage-2 procedure and setting the
   * altitude it will return at are one decision, and splitting them would
   * mean two saves, two readbacks and two chances to leave the aircraft
   * configured to fly home at an altitude nobody checked.
   */
  readonly gpsRescue?: MspGpsRescueConfiguration;
  readonly gpsRescueAvailability: GpsRescueAvailability;
}

/**
 * READS WHAT THE FIRMWARE SENT - it does not audit it.
 *
 * This used to demand exactly 8 bytes and reject any switch mode or
 * procedure above 2. Both are the wrong posture for a configuration READ,
 * and the pinned Betaflight Configurator takes neither: its handler
 * (src/js/msp/MSPHelper.js, `case MSPCodes.MSP_FAILSAFE_CONFIG`) reads the
 * six fields positionally with a reader that returns null past the end
 * (src/js/injected_methods.js) - no length assertion, no enum range check.
 *
 * The consequence of the old posture was not safety, it was fragility: a
 * firmware one byte longer (Betaflight has appended fields to this message
 * before) or a procedure value we have not seen (GPS Rescue itself was
 * added as procedure 2) made the ENTIRE Failsafe screen fail to load, so
 * the operator could not read or fix anything - including the settings
 * that were still perfectly valid.
 *
 * So: extra trailing bytes are ignored, absent trailing fields keep their
 * zero default, and an unrecognized switch mode or procedure is preserved
 * verbatim in `rawSwitchMode` / `rawProcedure` with the typed field
 * clamped to a safe known value. Writing is where validity is enforced -
 * see failsafeConfigurationModel.ts.
 */
export function decodeFailsafeConfiguration(payload: Uint8Array): MspFailsafeConfiguration {
  const reader = new MspPayloadReader(payload, {lenient: true});
  const delayDeciseconds = reader.readU8();
  const landingTimeSeconds = reader.readU8();
  const throttle = reader.readU16LE();
  const switchMode = reader.readU8();
  const throttleLowDelayDeciseconds = reader.readU16LE();
  const procedure = reader.readU8();
  return Object.freeze({
    delayDeciseconds,
    landingTimeSeconds,
    throttle,
    // DROP (1) is the clamp for an unrecognized procedure on purpose: of
    // the procedures this app understands it is the one that cannot fly
    // the aircraft anywhere on its own. The real value is preserved
    // alongside so the UI can say it is unrecognized rather than silently
    // present a setting the FC does not actually hold.
    switchMode: (switchMode <= 2 ? switchMode : 0) as FailsafeSwitchMode,
    rawSwitchMode: switchMode,
    throttleLowDelayDeciseconds,
    procedure: (procedure <= 2 ? procedure : 1) as FailsafeProcedure,
    rawProcedure: procedure,
    truncated: reader.truncated(),
  });
}

/**
 * SHOWS THE OPERATOR WHAT IS ACTUALLY ON THE BOARD.
 *
 * Betaflight derives the channel count from the payload length alone
 * (`data.byteLength / 3`) and stores each record with no validation
 * whatsoever (src/js/msp/MSPHelper.js, `case MSPCodes.MSP_RXFAIL_CONFIG`).
 *
 * This used to throw on an unknown mode, and on any value outside
 * 750-2250 or off the 25us grid. Those are WRITE constraints - Betaflight
 * enforces them on the way out, not on the way in - and applying them to
 * a read meant one unexpected stored value made the whole Failsafe screen
 * unreadable, so the operator could neither see the bad value nor correct
 * it. A configuration editor that refuses to display the configuration it
 * exists to edit is the least useful failure mode available.
 *
 * Values are now reported as stored, with `outOfRange` marking the ones a
 * save would have to correct. A trailing partial record is ignored rather
 * than rejected, matching Betaflight's integer division.
 */
export function decodeRxFailsafeConfiguration(payload: Uint8Array): readonly MspRxFailsafeChannel[] {
  const count = Math.min(Math.floor(payload.length / 3), RECEIVER_CHANNEL_MAX_COUNT);
  const reader = new MspPayloadReader(payload, {lenient: true});
  const channels: MspRxFailsafeChannel[] = [];
  for (let index = 0; index < count; index += 1) {
    const mode = reader.readU8();
    const value = reader.readU16LE();
    const outOfRange =
      value < RX_FAILSAFE_MIN ||
      value > RX_FAILSAFE_MAX ||
      (value - RX_FAILSAFE_MIN) % RX_FAILSAFE_STEP !== 0;
    channels.push(
      Object.freeze({
        // HOLD (1) is the clamp for an unrecognized mode: it changes
        // nothing about the channel, which is the least surprising
        // behaviour for a value this app does not understand.
        mode: (mode <= 2 ? mode : 1) as RxFailsafeMode,
        rawMode: mode,
        value,
        outOfRange,
      }),
    );
  }
  return Object.freeze(channels);
}
