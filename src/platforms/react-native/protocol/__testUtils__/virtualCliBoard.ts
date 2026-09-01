/* eslint-disable no-bitwise -- masking bytes for the serial byte stream. */
/**
 * A VIRTUAL CLI, at the serial layer.
 *
 * Backup and Restore do not speak MSP - they open the flight controller's
 * text console, ask for `diff all`, and later replay those lines one at a
 * time. Testing that against a stubbed `CliBackupService` proves nothing
 * about the thing that actually goes wrong on a bench: a command the
 * board rejects, a prompt that never arrives, a restore that reports
 * success after writing half a configuration.
 *
 * So this implements the CLIENT the real `ReactNativeSerialPort` talks to
 * - openDevice / startReading / writeBytes / onDataReceived - and behind
 * it a console with settings storage. The real CliBackupService drives
 * it, unmodified.
 *
 * WHAT IT COPIES FROM THE REAL CLI, because the service depends on each:
 *   - `#` enters interactive mode and answers with the `# ` prompt
 *   - every command is answered, and the answer ends with a prompt; the
 *     service reads until it sees one and would hang without it
 *   - an unknown or malformed `set` answers `###ERROR: ...###`, which is
 *     the exact marker the service scans for
 *   - `save` is accepted and marks the settings persisted
 *
 * WHAT IT DOES NOT DO: validate values, reboot, or model any setting's
 * meaning. It stores strings, because that is all `diff all` and `set`
 * exchange.
 */

/** Betaflight answers an interactive session with "# " on its own line. */
const PROMPT = '\r\n# ';

export interface VirtualCliOptions {
  /** The settings `diff all` will report, as name -> value. */
  readonly settings: ReadonlyMap<string, string>;
  /** Heading TEXT, without the `# ` prefix - the board adds it, as
   *  cliPrintHashLine does. */
  readonly header?: readonly string[];
  /** Settings this board will refuse, as the real CLI refuses a name its
   *  firmware does not have. */
  readonly unknownSettings?: ReadonlySet<string>;
  /**
   * How the reply is broken into transport chunks.
   *
   * Chunk boundaries are an artefact of USB and the OS, never of the
   * protocol, so a reader that behaves differently for different
   * chunkings is reading the transport instead. Varying this is how that
   * gets proven rather than assumed.
   *
   *   number  fixed size (1 = one byte per delivery)
   *   'whole' one delivery per reply
   *   fn      caller-controlled, e.g. a seeded pseudo-random split
   */
  readonly chunking?: number | 'whole' | ((remaining: number) => number);
  /** Line ending the board uses. The firmware emits CRLF; LF exists here
   *  only to prove the reader does not depend on the CR. */
  readonly lineEnding?: '\r\n' | '\n';
  /** Stop answering entirely, to exercise a genuine timeout. */
  readonly silent?: boolean;
  /**
   * Cut the `diff all` reply short after N settings, as a board that
   * browns out or a link that drops mid-document would. The bytes still
   * look like a configuration; only the missing terminator says it is
   * half of one.
   */
  readonly truncateDiffAfter?: number;
}

type DataListener = (event: {sessionId: string; dataBase64: string}) => void;

function toBase64(text: string): string {
  const bytes = Array.from(text, character => character.charCodeAt(0) & 0xff);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa !== undefined
    ? globalThis.btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64(value: string): string {
  return globalThis.atob !== undefined
    ? globalThis.atob(value)
    : Buffer.from(value, 'base64').toString('binary');
}

export class VirtualCliBoard {
  /** Live settings. `save` copies these into `persisted`. */
  settings: Map<string, string>;
  persisted: Map<string, string>;
  savedCommandCount = 0;
  sawSave = false;
  readonly commands: string[] = [];
  readonly savedFiles: Array<{filename: string; text: string}> = [];
  private readonly header: readonly string[];
  private readonly unknown: ReadonlySet<string>;
  private readonly chunking: number | 'whole' | ((remaining: number) => number);
  private readonly eol: string;
  private readonly truncateDiffAfter?: number;
  silent: boolean;
  private listeners = new Set<DataListener>();
  private sessionId = 'virtual-cli-1';
  private pending = '';

  constructor(options: VirtualCliOptions) {
    this.settings = new Map(options.settings);
    this.persisted = new Map(options.settings);
    // Heading TEXT only; the `\r\n# ` prefix is added when printed,
    // exactly as cliPrintHashLine does.
    this.header = options.header ?? [
      'version',
      'Betaflight / STM32F405 (S405) 4.5.1',
      'start the command batch',
    ];
    this.unknown = options.unknownSettings ?? new Set();
    this.chunking = options.chunking ?? 'whole';
    this.eol = options.lineEnding ?? '\r\n';
    this.silent = options.silent === true;
    this.truncateDiffAfter = options.truncateDiffAfter;
  }

  /**
   * What `diff all` prints, byte for byte as the firmware prints it.
   *
   * The heading lines matter more than they look. Betaflight emits every
   * one through `cliPrintHashLine`, which is literally
   *
   *     cliPrint("\r\n# "); cliPrintLine(str);        (cli.c:368-376)
   *
   * so the wire carries `\r\n# version`, `\r\n# start the command
   * batch`, and so on. Reproducing that exactly is the whole reason this
   * board exists rather than a canned string: a heading and the CLI
   * PROMPT begin with the same four bytes, and any reader that cannot
   * tell them apart will stop in the middle of a backup.
   */
  diffAll(): string {
    // Built with CRLF; emit() rewrites it if this board speaks LF.
    let out = '';
    for (const heading of this.header) {
      out += `\r\n# ${heading}`;
    }
    out += '\r\nbatch start';
    let emitted = 0;
    for (const [name, value] of this.settings) {
      if (
        this.truncateDiffAfter !== undefined &&
        emitted >= this.truncateDiffAfter
      ) {
        // Stops WITHOUT the batch terminator, which is the only thing
        // that distinguishes this from a complete document.
        return out;
      }
      out += `\r\nset ${name} = ${value}`;
      emitted += 1;
    }
    out += '\r\n# end the command batch\r\nbatch end';
    return out;
  }

  /* ---- the UsbSerialTransportClient surface the port actually uses -- */

  async openDevice(): Promise<string> {
    return this.sessionId;
  }

  async closeSession(): Promise<void> {
    this.listeners.clear();
  }

  async startReading(): Promise<void> {}

  async stopReading(): Promise<void> {}

  async setBaudRate(): Promise<void> {}

  async setControlLines(): Promise<void> {}

  async saveFirmwareFile(
    filename: string,
    _mimeType: string,
    dataBase64: string,
  ): Promise<boolean> {
    this.savedFiles.push({filename, text: fromBase64(dataBase64)});
    return true;
  }

  onDataReceived(callback: DataListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onSessionDetached(): () => void {
    return () => undefined;
  }

  async writeBytes(_sessionId: string, dataBase64: string): Promise<void> {
    this.pending += fromBase64(dataBase64);
    // The console acts on carriage return, exactly like the real one, so
    // a command split across two writes still behaves.
    let index = this.pending.indexOf('\r');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.emit(this.respond(line));
      index = this.pending.indexOf('\r');
    }
  }

  private emit(text: string): void {
    if (this.silent) return;
    const wire = this.eol === '\n' ? text.replace(/\r\n/g, '\n') : text;
    for (const chunk of this.split(wire)) {
      const event = {sessionId: this.sessionId, dataBase64: toBase64(chunk)};
      for (const listener of Array.from(this.listeners)) listener(event);
    }
  }

  /** Cuts a reply into transport-sized deliveries. */
  private split(text: string): string[] {
    if (this.chunking === 'whole' || text.length === 0) return [text];
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      const remaining = text.length - offset;
      const size =
        typeof this.chunking === 'number'
          ? this.chunking
          : Math.max(1, Math.min(remaining, this.chunking(remaining)));
      chunks.push(text.slice(offset, offset + Math.max(1, size)));
      offset += Math.max(1, size);
    }
    return chunks;
  }

  private respond(line: string): string {
    const command = line.trim();
    if (command === '' || command === '#') {
      // Entering interactive mode.
      return `${PROMPT}`;
    }
    this.commands.push(command);
    if (command.toLowerCase() === 'diff all') {
      return `diff all${this.diffAll()}${PROMPT}`;
    }
    if (command.toLowerCase() === 'save') {
      this.sawSave = true;
      this.persisted = new Map(this.settings);
      return `\r\nSaving${PROMPT}`;
    }
    if (command.toLowerCase() === 'exit') {
      return `${PROMPT}`;
    }
    const assignment = /^set\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(command);
    if (assignment !== null) {
      const [, name, value] = assignment;
      if (this.unknown.has(name)) {
        // The exact marker CliBackupService scans for.
        return `\r\n###ERROR: INVALID NAME: ${name}###${PROMPT}`;
      }
      this.settings.set(name, value.trim());
      this.savedCommandCount += 1;
      return `\r\n${name} set to ${value.trim()}${PROMPT}`;
    }
    if (command.startsWith('batch') || command.startsWith('profile')) {
      return `${PROMPT}`;
    }
    return `\r\n###ERROR: UNKNOWN COMMAND: ${command}###${PROMPT}`;
  }
}
