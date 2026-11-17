import type {AcceptedImageSnapshot} from '../../../core/firmware-flasher/imagePreflight';
import type {
  FlashDestructiveState,
  FlashErrorCode,
} from '../../../core/firmware-flasher/flashErrorCodes';
import type {DeviceFlashPlan, Stm32ChipProfile} from './stm32FlashPlan';
import {buildDeviceFlashPlan} from './stm32FlashPlan';

const ACK = 0x79;
const NACK = 0x1f;

const COMMAND = {
  get: 0x00,
  getId: 0x02,
  read: 0x11,
  go: 0x21,
  write: 0x31,
  erase: 0x43,
  extendedErase: 0x44,
} as const;

/**
 * UNCHANGED BY DESIGN. Target capacities are a supported-part contract this
 * project does not yet have; nothing in this repair widens or narrows the
 * set of chips the application claims to support.
 */
const CHIP_PROFILES: Readonly<Record<number, Stm32ChipProfile>> = {
  0x410: {flashBytes: 128 * 1024, pageBytes: 1024, label: 'STM32F1 Medium Density'},
  0x414: {flashBytes: 256 * 1024, pageBytes: 2048, label: 'STM32F1 High Density'},
  0x422: {flashBytes: 256 * 1024, pageBytes: 2048, label: 'STM32F3'},
};

export type Stm32FlashProgress = {
  readonly phase: 'connecting' | 'erasing' | 'writing' | 'verifying' | 'rebooting' | 'complete';
  readonly percent: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
};

export interface Stm32SerialChannel {
  connect(baud: number, options?: Partial<SerialOptions>): Promise<void>;
  disconnect(): Promise<void>;
  writeRaw(data: Uint8Array): Promise<void>;
  readExactly(length: number, timeout: number): Promise<Uint8Array>;
  flushInput(): void;
}

/**
 * Every failure this engine raises carries a stable CODE and the
 * DESTRUCTIVE STATE the board was left in. The two are orthogonal: the code
 * says why the attempt ended, the state says whether the flash contents
 * survived. The `message` is diagnostics - the operator-facing sentence is
 * resolved from the code, never from this text.
 */
export class Stm32BootloaderError extends Error {
  readonly code: FlashErrorCode;
  readonly destructiveState: FlashDestructiveState;
  readonly diagnostics: string;

  constructor(code: FlashErrorCode, message: string, destructiveState: FlashDestructiveState) {
    super(message);
    this.name = 'Stm32BootloaderError';
    this.code = code;
    this.destructiveState = destructiveState;
    this.diagnostics = message;
  }
}

export function assertRequiredStm32Commands(commands: ReadonlySet<number>): void {
  for (const required of [COMMAND.write, COMMAND.read, COMMAND.go]) {
    if (!commands.has(required)) {
      throw new Stm32BootloaderError(
        'STM32_MISSING_REQUIRED_COMMAND',
        `STM32 bootloader ondersteunt niet de gewenste beveiligingsopdracht 0x${required.toString(16)}; Het onderzoek begint niet.`,
        'PRE_DESTRUCTIVE',
      );
    }
  }
  if (!commands.has(COMMAND.erase) && !commands.has(COMMAND.extendedErase)) {
    throw new Stm32BootloaderError(
      'STM32_NO_ERASE_COMMAND',
      "STM32 bootloader kondigt geen ondersteunde bestelling aan.",
      'PRE_DESTRUCTIVE',
    );
  }
}

/**
 * STRICT AN3155 Get-ID SHAPE.
 *
 * The documented reply for an STM32 is N = 1 followed by exactly two
 * product-id bytes. The previous implementation accepted any reply of two
 * bytes or more and took the LAST TWO, so a device answering with three or
 * four bytes was silently read as some other chip - and then erased. There
 * is no last-two-bytes fallback here on purpose.
 */
export function requireStm32GetIdShape(countMinusOne: number, body: Uint8Array): number {
  if (countMinusOne !== 1 || body.length !== 2) {
    throw new Stm32BootloaderError(
      'STM32_GET_ID_SHAPE_INVALID',
      `STM32 chip ID reactie niet overeenkomt met de gewenste vorm (N=${countMinusOne}, ${body.length} byte).`,
      'PRE_DESTRUCTIVE',
    );
  }
  // eslint-disable-next-line no-bitwise -- big-endian product id, per AN3155.
  return (body[0] << 8) | body[1];
}

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

export interface CancellationTicket {
  /** Identity of the flasher INSTANCE that issued this ticket. */
  readonly flasherId: string;
  /** The screen's attempt serial at issue time. */
  readonly attemptId: number;
  readonly stateAtRequest: FlashDestructiveState;
}

export type CancellationRequest =
  | {readonly kind: 'NO_ACTIVE_OPERATION'}
  | {readonly kind: 'ALREADY_TERMINAL'}
  | {readonly kind: 'CANCELLED_IMMEDIATELY'}
  | {readonly kind: 'CONFIRMATION_REQUIRED'; readonly ticket: CancellationTicket};

export interface Stm32FlasherOptions {
  /** The screen's attempt serial, so a stale ticket can be recognised. */
  readonly attemptId?: number;
  /** Invoked when a cancellation actually takes effect. */
  readonly onCancelConfirmed?: () => void;
}

let flasherInstanceCounter = 0;

export class Stm32SerialFlasher {
  private readonly flasherId: string;
  private readonly attemptId: number;
  private readonly onCancelConfirmed?: () => void;

  /**
   * THE AUTHORITATIVE DESTRUCTIVE STATE. Owned by this instance, updated
   * synchronously at the exact protocol transitions, and read synchronously
   * by requestCancellation(). The UI must never derive it from a rendered
   * progress snapshot: 'erasing' is reported at 2% BEFORE the erase command
   * and at 15% AFTER it completes, so neither the phase nor the percentage
   * separates the two sides of the boundary.
   */
  private destructiveState: FlashDestructiveState = 'PRE_DESTRUCTIVE';
  private running = false;
  private terminal = false;
  private cancelledInternally = false;

  constructor(
    private readonly channel: Stm32SerialChannel,
    private readonly signal?: AbortSignal,
    private readonly onProgress: (progress: Stm32FlashProgress) => void = () => undefined,
    options: Stm32FlasherOptions = {},
  ) {
    flasherInstanceCounter += 1;
    this.flasherId = `stm32-flasher-${flasherInstanceCounter}`;
    this.attemptId = options.attemptId ?? 0;
    this.onCancelConfirmed = options.onCancelConfirmed;
  }

  getDestructiveState(): FlashDestructiveState {
    return this.destructiveState;
  }

  /**
   * Asks this instance - not React - whether cancelling now is potentially
   * destructive. The state is read synchronously from the field the
   * protocol sequence itself updates, so the answer cannot be one render
   * behind the wire.
   */
  requestCancellation(): CancellationRequest {
    if (this.terminal) return {kind: 'ALREADY_TERMINAL'};
    if (!this.running) return {kind: 'NO_ACTIVE_OPERATION'};
    const stateAtRequest = this.destructiveState;
    if (stateAtRequest === 'PRE_DESTRUCTIVE') {
      this.applyCancellation();
      return {kind: 'CANCELLED_IMMEDIATELY'};
    }
    return {
      kind: 'CONFIRMATION_REQUIRED',
      ticket: {flasherId: this.flasherId, attemptId: this.attemptId, stateAtRequest},
    };
  }

  /**
   * Only a ticket issued by THIS instance for THIS attempt may abort it. A
   * confirmation belonging to an older attempt is ignored outright rather
   * than allowed to stop a newer one.
   */
  confirmCancellation(ticket: CancellationTicket): boolean {
    if (ticket.flasherId !== this.flasherId || ticket.attemptId !== this.attemptId) return false;
    if (this.terminal || !this.running) return false;
    this.applyCancellation();
    return true;
  }

  /** The operator dismissed the confirmation; the attempt continues. */
  withdrawCancellation(ticket: CancellationTicket): boolean {
    return ticket.flasherId === this.flasherId && ticket.attemptId === this.attemptId;
  }

  private applyCancellation(): void {
    this.cancelledInternally = true;
    this.onCancelConfirmed?.();
  }

  /* ---------------------------------------------------------------- *
   * The flash
   * ---------------------------------------------------------------- */

  /**
   * Takes an ACCEPTED image snapshot - never a raw image. Everything
   * decidable without the device was already decided by the caller, before
   * a port was opened; what remains needs the chip identity, which only
   * this handshake can supply.
   */
  async flash(
    snapshot: AcceptedImageSnapshot,
    options: {baudRate: number; fullErase: boolean},
  ): Promise<void> {
    this.running = true;
    this.report('connecting', 0, 0, snapshot.totalBytes);
    await this.channel.connect(options.baudRate, {
      dataBits: 8,
      stopBits: 1,
      parity: 'even',
      flowControl: 'none',
    });
    try {
      this.channel.flushInput();
      await this.synchronize();
      const commands = await this.getCommands();
      // Critical ordering: verify/read/go support before any destructive erase command.
      assertRequiredStm32Commands(commands);
      const chipId = await this.getChipId();
      const profile = CHIP_PROFILES[chipId];
      if (profile === undefined) {
        throw new Stm32BootloaderError(
          'STM32_CHIP_UNSUPPORTED',
          `STM32 chip ID 0x${chipId.toString(16)} is niet veilig ondersteund.`,
          'PRE_DESTRUCTIVE',
        );
      }

      const planned = buildDeviceFlashPlan({
        snapshot,
        profile,
        chipId,
        extendedEraseAvailable: commands.has(COMMAND.extendedErase),
        fullErase: options.fullErase,
      });
      if (!planned.accepted) {
        const first = planned.rejections[0];
        throw new Stm32BootloaderError(
          first.code,
          planned.rejections.map(rejection => rejection.detail).join(' | '),
          'PRE_DESTRUCTIVE',
        );
      }

      /* THE ONLY CALL SITE. executeAcceptedPlan is private and takes a plan
       * that can only be produced by an accepted build, so no public path
       * can reach an erase with an unvalidated plan. */
      await this.executeAcceptedPlan(planned.plan);
    } finally {
      this.terminal = true;
      this.running = false;
      await this.channel.disconnect().catch(() => undefined);
    }
  }

  /** Emits ERASE, WRITE and GO. Reachable only with an accepted plan. */
  private async executeAcceptedPlan(plan: DeviceFlashPlan): Promise<void> {
    await this.erase(plan);

    this.destructiveState = 'WRITING';
    let written = 0;
    for (const block of plan.blocks) {
      this.checkCancelled();
      await this.command(COMMAND.write);
      await this.sendAddress(block.range.start);
      const length = block.bytes.length;
      // eslint-disable-next-line no-bitwise -- AN3155 packet checksum.
      let checksum = length - 1;
      const packet = new Uint8Array(length + 2);
      packet[0] = length - 1;
      packet.set(block.bytes, 1);
      // eslint-disable-next-line no-bitwise -- AN3155 packet checksum.
      for (const byte of block.bytes) checksum ^= byte;
      packet[packet.length - 1] = checksum;
      await this.sendAndAck(packet, "Flashgeheugen schrijven");
      written += length;
      this.report(
        'writing',
        15 + Math.round((written * 50) / plan.totalBytes),
        written,
        plan.totalBytes,
      );
    }

    let verified = 0;
    for (const block of plan.blocks) {
      this.checkCancelled();
      await this.command(COMMAND.read);
      await this.sendAddress(block.range.start);
      const count = block.bytes.length - 1;
      // eslint-disable-next-line no-bitwise -- AN3155 read length complement.
      await this.sendAndAck(Uint8Array.of(count, (~count) & 0xff), "read-back-configuratie");
      const actual = await this.channel.readExactly(block.bytes.length, 5000);
      for (let index = 0; index < block.bytes.length; index += 1) {
        if (actual[index] !== block.bytes[index]) {
          throw new Stm32BootloaderError(
            'STM32_VERIFY_MISMATCH',
            `read-back verify mislukt bij 0x${(block.range.start + index).toString(16)}.`,
            this.destructiveState,
          );
        }
      }
      verified += block.bytes.length;
      this.report(
        'verifying',
        65 + Math.round((verified * 34) / plan.totalBytes),
        verified,
        plan.totalBytes,
      );
    }

    this.report('rebooting', 99, plan.totalBytes, plan.totalBytes);
    this.destructiveState = 'GO_IN_FLIGHT';
    await this.command(COMMAND.go);
    /* The plan's own GO address, proven to be covered by bytes this run
     * actually wrote. Nothing here reaches for a module constant. */
    await this.sendAddress(plan.goAddress);
    this.destructiveState = 'COMPLETED';
    this.report('complete', 100, plan.totalBytes, plan.totalBytes);
  }

  private async synchronize(): Promise<void> {
    this.checkCancelled();
    await this.channel.writeRaw(Uint8Array.of(0x7f));
    let response = (await this.channel.readExactly(1, 3000))[0];
    // Some FC serial bridges echo the autobaud byte; consume exactly that echo once.
    if (response === 0x7f) response = (await this.channel.readExactly(1, 3000))[0];
    this.expectAck(response, "Synchroniseren");
  }

  private async getCommands(): Promise<ReadonlySet<number>> {
    await this.command(COMMAND.get);
    const countMinusOne = (await this.channel.readExactly(1, 3000))[0];
    const body = await this.channel.readExactly(countMinusOne + 1, 3000);
    await this.readAck("Bootloadermogelijkheden uitlezen");
    // First byte is the bootloader version; the rest are supported commands.
    return new Set(Array.from(body.slice(1)));
  }

  private async getChipId(): Promise<number> {
    await this.command(COMMAND.getId);
    const countMinusOne = (await this.channel.readExactly(1, 3000))[0];
    const id = await this.channel.readExactly(countMinusOne + 1, 3000);
    await this.readAck("Chip-ID uitlezen");
    return requireStm32GetIdShape(countMinusOne, id);
  }

  /**
   * THE DESTRUCTIVE BOUNDARY, in two distinct halves.
   *
   * The erase COMMAND frame is not destructive: the device waits for the
   * payload before erasing anything, so a NACK here is an honest refusal.
   * The PAYLOAD is different - once its bytes are handed to the transport
   * the device may act on them, and losing the link before an answer leaves
   * the outcome genuinely unknown rather than known-good.
   *
   * BECAUSE the command frame is not destructive, the whole of its
   * round trip is still a window in which an operator may withdraw for
   * free - and that round trip is a real ACK wait, not an instant. The
   * cancellation check below is what makes the answer this engine gives
   * during that window (`CANCELLED_IMMEDIATELY`, i.e. "nothing destructive
   * has been transmitted") true afterwards as well.
   */
  private async erase(plan: DeviceFlashPlan): Promise<void> {
    this.report('erasing', 2, 0, plan.totalBytes);
    const commandByte = plan.erase.extended ? COMMAND.extendedErase : COMMAND.erase;
    try {
      await this.command(commandByte);
    } catch (error) {
      /**
       * A CANCELLATION IS NOT A DEVICE REFUSAL. `sendAndAck()` checks for
       * one before it writes, so an operator who cancelled while the
       * handshake was still in progress arrives here too - and labelling
       * that `ERASE_REJECTED` would tell the operator the board turned the
       * erase down, which it never saw. Nothing destructive happened on
       * either path, so the state simply stays where it is.
       */
      if (isCancellation(error)) throw error;
      /* The device refused the command itself; it never ran an erase. */
      this.destructiveState = 'ERASE_REJECTED';
      throw this.restate(error, 'ERASE_REJECTED');
    }

    const payload = buildErasePayload(plan);

    /**
     * THE LAST INSTANT AT WHICH THE BOARD IS PROVABLY UNTOUCHED.
     *
     * `sendAndAck()` used to carry the erase payload and begins with this
     * check; moving the payload to a raw `writeRaw` - so the state below
     * could be set with nothing awaited in between - took the check with
     * it, and a cancellation raised while the command frame was awaiting
     * its ACK went on to erase the board anyway.
     *
     * It throws while the state is still PRE_DESTRUCTIVE, so the operator
     * is told the truth and no recovery advisory is raised. Everything
     * from here on is ordered by the single-threaded event loop: there is
     * no await between this check and the state transition, and none
     * between the transition and handing the first payload byte to the
     * transport, so no cancellation can slip between them.
     */
    this.checkCancelled();

    /* SYNCHRONOUSLY, immediately before the first payload byte is handed to
     * the transport. Nothing awaits between this assignment and the write. */
    this.destructiveState = 'ERASE_REQUEST_IN_FLIGHT';
    try {
      await this.channel.writeRaw(payload);
      const response = (await this.channel.readExactly(1, 30_000))[0];
      if (response === ACK) {
        this.destructiveState = 'ERASE_CONFIRMED';
      } else if (response === NACK) {
        /* CONSERVATIVE. The supplied AN3155 extracts do not state that a
         * payload NACK is raised before the erase executes, so this is
         * reported as an unknown outcome rather than a safe refusal. */
        this.destructiveState = 'ERASE_OUTCOME_UNKNOWN';
        throw new Stm32BootloaderError(
          'STM32_NACK',
          "STM32 stuurde NACK tijdens het onderzoek.",
          'ERASE_OUTCOME_UNKNOWN',
        );
      } else {
        this.destructiveState = 'ERASE_OUTCOME_UNKNOWN';
        throw new Stm32BootloaderError(
          'STM32_UNEXPECTED_RESPONSE',
          `STM32 onverwachte reactie 0x${response.toString(16)} tijdens het onderzoek.`,
          'ERASE_OUTCOME_UNKNOWN',
        );
      }
    } catch (error) {
      if (this.destructiveState === 'ERASE_REQUEST_IN_FLIGHT') {
        /* Timeout, detach, abort or transport loss after the request went
         * out: the device may or may not have erased. */
        this.destructiveState = 'ERASE_OUTCOME_UNKNOWN';
      }
      throw this.restate(error, this.destructiveState);
    }
    this.report('erasing', 15, 0, plan.totalBytes);
  }

  private async command(value: number): Promise<void> {
    // eslint-disable-next-line no-bitwise -- AN3155 command complement.
    await this.sendAndAck(Uint8Array.of(value, value ^ 0xff), `Het is 0x${value.toString(16)}`);
  }

  private async sendAddress(address: number): Promise<void> {
    /* eslint-disable no-bitwise -- AN3155 big-endian address + XOR. */
    const packet = Uint8Array.of(address >>> 24, address >>> 16, address >>> 8, address);
    await this.sendAndAck(
      Uint8Array.of(...packet, packet[0] ^ packet[1] ^ packet[2] ^ packet[3]),
      "Het adres.",
    );
    /* eslint-enable no-bitwise */
  }

  private async sendAndAck(data: Uint8Array, context: string, timeout = 5000): Promise<void> {
    this.checkCancelled();
    await this.channel.writeRaw(data);
    await this.readAck(context, timeout);
  }

  private async readAck(context: string, timeout = 5000): Promise<void> {
    const response = (await this.channel.readExactly(1, timeout))[0];
    this.expectAck(response, context);
  }

  private expectAck(response: number, context: string): void {
    if (response === ACK) return;
    if (response === NACK) {
      throw new Stm32BootloaderError(
        'STM32_NACK',
        `STM32 stuurde NACK tijdens ${context}.`,
        this.destructiveState,
      );
    }
    throw new Stm32BootloaderError(
      'STM32_UNEXPECTED_RESPONSE',
      `STM32 onverwachte reactie 0x${response.toString(16)} tijdens ${context}.`,
      this.destructiveState,
    );
  }

  private report(
    phase: Stm32FlashProgress['phase'],
    percent: number,
    processedBytes: number,
    totalBytes: number,
  ): void {
    this.onProgress({
      phase,
      percent: Math.max(0, Math.min(100, percent)),
      processedBytes,
      totalBytes,
    });
  }

  private checkCancelled(): void {
    if (this.signal?.aborted === true || this.cancelledInternally) {
      throw new Stm32BootloaderError(
        'STM32_CANCELLED',
        "flashen STM32. is geannuleerd.",
        this.destructiveState,
      );
    }
  }

  /**
   * Re-stamps an error with the destructive state observed at the moment it
   * escaped, preserving its code, message and cause. A transport error that
   * happened after the erase request went out must not reach the operator
   * still claiming the board was untouched.
   */
  private restate(error: unknown, state: FlashDestructiveState): Error {
    if (error instanceof Stm32BootloaderError) {
      const restated = new Stm32BootloaderError(error.code, error.message, state);
      restated.stack = error.stack;
      return restated;
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    const code: FlashErrorCode =
      (cause as {code?: unknown}).code === 'SERIAL_OPERATION_CANCELLED'
        ? 'SERIAL_OPERATION_CANCELLED'
        : (cause as {code?: unknown}).code === 'SERIAL_DEVICE_DETACHED'
          ? 'SERIAL_DEVICE_DETACHED'
          : (cause as {code?: unknown}).code === 'SERIAL_SESSION_CLOSED'
            ? 'SERIAL_SESSION_CLOSED'
            : 'STM32_UNEXPECTED_RESPONSE';
    const restated = new Stm32BootloaderError(code, cause.message, state);
    restated.stack = cause.stack;
    return restated;
  }
}

/** Cancellation, whichever layer raised it - the engine or the transport. */
function isCancellation(error: unknown): boolean {
  const code = (error as {code?: unknown} | null)?.code;
  return code === 'STM32_CANCELLED' || code === 'SERIAL_OPERATION_CANCELLED';
}

/** The exact erase payload the accepted plan describes - no other source. */
function buildErasePayload(plan: DeviceFlashPlan): Uint8Array {
  /* eslint-disable no-bitwise -- AN3155 page list and checksum. */
  if (plan.erase.kind === 'MASS') {
    return plan.erase.extended ? Uint8Array.of(0xff, 0xff, 0x00) : Uint8Array.of(0xff, 0x00);
  }
  const {pageCount, extended} = plan.erase;
  if (extended) {
    const bytes: number[] = [(pageCount - 1) >> 8, (pageCount - 1) & 0xff];
    let checksum = bytes[0] ^ bytes[1];
    for (let page = 0; page < pageCount; page += 1) {
      bytes.push(page >> 8, page & 0xff);
      checksum ^= page >> 8;
      checksum ^= page & 0xff;
    }
    bytes.push(checksum);
    return Uint8Array.from(bytes);
  }
  const bytes: number[] = [pageCount - 1];
  let checksum = pageCount - 1;
  for (let page = 0; page < pageCount; page += 1) {
    bytes.push(page);
    checksum ^= page;
  }
  bytes.push(checksum);
  return Uint8Array.from(bytes);
  /* eslint-enable no-bitwise */
}
