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
 * NO responseTimeoutMs OVERRIDE, and no retry policy. Both were briefly
 * added here and are deliberately restored - see
 * docs/IDENTIFICATION_RETRY_DECISION.md for the evidence. In short: a
 * probe against the REAL MspClient showed the retry loop never reached
 * the wire at all (2 transport writes, the second being the client's own
 * recovery probe), because a first-contact timeout synchronously latches
 * desync and every later attempt is refused with MSP_RECOVERING. It also
 * changed the user-visible failure code and, being shared core, changed
 * Android with no Android evidence asking for it. First contact is ONE
 * attempt at the client's own default timeout, and its rejection is
 * final and unmodified.
 */
const IDENTIFICATION_REQUEST_OPTIONS: MspRequestOptions = {wireFormat: 'v1'};

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
    const apiVersionFrame = await this.requester.request(
      MSP_API_VERSION,
      EMPTY_PAYLOAD,
      IDENTIFICATION_REQUEST_OPTIONS,
    );
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
}
