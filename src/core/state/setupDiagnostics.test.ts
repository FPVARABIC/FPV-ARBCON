/**
 * Pass 7.7, Region 4 - the pure presentation model's truthfulness rules.
 */

import {deriveSetupDiagnostics} from './setupDiagnostics';
import type {DiagnosticsChannelState, DiagnosticsTelemetryStatus, SetupDiagnosticsInput} from './setupDiagnostics';
import type {FlightControllerIdentity, MspStatusExDiagnostics} from '../protocol';

function identity(overrides: {identifier?: string; major?: number; minor?: number} = {}): FlightControllerIdentity {
  return {
    apiVersion: {apiVersionMajor: overrides.major ?? 1, apiVersionMinor: overrides.minor ?? 47},
    firmware: {
      identifier: overrides.identifier ?? 'BTFL',
      knownFamily: (overrides.identifier ?? 'BTFL') === 'BTFL' ? 'BETAFLIGHT' : 'UNKNOWN',
    },
    board: {boardIdentifier: 'S405', boardName: 'SPEEDYBEEF405V3', manufacturerId: 'SPBE', targetName: 'STM32F405'},
  } as FlightControllerIdentity;
}

function value(overrides: Partial<MspStatusExDiagnostics> = {}): MspStatusExDiagnostics {
  return {
    cycleTimeUs: 900,
    i2cErrorCount: 0,
    sensorPresenceMask: 41,
    cpuLoadPercent: 42,
    flightModeFlagsLow32: 0,
    readiness: {armingDisableFlags: 0, armingDisableFlagsCount: 29},
    ...overrides,
  };
}

function input(overrides: Partial<SetupDiagnosticsInput> = {}): SetupDiagnosticsInput {
  return {
    connected: true,
    channelState: 'ACTIVE',
    status: 'FRESH',
    value: value(),
    identificationStatus: 'SUCCEEDED',
    identity: identity(),
    ...overrides,
  };
}

describe('deriveSetupDiagnostics - lifecycle precedence', () => {
  const cases: Array<[string, Partial<SetupDiagnosticsInput>, string]> = [
    ['not connected', {connected: false}, 'DISCONNECTED'],
    ['channel unsupported', {channelState: 'UNSUPPORTED'}, 'UNSUPPORTED'],
    ['channel decode-failed', {channelState: 'DECODE_FAILED'}, 'ERROR'],
    ['channel disabled by the breaker', {channelState: 'DISABLED'}, 'ERROR'],
    ['value unavailable', {status: 'UNAVAILABLE', value: undefined}, 'UNAVAILABLE'],
    ['value waiting', {status: 'WAITING', value: undefined}, 'WAITING'],
    ['value error', {status: 'ERROR', value: undefined}, 'ERROR'],
    ['value stale', {status: 'STALE'}, 'STALE'],
    ['value fresh', {}, 'FRESH'],
  ];

  it.each(cases)('%s -> %s', (_name, overrides, expected) => {
    expect(deriveSetupDiagnostics(input(overrides)).dataState).toBe(expected);
  });

  it('disconnection beats every other signal, in that exact order', () => {
    const view = deriveSetupDiagnostics(input({connected: false, channelState: 'UNSUPPORTED', status: 'ERROR'}));
    expect(view.dataState).toBe('DISCONNECTED');
  });

  it('FRESH/STALE without a value degrade to UNAVAILABLE instead of inventing one', () => {
    expect(deriveSetupDiagnostics(input({status: 'FRESH', value: undefined})).dataState).toBe('UNAVAILABLE');
    expect(deriveSetupDiagnostics(input({status: 'STALE', value: undefined})).dataState).toBe('UNAVAILABLE');
  });
});

describe('deriveSetupDiagnostics - identity and compatibility', () => {
  it('reports exactly BTFL + API 1.47 as the compatible pair', () => {
    const view = deriveSetupDiagnostics(input());
    expect(view.compatibility).toBe('BETAFLIGHT_API_1_47');
    expect(view.identity).toEqual({
      boardName: 'SPEEDYBEEF405V3',
      firmwareIdentifier: 'BTFL',
      family: 'BETAFLIGHT',
      apiVersionMajor: 1,
      apiVersionMinor: 47,
    });
  });

  it('any other firmware or API version is NOT the compatible pair', () => {
    expect(deriveSetupDiagnostics(input({identity: identity({minor: 46})})).compatibility).toBe('OTHER_FIRMWARE_OR_API');
    expect(deriveSetupDiagnostics(input({identity: identity({minor: 48})})).compatibility).toBe('OTHER_FIRMWARE_OR_API');
    expect(deriveSetupDiagnostics(input({identity: identity({major: 2})})).compatibility).toBe('OTHER_FIRMWARE_OR_API');
    expect(deriveSetupDiagnostics(input({identity: identity({identifier: 'INAV'})})).compatibility).toBe(
      'OTHER_FIRMWARE_OR_API',
    );
  });

  it('unsettled and failed identification are distinct, and neither invents an identity', () => {
    for (const status of ['IDLE', 'RUNNING'] as const) {
      const view = deriveSetupDiagnostics(input({identificationStatus: status, identity: undefined}));
      expect(view.compatibility).toBe('IDENTIFYING');
      expect(view.identity).toBeUndefined();
    }
    const failed = deriveSetupDiagnostics(input({identificationStatus: 'FAILED', identity: undefined}));
    expect(failed.compatibility).toBe('IDENTIFICATION_FAILED');
    expect(failed.identity).toBeUndefined();
  });

  it('a dead telemetry channel does not suppress identity or compatibility', () => {
    const view = deriveSetupDiagnostics(input({channelState: 'DISABLED'}));
    expect(view.dataState).toBe('ERROR');
    expect(view.compatibility).toBe('BETAFLIGHT_API_1_47');
    expect(view.identity?.boardName).toBe('SPEEDYBEEF405V3');
  });

  it('a failed identification does not suppress live telemetry-derived fields', () => {
    const view = deriveSetupDiagnostics(input({identificationStatus: 'FAILED', identity: undefined}));
    expect(view.dataState).toBe('FRESH');
    expect(view.sensors.kind).toBe('REPORTED');
  });
});

describe('deriveSetupDiagnostics - sensor semantics', () => {
  it('reports detected sensors from a FRESH mask, preserving unknown bits', () => {
    const view = deriveSetupDiagnostics(input({value: value({sensorPresenceMask: 41 + Math.pow(2, 9)})}));
    expect(view.sensors).toEqual({
      kind: 'REPORTED',
      bits: [
        {kind: 'KNOWN', bit: 0, token: 'ACC'},
        {kind: 'KNOWN', bit: 3, token: 'GPS'},
        {kind: 'KNOWN', bit: 5, token: 'GYRO'},
        {kind: 'UNKNOWN', bit: 9, hex: '0x200'},
      ],
    });
  });

  it('a STALE mask still proves what the FC DETECTED, so sensors stay reported', () => {
    const view = deriveSetupDiagnostics(input({status: 'STALE'}));
    expect(view.dataState).toBe('STALE');
    expect(view.sensors.kind).toBe('REPORTED');
  });

  it('an EMPTY mask is reported as such - never an FC-health conclusion', () => {
    const view = deriveSetupDiagnostics(input({value: value({sensorPresenceMask: 0})}));
    expect(view.sensors).toEqual({kind: 'REPORTED', bits: []});
  });

  it('sensors are UNCONFIRMED whenever there is no reading at all', () => {
    for (const overrides of [
      {connected: false},
      {channelState: 'UNSUPPORTED' as DiagnosticsChannelState},
      {status: 'WAITING' as DiagnosticsTelemetryStatus, value: undefined},
      {status: 'ERROR' as DiagnosticsTelemetryStatus, value: undefined},
      {status: 'UNAVAILABLE' as DiagnosticsTelemetryStatus, value: undefined},
    ]) {
      expect(deriveSetupDiagnostics(input(overrides)).sensors).toEqual({kind: 'UNCONFIRMED'});
    }
  });
});

describe('deriveSetupDiagnostics - blocker semantics', () => {
  it('a FRESH zero mask says only "none in this reading"', () => {
    expect(deriveSetupDiagnostics(input()).blockers).toEqual({kind: 'NONE_IN_THIS_READING'});
  });

  it('reports every set blocker bit, known and unknown, in ascending order', () => {
    const mask = Math.pow(2, 7) + Math.pow(2, 23) + Math.pow(2, 30);
    const view = deriveSetupDiagnostics(input({value: value({readiness: {armingDisableFlags: mask}})}));
    expect(view.blockers).toEqual({
      kind: 'REPORTED',
      bits: [
        {kind: 'KNOWN', bit: 7, token: 'THROTTLE'},
        {kind: 'KNOWN', bit: 23, token: 'ACC_CALIBRATION'},
        {kind: 'UNKNOWN', bit: 30, hex: '0x40000000'},
      ],
    });
  });

  it('a valid SHORT payload that never carried the field is UNCONFIRMED, not "no blockers"', () => {
    const view = deriveSetupDiagnostics(input({value: value({readiness: {pidProfileCount: 3}})}));
    expect(view.dataState).toBe('FRESH');
    expect(view.blockers).toEqual({kind: 'UNCONFIRMED'});
  });

  it('a STALE reading can NEVER confirm blockers, even when the mask is present and zero', () => {
    const view = deriveSetupDiagnostics(input({status: 'STALE'}));
    expect(view.blockers).toEqual({kind: 'UNCONFIRMED'});
  });

  it('a STALE reading that DID list blockers still reports them as unconfirmable', () => {
    const view = deriveSetupDiagnostics(
      input({status: 'STALE', value: value({readiness: {armingDisableFlags: Math.pow(2, 7)}})}),
    );
    expect(view.blockers).toEqual({kind: 'UNCONFIRMED'});
  });

  it('every no-data lifecycle state is UNCONFIRMED - absence is never "no problems"', () => {
    for (const overrides of [
      {connected: false},
      {channelState: 'UNSUPPORTED' as DiagnosticsChannelState},
      {channelState: 'DECODE_FAILED' as DiagnosticsChannelState},
      {channelState: 'DISABLED' as DiagnosticsChannelState},
      {status: 'WAITING' as DiagnosticsTelemetryStatus, value: undefined},
      {status: 'ERROR' as DiagnosticsTelemetryStatus, value: undefined},
      {status: 'UNAVAILABLE' as DiagnosticsTelemetryStatus, value: undefined},
    ]) {
      expect(deriveSetupDiagnostics(input(overrides)).blockers).toEqual({kind: 'UNCONFIRMED'});
    }
  });

  it('preserves an unsigned bit-31 blocker instead of truncating it', () => {
    const view = deriveSetupDiagnostics(input({value: value({readiness: {armingDisableFlags: 2147483648}})}));
    expect(view.blockers).toEqual({kind: 'REPORTED', bits: [{kind: 'UNKNOWN', bit: 31, hex: '0x80000000'}]});
  });
});

describe('deriveSetupDiagnostics - generation replacement', () => {
  it('a replaced generation re-derives from its OWN reading; nothing survives from the old one', () => {
    const oldGeneration = deriveSetupDiagnostics(
      input({value: value({sensorPresenceMask: 41, readiness: {armingDisableFlags: Math.pow(2, 7)}})}),
    );
    expect(oldGeneration.blockers.kind).toBe('REPORTED');

    // Teardown: the coordinator drops the scheduler, so every hook reads
    // UNAVAILABLE and identification restarts.
    const duringReplacement = deriveSetupDiagnostics(
      input({status: 'UNAVAILABLE', value: undefined, identificationStatus: 'RUNNING', identity: undefined}),
    );
    expect(duringReplacement.dataState).toBe('UNAVAILABLE');
    expect(duringReplacement.sensors).toEqual({kind: 'UNCONFIRMED'});
    expect(duringReplacement.blockers).toEqual({kind: 'UNCONFIRMED'});
    expect(duringReplacement.identity).toBeUndefined();

    // The new generation's own first reading stands alone.
    const newGeneration = deriveSetupDiagnostics(
      input({value: value({sensorPresenceMask: 32, readiness: {armingDisableFlags: 0}})}),
    );
    expect(newGeneration.sensors).toEqual({kind: 'REPORTED', bits: [{kind: 'KNOWN', bit: 5, token: 'GYRO'}]});
    expect(newGeneration.blockers).toEqual({kind: 'NONE_IN_THIS_READING'});
  });

  it('is a pure function of its input - the same input yields an equal view, with no shared mutable state', () => {
    const first = deriveSetupDiagnostics(input());
    const second = deriveSetupDiagnostics(input());
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
