import { decodeArmingConfig } from './decodeArmingConfig';
import { decodeBeeperConfig } from './decodeBeeperConfig';
import { decodeMspText } from './decodeMspText';
import { decodeRxConfig } from './decodeRxConfig';

describe('general configuration MSP decoders', () => {
  it('decodes arming and beeper fields with unsigned masks', () => {
    expect(decodeArmingConfig(Uint8Array.from([5, 0, 25, 1]))).toEqual({
      autoDisarmDelaySeconds: 5,
      deprecatedDisarmKillsSwitch: 0,
      smallAngleDegrees: 25,
      gyroCalibrationOnFirstArm: true,
    });
    expect(
      decodeBeeperConfig(
        Uint8Array.from([0x01, 0x02, 0x03, 0x84, 4, 0x05, 0, 0, 0x80]),
      ),
    ).toEqual({
      disabledMask: 0x84030201,
      dshotBeaconTone: 4,
      disabledDshotBeaconMask: 0x80000005,
    });
  });

  it('reads camera angle at byte 22 and retains an independent payload copy', () => {
    const payload = Uint8Array.from({ length: 39 }, (_, index) => index);
    payload[22] = 37;
    const decoded = decodeRxConfig(payload);
    expect(decoded.serialRxProvider).toBe(0);
    expect(decoded.fpvCameraAngleDegrees).toBe(37);
    payload[22] = 90;
    expect(decoded.raw[22]).toBe(37);
  });

  it('READS a short payload so old firmware can still view its settings', () => {
    // Betaflight version-gates every trailing MSP_RX_CONFIG field over a
    // reader that returns null past the end, so an older board still populates
    // the tab. Demanding 39 bytes here meant it could not even be VIEWED.
    expect(() => decodeRxConfig(new Uint8Array(38))).not.toThrow();
    expect(decodeRxConfig(new Uint8Array(38)).raw).toHaveLength(38);
  });

  it('but the WRITE still refuses to patch offsets that did not arrive', () => {
    // The strict half of the pair: encodeReceiverConfig patches fixed offsets
    // inside the original response, so a truncated read can never become a
    // corrupt write.
    const encodeReceiver = require('../encoding/encodeReceiver') as typeof import('../encoding/encodeReceiver');
    expect(() =>
      encodeReceiver.encodeReceiverConfig(decodeRxConfig(new Uint8Array(38)), {
        fpvCameraAngleDegrees: 0, serialRxProvider: 0, rcSmoothing: 0,
        rcSmoothingSetpointCutoff: 0, rcSmoothingThrottleCutoff: 0,
        rcSmoothingAutoFactor: 0, rcSmoothingAutoFactorThrottle: 0,
        channelMap: 'AETR1234', rssiChannel: 0, deadband: 0, yawDeadband: 0,
        throttle3dDeadband: 0,
      } as never),
    ).toThrow(/truncated/);
  });

  it('decodes bounded MSP2 text and rejects an oversized declaration', () => {
    expect(decodeMspText(Uint8Array.from([2, 3, 70, 80, 86]))).toEqual({
      type: 2,
      value: 'FPV',
    });
    expect(() => decodeMspText(Uint8Array.from([2, 17]))).toThrow(RangeError);
  });
});
