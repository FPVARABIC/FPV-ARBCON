/**
 * THIS APPLICATION IS NOT PUBLISHED BY, AFFILIATED WITH, OR ENDORSED BY
 * ANY THIRD-PARTY FIRMWARE PROJECT, AND ITS INTERFACE MUST NOT SUGGEST
 * OTHERWISE.
 *
 * =====================================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * =====================================================================
 *
 * FPV-ARBCON talks to flight controllers over MSP. MSP is a protocol,
 * and the boards that speak it are made and flashed by other people.
 * Naming one of those projects in the operator interface - on a chip, in
 * a heading, in an error, in a downloaded filename - reads as a claim of
 * association that this application has no right to make.
 *
 * So the surface is neutral. Internals are NOT: the wire identifier a
 * board reports, the compatibility enum that gates capabilities, the
 * pinned source citations in the protocol layer, the fixture names in
 * the test suites - all of those keep the real name, because they are
 * about which dialect is being spoken and getting them wrong would be a
 * protocol defect. What changes is only what a person reads.
 *
 * brandSurface.test.ts enforces the boundary by scanning every string a
 * UI file could render, so a new heading cannot quietly re-introduce it.
 *
 * =====================================================================
 * THE VOCABULARY
 * =====================================================================
 *
 * Replacements are chosen so the sentence still says something true and
 * actionable:
 *
 *   the project name in prose   -> البرنامج الثابت / نظام المتحكم
 *   a firmware FAMILY value     -> a capability statement (MSP متوافق)
 *   a wire identifier (BTFL)    -> not shown at all; it is a protocol
 *                                  field, and to an operator it is just
 *                                  the same brand in four letters
 *   a downloaded filename       -> FPV-ARBCON's own name
 *   a USB descriptor            -> the hardware, minus the brand
 *   a build-server error        -> "خادم البناء", which is what it is
 */

/**
 * Every written form the surface must not carry: the project name, its
 * common misspelling, and the four-character wire identifier that is the
 * same name in shorthand. Word-bounded on the identifier so it cannot
 * eat an unrelated token.
 */
const EXTERNAL_FIRMWARE_BRAND = /betaflight|betafight/gi;
const EXTERNAL_FIRMWARE_IDENTIFIER = /\bBTFL\b/g;

/** Neutral, and still descriptive: it IS firmware. */
const NEUTRAL_FIRMWARE_WORD = 'البرنامج الثابت';

/**
 * Strips the brand from text this application did not write - a server
 * error, a build log line, a USB descriptor - before it reaches a
 * screen. Latin replacement on purpose: these strings are English and a
 * lone Arabic word inside one reads worse than the neutral noun.
 */
export function sanitizeUserVisibleText(value: string): string {
  return value
    .replace(EXTERNAL_FIRMWARE_BRAND, 'Firmware')
    .replace(EXTERNAL_FIRMWARE_IDENTIFIER, 'MSP');
}

/** A file this application hands to the operator carries OUR name. */
export function firmwareFilenameLabel(filename: string): string {
  return filename
    .replace(EXTERNAL_FIRMWARE_BRAND, 'FPV-ARBCON')
    .replace(EXTERNAL_FIRMWARE_IDENTIFIER, 'FPV-ARBCON');
}

export function usbProductLabel(
  productName: string | null | undefined,
  fallback: string,
): string {
  if (!productName) return fallback;
  const withoutBrand = productName
    .replace(EXTERNAL_FIRMWARE_BRAND, '')
    .replace(EXTERNAL_FIRMWARE_IDENTIFIER, '')
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
    .replace(EXTERNAL_FIRMWARE_IDENTIFIER, '')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutBrand || null;
}

/**
 * WHAT A FIRMWARE FAMILY IS ALLOWED TO SAY ON SCREEN.
 *
 * The decoded family is a project name - the very thing this module
 * exists to keep off the surface - so it is reported as the CAPABILITY
 * the operator can act on instead:
 *
 *   the dialect this application verifies against -> "MSP متوافق"
 *   any other named project                       -> "MSP غير متحقَّق منه"
 *   nothing recognised                            -> "غير معروف"
 *
 * NOTHING IS LOST BY THIS. The distinction an operator acts on is
 * whether their board's interface is one this application has verified,
 * and that is exactly what the three states above say. The family value
 * itself is unchanged internally and still gates every capability check.
 */
export function firmwareFamilyLabel(family: string): string {
  const upper = family.trim().toUpperCase();
  if (upper.length === 0 || upper === 'UNKNOWN') return 'غير معروف';
  return upper === 'BETAFLIGHT' ? 'MSP متوافق' : 'MSP غير متحقَّق منه';
}

/**
 * The neutral noun to use where prose would otherwise name the project.
 * Exported so a screen writes `${firmwareNoun()} يفرض ...` rather than
 * each one inventing its own wording.
 */
export function firmwareNoun(): string {
  return NEUTRAL_FIRMWARE_WORD;
}

/**
 * True when a string still carries the brand in any written form.
 * The enforcement test uses it, and so can any surface that formats
 * text it did not author.
 */
export function containsExternalFirmwareBrand(value: string): boolean {
  return (
    new RegExp(EXTERNAL_FIRMWARE_BRAND.source, 'i').test(value) ||
    new RegExp(EXTERNAL_FIRMWARE_IDENTIFIER.source).test(value)
  );
}
