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

export interface SerialPortsSnapshot {
  readonly ports: readonly MspSerialPortRecord[];
  /** Complete MSP_FEATURE_CONFIG u32 mask. Unrelated bits are preserved. */
  readonly featureMaskRaw: number;
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
  readonly serialRxProvider: number;
  /** undefined means build options could not be queried, not "none compiled". */
  readonly buildOptionIds?: ReadonlySet<number>;
  /** Whether this firmware exposes configurable VTX tables. */
  readonly vtxTableAvailable?: boolean;
  /**
   * True only when an exposed VTX table contains at least one band, channel
   * and power level. Undefined means the optional evidence could not be read.
   */
  readonly vtxTableConfigured?: boolean;
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

export function serialRoleIsAvailable(
  snapshot: SerialPortsSnapshot,
  role: SerialRoleKey,
): boolean {
  const definition = roleByKey.get(role);
  if (definition === undefined) return false;
  if (
    definition.minimumApiMinor !== undefined &&
    (snapshot.apiVersionMajor !== 1 ||
      snapshot.apiVersionMinor < definition.minimumApiMinor)
  )
    return false;
  return (
    snapshot.buildOptionIds === undefined ||
    snapshot.buildOptionIds.size === 0 ||
    definition.buildOptionId === undefined ||
    snapshot.buildOptionIds.has(definition.buildOptionId)
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

function sharingIsValid(
  port: MspSerialPortRecord,
  serialRxProvider: number,
): boolean {
  const known = port.functionMask & SERIAL_KNOWN_FUNCTION_MASK;
  const count = SERIAL_ROLE_DEFINITIONS.filter(
    role => (known & (1 << role.bit)) !== 0,
  ).length;
  if (count <= 1) return true;
  if ((known & MSP_MASK) !== 0)
    return (known & ~(MSP_MASK | MSP_SHAREABLE_MASK)) === 0;
  if ((known & RX_MASK) !== 0) {
    const others = known & ~RX_MASK;
    if ((others & VTX_MSP_MASK) !== 0 && (others & ~VTX_MSP_MASK) === 0)
      return true;
    if (
      (others & (1 << 12)) !== 0 &&
      serialRxProvider === 7 &&
      (others & ~(1 << 12)) === 0
    )
      return true;
    return (
      RX_PROVIDERS_WITH_TX_SHARING.has(serialRxProvider) &&
      (others & ~RX_TELEMETRY_SHAREABLE_MASK) === 0
    );
  }
  return false;
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
      if (
        snapshot.buildOptionIds !== undefined &&
        snapshot.buildOptionIds.size > 0 &&
        role.buildOptionId !== undefined &&
        !snapshot.buildOptionIds.has(role.buildOptionId)
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
    if (!sharingIsValid(port, snapshot.serialRxProvider))
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
