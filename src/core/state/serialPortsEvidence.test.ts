/* eslint-disable no-bitwise -- fixtures use the same function-mask notation as firmware. */
/*
 * THE OPTIONAL-EVIDENCE MATRICES.
 *
 * Three reads on the Ports page are optional: MSP_RX_CONFIG,
 * MSP_BUILD_INFO and MSP_VTX_CONFIG. Before this model existed, each one
 * failing produced a *value* rather than an absence, and the three
 * failures were indistinguishable from real board answers:
 *
 *   - a failed MSP_RX_CONFIG became provider 0. Provider 0 is
 *     SERIALRX_NONE, a real provider, and one that fails the RX/telemetry
 *     sharing rule - so a single timed-out read reported a correctly
 *     configured board as invalid and blocked every save on the page,
 *     including edits to unrelated ports.
 *   - a failed MSP_BUILD_INFO became "no build gating", presenting every
 *     build-gated role as compiled and letting an unproven role be added
 *     and written.
 *   - a failed MSP_VTX_CONFIG made the incomplete-table diagnostic
 *     silently vanish.
 *
 * Each matrix below therefore separates THREE states, not two: observed
 * good, observed bad, and never learned. The middle column is the one
 * that used to be manufactured.
 */
import {
  assessPortSharing,
  assessSerialPorts,
  EVIDENCE_READ_FAILED,
  observedEvidence,
  refusalsForUnverifiedEvidence,
  serialRoleCompilationUnverified,
  serialRoleIsAvailable,
  validateSerialPorts,
  portsWithUnverifiedEvidence,
  type SerialPortsSnapshot,
  type SerialRoleKey,
} from './serialPortsModel';
import type { MspSerialPortRecord } from '../protocol/msp';

const MSP = 1 << 0;
const GPS = 1 << 1;
const TELEMETRY_FRSKY = 1 << 2;
const TELEMETRY_LTM = 1 << 4;
const RX_SERIAL = 1 << 6;
const BLACKBOX = 1 << 7;
const TELEMETRY_IBUS = 1 << 12;
const VTX_MSP = 1 << 17;

/** Betaflight rxSerialProvider values, by name so the cases read. */
const SERIALRX_NONE = 0;
const SERIALRX_SBUS = 2;
const SERIALRX_IBUS = 7;
const SERIALRX_CRSF = 9;

const port = (
  identifier: number,
  functionMask: number,
  overrides: Partial<MspSerialPortRecord> = {},
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 4,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xa5]),
  ...overrides,
});

function snapshot(
  options: Partial<SerialPortsSnapshot> = {},
): SerialPortsSnapshot {
  return Object.freeze({
    ports: Object.freeze([port(20, MSP), port(0, RX_SERIAL)]),
    featureMaskRaw: 0,
    apiVersionMajor: 1,
    apiVersionMinor: 48,
    serialRxProvider: observedEvidence(SERIALRX_SBUS),
    buildOptionIds: observedEvidence<ReadonlySet<number>>(new Set()),
    vtxTable: observedEvidence({ tableAvailable: true, tableConfigured: true }),
    ...options,
  });
}

const codes = (s: SerialPortsSnapshot) =>
  validateSerialPorts(s).map(issue => issue.code);
const uncertaintyCodes = (s: SerialPortsSnapshot) =>
  assessSerialPorts(s).uncertainties.map(u => u.code);

/* ================================================================== *
 * §33 - THE RX PROVIDER MATRIX
 * ================================================================== */

describe('serial RX provider evidence - eight cases', () => {
  /** UART1 carrying RX_SERIAL plus FrSky telemetry: the shape whose
   * legality genuinely depends on which provider drives the TX line. */
  const sharedRxTelemetry = port(0, RX_SERIAL | TELEMETRY_FRSKY);

  it('1. observed SBUS accepts an RX pad shared with FrSky telemetry', () => {
    expect(
      assessPortSharing(sharedRxTelemetry, observedEvidence(SERIALRX_SBUS)),
    ).toBe('KNOWN_VALID');
  });

  it('2. observed CRSF rejects the same pad - CRSF does not drive TX', () => {
    expect(
      assessPortSharing(sharedRxTelemetry, observedEvidence(SERIALRX_CRSF)),
    ).toBe('KNOWN_INVALID');
  });

  it('3. observed SERIALRX_NONE rejects it, because none is a real answer', () => {
    // Provider 0 is a genuine board state, and rejecting it is correct.
    // The defect was never that 0 is judged - it was that a failed read
    // was TURNED INTO 0. Case 4 is the same shape with no answer at all.
    expect(
      assessPortSharing(sharedRxTelemetry, observedEvidence(SERIALRX_NONE)),
    ).toBe('KNOWN_INVALID');
  });

  it('4. a failed read is NOT_VERIFIED - a different answer from case 3', () => {
    expect(assessPortSharing(sharedRxTelemetry, EVIDENCE_READ_FAILED)).toBe(
      'NOT_VERIFIED_PROVIDER_UNAVAILABLE',
    );
  });

  it('5. a failed read still decides shapes the mask alone settles', () => {
    // One role: nothing is shared, so no provider is needed.
    expect(assessPortSharing(port(0, RX_SERIAL), EVIDENCE_READ_FAILED)).toBe(
      'KNOWN_VALID',
    );
    // RX + BLACKBOX is not a candidate for either provider-dependent
    // rule, so it is invalid whether or not the provider is known.
    expect(
      assessPortSharing(port(0, RX_SERIAL | BLACKBOX), EVIDENCE_READ_FAILED),
    ).toBe('KNOWN_INVALID');
  });

  it('6. RX sharing with MSP VTX control never consults the provider', () => {
    for (const evidence of [
      observedEvidence(SERIALRX_CRSF),
      EVIDENCE_READ_FAILED,
    ])
      expect(assessPortSharing(port(0, RX_SERIAL | VTX_MSP), evidence)).toBe(
        'KNOWN_VALID',
      );
  });

  it('7. IBUS telemetry on the RX pad is valid only for the IBUS provider', () => {
    const pad = port(0, RX_SERIAL | TELEMETRY_IBUS);
    expect(assessPortSharing(pad, observedEvidence(SERIALRX_IBUS))).toBe(
      'KNOWN_VALID',
    );
    expect(assessPortSharing(pad, observedEvidence(SERIALRX_SBUS))).toBe(
      'KNOWN_INVALID',
    );
    expect(assessPortSharing(pad, EVIDENCE_READ_FAILED)).toBe(
      'NOT_VERIFIED_PROVIDER_UNAVAILABLE',
    );
  });

  it('8. THE P2 REGRESSION: an unread provider does not invalidate a working board', () => {
    const ports = Object.freeze([
      port(20, MSP),
      port(0, RX_SERIAL | TELEMETRY_FRSKY),
    ]);
    const observed = snapshot({
      ports,
      serialRxProvider: observedEvidence(SERIALRX_SBUS),
    });
    const unread = snapshot({ ports, serialRxProvider: EVIDENCE_READ_FAILED });

    // The board is genuinely valid, and stays valid when the optional
    // read fails. Pre-fix this produced INVALID_PORT_SHARING.
    expect(codes(observed)).toEqual([]);
    expect(codes(unread)).toEqual([]);

    // The doubt is not thrown away either - it is reported as doubt.
    expect(assessSerialPorts(observed).uncertainties).toEqual([]);
    expect(assessSerialPorts(unread).uncertainties).toEqual([
      { code: 'PORT_SHARING_NOT_VERIFIED', portIdentifier: 0 },
    ]);
  });
});

/* ================================================================== *
 * §31 - KNOWN-INVALID AND UNKNOWN ARE NOT THE SAME OUTPUT
 * ================================================================== */

describe('a proven fault and an unproven one travel differently', () => {
  const ports = Object.freeze([
    port(20, MSP),
    port(0, RX_SERIAL | TELEMETRY_FRSKY),
  ]);
  const known = snapshot({
    ports,
    serialRxProvider: observedEvidence(SERIALRX_CRSF),
  });
  const unknown = snapshot({ ports, serialRxProvider: EVIDENCE_READ_FAILED });

  it('a proven bad sharing shape is an issue and no uncertainty', () => {
    expect(assessSerialPorts(known).issues).toEqual([
      { code: 'INVALID_PORT_SHARING', portIdentifier: 0 },
    ]);
    expect(assessSerialPorts(known).uncertainties).toEqual([]);
  });

  it('an unproven one is an uncertainty and no issue', () => {
    expect(assessSerialPorts(unknown).issues).toEqual([]);
    expect(assessSerialPorts(unknown).uncertainties).toEqual([
      { code: 'PORT_SHARING_NOT_VERIFIED', portIdentifier: 0 },
    ]);
  });

  it('only the unproven one names the port as carrying unverified evidence', () => {
    expect(portsWithUnverifiedEvidence(known)).toEqual([]);
    expect(portsWithUnverifiedEvidence(unknown)).toEqual([0]);
  });

  it('a proven bad build inventory is an issue, an unread one is not', () => {
    const gps = Object.freeze([port(20, MSP), port(0, GPS)]);
    const proven = snapshot({
      ports: gps,
      buildOptionIds: observedEvidence(new Set([12301])),
    });
    const unread = snapshot({ ports: gps, buildOptionIds: EVIDENCE_READ_FAILED });
    expect(codes(proven)).toEqual(['ROLE_NOT_COMPILED']);
    expect(codes(unread)).toEqual([]);
    expect(uncertaintyCodes(unread)).toEqual(['BUILD_CAPABILITY_NOT_VERIFIED']);
  });
});

/* ================================================================== *
 * §32 - THE BUILD-CAPABILITY MATRIX
 * ================================================================== */

describe('build capability evidence - seven cases', () => {
  const available = (
    s: SerialPortsSnapshot,
    role: SerialRoleKey,
    assigned = false,
  ) => serialRoleIsAvailable(s, role, assigned);

  it('1. an observed inventory listing the option offers the role', () => {
    const s = snapshot({ buildOptionIds: observedEvidence(new Set([16412])) });
    expect(available(s, 'GPS')).toBe(true);
    expect(serialRoleCompilationUnverified(s, 'GPS')).toBe(false);
  });

  it('2. an observed inventory omitting it withholds the role', () => {
    const s = snapshot({ buildOptionIds: observedEvidence(new Set([12301])) });
    expect(available(s, 'GPS')).toBe(false);
    expect(serialRoleCompilationUnverified(s, 'GPS')).toBe(false);
  });

  it('3. an observed EMPTY inventory is firmware that reports nothing, not a denial', () => {
    const s = snapshot({
      buildOptionIds: observedEvidence<ReadonlySet<number>>(new Set()),
    });
    expect(available(s, 'GPS')).toBe(true);
    expect(serialRoleCompilationUnverified(s, 'GPS')).toBe(false);
    expect(codes(snapshot({ ...s, ports: [port(20, MSP), port(0, GPS)] }))).toEqual(
      [],
    );
  });

  it('4. THE P2 REGRESSION: a failed read does NOT offer an unproven role', () => {
    const s = snapshot({ buildOptionIds: EVIDENCE_READ_FAILED });
    // Pre-fix this returned true, because undefined meant "no gating".
    expect(available(s, 'GPS')).toBe(false);
    expect(serialRoleCompilationUnverified(s, 'GPS')).toBe(true);
  });

  it('5. a role the board already runs stays operable so it can be REMOVED', () => {
    const s = snapshot({ buildOptionIds: EVIDENCE_READ_FAILED });
    expect(available(s, 'GPS', true)).toBe(true);
  });

  it('6. roles with no build option are unaffected by the failed read', () => {
    const s = snapshot({ buildOptionIds: EVIDENCE_READ_FAILED });
    for (const role of [
      'MSP',
      'RX_SERIAL',
      'BLACKBOX',
      'ESC_SENSOR',
      'LIDAR_TF',
    ] as const) {
      expect(available(s, role)).toBe(true);
      expect(serialRoleCompilationUnverified(s, role)).toBe(false);
    }
  });

  it('7. API gating is decided separately from build gating', () => {
    // VTX_MSP has no buildOptionId but does have minimumApiMinor 45.
    const old = snapshot({
      apiVersionMinor: 44,
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(available(old, 'VTX_MSP')).toBe(false);
    expect(serialRoleCompilationUnverified(old, 'VTX_MSP')).toBe(false);
    expect(available(snapshot({ apiVersionMinor: 45 }), 'VTX_MSP')).toBe(true);
  });

  it('one uncertainty is raised per build-gated role actually assigned', () => {
    const s = snapshot({
      ports: [port(20, MSP), port(0, GPS | TELEMETRY_FRSKY), port(1, BLACKBOX)],
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(assessSerialPorts(s).uncertainties).toEqual([
      {
        code: 'BUILD_CAPABILITY_NOT_VERIFIED',
        portIdentifier: 0,
        role: 'GPS',
      },
      {
        code: 'BUILD_CAPABILITY_NOT_VERIFIED',
        portIdentifier: 0,
        role: 'TELEMETRY_FRSKY',
      },
    ]);
  });
});

/* ================================================================== *
 * §34 - THE VTX TABLE MATRIX
 * ================================================================== */

describe('VTX table evidence - six cases', () => {
  const withVtx = (vtxTable: SerialPortsSnapshot['vtxTable']) =>
    snapshot({ ports: [port(20, MSP), port(0, VTX_MSP | MSP)], vtxTable });

  it('1. observed available and complete raises nothing', () => {
    const s = withVtx(
      observedEvidence({ tableAvailable: true, tableConfigured: true }),
    );
    expect(uncertaintyCodes(s)).toEqual([]);
    expect(s.vtxTable).toEqual({
      kind: 'OBSERVED',
      value: { tableAvailable: true, tableConfigured: true },
    });
  });

  it('2. observed available and incomplete is a fact the screen can state', () => {
    const s = withVtx(
      observedEvidence({ tableAvailable: true, tableConfigured: false }),
    );
    expect(uncertaintyCodes(s)).toEqual([]);
    expect(s.vtxTable).toEqual({
      kind: 'OBSERVED',
      value: { tableAvailable: true, tableConfigured: false },
    });
  });

  it('3. observed unavailable is also a fact, and a different one', () => {
    const s = withVtx(
      observedEvidence({ tableAvailable: false, tableConfigured: false }),
    );
    expect(uncertaintyCodes(s)).toEqual([]);
  });

  it('4. a failed read is reported as unknown, not as either fact', () => {
    expect(uncertaintyCodes(withVtx(EVIDENCE_READ_FAILED))).toEqual([
      'VTX_TABLE_NOT_VERIFIED',
    ]);
  });

  it('5. a failed VTX read adds no validation issue', () => {
    expect(codes(withVtx(EVIDENCE_READ_FAILED))).toEqual([]);
  });

  it('6. a failed VTX read never refuses a write - it gates no configuration', () => {
    const s = withVtx(EVIDENCE_READ_FAILED);
    const edited = [port(20, MSP), port(0, VTX_MSP | MSP), port(1, BLACKBOX)];
    expect(refusalsForUnverifiedEvidence(s, edited)).toEqual([]);
    expect(portsWithUnverifiedEvidence(s)).toEqual([]);
  });
});

/* ================================================================== *
 * THE WHOLE-TABLE WRITE RULE
 *
 * MSP2_COMMON_SET_SERIAL_CONFIG replaces every record, so "the operator
 * only touched another card" is not a safety argument - the bytes are.
 * ================================================================== */

describe('refusals for a write that would touch unverified evidence', () => {
  const shared = port(0, RX_SERIAL | TELEMETRY_FRSKY);
  const unread = snapshot({
    ports: Object.freeze([port(20, MSP), shared, port(1, 0)]),
    serialRxProvider: EVIDENCE_READ_FAILED,
  });

  it('permits an unrelated edit that leaves the unverified port byte-identical', () => {
    const edited = [port(20, MSP), shared, port(1, BLACKBOX)];
    expect(refusalsForUnverifiedEvidence(unread, edited)).toEqual([]);
  });

  it('refuses when the unverified port itself changes', () => {
    const edited = [
      port(20, MSP),
      port(0, RX_SERIAL | TELEMETRY_FRSKY | TELEMETRY_LTM),
      port(1, 0),
    ];
    expect(refusalsForUnverifiedEvidence(unread, edited)).toEqual([
      {
        reason: 'RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION',
        portIdentifier: 0,
      },
    ]);
  });

  it('refuses a baud rewrite on the unverified port, not only a role change', () => {
    // Normalization rewrites zero baud indexes. Doing that to a record
    // we cannot judge is exactly the speculative write this refuses.
    const edited = [
      port(20, MSP),
      { ...shared, telemetryBaudIndex: 5 },
      port(1, 0),
    ];
    expect(
      refusalsForUnverifiedEvidence(unread, edited).map(r => r.reason),
    ).toEqual(['RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION']);
  });

  it('refuses dropping the unverified port from the table entirely', () => {
    expect(
      refusalsForUnverifiedEvidence(unread, [port(20, MSP), port(1, 0)]).map(
        r => r.reason,
      ),
    ).toEqual(['RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION']);
  });

  it('permits an edit that removes the dependence on the unread provider', () => {
    // Dropping the telemetry role leaves a shape the mask alone decides.
    const edited = [port(20, MSP), port(0, RX_SERIAL), port(1, 0)];
    expect(refusalsForUnverifiedEvidence(unread, edited)).toEqual([]);
  });

  it('refuses INTRODUCING a build-gated role while the inventory is unknown', () => {
    const s = snapshot({
      ports: Object.freeze([port(20, MSP), port(0, 0)]),
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(refusalsForUnverifiedEvidence(s, [port(20, MSP), port(0, GPS)])).toEqual(
      [
        {
          reason: 'BUILD_CAPABILITY_NOT_VERIFIED',
          portIdentifier: 0,
          role: 'GPS',
        },
      ],
    );
  });

  it('permits REMOVING a build-gated role while the inventory is unknown', () => {
    const s = snapshot({
      ports: Object.freeze([port(20, MSP), port(0, GPS)]),
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(refusalsForUnverifiedEvidence(s, [port(20, MSP), port(0, 0)])).toEqual(
      [],
    );
  });

  it('permits MOVING an unrelated port while a gated role stays put', () => {
    const s = snapshot({
      ports: Object.freeze([port(20, MSP), port(0, GPS), port(1, 0)]),
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(
      refusalsForUnverifiedEvidence(s, [
        port(20, MSP),
        port(0, GPS),
        port(1, BLACKBOX),
      ]),
    ).toEqual([]);
  });

  it('refuses moving a gated role to a different port - that is an introduction', () => {
    const s = snapshot({
      ports: Object.freeze([port(20, MSP), port(0, GPS), port(1, 0)]),
      buildOptionIds: EVIDENCE_READ_FAILED,
    });
    expect(
      refusalsForUnverifiedEvidence(s, [
        port(20, MSP),
        port(0, 0),
        port(1, GPS),
      ]).map(r => r.portIdentifier),
    ).toEqual([1]);
  });

  it('raises no refusal at all once both reads succeeded', () => {
    const s = snapshot({
      ports: Object.freeze([port(20, MSP), shared, port(1, 0)]),
      serialRxProvider: observedEvidence(SERIALRX_SBUS),
      buildOptionIds: observedEvidence(new Set([16412])),
    });
    expect(
      refusalsForUnverifiedEvidence(s, [
        port(20, MSP),
        port(0, RX_SERIAL | TELEMETRY_FRSKY | GPS),
        port(1, BLACKBOX),
      ]),
    ).toEqual([]);
  });
});
