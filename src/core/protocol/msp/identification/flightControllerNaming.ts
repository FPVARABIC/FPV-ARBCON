import type {FlightControllerIdentity} from './mspIdentificationTypes';
import type {MspBoardInfo} from '../decoding/decodeBoardInfo';

/**
 * WHICH NAME IS "THE BOARD", AND WHICH IS "THE BUILD TARGET".
 *
 * A real flight controller went unrecognized during hardware testing, and
 * the reason is a field ordering that reads correctly but is backwards
 * for every modern Betaflight build:
 *
 *   MSP_BOARD_INFO.targetName  is the FIRMWARE BUILD TARGET. Under
 *     Betaflight's unified targets (4.1+) that is the MCU family - e.g.
 *     "STM32F7X2", "STM32F405", "STM32H743" - and NOT a board.
 *   MSP_BOARD_INFO.boardName   is the BOARD, written into the config by
 *     the unified target - the name the official catalogue lists.
 *   MSP_BOARD_INFO.boardIdentifier is the legacy 4-character id.
 *
 * The app asked `targetName || boardName || boardIdentifier` when looking
 * a board up in the official target catalogue, so any board on a unified
 * target answered with its MCU family, which is not a catalogue entry,
 * and the flasher reported the board as unknown. That is not one board's
 * problem: it is every board built from a unified target, which today is
 * nearly all of them.
 *
 * The pinned Betaflight Configurator resolves it the other way round -
 * `src/js/utils/AutoDetect.js` matches `FC.CONFIG.boardName` against the
 * target list, and `src/js/fc.js calculateHardwareName()` composes the
 * display name as `manufacturerId/targetName(boardName)`. These helpers
 * are that behaviour, shared by every screen and both platforms, with no
 * vendor, manufacturer or board list anywhere in them.
 */

/** Trimmed, uppercase, or '' - the shape catalogue matching needs. */
function normalize(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * The name to look up in the official target catalogue: the BOARD first,
 * exactly as Betaflight's own AutoDetect does, then the build target,
 * then the legacy identifier. Returns '' when the firmware answered with
 * nothing usable, which callers must treat as "unknown board", never as
 * "no flight controller".
 */
export function resolveCatalogTarget(board: Pick<
  MspBoardInfo,
  'targetName' | 'boardName' | 'boardIdentifier'
>): string {
  return normalize(board.boardName) || normalize(board.targetName) || normalize(board.boardIdentifier);
}

/**
 * EVERY name this board legitimately answers to, most specific first and
 * de-duplicated. A selected catalogue target matches the connected board
 * when it appears here - so a unified-target board matches on its board
 * name while a legacy build still matches on its target name.
 */
export function boardIdentityNames(board: Pick<
  MspBoardInfo,
  'targetName' | 'boardName' | 'boardIdentifier'
>): readonly string[] {
  const names = [
    normalize(board.boardName),
    normalize(board.targetName),
    normalize(board.boardIdentifier),
  ].filter(name => name.length > 0);
  return [...new Set(names)];
}

/** True when `selected` is one of the names the board answers to. An
 * EMPTY selection matches anything: nothing has been chosen to disagree
 * with yet. */
export function boardMatchesTarget(
  board: Pick<MspBoardInfo, 'targetName' | 'boardName' | 'boardIdentifier'>,
  selected: string,
): boolean {
  const wanted = normalize(selected);
  if (wanted.length === 0) {
    return true;
  }
  return boardIdentityNames(board).includes(wanted);
}

/**
 * The operator-facing hardware name, following the pinned Betaflight
 * Configurator's calculateHardwareName() shape:
 * `manufacturerId/targetName(boardName)`, with each part omitted when the
 * firmware did not supply it. Nothing here is invented: an FC that
 * answers with only a 4-character identifier is displayed as exactly
 * that.
 */
export function describeFlightControllerHardware(board: Pick<
  MspBoardInfo,
  'targetName' | 'boardName' | 'boardIdentifier' | 'manufacturerId'
>): string {
  const targetName = (board.targetName ?? '').trim();
  const boardName = (board.boardName ?? '').trim();
  const boardIdentifier = (board.boardIdentifier ?? '').trim();
  const manufacturerId = (board.manufacturerId ?? '').trim();

  let name = targetName.length > 0 ? targetName : boardIdentifier;
  if (boardName.length > 0 && boardName !== name) {
    name = name.length > 0 ? `${boardName} (${name})` : boardName;
  }
  if (manufacturerId.length > 0 && name.length > 0) {
    name = `${manufacturerId}/${name}`;
  }
  return name;
}

/**
 * Whether this identity is usable as a flight controller at all.
 *
 * PROTOCOL TRUTH, NOT BRAND. The firmware answered MSP_API_VERSION,
 * MSP_FC_VARIANT and MSP_BOARD_INFO, so it IS a flight controller this
 * app can talk to. A board whose name is absent from our catalogue, from
 * an unreleased vendor, or carrying an unrecognized FC variant is still
 * identified - the catalogue lookup may fail, and that is a separate,
 * lesser fact reported separately.
 */
export function isIdentifiedFlightController(identity: FlightControllerIdentity): boolean {
  return (
    identity.firmware.identifier.trim().length > 0 &&
    boardIdentityNames(identity.board).length > 0
  );
}
