/**
 * Pass 7.7, Region 5 - the pure authorization gate.
 */

import {FC_TOOL_IDS, resolveAllFcToolAvailability, resolveFcToolAvailability} from './fcTools';
import type {FcToolGateInput, FcToolId} from './fcTools';
import type {SensorPresenceBit} from './armingBlockers';

const WITH_MAG: readonly SensorPresenceBit[] = [
  {kind: 'KNOWN', bit: 0, token: 'ACC'},
  {kind: 'KNOWN', bit: 2, token: 'MAG'},
  {kind: 'KNOWN', bit: 5, token: 'GYRO'},
];
const WITHOUT_MAG: readonly SensorPresenceBit[] = [
  {kind: 'KNOWN', bit: 0, token: 'ACC'},
  {kind: 'KNOWN', bit: 5, token: 'GYRO'},
];

function input(overrides: Partial<FcToolGateInput> = {}): FcToolGateInput {
  return {
    connected: true,
    appActive: true,
    busy: false,
    recovering: false,
    compatibility: 'BETAFLIGHT_API_1_47',
    dataState: 'FRESH',
    readingMalformed: false,
    armedState: 'DISARMED',
    sensors: WITH_MAG,
    ...overrides,
  };
}

describe('resolveFcToolAvailability - only the three proven tools exist', () => {
  it('offers exactly accelerometer calibration, magnetometer calibration and normal reboot', () => {
    expect(FC_TOOL_IDS).toEqual(['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']);
  });

  it('enables all three under the fully-satisfied preconditions', () => {
    const all = resolveAllFcToolAvailability(input());
    expect(all.map(a => a.enabled)).toEqual([true, true, true]);
    expect(all.every(a => a.reason === undefined)).toBe(true);
  });
});

describe('resolveFcToolAvailability - every disabled state names its exact reason', () => {
  const cases: Array<[Partial<FcToolGateInput>, string]> = [
    [{connected: false}, 'DISCONNECTED'],
    [{appActive: false}, 'BACKGROUNDED'],
    [{busy: true}, 'BUSY'],
    [{recovering: true}, 'RECOVERING'],
    [{compatibility: 'IDENTIFYING'}, 'IDENTIFYING'],
    [{compatibility: 'IDENTIFICATION_FAILED'}, 'INCOMPATIBLE'],
    [{compatibility: 'OTHER_FIRMWARE_OR_API'}, 'INCOMPATIBLE'],
    [{dataState: 'WAITING'}, 'NO_READING'],
    [{dataState: 'UNAVAILABLE'}, 'NO_READING'],
    [{dataState: 'ERROR'}, 'NO_READING'],
    [{dataState: 'UNSUPPORTED'}, 'NO_READING'],
    [{dataState: 'DISCONNECTED'}, 'NO_READING'],
    [{dataState: 'STALE'}, 'STALE_READING'],
    [{readingMalformed: true}, 'MALFORMED_READING'],
    [{armedState: 'UNKNOWN'}, 'ARMED_UNKNOWN'],
    [{armedState: 'ARMED'}, 'ARMED'],
  ];

  it.each(cases)('%j blocks every tool with %s', (overrides, reason) => {
    for (const tool of FC_TOOL_IDS) {
      const availability = resolveFcToolAvailability(tool, input(overrides));
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toBe(reason);
    }
  });

  it('reports the MOST fundamental reason first when several apply at once', () => {
    const availability = resolveFcToolAvailability(
      'REBOOT',
      input({connected: false, appActive: false, busy: true, armedState: 'ARMED', dataState: 'STALE'}),
    );
    expect(availability.reason).toBe('DISCONNECTED');
    expect(resolveFcToolAvailability('REBOOT', input({appActive: false, busy: true})).reason).toBe('BACKGROUNDED');
    expect(resolveFcToolAvailability('REBOOT', input({busy: true, recovering: true})).reason).toBe('BUSY');
    expect(resolveFcToolAvailability('REBOOT', input({dataState: 'STALE', armedState: 'ARMED'})).reason).toBe(
      'STALE_READING',
    );
  });

  it('a malformed reading blocks every tool even when it would otherwise be fully authorized', () => {
    for (const tool of FC_TOOL_IDS) {
      const authorized = resolveFcToolAvailability(tool, input());
      expect(authorized.enabled).toBe(true);
      const malformed = resolveFcToolAvailability(tool, input({readingMalformed: true}));
      expect(malformed.enabled).toBe(false);
      expect(malformed.reason).toBe('MALFORMED_READING');
    }
  });

  it('an UNKNOWN armed state is never treated as permission - a cached DISARMED is required explicitly', () => {
    expect(resolveFcToolAvailability('ACC_CALIBRATION', input({armedState: 'UNKNOWN'})).enabled).toBe(false);
    expect(resolveFcToolAvailability('ACC_CALIBRATION', input({armedState: 'DISARMED'})).enabled).toBe(true);
  });
});

describe('resolveFcToolAvailability - the magnetometer requirement', () => {
  it('blocks ONLY magnetometer calibration when no magnetometer is reported as detected', () => {
    const availability = resolveAllFcToolAvailability(input({sensors: WITHOUT_MAG}));
    const byTool = new Map<FcToolId, (typeof availability)[number]>(availability.map(a => [a.tool, a]));
    expect(byTool.get('MAG_CALIBRATION')).toEqual({
      tool: 'MAG_CALIBRATION',
      enabled: false,
      reason: 'SENSOR_NOT_DETECTED',
    });
    expect(byTool.get('ACC_CALIBRATION')?.enabled).toBe(true);
    expect(byTool.get('REBOOT')?.enabled).toBe(true);
  });

  it('an absent sensor list is not proof of a magnetometer', () => {
    expect(resolveFcToolAvailability('MAG_CALIBRATION', input({sensors: undefined})).reason).toBe(
      'SENSOR_NOT_DETECTED',
    );
    expect(resolveFcToolAvailability('MAG_CALIBRATION', input({sensors: []})).reason).toBe('SENSOR_NOT_DETECTED');
  });

  it('an UNKNOWN sensor bit is not a magnetometer', () => {
    const unknownOnly: readonly SensorPresenceBit[] = [{kind: 'UNKNOWN', bit: 9, hex: '0x200'}];
    expect(resolveFcToolAvailability('MAG_CALIBRATION', input({sensors: unknownOnly})).reason).toBe(
      'SENSOR_NOT_DETECTED',
    );
  });
});
