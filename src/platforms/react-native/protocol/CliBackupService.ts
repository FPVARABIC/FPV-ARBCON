import type {UsbSerialTransportClient} from '../transport';
import {bytesToBase64} from './base64';
import {
  CLI_DIFF_REPLY,
  CLI_PLAIN_REPLY,
  CliReplyAccumulator,
  stripCliEnvelope,
  type CliReplyExpectation,
} from './cliReplyReader';
import {ReactNativeSerialPort} from './ReactNativeSerialPort';

const MAX_BACKUP_CHARACTERS = 1024 * 1024;
const MAX_RESTORE_COMMANDS = 5000;

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0) & 0xff);
}

export type RestoreResult = {
  readonly commandCount: number;
  readonly errors: readonly string[];
};

export function isPlausibleCliBackup(text: string): boolean {
  if (text.length === 0 || text.length > MAX_BACKUP_CHARACTERS) return false;
  let hasComment = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) hasComment = true;
    for (const character of line) {
      const code = character.charCodeAt(0);
      if (!(code === 9 || (code >= 32 && code <= 126))) return false;
    }
  }
  return hasComment;
}

export function restoreCommands(text: string): string[] {
  if (!isPlausibleCliBackup(text)) throw new Error('ملف النسخة الاحتياطية CLI غير صالح.');
  const commands = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && line.toLowerCase() !== 'save');
  if (commands.length > MAX_RESTORE_COMMANDS) throw new Error('النسخة الاحتياطية تحتوي أوامر أكثر من الحد الآمن.');
  return commands;
}

export class CliBackupService {
  constructor(private readonly client: UsbSerialTransportClient) {}

  async capture(
    deviceId: number,
    portIndex: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const port = new ReactNativeSerialPort(this.client, deviceId, portIndex, signal);
    await port.connect(115200, {dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'});
    try {
      port.flushInput();
      await port.writeRaw(Uint8Array.of(0x23, 0x0d)); // #\r
      // Entering interactive mode prints a banner and the prompt, and
      // cannot print a heading, so the first prompt is the real one.
      await this.readReply(port, CLI_PLAIN_REPLY, 5000);
      port.flushInput();
      await port.writeRaw(asciiBytes('diff all\r'));
      // `diff` DOES print headings, so its reply is only complete once
      // the batch terminator has been seen - see cliReplyReader.
      const output = await this.readReply(port, CLI_DIFF_REPLY, 30_000);
      const backup = stripCliEnvelope(output, 'diff all');
      if (!isPlausibleCliBackup(backup)) throw new Error('لم يُرجع Flight Controller نسخة CLI صالحة.');
      return backup;
    } finally {
      await port.writeRaw(asciiBytes('exit\r')).catch(() => undefined);
      await port.disconnect().catch(() => undefined);
    }
  }

  async saveBackup(filename: string, text: string): Promise<boolean> {
    if (!isPlausibleCliBackup(text)) throw new Error('لن تُحفظ نسخة CLI غير صالحة.');
    return this.client.saveFirmwareFile(
      filename,
      'text/plain',
      bytesToBase64(asciiBytes(text)),
    );
  }

  async restore(
    deviceId: number,
    portIndex: number,
    backup: string,
    signal?: AbortSignal,
    onProgress: (done: number, total: number) => void = () => undefined,
  ): Promise<RestoreResult> {
    const commands = restoreCommands(backup);
    const port = new ReactNativeSerialPort(this.client, deviceId, portIndex, signal);
    const errors: string[] = [];
    await port.connect(115200, {dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'});
    try {
      await port.writeRaw(Uint8Array.of(0x23, 0x0d));
      await this.readReply(port, CLI_PLAIN_REPLY, 5000);
      for (let index = 0; index < commands.length; index += 1) {
        if (signal?.aborted) throw new Error('أُلغيَت استعادة إعدادات CLI.');
        port.flushInput();
        await port.writeRaw(asciiBytes(`${commands[index]}\r`));
        // A replayed line is a `set`, a `batch`, or a profile switch -
        // none of which can print a `# ` heading - so the first prompt
        // ends the reply, and the whole reply INCLUDING any
        // `###ERROR IN ...###` is in hand before this line runs.
        const reply = await this.readReply(port, CLI_PLAIN_REPLY, 5000);
        if (/###ERROR/i.test(reply)) errors.push(`${commands[index]}: ${reply.trim()}`);
        onProgress(index + 1, commands.length);
      }
      if (errors.length === 0) {
        await port.writeRaw(asciiBytes('save\r'));
      }
      return {commandCount: commands.length, errors};
    } finally {
      await port.disconnect().catch(() => undefined);
    }
  }

  /**
   * Reads one reply, deciding its end with the firmware's own rules
   * rather than with a regex over whatever has arrived.
   *
   * The accumulator is fed ONE BYTE AT A TIME on purpose: chunk
   * boundaries belong to the transport, not to the protocol, and a
   * reader whose answer depends on them is not reading the protocol.
   */
  private async readReply(
    port: ReactNativeSerialPort,
    expectation: CliReplyExpectation,
    timeout: number,
  ): Promise<string> {
    const deadline = Date.now() + timeout;
    const reply = new CliReplyAccumulator(expectation, MAX_BACKUP_CHARACTERS);
    while (Date.now() < deadline) {
      let byte: number;
      try {
        byte = (
          await port.readExactly(1, Math.max(1, deadline - Date.now()))
        )[0];
      } catch (error) {
        // The board stopped sending. For a command with no structural
        // terminator that silence IS the end of the reply - but only if
        // a prompt is already standing; otherwise the reply is genuinely
        // incomplete and must not be handed to anyone.
        if (reply.settleAtDeadline().kind === 'COMPLETE') return reply.text;
        throw error;
      }
      const state = reply.push(byte);
      if (state.kind === 'COMPLETE') return reply.text;
      if (state.kind === 'BINARY') {
        throw new Error('استجابة CLI تحتوي بيانات ثنائية غير متوقعة.');
      }
      if (state.kind === 'OVERFLOW') {
        throw new Error('استجابة CLI تجاوزت الحد الآمن.');
      }
    }
    if (reply.settleAtDeadline().kind === 'COMPLETE') return reply.text;
    throw new Error('انتهت مهلة انتظار CLI prompt.');
  }
}
