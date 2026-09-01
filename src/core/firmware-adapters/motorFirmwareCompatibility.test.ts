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

  /**
   * API 1.48 IS API 1.47 ON THIS PATH.
   *
   * This test used to assert the opposite - that 1.48 got everything except
   * MOTOR_CONFIGURATION_WRITE - on the strength of a comment saying "the
   * wider configuration API changed". The two firmware trees were then
   * compared directly, and all eleven motor MSP handlers are byte-for-byte
   * identical between API_VERSION_MINOR 47 and 48, as are motorProtocolTypes_e,
   * the four CLI bounds, and every feature bit this app touches. The gate had
   * nothing behind it, so it is gone and this asserts the full set.
   */
  it('admits API 1.48 for the whole reviewed set, writes included', () => {
    const base = betaflightApi147Identity();
    const result = resolveMotorFirmwareCompatibility({
      ...base,
      apiVersion: {...base.apiVersion, apiVersionMinor: 48},
    });

    expect(result).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_48',
    });
    for (const capability of ALL_CAPABILITIES) {
      expect(`1.48 ${capability}`).toBe(
        `1.48 ${capability}${motorFirmwareSupports(result, capability) ? '' : ' MISSING'}`,
      );
    }
  });

  /**
   * ABOVE THE REVIEWED RANGE: READ, NEVER WRITE.
   *
   * 1.49 previously fell through to no capabilities at all, which blocked
   * the Motors screen outright on any firmware newer than this build - a
   * refusal to READ justified by an inability to prove a WRITE. Reads are
   * now admitted and every write, including the motor-test and ESC-direction
   * writes, stays withheld because no published Betaflight source declares
   * an API above 1.48 to check them against.
   */
  it.each([49, 50, 63, 99])(
    'reads but never writes at API 1.%i',
    minor => {
      const base = betaflightApi147Identity();
      const result = resolveMotorFirmwareCompatibility({
        ...base,
        apiVersion: {...base.apiVersion, apiVersionMinor: minor},
      });

      expect(result).toMatchObject({
        status: 'SUPPORTED',
        adapterId: 'BETAFLIGHT_API_NEWER_READ_ONLY',
      });
      expect({
        read: motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_READ'),
        outputs: motorFirmwareSupports(result, 'MOTOR_OUTPUTS_READ'),
        telemetry: motorFirmwareSupports(result, 'ESC_TELEMETRY_READ'),
        configWrite: motorFirmwareSupports(result, 'MOTOR_CONFIGURATION_WRITE'),
        testWrite: motorFirmwareSupports(result, 'MOTOR_TEST_WRITE'),
        escDirection: motorFirmwareSupports(result, 'ESC_DIRECTION_WRITE'),
      }).toEqual({
        read: true,
        outputs: true,
        telemetry: true,
        configWrite: false,
        testWrite: false,
        escDirection: false,
      });
      expect(Object.isFrozen(result.capabilities)).toBe(true);
    },
  );

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

  /**
   * The asymmetry is deliberate. An API BELOW the reviewed range is a
   * contract this build no longer carries a decoder for, so it is refused
   * outright; an API ABOVE it extends the reviewed one, so it is read.
   * A different MAJOR is a different protocol and gets nothing either way.
   */
  it.each([
    [1, 45],
    [1, 0],
    [2, 0],
    [2, 48],
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
