/**
 * A VIRTUAL STM32 ROM BOOTLOADER, as a BYTE STREAM.
 *
 * Shared by the flash-plan, erase-uncertainty and rendered-disclosure
 * suites so they all drive the same device rather than three that could
 * drift apart.
 *
 * It is a stream machine, not a frame matcher, on purpose: an AN3155
 * read-length pair `N, ~N` is byte-identical in shape to a command frame,
 * so anything that dispatched on shape would answer the wrong question. It
 * consumes exactly the number of bytes the CURRENT protocol state defines.
 *
 * It records the transcript - every command, address, write frame and the
 * Get-ID reply - so a test can compare what went on the wire against what
 * an accepted plan said should go on the wire.
 */
import {base64ToBytes, bytesToBase64} from '../base64';
import type {UsbSerialDataEvent, UsbSerialTransportClient} from '../../transport';

export const ACK = 0x79;
export const NACK = 0x1f;

/** Where a scripted device may refuse or fall silent. */
export type Stm32FaultPoint =
  | 'NONE'
  | 'SYNC'
  | 'GET'
  | 'ERASE_COMMAND'
  /** The payload is received but answered with NACK. */
  | 'ERASE_PAYLOAD_NACK'
  /** The payload is received and NOTHING is ever answered. */
  | 'ERASE_PAYLOAD_SILENT'
  | 'WRITE_COMMAND'
  | 'WRITE_ADDRESS'
  | 'WRITE_DATA'
  | 'VERIFY_MISMATCH'
  | 'GO';

/**
 * A DETERMINISTIC REPLACEMENT FOR `writeDelayMs`.
 *
 * `writeDelayMs` buys a cancel window with real wall-clock sleeps, which
 * makes any test that relies on it a race against the machine. Under CPU
 * contention each 8 ms sleep stretches, the whole exchange overruns the
 * flasher's own ACK timeout, and the board never acknowledges the erase -
 * so the attempt genuinely fails and the screen truthfully says so. The
 * product is right and the test is measuring the runner's load.
 *
 * A barrier moves that decision from the clock to the test. The device
 * awaits [beforeWrite] before consuming each write, so the test can hold
 * the exchange open at an exact point, do something to the UI, and then
 * let it continue - with no wall-clock duration anywhere in the sequence,
 * and therefore nothing for load to stretch.
 *
 * Ordering only. A barrier must never introduce a real delay, or it would
 * reintroduce exactly the problem it exists to remove.
 */
export interface Stm32WriteBarrier {
  /** Awaited before write number [index] (0-based) is consumed. */
  readonly beforeWrite: (index: number) => Promise<void> | void;
}

export interface Stm32DeviceConfig {
  readonly productId?: number;
  /** Get-ID `N`. AN3155 mandates 1 for an STM32. */
  readonly chipIdCountMinusOne?: number;
  /** Get-ID body length. AN3155 mandates exactly two PID bytes. */
  readonly chipIdBodyLength?: number;
  readonly advertiseExtendedErase?: boolean;
  readonly advertisedCommands?: readonly number[];
  readonly faultAt?: Stm32FaultPoint;
  /** Milliseconds each accepted write takes, so a cancel has a real window. */
  readonly writeDelayMs?: number;
  /**
   * Deterministic alternative to [writeDelayMs]. When set it REPLACES the
   * delay: the two are mutually exclusive, because a test that wanted an
   * exact ordering and also slept would still be racing the clock.
   */
  readonly writeBarrier?: Stm32WriteBarrier;
}

export interface Stm32WriteFrame {
  readonly address: number;
  readonly bytes: number[];
  readonly checksumOk: boolean;
  readonly accepted: boolean;
}

export interface Stm32Transcript {
  readonly events: string[];
  readonly commands: number[];
  readonly addresses: number[];
  readonly writes: Stm32WriteFrame[];
  eraseCommandSent: boolean;
  eraseAcknowledged: boolean;
  erasePayloadBytes: number[] | null;
  goAddress: number | null;
  getIdReply: {countMinusOne: number; bodyLength: number} | null;
}

type Stage = 'SYNC' | 'CMD' | 'ERASE_PAYLOAD' | 'ADDR' | 'WRITE_DATA' | 'READ_N';

export function createStm32Device(config: Stm32DeviceConfig = {}): {
  client: UsbSerialTransportClient;
  transcript: Stm32Transcript;
} {
  const faultAt = config.faultAt ?? 'NONE';
  const productId = config.productId ?? 0x0410;
  const chipIdN = config.chipIdCountMinusOne ?? 1;
  const chipIdBodyLength = config.chipIdBodyLength ?? chipIdN + 1;
  const commands = config.advertisedCommands ?? [
    0x00, 0x02, 0x11, 0x21, 0x31,
    ...(config.advertiseExtendedErase === true ? [0x44] : [0x43]),
  ];

  const transcript: Stm32Transcript = {
    events: [],
    commands: [],
    addresses: [],
    writes: [],
    eraseCommandSent: false,
    eraseAcknowledged: false,
    erasePayloadBytes: null,
    goAddress: null,
    getIdReply: null,
  };

  const memory = new Map<number, number>();
  let stage: Stage = 'SYNC';
  let afterAddress: 'WRITE_DATA' | 'READ_N' | 'CMD' = 'CMD';
  let pendingAddress = 0;
  let eraseExtended = false;
  let inbox: number[] = [];
  let writeIndex = 0;
  let listener: ((event: UsbSerialDataEvent) => void) | undefined;

  const emit = (bytes: readonly number[]): void => {
    listener?.({sessionId: 'stm32', dataBase64: bytesToBase64(Uint8Array.from(bytes))});
  };

  function required(): number | null {
    switch (stage) {
      case 'SYNC':
        return 1;
      case 'CMD':
        return 2;
      case 'ADDR':
        return 5;
      case 'READ_N':
        return 2;
      case 'WRITE_DATA':
        return inbox.length < 1 ? null : inbox[0] + 3;
      case 'ERASE_PAYLOAD':
        if (eraseExtended) {
          if (inbox.length < 2) return null;
          if (inbox[0] === 0xff && inbox[1] === 0xff) return 3;
          /* eslint-disable-next-line no-bitwise -- AN3155 page-count header. */
          return 2 + 2 * (((inbox[0] << 8) | inbox[1]) + 1) + 1;
        }
        if (inbox.length < 1) return null;
        if (inbox[0] === 0xff) return 2;
        return inbox[0] + 3;
    }
  }

  /* eslint-disable complexity -- one protocol state machine, read top-down. */
  function step(frame: number[]): void {
    switch (stage) {
      case 'SYNC': {
        transcript.events.push('SYNC');
        if (frame[0] !== 0x7f || faultAt === 'SYNC') {
          emit([NACK]);
          return;
        }
        stage = 'CMD';
        emit([ACK]);
        return;
      }
      case 'CMD': {
        const command = frame[0];
        transcript.commands.push(command);
        // eslint-disable-next-line no-bitwise -- AN3155 command complement.
        if (frame[1] !== ((command ^ 0xff) & 0xff)) {
          emit([NACK]);
          return;
        }
        switch (command) {
          case 0x00:
            transcript.events.push('GET');
            if (faultAt === 'GET') {
              emit([NACK]);
              return;
            }
            emit([ACK, commands.length, 0x31, ...commands, ACK]);
            return;
          case 0x02: {
            transcript.events.push('GET_ID');
            transcript.getIdReply = {countMinusOne: chipIdN, bodyLength: chipIdBodyLength};
            const body = new Array<number>(chipIdBodyLength).fill(0);
            if (chipIdBodyLength >= 2) {
              // eslint-disable-next-line no-bitwise -- big-endian product id.
              body[chipIdBodyLength - 2] = (productId >> 8) & 0xff;
              body[chipIdBodyLength - 1] = productId & 0xff;
            }
            emit([ACK, chipIdN, ...body, ACK]);
            return;
          }
          case 0x43:
          case 0x44:
            transcript.events.push('ERASE_CMD');
            transcript.eraseCommandSent = true;
            if (faultAt === 'ERASE_COMMAND') {
              emit([NACK]);
              return;
            }
            eraseExtended = command === 0x44;
            stage = 'ERASE_PAYLOAD';
            emit([ACK]);
            return;
          case 0x31:
            transcript.events.push('WRITE_CMD');
            if (faultAt === 'WRITE_COMMAND') {
              emit([NACK]);
              return;
            }
            stage = 'ADDR';
            afterAddress = 'WRITE_DATA';
            emit([ACK]);
            return;
          case 0x11:
            transcript.events.push('READ_CMD');
            stage = 'ADDR';
            afterAddress = 'READ_N';
            emit([ACK]);
            return;
          case 0x21:
            transcript.events.push('GO_CMD');
            if (faultAt === 'GO') {
              emit([NACK]);
              return;
            }
            stage = 'ADDR';
            afterAddress = 'CMD';
            emit([ACK]);
            return;
          default:
            emit([NACK]);
            return;
        }
      }
      case 'ERASE_PAYLOAD': {
        stage = 'CMD';
        transcript.erasePayloadBytes = [...frame];
        if (faultAt === 'ERASE_PAYLOAD_SILENT') {
          transcript.events.push('ERASE_PAYLOAD_SILENT');
          return;
        }
        if (faultAt === 'ERASE_PAYLOAD_NACK') {
          transcript.events.push('ERASE_PAYLOAD_NACK');
          emit([NACK]);
          return;
        }
        transcript.eraseAcknowledged = true;
        memory.clear();
        transcript.events.push('ERASE_DONE');
        emit([ACK]);
        return;
      }
      case 'ADDR': {
        /* eslint-disable no-bitwise -- AN3155 big-endian address + XOR. */
        const xor = frame[0] ^ frame[1] ^ frame[2] ^ frame[3];
        pendingAddress = ((frame[0] << 24) | (frame[1] << 16) | (frame[2] << 8) | frame[3]) >>> 0;
        /* eslint-enable no-bitwise */
        transcript.addresses.push(pendingAddress);
        if (xor !== frame[4]) {
          stage = 'CMD';
          emit([NACK]);
          return;
        }
        if (afterAddress === 'WRITE_DATA' && faultAt === 'WRITE_ADDRESS') {
          stage = 'CMD';
          emit([NACK]);
          return;
        }
        if (afterAddress === 'CMD') {
          transcript.goAddress = pendingAddress;
          transcript.events.push('GO_ADDR');
        }
        stage = afterAddress === 'CMD' ? 'CMD' : afterAddress;
        emit([ACK]);
        return;
      }
      case 'WRITE_DATA': {
        stage = 'CMD';
        const count = frame[0] + 1;
        const payload = frame.slice(1, 1 + count);
        let computed = frame[0];
        // eslint-disable-next-line no-bitwise -- AN3155 packet checksum.
        for (const byte of payload) computed ^= byte;
        const checksumOk = computed === frame[frame.length - 1];
        const accepted = checksumOk && faultAt !== 'WRITE_DATA';
        transcript.writes.push({address: pendingAddress, bytes: payload, checksumOk, accepted});
        if (!accepted) {
          transcript.events.push(`WRITE_NACK_${count}`);
          emit([NACK]);
          return;
        }
        payload.forEach((byte, index) => memory.set(pendingAddress + index, byte));
        transcript.events.push(`WRITE_OK_${count}`);
        emit([ACK]);
        return;
      }
      case 'READ_N': {
        stage = 'CMD';
        const count = frame[0] + 1;
        transcript.events.push(`READ_OK_${count}`);
        const out: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const stored = memory.get(pendingAddress + index) ?? 0xff;
          // eslint-disable-next-line no-bitwise -- deliberate corruption.
          out.push(faultAt === 'VERIFY_MISMATCH' ? (stored ^ 0xff) & 0xff : stored);
        }
        emit([ACK, ...out]);
        return;
      }
    }
  }
  /* eslint-enable complexity */

  function pump(): void {
    for (;;) {
      const need = required();
      if (need === null || inbox.length < need) return;
      const frame = inbox.slice(0, need);
      inbox = inbox.slice(need);
      step(frame);
    }
  }

  const client = {
    openDevice: async () => {
      inbox = [];
      stage = 'SYNC';
      return 'stm32';
    },
    closeSession: async () => undefined,
    startReading: async () => undefined,
    stopReading: async () => undefined,
    setBaudRate: async () => undefined,
    setControlLines: async () => undefined,
    writeBytes: async (_sessionId: string, dataBase64: string) => {
      const index = writeIndex;
      writeIndex += 1;
      if (config.writeBarrier !== undefined) {
        // Ordering, decided by the test. No clock is consulted.
        await config.writeBarrier.beforeWrite(index);
      } else if (config.writeDelayMs !== undefined && config.writeDelayMs > 0) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, config.writeDelayMs);
        });
      }
      for (const byte of base64ToBytes(dataBase64)) inbox.push(byte);
      pump();
    },
    onDataReceived: (callback: (event: UsbSerialDataEvent) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    onSessionDetached: () => () => undefined,
    onError: () => () => undefined,
  } as unknown as UsbSerialTransportClient;

  return {client, transcript};
}

/** Intel-HEX record generation, so no checksum is ever hand-computed. */
export function hexRecord(type: number, offset: number, data: readonly number[]): string {
  // eslint-disable-next-line no-bitwise -- Intel HEX record layout.
  const body = [data.length, (offset >> 8) & 0xff, offset & 0xff, type, ...data];
  const checksum = (0x100 - body.reduce((sum, byte) => (sum + byte) & 0xff, 0)) & 0xff;
  return `:${[...body, checksum].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/** A HEX image of `length` bytes at 0x08000000 + `offset`. */
export function makeHexImage(length: number, offset = 0): string {
  const lines = [hexRecord(0x04, 0, [0x08, 0x00])];
  const bytes = Array.from({length}, (_unused, index) => (index * 7 + 0x13) & 0xff);
  for (let cursor = 0; cursor < length; cursor += 16) {
    lines.push(hexRecord(0x00, offset + cursor, bytes.slice(cursor, cursor + 16)));
  }
  lines.push(hexRecord(0x01, 0, []));
  return lines.join('\n');
}
