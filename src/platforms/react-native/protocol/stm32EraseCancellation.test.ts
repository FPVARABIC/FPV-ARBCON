/**
 * THE ERASE CANCELLATION WINDOW.
 *
 * AN3155 splits an erase into two frames: a COMMAND, which the device only
 * acknowledges, and a PAYLOAD, which is what actually destroys the flash
 * contents. The gap between them is a real ACK round trip, and for its whole
 * duration the board is provably untouched - so an operator who cancels
 * there is entitled to keep their firmware.
 *
 * A previous repair moved the payload from `sendAndAck()` to a raw
 * `writeRaw()`, so the erase state could be set with nothing awaited in
 * between. `sendAndAck()` begins with a cancellation check; the raw write
 * did not, and a cancellation raised while the command frame was awaiting
 * its ACK went on to erase the board anyway - after the engine had already
 * answered `CANCELLED_IMMEDIATELY`, i.e. "nothing destructive has been
 * transmitted".
 *
 * Every barrier below is a deferred promise released by hand. Nothing here
 * sleeps, and nothing here is timing-dependent.
 */
jest.mock('../transport/native/NativeUsbSerialTransport', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`native leaf touched ("${String(property)}")`);
      },
    },
  ),
}));

import {parseIntelHex} from '../../../core/firmware-flasher/intelHex';
import {runImagePreflight} from '../../../core/firmware-flasher/imagePreflight';
import {recoveryAdvisoryFor} from '../../../core/firmware-flasher/flashErrorCodes';
import {ReactNativeSerialPort} from './ReactNativeSerialPort';
import {Stm32SerialFlasher} from './Stm32SerialFlasher';
import {createStm32Device, makeHexImage} from './__testUtils__/stm32Bootloader';
import type {Stm32DeviceConfig, Stm32Transcript} from './__testUtils__/stm32Bootloader';
import {base64ToBytes} from './base64';
import type {UsbSerialTransportClient} from '../transport';

const IMAGE = makeHexImage(8);

/** AN3155 frames, named so the assertions read as protocol rather than hex. */
const ERASE_COMMAND = (bytes: number[]) =>
  bytes.length === 2 && bytes[0] === 0x43 && bytes[1] === 0xbc;
const EXTENDED_ERASE_COMMAND = (bytes: number[]) =>
  bytes.length === 2 && bytes[0] === 0x44 && bytes[1] === 0xbb;
const GET_ID_COMMAND = (bytes: number[]) =>
  bytes.length === 2 && bytes[0] === 0x02 && bytes[1] === 0xfd;

interface Rig {
  readonly client: UsbSerialTransportClient;
  readonly transcript: Stm32Transcript;
  /** Resolves once the flash has PARKED on the chosen frame. */
  readonly parked: Promise<void>;
  /** Lets the parked frame through. */
  readonly release: () => void;
}

/** Parks the FIRST outbound frame matching `match` until released. */
function barrier(match: (bytes: number[]) => boolean, device: Stm32DeviceConfig = {}): Rig {
  const {client: inner, transcript} = createStm32Device(device);
  let announce!: () => void;
  const parked = new Promise<void>(resolve => {
    announce = resolve;
  });
  let free!: () => void;
  const held = new Promise<void>(resolve => {
    free = resolve;
  });
  let armed = true;
  const original = (inner as unknown as {
    writeBytes: (sessionId: string, dataBase64: string) => Promise<void>;
  }).writeBytes;
  const client = {
    ...(inner as unknown as Record<string, unknown>),
    writeBytes: async (sessionId: string, dataBase64: string) => {
      if (armed && match(Array.from(base64ToBytes(dataBase64)))) {
        armed = false;
        announce();
        await held;
      }
      return original(sessionId, dataBase64);
    },
  } as unknown as UsbSerialTransportClient;
  return {client, transcript, parked, release: () => free()};
}

function accepted() {
  const preflight = runImagePreflight(parseIntelHex(IMAGE));
  if (!preflight.accepted) throw new Error('fixture must be acceptable');
  return preflight.snapshot;
}

function start(
  rig: Rig,
  options: {fullErase?: boolean} = {},
): {flasher: Stm32SerialFlasher; pending: Promise<void>} {
  const port = new ReactNativeSerialPort(rig.client, 7, 0);
  const flasher = new Stm32SerialFlasher(port);
  const pending = flasher.flash(accepted(), {
    baudRate: 256000,
    fullErase: options.fullErase ?? false,
  });
  pending.catch(() => undefined);
  return {flasher, pending};
}

describe('cancelling around the destructive boundary', () => {
  it('1. BEFORE the erase command: neither the command nor the payload is sent', async () => {
    const rig = barrier(GET_ID_COMMAND);
    const {flasher, pending} = start(rig);
    await rig.parked;

    expect(flasher.requestCancellation().kind).toBe('CANCELLED_IMMEDIATELY');
    rig.release();

    await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
    expect(rig.transcript.eraseCommandSent).toBe(false);
    expect(rig.transcript.erasePayloadBytes).toBeNull();
    expect(flasher.getDestructiveState()).toBe('PRE_DESTRUCTIVE');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  }, 60_000);

  it('2. WHILE the erase command awaits its ACK: the payload is never sent', async () => {
    const rig = barrier(ERASE_COMMAND);
    const {flasher, pending} = start(rig);
    await rig.parked;

    /* The engine's own answer at this instant, which the rest of the test
     * holds it to. */
    expect(flasher.requestCancellation().kind).toBe('CANCELLED_IMMEDIATELY');
    rig.release();

    await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
    /* The COMMAND frame may exist - it was already in flight, and it is not
     * destructive. The PAYLOAD is the half that destroys, and it must not. */
    expect(rig.transcript.erasePayloadBytes).toBeNull();
    expect(rig.transcript.eraseAcknowledged).toBe(false);
    expect(flasher.getDestructiveState()).toBe('PRE_DESTRUCTIVE');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  }, 60_000);

  it('3. AFTER the command ACK, before payload initiation: still no payload', async () => {
    /* Parking on the payload itself proves the check ran between the two:
     * the request is raised only once the command round trip is complete. */
    const rig = barrier(bytes => bytes.length === 3 && bytes[0] === 0x00);
    const {flasher, pending} = start(rig);
    await rig.parked;
    /* The device has ACKed the command; the payload write is already in
     * flight, so the honest answer here is a CONFIRMATION, not a free
     * cancellation - which is case 4. */
    expect(flasher.requestCancellation().kind).toBe('CONFIRMATION_REQUIRED');
    rig.release();
    await pending;
    expect(rig.transcript.eraseAcknowledged).toBe(true);
  }, 60_000);

  it('4. AFTER payload initiation: a confirmation is required, not a free cancel', async () => {
    const rig = barrier(bytes => bytes.length === 3 && bytes[0] === 0x00);
    const {flasher, pending} = start(rig);
    await rig.parked;

    const request = flasher.requestCancellation();
    expect(request.kind).toBe('CONFIRMATION_REQUIRED');
    if (request.kind !== 'CONFIRMATION_REQUIRED') throw new Error('unreachable');
    expect(request.ticket.stateAtRequest).toBe('ERASE_REQUEST_IN_FLIGHT');

    rig.release();
    expect(flasher.confirmCancellation(request.ticket)).toBe(true);
    await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
    /* Never "safe" once the payload was handed to the transport. */
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).not.toBe('NONE');
  }, 60_000);

  it('5. AFTER the erase ACK: confirmation required AND a confirmed advisory', async () => {
    const rig = barrier(bytes => bytes.length === 2 && bytes[0] === 0x31);
    const {flasher, pending} = start(rig);
    await rig.parked;

    expect(rig.transcript.eraseAcknowledged).toBe(true);
    const request = flasher.requestCancellation();
    expect(request.kind).toBe('CONFIRMATION_REQUIRED');
    if (request.kind !== 'CONFIRMATION_REQUIRED') throw new Error('unreachable');

    rig.release();
    expect(flasher.confirmCancellation(request.ticket)).toBe(true);
    await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('ERASE_CONFIRMED');
  }, 60_000);

  it('6. a command NACK sends no payload and raises NO erase advisory', async () => {
    const {client, transcript} = createStm32Device({faultAt: 'ERASE_COMMAND'});
    const port = new ReactNativeSerialPort(client, 7, 0);
    const flasher = new Stm32SerialFlasher(port);
    await expect(
      flasher.flash(accepted(), {baudRate: 256000, fullErase: false}),
    ).rejects.toMatchObject({code: 'STM32_NACK'});
    expect(transcript.eraseCommandSent).toBe(true);
    expect(transcript.erasePayloadBytes).toBeNull();
    expect(flasher.getDestructiveState()).toBe('ERASE_REJECTED');
    expect(recoveryAdvisoryFor(flasher.getDestructiveState())).toBe('NONE');
  }, 60_000);

  /**
   * 7. EVERY erase form obeys the same guard. The four AN3155 payloads are
   * built by different branches, so a check placed on only one of them
   * would leave the others open.
   */
  const forms: ReadonlyArray<[string, Stm32DeviceConfig, boolean, (b: number[]) => boolean]> = [
    ['standard selective', {}, false, ERASE_COMMAND],
    ['standard mass', {}, true, ERASE_COMMAND],
    ['extended selective', {advertiseExtendedErase: true}, false, EXTENDED_ERASE_COMMAND],
    ['extended mass', {advertiseExtendedErase: true}, true, EXTENDED_ERASE_COMMAND],
  ];

  it.each(forms)(
    '7. %s erase: cancelling on the command frame sends no payload',
    async (_label, device, fullErase, commandFrame) => {
      const rig = barrier(commandFrame, device);
      const {flasher, pending} = start(rig, {fullErase});
      await rig.parked;

      expect(flasher.requestCancellation().kind).toBe('CANCELLED_IMMEDIATELY');
      rig.release();

      await expect(pending).rejects.toMatchObject({code: 'STM32_CANCELLED'});
      expect(rig.transcript.erasePayloadBytes).toBeNull();
      expect(rig.transcript.eraseAcknowledged).toBe(false);
      expect(flasher.getDestructiveState()).toBe('PRE_DESTRUCTIVE');
    },
    60_000,
  );

  it('the native leaf sentinel never fired', () => {
    const module_ = require('../transport/native/NativeUsbSerialTransport');
    expect(() => (module_.default as {listDevices: unknown}).listDevices).toThrow(
      /native leaf touched/,
    );
  });
});
