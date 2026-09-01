import {
  MAX_PROFILE_NAME_LENGTH,
  MSP2TEXT_PID_PROFILE_NAME,
  MSP2TEXT_RATE_PROFILE_NAME,
  decodeSelectSetting,
  encodeCopyProfile,
  encodeGetProfileName,
  encodePidProfileReset,
  encodeSelectSettingVersioned,
  encodeSetProfileName,
  isEncodableSelectSettingIndex,
  pidProfileResetRequest,
  projectCopyProfile,
  projectSelectSetting,
} from './encodeProfileCommands';

describe('P-B - MSP_SELECT_SETTING is one byte with a versioned discriminator', () => {
  it('encodes a PID profile as the bare index', () => {
    expect(Array.from(encodeSelectSettingVersioned('PID', 2, 'API_1_47'))).toEqual([0x02]);
  });

  it('encodes a rate profile with the high bit set', () => {
    expect(Array.from(encodeSelectSettingVersioned('RATE', 2, 'API_1_47'))).toEqual([0x82]);
  });

  it('encodes a battery profile with bit 6, from 1.48 only', () => {
    expect(Array.from(encodeSelectSettingVersioned('BATTERY', 2, 'API_1_48'))).toEqual([0x42]);
    expect(() => encodeSelectSettingVersioned('BATTERY', 2, 'API_1_47')).toThrow(RangeError);
  });

  it('reads 0x02 as a PID profile at every version', () => {
    expect(decodeSelectSetting(0x02, 'API_1_47')).toEqual({kind: 'PID', index: 2});
    expect(decodeSelectSetting(0x02, 'API_1_48')).toEqual({kind: 'PID', index: 2});
  });

  it('reads 0x82 as a rate profile at every version', () => {
    expect(decodeSelectSetting(0x82, 'API_1_47')).toEqual({kind: 'RATE', index: 2});
    expect(decodeSelectSetting(0x82, 'API_1_49')).toEqual({kind: 'RATE', index: 2});
  });

  it('reads 0x42 differently at 1.47 and 1.48 - which is the whole point', () => {
    // At 1.47 bit 6 carries no meaning, so the byte is PID profile 66.
    expect(decodeSelectSetting(0x42, 'API_1_47')).toEqual({kind: 'PID', index: 66});
    // From 1.48 the firmware tests the battery bit FIRST.
    expect(decodeSelectSetting(0x42, 'API_1_48')).toEqual({kind: 'BATTERY', index: 2});
    expect(decodeSelectSetting(0x42, 'API_1_49')).toEqual({kind: 'BATTERY', index: 2});
  });

  it('gives the battery bit precedence over the rate bit at 1.48', () => {
    // 0xC2 has both bits. The firmware tests battery first, so battery wins.
    expect(decodeSelectSetting(0xc2, 'API_1_48')).toEqual({kind: 'BATTERY', index: 0x82});
    expect(decodeSelectSetting(0xc2, 'API_1_47')).toEqual({kind: 'RATE', index: 0x42});
  });

  it('refuses to encode an index that would reach a discriminator bit', () => {
    expect(isEncodableSelectSettingIndex('PID', 4)).toBe(false);
    expect(isEncodableSelectSettingIndex('RATE', 4)).toBe(false);
    expect(isEncodableSelectSettingIndex('PID', 64)).toBe(false);
    expect(isEncodableSelectSettingIndex('PID', 128)).toBe(false);
    expect(() => encodeSelectSettingVersioned('PID', 4, 'API_1_47')).toThrow(RangeError);
    expect(() => encodeSelectSettingVersioned('RATE', 9, 'API_1_47')).toThrow(RangeError);
  });

  it('models the firmware coercion without relying on it', () => {
    // The handler replaces an out-of-range index with 0 and acknowledges as
    // if nothing happened. That is real, so a readback must expect it - but
    // the encoder above still refuses to send such a byte.
    expect(projectSelectSetting({kind: 'PID', index: 5})).toEqual({kind: 'PID', index: 0});
    expect(projectSelectSetting({kind: 'RATE', index: 6})).toEqual({kind: 'RATE', index: 0});
    expect(projectSelectSetting({kind: 'PID', index: 3})).toEqual({kind: 'PID', index: 3});
  });
});

describe('P-B - MSP_COPY_PROFILE puts the destination before the source', () => {
  it('encodes a PID copy from 1 into 2', () => {
    // Hand-written expectation: type 0, destination 2, source 1.
    expect(Array.from(encodeCopyProfile({kind: 'PID', destinationIndex: 2, sourceIndex: 1})))
      .toEqual([0, 2, 1]);
  });

  it('encodes a rate copy from 0 into 3', () => {
    expect(Array.from(encodeCopyProfile({kind: 'RATE', destinationIndex: 3, sourceIndex: 0})))
      .toEqual([1, 3, 0]);
  });

  it('produces different bytes when source and destination are swapped', () => {
    const forward = Array.from(encodeCopyProfile({kind: 'PID', destinationIndex: 2, sourceIndex: 1}));
    const reversed = Array.from(encodeCopyProfile({kind: 'PID', destinationIndex: 1, sourceIndex: 2}));
    expect(forward).not.toEqual(reversed);
    expect(reversed).toEqual([0, 1, 2]);
  });

  it('refuses an out-of-range index rather than sending a silent no-op', () => {
    expect(() => encodeCopyProfile({kind: 'PID', destinationIndex: 4, sourceIndex: 0}))
      .toThrow(RangeError);
  });
});

describe('P-B - what a copy actually does, firmware capability versus UI rule', () => {
  it('is a silent no-op when source and destination are the same', () => {
    expect(projectCopyProfile({kind: 'PID', destinationIndex: 1, sourceIndex: 1}, 0))
      .toEqual({kind: 'NO_OP_SAME_INDEX'});
  });

  it('is a silent no-op when either index is out of range', () => {
    expect(projectCopyProfile({kind: 'PID', destinationIndex: 9, sourceIndex: 0}, 0))
      .toEqual({kind: 'NO_OP_OUT_OF_RANGE'});
  });

  it('ALLOWS the active profile as a destination - the firmware does not forbid it', () => {
    // The Configurator removes the active entry from its dialog, but
    // pidCopyProfile guards only "both in range" and "not the same index".
    // Building a controller rule from the UI restriction would be inventing a
    // firmware constraint that does not exist.
    const outcome = projectCopyProfile({kind: 'PID', destinationIndex: 1, sourceIndex: 2}, 1);
    expect(outcome).toEqual({kind: 'COPIED', writesActiveProfile: true, runtimeReinitialised: false});
  });

  it('reports that no re-initialisation follows the copy', () => {
    // The handler runs the memcpy and returns. Nothing calls pidInit or
    // initRcProcessing, so a copy onto the active profile leaves the stored
    // configuration and the running behaviour disagreeing.
    const outcome = projectCopyProfile({kind: 'RATE', destinationIndex: 0, sourceIndex: 3}, 0);
    expect(outcome).toEqual({kind: 'COPIED', writesActiveProfile: true, runtimeReinitialised: false});
  });

  it('marks a copy into an inactive profile as not touching the live one', () => {
    const outcome = projectCopyProfile({kind: 'PID', destinationIndex: 3, sourceIndex: 0}, 1);
    expect(outcome).toEqual({kind: 'COPIED', writesActiveProfile: false, runtimeReinitialised: false});
  });
});

describe('P-B - the two resets are not the same thing and cannot be confused', () => {
  it('describes the PID-profile reset as narrow, unpersisted and reboot-free', () => {
    expect(pidProfileResetRequest()).toEqual({
      scope: 'CURRENT_PID_PROFILE_ONLY',
      persists: false,
      reboots: false,
    });
  });

  it('sends no payload, because the command takes none', () => {
    expect(encodePidProfileReset()).toHaveLength(0);
  });

  it('offers no way to widen its scope', () => {
    // There is deliberately no parameter, no enum and no shared "reset"
    // helper: reaching the whole-configuration reset requires naming a
    // different command entirely, in a different module.
    expect(pidProfileResetRequest.length).toBe(0);
    expect(pidProfileResetRequest().scope).toBe('CURRENT_PID_PROFILE_ONLY');
  });
});

describe('P-B - profile names', () => {
  it('addresses the PID and rate names with the firmware selectors', () => {
    expect(MSP2TEXT_PID_PROFILE_NAME).toBe(3);
    expect(MSP2TEXT_RATE_PROFILE_NAME).toBe(4);
    expect(Array.from(encodeGetProfileName('PID'))).toEqual([3]);
    expect(Array.from(encodeGetProfileName('RATE'))).toEqual([4]);
  });

  it('encodes selector, length, then the characters', () => {
    // Hand-written: 'Cine' is 0x43 0x69 0x6E 0x65.
    expect(Array.from(encodeSetProfileName('PID', 'Cine')))
      .toEqual([3, 4, 0x43, 0x69, 0x6e, 0x65]);
  });

  it('allows exactly the eight characters the firmware stores', () => {
    expect(MAX_PROFILE_NAME_LENGTH).toBe(8);
    expect(encodeSetProfileName('RATE', 'ABCDEFGH')).toHaveLength(10);
    expect(() => encodeSetProfileName('RATE', 'ABCDEFGHI')).toThrow(RangeError);
  });

  it('refuses a character the flight controller cannot store', () => {
    // A truncated or mangled name is a different name; better to refuse.
    expect(() => encodeSetProfileName('PID', 'حر')).toThrow(RangeError);
  });

  it('encodes an empty name as a zero length', () => {
    expect(Array.from(encodeSetProfileName('PID', ''))).toEqual([3, 0]);
  });
});
