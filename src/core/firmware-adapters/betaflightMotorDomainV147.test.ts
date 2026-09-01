/**
 * P1-B - the motor test value domain resolver.
 *
 * Every expected number below is traced to Betaflight
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e in the module's own header;
 * nothing here asserts a physical outcome.
 */
import {
  MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DISABLED_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2,
  MotorTestDomainError,
  PWM_RANGE_MAX_AT_2025_12_2,
  PWM_RANGE_MIDDLE_AT_2025_12_2,
  PWM_RANGE_MIN_AT_2025_12_2,
  resolveMotorProtocolFamily,
  resolveMotorTestValueDomain,
  type MotorTestDomainInput,
} from './betaflightMotorDomainV147';
import {
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
} from '../protocol/msp/decoding/decodeAdvancedConfig';

const digital = (over: Partial<MotorTestDomainInput> = {}): MotorTestDomainInput => ({
  motorCount: 4,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  feature3dEnabled: false,
  minCommand: 1000,
  maxThrottle: 2000,
  ...over,
});

const analog = (over: Partial<MotorTestDomainInput> = {}): MotorTestDomainInput => ({
  motorCount: 4,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2,
  feature3dEnabled: false,
  minCommand: 900,
  maxThrottle: 1900,
  ...over,
});

describe('resolveMotorProtocolFamily - motorGetProtocolFamily() parity', () => {
  it('maps every DShot-family raw', () => {
    for (const raw of [
      MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
    ]) {
      expect(resolveMotorProtocolFamily(raw)).toBe('DSHOT');
    }
  });

  it('maps every PWM-family raw', () => {
    for (const raw of [
      MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2,
      MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2,
    ]) {
      expect(resolveMotorProtocolFamily(raw)).toBe('PWM');
    }
  });

  it('maps MOTOR_PROTOCOL_DISABLED and unknown raws to UNKNOWN', () => {
    expect(resolveMotorProtocolFamily(MOTOR_PROTOCOL_RAW_DISABLED_AT_2025_12_2)).toBe('UNKNOWN');
    for (const raw of [10, 42, 255, -1]) {
      expect(resolveMotorProtocolFamily(raw)).toBe('UNKNOWN');
    }
  });
});

describe('resolveMotorTestValueDomain - digital, non-3D', () => {
  it('uses PWM_RANGE with stop at PWM_RANGE_MIN', () => {
    const domain = resolveMotorTestValueDomain(digital());
    expect(domain).toEqual({
      motorCount: 4,
      protocolFamily: 'DSHOT',
      feature3dEnabled: false,
      commandDomainMin: PWM_RANGE_MIN_AT_2025_12_2,
      commandDomainMax: PWM_RANGE_MAX_AT_2025_12_2,
      domainSource: 'FIRMWARE_CONSTRAIN',
      stopValue: PWM_RANGE_MIN_AT_2025_12_2,
      notKnowableFromMsp: [],
    });
  });

  it('ignores mincommand/maxthrottle, because dshot.c constrains to PWM_RANGE', () => {
    const domain = resolveMotorTestValueDomain(
      digital({minCommand: 900, maxThrottle: 1850}),
    );
    expect(domain.commandDomainMin).toBe(1000);
    expect(domain.commandDomainMax).toBe(2000);
    expect(domain.stopValue).toBe(1000);
  });

  it('carries the FC-reported motor count through unchanged', () => {
    for (let motorCount = 1; motorCount <= 8; motorCount += 1) {
      expect(resolveMotorTestValueDomain(digital({motorCount})).motorCount).toBe(motorCount);
    }
  });
});

describe('resolveMotorTestValueDomain - analog, non-3D', () => {
  it('takes the domain from mincommand..maxthrottle, with stop at mincommand', () => {
    const domain = resolveMotorTestValueDomain(analog());
    expect(domain.motorCount).toBe(4);
    expect(domain.protocolFamily).toBe('PWM');
    expect(domain.feature3dEnabled).toBe(false);
    expect(domain.commandDomainMin).toBe(900);
    expect(domain.commandDomainMax).toBe(1900);
    // The firmware does NOT clamp on the analog path: the product permits
    // commands within the configured control domain, so values outside it
    // are rejected by PRODUCT POLICY, not by a firmware wire bound.
    expect(domain.domainSource).toBe('CONFIGURATION_POLICY');
    expect(domain.stopValue).toBe(900);
    expect(domain.notKnowableFromMsp.length).toBeGreaterThan(0);
  });

  it('does not assume 1000 is the analog zero', () => {
    expect(resolveMotorTestValueDomain(analog({minCommand: 940})).stopValue).toBe(940);
  });

  it('rejects an empty or inverted analog domain', () => {
    expect(() =>
      resolveMotorTestValueDomain(analog({minCommand: 1900, maxThrottle: 1900})),
    ).toThrow(MotorTestDomainError);
    expect(() =>
      resolveMotorTestValueDomain(analog({minCommand: 1900, maxThrottle: 1000})),
    ).toThrow(MotorTestDomainError);
  });
});

describe('resolveMotorTestValueDomain - 3D / reversible', () => {
  const motor3d = {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460};

  it('puts DShot 3D neutral at PWM_RANGE_MIDDLE, not at neutral3d', () => {
    const domain = resolveMotorTestValueDomain(
      digital({feature3dEnabled: true, motor3d}),
    );
    expect(domain.feature3dEnabled).toBe(true);
    expect(domain.neutral).toBe(PWM_RANGE_MIDDLE_AT_2025_12_2);
    expect(domain.stopValue).toBe(PWM_RANGE_MIDDLE_AT_2025_12_2);
    expect(domain.stopValue).not.toBe(motor3d.neutral3d);
    expect(domain.domainSource).toBe('FIRMWARE_CONSTRAIN');
    expect(domain.provenReverseRegion).toEqual({min: 1000, max: 1499});
    expect(domain.provenForwardRegion).toEqual({min: 1501, max: 2000});
    expect(domain.notKnowableFromMsp).toEqual([]);
    expect(domain.deadbandLow).toBe(1406);
    expect(domain.deadbandHigh).toBe(1514);
  });

  it('puts analog 3D neutral at neutral3d, because the analog path passes through', () => {
    const domain = resolveMotorTestValueDomain(
      analog({feature3dEnabled: true, motor3d}),
    );
    expect(domain.neutral).toBe(1460);
    expect(domain.stopValue).toBe(1460);
    // NOT approximated: limit3d_low/high are not on the wire at API 1.47,
    // so the active regions are left absent and the gap is named.
    expect(domain.provenReverseRegion).toBeUndefined();
    expect(domain.provenForwardRegion).toBeUndefined();
    expect(domain.domainSource).toBe('CONFIGURATION_POLICY');
    expect(domain.notKnowableFromMsp.join(' ')).toContain('limit3d_low');
  });

  it('never reports 1000 as the stop value while 3D is enabled', () => {
    for (const input of [
      digital({feature3dEnabled: true, motor3d}),
      analog({feature3dEnabled: true, motor3d}),
    ]) {
      expect(resolveMotorTestValueDomain(input).stopValue).not.toBe(1000);
    }
  });

  it('rejects 3D without MSP_MOTOR_3D_CONFIG values', () => {
    expect(() => resolveMotorTestValueDomain(digital({feature3dEnabled: true}))).toThrow(
      MotorTestDomainError,
    );
  });

  it('rejects an invalid 3D configuration', () => {
    // deadbandLow above deadbandHigh
    expect(() =>
      resolveMotorTestValueDomain(
        analog({
          feature3dEnabled: true,
          motor3d: {deadband3dLow: 1600, deadband3dHigh: 1400, neutral3d: 1460},
        }),
      ),
    ).toThrow(MotorTestDomainError);
    // neutral outside the analog domain
    expect(() =>
      resolveMotorTestValueDomain(
        analog({
          feature3dEnabled: true,
          motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 2500},
        }),
      ),
    ).toThrow(MotorTestDomainError);
    // neutral exactly at an edge leaves no reverse region
    expect(() =>
      resolveMotorTestValueDomain(
        analog({
          feature3dEnabled: true,
          motor3d: {deadband3dLow: 901, deadband3dHigh: 1514, neutral3d: 900},
        }),
      ),
    ).toThrow(MotorTestDomainError);
    // non-integer 3D values
    expect(() =>
      resolveMotorTestValueDomain(
        analog({
          feature3dEnabled: true,
          motor3d: {deadband3dLow: 1406.5, deadband3dHigh: 1514, neutral3d: 1460},
        }),
      ),
    ).toThrow(MotorTestDomainError);
  });
});

describe('resolveMotorTestValueDomain - rejections', () => {
  it('rejects an unknown or disabled protocol', () => {
    expect(() =>
      resolveMotorTestValueDomain(
        digital({motorProtocolRaw: MOTOR_PROTOCOL_RAW_DISABLED_AT_2025_12_2}),
      ),
    ).toThrow(MotorTestDomainError);
    expect(() => resolveMotorTestValueDomain(digital({motorProtocolRaw: 99}))).toThrow(
      MotorTestDomainError,
    );
  });

  it('rejects motorCount outside 1..MAX_SUPPORTED_MOTORS', () => {
    for (const motorCount of [0, -1, 9, 12]) {
      expect(() => resolveMotorTestValueDomain(digital({motorCount}))).toThrow(
        MotorTestDomainError,
      );
    }
  });

  it('rejects fractional or non-numeric configuration values', () => {
    expect(() => resolveMotorTestValueDomain(digital({motorCount: 4.5}))).toThrow(
      MotorTestDomainError,
    );
    expect(() => resolveMotorTestValueDomain(analog({minCommand: 900.5}))).toThrow(
      MotorTestDomainError,
    );
    expect(() =>
      resolveMotorTestValueDomain(analog({maxThrottle: Number.NaN})),
    ).toThrow(MotorTestDomainError);
  });

  it('returns a frozen domain', () => {
    const domain = resolveMotorTestValueDomain(digital());
    expect(Object.isFrozen(domain)).toBe(true);
  });
});

describe('analog command-domain provenance is never overstated', () => {
  it('labels the analog bound CONFIGURATION_POLICY in every analog shape', () => {
    const shapes = [
      analog(),
      analog({minCommand: 940, maxThrottle: 1850}),
      analog({
        feature3dEnabled: true,
        motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
      }),
    ];
    for (const input of shapes) {
      expect(resolveMotorTestValueDomain(input).domainSource).toBe(
        'CONFIGURATION_POLICY',
      );
    }
  });

  it('labels every digital shape FIRMWARE_CONSTRAIN, which pinned source proves', () => {
    const shapes = [
      digital(),
      digital({minCommand: 900, maxThrottle: 1850}),
      digital({
        feature3dEnabled: true,
        motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
      }),
    ];
    for (const input of shapes) {
      expect(resolveMotorTestValueDomain(input).domainSource).toBe(
        'FIRMWARE_CONSTRAIN',
      );
    }
  });

  it('keeps the analog command domain bounded - never widened to raw u16', () => {
    const domain = resolveMotorTestValueDomain(analog());
    expect(domain.commandDomainMin).toBe(900);
    expect(domain.commandDomainMax).toBe(1900);
    expect(domain.commandDomainMin).toBeGreaterThan(0);
    expect(domain.commandDomainMax).toBeLessThan(0xffff);
  });

  it('still refuses to infer analog 3D active regions from the missing limits', () => {
    const domain = resolveMotorTestValueDomain(
      analog({
        feature3dEnabled: true,
        motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
      }),
    );
    expect(domain.provenReverseRegion).toBeUndefined();
    expect(domain.provenForwardRegion).toBeUndefined();
    expect(domain.notKnowableFromMsp.join(' ')).toContain('limit3d_low');
  });
});
