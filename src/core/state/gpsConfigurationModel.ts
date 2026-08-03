import type { MspGpsConfiguration, MspSerialPortRecord } from '../protocol/msp';
import { hasSerialRole } from './serialPortsModel';

export const GPS_FEATURE_BIT = 2 ** 7;
export const GPS_PROVIDERS = Object.freeze([0, 1, 2] as const);
export const GPS_SBAS_MODES = Object.freeze([0, 1, 2, 3, 4, 5] as const);

export interface GpsConfigurationSnapshot {
  readonly featureMaskRaw: number;
  readonly configuration: MspGpsConfiguration;
  readonly ports: readonly MspSerialPortRecord[];
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
}

export interface GpsConfigurationDraft extends MspGpsConfiguration {
  readonly enabled: boolean;
}

export type GpsConfigurationValidationCode =
  | 'INVALID_PROVIDER'
  | 'INVALID_SBAS';

export function createGpsConfigurationDraft(
  snapshot: GpsConfigurationSnapshot,
): GpsConfigurationDraft {
  return Object.freeze({
    enabled: hasGpsFeature(snapshot.featureMaskRaw),
    ...snapshot.configuration,
  });
}

export function hasGpsFeature(mask: number): boolean {
  // eslint-disable-next-line no-bitwise -- firmware feature mask membership.
  return (mask & GPS_FEATURE_BIT) !== 0;
}

export function deriveGpsFeatureMask(base: number, enabled: boolean): number {
  // eslint-disable-next-line no-bitwise -- preserve the complete u32 mask while changing GPS only.
  return (enabled ? base | GPS_FEATURE_BIT : base & ~GPS_FEATURE_BIT) >>> 0;
}

export function gpsDraftsEqual(
  a: GpsConfigurationDraft,
  b: GpsConfigurationDraft,
): boolean {
  return (
    a.enabled === b.enabled &&
    a.provider === b.provider &&
    a.sbasMode === b.sbasMode &&
    a.autoConfig === b.autoConfig &&
    a.autoBaud === b.autoBaud &&
    a.homePointOnce === b.homePointOnce &&
    a.useGalileo === b.useGalileo
  );
}

export function gpsConfigurationsEqual(
  a: MspGpsConfiguration,
  b: MspGpsConfiguration,
): boolean {
  return (
    a.provider === b.provider &&
    a.sbasMode === b.sbasMode &&
    a.autoConfig === b.autoConfig &&
    a.autoBaud === b.autoBaud &&
    a.homePointOnce === b.homePointOnce &&
    a.useGalileo === b.useGalileo
  );
}

export function validateGpsDraft(
  draft: GpsConfigurationDraft,
): readonly GpsConfigurationValidationCode[] {
  const issues: GpsConfigurationValidationCode[] = [];
  if (![...GPS_PROVIDERS, 3].includes(draft.provider as 0 | 1 | 2 | 3))
    issues.push('INVALID_PROVIDER');
  if (!GPS_SBAS_MODES.includes(draft.sbasMode as 0 | 1 | 2 | 3 | 4 | 5))
    issues.push('INVALID_SBAS');
  return Object.freeze(issues);
}

export function assignedGpsPorts(
  snapshot: GpsConfigurationSnapshot,
): readonly MspSerialPortRecord[] {
  return Object.freeze(
    snapshot.ports.filter(port => hasSerialRole(port, 'GPS')),
  );
}
