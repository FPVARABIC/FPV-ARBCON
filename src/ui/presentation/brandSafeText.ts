/**
 * USB descriptors, downloaded filenames and server errors are untrusted
 * presentation input.  The application keeps the original values for the
 * protocol/file operation, but it must not let a third-party product name
 * replace FPV-ARBCON's own identity in the operator interface.
 */
const EXTERNAL_FIRMWARE_BRAND = /betaflight/gi;

export function sanitizeUserVisibleText(value: string): string {
  return value.replace(EXTERNAL_FIRMWARE_BRAND, 'Firmware');
}

export function firmwareFilenameLabel(filename: string): string {
  return filename.replace(EXTERNAL_FIRMWARE_BRAND, 'FPV-ARBCON');
}

export function usbProductLabel(
  productName: string | null | undefined,
  fallback: string,
): string {
  if (!productName) return fallback;
  const withoutBrand = productName
    .replace(EXTERNAL_FIRMWARE_BRAND, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutBrand) return fallback;
  return /^STM32/i.test(withoutBrand)
    ? `متحكم طيران ${withoutBrand}`
    : withoutBrand;
}

export function usbManufacturerLabel(
  manufacturerName: string | null | undefined,
): string | null {
  if (!manufacturerName) return null;
  const withoutBrand = manufacturerName
    .replace(EXTERNAL_FIRMWARE_BRAND, '')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutBrand || null;
}

export function firmwareFamilyLabel(family: string): string {
  return family.toUpperCase() === 'BETAFLIGHT' ? 'MSP متوافق' : family;
}
