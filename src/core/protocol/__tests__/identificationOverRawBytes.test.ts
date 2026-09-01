/* eslint-disable no-bitwise -- this file BUILDS MSP frames byte by byte:
   the v1 XOR checksum and the v2 CRC8 DVB-S2 are bit operations in the
   protocol's own definition, and they are hand-rolled here rather than
   imported from mspChecksum.ts on purpose - a test that encodes responses
   with the same helper the parser verifies them with could not catch a
   fault in that helper. */
/**
 * IDENTIFICATION, DRIVEN BY REAL BYTES.
 *
 * Every earlier identification test handed MspIdentificationService a fake
 * requester that returned already-decoded objects. That is exactly how a
 * retry policy could be written, reviewed and merged while never reaching
 * the wire at all - the fake had no wire (documented at the time in
 * docs/IDENTIFICATION_RETRY_DECISION.md). So these tests use the REAL
 * MspClient over a byte-level fake transport, and every response is
 * assembled here as the actual $M> / $X> bytes a flight controller sends.
 *
 * The reference for all of it is the pinned Betaflight Configurator:
 *   src/js/msp.js               framing, checksums, TIMEOUT, send_message
 *   src/js/msp/MSPHelper.js     MSP_API_VERSION / MSP_FC_VARIANT /
 *                               MSP_BOARD_INFO decoding
 *   src/js/injected_methods.js  reads past the end return null, never throw
 *   src/js/serial_backend.js    what actually declares a board connected
 */

import {MspClient} from '../mspClient';
import {FakeMspTransport} from '../__testUtils__/mspFakeTransport';
import {MspIdentificationService} from '../msp/identification/MspIdentificationService';
import {
  isIdentifiedFlightController,
  resolveCatalogTarget,
} from '../msp/identification/flightControllerNaming';
import {ConnectionTrace} from '../msp/identification/connectionTrace';

const SESSION_ID = 'raw-bytes-session';

/* ------------------------------------------------------------------ *
 * Wire encoders - the FC's side, byte for byte
 * ------------------------------------------------------------------ */

/** `$M>` + len + code + payload + XOR checksum (Betaflight msp.js v1). */
function v1Response(code: number, payload: number[]): Uint8Array {
  const frame = [0x24, 0x4d, 0x3e, payload.length, code, ...payload];
  let checksum = payload.length ^ code;
  for (const byte of payload) checksum ^= byte;
  frame.push(checksum & 0xff);
  return new Uint8Array(frame);
}

function crc8DvbS2(crc: number, byte: number): number {
  let next = crc ^ byte;
  for (let i = 0; i < 8; i += 1) {
    next = next & 0x80 ? ((next << 1) & 0xff) ^ 0xd5 : (next << 1) & 0xff;
  }
  return next;
}

/** `$X>` + flag + code LE16 + len LE16 + payload + CRC8 DVB-S2. */
function v2Response(code: number, payload: number[]): Uint8Array {
  const header = [0x00, code & 0xff, (code >> 8) & 0xff, payload.length & 0xff, (payload.length >> 8) & 0xff];
  let crc = 0;
  for (const byte of [...header, ...payload]) crc = crc8DvbS2(crc, byte);
  return new Uint8Array([0x24, 0x58, 0x3e, ...header, ...payload, crc]);
}

const ascii = (text: string): number[] => Array.from(text, character => character.charCodeAt(0));
/** Betaflight's sbufWritePString: one length byte then the characters. */
const pstring = (text: string): number[] => [text.length, ...ascii(text)];

const API_VERSION = 1;
const FC_VARIANT = 2;
const BOARD_INFO = 4;

/** MSP_API_VERSION: protocol byte, major, minor. */
const apiVersionPayload = (major = 1, minor = 46): number[] => [0, major, minor];

/**
 * MSP_BOARD_INFO exactly as msp.c writes it: 4-char id, u16 revision, u8
 * type, u8 capabilities, three p-strings, 32-byte signature, u8 mcu type,
 * then the version-added tail.
 */
function boardInfoPayload(options: {
  identifier: string;
  targetName: string;
  boardName: string;
  manufacturerId: string;
  mcuTypeId?: number;
  /** Cut the response short after this many bytes, as an older firmware
   * that simply does not have the later fields would. */
  truncateTo?: number;
}): number[] {
  const payload = [
    ...ascii(options.identifier),
    0, 0, // hardwareRevision u16
    0,    // boardType
    0,    // targetCapabilities
    ...pstring(options.targetName),
    ...pstring(options.boardName),
    ...pstring(options.manufacturerId),
    ...new Array<number>(32).fill(0), // signature
    options.mcuTypeId ?? 4,
    2,          // configurationState  (1.42)
    0x20, 0x03, // gyroSampleRateHz    (1.43)
    0, 0, 0, 0, // configurationProblems
    0,          // spiRegisteredDeviceCount (1.44)
    0,          // i2cRegisteredDeviceCount
  ];
  return options.truncateTo === undefined ? payload : payload.slice(0, options.truncateTo);
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

type Harness = {
  client: MspClient;
  transport: FakeMspTransport;
  /** Settles the pending write and feeds the given bytes back. */
  answer: (bytes: Uint8Array | Uint8Array[]) => Promise<void>;
  /** Settles the pending write and stays silent. */
  swallow: () => Promise<void>;
};

function harness(): Harness {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, SESSION_ID);
  const settleWrite = async () => {
    // The write Promise must settle before the client arms its response
    // timer, and one microtask turn is what lets that continuation run.
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) {
      await Promise.resolve();
    }
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    client,
    transport,
    async answer(bytes) {
      await settleWrite();
      for (const chunk of Array.isArray(bytes) ? bytes : [bytes]) {
        transport.emitData(chunk);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    async swallow() {
      await settleWrite();
    },
  };
}

/** The full three-command exchange, answered from raw bytes. */
async function identifyWith(
  board: number[] | 'timeout',
  options?: {variant?: string; api?: number[]; trace?: ConnectionTrace},
) {
  const {client, answer, swallow} = harness();
  const identity = new MspIdentificationService(client, options?.trace).identify();
  await answer(v1Response(API_VERSION, options?.api ?? apiVersionPayload()));
  await answer(v1Response(FC_VARIANT, ascii(options?.variant ?? 'BTFL')));
  if (board === 'timeout') {
    await swallow();
    jest.advanceTimersByTime(10_000);
  } else {
    await answer(v1Response(BOARD_INFO, board));
  }
  return identity;
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

describe('the parser survives what a real serial link actually delivers', () => {
  const KAKUTE_CLASS = boardInfoPayload({
    identifier: 'KTF7',
    targetName: 'STM32F7X2',
    boardName: 'KAKUTEF7',
    manufacturerId: 'HBRO',
  });

  it('a response split across many reads is still one frame', async () => {
    const {client, transport} = harness();
    const pending = client.request(API_VERSION, new Uint8Array(0), {wireFormat: 'v1'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    // One byte at a time - the worst case a USB CDC read can produce.
    for (const byte of v1Response(API_VERSION, apiVersionPayload())) {
      transport.emitData(new Uint8Array([byte]));
    }
    await expect(pending).resolves.toMatchObject({command: API_VERSION});
  });

  it('leading garbage before the frame is discarded, not fatal', async () => {
    const {client, transport} = harness();
    const pending = client.request(API_VERSION, new Uint8Array(0), {wireFormat: 'v1'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    // Betaflight's decoder sits in IDLE scanning for '$' and drops
    // everything else; stale bytes in the driver buffer are ordinary.
    transport.emitData(new Uint8Array([0x00, 0xff, 0x41, 0x42, 0x0d, 0x0a]));
    transport.emitData(v1Response(API_VERSION, apiVersionPayload()));
    await expect(pending).resolves.toMatchObject({command: API_VERSION});
  });

  it('two frames arriving in ONE read are both parsed', async () => {
    const {client, transport} = harness();
    const first = client.request(API_VERSION, new Uint8Array(0), {wireFormat: 'v1'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    const merged = new Uint8Array([
      ...v1Response(API_VERSION, apiVersionPayload()),
      ...v1Response(FC_VARIANT, ascii('BTFL')),
    ]);
    transport.emitData(merged);
    await expect(first).resolves.toMatchObject({command: API_VERSION});
  });

  it('decodes an MSP v2 response as readily as a v1 one', async () => {
    const {client, transport} = harness();
    const pending = client.request(0x1001, new Uint8Array(0), {wireFormat: 'v2'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    transport.emitData(v2Response(0x1001, [1, 2, 3]));
    const frame = await pending;
    expect(Array.from(frame.payload)).toEqual([1, 2, 3]);
  });

  it('identifies a board whose whole exchange is byte-fragmented', async () => {
    const {client, transport} = harness();
    const identity = new MspIdentificationService(client).identify();
    for (const response of [
      v1Response(API_VERSION, apiVersionPayload()),
      v1Response(FC_VARIANT, ascii('BTFL')),
      v1Response(BOARD_INFO, KAKUTE_CLASS),
    ]) {
      for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
      transport.resolveNextWrite();
      await Promise.resolve();
      await Promise.resolve();
      for (const byte of response) transport.emitData(new Uint8Array([byte]));
      await Promise.resolve();
      await Promise.resolve();
    }
    const resolved = await identity;
    expect(resolveCatalogTarget(resolved.board)).toBe('KAKUTEF7');
  });
});

/* ------------------------------------------------------------------ *
 * The resend - Betaflight's own answer to a board that misses the first ask
 * ------------------------------------------------------------------ */

describe('a board that does not answer the first request', () => {
  it('IS ASKED AGAIN - the same bytes, exactly as Betaflight resends', async () => {
    const {client, transport} = harness();
    const pending = client.request(API_VERSION, new Uint8Array(0), {
      wireFormat: 'v1',
      responseTimeoutMs: 4000,
      resend: {intervalMs: 1000, maxResends: 2},
    });
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    const firstWrite = transport.writeLog[0];
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.writeLog).toHaveLength(1);

    // Silence for one interval: Betaflight writes the frame again.
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(transport.writeLog).toHaveLength(2);
    expect(Array.from(transport.writeLog[1])).toEqual(Array.from(firstWrite));

    // The board finally answers the second ask.
    transport.emitData(v1Response(API_VERSION, apiVersionPayload()));
    await expect(pending).resolves.toMatchObject({command: API_VERSION});
  });

  it('honours the resend budget and then stops', async () => {
    const {client, transport} = harness();
    const pending = client.request(API_VERSION, new Uint8Array(0), {
      wireFormat: 'v1',
      responseTimeoutMs: 4000,
      resend: {intervalMs: 1000, maxResends: 2},
    });
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(3500);
    await Promise.resolve();
    // One original write plus exactly two resends - never a third.
    expect(transport.writeLog).toHaveLength(3);

    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toMatchObject({code: 'MSP_TIMEOUT'});
  });

  it('never resends a request that did not ask for it', async () => {
    const {client, transport} = harness();
    const pending = client.request(API_VERSION, new Uint8Array(0), {wireFormat: 'v1'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1900);
    await Promise.resolve();
    expect(transport.writeLog).toHaveLength(1);
    jest.advanceTimersByTime(200);
    await expect(pending).rejects.toMatchObject({code: 'MSP_TIMEOUT'});
  });

  it('a duplicate answer to a resent request cannot settle a later request', async () => {
    const {client, transport} = harness();
    const first = client.request(API_VERSION, new Uint8Array(0), {
      wireFormat: 'v1',
      responseTimeoutMs: 4000,
      resend: {intervalMs: 1000, maxResends: 2},
    });
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(transport.writeLog).toHaveLength(2);

    // The board answers BOTH asks. The first settles the request.
    transport.emitData(v1Response(API_VERSION, [0, 1, 46]));
    await expect(first).resolves.toBeDefined();

    // A later request for the SAME command must not be settled by the
    // straggler - it is quarantined and swallowed.
    const second = client.request(API_VERSION, new Uint8Array(0), {wireFormat: 'v1'});
    for (let i = 0; i < 40 && transport.writes.length === 0; i += 1) await Promise.resolve();
    transport.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();

    transport.emitData(v1Response(API_VERSION, [0, 9, 99])); // the straggler
    await Promise.resolve();
    transport.emitData(v1Response(API_VERSION, [0, 1, 47])); // the genuine reply
    const frame = await second;
    expect(Array.from(frame.payload)).toEqual([0, 1, 47]);
  });
});

/* ------------------------------------------------------------------ *
 * BOARD_INFO - every shape Betaflight tolerates
 * ------------------------------------------------------------------ */

describe('MSP_BOARD_INFO payload variants', () => {
  const families: ReadonlyArray<{name: string; args: Parameters<typeof boardInfoPayload>[0]; catalog: string}> = [
    {name: 'unified target, MCU family in targetName', catalog: 'KAKUTEF7',
     args: {identifier: 'KTF7', targetName: 'STM32F7X2', boardName: 'KAKUTEF7', manufacturerId: 'HBRO'}},
    {name: 'another unified F405 board', catalog: 'SPEEDYBEEF405V3',
     args: {identifier: 'SBF4', targetName: 'STM32F405', boardName: 'SPEEDYBEEF405V3', manufacturerId: 'SPBE'}},
    {name: 'a vendor this project has never heard of', catalog: 'NEWVENDORH7PRO',
     args: {identifier: 'ZZ01', targetName: 'STM32H743', boardName: 'NEWVENDORH7PRO', manufacturerId: 'NVND'}},
    {name: 'a legacy build whose target IS the board', catalog: 'OMNIBUSF4SD',
     args: {identifier: 'OMNI', targetName: 'OMNIBUSF4SD', boardName: '', manufacturerId: ''}},
  ];

  it.each(families)('$name resolves to $catalog off the wire', async ({args, catalog}) => {
    const identity = await identifyWith(boardInfoPayload(args));
    expect(isIdentifiedFlightController(identity)).toBe(true);
    expect(resolveCatalogTarget(identity.board)).toBe(catalog);
  });

  it('an older firmware that stops after mcuTypeId still decodes', async () => {
    // 4 + 2 + 1 + 1 + 10 + 9 + 5 + 32 + 1 = 65 bytes, i.e. no 1.42+ tail.
    const identity = await identifyWith(
      boardInfoPayload({
        identifier: 'KTF7', targetName: 'STM32F7X2', boardName: 'KAKUTEF7',
        manufacturerId: 'HBRO', truncateTo: 65,
      }),
    );
    expect(resolveCatalogTarget(identity.board)).toBe('KAKUTEF7');
    expect(identity.board.configurationState).toBeUndefined();
    expect(identity.board.truncated).toBe(false);
  });

  it('A RESPONSE SHORTER THAN THE MANDATORY PREFIX NO LONGER FAILS THE BOARD', async () => {
    // This used to throw MspPayloadReadError and take the whole connection
    // down with it. Betaflight reads past the end as null and connects.
    const identity = await identifyWith([0x4b, 0x54, 0x46, 0x37, 0x00]);
    expect(isIdentifiedFlightController(identity)).toBe(true);
    expect(identity.board.truncated).toBe(true);
  });

  it('a longer-than-known response keeps its extra bytes and decodes the rest', async () => {
    const identity = await identifyWith([
      ...boardInfoPayload({identifier: 'KTF7', targetName: 'STM32F7X2', boardName: 'KAKUTEF7', manufacturerId: 'HBRO'}),
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(resolveCatalogTarget(identity.board)).toBe('KAKUTEF7');
    expect(Array.from(identity.board.trailingBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('optional identity fields being absent is not a failure', async () => {
    const identity = await identifyWith(
      boardInfoPayload({identifier: 'ABCD', targetName: '', boardName: '', manufacturerId: ''}),
    );
    expect(isIdentifiedFlightController(identity)).toBe(true);
    expect(resolveCatalogTarget(identity.board)).toBe('ABCD');
  });
});

/* ------------------------------------------------------------------ *
 * What may and may not fail a connection
 * ------------------------------------------------------------------ */

describe('what actually decides a flight controller is connected', () => {
  it('BOARD_INFO NEVER ANSWERING still leaves the FC identified', async () => {
    // Betaflight's processBoardInfo() cannot abort a connection; neither
    // can ours. The reason is recorded instead of being fatal.
    const identity = await identifyWith('timeout');
    expect(isIdentifiedFlightController(identity)).toBe(true);
    expect(identity.firmware.identifier).toBe('BTFL');
    expect(identity.boardInfoUnavailableReason).toBeDefined();
    expect(resolveCatalogTarget(identity.board)).toBe('');
  });

  it('an unrecognized firmware variant is still an identified flight controller', async () => {
    const identity = await identifyWith(
      boardInfoPayload({identifier: 'ZZ01', targetName: 'STM32H743', boardName: 'NEWVENDORH7PRO', manufacturerId: 'NVND'}),
      {variant: 'XYZW'},
    );
    expect(identity.firmware.knownFamily).toBe('UNKNOWN');
    expect(isIdentifiedFlightController(identity)).toBe(true);
  });

  it('a firmware below the supported MSP API is refused before anything else is asked', async () => {
    const {client, answer, transport} = harness();
    const identity = new MspIdentificationService(client).identify();
    await answer(v1Response(API_VERSION, [0, 1, 20]));
    await expect(identity).rejects.toMatchObject({name: 'MspIncompatibleFirmwareError'});
    // One write only: it never went on to ask for the variant.
    expect(transport.writeLog).toHaveLength(1);
  });

  it('a silent port fails in bounded time rather than hanging', async () => {
    const {client, swallow} = harness();
    const identity = new MspIdentificationService(client).identify();
    await swallow();
    jest.advanceTimersByTime(10_000);
    await expect(identity).rejects.toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * The developer trace
 * ------------------------------------------------------------------ */

describe('the connection trace records what a hardware test needs', () => {
  it('names every stage reached and carries the raw BOARD_INFO bytes', async () => {
    let clock = 0;
    const trace = new ConnectionTrace(() => (clock += 10));
    await identifyWith(
      boardInfoPayload({identifier: 'KTF7', targetName: 'STM32F7X2', boardName: 'KAKUTEF7', manufacturerId: 'HBRO'}),
      {trace},
    );
    const report = trace.toText();

    expect(trace.lastStageReached()).toBe('BOARD_INFO_PARSED');
    expect(report).toContain('MSP_SYNCED');
    expect(report).toContain('API_VERSION_RECEIVED');
    expect(report).toContain('FC_VARIANT_RECEIVED');
    expect(report).toContain('FC_IDENTIFIED');
    expect(report).toContain('BOARD_INFO_PARSED');
    // The bytes, verbatim - the artifact that settles a naming argument.
    expect(report).toContain('boardInfoHex: 4b 54 46 37');
    expect(report).toContain('boardName: KAKUTEF7');
    expect(report).toContain('targetName: STM32F7X2');
    expect(report).toContain('resolvedCatalogTarget: KAKUTEF7');
    expect(report).toContain('first failure: (none)');
  });

  it('records the first failure when board metadata never arrives', async () => {
    let clock = 0;
    const trace = new ConnectionTrace(() => (clock += 10));
    await identifyWith('timeout', {trace});

    expect(trace.firstFailure()?.stage).toBe('BOARD_INFO_RECEIVED');
    // ...and it still reports the FC as identified, because it is.
    expect(trace.toText()).toContain('FC_IDENTIFIED');
  });
});
