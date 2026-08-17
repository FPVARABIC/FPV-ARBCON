/**
 * FAILSAFE: WHAT THE OPERATOR IS TOLD, AND WHAT SURVIVES A STRANGE BOARD.
 *
 * Screen 1 of the remaining-screens program. Two defects drove these
 * tests, both found by reading the pinned Betaflight Configurator against
 * ours (src/js/tabs/failsafe.js, src/js/msp/MSPHelper.js cases
 * MSP_FAILSAFE_CONFIG / MSP_RXFAIL_CONFIG, src/js/injected_methods.js):
 *
 *  1. Our decoders REJECTED payloads Betaflight accepts - an exact 8-byte
 *     length, any switch mode or procedure above 2, any RXFAIL value off
 *     the 25us grid. Each of those turned one unexpected byte into "the
 *     Failsafe screen will not load", on the screen that decides what the
 *     aircraft does when the link dies.
 *
 *  2. The screen rendered raw validation identifiers to an Arabic
 *     operator ("CHANNEL_VALUE_INVALID"). Fixing (1) makes that path
 *     reachable by real boards, so it had to be fixed with it.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import {
  decodeFailsafeConfiguration,
  decodeRxFailsafeConfiguration,
} from '../../core/protocol/msp/decoding/decodeFailsafe';
import {
  createFailsafeConfigurationDraft,
  failsafeDraftsEqual,
  validateFailsafeDraft,
} from '../../core/state/failsafeConfigurationModel';
import type {MspFailsafeSnapshot} from '../../core';

/** A board answering exactly as current Betaflight does. */
function snapshotFrom(configBytes: number[], channelBytes: number[]): MspFailsafeSnapshot {
  return {
    config: decodeFailsafeConfiguration(Uint8Array.from(configBytes)),
    channels: decodeRxFailsafeConfiguration(Uint8Array.from(channelBytes)),
    supportsGpsRescue: true,
  };
}

const HEALTHY_CONFIG = [15, 60, 232, 3, 0, 100, 0, 1];
/** Four axes on AUTO, then one AUX on HOLD. */
const HEALTHY_CHANNELS = [0, 220, 5, 0, 220, 5, 0, 220, 5, 0, 232, 3, 1, 220, 5];

describe('a board whose stored failsafe is not what we expected', () => {
  it('LOADS when the config payload is longer than this build knows about', () => {
    const snapshot = snapshotFrom([...HEALTHY_CONFIG, 99, 99], HEALTHY_CHANNELS);
    expect(snapshot.config.procedure).toBe(1);
    expect(snapshot.channels).toHaveLength(5);
  });

  it('LOADS when a channel holds an off-grid value, and asks for it to be corrected', () => {
    // 1501us - inside range, off the 25us grid. Previously this threw and
    // the operator saw no screen at all.
    const snapshot = snapshotFrom(HEALTHY_CONFIG, [2, 221, 5, ...HEALTHY_CHANNELS.slice(3)]);
    expect(snapshot.channels[0].value).toBe(1501);
    expect(snapshot.channels[0].outOfRange).toBe(true);

    const draft = createFailsafeConfigurationDraft(snapshot);
    // The value is present to be edited, and validation asks for the fix.
    expect(draft.channels[0].value).toBe(1501);
    expect(validateFailsafeDraft(draft, snapshot)).toContain('CHANNEL_VALUE_INVALID');
  });

  it('LOADS when the procedure is one this build has never heard of', () => {
    const snapshot = snapshotFrom([15, 60, 232, 3, 0, 100, 0, 7], HEALTHY_CHANNELS);
    expect(snapshot.config.rawProcedure).toBe(7);
    // Clamped to Drop - the one procedure that cannot fly the aircraft.
    expect(snapshot.config.procedure).toBe(1);
  });
});

describe('the draft carries settings, never diagnostics', () => {
  it('an unedited draft equals itself, even when the board reported an odd value', () => {
    // Regression guard for a false UNVERIFIED: diagnostics (outOfRange,
    // rawMode, truncated) used to be spread into the draft, and the draft
    // is compared with JSON.stringify during save readback. A corrected
    // value clears its own outOfRange flag, so the readback of a perfect
    // save would have compared unequal and been reported UNVERIFIED on the
    // safety screen.
    const snapshot = snapshotFrom(HEALTHY_CONFIG, [2, 221, 5, ...HEALTHY_CHANNELS.slice(3)]);
    const draft = createFailsafeConfigurationDraft(snapshot);

    expect(failsafeDraftsEqual(draft, createFailsafeConfigurationDraft(snapshot))).toBe(true);
    for (const channel of draft.channels) {
      expect(Object.keys(channel).sort()).toEqual(['mode', 'value']);
    }
    expect(Object.keys(draft)).not.toContain('rawProcedure');
    expect(Object.keys(draft)).not.toContain('truncated');
  });

  it('a readback whose diagnostics differ but whose SETTINGS match verifies', () => {
    // The FC corrected the off-grid value on save; the readback therefore
    // has outOfRange false where the original had it true. Same settings.
    const before = snapshotFrom(HEALTHY_CONFIG, [2, 221, 5, ...HEALTHY_CHANNELS.slice(3)]);
    const corrected = snapshotFrom(HEALTHY_CONFIG, [2, 220, 5, ...HEALTHY_CHANNELS.slice(3)]);

    const intended = {
      ...createFailsafeConfigurationDraft(before),
      channels: createFailsafeConfigurationDraft(corrected).channels,
    };
    expect(failsafeDraftsEqual(intended, createFailsafeConfigurationDraft(corrected))).toBe(true);
  });
});

describe('every validation code reaches the operator in Arabic', () => {
  it('the screen maps ALL of them - no internal identifier can leak', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const screen = fs.readFileSync(path.join(__dirname, 'FailsafeScreen.tsx'), 'utf8');
    const model = fs.readFileSync(
      path.join(__dirname, '..', '..', 'core', 'state', 'failsafeConfigurationModel.ts'),
      'utf8',
    );

    // Every code the model can emit must have an entry in the screen's map.
    const codes = Array.from(model.matchAll(/issues\.push\('([A-Z_]+)'\)/g), match => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of new Set(codes)) {
      expect(screen).toContain(`${code}:`);
    }

    // ...and the raw join that used to print them is gone.
    expect(screen).not.toContain("issues.join(' · ')");
  });
});
