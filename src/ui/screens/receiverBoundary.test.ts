/**
 * RECEIVER P5 - the UI/protocol boundary, enforced rather than intended.
 *
 * P0 recorded this as a STRUCTURAL weakness, not a live defect:
 * ReceiverScreen's own imports were clean, but it reached them through
 * `platforms/react-native/protocol`, a barrel re-exporting ~180 symbols
 * including `RNMspTransport` and the live `mspSessionCoordinator`. Adding
 * one identifier to that existing import line would have handed a React
 * component the wire, compiling cleanly and bypassing every interlock,
 * disarm proof and capability gate P1-P4 built. A naming convention does
 * not stop that; a failing test does.
 *
 * These assertions read SOURCE, deliberately. A runtime test cannot fail
 * for an import nobody has written yet - the whole point is to fail the
 * moment someone writes it.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

const SCREEN = join(__dirname, 'ReceiverScreen.tsx');
const FACADE = join(__dirname, '../../platforms/react-native/protocol/receiverPresentation.ts');
const BARREL = join(__dirname, '../../platforms/react-native/protocol/index.ts');

const screenSource = readFileSync(SCREEN, 'utf8');
/** Comments stripped: prose may DISCUSS the forbidden names, and does. */
const screenExecutable = screenSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const facadeSource = readFileSync(FACADE, 'utf8');
/** Comments stripped, so doc prose cannot masquerade as an export name -
 * and so a forbidden name may still be DISCUSSED in the header. */
const facadeExecutable = facadeSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
/** Only the braces of `export { ... } from '...'`, never the specifier. */
const facadeExportNames = [...facadeExecutable.matchAll(/export\s*\{([\s\S]*?)\}\s*from/g)]
  .flatMap(match => match[1].split(','))
  .map(entry => entry.replace(/\btype\b/, '').trim())
  .filter(Boolean);
const barrelSource = readFileSync(BARREL, 'utf8');

/** Every module specifier ReceiverScreen imports from. */
const screenImports = [...screenExecutable.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
/**
 * Wire authority: things that can send or schedule an MSP frame, or that
 * hand out something which can. None may be reachable from a screen.
 */
const FORBIDDEN_AUTHORITY = [
  'MspClient',
  'RNMspTransport',
  'WebSerialTransport',
  'mspSessionCoordinator',
  'MspSessionCoordinator',
  'MspTelemetryScheduler',
  'createMspTelemetryScheduler',
  'createMspOperationCoordinator',
  'acquireMotorConfigurationInterlock',
];
/** Encoders/decoders: payload authorship belongs below the controller. */
const FORBIDDEN_CODECS = [
  'encodeFeatureConfig',
  'encodeChangedReceiverConfiguration',
  'encodeReceiverConfig',
  'encodeReceiverMap',
  'encodeReceiverDeadband',
  'decodeRcChannels',
  'decodeRxConfig',
  'decodeFeatureConfig',
  'decodeSerialPorts',
  'decodeBuildOptions',
  'applyReceiverModeToFeatureMask',
];
/** Raw command constants the screen must never name. */
const FORBIDDEN_COMMANDS = [
  'MSP_RC',
  'MSP_RX_CONFIG',
  'MSP_SET_RX_CONFIG',
  'MSP_SET_RX_MAP',
  'MSP_SET_RSSI_CONFIG',
  'MSP_SET_RC_DEADBAND',
  'MSP_SET_FEATURE_CONFIG',
  'MSP_FEATURE_CONFIG',
  'MSP2_COMMON_SERIAL_CONFIG',
  'MSP2_COMMON_SET_SERIAL_CONFIG',
  'MSP_SET_RXFAIL_CONFIG',
  'MSP_RXFAIL_CONFIG',
  'MSP_REBOOT',
  'MSP_EEPROM_WRITE',
  'MSP_BUILD_INFO',
  'MSP_STATUS_EX',
];

describe('P5 boundary: ReceiverScreen reaches protocol only through the narrow facade', () => {
  it('imports from receiverPresentation and NOT from the broad platform barrel', () => {
    expect(screenImports).toContain('../../platforms/react-native/protocol/receiverPresentation');
    // The barrel itself, or any deeper module inside it, is out of bounds.
    const offending = screenImports.filter(specifier =>
      specifier.includes('platforms/react-native/protocol') &&
      !specifier.endsWith('/receiverPresentation'));
    expect(offending).toEqual([]);
  });

  it('proves the broad barrel really does expose wire authority - this is not a hypothetical', () => {
    // If this ever stops being true the boundary is less urgent, but the
    // facade is still correct; the assertion documents WHY it exists.
    expect(barrelSource).toContain('RNMspTransport');
    expect(barrelSource).toContain('mspSessionCoordinator');
  });

  it('reaches no transport, client, scheduler or coordinator by any route', () => {
    for (const name of FORBIDDEN_AUTHORITY) {
      expect({name, inScreen: screenExecutable.includes(name)}).toEqual({name, inScreen: false});
      // The facade may READ FROM './MspSessionCoordinator' - that is a
      // module path. What it may never do is re-export the authority
      // itself, so the exported NAMES are what is checked.
      expect({name, exported: facadeExportNames.includes(name)}).toEqual({name, exported: false});
    }
    // And it re-exports only; it constructs and imports nothing.
    expect(facadeExecutable).not.toMatch(/^import\s/m);
  });

  it('authors no payload: no encoder, decoder or mask mutation is reachable', () => {
    for (const name of FORBIDDEN_CODECS) {
      expect({name, inScreen: screenExecutable.includes(name)}).toEqual({name, inScreen: false});
      expect({name, exported: facadeExportNames.includes(name)}).toEqual({name, exported: false});
    }
  });

  it('names no raw MSP command constant', () => {
    for (const name of FORBIDDEN_COMMANDS) {
      expect({name, inScreen: screenExecutable.includes(name)}).toEqual({name, inScreen: false});
      expect({name, inFacade: facadeSource.includes(name)}).toEqual({name, inFacade: false});
    }
  });

  it('owns no clock: no timer, interval or animation-frame of its own', () => {
    expect(screenExecutable).not.toMatch(/\bsetInterval\b/);
    expect(screenExecutable).not.toMatch(/\bsetTimeout\b/);
    expect(screenExecutable).not.toMatch(/\brequestAnimationFrame\b/);
  });
});

describe('P5 boundary: the facade surface is a closed, reviewed list', () => {
  /**
   * The whole allow-list, written out. Growing it is a deliberate edit to
   * THIS array as well as to the facade - which is exactly the review
   * step the barrel never forced.
   */
  const ALLOWED = [
    'acquireReceiverTelemetry',
    'getReceiverObservedRateHz',
    'RECEIVER_CHANNELS_POLL_ID',
    'FC_STATUS_TELEMETRY_POLL_ID',
    'RECEIVER_TELEMETRY_POLL_ID',
    'SetupUiSessionKey',
    'useTelemetryValue',
    'receiverConfigurationController',
    'ReceiverBlockReason',
    'ReceiverLoadOutcome',
    'ReceiverModeTarget',
    'ReceiverRebootOutcome',
    'ReceiverRuntimeOutcome',
    'ReceiverRuntimeTruth',
    'ReceiverSaveOutcome',
  ];

  it('exports exactly the reviewed surface, nothing more', () => {
    expect([...facadeExportNames].sort()).toEqual([...ALLOWED].sort());
  });

  it('re-exports nothing at all with a wildcard', () => {
    // `export * from` would silently reopen the whole barrel.
    expect(facadeSource).not.toMatch(/export\s*\*/);
  });

  it('lets the screen import nothing the facade does not export', () => {
    // The exact brace block attached to the facade specifier.
    // [^}] rather than [\s\S]*? : a lazy any-character capture still
    // starts at the FIRST import in the file and swallows every one
    // before this specifier.
    const block = screenExecutable.match(/import\s*\{([^}]*)\}\s*from\s*'[^']*receiverPresentation'/);
    expect(block).not.toBeNull();
    const names = block![1].split(',').map(entry => entry.replace(/\btype\b/, '').trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      expect({name, exportedByFacade: facadeExportNames.includes(name)}).toEqual({name, exportedByFacade: true});
    }
  });
});
