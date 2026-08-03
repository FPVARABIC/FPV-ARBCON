import {MspIdentificationService, MspIncompatibleFirmwareError} from './MspIdentificationService';
import type {MspRequester} from './MspIdentificationService';
import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT} from '../commands/mspCommands';
import {MspPayloadReadError} from '../decoding/MspPayloadReader';
import type {MspFrame} from '../../mspTypes';
import type {MspRequestOptions} from '../../mspClient';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A valid MSP_API_VERSION payload: mspProtocolVersion=0, major=1, minor. */
function apiVersionPayload(apiVersionMinor: number): Uint8Array {
  return Uint8Array.from([0, 1, apiVersionMinor]);
}

function fcVariantPayload(identifier: string): Uint8Array {
  return Uint8Array.from(ascii(identifier));
}

/** A valid MSP_BOARD_INFO payload: the guaranteed prefix, all 5 optional
 * fields fully populated (so remaining() is genuinely 0 before any
 * caller-supplied extra bytes - see decodeBoardInfo.ts's own strict
 * sequential-stop algorithm: partially-filled optional fields would
 * otherwise consume "extra" bytes as if they belonged to those fields,
 * rather than leaving them as trailingBytes), then arbitrary extra bytes
 * appended on top (to separately prove decodeBoardInfo's own
 * trailingBytes handling is reachable through this service, not just
 * directly). */
function boardInfoPayload(extraTrailingBytes: number[] = []): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'), // boardIdentifier
    ...u16le(0), // hardwareRevision
    0, // boardType
    0, // targetCapabilities
    ...pstring('TEST'), // targetName
    ...pstring('MyBoard'), // boardName
    ...pstring('MTKS'), // manufacturerId
    ...new Array(32).fill(0), // signature
    0, // mcuTypeId
    0, // configurationState
    ...u16le(0), // gyroSampleRateHz
    ...u32le(0), // configurationProblems
    0, // spiRegisteredDeviceCount
    0, // i2cRegisteredDeviceCount
    ...extraTrailingBytes,
  ]);
}

type ScriptedResponse = {frame: Uint8Array} | {reject: unknown};

class FakeMspRequester implements MspRequester {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = [];
  private readonly scripted = new Map<number, ScriptedResponse>();

  scriptResponse(command: number, payload: Uint8Array): void {
    this.scripted.set(command, {frame: payload});
  }

  scriptRejection(command: number, error: unknown): void {
    this.scripted.set(command, {reject: error});
  }

  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    const response = this.scripted.get(command);
    if (!response) {
      throw new Error(`FakeMspRequester: no scripted response for command ${command}`);
    }
    if ('reject' in response) {
      throw response.reject;
    }
    return {
      protocolVersion: 'v1',
      wireFormat: 'v1',
      direction: 'response',
      command,
      flags: 0,
      payload: response.frame,
    };
  }
}

/** Scripts a fully-successful, compatible happy-path fake requester. */
function makeHappyPathRequester(): FakeMspRequester {
  const requester = new FakeMspRequester();
  requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
  requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
  requester.scriptResponse(MSP_BOARD_INFO, boardInfoPayload());
  return requester;
}

describe('MspIdentificationService - happy path', () => {
  it('assembles the correct FlightControllerIdentity and sends commands in the correct sequential order', async () => {
    const requester = makeHappyPathRequester();
    const service = new MspIdentificationService(requester);

    const identity = await service.identify();

    expect(identity.apiVersion).toEqual({mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 48});
    expect(identity.firmware).toEqual({identifier: 'BTFL', knownFamily: 'BETAFLIGHT'});
    expect(identity.board.boardIdentifier).toBe('AFF3');
    expect(identity.board.targetName).toBe('TEST');
    expect(identity.board.trailingBytes).toEqual(new Uint8Array(0));

    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO]);
  });
});

describe('MspIdentificationService - incompatible MSP_API_VERSION', () => {
  it('stops immediately and never calls MSP_FC_VARIANT or MSP_BOARD_INFO', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(10)); // well below the 1.42 minimum
    const service = new MspIdentificationService(requester);

    await expect(service.identify()).rejects.toBeInstanceOf(MspIncompatibleFirmwareError);
    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION]);
  });
});

describe('MspIdentificationService - request rejections propagate unchanged, stopping the sequence', () => {
  it('MSP_API_VERSION rejecting with a NON-retryable error propagates it after a single attempt', async () => {
    // A plain Error carries no `code`, so first-contact retry logic must
    // treat it as a real answer about the link, not link-not-ready.
    const requester = new FakeMspRequester();
    const timeoutError = new Error('simulated non-retryable failure');
    requester.scriptRejection(MSP_API_VERSION, timeoutError);
    const service = new MspIdentificationService(requester);

    await expect(service.identify()).rejects.toBe(timeoutError);
    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION]);
  });

  it('MSP_FC_VARIANT rejecting propagates that error and never reaches MSP_BOARD_INFO', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    const fcVariantError = new Error('simulated MSP_FC_VARIANT failure');
    requester.scriptRejection(MSP_FC_VARIANT, fcVariantError);
    const service = new MspIdentificationService(requester);

    await expect(service.identify()).rejects.toBe(fcVariantError);
    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION, MSP_FC_VARIANT]);
  });

  it('MSP_BOARD_INFO rejecting propagates that error', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    const boardInfoError = new Error('simulated MSP_BOARD_INFO failure');
    requester.scriptRejection(MSP_BOARD_INFO, boardInfoError);
    const service = new MspIdentificationService(requester);

    await expect(service.identify()).rejects.toBe(boardInfoError);
    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO]);
  });
});

describe('MspIdentificationService - decode failures are enriched with which command failed', () => {
  it('a malformed MSP_BOARD_INFO response rejects with an MspPayloadReadError whose message includes the MSP_BOARD_INFO command number (4)', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    // Far too short to satisfy MSP_BOARD_INFO's own guaranteed-prefix fields.
    requester.scriptResponse(MSP_BOARD_INFO, Uint8Array.from([1, 2]));
    const service = new MspIdentificationService(requester);

    let caught: unknown;
    try {
      await service.identify();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MspPayloadReadError);
    expect((caught as Error).message).toContain(`MSP command ${MSP_BOARD_INFO}`);
    expect(MSP_BOARD_INFO).toBe(4);
  });
});

describe('MspIdentificationService - unrecognized/extra data handling', () => {
  it('an unrecognized MSP_FC_VARIANT identifier resolves knownFamily to UNKNOWN and still completes successfully', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('ZZZZ'));
    requester.scriptResponse(MSP_BOARD_INFO, boardInfoPayload());
    const service = new MspIdentificationService(requester);

    const identity = await service.identify();

    expect(identity.firmware).toEqual({identifier: 'ZZZZ', knownFamily: 'UNKNOWN'});
  });

  it('an MSP_BOARD_INFO response with extra/unknown trailing bytes completes successfully with trailingBytes populated', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    requester.scriptResponse(MSP_BOARD_INFO, boardInfoPayload([0x11, 0x22, 0x33]));
    const service = new MspIdentificationService(requester);

    const identity = await service.identify();

    expect(identity.board.trailingBytes).toEqual(Uint8Array.from([0x11, 0x22, 0x33]));
  });
});

/**
 * FIRST-CONTACT RETRIES.
 *
 * The real-user failure these protect against: a flight controller whose
 * USB port was JUST opened by the browser may still be enumerating or
 * booting its MSP task, so the very first MSP_API_VERSION can time out on
 * a perfectly healthy board. One 2000ms attempt turned that boot window
 * into a terminal "تعذّر التعرّف على متحكم الطيران" for the whole session.
 *
 * The retry contract is deliberately narrow, and these tests pin every
 * edge of it: ONLY the opening MSP_API_VERSION retries; ONLY on
 * MSP_TIMEOUT / MSP_RECOVERING (the two "link may not be ready yet"
 * codes); at most three attempts; and the final rejection is the
 * requester's own error object, unchanged.
 */
describe('MspIdentificationService - first-contact retries', () => {
  /** A requester whose MSP_API_VERSION behaviour is scripted PER ATTEMPT. */
  class SequencedRequester extends FakeMspRequester {
    private readonly firstContactScript: ScriptedResponse[];

    constructor(firstContactScript: ScriptedResponse[]) {
      super();
      this.firstContactScript = firstContactScript;
    }

    override async request(
      command: number,
      payload: Uint8Array,
      options: MspRequestOptions,
    ): Promise<MspFrame> {
      if (command === MSP_API_VERSION) {
        this.calls.push({command, payload, options});
        const scripted = this.firstContactScript.shift();
        if (!scripted) {
          throw new Error('SequencedRequester: MSP_API_VERSION script exhausted');
        }
        if ('reject' in scripted) {
          throw scripted.reject;
        }
        return {
          protocolVersion: 'v1',
          wireFormat: 'v1',
          direction: 'response',
          command,
          flags: 0,
          payload: scripted.frame,
        };
      }
      return super.request(command, payload, options);
    }
  }

  function mspError(code: 'MSP_TIMEOUT' | 'MSP_RECOVERING'): Error & {code: string} {
    return Object.assign(new Error(`simulated ${code}`), {code});
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries MSP_API_VERSION after an MSP_TIMEOUT and succeeds on the second attempt', async () => {
    const requester = new SequencedRequester([
      {reject: mspError('MSP_TIMEOUT')},
      {frame: apiVersionPayload(48)},
    ]);
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    requester.scriptResponse(MSP_BOARD_INFO, boardInfoPayload());
    const service = new MspIdentificationService(requester);

    const pending = service.identify();
    await jest.advanceTimersByTimeAsync(500);
    const identity = await pending;

    expect(identity.firmware.identifier).toBe('BTFL');
    expect(requester.calls.map(call => call.command)).toEqual([
      MSP_API_VERSION,
      MSP_API_VERSION,
      MSP_FC_VARIANT,
      MSP_BOARD_INFO,
    ]);
  });

  it('also retries on MSP_RECOVERING - the code the client itself mints while its own desync recovery holds requests', async () => {
    const requester = new SequencedRequester([
      {reject: mspError('MSP_TIMEOUT')},
      {reject: mspError('MSP_RECOVERING')},
      {frame: apiVersionPayload(48)},
    ]);
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    requester.scriptResponse(MSP_BOARD_INFO, boardInfoPayload());
    const service = new MspIdentificationService(requester);

    const pending = service.identify();
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      firmware: {identifier: 'BTFL'},
    });
  });

  it('gives up after three attempts and propagates the LAST rejection unchanged', async () => {
    const finalError = mspError('MSP_TIMEOUT');
    const requester = new SequencedRequester([
      {reject: mspError('MSP_TIMEOUT')},
      {reject: mspError('MSP_TIMEOUT')},
      {reject: finalError},
    ]);
    const service = new MspIdentificationService(requester);

    const pending = service.identify();
    // The expectation is created BEFORE the timers are driven, then
    // awaited after. That ordering is the point: attaching the rejection
    // handler first means the promise is never momentarily unhandled
    // while advanceTimersByTimeAsync settles the retry delays. The lint
    // rule cannot see the later await, so it is suppressed here with the
    // reason rather than restructured into the race it prevents.
    // eslint-disable-next-line jest/valid-expect -- awaited two lines below
    const expectation = expect(pending).rejects.toBe(finalError);
    await jest.advanceTimersByTimeAsync(1_000);
    await expectation;
    expect(
      requester.calls.filter(call => call.command === MSP_API_VERSION),
    ).toHaveLength(3);
  });

  it('never retries the LATER identification commands - a proven link that then fails is information, not noise', async () => {
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptRejection(MSP_FC_VARIANT, mspError('MSP_TIMEOUT'));
    const service = new MspIdentificationService(requester);

    await expect(service.identify()).rejects.toMatchObject({code: 'MSP_TIMEOUT'});
    expect(requester.calls.map(call => call.command)).toEqual([
      MSP_API_VERSION,
      MSP_FC_VARIANT,
    ]);
  });

  it('raises the identification response ceiling to 5000ms on every identification request', async () => {
    const requester = makeHappyPathRequester();
    const service = new MspIdentificationService(requester);

    await service.identify();

    for (const call of requester.calls) {
      expect(call.options).toMatchObject({
        wireFormat: 'v1',
        responseTimeoutMs: 5_000,
      });
    }
  });
});
