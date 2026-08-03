import type {MspFrame} from '../../mspTypes';
import type {MspRequestOptions} from '../../mspClient';
import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT} from '../commands/mspCommands';
import type {MspApiVersion} from '../decoding/decodeApiVersion';
import {decodeApiVersion} from '../decoding/decodeApiVersion';
import {decodeBoardInfo} from '../decoding/decodeBoardInfo';
import {decodeFcVariant} from '../decoding/decodeFcVariant';
import {MspPayloadReadError} from '../decoding/MspPayloadReader';
import {checkMspCompatibility} from './mspCompatibility';
import {deriveFcFamily} from './mspIdentificationTypes';
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
 * single-byte-command MSP v1 requests - mirrors mspClient.ts's own Pass
 * 6.2b recovery-probe precedent (MSP_PROBE_WIRE_FORMAT = 'v1', also used
 * for MSP_API_VERSION specifically).
 *
 * responseTimeoutMs raises the FIRST-CONTACT patience from the client's
 * 2000ms default. The real-user failure that motivated it: a flight
 * controller whose USB port was just opened may still be enumerating or
 * booting its MSP task - on the web transport especially, where opening
 * the port is the first electrical event the board sees from this app.
 * Identification is a one-time handshake: a longer ceiling costs nothing
 * when the board answers (the request resolves on the response) and only
 * delays the FAILED verdict when it truly never answers.
 */
const IDENTIFICATION_RESPONSE_TIMEOUT_MILLIS = 5_000;
const IDENTIFICATION_REQUEST_OPTIONS: MspRequestOptions = {
  wireFormat: 'v1',
  responseTimeoutMs: IDENTIFICATION_RESPONSE_TIMEOUT_MILLIS,
};

/**
 * FIRST-CONTACT RETRIES - for the opening MSP_API_VERSION request only.
 *
 * Total attempts (1 original + retries) and the pause between them. Three
 * attempts with the 5s ceiling above bound the worst case at ~16s, which
 * covers every observed FC boot window while still ending in an honest
 * FAILED state for a board that genuinely never speaks. Later commands do
 * NOT retry: once the board has answered MSP_API_VERSION, the link is
 * proven, and a failure after that is information the operator should
 * see, not smooth over.
 */
const FIRST_CONTACT_MAX_ATTEMPTS = 3;
const FIRST_CONTACT_RETRY_DELAY_MILLIS = 500;

/**
 * The two rejection codes that mean "the link may simply not be ready
 * yet" rather than "the board refused": MSP_TIMEOUT (no reply inside the
 * window) and MSP_RECOVERING (the client's own desync recovery - which a
 * first-contact timeout itself triggers - is momentarily holding new
 * requests). Everything else (MSP_REMOTE_ERROR, a decode failure, a
 * closed session) is a real answer about the link and fails immediately.
 */
function isRetryableFirstContactError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as {code: unknown}).code
      : undefined;
  return code === 'MSP_TIMEOUT' || code === 'MSP_RECOVERING';
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

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
  constructor(private readonly requester: MspRequester) {}

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
    const apiVersionFrame = await this.requestFirstContact();
    const apiVersion = decodeOrThrow(MSP_API_VERSION, () => decodeApiVersion(apiVersionFrame.payload));

    const compatibility = checkMspCompatibility(apiVersion);
    if (!compatibility.compatible) {
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

    const boardInfoFrame = await this.requester.request(
      MSP_BOARD_INFO,
      EMPTY_PAYLOAD,
      IDENTIFICATION_REQUEST_OPTIONS,
    );
    const board = decodeOrThrow(MSP_BOARD_INFO, () => decodeBoardInfo(boardInfoFrame.payload));

    return {apiVersion, firmware, board};
  }

  /**
   * The opening MSP_API_VERSION request, with bounded first-contact
   * retries. See FIRST_CONTACT_MAX_ATTEMPTS above for why only this
   * request retries and why only MSP_TIMEOUT/MSP_RECOVERING qualify.
   * The last attempt's rejection is propagated UNCHANGED, preserving this
   * service's documented contract of never reinterpreting the
   * requester's own errors.
   */
  private async requestFirstContact(): Promise<MspFrame> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FIRST_CONTACT_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requester.request(
          MSP_API_VERSION,
          EMPTY_PAYLOAD,
          IDENTIFICATION_REQUEST_OPTIONS,
        );
      } catch (error) {
        lastError = error;
        if (
          attempt === FIRST_CONTACT_MAX_ATTEMPTS ||
          !isRetryableFirstContactError(error)
        ) {
          throw error;
        }
        await delay(FIRST_CONTACT_RETRY_DELAY_MILLIS);
      }
    }
    // Unreachable: the loop either returned or threw on its last pass.
    throw lastError;
  }
}
