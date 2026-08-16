/**
 * THE KAKUTE F7 FORENSIC SUITE - and why it was never a Kakute problem.
 *
 * A real Holybro Kakute F7 was not recognized. These fixtures are built
 * from the MSP_BOARD_INFO contract itself (src/main/msp/msp.c at the
 * pinned commit), not from any board list, and they reproduce the exact
 * shape modern Betaflight answers with:
 *
 *   targetName  = the UNIFIED BUILD TARGET - the MCU family, e.g.
 *                 "STM32F7X2". Not a board name at all.
 *   boardName   = the BOARD, written into the config by the unified
 *                 target: "KAKUTEF7", "MATEKF405", "SPEEDYBEEF405V3".
 *   boardIdentifier = the legacy 4-character id.
 *
 * The app used to resolve a board as `targetName || boardName || ...`,
 * so EVERY unified-target board answered with its MCU family, which is
 * not in the official target catalogue - and the product reported the
 * board as unrecognized. The pinned Betaflight Configurator does the
 * opposite (AutoDetect.js matches FC.CONFIG.boardName), which is what
 * these tests pin.
 *
 * Every fixture below is a REAL family shape, and the assertions never
 * name a manufacturer as a condition - the last two fixtures are an
 * unlisted vendor and a bare legacy board precisely to prove that.
 */

import {
  boardIdentityNames,
  hasUsableBoardMetadata,
  boardMatchesTarget,
  describeFlightControllerHardware,
  isIdentifiedFlightController,
  resolveCatalogTarget,
} from './flightControllerNaming';
import type {MspBoardInfo} from '../decoding/decodeBoardInfo';
import type {FlightControllerIdentity} from './mspIdentificationTypes';

function board(over: Partial<MspBoardInfo>): MspBoardInfo {
  return {
    boardIdentifier: 'XXXX',
    hardwareRevision: 0,
    boardType: 0,
    targetCapabilities: 0,
    targetName: '',
    boardName: '',
    manufacturerId: '',
    signature: new Uint8Array(32),
    mcuTypeId: 0,
    trailingBytes: new Uint8Array(0),
    truncated: false,
    ...over,
  };
}

/** Modern Betaflight: unified target + board name written by the config. */
const KAKUTE_F7 = board({
  boardIdentifier: 'KTF7',
  targetName: 'STM32F7X2',
  boardName: 'KAKUTEF7',
  manufacturerId: 'HBRO',
  mcuTypeId: 4,
});

const BETAFPV_F405 = board({
  boardIdentifier: 'S405',
  targetName: 'STM32F405',
  boardName: 'BETAFPVF405',
  manufacturerId: 'BEFH',
  mcuTypeId: 1,
});

const SPEEDYBEE_F405_V3 = board({
  boardIdentifier: 'SBF4',
  targetName: 'STM32F405',
  boardName: 'SPEEDYBEEF405V3',
  manufacturerId: 'SPBE',
  mcuTypeId: 1,
});

const MATEK_F405 = board({
  boardIdentifier: 'MTKS',
  targetName: 'STM32F405',
  boardName: 'MATEKF405',
  manufacturerId: 'MTKS',
  mcuTypeId: 1,
});

const IFLIGHT_F745 = board({
  boardIdentifier: 'IFF7',
  targetName: 'STM32F745',
  boardName: 'IFLIGHTF745',
  manufacturerId: 'IFRC',
  mcuTypeId: 4,
});

const MAMBA_F405 = board({
  boardIdentifier: 'MBF4',
  targetName: 'STM32F405',
  boardName: 'DIATONEF405',
  manufacturerId: 'DIAT',
  mcuTypeId: 1,
});

/** A board this project has never heard of, answering the same protocol. */
const UNKNOWN_VENDOR = board({
  boardIdentifier: 'ZZ01',
  targetName: 'STM32H743',
  boardName: 'NEWVENDORH7PRO',
  manufacturerId: 'NVND',
  mcuTypeId: 8,
});

/** A legacy (pre-unified) build: the target IS the board, no board name. */
const LEGACY_TARGET = board({
  boardIdentifier: 'OMNI',
  targetName: 'OMNIBUSF4SD',
  boardName: '',
  manufacturerId: '',
  mcuTypeId: 1,
});

const FAMILIES: ReadonlyArray<{name: string; board: MspBoardInfo; catalog: string}> = [
  {name: 'Holybro Kakute F7 class', board: KAKUTE_F7, catalog: 'KAKUTEF7'},
  {name: 'BetaFPV F405 class', board: BETAFPV_F405, catalog: 'BETAFPVF405'},
  {name: 'SpeedyBee F405 V3 class', board: SPEEDYBEE_F405_V3, catalog: 'SPEEDYBEEF405V3'},
  {name: 'Matek F405 class', board: MATEK_F405, catalog: 'MATEKF405'},
  {name: 'iFlight F745 class', board: IFLIGHT_F745, catalog: 'IFLIGHTF745'},
  {name: 'Diatone/Mamba F405 class', board: MAMBA_F405, catalog: 'DIATONEF405'},
  {name: 'unlisted future vendor', board: UNKNOWN_VENDOR, catalog: 'NEWVENDORH7PRO'},
  {name: 'legacy non-unified target', board: LEGACY_TARGET, catalog: 'OMNIBUSF4SD'},
];

describe('the board a catalogue lookup should use', () => {
  it.each(FAMILIES)('$name resolves to its BOARD, not its MCU target', ({board: info, catalog}) => {
    expect(resolveCatalogTarget(info)).toBe(catalog);
  });

  it('THE ROOT CAUSE: the old targetName-first order returned the MCU family', () => {
    // This is precisely what the product did, and why a real Kakute F7
    // was reported as an unknown board: "STM32F7X2" is not a catalogue
    // entry, and never will be.
    const oldOrder =
      KAKUTE_F7.targetName || KAKUTE_F7.boardName || KAKUTE_F7.boardIdentifier;
    expect(oldOrder).toBe('STM32F7X2');
    expect(resolveCatalogTarget(KAKUTE_F7)).toBe('KAKUTEF7');
    expect(resolveCatalogTarget(KAKUTE_F7)).not.toBe(oldOrder);
  });

  it('is not specific to one board: every unified-target family had the same defect', () => {
    const brokenByOldOrder = FAMILIES.filter(({board: info, catalog}) => {
      const oldOrder = info.targetName || info.boardName || info.boardIdentifier;
      return oldOrder.toUpperCase() !== catalog;
    });
    // Every fixture except the legacy build, whose target IS its board.
    expect(brokenByOldOrder.map(entry => entry.name)).toEqual(
      FAMILIES.filter(entry => entry.name !== 'legacy non-unified target').map(
        entry => entry.name,
      ),
    );
  });

  it('falls back honestly when a board answers with only a legacy identifier', () => {
    const bare = board({boardIdentifier: 'KTF7', targetName: '', boardName: ''});
    expect(resolveCatalogTarget(bare)).toBe('KTF7');
  });

  it('answers empty - never a guess - when the firmware supplied no names at all', () => {
    expect(resolveCatalogTarget(board({boardIdentifier: '', targetName: '', boardName: ''}))).toBe('');
  });
});

describe('matching a selected target against the connected board', () => {
  it.each(FAMILIES)('$name matches its own catalogue target', ({board: info, catalog}) => {
    expect(boardMatchesTarget(info, catalog)).toBe(true);
    expect(boardMatchesTarget(info, catalog.toLowerCase())).toBe(true);
    expect(boardMatchesTarget(info, ` ${catalog} `)).toBe(true);
  });

  it('a unified-target board ALSO still matches on its build target and legacy id', () => {
    expect(boardMatchesTarget(KAKUTE_F7, 'STM32F7X2')).toBe(true);
    expect(boardMatchesTarget(KAKUTE_F7, 'KTF7')).toBe(true);
  });

  it('a genuinely different board is still a mismatch', () => {
    expect(boardMatchesTarget(KAKUTE_F7, 'MATEKF405')).toBe(false);
    expect(boardMatchesTarget(MATEK_F405, 'KAKUTEF7')).toBe(false);
  });

  it('an empty selection disagrees with nothing', () => {
    expect(boardMatchesTarget(KAKUTE_F7, '')).toBe(true);
    expect(boardMatchesTarget(KAKUTE_F7, '   ')).toBe(true);
  });

  it('lists the names most specific first, without duplicates', () => {
    expect(boardIdentityNames(KAKUTE_F7)).toEqual(['KAKUTEF7', 'STM32F7X2', 'KTF7']);
    const sameName = board({boardIdentifier: 'ABCD', targetName: 'ABCD', boardName: 'ABCD'});
    expect(boardIdentityNames(sameName)).toEqual(['ABCD']);
  });
});

describe('how the hardware is described to the operator', () => {
  it('composes manufacturer / build target ( board ), Betaflight-style', () => {
    expect(describeFlightControllerHardware(KAKUTE_F7)).toBe('HBRO/KAKUTEF7 (STM32F7X2)');
    expect(describeFlightControllerHardware(UNKNOWN_VENDOR)).toBe(
      'NVND/NEWVENDORH7PRO (STM32H743)',
    );
  });

  it('omits every part the firmware did not supply, and invents nothing', () => {
    expect(describeFlightControllerHardware(LEGACY_TARGET)).toBe('OMNIBUSF4SD');
    expect(
      describeFlightControllerHardware(
        board({boardIdentifier: 'KTF7', targetName: '', boardName: '', manufacturerId: ''}),
      ),
    ).toBe('KTF7');
  });

  it('does not repeat a name that is both board and target', () => {
    expect(
      describeFlightControllerHardware(
        board({boardIdentifier: 'OMNI', targetName: 'OMNIBUSF4SD', boardName: 'OMNIBUSF4SD'}),
      ),
    ).toBe('OMNIBUSF4SD');
  });
});

describe('what counts as an identified flight controller', () => {
  const identityFor = (info: MspBoardInfo, variant = 'BTFL'): FlightControllerIdentity => ({
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 46},
    firmware: {identifier: variant, knownFamily: variant === 'BTFL' ? 'BETAFLIGHT' : 'UNKNOWN'},
    board: info,
  });

  it.each(FAMILIES)('$name is identified', ({board: info}) => {
    expect(isIdentifiedFlightController(identityFor(info))).toBe(true);
  });

  it('an UNRECOGNIZED firmware variant is still an identified flight controller', () => {
    // Protocol truth: it answered the contract. Naming its family is a
    // separate, lesser fact.
    const exotic = identityFor(UNKNOWN_VENDOR, 'XYZW');
    expect(exotic.firmware.knownFamily).toBe('UNKNOWN');
    expect(isIdentifiedFlightController(exotic)).toBe(true);
  });

  it('a board that answered with NO NAMES AT ALL is still an identified flight controller', () => {
    // Betaflight parity, and a reversal of what this test used to assert.
    // src/js/serial_backend.js onOpen() declares a board connected on the
    // api version and the "BTFL" variant alone; processBoardInfo() has no
    // path that can abort a connection. Requiring a board name here made
    // metadata a precondition for being connected, so a board whose
    // MSP_BOARD_INFO was slow, short or unanswered was reported as no
    // flight controller at all.
    const nameless = identityFor(
      board({boardIdentifier: '', targetName: '', boardName: ''}),
    );
    expect(isIdentifiedFlightController(nameless)).toBe(true);
    // The catalogue still cannot name it - a separate, lesser fact.
    expect(hasUsableBoardMetadata(nameless)).toBe(false);
    expect(resolveCatalogTarget(nameless.board)).toBe('');
  });

  it('a board whose MSP_BOARD_INFO never arrived is identified, with the reason kept', () => {
    const unanswered = {
      ...identityFor(board({boardIdentifier: '', targetName: '', boardName: ''})),
      boardInfoUnavailableReason: 'MSP_TIMEOUT',
    };
    expect(isIdentifiedFlightController(unanswered)).toBe(true);
    expect(hasUsableBoardMetadata(unanswered)).toBe(false);
  });
});

describe('vendor neutrality of the production identification path', () => {
  it('names no manufacturer, board or vendor id anywhere in its source', () => {
    // The fixtures above deliberately carry real family names; the LOGIC
    // must not. Anything that branches on a brand here would make a
    // future board a bug report instead of a supported device.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const sources = [
      'flightControllerNaming.ts',
      'MspIdentificationService.ts',
      'mspIdentificationTypes.ts',
      'mspCompatibility.ts',
    ].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'));

    for (const source of sources) {
      expect(
        /kakute|holybro|speedybee|betafpv|matek|iflight|mamba|diatone|foxeer|geprc|hglrc/i.test(
          source,
        ),
      ).toBe(false);
    }
  });
});
