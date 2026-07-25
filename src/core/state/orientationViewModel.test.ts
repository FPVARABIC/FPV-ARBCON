import {deriveOrientationViewState, describeOrientationForAccessibility} from './orientationViewModel';
import type {OrientationViewOffset, OrientationViewState} from './orientationViewModel';
import type {MspAttitude, TelemetryValue} from '../protocol';

const ZERO_OFFSET: OrientationViewOffset = {rollDeg: 0, pitchDeg: 0, yawDeg: 0};

function attitude(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): MspAttitude {
  return {rollDecidegrees, pitchDecidegrees, yawDegrees};
}

describe('deriveOrientationViewState', () => {
  it('maps UNAVAILABLE to WAITING - a deliberate collapse, see this file\'s own doc comment', () => {
    const telemetry: TelemetryValue<MspAttitude> = {status: 'UNAVAILABLE'};
    expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({status: 'WAITING'});
  });

  it('maps WAITING to WAITING', () => {
    const telemetry: TelemetryValue<MspAttitude> = {status: 'WAITING'};
    expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({status: 'WAITING'});
  });

  it('maps ERROR to ERROR, carrying no stale value', () => {
    const telemetry: TelemetryValue<MspAttitude> = {status: 'ERROR', error: new Error('boom')};
    expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({status: 'ERROR'});
  });

  it('maps FRESH to LIVE, converting roll/pitch decidegrees to whole degrees (pitch negated into the presentation domain) and leaving yaw (already whole degrees) unconverted', () => {
    const telemetry: TelemetryValue<MspAttitude> = {
      status: 'FRESH',
      value: attitude(150, -300, 270),
      updatedAtMs: 1000,
    };
    expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({
      status: 'LIVE',
      rollDeg: 15,
      // Raw -300 dd = firmware nose UP 30deg -> presentation +30 (Pass 7.5C).
      pitchDeg: 30,
      yawDeg: 270,
    });
  });

  it('maps STALE to STALE, freezing the same converted roll/pitch/yaw and passing ageMs through unchanged', () => {
    const telemetry: TelemetryValue<MspAttitude> = {
      status: 'STALE',
      value: attitude(40, 20, 90),
      updatedAtMs: 1000,
      ageMs: 850,
    };
    expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({
      status: 'STALE',
      rollDeg: 4,
      // Raw +20 dd = firmware nose DOWN 2deg -> presentation -2 (Pass 7.5C).
      pitchDeg: -2,
      yawDeg: 90,
      ageMs: 850,
    });
  });

  it('defaults to a zero offset when none is passed', () => {
    const telemetry: TelemetryValue<MspAttitude> = {
      status: 'FRESH',
      value: attitude(50, 50, 50),
      updatedAtMs: 0,
    };
    // Pitch: raw +50 dd -> presentation -5 (Pass 7.5C sign contract).
    expect(deriveOrientationViewState(telemetry)).toEqual({status: 'LIVE', rollDeg: 5, pitchDeg: -5, yawDeg: 50});
  });

  describe('view offset application', () => {
    it('subtracts the offset from roll/pitch/yaw', () => {
      const telemetry: TelemetryValue<MspAttitude> = {
        status: 'FRESH',
        value: attitude(150, 100, 100),
        updatedAtMs: 0,
      };
      const offset: OrientationViewOffset = {rollDeg: 5, pitchDeg: -3, yawDeg: 20};
      // roll: 15 - 5 = 10; pitch (presentation-domain offset, Pass 7.5C):
      // -(100/10) - (-3) = -7; yaw: 100 - 20 = 80
      expect(deriveOrientationViewState(telemetry, offset)).toEqual({
        status: 'LIVE',
        rollDeg: 10,
        pitchDeg: -7,
        yawDeg: 80,
      });
    });

    it('a zero offset is the identity transform', () => {
      const telemetry: TelemetryValue<MspAttitude> = {
        status: 'FRESH',
        value: attitude(-275, 899, 359),
        updatedAtMs: 0,
      };
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toEqual({
        status: 'LIVE',
        rollDeg: -27.5,
        // Raw +899 dd -> presentation -89.9 (Pass 7.5C sign contract).
        pitchDeg: -89.9,
        yawDeg: 359,
      });
    });
  });

  describe('firmware->presentation pitch sign (Pass 7.5C RC-CONVENTION regression)', () => {
    // MSP_ATTITUDE pitch is positive = nose DOWN (Betaflight imu.c @
    // 0ccf5955: attitude.values.pitch = asin(getSinPitchAngle()), whose
    // own comment reads "Positive angle - nose down, negative angle -
    // nose up"; INAV/EmuFlight share the identical formula). The
    // presentation contract (renderer, numeric readout, accessibility)
    // is positive = nose UP, so the view model must negate pitch exactly
    // once - here, at the firmware->presentation boundary.
    it('raw +100 decidegrees (nose down) with zero offset presents as -10 (nose down on screen)', () => {
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, 100, 0), updatedAtMs: 0};
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toMatchObject({pitchDeg: -10});
    });

    it('raw -100 decidegrees (nose up) with zero offset presents as +10 (nose up on screen)', () => {
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, -100, 0), updatedAtMs: 0};
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toMatchObject({pitchDeg: 10});
    });

    it('negates BEFORE subtracting the presentation-domain offset: raw -100 dd with pitch offset +3 presents as +7', () => {
      // Correct order: (-(-100/10)) - 3 = 10 - 3 = 7.
      // Old (uncorrected) code would give (-100/10) - 3 = -13; the wrong
      // order (subtract-then-negate, -((-10) - 3)) would give 13 - so 7
      // discriminates against both.
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, -100, 0), updatedAtMs: 0};
      const offset: OrientationViewOffset = {rollDeg: 0, pitchDeg: 3, yawDeg: 0};
      expect(deriveOrientationViewState(telemetry, offset)).toMatchObject({pitchDeg: 7});
    });

    it('roll and yaw keep their existing equations - no negation leaks into either', () => {
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(150, 0, 270), updatedAtMs: 0};
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toMatchObject({rollDeg: 15, yawDeg: 270});
    });
  });

  describe('roll/pitch signed wraparound - normalized into (-180, 180]', () => {
    it('a roll of exactly 180 stays 180, not -180', () => {
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(1800, 0, 0), updatedAtMs: 0};
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toMatchObject({rollDeg: 180});
    });

    it('subtracting a large offset wraps a roll past -180 back into the top of the range', () => {
      // raw roll 10 - offset 200 = -190, wraps to 170
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(100, 0, 0), updatedAtMs: 0};
      const offset: OrientationViewOffset = {rollDeg: 200, pitchDeg: 0, yawDeg: 0};
      expect(deriveOrientationViewState(telemetry, offset)).toMatchObject({rollDeg: 170});
    });

    it('adding an offset (i.e. a negative offset value) wraps a roll past 180 back into the bottom of the range', () => {
      // raw roll 170 - offset -200 = 370, wraps to 10
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(1700, 0, 0), updatedAtMs: 0};
      const offset: OrientationViewOffset = {rollDeg: -200, pitchDeg: 0, yawDeg: 0};
      expect(deriveOrientationViewState(telemetry, offset)).toMatchObject({rollDeg: 10});
    });
  });

  describe('yaw heading wraparound - normalized into [0, 360), never signed', () => {
    it('a yaw of 350 with zero offset stays 350, not -10 (heading convention, unlike roll/pitch)', () => {
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, 0, 350), updatedAtMs: 0};
      expect(deriveOrientationViewState(telemetry, ZERO_OFFSET)).toMatchObject({yawDeg: 350});
    });

    it('subtracting an offset that would go negative wraps back into [0, 360)', () => {
      // raw yaw 10 - offset 30 = -20, wraps to 340
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, 0, 10), updatedAtMs: 0};
      const offset: OrientationViewOffset = {rollDeg: 0, pitchDeg: 0, yawDeg: 30};
      expect(deriveOrientationViewState(telemetry, offset)).toMatchObject({yawDeg: 340});
    });

    it('a yaw offset that pushes past 360 wraps back to 0-based', () => {
      // raw yaw 350 - offset -30 = 380, wraps to 20
      const telemetry: TelemetryValue<MspAttitude> = {status: 'FRESH', value: attitude(0, 0, 350), updatedAtMs: 0};
      const offset: OrientationViewOffset = {rollDeg: 0, pitchDeg: 0, yawDeg: -30};
      expect(deriveOrientationViewState(telemetry, offset)).toMatchObject({yawDeg: 20});
    });
  });
});

describe('describeOrientationForAccessibility', () => {
  it('returns undefined for WAITING', () => {
    expect(describeOrientationForAccessibility({status: 'WAITING'})).toBeUndefined();
  });

  it('returns undefined for ERROR', () => {
    expect(describeOrientationForAccessibility({status: 'ERROR'})).toBeUndefined();
  });

  it('describes a LIVE state with roll right, pitch up, and a heading', () => {
    const state: OrientationViewState = {status: 'LIVE', rollDeg: 4, pitchDeg: 2, yawDeg: 274};
    expect(describeOrientationForAccessibility(state)).toBe('ميلان 4 درجة لليمين، ارتفاع المقدمة 2 درجة، الاتجاه 274 درجة');
  });

  it('describes negative roll as left and negative pitch as nose-down', () => {
    const state: OrientationViewState = {status: 'LIVE', rollDeg: -4, pitchDeg: -2, yawDeg: 90};
    expect(describeOrientationForAccessibility(state)).toBe(
      'ميلان 4 درجة لليسار، انخفاض المقدمة 2 درجة، الاتجاه 90 درجة',
    );
  });

  it('describes zero roll/pitch with level wording rather than "0 degrees left/up"', () => {
    const state: OrientationViewState = {status: 'LIVE', rollDeg: 0, pitchDeg: 0, yawDeg: 0};
    expect(describeOrientationForAccessibility(state)).toBe('بدون ميل جانبي، المقدمة أفقية، الاتجاه 0 درجة');
  });

  it('rounds fractional degrees before formatting', () => {
    const state: OrientationViewState = {status: 'LIVE', rollDeg: 4.6, pitchDeg: -1.4, yawDeg: 273.5};
    // Math.round: 4.6 -> 5, -1.4 -> -1, 273.5 -> 274
    expect(describeOrientationForAccessibility(state)).toBe(
      'ميلان 5 درجة لليمين، انخفاض المقدمة 1 درجة، الاتجاه 274 درجة',
    );
  });

  it('works for STALE the same as LIVE (same rollDeg/pitchDeg/yawDeg fields, ageMs simply ignored)', () => {
    const state: OrientationViewState = {status: 'STALE', rollDeg: 4, pitchDeg: 2, yawDeg: 274, ageMs: 900};
    expect(describeOrientationForAccessibility(state)).toBe('ميلان 4 درجة لليمين، ارتفاع المقدمة 2 درجة، الاتجاه 274 درجة');
  });
});
