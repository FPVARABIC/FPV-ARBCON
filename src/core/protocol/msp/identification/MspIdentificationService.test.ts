import {MspIdentificationService, MspIncompatibleFirmwareError} from './MspIdentificationService';
import type {MspRequester} from './MspIdentificationService';
import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT} from '../commands/mspCommands';
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
  it('MSP_API_VERSION rejecting (e.g. simulated MSP_TIMEOUT) propagates that error and never proceeds', async () => {
    const requester = new FakeMspRequester();
    const timeoutError = new Error('simulated MSP_TIMEOUT');
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

  it('MSP_BOARD_INFO rejecting does NOT fail identification - it records why', async () => {
    // Reversed deliberately. This test used to pin "a BOARD_INFO rejection
    // propagates and stops the sequence", which makes optional metadata a
    // precondition for being connected. The pinned Betaflight Configurator
    // does the opposite: serial_backend.js onOpen() has already accepted
    // the connection by this point (api version + "BTFL" variant), and
    // processBoardInfo() cannot abort it. A board whose MSP_BOARD_INFO
    // times out is a connected board with unknown metadata.
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    const boardInfoError = new Error('simulated MSP_BOARD_INFO failure');
    requester.scriptRejection(MSP_BOARD_INFO, boardInfoError);
    const service = new MspIdentificationService(requester);

    const identity = await service.identify();
    expect(identity.firmware.identifier).toBe('BTFL');
    expect(identity.boardInfoUnavailableReason).toContain('simulated MSP_BOARD_INFO failure');
    expect(identity.board.boardName).toBe('');
    expect(requester.calls.map(call => call.command)).toEqual([MSP_API_VERSION, MSP_FC_VARIANT, MSP_BOARD_INFO]);
  });
});

describe('MspIdentificationService - decode failures are enriched with which command failed', () => {
  it('a MALFORMED MSP_BOARD_INFO response is tolerated and marked truncated, not rejected', async () => {
    // Also reversed, and for the same Betaflight-parity reason as above:
    // its reader returns null past the end of a payload rather than
    // throwing (src/js/injected_methods.js), so a two-byte BOARD_INFO
    // leaves Betaflight connected with empty names. The command-number
    // enrichment in decodeOrThrow() is retained for any decoder that IS
    // strict; BOARD_INFO simply no longer reaches it.
    const requester = new FakeMspRequester();
    requester.scriptResponse(MSP_API_VERSION, apiVersionPayload(48));
    requester.scriptResponse(MSP_FC_VARIANT, fcVariantPayload('BTFL'));
    requester.scriptResponse(MSP_BOARD_INFO, Uint8Array.from([1, 2]));
    const service = new MspIdentificationService(requester);

    const identity = await service.identify();
    expect(identity.board.truncated).toBe(true);
    expect(identity.board.boardName).toBe('');
    expect(identity.boardInfoUnavailableReason).toBeUndefined();
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
