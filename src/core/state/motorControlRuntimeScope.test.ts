/**
 * P2-i / P2-N - runtime scope classification.
 *
 * Every domain here is produced by the real P1 resolver rather than
 * hand-written, so a change to the resolver's provenance cannot silently
 * widen what the runtime is willing to command. Nothing asserts a physical
 * outcome.
 */
import {
  classifyMotorControlRuntimeScope,
  type MotorControlRuntimeScope,
} from './motorControlRuntimeScope';
import {
  resolveMotorTestValueDomain,
  type MotorTestDomainInput,
} from '../firmware-adapters/betaflightMotorDomainV147';

const MOTOR_3D = {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460};

const digital = (over: Partial<MotorTestDomainInput> = {}): MotorTestDomainInput => ({
  motorCount: 4,
  motorProtocolRaw: 7, // DSHOT600
  feature3dEnabled: false,
  minCommand: 1000,
  maxThrottle: 2000,
  ...over,
});

const analog = (over: Partial<MotorTestDomainInput> = {}): MotorTestDomainInput => ({
  motorCount: 4,
  motorProtocolRaw: 3, // MULTISHOT
  feature3dEnabled: false,
  minCommand: 900,
  maxThrottle: 1900,
  ...over,
});

const classify = (input: MotorTestDomainInput): MotorControlRuntimeScope =>
  classifyMotorControlRuntimeScope(resolveMotorTestValueDomain(input));

describe('runtime scope - eligible configurations', () => {
  it('digital non-3D is eligible on every DShot-family protocol', () => {
    for (const motorProtocolRaw of [5, 6, 7, 8]) {
      const scope = classify(digital({motorProtocolRaw}));
      expect(scope.eligible).toBe(true);
    }
  });

  it('digital 3D is eligible, with the exact midpoint neutral', () => {
    const scope = classify(digital({feature3dEnabled: true, motor3d: MOTOR_3D}));
    expect(scope.eligible).toBe(true);
    if (scope.eligible) {
      expect(scope.domain.stopValue).toBe(1500);
      expect(scope.domain.provenReverseRegion).toEqual({min: 1000, max: 1499});
      expect(scope.domain.provenForwardRegion).toEqual({min: 1501, max: 2000});
    }
  });

  it('analog non-3D is eligible and RETAINS its CONFIGURATION_POLICY provenance', () => {
    const scope = classify(analog());
    expect(scope.eligible).toBe(true);
    if (scope.eligible) {
      expect(scope.domain.domainSource).toBe('CONFIGURATION_POLICY');
      expect(scope.domain.commandDomainMin).toBe(900);
      expect(scope.domain.commandDomainMax).toBe(1900);
      expect(scope.domain.stopValue).toBe(900);
    }
  });

  it('eligibility does not depend on motor count', () => {
    for (let motorCount = 1; motorCount <= 8; motorCount += 1) {
      expect(classify(digital({motorCount})).eligible).toBe(true);
    }
  });
});

describe('runtime scope - analog 3D is refused, not approximated', () => {
  it('refuses analog 3D and names the missing endpoints', () => {
    const scope = classify(analog({feature3dEnabled: true, motor3d: MOTOR_3D}));
    expect(scope.eligible).toBe(false);
    if (!scope.eligible) {
      expect(scope.refusal).toBe('ANALOG_3D_ACTIVE_ENDPOINTS_UNKNOWN');
      expect(scope.notKnowableFromMsp.join(' ')).toContain('limit3d_low');
      expect(scope.notKnowableFromMsp.join(' ')).toContain('limit3d_high');
    }
  });

  it('refuses analog 3D for every analog protocol and every neutral', () => {
    for (const motorProtocolRaw of [0, 1, 2, 3, 4]) {
      for (const neutral3d of [1450, 1460, 1500]) {
        const scope = classify(
          analog({
            motorProtocolRaw,
            feature3dEnabled: true,
            motor3d: {...MOTOR_3D, neutral3d},
          }),
        );
        expect(scope.eligible).toBe(false);
      }
    }
  });

  it('does not become eligible just because the domain resolved successfully', () => {
    const domain = resolveMotorTestValueDomain(
      analog({feature3dEnabled: true, motor3d: MOTOR_3D}),
    );
    // P1 CAN describe it...
    expect(domain.stopValue).toBe(1460);
    expect(domain.commandDomainMin).toBe(900);
    // ...and P2 still refuses to command it.
    expect(classifyMotorControlRuntimeScope(domain).eligible).toBe(false);
  });
});

describe('runtime scope - unknown protocol family', () => {
  it('an unknown or disabled protocol never reaches the classifier as a domain', () => {
    // The P1 resolver refuses first, which is the stronger guarantee.
    expect(() => resolveMotorTestValueDomain(digital({motorProtocolRaw: 9}))).toThrow();
    expect(() => resolveMotorTestValueDomain(digital({motorProtocolRaw: 42}))).toThrow();
  });

  it('is refused defensively if one is ever constructed by hand', () => {
    const scope = classifyMotorControlRuntimeScope({
      motorCount: 4,
      protocolFamily: 'UNKNOWN',
      feature3dEnabled: false,
      commandDomainMin: 1000,
      commandDomainMax: 2000,
      domainSource: 'FIRMWARE_CONSTRAIN',
      stopValue: 1000,
      notKnowableFromMsp: [],
    });
    expect(scope.eligible).toBe(false);
    if (!scope.eligible) {
      expect(scope.refusal).toBe('PROTOCOL_FAMILY_UNKNOWN');
    }
  });

  it('a 3D domain with no neutral is refused defensively', () => {
    const scope = classifyMotorControlRuntimeScope({
      motorCount: 4,
      protocolFamily: 'DSHOT',
      feature3dEnabled: true,
      commandDomainMin: 1000,
      commandDomainMax: 2000,
      domainSource: 'FIRMWARE_CONSTRAIN',
      stopValue: 1500,
      notKnowableFromMsp: [],
    });
    expect(scope.eligible).toBe(false);
    if (!scope.eligible) {
      expect(scope.refusal).toBe('THREE_D_NEUTRAL_UNRESOLVED');
    }
  });

  it('a non-analog 3D domain missing proven regions is refused by the proof rule', () => {
    const scope = classifyMotorControlRuntimeScope({
      motorCount: 4,
      protocolFamily: 'DSHOT',
      feature3dEnabled: true,
      commandDomainMin: 1000,
      commandDomainMax: 2000,
      domainSource: 'FIRMWARE_CONSTRAIN',
      stopValue: 1500,
      neutral: 1500,
      notKnowableFromMsp: [],
    });
    expect(scope.eligible).toBe(false);
    if (!scope.eligible) {
      expect(scope.refusal).toBe('THREE_D_ACTIVE_REGIONS_UNPROVEN');
    }
  });
});

describe('runtime scope - structural', () => {
  it('returns a frozen result', () => {
    expect(Object.isFrozen(classify(digital()))).toBe(true);
    expect(
      Object.isFrozen(classify(analog({feature3dEnabled: true, motor3d: MOTOR_3D}))),
    ).toBe(true);
  });
});
