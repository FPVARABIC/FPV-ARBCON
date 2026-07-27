/**
 * Motor read-capability pass - tests for the pure static FC-facts model.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated here: no
 * flight controller, no USB, no ESC, no motor, no LiPo. Every input is a
 * hand-written plain object, and the module under test performs no I/O.
 *
 * The immutability tests deliberately assert OBSERVED VALUES after an
 * attempted write, not merely that a `readonly` annotation exists: a
 * readonly type is erased at runtime and proves nothing about what a
 * holder of the object can actually do to it.
 */

import {
  assembleMotorStaticFacts,
  bindMotorStaticFacts,
  type MotorStaticFacts,
  type MotorStaticFactsInput,
  type MotorStaticFactsSessionIdentity,
} from './motorStaticFacts';
import type {MspApiVersion} from '../protocol/msp/decoding/decodeApiVersion';
import type {MspBoardInfo} from '../protocol/msp/decoding/decodeBoardInfo';
import type {FlightControllerIdentity, MspFcVariant} from '../protocol/msp/identification/mspIdentificationTypes';

/** Fresh mutable fixtures per call - these stand in for the objects the
 * existing identification decoders hand out, which are NOT frozen. */
function makeApiVersion(): MspApiVersion {
  return {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47};
}

function makeFirmware(): MspFcVariant {
  return {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'};
}

/** Every optional field populated, so the exact nested key set can be
 * asserted in full. `makeBoardWithoutOptionals` covers the other case. */
function makeBoard(): MspBoardInfo {
  return {
    boardIdentifier: 'S405',
    hardwareRevision: 3,
    boardType: 2,
    targetCapabilities: 0b0100_0011,
    targetName: 'STM32F405',
    boardName: 'TESTBOARD',
    manufacturerId: 'TEST',
    signature: Uint8Array.from([1, 2, 3, 250, 0, 255]),
    mcuTypeId: 1,
    configurationState: 2,
    gyroSampleRateHz: 8000,
    configurationProblems: 1,
    spiRegisteredDeviceCount: 4,
    i2cRegisteredDeviceCount: 2,
    trailingBytes: Uint8Array.from([9, 8, 7]),
  };
}

function makeBoardWithoutOptionals(): MspBoardInfo {
  const board = makeBoard();
  return {
    boardIdentifier: board.boardIdentifier,
    hardwareRevision: board.hardwareRevision,
    boardType: board.boardType,
    targetCapabilities: board.targetCapabilities,
    targetName: board.targetName,
    boardName: board.boardName,
    manufacturerId: board.manufacturerId,
    signature: board.signature,
    mcuTypeId: board.mcuTypeId,
    trailingBytes: board.trailingBytes,
  };
}

function makeIdentity(): FlightControllerIdentity {
  return {apiVersion: makeApiVersion(), firmware: makeFirmware(), board: makeBoard()};
}

/** Distinct, non-default values throughout, so a field copied from the
 * wrong source structure cannot coincidentally look correct. */
function makeInput(overrides: Partial<MotorStaticFactsInput> = {}): MotorStaticFactsInput {
  return {
    flightControllerIdentity: makeIdentity(),
    mixerConfig: {mixerModeRaw: 26, yawMotorsReversedConfigured: true, yawMotorsReversedRaw: 1},
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
    },
    featureConfig: {enabledFeaturesRaw: 0x0000_1000, feature3dEnabled: true},
    ...overrides,
  };
}

/**
 * Attempts a write through the public surface using Reflect.set, which
 * returns false on a frozen target instead of throwing, and needs no
 * `any` and no cast to call. The caller then asserts the OBSERVED value,
 * which is the property that actually matters.
 */
function attemptWrite(target: object, key: PropertyKey, value: unknown): boolean {
  return Reflect.set(target, key, value);
}

/**
 * COMPILE-TIME guard, evaluated against the production type rather than
 * against any fixture in this file. `Exclude<'apiVersion', keyof
 * MotorStaticFactsInput>` is `'apiVersion'` only while the input type
 * has no such key; the day one is added it collapses to `never`, and the
 * initializer below stops compiling. The runtime `expect` merely keeps
 * the binding live so it cannot be dropped as unused.
 */
const EXCLUDED_INPUT_KEY: Exclude<'apiVersion', keyof MotorStaticFactsInput> = 'apiVersion';

const TOP_LEVEL_KEYS = [
  'flightControllerIdentity',
  'mixerModeRaw',
  'yawMotorsReversedConfigured',
  'motorCount',
  'motorPoleCount',
  'motorProtocolRaw',
  'motorIdleRaw',
  'feature3dEnabled',
  'dshotTelemetryRaw',
];

describe('assembleMotorStaticFacts', () => {
  it('copies every field from the decoded response that owns it', () => {
    const facts = assembleMotorStaticFacts(makeInput());

    expect(facts.mixerModeRaw).toBe(26);
    expect(facts.yawMotorsReversedConfigured).toBe(true);
    expect(facts.motorCount).toBe(4);
    expect(facts.motorPoleCount).toBe(14);
    expect(facts.motorProtocolRaw).toBe(7);
    expect(facts.motorIdleRaw).toBe(550);
    expect(facts.feature3dEnabled).toBe(true);
    expect(facts.dshotTelemetryRaw).toBe(1);
    expect(facts.flightControllerIdentity.apiVersion).toEqual(makeApiVersion());
    expect(facts.flightControllerIdentity.firmware).toEqual(makeFirmware());
    expect(facts.flightControllerIdentity.board.boardName).toBe('TESTBOARD');
  });

  it('enforces the EXACT top-level key set - an allowlist, not a denylist', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    expect(Object.keys(facts).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  });

  it('enforces the EXACT nested key sets', () => {
    const identity = assembleMotorStaticFacts(makeInput()).flightControllerIdentity;

    expect(Object.keys(identity).sort()).toEqual(['apiVersion', 'board', 'firmware']);
    expect(Object.keys(identity.apiVersion).sort()).toEqual([
      'apiVersionMajor',
      'apiVersionMinor',
      'mspProtocolVersion',
    ]);
    expect(Object.keys(identity.firmware).sort()).toEqual(['identifier', 'knownFamily']);
    expect(Object.keys(identity.board).sort()).toEqual(
      [
        'boardIdentifier',
        'hardwareRevision',
        'boardType',
        'targetCapabilities',
        'targetName',
        'boardName',
        'manufacturerId',
        'signature',
        'mcuTypeId',
        'configurationState',
        'gyroSampleRateHz',
        'configurationProblems',
        'spiRegisteredDeviceCount',
        'i2cRegisteredDeviceCount',
        'trailingBytes',
      ].sort(),
    );
  });

  it('keeps an absent optional board field ABSENT, never an own key holding undefined', () => {
    const identity = makeIdentity();
    const board = makeBoardWithoutOptionals();
    const facts = assembleMotorStaticFacts(
      makeInput({flightControllerIdentity: {...identity, board}}),
    );
    const keys = Object.keys(facts.flightControllerIdentity.board);

    expect(keys).not.toContain('configurationState');
    expect(keys).not.toContain('gyroSampleRateHz');
    expect(keys).not.toContain('configurationProblems');
    expect(keys).not.toContain('spiRegisteredDeviceCount');
    expect(keys).not.toContain('i2cRegisteredDeviceCount');
    expect(keys.sort()).toEqual(
      [
        'boardIdentifier',
        'hardwareRevision',
        'boardType',
        'targetCapabilities',
        'targetName',
        'boardName',
        'manufacturerId',
        'signature',
        'mcuTypeId',
        'trailingBytes',
      ].sort(),
    );
  });

  it('handles a PARTIAL optional board set - present ones kept, absent ones still absent', () => {
    // decodeBoardInfo reads MspBoardInfo's five optional fields in order
    // and stops as soon as the payload runs out (its optionalFields loop
    // breaks on insufficient bytes), so a real firmware genuinely
    // produces a prefix of them. Here: the first two present, the last
    // three absent. Optional names taken from MspBoardInfo itself.
    const board: MspBoardInfo = {
      ...makeBoardWithoutOptionals(),
      configurationState: 2,
      gyroSampleRateHz: 8000,
    };
    expect(Object.keys(board)).toContain('configurationState');
    expect(Object.keys(board)).not.toContain('configurationProblems');

    const snapshot = assembleMotorStaticFacts(
      makeInput({flightControllerIdentity: {...makeIdentity(), board}}),
    ).flightControllerIdentity.board;

    // Present optionals survive as own properties with unchanged values.
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'configurationState')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'gyroSampleRateHz')).toBe(true);
    expect(snapshot.configurationState).toBe(2);
    expect(snapshot.gyroSampleRateHz).toBe(8000);

    // Absent optionals do NOT become own keys holding undefined.
    for (const absent of [
      'configurationProblems',
      'spiRegisteredDeviceCount',
      'i2cRegisteredDeviceCount',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(snapshot, absent)).toBe(false);
    }

    // Exact own-key set for this partial variant: 9 required + the two
    // present optionals + trailingBytes.
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'boardIdentifier',
        'hardwareRevision',
        'boardType',
        'targetCapabilities',
        'targetName',
        'boardName',
        'manufacturerId',
        'signature',
        'mcuTypeId',
        'configurationState',
        'gyroSampleRateHz',
        'trailingBytes',
      ].sort(),
    );

    // The mutable byte fields are still copied and frozen on this path.
    expect(snapshot.signature).not.toBe(board.signature);
    expect(snapshot.signature).toEqual([1, 2, 3, 250, 0, 255]);
    expect(Object.isFrozen(snapshot.signature)).toBe(true);
    expect(Object.isFrozen(snapshot.trailingBytes)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('exposes exactly ONE API-version path and no second copy that could diverge', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    const asRecord: Record<string, unknown> = {...facts};

    expect(Object.keys(asRecord)).not.toContain('apiVersion');
    expect(facts.flightControllerIdentity.apiVersion.apiVersionMajor).toBe(1);
    expect(facts.flightControllerIdentity.apiVersion.apiVersionMinor).toBe(47);
    // The assembly input carries no independent API-version member
    // either, so nothing exists that could disagree in the first place.
    // Anchored to the PRODUCTION type via `keyof MotorStaticFactsInput`,
    // not to this file's fixture factory: Exclude<> yields `never` the
    // moment 'apiVersion' becomes a top-level input key, and `never` has
    // no assignable value, so re-adding it breaks compilation here.
    expect(EXCLUDED_INPUT_KEY).toBe('apiVersion');
  });

  it('preserves dshotTelemetryRaw under the firmware field name, unreinterpreted', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    expect(facts.dshotTelemetryRaw).toBe(input.motorConfig.dshotTelemetryRaw);
    // Not renamed into a different technical concept.
    expect(Object.keys(facts)).not.toContain('bidirectionalDshotRaw');
    expect(Object.keys(facts)).not.toContain('bidirectionalDshot');
    // A raw 0 stays a raw 0: "off" and "not compiled in" are not resolved.
    const zero = assembleMotorStaticFacts(
      makeInput({motorConfig: {...input.motorConfig, dshotTelemetryRaw: 0}}),
    );
    expect(zero.dshotTelemetryRaw).toBe(0);
  });

  it('carries yawMotorsReversedConfigured as an FC CONFIGURATION fact only', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    expect(facts.yawMotorsReversedConfigured).toBe(input.mixerConfig.yawMotorsReversedConfigured);
    expect(
      assembleMotorStaticFacts(
        makeInput({
          mixerConfig: {
            mixerModeRaw: 3,
            yawMotorsReversedConfigured: false,
            yawMotorsReversedRaw: 0,
          },
        }),
      ).yawMotorsReversedConfigured,
    ).toBe(false);
    // No physical-direction, props-out or mechanical-condition claim
    // accompanies it anywhere in the facts.
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/propsOut|propsIn|spinDirection|rotation|clockwise|mechanical/i);
    }
  });

  it('drops the old ambiguous public names entirely - no deprecated aliases', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const removed of ['identity', 'apiVersion', 'yawMotorsReversed', 'bidirectionalDshotRaw']) {
      expect(Object.keys(facts)).not.toContain(removed);
    }
  });

  it('takes motor count ONLY from MSP_MOTOR_CONFIG', () => {
    // There is no MSP_MOTOR input to this function at all, so a count can
    // never be back-derived from live output values.
    const input = makeInput();
    expect(Object.keys(input)).not.toContain('motorOutputs');
    expect(
      assembleMotorStaticFacts({
        ...input,
        motorConfig: {...input.motorConfig, motorCount: 6},
      }).motorCount,
    ).toBe(6);
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
    const base = makeInput();

    // PROPERTY-BASED, not fixture-value-based: for every raw idle across
    // the firmware's range, the assembled value must be that same number,
    // unchanged. A transform into an 1000..2000 external pulse - or any
    // other rescaling - would break the identity for at least one input.
    for (const motorIdleRaw of [0, 1, 300, 550, 700, 1000, 2000, 65535]) {
      const facts = assembleMotorStaticFacts({
        ...base,
        advancedConfig: {...base.advancedConfig, motorIdleRaw},
      });
      expect(facts.motorIdleRaw).toBe(motorIdleRaw);
    }

    // Structural proof that nothing pulse-shaped exists at all is the
    // exhaustive nine-key allowlist (asserted in its own test); this
    // name check is only a redundant guard against a future addition.
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(base)};
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/pulse|throttle|command|spin|test/i);
    }
    expect(Object.keys(facts).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  });

  it('computes no compatibility verdict', () => {
    const facts: Record<string, unknown> = {...assembleMotorStaticFacts(makeInput())};
    for (const key of Object.keys(facts)) {
      expect(key).not.toMatch(/supported|compatible|allowed|safe|ready|verdict|ok/i);
    }
    const booleanKeys = Object.keys(facts).filter(key => typeof facts[key] === 'boolean');
    expect(booleanKeys.sort()).toEqual(['feature3dEnabled', 'yawMotorsReversedConfigured']);
  });
});

describe('static/dynamic separation', () => {
  it('holds no dynamic flight-controller state', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    // The exact-allowlist assertion above is the primary guarantee; this
    // denylist stays as defence in depth against a specific set of
    // safety-relevant names.
    for (const name of [
      'armed',
      'armingDisabledFlags',
      'armingDisableFlags',
      'batteryState',
      'batteryVoltage',
      'motorOutputs',
      'motorValues',
      'values',
      'rebootRequired',
      'rpm',
      'escTemperature',
      'temperature',
    ]) {
      expect(Object.keys(facts)).not.toContain(name);
    }
    expect(Object.keys(facts).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  });

  it('holds no session identity - that is composed separately', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    for (const name of [
      'sessionIdentity',
      'sessionId',
      'sessionKey',
      'generation',
      'physicalGeneration',
      'epoch',
      'mspEpoch',
    ]) {
      expect(Object.keys(facts)).not.toContain(name);
      expect(Object.keys(facts.flightControllerIdentity)).not.toContain(name);
    }
  });

  it('holds no user-provided hardware facts - none of these is MSP-discoverable', () => {
    const facts = assembleMotorStaticFacts(makeInput());
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
});

describe('runtime immutability - defensive snapshot, not a shallow freeze', () => {
  it('freezes the top-level facts object and every nested object', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    const identity = facts.flightControllerIdentity;

    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.apiVersion)).toBe(true);
    expect(Object.isFrozen(identity.firmware)).toBe(true);
    expect(Object.isFrozen(identity.board)).toBe(true);
    expect(Object.isFrozen(identity.board.signature)).toBe(true);
    expect(Object.isFrozen(identity.board.trailingBytes)).toBe(true);
  });

  it('shares NO nested reference with the caller-supplied input', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);
    const source = input.flightControllerIdentity;
    const snapshot = facts.flightControllerIdentity;

    expect(snapshot).not.toBe(source);
    expect(snapshot.apiVersion).not.toBe(source.apiVersion);
    expect(snapshot.firmware).not.toBe(source.firmware);
    expect(snapshot.board).not.toBe(source.board);
    // The typed array is not merely copied, it is replaced by a frozen
    // plain array - a Uint8Array cannot be frozen while it has elements.
    expect(snapshot.board.signature).not.toBe(source.board.signature);
    expect(Array.isArray(snapshot.board.signature)).toBe(true);
    expect(ArrayBuffer.isView(snapshot.board.signature)).toBe(false);
  });

  it('preserves every signature byte and its order exactly', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    expect(facts.flightControllerIdentity.board.signature).toEqual([1, 2, 3, 250, 0, 255]);
    expect(facts.flightControllerIdentity.board.signature).toHaveLength(
      input.flightControllerIdentity.board.signature.length,
    );
    expect(facts.flightControllerIdentity.board.trailingBytes).toEqual([9, 8, 7]);
  });

  it('is unaffected by mutating the ORIGINAL api-version object afterwards', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    input.flightControllerIdentity.apiVersion.apiVersionMinor = 99;
    input.flightControllerIdentity.apiVersion.apiVersionMajor = 9;

    expect(facts.flightControllerIdentity.apiVersion.apiVersionMinor).toBe(47);
    expect(facts.flightControllerIdentity.apiVersion.apiVersionMajor).toBe(1);
  });

  it('is unaffected by mutating the ORIGINAL firmware object afterwards', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    input.flightControllerIdentity.firmware.identifier = 'INAV';
    input.flightControllerIdentity.firmware.knownFamily = 'INAV';

    expect(facts.flightControllerIdentity.firmware.identifier).toBe('BTFL');
    expect(facts.flightControllerIdentity.firmware.knownFamily).toBe('BETAFLIGHT');
  });

  it('is unaffected by mutating the ORIGINAL board object afterwards', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    input.flightControllerIdentity.board.boardName = 'REWRITTEN';
    input.flightControllerIdentity.board.mcuTypeId = 42;
    input.flightControllerIdentity.board.configurationState = 7;

    expect(facts.flightControllerIdentity.board.boardName).toBe('TESTBOARD');
    expect(facts.flightControllerIdentity.board.mcuTypeId).toBe(1);
    expect(facts.flightControllerIdentity.board.configurationState).toBe(2);
  });

  it('is unaffected by mutating the ORIGINAL board-signature typed array afterwards', () => {
    const input = makeInput();
    const facts = assembleMotorStaticFacts(input);

    input.flightControllerIdentity.board.signature[0] = 0xff;
    input.flightControllerIdentity.board.signature[4] = 0xff;
    input.flightControllerIdentity.board.trailingBytes[0] = 0xff;

    expect(facts.flightControllerIdentity.board.signature).toEqual([1, 2, 3, 250, 0, 255]);
    expect(facts.flightControllerIdentity.board.trailingBytes).toEqual([9, 8, 7]);
  });

  it('is unaffected by replacing a whole input sub-object afterwards', () => {
    const input = makeInput();
    const mutable = input as {motorConfig: MotorStaticFactsInput['motorConfig']};
    const facts = assembleMotorStaticFacts(input);
    mutable.motorConfig = {...input.motorConfig, motorCount: 8};
    expect(facts.motorCount).toBe(4);
  });

  it('rejects every write attempted THROUGH the returned objects and arrays', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    const identity = facts.flightControllerIdentity;

    expect(attemptWrite(facts, 'motorCount', 8)).toBe(false);
    expect(attemptWrite(identity, 'firmware', null)).toBe(false);
    expect(attemptWrite(identity.apiVersion, 'apiVersionMinor', 99)).toBe(false);
    expect(attemptWrite(identity.firmware, 'identifier', 'INAV')).toBe(false);
    expect(attemptWrite(identity.board, 'boardName', 'REWRITTEN')).toBe(false);
    expect(attemptWrite(identity.board.signature, 0, 0xff)).toBe(false);
    expect(attemptWrite(identity.board.trailingBytes, 0, 0xff)).toBe(false);

    expect(facts.motorCount).toBe(4);
    expect(identity.apiVersion.apiVersionMinor).toBe(47);
    expect(identity.firmware.identifier).toBe('BTFL');
    expect(identity.board.boardName).toBe('TESTBOARD');
    expect(identity.board.signature[0]).toBe(1);
    expect(identity.board.trailingBytes[0]).toBe(9);
  });

  it('produces independent objects for independent calls', () => {
    const a = assembleMotorStaticFacts(makeInput());
    const b = assembleMotorStaticFacts(makeInput());
    expect(a).not.toBe(b);
    expect(a.flightControllerIdentity).not.toBe(b.flightControllerIdentity);
    expect(a).toEqual(b);
  });
});

describe('bindMotorStaticFacts', () => {
  const makeSessionIdentity = (): MotorStaticFactsSessionIdentity => ({
    physicalGeneration: 3,
    mspEpoch: 11,
  });

  it('composes session identity ALONGSIDE the facts, never inside them', () => {
    const facts: MotorStaticFacts = assembleMotorStaticFacts(makeInput());
    const bound = bindMotorStaticFacts(makeSessionIdentity(), facts);

    expect(bound.sessionIdentity).toEqual({physicalGeneration: 3, mspEpoch: 11});
    expect(bound.facts).toBe(facts);
    expect(Object.keys(bound.facts)).not.toContain('sessionIdentity');
    expect(Object.keys(bound.facts)).not.toContain('physicalGeneration');
    expect(Object.keys(bound.facts)).not.toContain('mspEpoch');
  });

  it('exposes EXACTLY the two documented binding keys, and two session keys', () => {
    const bound = bindMotorStaticFacts(
      makeSessionIdentity(),
      assembleMotorStaticFacts(makeInput()),
    );
    expect(Object.keys(bound).sort()).toEqual(['facts', 'sessionIdentity']);
    expect(Object.keys(bound.sessionIdentity).sort()).toEqual(['mspEpoch', 'physicalGeneration']);
  });

  it('freezes the binding and the session identity, and rejects writes through them', () => {
    const bound = bindMotorStaticFacts(
      makeSessionIdentity(),
      assembleMotorStaticFacts(makeInput()),
    );

    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.sessionIdentity)).toBe(true);
    expect(attemptWrite(bound, 'sessionIdentity', null)).toBe(false);
    expect(attemptWrite(bound.sessionIdentity, 'physicalGeneration', 99)).toBe(false);
    expect(bound.sessionIdentity.physicalGeneration).toBe(3);
  });

  it('is unaffected by mutating the caller-owned session identity afterwards', () => {
    const sessionIdentity = {physicalGeneration: 3, mspEpoch: 11};
    const bound = bindMotorStaticFacts(sessionIdentity, assembleMotorStaticFacts(makeInput()));

    sessionIdentity.physicalGeneration = 99;
    sessionIdentity.mspEpoch = 99;

    expect(bound.sessionIdentity).not.toBe(sessionIdentity);
    expect(bound.sessionIdentity.physicalGeneration).toBe(3);
    expect(bound.sessionIdentity.mspEpoch).toBe(11);
  });

  it('projects ONLY the two session fields, discarding extra properties actually supplied', () => {
    // A WIDENED object really carrying extra own properties. Declared
    // through its own interface and passed as a variable, so TypeScript's
    // excess-property check (which only fires on fresh object literals)
    // does not apply and the extras genuinely reach the function at
    // runtime - no `any`, no cast, no suppression. This is what makes the
    // test prove RUNTIME projection rather than compile-time filtering.
    interface WidenedSessionIdentity extends MotorStaticFactsSessionIdentity {
      sessionId: string;
      operatorNote: string;
    }
    const widened: WidenedSessionIdentity = {
      physicalGeneration: 3,
      mspEpoch: 11,
      sessionId: 'usb-device-0',
      operatorNote: 'must not survive projection',
    };
    expect(Object.keys(widened).sort()).toEqual([
      'mspEpoch',
      'operatorNote',
      'physicalGeneration',
      'sessionId',
    ]);

    const bound = bindMotorStaticFacts(widened, assembleMotorStaticFacts(makeInput()));

    // Exactly the two approved keys survive; the extras are gone.
    expect(Object.keys(bound.sessionIdentity).sort()).toEqual(['mspEpoch', 'physicalGeneration']);
    expect(Object.keys(bound.sessionIdentity)).not.toContain('sessionId');
    expect(Object.keys(bound.sessionIdentity)).not.toContain('operatorNote');
    expect(bound.sessionIdentity).toEqual({physicalGeneration: 3, mspEpoch: 11});

    // A new object, not the supplied one - had it been stored or spread
    // by reference, the extras above would still be present.
    expect(bound.sessionIdentity).not.toBe(widened);

    // Freeze and caller-mutation guarantees hold for the widened path too.
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.sessionIdentity)).toBe(true);
    widened.sessionId = 'usb-device-1';
    widened.operatorNote = 'rewritten';
    expect(Object.keys(bound.sessionIdentity).sort()).toEqual(['mspEpoch', 'physicalGeneration']);
    expect(attemptWrite(bound.sessionIdentity, 'mspEpoch', 99)).toBe(false);
    expect(bound.sessionIdentity.mspEpoch).toBe(11);
  });

  it('does not accept a bare number as session identity (compile-time)', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    // @ts-expect-error - a number is not a composite session identity; the
    // binding must not accept an opaque token nobody can interpret.
    bindMotorStaticFacts(42, facts);
    // The same guard applies to a partial identity.
    // @ts-expect-error - mspEpoch is required.
    bindMotorStaticFacts({physicalGeneration: 1}, facts);
  });

  it('lets the same facts be bound to two different sessions without aliasing', () => {
    const facts = assembleMotorStaticFacts(makeInput());
    const first = bindMotorStaticFacts({physicalGeneration: 1, mspEpoch: 1}, facts);
    const second = bindMotorStaticFacts({physicalGeneration: 2, mspEpoch: 5}, facts);

    expect(first.sessionIdentity).toEqual({physicalGeneration: 1, mspEpoch: 1});
    expect(second.sessionIdentity).toEqual({physicalGeneration: 2, mspEpoch: 5});
    expect(first.sessionIdentity).not.toBe(second.sessionIdentity);
    expect(first.facts).toBe(second.facts);
  });
});
