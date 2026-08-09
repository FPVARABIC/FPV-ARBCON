/* eslint-disable no-bitwise -- test vectors intentionally manipulate MSP masks. */
import type { GeneralConfigurationSnapshot } from '../../../state/generalConfigurationModel';
import { createGeneralConfigurationDraft } from '../../../state/generalConfigurationModel';
import { encodeChangedGeneralConfiguration } from './encodeGeneralConfiguration';

function snapshot(): GeneralConfigurationSnapshot {
  const rx = Uint8Array.from({ length: 39 }, (_, index) => index);
  rx[22] = 10;
  return {
    featureMaskRaw: 0x80000001,
    arming: {
      autoDisarmDelaySeconds: 5,
      deprecatedDisarmKillsSwitch: 0,
      smallAngleDegrees: 25,
      gyroCalibrationOnFirstArm: false,
    },
    beeper: {
      disabledMask: 0x80002000,
      disabledDshotBeaconMask: 0x40000000,
      dshotBeaconTone: 1,
    },
    advanced: {
      deprecatedGyroSyncDenom: 1,
      pidProcessDenom: 2,
      useContinuousUpdate: 1,
      motorProtocolRaw: 7,
      motorPwmRate: 480,
      motorIdleRaw: 550,
      deprecatedGyroUse32kHz: 0,
      motorInversionRaw: 1,
      deprecatedGyroToUse: 0,
      gyroHighFsr: 1,
      gyroMovementCalibrationThreshold: 48,
      gyroCalibrationDuration: 125,
      gyroYawOffset: -4,
      checkOverflow: 1,
      debugMode: 9,
      debugModeCount: 70,
    },
    rx: {
      serialRxProvider: 9,
      stickMax: 1900,
      stickCenter: 1500,
      stickMin: 1100,
      receiverMinUsec: 885,
      receiverMaxUsec: 2115,
      fpvCameraAngleDegrees: 10,
      rcSmoothingSetpointCutoff: 0,
      rcSmoothingThrottleCutoff: 0,
      rcSmoothingAutoFactorThrottle: 30,
      rcSmoothingAutoFactor: 30,
      rcSmoothing: 1,
      raw: rx,
    },
    craftName: 'QUAD',
    pilotName: 'PILOT',
    buildOptionIds: new Set(),
    gyroSampleRateHz: 8000,
  };
}

describe('encodeChangedGeneralConfiguration', () => {
  it('returns no groups for an untouched draft', () => {
    const original = snapshot();
    expect(
      encodeChangedGeneralConfiguration(
        original,
        createGeneralConfigurationDraft(original),
      ),
    ).toEqual([]);
  });

  it('patches only the owned RX and advanced fields', () => {
    const original = snapshot();
    const base = createGeneralConfigurationDraft(original);
    const writes = encodeChangedGeneralConfiguration(original, {
      ...base,
      fpvCameraAngleDegrees: 42,
      pidProcessDenom: 4,
    });
    expect(writes.map(write => write.group)).toEqual(['RX', 'ADVANCED']);
    const rx = writes[0].payload;
    expect(rx).toHaveLength(39);
    expect(rx[22]).toBe(42);
    expect(rx.filter((value, index) => index !== 22 && value !== index)).toEqual(
      new Uint8Array(0),
    );
    const advanced = writes[1].payload;
    expect(advanced).toHaveLength(19);
    expect(advanced[1]).toBe(4);
    expect(advanced[3]).toBe(7);
    expect(new DataView(advanced.buffer).getUint16(6, true)).toBe(550);
    expect(new DataView(advanced.buffer).getInt16(15, true)).toBe(-4);
  });

  it('preserves unknown high mask bits and rejects changes to them', () => {
    const original = snapshot();
    const base = createGeneralConfigurationDraft(original);
    const valid = encodeChangedGeneralConfiguration(original, {
      ...base,
      featureMaskRaw: (base.featureMaskRaw | 2 ** 22) >>> 0,
    });
    expect(new DataView(valid[0].payload.buffer).getUint32(0, true)).toBe(
      0x80400001,
    );
    expect(() =>
      encodeChangedGeneralConfiguration(original, {
        ...base,
        featureMaskRaw: (base.featureMaskRaw ^ 2 ** 31) >>> 0,
      }),
    ).toThrow('UNOWNED_FEATURE_CHANGED');
  });

  it('rejects non-ASCII controller labels before encoding', () => {
    const original = snapshot();
    expect(() =>
      encodeChangedGeneralConfiguration(original, {
        ...createGeneralConfigurationDraft(original),
        craftName: 'طائرة',
      }),
    ).toThrow('CRAFT_NAME_INVALID');
  });
});
