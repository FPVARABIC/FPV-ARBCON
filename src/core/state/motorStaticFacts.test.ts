/**
 * Motor read-capability pass - tests for the pure static FC-facts model.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated here: no
 * flight controller, no USB, no ESC, no motor, no LiPo. Every input is a
 * hand-written plain object, and the module under test performs no I/O.
 */

import {
  assembleMotorStaticFacts,
  bindMotorStaticFacts,
  type MotorStaticFacts,
  type MotorStaticFactsInput,
} from './motorStaticFacts';
import type {MspApiVersion} from '../protocol/msp/decoding/decodeApiVersion';
import type {FlightControllerIdentity} from '../protocol/msp/identification/mspIdentificationTypes';

const apiVersion: MspApiVersion = {
  mspProtocolVersion: 0,
  apiVersionMajor: 1,
  apiVersionMinor: 47,
};

const identity: FlightControllerIdentity = {
  apiVersion,
  firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
  board: {
    boardIdentifier: 'S405',
    hardwareRevision: 0,
    boardType: 2,
    targetCapabilities: 0,
    targetName: 'STM32F405',
    boardName: 'TESTBOARD',
    manufacturerId: 'TEST',
    signature: Uint8Array.from([]),
    mcuTypeId: 1,
    trailingBytes: new Uint8Array(0),
  },
};

/** Distinct, non-default values throughout, so a field copied from the
 * wrong source structure cannot coincidentally look correct. */
function makeInput(overrides: Partial<MotorStaticFactsInput> = {}): MotorStaticFactsInput {
  return {
    identity,
    apiVersion,
    mixerConfig: {mixerModeRaw: 26, yawMotorsReversed: true, yawMotorsReversedRaw: 1},
    motorConfig: {
      deprecatedMinThrottle: 0,
      maxThrottle: 2000,
      minCommand: 1000,
      motorCount: 4,
      motorPoleCount: 14,
      dshotTelemetryRaw: 1,
      escSensorRaw: 0,
    },
    advancedConfig: {
      deprecatedGyroSyncDenom: 1,
      pidProcessDenom: 2,
      useContinuousUpdate: 0,
      motorProtocolRaw: 7,
      motorPwmRate: 480,
      motorIdleRaw: 550,
      deprecatedGyroUse32kHz: 0,
      motorInversionRaw: 0,
      deprecatedGyroToUse: 0,
      gyroHighFsr: 0,
      gyroMovementCalibrationThreshold: 48,
      gyroCalibrationDuration: 125,
      gyroYawOffset: -10,
      checkOverflow: 2,
      debugMode: 0,
      debugModeCount: 111,
      ...(overrides.advancedConfig ?? {}),
    },
    featureConfig: {enabledFeaturesRaw: 0x0000_1000, feature3dEnabled: true},
    ...overrides,
  };
}

/** Performs a write that is expected to be rejected, tolerating either
 * rejection form (silent no-op in sloppy mode, TypeError in strict mode)
 * so the caller can assert the value itself is unchanged. */
function attemptWrite(write: () => void): void {
  try {
    write();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
}

describe('assembleMotorStaticFacts', () => {
  it('copies every field from the decoded response that owns it', () => {
    const facts = assembleMotorStaticFacts(makeInput());

    expect(facts.identity).toBe(identity);
    expect(facts.apiVersion).toBe(apiVersion);
    expect(facts.mixerModeRaw).toBe(26);
    expect(facts.yawMotorsReversed).toBe(true);
    expect(facts.motorCount).toBe(4);
    expect(facts.motorPoleCount).toBe(14);
    expect(facts.motorProtocolRaw).toBe(7);
    expect(facts.motorIdleRaw).toBe(550);
    expect(facts.feature3dEnabled).toBe(true);
    expect(facts.bidirectionalDshotRaw).toBe(1);
  });

  it('takes motor count ONLY from MSP_MOTOR_CONFIG', () => {
    // There is no MSP_MOTOR input to this function at all, so a count can
    // never be back-derived from live output values.
    const input = makeInput();
    expect(Object.keys(input)).not.toContain('motorOutputs');
    expect(assembleMotorStaticFacts({
      ...input,
      motorConfig: {...input.motorConfig, motorCount: 6},
    }).motorCount).toBe(6);
  });

  it('takes 3D state ONLY from FEATURE_3D, never from deadband/neutral values', () => {
    const input = makeInput();
    // MSP_MOTOR_3D_CONFIG is not an input here; only the feature bit is.
    expect(Object.keys(input)).not.toContain('motor3dConfig');
    expect(
      assembleMotorStaticFacts({
        ...input,
        featureConfig: {enabledFeaturesRaw: 0, feature3dEnabled: false},
      }).feature3dEnabled,
    ).toBe(false);
  });

  it('keeps motor idle raw and exposes no pulse/throttle value derived from it', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    expect(facts.motorIdleRaw).toBe(550);
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/pulse|throttle|command|spin|test/i);
    }
    // 550 hundredths-of-a-percent must not have been turned into an
    // 1000..2000 external value anywhere in the object.
    expect(Object.values(facts)).not.toContain(1055);
    expect(Object.values(facts)).not.toContain(1000);
  });

  it('computes no compatibility verdict', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/supported|compatible|allowed|safe|ready|ok/i);
    }
    for (const value of Object.values(facts)) {
      // The only booleans are the two wire-truth flags asserted above.
      if (typeof value === 'boolean') {
        expect([facts.yawMotorsReversed, facts.feature3dEnabled]).toContain(value);
      }
    }
  });
});

describe('static/dynamic separation', () => {
  const dynamicFieldNames = [
    'armed',
    'armingDisabledFlags',
    'armingDisableFlags',
    'batteryState',
    'batteryVoltage',
    'motorOutputs',
    'motorValues',
    'values',
    'rebootRequired',
  ];

  it('holds no dynamic flight-controller state', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const name of dynamicFieldNames) {
      expect(Object.keys(facts)).not.toContain(name);
    }
  });

  it('holds no session identity - that is composed separately', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const name of ['sessionId', 'sessionKey', 'generation', 'epoch', 'mspEpoch']) {
      expect(Object.keys(facts)).not.toContain(name);
    }
  });

  it('holds no user-provided hardware facts - none of these is MSP-discoverable', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const name of [
      'frame',
      'frameSize',
      'motorModel',
      'motorKv',
      'kv',
      'escModel',
      'escFirmware',
      'batteryBrand',
      'batteryCapacity',
      'batteryCRating',
      'propDirection',
      'propellerDirection',
      'physicalDirection',
      'mechanicalCondition',
    ]) {
      expect(Object.keys(facts)).not.toContain(name);
    }
  });

  it('does not treat yawMotorsReversed as physical rotation evidence', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    // The FC-configuration flag is present; no physical-direction claim is.
    expect(Object.keys(facts)).toContain('yawMotorsReversed');
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/^(cw|ccw)|propsOut|propsIn|spinDirection/i);
    }
  });
});

describe('readonly / defensive behavior', () => {
  it('returns a frozen facts object', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    expect(Object.isFrozen(facts)).toBe(true);
    // Asserted as "the write does not take effect" rather than "the write
    // throws": a frozen object rejects assignment silently outside strict
    // mode, and the property that matters is that no caller can rewrite
    // another caller's view of the aircraft.
    attemptWrite(() => {
      (facts as {motorCount: number}).motorCount = 8;
    });
    expect(facts.motorCount).toBe(4);
  });

  it('is unaffected by later mutation of the caller-supplied input object', () => {
    const input = makeInput();
    const mutable = input as {motorConfig: {motorCount: number}};
    const facts = assembleMotorStaticFacts(input);
    mutable.motorConfig = {...input.motorConfig, motorCount: 8};
    expect(facts.motorCount).toBe(4);
  });

  it('produces independent objects for independent calls', () => {
    const a = assembleMotorStaticFacts(makeInput());
    const b = assembleMotorStaticFacts(makeInput());
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('bindMotorStaticFacts', () => {
  const facts: MotorStaticFacts = assembleMotorStaticFacts(makeInput());

  it('composes session identity ALONGSIDE the facts, never inside them', () => {
    const bound = bindMotorStaticFacts({sessionId: 'session-1', generation: 3}, facts);
    expect(bound.identity).toEqual({sessionId: 'session-1', generation: 3});
    expect(bound.facts).toBe(facts);
    // The facts object itself is untouched by binding.
    expect(Object.keys({...bound.facts})).not.toContain('sessionId');
    expect(Object.keys({...bound.facts})).not.toContain('generation');
  });

  it('returns a frozen binding', () => {
    const bound = bindMotorStaticFacts('session-1', facts);
    expect(Object.isFrozen(bound)).toBe(true);
    attemptWrite(() => {
      (bound as {identity: string}).identity = 'session-2';
    });
    expect(bound.identity).toBe('session-1');
  });

  it('lets the same facts be bound to two different sessions without aliasing', () => {
    const first = bindMotorStaticFacts('session-1', facts);
    const second = bindMotorStaticFacts('session-2', facts);
    expect(first.identity).toBe('session-1');
    expect(second.identity).toBe('session-2');
    expect(first.facts).toBe(second.facts);
  });
});
