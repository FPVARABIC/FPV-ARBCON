import {betaflightApi147Identity} from '../protocol/__testUtils__/motorFirmwareFixtures';
import {
  motorFirmwareSupports,
  resolveMotorFirmwareCompatibility,
  type MotorFirmwareCapability,
} from './motorFirmwareCompatibility';

const ALL_CAPABILITIES: readonly MotorFirmwareCapability[] = [
  'MOTOR_OUTPUTS_READ',
  'ESC_TELEMETRY_READ',
  'MOTOR_CONFIGURATION_READ',
  'MOTOR_CONFIGURATION_WRITE',
  'MOTOR_TEST_WRITE',
  'ESC_DIRECTION_WRITE',
];

describe('resolveMotorFirmwareCompatibility', () => {
  it('admits API 1.46 only for its independently reviewed bench capabilities', () => {
    const base = betaflightApi147Identity();
    const result = resolveMotorFirmwareCompatibility({
      ...base,
      apiVersion: {...base.apiVersion, apiVersionMinor: 46},
    });

    expect(result).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_46',
    });
    expect(motorFirmwareSupports(result, 'MOTOR_TEST_WRITE')).toBe(true);
    expect(motorFirmwareSupports(result, 'ESC_DIRECTION_WRITE')).toBe(true);
    expect(motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_READ')).toBe(
      true,
    );
    expect(motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_WRITE')).toBe(
      false,
    );
  });

  it('admits the exact reviewed Betaflight API-1.47 adapter', () => {
    const result = resolveMotorFirmwareCompatibility(
      betaflightApi147Identity(),
    );

    expect(result).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_47',
      identity: {
        firmwareIdentifier: 'BTFL',
        knownFamily: 'BETAFLIGHT',
        apiVersionMajor: 1,
        apiVersionMinor: 47,
      },
    });
    for (const capability of ALL_CAPABILITIES) {
      expect(motorFirmwareSupports(result, capability)).toBe(true);
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
  });

  it('admits API 1.48 only for the independently verified bench capabilities', () => {
    const base = betaflightApi147Identity();
    const result = resolveMotorFirmwareCompatibility({
      ...base,
      apiVersion: {...base.apiVersion, apiVersionMinor: 48},
    });

    expect(result).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_48',
    });
    expect(motorFirmwareSupports(result, 'MOTOR_TEST_WRITE')).toBe(true);
    expect(motorFirmwareSupports(result, 'ESC_DIRECTION_WRITE')).toBe(true);
    expect(motorFirmwareSupports(result, 'MOTOR_OUTPUTS_READ')).toBe(true);
    expect(motorFirmwareSupports(result, 'ESC_TELEMETRY_READ')).toBe(true);
    expect(motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_READ')).toBe(
      true,
    );
    expect(motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_WRITE')).toBe(
      false,
    );
  });

  it.each([
    ['INAV', 'INAV'],
    ['EMUF', 'EMUFLIGHT'],
    ['ZZZZ', 'UNKNOWN'],
  ] as const)('gives %s no write capability', (identifier, knownFamily) => {
    const base = betaflightApi147Identity();
    const result = resolveMotorFirmwareCompatibility({
      ...base,
      firmware: {identifier, knownFamily},
    });

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'FIRMWARE_FAMILY_UNSUPPORTED',
    });
    for (const capability of ALL_CAPABILITIES) {
      expect(motorFirmwareSupports(result, capability)).toBe(false);
    }
    expect(result.capabilities).toEqual([]);
  });

  it.each([
    [1, 45],
    [1, 49],
    [2, 0],
  ])('does not guess across MSP API %s.%s', (major, minor) => {
    const base = betaflightApi147Identity();
    const result = resolveMotorFirmwareCompatibility({
      ...base,
      apiVersion: {
        ...base.apiVersion,
        apiVersionMajor: major,
        apiVersionMinor: minor,
      },
    });

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'API_VERSION_UNVERIFIED',
    });
    expect(motorFirmwareSupports(result, 'MOTOR_TEST_WRITE')).toBe(false);
  });
});
