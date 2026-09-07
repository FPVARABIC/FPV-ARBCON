/**
 * THE TRUST BOUNDARY FOR OPERATOR-FACING TEXT.
 *
 * An error reaches the flasher screens from many places: this application's
 * own guards, the STM32 engine, the raw serial port, the MSP layer, the
 * platform transports, and - inevitably - the JavaScript runtime itself
 * when something is simply broken. Only some of that text was ever written
 * for an operator to read, and only some of it was ever reviewed.
 *
 * WHAT THIS REPLACES. The previous rule was a Unicode range test on
 * `Error.message`:
 *
 *     if (/[؀-ۿ]/.test(raw)) return raw;
 *
 * That is not a trust boundary. It asks what SCRIPT a string is written in,
 * which says nothing about who wrote it, whether anyone reviewed it, or
 * whether it is true. A sentence reading «اللوحة سليمة تماماً ويمكنك
 * الطيران فوراً» - "the board is completely fine, you may fly immediately" -
 * passes that test as easily as a real diagnosis does.
 *
 * WHAT REPLACES IT. Three explicit, structural categories:
 *
 *   1. a CODED engine error, resolved through the catalogue by its code;
 *   2. an APP-AUTHORED operator message, carried as a catalogue KEY plus
 *      interpolation VALUES - never as a pre-composed sentence;
 *   3. anything else, which is untrusted and renders `errors.UNKNOWN`.
 *
 * The raw message, its stack and any engine diagnostics survive - on the
 * diagnostic surfaces (the log and the flash report), which is where text
 * nobody reviewed belongs.
 *
 * VALUES ARE DATA, NOT KEYS. Interpolation values are substituted into an
 * already-selected catalogue string; they cannot select a different one.
 * i18next's `skipOnVariables` default keeps `$t(...)` inside a VALUE from
 * being resolved as a nested key, and `operatorMessage.test.ts` asserts
 * exactly that rather than trusting it.
 */

/** A message this application wrote, addressed by catalogue key. */
export interface OperatorMessage {
  /** A key that must exist in the shipped catalogue. */
  readonly key: string;
  /** Substituted into the catalogue string. Data, never a key. */
  readonly values?: Readonly<Record<string, string | number>>;
}

/** Implemented by every error class allowed to speak to the operator. */
export interface CarriesOperatorMessage {
  readonly operatorMessage: OperatorMessage;
}

/**
 * An app-authored operator error with no engine code behind it - a guard
 * this application decided to fail, in words it wrote itself.
 *
 * `message` stays the diagnostic sentence so logs, reports and any existing
 * `error.message` reader keep working unchanged; the operator line is built
 * from `operatorMessage` instead.
 */
export class OperatorMessageError extends Error implements CarriesOperatorMessage {
  readonly operatorMessage: OperatorMessage;

  constructor(operatorMessage: OperatorMessage, diagnostics: string) {
    super(diagnostics);
    this.name = 'OperatorMessageError';
    this.operatorMessage = operatorMessage;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads a structured operator message off an error, whatever class it is.
 * Shape is checked rather than `instanceof`, so an error that crossed a
 * module or realm boundary is still recognised - and anything that merely
 * looks Arabic is still not.
 */
export function readOperatorMessage(error: unknown): OperatorMessage | undefined {
  if (!isPlainRecord(error)) return undefined;
  const candidate = error.operatorMessage;
  if (!isPlainRecord(candidate)) return undefined;
  const {key, values} = candidate;
  if (typeof key !== 'string' || key.length === 0) return undefined;
  if (values === undefined) return {key};
  if (!isPlainRecord(values)) return {key};
  const safe: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number') safe[name] = value;
  }
  return {key, values: safe};
}

/** Minimal shape of i18next's `t`, so this module needs no i18n import. */
export type OperatorTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/**
 * Resolves a trusted app-authored message, or `undefined` when the error
 * carries none OR names a key the shipped catalogue does not have. A
 * missing key is treated as untrusted rather than rendered as its own name.
 */
export function resolveOperatorMessage(
  t: OperatorTranslate,
  error: unknown,
): string | undefined {
  const message = readOperatorMessage(error);
  if (message === undefined) return undefined;
  const rendered = t(message.key, {...(message.values ?? {}), defaultValue: ''});
  return typeof rendered === 'string' && rendered.length > 0 ? rendered : undefined;
}
