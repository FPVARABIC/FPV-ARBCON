import {parseIntelHex} from '../../../core/firmware-flasher/intelHex';
import {runImagePreflight} from '../../../core/firmware-flasher/imagePreflight';
import type {AcceptedImageSnapshot} from '../../../core/firmware-flasher/imagePreflight';
import {recoveryAdvisoryFor} from '../../../core/firmware-flasher/flashErrorCodes';
import {ReactNativeSerialPort} from './ReactNativeSerialPort';
import {Stm32SerialFlasher} from './Stm32SerialFlasher';
import type {CancellationTicket} from './Stm32SerialFlasher';
import {createStm32Device, makeHexImage} from './__testUtils__/stm32Bootloader';
import type {Stm32DeviceConfig, Stm32Transcript} from './__testUtils__/stm32Bootloader';

/**
 * WHAT THE BOARD WAS LEFT IN, not what would be convenient to say.
 *
 * The erase COMMAND frame is not destructive - the device waits for the
 * payload before erasing, so a refusal there is honest. The PAYLOAD is
 * different: once its bytes are handed to the transport the device may act
 * on them, so losing the link before an answer leaves the outcome genuinely
 * unknown. Reporting that as "not erased" would send an operator to fly a
 * board that may be blank.
 */
function acceptedSnapshot(length = 64): AcceptedImageSnapshot {
  const preflight = runImagePreflight(parseIntelHex(makeHexImage(length)));
  if (!preflight.accepted) throw new Error('fixture must be acceptable');
  return preflight.snapshot;
}

/**
 * Waits for a REAL protocol milestone instead of a fixed sleep - but yields
 * with a timer rather than `setImmediate`. A `setImmediate` poll re-queues
 * itself every event-loop turn and pins a core for the whole wait; with the
 * suite running beside others that starves the very timers the flash needs
 * in order to make the progress being waited for.
 */
async function until(reached: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (reached()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>(resolve => {
      setTimeout(resolve, 2);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function run(
  device: Stm32DeviceConfig,
  options: {signal?: AbortSignal; snapshot?: AcceptedImageSnapshot} = {},
): Promise<{flasher: Stm32SerialFlasher; transcript: Stm32Transcript; error?: Error}> {
  const {client, transcript} = createStm32Device(device);
  const port = new ReactNativeSerialPort(client, 7, 0, options.signal);
  const flasher = new Stm32SerialFlasher(port, options.signal);
  try {
    await flasher.flash(options.snapshot ?? acceptedSnapshot(), {
      baudRate: 256000,
      fullErase: false,
    });
    return {flasher, transcript};
  } catch (error) {
    return {flasher, transcript, error: error as Error};
  }
}

describe('erase outcome states', () => {
  it('never sent: a failure before the erase command leaves PRE_DESTRUCTIVE', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'GET'});
    expect(error).toBeDefined();
    expect(flasher.getDestructiveState()).toBe('PRE_DESTRUCTIVE');
    expect(transcript.eraseCommandSent).toBe(false);
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  });

  it('command NACK: the device refused the erase, so it never ran', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'ERASE_COMMAND'});
    expect(error).toBeDefined();
    expect(transcript.eraseCommandSent).toBe(true);
    expect(transcript.erasePayloadBytes).toBeNull();
    expect(flasher.getDestructiveState()).toBe('ERASE_REJECTED');
    expect((error as {destructiveState?: string}).destructiveState).toBe('ERASE_REJECTED');
    /* A refusal before execution is NOT destructive - no scare advisory. */
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  });

  it('payload sent, ACK lost: the outcome is UNKNOWN, not "safe"', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'ERASE_PAYLOAD_SILENT'});
    expect(error).toBeDefined();
    /* The complete request really did reach the transport. */
    expect(transcript.erasePayloadBytes).not.toBeNull();
    expect(transcript.eraseAcknowledged).toBe(false);
    expect(flasher.getDestructiveState()).toBe('ERASE_OUTCOME_UNKNOWN');
    expect((error as {destructiveState?: string}).destructiveState).toBe('ERASE_OUTCOME_UNKNOWN');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_UNCERTAIN');
  }, 60_000);

  it('payload NACK: conservatively UNKNOWN, because the extracts do not cover it', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'ERASE_PAYLOAD_NACK'});
    expect(error).toBeDefined();
    expect(transcript.erasePayloadBytes).not.toBeNull();
    expect(flasher.getDestructiveState()).toBe('ERASE_OUTCOME_UNKNOWN');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_UNCERTAIN');
  });

  it('ACK then write failure: the destructive history is CONFIRMED and carried', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'WRITE_DATA'});
    expect(error).toBeDefined();
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(flasher.getDestructiveState()).toBe('WRITING');
    expect((error as {destructiveState?: string}).destructiveState).toBe('WRITING');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  });

  it('ACK then cancellation: still CONFIRMED destructive', async () => {
    const controller = new AbortController();
    const {client, transcript} = createStm32Device({writeDelayMs: 4});
    const port = new ReactNativeSerialPort(client, 7, 0, controller.signal);
    const flasher = new Stm32SerialFlasher(port, controller.signal);
    const pending = flasher.flash(acceptedSnapshot(2048), {baudRate: 256000, fullErase: false});
    await until(() => transcript.eraseAcknowledged, 'the erase acknowledgement');
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  }, 60_000);

  it('a completed flash ends COMPLETED with the plan address on the wire', async () => {
    const {flasher, transcript, error} = await run({});
    expect(error).toBeUndefined();
    expect(flasher.getDestructiveState()).toBe('COMPLETED');
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(transcript.goAddress).toBe(0x08000000);
  });

  /**
   * ERASE_CONFIRMED IS OBSERVED WHERE IT ACTUALLY LIVES.
   *
   * Its lifetime is the gap between the erase acknowledgement and the first
   * write, and `WRITING` overwrites it immediately afterwards - so every
   * assertion made from a FAILURE sees `WRITING` and would keep passing even
   * if the acknowledgement never promoted the state at all. The progress
   * relay fires inside that gap, which makes it the one honest place to read
   * the state from.
   */
  it('the state reads CONFIRMED at the erase-complete report, not before it', async () => {
    const seen: string[] = [];
    const {client} = createStm32Device({});
    const port = new ReactNativeSerialPort(client, 7, 0);
    const flasher: Stm32SerialFlasher = new Stm32SerialFlasher(port, undefined, progress => {
      if (progress.phase === 'erasing') {
        seen.push(`${progress.percent}:${flasher.getDestructiveState()}`);
      }
    });
    await flasher.flash(acceptedSnapshot(), {baudRate: 256000, fullErase: false});
    expect(seen).toEqual(['2:PRE_DESTRUCTIVE', '15:ERASE_CONFIRMED']);
  });
});

/**
 * A CLEANUP FAILURE IS NOT THE FAILURE. The port is closed in a `finally`,
 * so a disconnect that throws runs while a real flashing error is already
 * in flight. Whichever error reaches the operator decides whether they are
 * told the board was erased or merely that a port would not close.
 */
describe('cleanup never replaces the primary error', () => {
  /** A channel whose disconnect always throws, over a scripted device. */
  function brittleCleanup(device: Stm32DeviceConfig): {
    channel: ConstructorParameters<typeof Stm32SerialFlasher>[0];
    transcript: Stm32Transcript;
  } {
    const {client, transcript} = createStm32Device(device);
    const port = new ReactNativeSerialPort(client, 7, 0);
    return {
      transcript,
      channel: {
        connect: port.connect.bind(port),
        writeRaw: port.writeRaw.bind(port),
        readExactly: port.readExactly.bind(port),
        flushInput: port.flushInput.bind(port),
        disconnect: async () => {
          throw new Error('the probe made closing the port fail');
        },
      },
    };
  }

  it('a PRE-destructive refusal keeps its own code and its NONE advisory', async () => {
    const {channel, transcript} = brittleCleanup({faultAt: 'ERASE_COMMAND'});
    const flasher = new Stm32SerialFlasher(channel);
    await expect(
      flasher.flash(acceptedSnapshot(), {baudRate: 256000, fullErase: false}),
    ).rejects.toMatchObject({code: 'STM32_NACK'});
    expect(transcript.erasePayloadBytes).toBeNull();
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  });

  it('a POST-erase failure keeps its erased advisory', async () => {
    const {channel, transcript} = brittleCleanup({faultAt: 'WRITE_DATA'});
    const flasher = new Stm32SerialFlasher(channel);
    await expect(
      flasher.flash(acceptedSnapshot(), {baudRate: 256000, fullErase: false}),
    ).rejects.toBeDefined();
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  });

  it('a successful flash is not turned into a failure by a failing close', async () => {
    const {channel, transcript} = brittleCleanup({});
    const flasher = new Stm32SerialFlasher(channel);
    await flasher.flash(acceptedSnapshot(), {baudRate: 256000, fullErase: false});
    expect(flasher.getDestructiveState()).toBe('COMPLETED');
    expect(transcript.goAddress).toBe(0x08000000);
  });
});

/**
 * GO LAUNCHES WHAT WAS WRITTEN. A read-back that disagrees with the plan
 * means the board does not hold the image this run intended, so the one
 * thing that must not follow is a jump into it.
 */
describe('a failed verification is never followed by GO', () => {
  it('a read-back mismatch stops the run with the erase history intact', async () => {
    const {flasher, transcript, error} = await run({faultAt: 'VERIFY_MISMATCH'});
    expect((error as {code?: string} | undefined)?.code).toBe('STM32_VERIFY_MISMATCH');
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(transcript.goAddress).toBeNull();
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  });
});

/**
 * ONLY THE ISSUER MAY BE CANCELLED BY ITS OWN TICKET.
 *
 * A confirmation is answered by a human, so it can arrive arbitrarily late -
 * after the attempt it belonged to has ended and a NEW attempt, on a new
 * flasher instance, is already erasing. Honouring it then would abort a
 * healthy flash mid-write on the strength of a question about a different
 * one, so both halves of the identity are checked.
 */
describe('cancellation ticket identity', () => {
  async function armedMidFlash(attemptId: number): Promise<{
    flasher: Stm32SerialFlasher;
    pending: Promise<void>;
    ticket: CancellationTicket;
  }> {
    const {client, transcript} = createStm32Device({writeDelayMs: 4});
    const port = new ReactNativeSerialPort(client, 7, 0);
    const flasher = new Stm32SerialFlasher(port, undefined, () => undefined, {attemptId});
    const pending = flasher.flash(acceptedSnapshot(2048), {baudRate: 256000, fullErase: false});
    await until(() => transcript.eraseAcknowledged, 'the erase acknowledgement');
    const request = flasher.requestCancellation();
    if (request.kind !== 'CONFIRMATION_REQUIRED') {
      throw new Error(`expected a confirmation to be required, got ${request.kind}`);
    }
    return {flasher, pending, ticket: request.ticket};
  }

  it('refuses a ticket from a different flasher instance, and the flash survives', async () => {
    const {flasher, pending, ticket} = await armedMidFlash(7);
    expect(flasher.confirmCancellation({...ticket, flasherId: 'stm32-flasher-someone-else'})).toBe(
      false,
    );
    await expect(pending).resolves.toBeUndefined();
    expect(flasher.getDestructiveState()).toBe('COMPLETED');
  }, 60_000);

  it('refuses a ticket from a superseded attempt, and the flash survives', async () => {
    const {flasher, pending, ticket} = await armedMidFlash(7);
    expect(ticket.attemptId).toBe(7);
    expect(flasher.confirmCancellation({...ticket, attemptId: 6})).toBe(false);
    expect(flasher.confirmCancellation({...ticket, attemptId: 8})).toBe(false);
    await expect(pending).resolves.toBeUndefined();
    expect(flasher.getDestructiveState()).toBe('COMPLETED');
  }, 60_000);

  it('accepts the genuine ticket, and the flash stops', async () => {
    const {flasher, pending, ticket} = await armedMidFlash(7);
    expect(flasher.confirmCancellation(ticket)).toBe(true);
    await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
    /* Stopping does not erase the history: the board really was erased. */
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  }, 60_000);
});
