import {assertRequiredStm32Commands, Stm32BootloaderError} from './Stm32SerialFlasher';

describe('STM32 serial pre-erase capability gate', () => {
  it('accepts write/read/go with either erase command', () => {
    expect(() => assertRequiredStm32Commands(new Set([0x31, 0x11, 0x21, 0x44]))).not.toThrow();
    expect(() => assertRequiredStm32Commands(new Set([0x31, 0x11, 0x21, 0x43]))).not.toThrow();
  });

  it('refuses missing read-back, write, or GO support before destructive erase', () => {
    expect(() => assertRequiredStm32Commands(new Set([0x31, 0x21, 0x44]))).toThrow(Stm32BootloaderError);
    expect(() => assertRequiredStm32Commands(new Set([0x11, 0x21, 0x44]))).toThrow(/0x31/);
    expect(() => assertRequiredStm32Commands(new Set([0x31, 0x11, 0x44]))).toThrow(/0x21/);
  });
});
