import type { MspClient, TelemetryPauseLease } from '../../../core';
import {
  acquireMotorTestLease,
  type MotorTestLease,
} from '../../../core/protocol/motorTestLease';
import { RNMspTransport } from './RNMspTransport';
import {
  mspSessionCoordinator,
  type MspIdentificationState,
  type MspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';
import {
  acquireMotorConfigurationInterlock,
  type MotorConfigurationInterlockLease,
} from './motorConfigurationInterlock';
import { isMotorTestSessionActive } from './motorTestCapability';
import { fcRebootRecovery, type FcRebootRecovery } from './fcRebootRecovery';
import {
  setupAppStateTelemetryOwner,
  type SetupAppStatePhase,
} from './setupAppStateTelemetryOwner';

/**
 * SILENCE, NOT DURATION.
 *
 * This bound used to start when the command was written and fire five seconds
 * later no matter what, so a command that was still streaming was killed for
 * being long rather than for being stuck. `diff all` and `dump all` return a
 * whole configuration - many kilobytes - and on a slow USB link that takes
 * well over five seconds. Worse, `execute` treats a timeout as a dead session
 * and tears the CLI down, so the very first step of the Presets backup could
 * fail while the board was mid-sentence.
 *
 * Betaflight has no per-command deadline at all in its CLI tab; it stamps
 * `this.lastArrival` on every read and renders whatever arrives
 * (src/js/tabs/cli.js). The equivalent here is an INACTIVITY bound: the timer
 * is re-armed by every byte, so it now means "the board has said nothing for
 * five seconds", which is the condition actually worth failing on.
 */
const CLI_IDLE_TIMEOUT_MS = 5_000;

/**
 * A `#` at the end of a chunk is not proof the board has finished.
 *
 * The prompt is detected as a `#` at the tail of the buffer, but `diff` and
 * `dump` output contains `#` lines of its own, and serial data arrives in
 * chunks that can end anywhere - including exactly on one of them. Resolving
 * there truncated the response AND left the remainder to arrive during the
 * next command, attributing one command's output to another. Requiring the
 * prompt to still be the tail after a short silence costs a fraction of a
 * second and removes both failures; any further byte cancels it and reading
 * continues. Betaflight's own inter-line pacing is 15ms, so 40ms of quiet is
 * comfortably longer than a gap inside a continuous stream.
 */
const CLI_PROMPT_SETTLE_MS = 40;
const MAX_CLI_OUTPUT_CHARACTERS = 1024 * 1024;
const MAX_COMMAND_CHARACTERS = 512;
const SAVE_SETTLE_MS = 750;
const EXIT_SETTLE_MS = 120;

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0) % 256);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function printableText(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    if (
      byte === 8 ||
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      byte === 27 ||
      (byte >= 32 && byte <= 126)
    ) {
      result += String.fromCharCode(byte);
    }
  }
  return result;
}

/** Removes cursor-control bytes without changing command/error text. */
export function sanitizeCliOutput(text: string): string {
  const escapeSequence = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'g',
  );
  return text
    .replace(escapeSequence, '')
    .replace(/[\b\x7f]/g, '')
    .replace(/\r/g, '');
}

export function normalizeCliCommand(command: string): string | undefined {
  const value = command.trim();
  if (value.length === 0 || value.startsWith('#')) return undefined;
  if (value.length > MAX_COMMAND_CHARACTERS) {
    throw new Error('أمر CLI أطول من الحد الآمن.');
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error('أمر CLI يحتوي محارف غير مدعومة.');
    }
  }
  if (/^(?:save|exit)\b/i.test(value)) {
    throw new Error(
      'save وexit يداران من أزرار الجلسة ولا يقبلان داخل قائمة الأوامر.',
    );
  }
  return value;
}

export type CliCommandResult = {
  readonly command: string;
  readonly response: string;
  readonly error: boolean;
};

export type CliBatchResult = {
  readonly commandCount: number;
  readonly errors: readonly CliCommandResult[];
};

export type RawCliPhase =
  | 'IDLE'
  | 'ENTERING'
  | 'ACTIVE'
  | 'SENDING'
  | 'CLOSING';

type Resources = {
  readonly sessionKey: SetupUiSessionKey;
  readonly transport: RNMspTransport;
  readonly pause: TelemetryPauseLease;
  readonly ownership: MotorTestLease;
  readonly interlock: MotorConfigurationInterlockLease;
  releaseRaw: () => void;
};

type PromptWaiter = {
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
  /** Re-armed by every arriving byte; fires only on real silence. */
  idleTimer: ReturnType<typeof setTimeout>;
  /** Armed when the prompt appears; cancelled if anything else arrives. */
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly idleMs: number;
};

export type RawCliCoordinator = Pick<
  MspSessionCoordinator,
  | 'getSessionKey'
  | 'getActiveMspClient'
  | 'getActiveTransport'
  | 'getTelemetryScheduler'
  | 'getMotorTestSessionIdentity'
  | 'getIdentificationState'
>;

export interface RawCliSessionControllerOptions {
  readonly coordinator?: RawCliCoordinator;
  readonly appStatePhase?: () => SetupAppStatePhase;
  readonly motorTestActive?: (sessionId: string) => boolean;
  /** The app-wide reboot lifecycle. Injectable so a test can watch the
   *  hand-off without reaching for the singleton. */
  readonly rebootRecovery?: FcRebootRecovery;
}

/**
 * Owns one explicit CLI window over the existing serial session.
 * Telemetry is paused and drained before request admission is reserved;
 * only then are received bytes diverted away from MspClient.
 */
export class RawCliSessionController {
  private readonly coordinator: RawCliCoordinator;
  private readonly appStatePhase: () => SetupAppStatePhase;
  private readonly motorTestActive: (sessionId: string) => boolean;
  private readonly rebootRecovery: FcRebootRecovery;
  private resources: Resources | undefined;
  private phase: RawCliPhase = 'IDLE';
  private receiveBuffer = '';
  private waiter: PromptWaiter | undefined;
  private output = '';
  private errorCount = 0;
  private readonly listeners = new Set<() => void>();

  constructor(options: RawCliSessionControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStatePhase =
      options.appStatePhase ?? (() => setupAppStateTelemetryOwner.getPhase());
    this.motorTestActive = options.motorTestActive ?? isMotorTestSessionActive;
    this.rebootRecovery = options.rebootRecovery ?? fcRebootRecovery;
  }

  getPhase(): RawCliPhase {
    return this.phase;
  }

  getOutput(): string {
    return this.output;
  }

  clearOutput(): void {
    this.requireActive();
    if (this.waiter !== undefined)
      throw new Error('انتظر اكتمال أمر CLI الحالي قبل مسح المخرجات.');
    this.output = '';
    this.receiveBuffer = '';
    this.notify();
  }

  getIdentification(sessionId: string): MspIdentificationState {
    return this.coordinator.getIdentificationState(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async begin(sessionKey: SetupUiSessionKey): Promise<void> {
    if (this.phase !== 'IDLE') throw new Error('هناك جلسة CLI نشطة بالفعل.');
    if (this.appStatePhase() !== 'ACTIVE')
      throw new Error('أعد التطبيق إلى الواجهة قبل بدء CLI.');
    if (this.motorTestActive(sessionKey.sessionId)) {
      throw new Error('أنه جلسة اختبار المحركات قبل فتح CLI.');
    }
    const currentKey = this.coordinator.getSessionKey(sessionKey.sessionId);
    if (!currentKey || currentKey.generation !== sessionKey.generation) {
      throw new Error('جلسة Flight Controller تغيّرت؛ أعد الاتصال.');
    }
    const client = this.coordinator.getActiveMspClient(sessionKey.sessionId) as
      | MspClient
      | undefined;
    const transport = this.coordinator.getActiveTransport(sessionKey.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(
      sessionKey.sessionId,
    );
    if (!client || !transport || !scheduler)
      throw new Error('جلسة MSP غير جاهزة لـCLI.');

    this.setPhase('ENTERING');
    const interlock = acquireMotorConfigurationInterlock(client);
    const pause = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    let ownership: MotorTestLease | undefined;
    scheduler.discardPendingDemands();
    try {
      await scheduler.waitUntilIdle();
      const requestedIdentity = this.coordinator.getMotorTestSessionIdentity(
        sessionKey.sessionId,
      );
      if (!requestedIdentity) throw new Error('تعذر تثبيت هوية جلسة CLI.');
      const acquired = acquireMotorTestLease({
        client,
        requestedIdentity,
        readCurrentIdentity: () =>
          this.coordinator.getMotorTestSessionIdentity(sessionKey.sessionId),
      });
      if (acquired.kind !== 'ACQUIRED') {
        throw new Error(`تعذر حجز رابط MSP لـCLI: ${acquired.reason}`);
      }
      ownership = acquired.lease;
      const releaseRaw = transport.enterRawMode(bytes => this.receive(bytes));
      this.resources = {
        sessionKey,
        transport,
        pause,
        ownership: acquired.lease,
        interlock,
        releaseRaw,
      };
      this.receiveBuffer = '';
      this.output = '';
      this.errorCount = 0;
      this.notify();
      await this.exchange('#', CLI_IDLE_TIMEOUT_MS, true);
      this.setPhase('ACTIVE');
    } catch (error) {
      ownership?.release();
      this.releaseResources({ pause, interlock });
      this.setPhase('IDLE');
      throw error;
    }
  }

  async execute(command: string): Promise<CliCommandResult> {
    const normalized = normalizeCliCommand(command);
    if (normalized === undefined) throw new Error('أدخل أمر CLI غير فارغ.');
    this.requireActive();
    this.setPhase('SENDING');
    try {
      const response = await this.exchange(normalized, CLI_IDLE_TIMEOUT_MS);
      const result = {
        command: normalized,
        response,
        error: /###ERROR/i.test(response),
      };
      if (result.error) this.errorCount += 1;
      return result;
    } catch (error) {
      await this.failAndRelease();
      throw error;
    } finally {
      if (this.resources !== undefined) this.setPhase('ACTIVE');
    }
  }

  async executeBatch(
    commands: readonly string[],
    onProgress: (done: number, total: number) => void = () => undefined,
  ): Promise<CliBatchResult> {
    const normalized = commands
      .map(normalizeCliCommand)
      .filter((command): command is string => command !== undefined);
    if (normalized.length === 0)
      throw new Error('الحزمة لا تحتوي أوامر CLI قابلة للتطبيق.');
    const errors: CliCommandResult[] = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const result = await this.execute(normalized[index]);
      if (result.error) errors.push(result);
      onProgress(index + 1, normalized.length);
    }
    return { commandCount: normalized.length, errors };
  }

  async captureDiffAll(): Promise<string> {
    const result = await this.execute('diff all');
    if (result.error) throw new Error('فشل إنشاء نسخة diff all.');
    return result.response
      .replace(/^\s*diff all\s*/i, '')
      .replace(/\n#\s*$/, '')
      .trim();
  }

  async saveTextFile(filename: string, text: string): Promise<boolean> {
    this.requireActive();
    return this.requireResources().transport.saveTextFile(filename, text);
  }

  /**
   * `save` IS A REBOOT, AND THE APPLICATION HAS TO SAY SO BEFORE IT HAPPENS.
   *
   * Betaflight's `save` writes EEPROM and then reboots (cli.c: cliSave ->
   * writeEEPROM + cliReboot), so the USB device disappears a moment after
   * this write lands. Every layer above used to learn that the same way it
   * learns about a cable being pulled out - which is why pressing save
   * left the operator on a connection screen waiting to be told to press
   * Connect, with Motors and every other screen holding a session id that
   * no longer named anything.
   *
   * The expectation is recorded BEFORE the bytes go out, not after: the
   * link can die between the write resolving and the next statement, and
   * a loss that arrives before the expectation is recorded is
   * indistinguishable from a fault. See fcRebootRecovery.ts for the
   * lifecycle this hands off to.
   */
  async saveAndClose(): Promise<void> {
    this.requireActive();
    if (this.errorCount > 0) {
      throw new Error(
        'لن يُرسل save بعد ظهور أخطاء CLI؛ اخرج دون حفظ وراجع الحزمة.',
      );
    }
    const {sessionKey} = this.requireResources();
    this.rebootRecovery.expectReboot(sessionKey.sessionId, 'CLI_SAVE');
    this.setPhase('CLOSING');
    try {
      await this.requireResources().transport.writeRawBytes(ascii('save\r'));
      await delay(SAVE_SETTLE_MS);
    } finally {
      this.releaseResources();
      this.setPhase('IDLE');
    }
  }

  async exitWithoutSave(): Promise<void> {
    if (this.resources === undefined) return;
    this.setPhase('CLOSING');
    try {
      await this.resources.transport
        .writeRawBytes(ascii('exit\r'))
        .catch(() => undefined);
      await delay(EXIT_SETTLE_MS);
    } finally {
      this.releaseResources();
      this.setPhase('IDLE');
    }
  }

  private async failAndRelease(): Promise<void> {
    await this.exitWithoutSave().catch(() => {
      this.releaseResources();
      this.setPhase('IDLE');
    });
  }

  private async exchange(
    command: string,
    timeout: number,
    rawEntry = false,
  ): Promise<string> {
    const resources = this.requireResources();
    if (this.waiter !== undefined)
      throw new Error('أمر CLI آخر ما زال قيد التنفيذ.');
    this.receiveBuffer = '';
    const response = new Promise<string>((resolve, reject) => {
      const waiter: PromptWaiter = {
        resolve,
        reject,
        idleMs: timeout,
        settleTimer: undefined,
        idleTimer: setTimeout(() => {
          if (this.waiter !== waiter) return;
          this.waiter = undefined;
          reject(new Error('انتهت مهلة انتظار CLI prompt.'));
        }, timeout),
      };
      this.waiter = waiter;
    });
    try {
      await resources.transport.writeRawBytes(
        ascii(rawEntry ? '#\r' : `${command}\r`),
      );
    } catch (error) {
      this.rejectWaiter(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return response;
  }

  private receive(bytes: Uint8Array): void {
    const incoming = printableText(bytes);
    if (!incoming) return;
    this.receiveBuffer += incoming;
    this.output = (this.output + incoming).slice(-MAX_CLI_OUTPUT_CHARACTERS);
    this.notify();
    const waiter = this.waiter;
    if (!waiter) return;
    // The board is talking, so it is not stuck: push the deadline out, and
    // withdraw any prompt we thought we had seen - these bytes prove it was a
    // chunk boundary inside the output, not the end of it.
    clearTimeout(waiter.idleTimer);
    if (waiter.settleTimer !== undefined) {
      clearTimeout(waiter.settleTimer);
      waiter.settleTimer = undefined;
    }
    waiter.idleTimer = setTimeout(() => {
      if (this.waiter !== waiter) return;
      this.waiter = undefined;
      waiter.reject(new Error('انتهت مهلة انتظار CLI prompt.'));
    }, waiter.idleMs);
    if (!/(?:^|\n)#\s*$/.test(sanitizeCliOutput(this.receiveBuffer))) return;
    waiter.settleTimer = setTimeout(() => {
      if (this.waiter !== waiter) return;
      this.waiter = undefined;
      clearTimeout(waiter.idleTimer);
      waiter.resolve(sanitizeCliOutput(this.receiveBuffer));
    }, CLI_PROMPT_SETTLE_MS);
  }

  private clearWaiterTimers(waiter: PromptWaiter): void {
    clearTimeout(waiter.idleTimer);
    if (waiter.settleTimer !== undefined) clearTimeout(waiter.settleTimer);
  }

  private rejectWaiter(error: Error): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (!waiter) return;
    this.clearWaiterTimers(waiter);
    waiter.reject(error);
  }

  private requireActive(): Resources {
    if (this.phase !== 'ACTIVE' || this.resources === undefined) {
      throw new Error('ابدأ جلسة CLI أولًا.');
    }
    return this.resources;
  }

  private requireResources(): Resources {
    if (!this.resources) throw new Error('جلسة CLI غير موجودة.');
    return this.resources;
  }

  private releaseResources(partial?: {
    pause: TelemetryPauseLease;
    interlock: MotorConfigurationInterlockLease;
  }): void {
    const resources = this.resources;
    this.resources = undefined;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) {
      this.clearWaiterTimers(waiter);
      waiter.reject(new Error('أُغلقت جلسة CLI.'));
    }
    if (resources) {
      resources.releaseRaw();
      resources.ownership.release();
      resources.pause.release();
      resources.interlock.release();
    } else if (partial) {
      partial.pause.release();
      partial.interlock.release();
    }
  }

  private setPhase(phase: RawCliPhase): void {
    this.phase = phase;
    this.notify();
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        /* subscriber isolation */
      }
    }
  }
}

export const rawCliSessionController = new RawCliSessionController();
