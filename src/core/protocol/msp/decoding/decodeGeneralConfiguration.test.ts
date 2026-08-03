import { MspPayloadReadError } from './MspPayloadReader';
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

  it('rejects truncated receiver payloads rather than inventing a camera value', () => {
    expect(() => decodeRxConfig(new Uint8Array(38))).toThrow(
      MspPayloadReadError,
    );
  });

  it('decodes bounded MSP2 text and rejects an oversized declaration', () => {
    expect(decodeMspText(Uint8Array.from([2, 3, 70, 80, 86]))).toEqual({
      type: 2,
      value: 'FPV',
    });
    expect(() => decodeMspText(Uint8Array.from([2, 17]))).toThrow(RangeError);
  });
});
