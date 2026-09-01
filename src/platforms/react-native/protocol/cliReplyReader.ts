/**
 * KNOWING WHEN A BETAFLIGHT CLI REPLY HAS ENDED.
 *
 * This exists because the obvious answer is wrong, and being wrong here
 * silently corrupts a backup or a restore.
 *
 * =====================================================================
 * THE PROTOCOL, READ OUT OF THE FIRMWARE
 * =====================================================================
 *
 * An interactive command produces exactly this byte sequence
 * (fc/cli.c, `processCharacter`, and the printers it calls):
 *
 *   <echo of each typed character>     cliWrite(c)              8547
 *   \r\n                               cliPrintLinefeed()       8489
 *   <the command's own output>         cmd->cliCommand(...)     8511
 *   \r\n#<space>                       cliPrompt()              1087-1090
 *
 * =====================================================================
 * WHY "READ UNTIL A LINE STARTING WITH #" CANNOT WORK
 * =====================================================================
 *
 * The prompt is not a distinctive string. Compare, verbatim:
 *
 *   cliPrompt()          cliPrint("\r\n# ");                    1089
 *   cliPrintHashLine(s)  cliPrint("\r\n# "); cliPrintLine(s);   371-372
 *
 * They emit the SAME FOUR BYTES. Every heading in a `diff` - `# version`,
 * `# start the command batch`, `# end the command batch` - begins with
 * the exact bytes the prompt is made of. A reader that accepts the first
 * `\r\n#` it sees stops three bytes into a document that has not begun.
 *
 * And the error marker is built from the same character again:
 *
 *   "###ERROR IN " cmdName ": " detail "###"                    477-484
 *
 * printed after a linefeed, so the wire carries `\r`, `\n`, `#`, `#`, `#`.
 * A reader that treats `\r\n#` as an ending never sees the word ERROR at
 * all - which is how a rejected command becomes an unnoticed one.
 *
 * =====================================================================
 * WHAT THE FIRMWARE DOES GIVE US
 * =====================================================================
 *
 * Three facts, each checked against the source, are enough:
 *
 * 1. THE PROMPT IS HASH-SPACE. Both `cliPrompt` and `cliPrintHashLine`
 *    emit `# ` - hash followed by ONE space. `###ERROR` is hash followed
 *    by hash. Requiring the space excludes every error marker
 *    deterministically, with no timing and no guessing. This alone is
 *    the whole fix for the restore path.
 *
 * 2. A HEADING IS NEVER THE LAST THING. `cliPrintHashLine` is
 *    `cliPrint("\r\n# ")` IMMEDIATELY followed by `cliPrintLine(str)`,
 *    and every call site passes a non-empty literal. So after a
 *    heading's `\r\n# ` more bytes always follow; after the prompt's,
 *    none do. A tail of `\r\n# ` is therefore a PROVISIONAL prompt: any
 *    further byte retracts it.
 *
 * 3. ONLY SOME COMMANDS PRINT HEADINGS AT ALL. `cliPrintHashLine` has a
 *    fixed set of call sites (board_name, manufacturer_id, signature,
 *    the bootloader and exit paths, `save`, `defaults`, and `printConfig`
 *    - i.e. `dump` and `diff`). `set` is not among them: it prints
 *    `"%s set to "` plus the value on success (5479-5480), or
 *    `cliPrintErrorLinef` plus the allowed range on failure (5482-5483).
 *
 *    So for a `set` - the only kind of command a restore replays - the
 *    FIRST `\r\n# ` genuinely is the prompt. No ambiguity, no waiting.
 *
 * 4. `diff` AND `dump` HAVE A STRUCTURAL END. `printConfig` closes with
 *    `cliPrintHashLine("end the command batch")` then
 *    `cliPrintLine("batch end")` (8184-8187), and nothing but the prompt
 *    follows. So once a `batch end` line has been seen, the next
 *    provisional prompt is the real one - again with no waiting.
 *
 * =====================================================================
 * WHAT IS HONESTLY NOT DECIDABLE
 * =====================================================================
 *
 * For a heading-printing command whose output carries NO structural
 * terminator - a `dump bare` on a build without USE_CLI_BATCH, say - the
 * prompt and a heading are indistinguishable until you know whether
 * anything follows, and nothing in the protocol tells you that. There is
 * no delimiter to find and none is invented here. That case falls back
 * to the caller's own deadline: if the board has gone quiet for the
 * whole budget AND a provisional prompt is the tail, the reply is
 * complete. That is not a short timeout standing in for knowledge; it is
 * the operation's own budget, reached only when the board really has
 * stopped talking. If the deadline arrives with no provisional prompt,
 * it is a genuine timeout and an error.
 *
 * Betaflight Configurator's own AutoBackup takes the other road - poll
 * the buffer every 100 ms and test whether it currently ends with a
 * prompt - which races the chunk boundary, and its own code carries a
 * "partial data is better than none" fallback for when it loses. That
 * behaviour is deliberately not copied: a partially captured backup is
 * worse than no backup, because it looks like one.
 */

/**
 * How a particular command's reply is known to have ended.
 *
 * `NO_HASH_LINES` - the command cannot print a `# ` heading, so the first
 * provisional prompt is the real one. Correct for `set`, and for
 * entering interactive mode.
 *
 * `HASH_LINES` - the command prints headings, so a provisional prompt is
 * only trusted once `completeWhen` has matched the accumulated body.
 */
export type CliReplyExpectation =
  | {readonly kind: 'NO_HASH_LINES'}
  | {readonly kind: 'HASH_LINES'; readonly completeWhen: RegExp};

/**
 * `printConfig` ends every non-bare dump or diff with a line that is
 * exactly `batch end` (fc/cli.c:8184-8187). Anchored to a line start so
 * a setting whose VALUE contained the words could not satisfy it.
 */
export const CLI_BATCH_END = /(?:^|\r?\n)batch end[ \t]*\r?\n/;

/** Betaflight's diff/dump reply. */
export const CLI_DIFF_REPLY: CliReplyExpectation = Object.freeze({
  kind: 'HASH_LINES',
  completeWhen: CLI_BATCH_END,
});

/** A `set`, or entering interactive mode: no headings are possible. */
export const CLI_PLAIN_REPLY: CliReplyExpectation = Object.freeze({
  kind: 'NO_HASH_LINES',
});

/**
 * The prompt, as the firmware writes it: a line break, a hash, and ONE
 * space, at the very end of what has arrived so far.
 *
 * The space is the load-bearing character. Without it this matches
 * `###ERROR`; with it, it cannot.
 */
const PROVISIONAL_PROMPT = /\r?\n# $/;

export type CliReplyState =
  /** More bytes are needed. */
  | {readonly kind: 'READING'}
  /** The reply is complete and `text` is the whole of it. */
  | {readonly kind: 'COMPLETE'}
  /** The byte was not something a text console may send. */
  | {readonly kind: 'BINARY'}
  /** The reply grew past the caller's ceiling. */
  | {readonly kind: 'OVERFLOW'};

/**
 * Accumulates one reply, one byte at a time.
 *
 * BYTE AT A TIME IS THE POINT. Chunk boundaries are an artefact of the
 * transport, not of the protocol, so a reader whose answer depends on
 * where a read happened to split is not reading the protocol at all.
 * Feeding this one byte at a time makes the outcome identical for any
 * chunking, which its own tests then prove rather than assume.
 */
export class CliReplyAccumulator {
  private buffer = '';

  constructor(
    private readonly expectation: CliReplyExpectation,
    private readonly maximumCharacters: number,
  ) {}

  get text(): string {
    return this.buffer;
  }

  /** True when the bytes so far END with something shaped like a prompt.
   *  Provisional: a further byte proves it was a heading instead. */
  get hasProvisionalPrompt(): boolean {
    return PROVISIONAL_PROMPT.test(this.buffer);
  }

  push(byte: number): CliReplyState {
    const printable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!printable) {
      return {kind: 'BINARY'};
    }
    this.buffer += String.fromCharCode(byte);
    if (this.buffer.length > this.maximumCharacters) {
      return {kind: 'OVERFLOW'};
    }
    return this.hasProvisionalPrompt && this.bodyIsComplete()
      ? {kind: 'COMPLETE'}
      : {kind: 'READING'};
  }

  /**
   * Called when the caller's deadline expires, or when the board stops
   * sending.
   *
   * A provisional prompt that has stood until the board went silent for
   * the whole budget IS the prompt - but ONLY for a command with no
   * structural terminator, where silence is the sole observation the
   * protocol offers.
   *
   * For a command that HAS a terminator this fallback is refused, and
   * that refusal is the point. A `diff` cut short by a brown-out or a
   * dropped link still ends with a prompt, and its bytes still look
   * exactly like a configuration - `# version`, `batch start`, a run of
   * `set` lines. The ONLY thing separating half a document from a whole
   * one is the missing `batch end`. Accepting it here would hand back a
   * truncated backup that passes every plausibility check and silently
   * restores an aircraft to a configuration it never had.
   */
  settleAtDeadline(): CliReplyState {
    if (this.expectation.kind !== 'NO_HASH_LINES') {
      return {kind: 'READING'};
    }
    return this.hasProvisionalPrompt ? {kind: 'COMPLETE'} : {kind: 'READING'};
  }

  private bodyIsComplete(): boolean {
    return this.expectation.kind === 'NO_HASH_LINES'
      ? true
      : this.expectation.completeWhen.test(this.buffer);
  }
}

/**
 * Strips the parts of a reply that belong to the console rather than to
 * the answer: the echoed command at the front and the prompt at the back.
 *
 * The echo is removed by NAME rather than by taking the first line,
 * because a reply whose first line is not the echo means the exchange
 * was not what the caller thought it was, and silently discarding a line
 * of real output would hide that.
 */
export function stripCliEnvelope(reply: string, command: string): string {
  const normalised = reply.replace(/\r/g, '');
  const withoutPrompt = normalised.replace(/\n# $/, '');
  const echo = normalised.indexOf(command);
  const body =
    echo >= 0 ? withoutPrompt.slice(echo + command.length) : withoutPrompt;
  return body.replace(/^\n+/, '').replace(/\n+$/, '');
}
