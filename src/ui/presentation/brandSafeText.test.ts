import {
  containsExternalFirmwareBrand,
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
  });

  it('reports a firmware family as the capability it implies, never as a project name', () => {
    // The dialect this application verifies against.
    expect(firmwareFamilyLabel('BETAFLIGHT')).toBe('MSP متوافق');
    // Case and stray whitespace are the wire's business, not the label's.
    expect(firmwareFamilyLabel('  betaflight ')).toBe('MSP متوافق');

    // Any OTHER named project is a real answer, and a different one: the
    // board speaks MSP, but not a dialect this application has verified.
    // It must not be flattened into "unknown" - the operator can read the
    // difference between "not checked" and "nothing identified".
    expect(firmwareFamilyLabel('INAV')).toBe('MSP غير متحقَّق منه');
    expect(firmwareFamilyLabel('EMUFLIGHT')).toBe('MSP غير متحقَّق منه');

    // Nothing identified at all.
    expect(firmwareFamilyLabel('UNKNOWN')).toBe('غير معروف');
    expect(firmwareFamilyLabel('')).toBe('غير معروف');
    expect(firmwareFamilyLabel('   ')).toBe('غير معروف');
  });

  it('never returns a label that still carries the brand', () => {
    const outputs = [
      firmwareFamilyLabel('BETAFLIGHT'),
      firmwareFamilyLabel('INAV'),
      firmwareFamilyLabel('UNKNOWN'),
      firmwareFilenameLabel('betaflight_4.5.1_STM32F405.hex'),
      sanitizeUserVisibleText('BTFL 4.5.1 (Betaflight)'),
      usbProductLabel('Betaflight STM32F405', 'وحدة USB'),
      usbProductLabel('BTFL', 'وحدة USB'),
      usbManufacturerLabel('Betaflight Devices') ?? '',
    ];
    expect(outputs.filter(containsExternalFirmwareBrand)).toEqual([]);

    // A product name that is ONLY the brand leaves nothing to show, so the
    // caller's fallback is used rather than an empty line on screen.
    expect(usbProductLabel('BTFL', 'وحدة USB')).toBe('وحدة USB');
    expect(usbManufacturerLabel('Betaflight')).toBeNull();
  });
});
