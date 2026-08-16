import type {MspFrame} from '../../mspTypes';
import type {MspRequestOptions} from '../../mspClient';
import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT} from '../commands/mspCommands';
import type {MspApiVersion} from '../decoding/decodeApiVersion';
import {decodeApiVersion} from '../decoding/decodeApiVersion';
import {decodeBoardInfo} from '../decoding/decodeBoardInfo';
import {decodeFcVariant} from '../decoding/decodeFcVariant';
import {MspPayloadReadError} from '../decoding/MspPayloadReader';
import {checkMspCompatibility} from './mspCompatibility';
import {deriveFcFamily, UNKNOWN_BOARD} from './mspIdentificationTypes';
import {resolveCatalogTarget} from './flightControllerNaming';
import type {ConnectionTrace} from './connectionTrace';
import {toHex} from './connectionTrace';
import type {FlightControllerIdentity, MspFcVariant} from './mspIdentificationTypes';

/**
 * Structural contract this service depends on - deliberately NOT a new
 * "MspRequestOptionsLike" duplicate type: MspRequestOptions is imported
 * directly from mspClient.ts (Pass 6.2a), the real, already-exported type,
 * so this can never silently drift from it if that type is ever changed.
 *
 * payload and options are REQUIRED here, matching MspClient.request()'s
 * real signature (command: number, payload: Uint8Array, options:
 * MspRequestOptions) exactly - not optional, as this pass's own original
 * sketch showed. Verified directly with `tsc --strict` that assigning a
 * concrete MspClient to a variable typed as this interface type-checks
 * cleanly either way (TypeScript checks method-shorthand interface
 * members bivariantly, independent of strictFunctionTypes - so making
 * these optional would ALSO have compiled without error). Chosen as
 * required anyway: an interface that promises payload/options CAN be
 * omitted, when the only real implementation (MspClient) actually
 * requires them and would misbehave if a future caller genuinely omitted
 * them, is a latent runtime footgun for anything other than this file's
 * own identify() (which always supplies both) - tightening the interface
 * to match MspClient's real contract exactly costs nothing here and
 * removes that risk entirely. No adapter shim needed either way: MspClient
 * satisfies this interface (or the more permissive optional-params
 * version) by plain structural typing.
 */
export interface MspRequester {
  request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame>;
}

const EMPTY_PAYLOAD = new Uint8Array(0);

/**
 * MSP_API_VERSION/MSP_FC_VARIANT/MSP_BOARD_INFO are all classic,
 * single-byte-command MSP v1 requests - the same wire format Betaflight
 * Configurator uses for them (src/js/msp.js send_message picks v1 for any
 * code <= 254, and all three are 1, 2 and 4).
 */
/**
 * BETAFLIGHT'S RESEND, APPLIED WHERE BETAFLIGHT APPLIES IT.
 *
 * Betaflight Configurator arms a 1000 ms timer on every MSP request whose
 * only action is to write the same frame again, leaving the request
 * pending (src/js/msp.js, MSP.send_message; MSP.TIMEOUT = 1000). That is
 * the whole reason a flight controller which misses the first request
 * after its port opens still connects there - and this app, which asked
 * exactly once, reported it as absent.
 *
 * The resend lives inside MspClient (MspRequestOptions.resend), NOT in a
 * loop around identify(): a loop here was tried before and reverted with
 * evidence, because the client latches desync on the first response
 * timeout and refuses every later attempt with MSP_RECOVERING before it
 * ever reaches the wire (docs/IDENTIFICATION_RETRY_DECISION.md). Asking
 * the client to ask again - which is what Betaflight does - is the only
 * form of this that reaches the board.
 *
 * 1000 ms is Betaflight's own interval. Two extra writes rather than
 * Betaflight's one, with a 4000 ms overall deadline replacing
 * Betaflight's "wait forever", so a genuinely silent port still fails in
 * bounded time instead of hanging the operator.
 */
const IDENTIFICATION_REQUEST_OPTIONS: MspRequestOptions = {
  wireFormat: 'v1',
  responseTimeoutMs: 4000,
  resend: {intervalMs: 1000, maxResends: 2},
};

/** Thrown by identify() when the connected firmware's MSP_API_VERSION is
 * below mspCompatibility.ts's own documented minimum - the ONE typed error
 * this service itself constructs; every other failure mode below is the
 * requester's own error, passed through unchanged (see identify()'s doc
 * comment). */
export class MspIncompatibleFirmwareError extends Error {
  readonly apiVersion: MspApiVersion;

  constructor(apiVersion: MspApiVersion, reason: string) {
    super(reason);
    this.name = 'MspIncompatibleFirmwareError';
    this.apiVersion = apiVersion;
  }
}

/**
 * Wraps a single decode call so a resulting MspPayloadReadError (a
 * malformed/truncated response) carries which MSP command it was decoding
 * when it failed - MspPayloadReadError's own message is purely byte-
 * offset-centric (e.g. "attempted to read 1 byte(s) with only 0
 * remaining...") and says nothing about which of MSP_API_VERSION/
 * MSP_FC_VARIANT/MSP_BOARD_INFO produced it; identify() is the only code
 * that knows which step it's on, so it's the right place to add that
 * context. Re-throws the SAME class (MspPayloadReadError), only the
 * message is enriched - `instanceof MspPayloadReadError` still works
 * identically for callers, and any OTHER error type (a rejected request()
 * Promise, MspIncompatibleFirmwareError) passes through this function
 * untouched, since only decode() runs inside the try.
 */
function decodeOrThrow<T>(command: number, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof MspPayloadReadError) {
      throw new MspPayloadReadError(`Failed to decode response for MSP command ${command}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Sequences MSP_API_VERSION -> (compatibility check) -> MSP_FC_VARIANT ->
 * MSP_BOARD_INFO into one FlightControllerIdentity. Owns ONLY this
 * sequencing/decoding/compatibility-check/result-assembly - it does not
 * construct an MspClient, open/close any USB session, know about
 * MspSessionCoordinator, touch any ownership/connection state, log to or
 * otherwise reference the debug panel, or handle reconnection/recovery
 * itself. All of that is Pass 6.4b+, built on top of this.
 */
export class MspIdentificationService {
  /**
   * `trace` is optional and developer-facing only (see connectionTrace.ts).
   * Passing none changes nothing about the protocol sequence - the trace
   * observes, it never decides.
   */
  constructor(
    private readonly requester: MspRequester,
    private readonly trace?: ConnectionTrace,
  ) {}

  /**
   * Stops at the first failure and propagates a clear typed error:
   *  - A rejected request() Promise (e.g. MSP_TIMEOUT, MSP_REMOTE_ERROR,
   *    any MspClientError) is passed through completely unchanged - this
   *    service never swallows or reinterprets it, it simply never
   *    proceeds to the next step in the sequence.
   *  - An incompatible MSP_API_VERSION throws MspIncompatibleFirmwareError
   *    (this service's own typed error) instead of proceeding to
   *    MSP_FC_VARIANT/MSP_BOARD_INFO at all.
   *  - A malformed/truncated response causes decodeApiVersion()/
   *    decodeFcVariant()/decodeBoardInfo() to throw MspPayloadReadError -
   *    decodeOrThrow() (above) re-throws the SAME class with the failing
   *    command number prepended to the message, so which step failed is
   *    recoverable from the error alone; nothing else about the error is
   *    changed.
   */
  async identify(): Promise<FlightControllerIdentity> {
    const apiVersionFrame = await this.requester.request(
      MSP_API_VERSION,
      EMPTY_PAYLOAD,
      IDENTIFICATION_REQUEST_OPTIONS,
    );
    // The first well-framed response is itself the proof that the byte
    // stream is synchronized - it is recorded as its own stage because
    // "the port opened but nothing ever parsed" and "it parsed but the
    // firmware is too old" are completely different hardware stories.
    this.trace?.reached('MSP_SYNCED', `first framed response, ${apiVersionFrame.payload.length} byte payload`);
    const apiVersion = decodeOrThrow(MSP_API_VERSION, () => decodeApiVersion(apiVersionFrame.payload));
    this.trace?.reached(
      'API_VERSION_RECEIVED',
      `MSP ${apiVersion.apiVersionMajor}.${apiVersion.apiVersionMinor}`,
    );
    this.trace?.fact('apiVersion', `${apiVersion.apiVersionMajor}.${apiVersion.apiVersionMinor}`);
    this.trace?.fact('mspProtocolVersion', apiVersion.mspProtocolVersion);

    const compatibility = checkMspCompatibility(apiVersion);
    if (!compatibility.compatible) {
      this.trace?.failed('API_VERSION_RECEIVED', compatibility.reason);
      throw new MspIncompatibleFirmwareError(apiVersion, compatibility.reason);
    }

    const fcVariantFrame = await this.requester.request(
      MSP_FC_VARIANT,
      EMPTY_PAYLOAD,
      IDENTIFICATION_REQUEST_OPTIONS,
    );
    const rawVariant = decodeOrThrow(MSP_FC_VARIANT, () => decodeFcVariant(fcVariantFrame.payload));
    const firmware: MspFcVariant = {
      identifier: rawVariant.identifier,
      knownFamily: deriveFcFamily(rawVariant.identifier),
    };
    this.trace?.reached('FC_VARIANT_RECEIVED', firmware.identifier);
    this.trace?.fact('fcVariant', firmware.identifier);
    this.trace?.fact('fcFamily', firmware.knownFamily);
    // Betaflight's own bar: parsed api version at/above the accepted one,
    // plus a firmware that named itself. Both now hold.
    this.trace?.reached('FC_IDENTIFIED', 'protocol truth satisfied; board metadata is a separate fact');

    // BEST EFFORT, EXACTLY AS IN BETAFLIGHT.
    //
    // The flight controller is already identified at this point: it
    // answered MSP_API_VERSION at a supported version and named its
    // firmware. Betaflight's own processBoardInfo() cannot abort a
    // connection, so neither can this - a board whose MSP_BOARD_INFO times
    // out, errors, or arrives too short is a board with unknown metadata,
    // not an absent flight controller. The reason is carried on the
    // identity so the operator can be told the specific, true thing
    // ("connected, board name unknown - choose a Target") instead of the
    // false one ("no flight controller found").
    try {
      const boardInfoFrame = await this.requester.request(
        MSP_BOARD_INFO,
        EMPTY_PAYLOAD,
        IDENTIFICATION_REQUEST_OPTIONS,
      );
      // decodeBoardInfo is itself total - it never throws - but the
      // wrapper stays so any future strict field keeps its command
      // attribution, and so a genuinely unexpected throw is still caught
      // by the surrounding best-effort block rather than escaping.
      this.trace?.reached('BOARD_INFO_RECEIVED', `${boardInfoFrame.payload.length} bytes`);
      // THE single most useful artifact when a real board is not
      // recognized: the exact bytes, before anything interpreted them.
      this.trace?.fact('boardInfoLength', boardInfoFrame.payload.length);
      this.trace?.fact('boardInfoHex', toHex(boardInfoFrame.payload));
      const board = decodeOrThrow(MSP_BOARD_INFO, () => decodeBoardInfo(boardInfoFrame.payload));
      this.trace?.reached('BOARD_INFO_PARSED', board.truncated ? 'decoded, response was short' : 'decoded');
      this.trace?.fact('boardIdentifier', board.boardIdentifier);
      this.trace?.fact('targetName', board.targetName);
      this.trace?.fact('boardName', board.boardName);
      this.trace?.fact('manufacturerId', board.manufacturerId);
      this.trace?.fact('mcuTypeId', board.mcuTypeId);
      this.trace?.fact('boardInfoTruncated', String(board.truncated));
      // What the catalogue will actually be asked for - the field whose
      // ordering caused a real board to look unknown.
      this.trace?.fact('resolvedCatalogTarget', resolveCatalogTarget(board) || '(none)');
      return {apiVersion, firmware, board};
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // NOT a connection failure - recorded as a note so the report shows
      // the FC was identified and only its metadata is missing.
      this.trace?.failed('BOARD_INFO_RECEIVED', reason);
      this.trace?.note('board metadata unavailable; the flight controller is still identified');
      return {
        apiVersion,
        firmware,
        board: UNKNOWN_BOARD,
        boardInfoUnavailableReason: reason,
      };
    }
  }
}
