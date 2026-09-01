/* eslint-disable no-bitwise -- serial functions are a firmware-defined u32 bitmask. */
import type { MspSerialPortRecord } from '../protocol/msp';

export const SERIAL_BAUD_RATES = Object.freeze([
  'AUTO',
  '9600',
  '19200',
  '38400',
  '57600',
  '115200',
  '230400',
  '250000',
  '400000',
  '460800',
  '500000',
  '921600',
  '1000000',
  '1500000',
  '2000000',
  '2470000',
] as const);

export type SerialRoleCategory =
  | 'CONFIGURATION'
  | 'RECEIVER'
  | 'TELEMETRY'
  | 'SENSOR'
  | 'PERIPHERAL';
export type SerialRoleKey =
  | 'MSP'
  | 'GPS'
  | 'TELEMETRY_FRSKY'
  | 'TELEMETRY_HOTT'
  | 'TELEMETRY_LTM'
  | 'TELEMETRY_SMARTPORT'
  | 'RX_SERIAL'
  | 'BLACKBOX'
  | 'TELEMETRY_MAVLINK'
  | 'ESC_SENSOR'
  | 'TBS_SMARTAUDIO'
  | 'TELEMETRY_IBUS'
  | 'IRC_TRAMP'
  | 'RUNCAM_DEVICE_CONTROL'
  | 'LIDAR_TF'
  | 'FRSKY_OSD'
  | 'VTX_MSP';

export interface SerialRoleDefinition {
  readonly key: SerialRoleKey;
  readonly bit: number;
  readonly category: SerialRoleCategory;
  readonly maxPorts: 1 | 2;
  readonly buildOptionId?: number;
  readonly minimumApiMinor?: number;
}

export const SERIAL_ROLE_DEFINITIONS: readonly SerialRoleDefinition[] =
  Object.freeze([
    { key: 'MSP', bit: 0, category: 'CONFIGURATION', maxPorts: 2 },
    {
      key: 'GPS',
      bit: 1,
      category: 'SENSOR',
      maxPorts: 1,
      buildOptionId: 16412,
    },
    {
      key: 'TELEMETRY_FRSKY',
      bit: 2,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12301,
    },
    {
      key: 'TELEMETRY_HOTT',
      bit: 3,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12302,
    },
    {
      key: 'TELEMETRY_LTM',
      bit: 4,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12304,
    },
    {
      key: 'TELEMETRY_SMARTPORT',
      bit: 5,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12306,
    },
    { key: 'RX_SERIAL', bit: 6, category: 'RECEIVER', maxPorts: 1 },
    { key: 'BLACKBOX', bit: 7, category: 'PERIPHERAL', maxPorts: 1 },
    {
      key: 'TELEMETRY_MAVLINK',
      bit: 9,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12305,
    },
    { key: 'ESC_SENSOR', bit: 10, category: 'SENSOR', maxPorts: 1 },
    {
      key: 'TBS_SMARTAUDIO',
      bit: 11,
      category: 'PERIPHERAL',
      maxPorts: 1,
      buildOptionId: 16421,
    },
    {
      key: 'TELEMETRY_IBUS',
      bit: 12,
      category: 'TELEMETRY',
      maxPorts: 1,
      buildOptionId: 12303,
    },
    {
      key: 'IRC_TRAMP',
      bit: 13,
      category: 'PERIPHERAL',
      maxPorts: 1,
      buildOptionId: 16421,
    },
    {
      key: 'RUNCAM_DEVICE_CONTROL',
      bit: 14,
      category: 'PERIPHERAL',
      maxPorts: 1,
      buildOptionId: 16407,
    },
    { key: 'LIDAR_TF', bit: 15, category: 'PERIPHERAL', maxPorts: 1 },
    {
      key: 'FRSKY_OSD',
      bit: 16,
      category: 'PERIPHERAL',
      maxPorts: 1,
      buildOptionId: 16411,
    },
    {
      key: 'VTX_MSP',
      bit: 17,
      category: 'PERIPHERAL',
      maxPorts: 1,
      minimumApiMinor: 45,
    },
  ]);

export const SERIAL_KNOWN_FUNCTION_MASK = SERIAL_ROLE_DEFINITIONS.reduce(
  (mask, role) => (mask | (1 << role.bit)) >>> 0,
  0,
);

/**
 * ABSENCE OF EVIDENCE IS NOT A VALUE.
 *
 * The Ports page reads three OPTIONAL things after the serial table
 * itself: the serial RX provider, the firmware's compiled build options,
 * and the VTX table status. Each of them used to collapse a failed read
 * into a plausible-looking value - provider 0, `undefined` options,
 * `undefined` table status - and downstream code could not tell that
 * apart from the board actually saying so.
 *
 * Measured consequences, not hypothetical ones: a timed-out
 * MSP_RX_CONFIG on a valid SBUS board fabricated provider 0, raised
 * INVALID_PORT_SHARING, and blocked EVERY save on the page including
 * edits nowhere near the RX port; a timed-out MSP_BUILD_INFO presented
 * every build-gated role as compiled, so an operator could add and save
 * a role the firmware cannot run.
 *
 * This type exists so ordinary validation code CANNOT make that mistake:
 * there is no number to read without first asking whether one was
 * observed.
 */
export type SerialEvidence<T> =
  | { readonly kind: 'OBSERVED'; readonly value: T }
  | { readonly kind: 'READ_FAILED' };

/** Reads better at call sites than the object literal. */
export function observedEvidence<T>(value: T): SerialEvidence<T> {
  return Object.freeze({ kind: 'OBSERVED' as const, value });
}
export const EVIDENCE_READ_FAILED: SerialEvidence<never> = Object.freeze({
  kind: 'READ_FAILED' as const,
});

/** What MSP_VTX_CONFIG tells us, when it answers at all. */
export interface VtxTableEvidence {
  /** Whether this firmware exposes configurable VTX tables. */
  readonly tableAvailable: boolean;
  /**
   * True only when an exposed VTX table contains at least one band,
   * channel and power level.
   */
  readonly tableConfigured: boolean;
}

export interface SerialPortsSnapshot {
  readonly ports: readonly MspSerialPortRecord[];
  /** Complete MSP_FEATURE_CONFIG u32 mask. Unrelated bits are preserved. */
  readonly featureMaskRaw: number;
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
  /**
   * OBSERVED carries the provider byte exactly as the FC reported it -
   * including 0, which is the real SERIALRX_NONE and not a placeholder.
   */
  readonly serialRxProvider: SerialEvidence<number>;
  /**
   * OBSERVED with an EMPTY set is a firmware that reported no build
   * options. That is board truth and gates roles. READ_FAILED is not.
   */
  readonly buildOptionIds: SerialEvidence<ReadonlySet<number>>;
  readonly vtxTable: SerialEvidence<VtxTableEvidence>;
}

export type SerialPortsValidationCode =
  | 'NO_MSP_PORT'
  | 'TOO_MANY_MSP_PORTS'
  | 'USB_MSP_REQUIRED'
  | 'ROLE_ASSIGNED_MORE_THAN_ONCE'
  | 'INVALID_PORT_SHARING'
  | 'VTX_MSP_REQUIRES_MSP_OR_RX'
  | 'SOFTSERIAL_MSP_OR_RX'
  | 'SOFTSERIAL_BAUD_TOO_HIGH'
  | 'UNSUPPORTED_BAUD_INDEX'
  | 'ROLE_NOT_COMPILED'
  | 'ROLE_NOT_SUPPORTED_BY_API'
  | 'DUPLICATE_PORT_IDENTIFIER';

export interface SerialPortsValidationIssue {
  readonly code: SerialPortsValidationCode;
  readonly portIdentifier?: number;
  readonly role?: SerialRoleKey;
}

/**
 * SOMETHING WE COULD NOT CHECK - deliberately NOT a validation issue.
 *
 * An issue means "this configuration is wrong". An uncertainty means
 * "the evidence needed to judge this never arrived". Collapsing the
 * second into the first is what told operators their working board was
 * misconfigured; collapsing it into silence is what let unproven roles
 * through. Both are kept, separately.
 */
export type SerialPortsUncertaintyCode =
  | 'PORT_SHARING_NOT_VERIFIED'
  | 'BUILD_CAPABILITY_NOT_VERIFIED'
  | 'VTX_TABLE_NOT_VERIFIED';

export interface SerialPortsUncertainty {
  readonly code: SerialPortsUncertaintyCode;
  readonly portIdentifier?: number;
  readonly role?: SerialRoleKey;
}

export interface SerialPortsAssessment {
  /** Configurations known to be wrong. These block a save. */
  readonly issues: readonly SerialPortsValidationIssue[];
  /** Things unproven. These block only the edits that depend on them. */
  readonly uncertainties: readonly SerialPortsUncertainty[];
}

const roleByKey = new Map(
  SERIAL_ROLE_DEFINITIONS.map(role => [role.key, role]),
);
const MSP_MASK = 1 << 0;
const RX_MASK = 1 << 6;
const BLACKBOX_MASK = 1 << 7;
const VTX_MSP_MASK = 1 << 17;
const MSP_SHAREABLE_MASK =
  (BLACKBOX_MASK | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 9) | VTX_MSP_MASK) >>>
  0;
const RX_TELEMETRY_SHAREABLE_MASK = ((1 << 2) | (1 << 4) | (1 << 9)) >>> 0;
const RX_PROVIDERS_WITH_TX_SHARING = new Set([15, 1, 2, 3, 4, 5, 6, 7, 16]);
const SOFTSERIAL_IDS = new Set([30, 31]);
const TELEMETRY_ROLES = SERIAL_ROLE_DEFINITIONS.filter(
  role => role.category === 'TELEMETRY',
).map(role => role.key);

export function serialPortDisplayName(identifier: number): string {
  if (identifier === 20) return 'USB VCP';
  if (identifier === 30) return 'SOFTSERIAL1';
  if (identifier === 31) return 'SOFTSERIAL2';
  if (identifier === 40) return 'LPUART1';
  if (identifier >= 50 && identifier <= 65) return `UART${identifier - 50}`;
  if (identifier >= 70 && identifier <= 79) return `PIOUART${identifier - 70}`;
  if (identifier >= 0 && identifier <= 19) return `UART${identifier + 1}`;
  return `PORT ${identifier}`;
}

/**
 * MAY THE OPERATOR INTRODUCE THIS ROLE ON A PORT THAT DOES NOT HAVE IT?
 *
 * `alreadyAssigned` matters. A role the FC already reports is board
 * truth: it stays visible and it stays removable whatever the build
 * evidence says. Adding a NEW build-gated role is a different act - it
 * needs proof the firmware carries the feature, and a failed
 * MSP_BUILD_INFO is not that proof.
 *
 * Measured before this rule existed: a timed-out build-info read flipped
 * GPS from unavailable to available on a board whose firmware genuinely
 * lacked the option.
 */
export function serialRoleIsAvailable(
  snapshot: SerialPortsSnapshot,
  role: SerialRoleKey,
  alreadyAssigned = false,
): boolean {
  const definition = roleByKey.get(role);
  if (definition === undefined) return false;
  if (
    definition.minimumApiMinor !== undefined &&
    (snapshot.apiVersionMajor !== 1 ||
      snapshot.apiVersionMinor < definition.minimumApiMinor)
  )
    return false;
  if (definition.buildOptionId === undefined) return true;
  /* The board already runs it; nothing to authorise. Also keeps the
     control usable so the role can be REMOVED without evidence. */
  if (alreadyAssigned) return true;
  if (snapshot.buildOptionIds.kind === 'READ_FAILED') return false;
  const observed = snapshot.buildOptionIds.value;
  /* A firmware that reports NO options at all is not declaring every
     feature absent - that shape predates per-feature reporting - so it
     keeps the historical "not gated" reading. An observed NON-empty set
     is a real inventory and gates normally. */
  return observed.size === 0 || observed.has(definition.buildOptionId);
}

/** True when the build evidence needed to ADD `role` never arrived. */
export function serialRoleCompilationUnverified(
  snapshot: SerialPortsSnapshot,
  role: SerialRoleKey,
): boolean {
  const definition = roleByKey.get(role);
  return (
    definition?.buildOptionId !== undefined &&
    snapshot.buildOptionIds.kind === 'READ_FAILED'
  );
}

export function hasSerialRole(
  port: MspSerialPortRecord,
  role: SerialRoleKey,
): boolean {
  const definition = roleByKey.get(role);
  return (
    definition !== undefined &&
    (port.functionMask & (1 << definition.bit)) !== 0
  );
}

export function enabledSerialRoles(
  port: MspSerialPortRecord,
): readonly SerialRoleKey[] {
  return Object.freeze(
    SERIAL_ROLE_DEFINITIONS.filter(
      role => (port.functionMask & (1 << role.bit)) !== 0,
    ).map(role => role.key),
  );
}

export function unknownSerialFunctionMask(port: MspSerialPortRecord): number {
  return (port.functionMask & ~SERIAL_KNOWN_FUNCTION_MASK) >>> 0;
}

export function setSerialRole(
  ports: readonly MspSerialPortRecord[],
  identifier: number,
  role: SerialRoleKey,
  enabled: boolean,
): readonly MspSerialPortRecord[] {
  const definition = roleByKey.get(role);
  if (definition === undefined) return ports;
  return Object.freeze(
    ports.map(port => {
      if (port.identifier !== identifier) return port;
      const bit = 1 << definition.bit;
      return Object.freeze({
        ...port,
        functionMask: enabled
          ? (port.functionMask | bit) >>> 0
          : (port.functionMask & ~bit) >>> 0,
      });
    }),
  );
}

export type SerialBaudField =
  | 'mspBaudIndex'
  | 'gpsBaudIndex'
  | 'telemetryBaudIndex'
  | 'blackboxBaudIndex';

export function setSerialBaud(
  ports: readonly MspSerialPortRecord[],
  identifier: number,
  field: SerialBaudField,
  value: number,
): readonly MspSerialPortRecord[] {
  return Object.freeze(
    ports.map(port =>
      port.identifier === identifier
        ? Object.freeze({ ...port, [field]: value })
        : port,
    ),
  );
}

export function availableBaudIndexes(
  field: SerialBaudField,
  apiMinor: number,
): readonly number[] {
  if (field === 'mspBaudIndex')
    return Object.freeze([1, 2, 3, 4, 5, 6, 7, 10, 12]);
  if (field === 'gpsBaudIndex')
    return Object.freeze(
      apiMinor >= 47 ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5],
    );
  if (field === 'telemetryBaudIndex')
    return Object.freeze(
      apiMinor >= 47 ? [0, 1, 2, 3, 4, 5, 6, 9] : [0, 1, 2, 3, 4, 5],
    );
  return Object.freeze([0, 2, 3, 4, 5, 6, 7, 13, 14, 15]);
}

/**
 * PORT SHARING HAS THREE ANSWERS, NOT TWO.
 *
 * Most sharing rules are decided by the function mask alone. Two of them
 * - RX sharing its pad with IBUS telemetry, and RX sharing with the
 * FrSky/LTM/MAVLink telemetry family - depend on WHICH serial RX
 * provider the board runs, because only some providers drive the TX
 * line. When that provider was never observed those two rules cannot be
 * decided at all, and saying "invalid" is a claim we have not earned.
 */
export type SerialSharingAssessment =
  | 'KNOWN_VALID'
  | 'KNOWN_INVALID'
  | 'NOT_VERIFIED_PROVIDER_UNAVAILABLE';

export function assessPortSharing(
  port: MspSerialPortRecord,
  serialRxProvider: SerialEvidence<number>,
): SerialSharingAssessment {
  const known = port.functionMask & SERIAL_KNOWN_FUNCTION_MASK;
  const count = SERIAL_ROLE_DEFINITIONS.filter(
    role => (known & (1 << role.bit)) !== 0,
  ).length;
  if (count <= 1) return 'KNOWN_VALID';
  if ((known & MSP_MASK) !== 0)
    return (known & ~(MSP_MASK | MSP_SHAREABLE_MASK)) === 0
      ? 'KNOWN_VALID'
      : 'KNOWN_INVALID';
  if ((known & RX_MASK) !== 0) {
    const others = known & ~RX_MASK;
    /* Provider-independent: RX may always share with MSP VTX control. */
    if ((others & VTX_MSP_MASK) !== 0 && (others & ~VTX_MSP_MASK) === 0)
      return 'KNOWN_VALID';
    /* The remaining two rules both consult the provider. If the shape is
       not even a candidate for them, the answer is known without it. */
    const ibusOnly = (others & (1 << 12)) !== 0 && (others & ~(1 << 12)) === 0;
    const telemetryOnly = (others & ~RX_TELEMETRY_SHAREABLE_MASK) === 0;
    if (!ibusOnly && !telemetryOnly) return 'KNOWN_INVALID';
    if (serialRxProvider.kind === 'READ_FAILED')
      return 'NOT_VERIFIED_PROVIDER_UNAVAILABLE';
    const provider = serialRxProvider.value;
    if (ibusOnly && provider === 7) return 'KNOWN_VALID';
    return telemetryOnly && RX_PROVIDERS_WITH_TX_SHARING.has(provider)
      ? 'KNOWN_VALID'
      : 'KNOWN_INVALID';
  }
  return 'KNOWN_INVALID';
}

export function validateSerialPorts(
  snapshot: SerialPortsSnapshot,
): readonly SerialPortsValidationIssue[] {
  const issues: SerialPortsValidationIssue[] = [];
  const roleCounts = new Map<SerialRoleKey, number>();
  const identifiers = new Set<number>();
  for (const port of snapshot.ports) {
    if (identifiers.has(port.identifier))
      issues.push({
        code: 'DUPLICATE_PORT_IDENTIFIER',
        portIdentifier: port.identifier,
      });
    identifiers.add(port.identifier);
    const roles = enabledSerialRoles(port);
    for (const key of roles) {
      roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
      const role = roleByKey.get(key)!;
      if (
        role.minimumApiMinor !== undefined &&
        (snapshot.apiVersionMajor !== 1 ||
          snapshot.apiVersionMinor < role.minimumApiMinor)
      ) {
        issues.push({
          code: 'ROLE_NOT_SUPPORTED_BY_API',
          portIdentifier: port.identifier,
          role: key,
        });
      }
      /* ROLE_NOT_COMPILED needs an OBSERVED inventory that does not list
         the option. A read that never answered proves nothing, and an
         empty observed set is a firmware that reports no options at all
         rather than one declaring every feature absent. */
      if (
        snapshot.buildOptionIds.kind === 'OBSERVED' &&
        snapshot.buildOptionIds.value.size > 0 &&
        role.buildOptionId !== undefined &&
        !snapshot.buildOptionIds.value.has(role.buildOptionId)
      ) {
        issues.push({
          code: 'ROLE_NOT_COMPILED',
          portIdentifier: port.identifier,
          role: key,
        });
      }
    }
    if (port.identifier === 20 && !hasSerialRole(port, 'MSP'))
      issues.push({
        code: 'USB_MSP_REQUIRED',
        portIdentifier: port.identifier,
        role: 'MSP',
      });
    if (
      hasSerialRole(port, 'VTX_MSP') &&
      !hasSerialRole(port, 'MSP') &&
      !hasSerialRole(port, 'RX_SERIAL')
    )
      issues.push({
        code: 'VTX_MSP_REQUIRES_MSP_OR_RX',
        portIdentifier: port.identifier,
        role: 'VTX_MSP',
      });
    /* Only a KNOWN_INVALID sharing shape is a validation failure.
       NOT_VERIFIED travels as an uncertainty instead - see
       assessSerialPorts. Emitting INVALID_PORT_SHARING here from a
       fabricated provider is what blocked whole pages. */
    if (assessPortSharing(port, snapshot.serialRxProvider) === 'KNOWN_INVALID')
      issues.push({
        code: 'INVALID_PORT_SHARING',
        portIdentifier: port.identifier,
      });
    if (SOFTSERIAL_IDS.has(port.identifier)) {
      if (hasSerialRole(port, 'MSP') || hasSerialRole(port, 'RX_SERIAL'))
        issues.push({
          code: 'SOFTSERIAL_MSP_OR_RX',
          portIdentifier: port.identifier,
        });
      const activeSoftSerialBauds = [
        hasSerialRole(port, 'GPS') ? port.gpsBaudIndex : undefined,
        TELEMETRY_ROLES.some(role => hasSerialRole(port, role))
          ? port.telemetryBaudIndex
          : undefined,
        hasSerialRole(port, 'BLACKBOX') ? port.blackboxBaudIndex : undefined,
      ].filter((value): value is number => value !== undefined);
      if (activeSoftSerialBauds.some(value => value > 2))
        issues.push({
          code: 'SOFTSERIAL_BAUD_TOO_HIGH',
          portIdentifier: port.identifier,
        });
    }
    const activeBaudFields: SerialBaudField[] = [];
    if (hasSerialRole(port, 'MSP')) activeBaudFields.push('mspBaudIndex');
    if (hasSerialRole(port, 'GPS')) activeBaudFields.push('gpsBaudIndex');
    if (TELEMETRY_ROLES.some(role => hasSerialRole(port, role)))
      activeBaudFields.push('telemetryBaudIndex');
    if (hasSerialRole(port, 'BLACKBOX'))
      activeBaudFields.push('blackboxBaudIndex');
    for (const field of activeBaudFields) {
      if (
        !availableBaudIndexes(field, snapshot.apiVersionMinor).includes(
          port[field],
        )
      )
        issues.push({
          code: 'UNSUPPORTED_BAUD_INDEX',
          portIdentifier: port.identifier,
        });
    }
  }
  const mspCount = roleCounts.get('MSP') ?? 0;
  if (mspCount === 0) issues.push({ code: 'NO_MSP_PORT', role: 'MSP' });
  if (mspCount > 2) issues.push({ code: 'TOO_MANY_MSP_PORTS', role: 'MSP' });
  for (const role of SERIAL_ROLE_DEFINITIONS) {
    if ((roleCounts.get(role.key) ?? 0) > role.maxPorts)
      issues.push({ code: 'ROLE_ASSIGNED_MORE_THAN_ONCE', role: role.key });
  }
  return Object.freeze(issues.map(issue => Object.freeze(issue)));
}

/** Every wire-relevant field of one serial record, for exact comparison. */
function sameSerialRecord(
  a: MspSerialPortRecord,
  b: MspSerialPortRecord,
): boolean {
  return (
    a.identifier === b.identifier &&
    a.functionMask === b.functionMask &&
    a.mspBaudIndex === b.mspBaudIndex &&
    a.gpsBaudIndex === b.gpsBaudIndex &&
    a.telemetryBaudIndex === b.telemetryBaudIndex &&
    a.blackboxBaudIndex === b.blackboxBaudIndex
  );
}

/**
 * WHICH PORTS CARRY SOMETHING WE COULD NOT VERIFY?
 *
 * Two kinds: a shared port whose validity needs the RX provider, and a
 * port holding a build-gated role while the build inventory is unknown.
 * A save that leaves every one of these byte-identical is preserving the
 * board's own truth; a save that changes one is asserting something it
 * cannot support.
 */
export function portsWithUnverifiedEvidence(
  snapshot: SerialPortsSnapshot,
): readonly number[] {
  const identifiers: number[] = [];
  for (const port of snapshot.ports) {
    const sharingUnverified =
      assessPortSharing(port, snapshot.serialRxProvider) ===
      'NOT_VERIFIED_PROVIDER_UNAVAILABLE';
    const buildUnverified =
      snapshot.buildOptionIds.kind === 'READ_FAILED' &&
      enabledSerialRoles(port).some(
        key => roleByKey.get(key)?.buildOptionId !== undefined,
      );
    if (sharingUnverified || buildUnverified) identifiers.push(port.identifier);
  }
  return Object.freeze(identifiers);
}

export type SerialPortsEvidenceRefusal =
  | {
      readonly reason: 'RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION';
      readonly portIdentifier: number;
    }
  | {
      readonly reason: 'BUILD_CAPABILITY_NOT_VERIFIED';
      readonly portIdentifier: number;
      readonly role: SerialRoleKey;
    };

/**
 * MAY THIS EXACT WRITE GO OUT, GIVEN WHAT WE COULD NOT VERIFY?
 *
 * MSP2_COMMON_SET_SERIAL_CONFIG replaces the WHOLE table, so "the
 * operator only touched another card" is not a safety argument - what
 * matters is the bytes. `normalized` is compared field by field against
 * the observed original for every port carrying unverified evidence.
 * Normalization counts as a change: it rewrites zero GPS/blackbox baud
 * indexes, and doing that to a port we cannot judge is exactly the
 * speculative write this refuses.
 *
 * Returns the refusals, empty when the write is safe to send.
 */
export function refusalsForUnverifiedEvidence(
  original: SerialPortsSnapshot,
  normalized: readonly MspSerialPortRecord[],
): readonly SerialPortsEvidenceRefusal[] {
  const refusals: SerialPortsEvidenceRefusal[] = [];
  const desiredById = new Map(normalized.map(port => [port.identifier, port]));
  for (const port of original.ports) {
    const desired = desiredById.get(port.identifier);
    /* Dropping the port entirely is a change like any other. */
    const unchanged = desired !== undefined && sameSerialRecord(port, desired);
    if (unchanged) continue;

    if (
      assessPortSharing(port, original.serialRxProvider) ===
      'NOT_VERIFIED_PROVIDER_UNAVAILABLE'
    ) {
      /* Unless the edit removes the dependence entirely: a resulting
         shape that no longer needs the provider is judged on its own -
         dropping the telemetry role off a shared RX pad, say, leaves a
         port the mask alone can decide. */
      const resolved =
        desired !== undefined &&
        assessPortSharing(desired, original.serialRxProvider) !==
          'NOT_VERIFIED_PROVIDER_UNAVAILABLE';
      if (!resolved)
        refusals.push({
          reason: 'RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION',
          portIdentifier: port.identifier,
        });
    }
  }

  /* Introducing a build-gated role needs proof the firmware carries it.
     Removing one does not, and neither does leaving one alone. */
  if (original.buildOptionIds.kind === 'READ_FAILED') {
    const originalById = new Map(
      original.ports.map(port => [port.identifier, port]),
    );
    for (const desired of normalized) {
      const before = originalById.get(desired.identifier);
      for (const key of enabledSerialRoles(desired)) {
        const definition = roleByKey.get(key);
        if (definition?.buildOptionId === undefined) continue;
        const hadItAlready = before !== undefined && hasSerialRole(before, key);
        if (!hadItAlready)
          refusals.push({
            reason: 'BUILD_CAPABILITY_NOT_VERIFIED',
            portIdentifier: desired.identifier,
            role: key,
          });
      }
    }
  }
  return Object.freeze(refusals.map(refusal => Object.freeze(refusal)));
}

/**
 * Hard issues and unproven things, kept apart. `validateSerialPorts`
 * still answers the first on its own for every existing caller.
 */
export function assessSerialPorts(
  snapshot: SerialPortsSnapshot,
): SerialPortsAssessment {
  const uncertainties: SerialPortsUncertainty[] = [];
  for (const port of snapshot.ports) {
    if (
      assessPortSharing(port, snapshot.serialRxProvider) ===
      'NOT_VERIFIED_PROVIDER_UNAVAILABLE'
    )
      uncertainties.push({
        code: 'PORT_SHARING_NOT_VERIFIED',
        portIdentifier: port.identifier,
      });
    if (snapshot.buildOptionIds.kind === 'READ_FAILED') {
      for (const key of enabledSerialRoles(port)) {
        if (roleByKey.get(key)?.buildOptionId !== undefined)
          uncertainties.push({
            code: 'BUILD_CAPABILITY_NOT_VERIFIED',
            portIdentifier: port.identifier,
            role: key,
          });
      }
    }
  }
  if (snapshot.vtxTable.kind === 'READ_FAILED')
    uncertainties.push({ code: 'VTX_TABLE_NOT_VERIFIED' });
  return Object.freeze({
    issues: validateSerialPorts(snapshot),
    uncertainties: Object.freeze(uncertainties.map(u => Object.freeze(u))),
  });
}

export function normalizeSerialPortsForSave(
  ports: readonly MspSerialPortRecord[],
): readonly MspSerialPortRecord[] {
  return Object.freeze(
    ports.map(port =>
      Object.freeze({
        ...port,
        gpsBaudIndex:
          hasSerialRole(port, 'GPS') && port.gpsBaudIndex === 0
            ? 4
            : port.gpsBaudIndex,
        blackboxBaudIndex:
          hasSerialRole(port, 'BLACKBOX') && port.blackboxBaudIndex === 0
            ? 5
            : port.blackboxBaudIndex,
      }),
    ),
  );
}

export const FEATURE_RX_SERIAL_BIT = 2 ** 3;
export const FEATURE_GPS_BIT = 2 ** 7;
export const FEATURE_TELEMETRY_BIT = 2 ** 10;
export const FEATURE_ESC_SENSOR_BIT_FOR_PORTS = 2 ** 27;

function setFeatureBit(mask: number, bit: number, enabled: boolean): number {
  return (enabled ? mask | bit : mask & ~bit) >>> 0;
}

/**
 * Mirrors the firmware feature coupling used by a real Ports save while
 * preserving every unrelated/future bit. RX_SERIAL and ESC_SENSOR follow
 * the port table exactly. TELEMETRY and GPS are enabled when requested but
 * are not disabled merely because this page has no corresponding port: both
 * can have valid non-UART providers.
 */
export function deriveSerialPortsFeatureMask(
  originalMask: number,
  ports: readonly MspSerialPortRecord[],
): number {
  const hasRole = (role: SerialRoleKey) =>
    ports.some(port => hasSerialRole(port, role));
  let mask = setFeatureBit(
    originalMask,
    FEATURE_RX_SERIAL_BIT,
    hasRole('RX_SERIAL'),
  );
  mask = setFeatureBit(
    mask,
    FEATURE_ESC_SENSOR_BIT_FOR_PORTS,
    hasRole('ESC_SENSOR'),
  );
  if (hasRole('GPS')) mask = setFeatureBit(mask, FEATURE_GPS_BIT, true);
  if (TELEMETRY_ROLES.some(hasRole))
    mask = setFeatureBit(mask, FEATURE_TELEMETRY_BIT, true);
  return mask >>> 0;
}

export function serialPortsEqual(
  left: readonly MspSerialPortRecord[],
  right: readonly MspSerialPortRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((port, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        port.identifier === other.identifier &&
        port.functionMask === other.functionMask &&
        port.mspBaudIndex === other.mspBaudIndex &&
        port.gpsBaudIndex === other.gpsBaudIndex &&
        port.telemetryBaudIndex === other.telemetryBaudIndex &&
        port.blackboxBaudIndex === other.blackboxBaudIndex &&
        port.extensionBytes.length === other.extensionBytes.length &&
        port.extensionBytes.every(
          (byte, byteIndex) => byte === other.extensionBytes[byteIndex],
        )
      );
    })
  );
}
