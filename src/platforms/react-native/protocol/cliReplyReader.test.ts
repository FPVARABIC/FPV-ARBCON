/* eslint-disable no-bitwise -- seeded pseudo-random chunk splitting. */
/**
 * THE CLI REPLY CONTRACT, byte by byte.
 *
 * These are the protocol proofs. They feed the accumulator ONE BYTE AT A
 * TIME - the same way the reader does - so nothing here can pass because
 * a chunk happened to land conveniently, which is precisely how the two
 * defects this module exists to fix went unnoticed.
 *
 * Every fixture below is assembled from the firmware's own printers:
 *
 *   prompt        cliPrint("\r\n# ")                       cli.c:1089
 *   heading       cliPrint("\r\n# "); cliPrintLine(str)    cli.c:371-372
 *   error         "###ERROR IN " cmd ": " detail "###"     cli.c:477-484
 *   diff end      hash line + cliPrintLine("batch end")    cli.c:8184-8187
 */

import {
  CLI_BATCH_END,
  CLI_DIFF_REPLY,
  CLI_PLAIN_REPLY,
  CliReplyAccumulator,
  stripCliEnvelope,
} from './cliReplyReader';

const CEILING = 1024 * 1024;

/** Exactly what cliPrompt writes. */
const PROMPT = '\r\n# ';

/** Exactly what cliPrintHashLine writes for a heading. */
function heading(text: string): string {
  return `\r\n# ${text}\r\n`;
}

/** Exactly what cliPrintErrorLinef writes. */
function errorLine(command: string, detail: string): string {
  return `\r\n###ERROR IN ${command}: ${detail}###\r\n`;
}

/** Drives the accumulator one byte at a time and reports where, if
 *  anywhere, it declared the reply complete. */
function feed(
  text: string,
  expectation = CLI_PLAIN_REPLY,
): {completedAfter: number | undefined; value: string} {
  const reply = new CliReplyAccumulator(expectation, CEILING);
  for (let index = 0; index < text.length; index += 1) {
    const state = reply.push(text.charCodeAt(index));
    if (state.kind === 'COMPLETE') {
      return {completedAfter: index + 1, value: reply.text};
    }
    if (state.kind !== 'READING') {
      throw new Error(`unexpected ${state.kind} at byte ${index}`);
    }
  }
  return {completedAfter: undefined, value: reply.text};
}

describe('the prompt is hash-SPACE, which is what separates it from ###ERROR', () => {
  it('completes on a bare prompt', () => {
    const result = feed(PROMPT);
    expect(result.completedAfter).toBe(PROMPT.length);
  });

  it('does NOT complete on the first hash of an error marker', () => {
    // The whole restore defect in one assertion: the reader must still be
    // reading when `###ERROR` begins, or the marker never arrives.
    const stream = errorLine('set', 'INVALID NAME: gps_rescue_min_sats');
    expect(feed(stream).completedAfter).toBeUndefined();
  });

  it('delivers the complete error line before completing on the prompt', () => {
    const stream = `set x = 1\r\n${errorLine('set', 'INVALID NAME: x')}${PROMPT}`;
    const result = feed(stream);
    expect(result.completedAfter).toBe(stream.length);
    expect(result.value).toContain('###ERROR IN set: INVALID NAME: x###');
    expect(/###ERROR/i.test(result.value)).toBe(true);
  });

  it('is not fooled by a hash that is not followed by a space', () => {
    for (const tail of ['\r\n#', '\r\n##', '\r\n###', '\r\n#\t', '\r\n#x']) {
      expect(feed(`ok${tail}`).completedAfter).toBeUndefined();
    }
  });

  it('accepts LF-only line endings as well as CRLF', () => {
    expect(feed('ok\n# ').completedAfter).toBe(5);
  });
});

describe('a heading is not a prompt', () => {
  it('keeps reading through a heading, for a command that prints them', () => {
    const stream = `diff all${heading('version')}`;
    // The provisional prompt inside the heading must be retracted.
    expect(feed(stream, CLI_DIFF_REPLY).completedAfter).toBeUndefined();
  });

  it('reads a whole diff document across four headings', () => {
    const document =
      'diff all' +
      heading('version') +
      'Betaflight / STM32F405 (S405) 4.5.1\r\n' +
      heading('start the command batch') +
      'batch start\r\n' +
      'set gps_provider = UBLOX\r\n' +
      'set failsafe_procedure = GPS-RESCUE\r\n' +
      heading('end the command batch') +
      'batch end\r\n' +
      PROMPT;
    const result = feed(document, CLI_DIFF_REPLY);
    expect(result.completedAfter).toBe(document.length);
    expect(result.value).toContain('set gps_provider = UBLOX');
    expect(result.value).toContain('# version');
  });

  it('never completes a diff that lacks its batch terminator', () => {
    // Even though the stream ends with a perfectly-formed prompt.
    const truncated =
      'diff all' +
      heading('version') +
      heading('start the command batch') +
      'batch start\r\nset gps_provider = UBLOX\r\n' +
      PROMPT;
    expect(feed(truncated, CLI_DIFF_REPLY).completedAfter).toBeUndefined();
  });

  it('refuses to settle a terminator-bearing reply at the deadline', () => {
    // The safety rule: for `diff`, silence is NOT proof of completeness,
    // because a truncated document still ends with a prompt.
    const reply = new CliReplyAccumulator(CLI_DIFF_REPLY, CEILING);
    for (const character of `batch start\r\nset a = 1\r\n${PROMPT}`) {
      reply.push(character.charCodeAt(0));
    }
    expect(reply.hasProvisionalPrompt).toBe(true);
    expect(reply.settleAtDeadline().kind).toBe('READING');
  });

  it('DOES settle a terminator-free reply at the deadline', () => {
    // A command with no structural end has only silence to go on, and
    // that is stated rather than hidden.
    const reply = new CliReplyAccumulator(CLI_PLAIN_REPLY, CEILING);
    for (const character of 'banner') reply.push(character.charCodeAt(0));
    expect(reply.settleAtDeadline().kind).toBe('READING');
    for (const character of PROMPT) reply.push(character.charCodeAt(0));
    expect(reply.settleAtDeadline().kind).toBe('COMPLETE');
  });
});

describe('the answer does not depend on where the bytes were split', () => {
  const document =
    'diff all' +
    heading('version') +
    heading('start the command batch') +
    'batch start\r\nset a = 1\r\nset b = 2\r\n' +
    heading('end the command batch') +
    'batch end\r\n' +
    PROMPT;

  /** Feeds the same stream in chunks of `size`, byte-accumulated inside. */
  function feedChunked(size: number): string | undefined {
    const reply = new CliReplyAccumulator(CLI_DIFF_REPLY, CEILING);
    for (let offset = 0; offset < document.length; offset += size) {
      const chunk = document.slice(offset, offset + size);
      for (const character of chunk) {
        const state = reply.push(character.charCodeAt(0));
        if (state.kind === 'COMPLETE') return reply.text;
      }
    }
    return undefined;
  }

  it.each([1, 2, 3, 5, 8, 13, 64, 4096])(
    'produces the identical document in %i-byte chunks',
    size => {
      expect(feedChunked(size)).toBe(document);
    },
  );

  it('is identical under a pseudo-random split', () => {
    let seed = 20260819;
    const reply = new CliReplyAccumulator(CLI_DIFF_REPLY, CEILING);
    let offset = 0;
    let completed: string | undefined;
    while (offset < document.length && completed === undefined) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const size = 1 + (seed % 17);
      for (const character of document.slice(offset, offset + size)) {
        if (reply.push(character.charCodeAt(0)).kind === 'COMPLETE') {
          completed = reply.text;
          break;
        }
      }
      offset += size;
    }
    expect(completed).toBe(document);
  });
});

describe('guards that must survive the rewrite', () => {
  it('rejects a byte no text console may send', () => {
    const reply = new CliReplyAccumulator(CLI_PLAIN_REPLY, CEILING);
    expect(reply.push(0x00).kind).toBe('BINARY');
  });

  it('rejects a reply that grows past the ceiling', () => {
    const reply = new CliReplyAccumulator(CLI_PLAIN_REPLY, 4);
    for (const character of 'abcd') reply.push(character.charCodeAt(0));
    expect(reply.push('e'.charCodeAt(0)).kind).toBe('OVERFLOW');
  });

  it('matches the batch terminator only on its own line', () => {
    expect(CLI_BATCH_END.test('\r\nbatch end\r\n')).toBe(true);
    expect(CLI_BATCH_END.test('batch end\r\n')).toBe(true);
    // A value that merely contains the words must not end a document.
    expect(CLI_BATCH_END.test('\r\nset name = batch end\r\n')).toBe(false);
    expect(CLI_BATCH_END.test('\r\nbatch end')).toBe(false);
  });
});

describe('stripping the console envelope', () => {
  it('removes the echoed command and the trailing prompt, keeping the body', () => {
    const reply = `diff all${heading('version')}batch start\r\nset a = 1\r\nbatch end\r\n${PROMPT}`;
    expect(stripCliEnvelope(reply, 'diff all')).toBe(
      '# version\nbatch start\nset a = 1\nbatch end',
    );
  });

  it('keeps the whole body when the echo is absent, rather than eating a line', () => {
    // A reply that does not begin with the echo means the exchange was
    // not what the caller thought; discarding a line would hide that.
    const reply = `batch start\r\nset a = 1\r\nbatch end\r\n${PROMPT}`;
    expect(stripCliEnvelope(reply, 'diff all')).toBe(
      'batch start\nset a = 1\nbatch end',
    );
  });
});
