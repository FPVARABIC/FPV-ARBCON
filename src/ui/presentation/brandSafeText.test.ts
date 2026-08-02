import {
  firmwareFamilyLabel,
  firmwareFilenameLabel,
  sanitizeUserVisibleText,
  usbManufacturerLabel,
  usbProductLabel,
} from './brandSafeText';

describe('brand-safe operator copy', () => {
  it('keeps USB identity useful while removing an external product brand', () => {
    expect(usbProductLabel('Betaflight STM32F405', 'وحدة USB')).toBe(
      'متحكم طيران STM32F405',
    );
    expect(usbManufacturerLabel('Betaflight')).toBeNull();
  });

  it('uses FPV-ARBCON for displayed filenames without changing technical text elsewhere', () => {
    expect(
      firmwareFilenameLabel(
        'betaflight_2025.12.5_STM32F405_SPEEDYBEEF405V5.hex',
      ),
    ).toBe('FPV-ARBCON_2025.12.5_STM32F405_SPEEDYBEEF405V5.hex');
    expect(sanitizeUserVisibleText('Betaflight build server')).toBe(
      'Firmware build server',
    );
    expect(firmwareFamilyLabel('BETAFLIGHT')).toBe('MSP متوافق');
  });
});
