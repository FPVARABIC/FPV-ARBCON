/**
 * RECEIVER P4 - the rules that decide what may be written, and the one
 * mutation that is allowed to write it.
 *
 * MSP_SET_FEATURE_CONFIG replaces the whole 32-bit feature word
 * (msp.c:3712-3714 @ pinned 1.47: `featureConfigReplace(sbufReadU32(src))`).
 * A mutation that drops a bit does not "leave that feature alone" - it
 * turns it off. GPS, telemetry, OSD, airmode and every bit this build has
 * never heard of ride in the same word as the receiver mode, so the
 * preservation assertions below are not pedantry; each one is a feature
 * an operator would find silently disabled.
 */

import {
  RECEIVER_MODE_CAPABILITY, RECEIVER_MODE_APPLY_REQUIREMENT,
  RECEIVER_PROVIDER_APPLY_REQUIREMENT, WRITABLE_RECEIVER_MODES,
  applyReceiverModeToFeatureMask, receiverModeAfterMutation,
  receiverModeBaseIsStale, receiverModeIsWritable, receiverOwnedModeBits,
  resolveReceiverTargetDependency,
} from './receiverModeCapability';
import {RECEIVER_MODE_FEATURE_MASK, resolveReceiverMode, type ReceiverMode} from './receiverRuntimeSemantics';
import type {MspSerialPortRecord} from '../protocol/msp/decoding/decodeSerialPorts';

/* FIRMWARE FACT - config/feature.h:46-66 @ pinned 1.47. */
const RX_PPM = 2 ** 0;
const RX_SERIAL = 2 ** 3;
const RX_SPI = 2 ** 25;
/* Unrelated bits used as the preservation witnesses. */
const INFLIGHT_ACC_CAL = 2 ** 2;
const MOTOR_STOP = 2 ** 4;
const GPS = 2 ** 7;
const TELEMETRY = 2 ** 10;
const OSD = 2 ** 18;
const ANTI_GRAVITY = 2 ** 28;
/** Bit 31: nothing in 1.47 defines it. A future or vendor build might,
 * and it must survive us regardless - this is the "unknown feature bit"
 * case, and it is also the bit that exposes a signed-vs-unsigned bug. */
const UNKNOWN_HIGH_BIT = 2 ** 31;

function port(identifier: number, functionMask: number): MspSerialPortRecord {
  return {identifier, functionMask, mspBaudIndex: 0, gpsBaudIndex: 0, telemetryBaudIndex: 0, blackboxBaudIndex: 0, extensionBytes: new Uint8Array(0)};
}
const FUNCTION_RX_SERIAL = 2 ** 6; // io/serial.h:43 @ pinned 1.47

describe('P4 capability matrix', () => {
  it('classifies every decoded mode, with a stated reason', () => {
    const modes: ReceiverMode[] = ['SERIAL', 'PPM', 'PARALLEL_PWM', 'MSP', 'SPI', 'NONE'];
    for (const mode of modes) {
      const capability = RECEIVER_MODE_CAPABILITY[mode];
      expect(capability.mode).toBe(mode);
      expect(capability.readable).toBe(true);
      expect(['WRITABLE', 'READ_ONLY']).toContain(capability.classification);
      // A classification without a reason is an assertion nobody can audit.
      expect(capability.reason.length).toBeGreaterThan(40);
    }
  });

  it('offers only the modes it can fully configure AND observe', () => {
    // PARALLEL_PWM left this list in the P4 closure pass: its
    // configuration is complete, but msp_build_info.c emits no option for
    // it, so its presence in the connected build is unobservable.
    expect([...WRITABLE_RECEIVER_MODES].sort()).toEqual(['PPM', 'SERIAL']);
    expect(RECEIVER_MODE_CAPABILITY.PARALLEL_PWM.classification).toBe('READ_ONLY');
    expect(RECEIVER_MODE_CAPABILITY.PARALLEL_PWM.reason).toContain('BUILD_OPTION');
  });

  it('keeps SPI read-only, because rx_spi_protocol is not ours to author', () => {
    expect(receiverModeIsWritable('SPI')).toBe(false);
    expect(RECEIVER_MODE_CAPABILITY.SPI.reason).toContain('rx_spi_protocol');
  });

  it('keeps NONE unselectable, because it removes the control source', () => {
    expect(receiverModeIsWritable('NONE')).toBe(false);
    expect(WRITABLE_RECEIVER_MODES).not.toContain('NONE');
  });

  it('keeps MSP unselectable, because this product sends no RC over MSP', () => {
    expect(receiverModeIsWritable('MSP')).toBe(false);
  });

  it('lists writable modes in the firmware precedence order rxInit applies', () => {
    // rx.c:284-298 evaluates PARALLEL_PWM, PPM, SERIAL, MSP, SPI in order.
    expect(WRITABLE_RECEIVER_MODES).toEqual(['PPM', 'SERIAL']);
  });
});

describe('P4 feature-mask mutation preserves everything it does not own', () => {
  const BUSY_MASK = RX_SERIAL | INFLIGHT_ACC_CAL | MOTOR_STOP | GPS | TELEMETRY | OSD | ANTI_GRAVITY | UNKNOWN_HIGH_BIT;

  it.each([['PPM', RX_PPM], ['SERIAL', RX_SERIAL]] as const)(
    'sets exactly the %s bit and clears the other receiver bits',
    (mode, bit) => {
      const before = RX_PPM | RX_SERIAL | RX_SPI; // deliberately several at once
      const after = applyReceiverModeToFeatureMask(before, mode);
      expect(receiverOwnedModeBits(after)).toBe(bit);
      expect(resolveReceiverMode(after)).toBe(mode);
    },
  );

  it('preserves bit 0-adjacent, GPS, telemetry, OSD, anti-gravity and an unknown high bit', () => {
    const after = applyReceiverModeToFeatureMask(BUSY_MASK, 'PPM');
    for (const [name, bit] of [['INFLIGHT_ACC_CAL', INFLIGHT_ACC_CAL], ['MOTOR_STOP', MOTOR_STOP], ['GPS', GPS], ['TELEMETRY', TELEMETRY], ['OSD', OSD], ['ANTI_GRAVITY', ANTI_GRAVITY], ['UNKNOWN_HIGH_BIT', UNKNOWN_HIGH_BIT]] as const) {
      // eslint-disable-next-line no-bitwise
      expect({[name]: (after & bit) !== 0}).toEqual({[name]: true});
    }
  });

  it('changes ONLY the receiver-owned bits, byte for byte', () => {
    const after = applyReceiverModeToFeatureMask(BUSY_MASK, 'PPM');
    // eslint-disable-next-line no-bitwise
    expect(after & ~RECEIVER_MODE_FEATURE_MASK).toBe(BUSY_MASK & ~RECEIVER_MODE_FEATURE_MASK);
  });

  it('returns an unsigned mask even when bit 31 is set', () => {
    const after = applyReceiverModeToFeatureMask(UNKNOWN_HIGH_BIT | RX_SPI, 'SERIAL');
    expect(after).toBeGreaterThan(0);
    expect(after).toBe(UNKNOWN_HIGH_BIT + RX_SERIAL);
  });

  it('is a total function of the fresh mask: the same input always gives the same output', () => {
    expect(applyReceiverModeToFeatureMask(BUSY_MASK, 'SERIAL')).toBe(applyReceiverModeToFeatureMask(BUSY_MASK, 'SERIAL'));
  });

  it('refuses to write a mode the capability matrix does not clear', () => {
    for (const mode of ['SPI', 'MSP', 'NONE', 'PARALLEL_PWM'] as const) {
      expect(() => applyReceiverModeToFeatureMask(BUSY_MASK, mode)).toThrow(RangeError);
    }
  });

  it('produces a mask that resolves back to the requested mode', () => {
    for (const mode of WRITABLE_RECEIVER_MODES) {
      expect(receiverModeAfterMutation(BUSY_MASK, mode)).toBe(mode);
    }
  });
});

describe('P4 staleness is scoped to the receiver-owned bits', () => {
  it('is NOT stale when an unrelated feature changed under us', () => {
    // Another screen enabled GPS between load and save. Receiver must
    // preserve that, not refuse the save.
    expect(receiverModeBaseIsStale(RX_SERIAL, RX_SERIAL | GPS)).toBe(false);
  });

  it('IS stale when the receiver mode changed under us', () => {
    expect(receiverModeBaseIsStale(RX_SERIAL, RX_PPM)).toBe(true);
    expect(receiverModeBaseIsStale(RX_SERIAL, RX_SERIAL | RX_PPM)).toBe(true);
  });

  it('is not stale when nothing changed at all', () => {
    expect(receiverModeBaseIsStale(RX_SERIAL | GPS, RX_SERIAL | GPS)).toBe(false);
  });
});

describe('P4 serial dependency verdicts', () => {
  it('is satisfied with exactly one Serial RX UART', () => {
    expect(resolveReceiverTargetDependency('SERIAL', [port(1, FUNCTION_RX_SERIAL), port(2, 0)])).toEqual({kind: 'SATISFIED'});
  });

  it('reports MISSING with none', () => {
    expect(resolveReceiverTargetDependency('SERIAL', [port(1, 0), port(2, 0)])).toEqual({kind: 'DEPENDENCY_MISSING'});
  });

  it('reports AMBIGUOUS with more than one, and names them', () => {
    expect(resolveReceiverTargetDependency('SERIAL', [port(1, FUNCTION_RX_SERIAL), port(3, FUNCTION_RX_SERIAL)]))
      .toEqual({kind: 'DEPENDENCY_AMBIGUOUS', portIdentifiers: [1, 3]});
  });

  it('reports UNKNOWN rather than MISSING when Ports could not be read', () => {
    // The distinction matters: "no UART" invites the operator to go and
    // assign one; "unknown" tells them we could not look.
    expect(resolveReceiverTargetDependency('SERIAL', undefined)).toEqual({kind: 'DEPENDENCY_UNKNOWN'});
  });

  it('requires no UART for a non-serial target', () => {
    for (const mode of ['PPM', 'PARALLEL_PWM', 'MSP', 'SPI', 'NONE'] as const) {
      expect(resolveReceiverTargetDependency(mode, [])).toEqual({kind: 'SATISFIED'});
    }
  });
});

describe('P4 apply requirement', () => {
  it('classifies BOTH mode and provider as structurally needing a restart', () => {
    expect(RECEIVER_MODE_APPLY_REQUIREMENT).toBe('STRUCTURAL_REBOOT');
    expect(RECEIVER_PROVIDER_APPLY_REQUIREMENT).toBe('STRUCTURAL_REBOOT');
  });

  it('does NOT claim the flight controller reports it', () => {
    // msp.c wires configRebootUpdateCheckU8 to five rc_smoothing fields
    // and nothing else, so STATUS_EX reports 0 after a mode change. A
    // FIRMWARE_REPORTED_REBOOT classification here would be a lie the UI
    // would then repeat.
    expect(RECEIVER_MODE_APPLY_REQUIREMENT).not.toBe('FIRMWARE_REPORTED_REBOOT');
    expect(RECEIVER_MODE_APPLY_REQUIREMENT).not.toBe('NO_REBOOT_REQUIRED');
  });
});

describe('P4 module boundary', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, 'receiverModeCapability.ts'), 'utf8');

  it('performs no I/O and knows nothing about MSP transport', () => {
    // Comments and the human-readable `reason` strings CITE firmware
    // command names as evidence - that is the point of them. What must
    // be absent is any way to actually reach a transport: an import of
    // one, an async boundary, or a request call.
    const imports = source.split('\n').filter((line: string) => line.trimStart().startsWith('import')).join('\n');
    for (const forbidden of ['MspClient', 'mspSessionCoordinator', 'protocol/mspClient', 'react-native']) {
      expect(imports).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/\basync\b/);
    expect(source).not.toMatch(/requester\.request|client\.request/);
  });

  it('invents no ExpressLRS provider and no link-quality concept', () => {
    expect(source.toLowerCase()).not.toContain('expresslrs');
    expect(source.toLowerCase()).not.toMatch(/\blq\b/);
    expect(source.toLowerCase()).not.toContain('linkquality');
  });

  it('never writes Ports - it only asks the canonical resolver for a verdict', () => {
    expect(source).toContain('resolveReceiverPortDependency');
    expect(source).not.toMatch(/setSerialRole|encodeSerialPorts|SET_SERIAL/);
  });
});
