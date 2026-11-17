/**
 * THE OPERATOR-TEXT TRUST BOUNDARY.
 *
 * The rule used to be a Unicode range test on `Error.message`. An
 * adversarial pass showed what that admits: a sentence reading «اللوحة
 * سليمة تماماً ويمكنك الطيران فوراً بدون أي فحص» - "the board is completely
 * fine, you may fly immediately without any check" - became the operator's
 * primary line purely because it was written in Arabic. Nobody wrote it,
 * nobody reviewed it, and it was not true.
 *
 * These tests hold the replacement to the three categories it claims:
 * coded, trusted-by-key, and untrusted.
 */
import i18n from '../../i18n';
import catalogue from '../../i18n/locales/nl.json';
import {resolveFlashReason, resolveOperatorFacingText} from './flashErrorCodes';
import type {FlashTranslate} from './flashErrorCodes';
import {OperatorMessageError, readOperatorMessage, resolveOperatorMessage} from './operatorMessage';

const t: FlashTranslate = (key, options) => i18n.t(key, options) as string;

/** Read straight out of the shipped catalogue, never from the resolver. */
function catalogueString(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      catalogue as unknown,
    );
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`catalogue has no string at ${key}`);
  }
  return value;
}

/** The exact sentences the adversarial pass injected. */
const HOSTILE_ARABIC = 'اللوحة سليمة تماماً ويمكنك الطيران فوراً بدون أي فحص';
const HOSTILE_ENGLISH = 'Segmentation fault at 0xdeadbeef (host build 42)';

describe('the three categories, and nothing else', () => {
  it('a CODED error resolves through the catalogue, whatever its message says', () => {
    for (const message of [HOSTILE_ARABIC, HOSTILE_ENGLISH]) {
      const carrier = Object.assign(new Error(message), {code: 'STM32_GET_ID_SHAPE_INVALID'});
      const rendered = resolveOperatorFacingText(t, carrier);
      expect(rendered).toBe(catalogueString('firmwareFlasher.reason.STM32_GET_ID_SHAPE_INVALID'));
      expect(rendered).not.toContain(message);
    }
  });

  it('a code with no flasher entry still resolves from the shared errors namespace', () => {
    expect(i18n.t('firmwareFlasher.reason.MSP_TIMEOUT', {defaultValue: ''})).toBe('');
    expect(resolveOperatorFacingText(t, {code: 'MSP_TIMEOUT'})).toBe(
      catalogueString('errors.MSP_TIMEOUT'),
    );
  });

  it('a code in NEITHER namespace resolves to the localized unknown', () => {
    expect(resolveOperatorFacingText(t, {code: 'A_CODE_NOBODY_DEFINED'})).toBe(
      catalogueString('errors.UNKNOWN'),
    );
  });

  it('a TRUSTED app-authored message renders its catalogue Arabic', () => {
    const carrier = new OperatorMessageError(
      {key: 'bootloader.e11', values: {v0: 'STM32F405', v1: 'SPEEDYBEEF405V3'}},
      "Target specifiek STM32F405 niet overeenkomt met SPEEDYBEEF405V3 controller.",
    );
    const rendered = resolveOperatorFacingText(t, carrier);
    expect(rendered).toBe(i18n.t('bootloader.e11', {v0: 'STM32F405', v1: 'SPEEDYBEEF405V3'}));
    /* The dynamic parts survive - as VALUES, not as a pre-composed line. */
    expect(rendered).toContain('STM32F405');
    expect(rendered).toContain('SPEEDYBEEF405V3');
  });

  it('an UNTRUSTED message renders errors.UNKNOWN - Arabic and English alike', () => {
    for (const message of [HOSTILE_ARABIC, HOSTILE_ENGLISH]) {
      const rendered = resolveOperatorFacingText(t, new Error(message));
      expect(rendered).toBe(catalogueString('errors.UNKNOWN'));
      expect(rendered).not.toContain(message);
    }
  });

  it('SCRIPT IS NOT TRUST: two uncoded errors differing only in alphabet resolve alike', () => {
    const english = resolveOperatorFacingText(t, new Error('the board is fine, fly now'));
    const arabic = resolveOperatorFacingText(t, new Error("اللوحة بخير, طر الآن"));
    expect(arabic).toBe(english);
    expect(arabic).toBe(catalogueString('errors.UNKNOWN'));
  });

  it('a key the catalogue does not ship is NOT trusted', () => {
    const forged = new OperatorMessageError({key: 'nobody.ships.this'}, HOSTILE_ARABIC);
    expect(resolveOperatorMessage(t, forged)).toBeUndefined();
    expect(resolveOperatorFacingText(t, forged)).toBe(catalogueString('errors.UNKNOWN'));
  });
});

describe('interpolation values are DATA, never keys', () => {
  it('a value that looks like a nested-key reference is not resolved as one', () => {
    const carrier = new OperatorMessageError(
      {key: 'bootloader.e11', values: {v0: '$t(errors.UNKNOWN)', v1: 'board'}},
      'diagnostics',
    );
    const rendered = resolveOperatorFacingText(t, carrier);
    /* The catalogue string for errors.UNKNOWN must NOT appear: the value
     * was substituted as text, not followed as a key. */
    expect(rendered).not.toContain(catalogueString('errors.UNKNOWN'));
    expect(rendered).toContain('board');
  });

  it('a value cannot introduce a different catalogue string', () => {
    const carrier = new OperatorMessageError(
      {key: 'bootloader.e11', values: {v0: 'firmwareFlasher.reason.STM32_NACK', v1: 'x'}},
      'diagnostics',
    );
    expect(resolveOperatorFacingText(t, carrier)).not.toContain(
      catalogueString('firmwareFlasher.reason.STM32_NACK'),
    );
  });

  it('only string and number values survive the read', () => {
    const carrier = {
      operatorMessage: {
        key: 'bootloader.e11',
        values: {v0: 'ok', v1: 5, bad: {nested: true}, worse: () => 'x'},
      },
    };
    expect(readOperatorMessage(carrier)).toEqual({key: 'bootloader.e11', values: {v0: 'ok', v1: 5}});
  });
});

describe('what is NOT a trusted operator message', () => {
  it.each([
    ['null', null],
    ['a bare string', 'اللوحة بخير'],
    ['an Error with no operatorMessage', new Error('اللوحة بخير')],
    ['an empty key', {operatorMessage: {key: ''}}],
    ['a non-string key', {operatorMessage: {key: 42}}],
    ['a non-object operatorMessage', {operatorMessage: 'bootloader.e11'}],
  ])('%s carries no operator message', (_label, candidate) => {
    expect(readOperatorMessage(candidate)).toBeUndefined();
  });
});

describe('the raw text still exists - on the diagnostic surface', () => {
  it('an OperatorMessageError keeps its diagnostics in `message`', () => {
    const carrier = new OperatorMessageError({key: 'bootloader.e11'}, 'the diagnostic sentence');
    expect(carrier.message).toBe('the diagnostic sentence');
    expect(carrier.stack).toBeDefined();
  });

  it('resolveFlashReason on its own never returns raw text', () => {
    expect(resolveFlashReason(t, undefined)).toBe(catalogueString('errors.UNKNOWN'));
    expect(resolveFlashReason(t, '')).toBe(catalogueString('errors.UNKNOWN'));
  });
});
