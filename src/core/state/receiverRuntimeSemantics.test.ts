/**
 * RECEIVER P2 - firmware truth, proven against the pinned Betaflight API
 * 1.47 authority (79065c96ba0bb5cdc675e67d7093e05dab8b330e).
 *
 * Every constant asserted here is a quoted firmware value, not a value
 * copied back out of the implementation.
 */

import type {MspSerialPortRecord} from '../protocol/msp/decoding/decodeSerialPorts';
import {
  RECEIVER_BOXFAILSAFE_BIT,
  RECEIVER_FAILSAFE_BIT,
  RECEIVER_MODE_FEATURE_MASK,
  RECEIVER_RXLOSS_BIT,
  RSSI_SOURCE_TOKENS,
  receiverProviderIsMeaningful,
  receiverValuesMayBeFailsafeOutput,
  resolveReceiverMode,
  resolveReceiverPortDependency,
  resolveReceiverSignalState,
  resolveRssiSource,
} from './receiverRuntimeSemantics';
import {
  RECEIVER_REBOOT_SENSITIVE_FIELDS,
  receiverChangeMayRequireReboot,
  type ReceiverConfigurationDraft,
} from './receiverConfigurationModel';

/** feature.h:46-66 @ pinned 1.47. */
const FEATURE_RX_PPM = 2 ** 0;
const FEATURE_RX_SERIAL = 2 ** 3;
const FEATURE_RX_PARALLEL_PWM = 2 ** 13;
const FEATURE_RX_MSP = 2 ** 14;
const FEATURE_RX_SPI = 2 ** 25;
/** An unrelated bit that must never influence the verdict: FEATURE_GPS. */
const FEATURE_GPS = 2 ** 7;

function port(identifier: number, functionMask: number): MspSerialPortRecord {
  return {
    identifier,
    functionMask,
    mspBaudIndex: 0,
    gpsBaudIndex: 0,
    telemetryBaudIndex: 0,
    blackboxBaudIndex: 0,
    extensionBytes: new Uint8Array(0),
  };
}
/** io/serial.h:43 @ pinned 1.47: FUNCTION_RX_SERIAL = (1 << 6). */
const FUNCTION_RX_SERIAL = 2 ** 6;

describe('Receiver P2 - mode comes from the feature mask, never the provider', () => {
  it('P2-X items 12-16: resolves each receiver mode from its own feature bit', () => {
    expect(resolveReceiverMode(FEATURE_RX_SERIAL)).toBe('SERIAL');
    expect(resolveReceiverMode(FEATURE_RX_PPM)).toBe('PPM');
    expect(resolveReceiverMode(FEATURE_RX_MSP)).toBe('MSP');
    expect(resolveReceiverMode(FEATURE_RX_SPI)).toBe('SPI');
    expect(resolveReceiverMode(FEATURE_RX_PARALLEL_PWM)).toBe('PARALLEL_PWM');
  });

  it('P2-X item 17: no receiver feature bit resolves honestly to NONE', () => {
    expect(resolveReceiverMode(0)).toBe('NONE');
    // Unrelated features set, no RX feature: still NONE, never a guess.
    expect(resolveReceiverMode(FEATURE_GPS)).toBe('NONE');
  });

  it('applies the firmware precedence when several bits are set (rx.c:284-298)', () => {
    // The bits are not mutually exclusive in storage; first match wins.
    expect(resolveReceiverMode(FEATURE_RX_PARALLEL_PWM | FEATURE_RX_SERIAL | FEATURE_RX_SPI)).toBe('PARALLEL_PWM');
    expect(resolveReceiverMode(FEATURE_RX_PPM | FEATURE_RX_SERIAL)).toBe('PPM');
    expect(resolveReceiverMode(FEATURE_RX_SERIAL | FEATURE_RX_MSP | FEATURE_RX_SPI)).toBe('SERIAL');
    expect(resolveReceiverMode(FEATURE_RX_MSP | FEATURE_RX_SPI)).toBe('MSP');
  });

  it('ignores every non-receiver feature bit', () => {
    expect(resolveReceiverMode(FEATURE_RX_SERIAL | FEATURE_GPS | 2 ** 31)).toBe('SERIAL');
  });

  it('survives bit 31 without going negative (the mask is unsigned)', () => {
    expect(resolveReceiverMode((FEATURE_RX_SPI | 2 ** 31) >>> 0)).toBe('SPI');
  });

  it('P2-X item 11: mode is NOT derived from the serial provider enum', () => {
    // Provider 9 is CRSF. A board running SPI still stores a provider,
    // and a mask with no RX_SERIAL bit must not become SERIAL because of
    // it - the resolver never sees the provider at all.
    expect(resolveReceiverMode(FEATURE_RX_SPI)).toBe('SPI');
    expect(receiverProviderIsMeaningful('SPI')).toBe(false);
    expect(receiverProviderIsMeaningful('SERIAL')).toBe(true);
    expect(receiverProviderIsMeaningful('NONE')).toBe(false);
  });

  it('P2-X item 20: the mode mask claims exactly the five receiver bits and nothing else', () => {
    expect(RECEIVER_MODE_FEATURE_MASK).toBe(
      FEATURE_RX_PPM | FEATURE_RX_SERIAL | FEATURE_RX_PARALLEL_PWM | FEATURE_RX_MSP | FEATURE_RX_SPI,
    );
    // eslint-disable-next-line no-bitwise -- asserting a firmware bitmask.
    expect(RECEIVER_MODE_FEATURE_MASK & FEATURE_GPS).toBe(0);
  });
});

describe('Receiver P2 - Ports/UART cross-check (read-only)', () => {
  it('P2-X item 23: serial mode with exactly one Serial RX UART is ready', () => {
    const result = resolveReceiverPortDependency('SERIAL', [port(0, 0), port(1, FUNCTION_RX_SERIAL)]);
    expect(result).toEqual({kind: 'SERIAL_RX_READY', portIdentifier: 1});
  });

  it('P2-X item 24: serial mode with no Serial RX UART reports the mismatch', () => {
    expect(resolveReceiverPortDependency('SERIAL', [port(0, 0), port(1, 2 ** 0)])).toEqual({
      kind: 'SERIAL_RX_UART_MISSING',
    });
  });

  it('reports an ambiguous configuration rather than silently choosing one', () => {
    expect(
      resolveReceiverPortDependency('SERIAL', [port(2, FUNCTION_RX_SERIAL), port(5, FUNCTION_RX_SERIAL)]),
    ).toEqual({kind: 'MULTIPLE_SERIAL_RX_ASSIGNMENTS', portIdentifiers: [2, 5]});
  });

  it('P2-X item 25: a non-serial mode makes the UART question not applicable', () => {
    for (const mode of ['PPM', 'MSP', 'SPI', 'PARALLEL_PWM', 'NONE'] as const) {
      expect(resolveReceiverPortDependency(mode, [])).toEqual({kind: 'NOT_APPLICABLE', mode});
    }
  });

  it('unreadable ports are UNKNOWN, never reported as "no UART assigned"', () => {
    expect(resolveReceiverPortDependency('SERIAL', undefined)).toEqual({kind: 'PORT_STATE_UNKNOWN'});
  });
});

describe('Receiver P2 - failsafe indication truth', () => {
  it('uses the pinned runtime_config.h bit positions', () => {
    // fc/runtime_config.h:44-47 @ pinned 1.47.
    expect(RECEIVER_FAILSAFE_BIT).toBe(2 ** 1);
    expect(RECEIVER_RXLOSS_BIT).toBe(2 ** 2);
    expect(RECEIVER_BOXFAILSAFE_BIT).toBe(2 ** 4);
  });

  it('P2-X item 27: RXLOSS is reported', () => {
    expect(resolveReceiverSignalState(RECEIVER_RXLOSS_BIT)).toEqual({kind: 'RX_LOSS'});
  });

  it('P2-X item 28: FAILSAFE is reported', () => {
    expect(resolveReceiverSignalState(RECEIVER_FAILSAFE_BIT)).toEqual({kind: 'FAILSAFE_ACTIVE'});
  });

  it('P2-X item 29: BOXFAILSAFE is reported - the flag the pre-P2 screen missed entirely', () => {
    expect(resolveReceiverSignalState(RECEIVER_BOXFAILSAFE_BIT)).toEqual({kind: 'BOXFAILSAFE_ACTIVE'});
    // The exact pre-P2 defect: only bits 1 and 2 were tested, so a mask
    // carrying ONLY bit 4 rendered as a healthy live link.
    expect(receiverValuesMayBeFailsafeOutput(resolveReceiverSignalState(RECEIVER_BOXFAILSAFE_BIT))).toBe(true);
  });

  it('P2-X item 30: absent status is UNKNOWN, never "fine"', () => {
    expect(resolveReceiverSignalState(undefined)).toEqual({kind: 'UNKNOWN'});
    expect(resolveReceiverSignalState(Number.NaN)).toEqual({kind: 'UNKNOWN'});
    expect(receiverValuesMayBeFailsafeOutput({kind: 'UNKNOWN'})).toBe(false);
  });

  it('a clean mask is LIVE, and unrelated arming blockers do not fake a failsafe', () => {
    expect(resolveReceiverSignalState(0)).toEqual({kind: 'LIVE'});
    // NO_GYRO (bit 0) and THROTTLE (bit 7) are arming blockers that say
    // nothing about the receiver link.
    expect(resolveReceiverSignalState(2 ** 0 | 2 ** 7)).toEqual({kind: 'LIVE'});
  });

  it('names the most specific cause when several flags are raised together', () => {
    // A real RX loss also raises the generic FAILSAFE; the one the pilot
    // did not choose is the more useful headline.
    expect(resolveReceiverSignalState(RECEIVER_RXLOSS_BIT | RECEIVER_FAILSAFE_BIT)).toEqual({kind: 'RX_LOSS'});
    expect(resolveReceiverSignalState(RECEIVER_BOXFAILSAFE_BIT | RECEIVER_FAILSAFE_BIT)).toEqual({
      kind: 'BOXFAILSAFE_ACTIVE',
    });
  });
});

describe('Receiver P2 - RSSI source and the absence of link quality', () => {
  it('P2-X item 35: an unavailable source stays honest', () => {
    expect(resolveRssiSource(undefined)).toEqual({kind: 'UNAVAILABLE'});
    expect(resolveRssiSource(-1)).toEqual({kind: 'UNAVAILABLE'});
  });

  it('maps the pinned rssiSource_e enum (rx.h:152-161)', () => {
    expect(RSSI_SOURCE_TOKENS[0]).toBe('NONE');
    expect(resolveRssiSource(1)).toEqual({kind: 'KNOWN', token: 'ADC', value: 1});
    expect(resolveRssiSource(2)).toEqual({kind: 'KNOWN', token: 'RX_CHANNEL', value: 2});
    expect(resolveRssiSource(6)).toEqual({kind: 'KNOWN', token: 'RX_PROTOCOL_CRSF', value: 6});
  });

  it('a value this pinned API does not define is UNRECOGNISED, not invented', () => {
    expect(resolveRssiSource(99)).toEqual({kind: 'UNRECOGNISED', value: 99});
  });

  it('P2-X item 37: nothing here fabricates a link-quality percentage', () => {
    // The pinned firmware serialises no LQ value through any MSP command,
    // so no symbol in this module may offer one.
    const semantics = require('./receiverRuntimeSemantics') as Record<string, unknown>;
    const names = Object.keys(semantics).join(' ').toLowerCase();
    expect(names).not.toContain('linkquality');
    expect(names).not.toContain('link_quality');
    expect(names).not.toContain('lq');
  });
});

describe('Receiver P2 - reboot-sensitive field detection', () => {
  const base: ReceiverConfigurationDraft = Object.freeze({
    channelMapText: 'AETR1234',
    rssiChannel: 0,
    stickMin: 1100,
    stickCenter: 1500,
    stickMax: 1900,
    deadband: 2,
    yawDeadband: 3,
    throttle3dDeadband: 5,
    smoothingEnabled: true,
    setpointCutoff: 0,
    throttleCutoff: 0,
    setpointAutoFactor: 30,
    throttleAutoFactor: 30,
  });

  it('claims exactly the five fields the firmware flags (msp.c:3779-3815)', () => {
    expect([...RECEIVER_REBOOT_SENSITIVE_FIELDS].sort()).toEqual(
      ['setpointAutoFactor', 'setpointCutoff', 'smoothingEnabled', 'throttleAutoFactor', 'throttleCutoff'].sort(),
    );
  });

  it('P2-X item 5: a change to any rc_smoothing field expects a reboot', () => {
    for (const field of RECEIVER_REBOOT_SENSITIVE_FIELDS) {
      const changed = {...base, [field]: typeof base[field] === 'boolean' ? !base[field] : (base[field] as number) + 1};
      expect(receiverChangeMayRequireReboot(base, changed)).toBe(true);
    }
  });

  it('P2-X item 6: a non-reboot-sensitive change does not falsely expect one', () => {
    expect(receiverChangeMayRequireReboot(base, {...base, channelMapText: 'TAER1234'})).toBe(false);
    expect(receiverChangeMayRequireReboot(base, {...base, rssiChannel: 5})).toBe(false);
    expect(receiverChangeMayRequireReboot(base, {...base, deadband: 9})).toBe(false);
    expect(receiverChangeMayRequireReboot(base, {...base, yawDeadband: 9})).toBe(false);
    expect(receiverChangeMayRequireReboot(base, {...base, stickCenter: 1501})).toBe(false);
    expect(receiverChangeMayRequireReboot(base, base)).toBe(false);
  });

  it('matches the firmware rule that only a CHANGED value raises the flag', () => {
    // configRebootUpdateCheckU8 (msp.c:353) compares before setting, so
    // rewriting an identical value flags nothing.
    expect(receiverChangeMayRequireReboot(base, {...base, smoothingEnabled: base.smoothingEnabled})).toBe(false);
  });
});
