/**
 * SETUP P1 - the canonical safety model, exhaustively.
 *
 * These are the tests that would have caught the shipping defect: the
 * readiness derivation is fed the SAME two facts the screen actually has
 * (a canonical ArmedState and a STATUS_EX blocker verdict), so a
 * regression to any "read a poll nobody registers" shape cannot type-check
 * here, let alone pass.
 */

import {
  describeArmingBlockers,
  deriveSetupArmingReadiness,
  deriveSetupRebootRequired,
  deriveSetupSafetyFlags,
  deriveSetupSensorSummary,
  deriveSetupWarnings,
  SETUP_SENSOR_TOKENS,
  SETUP_SENSOR_TOKENS_MATCH_DECODER,
} from './setupSafetyModel';
import type {SetupWarningInput} from './setupSafetyModel';
import {
  ARMING_DISABLE_FLAG_TOKENS,
  decodeArmingBlockers,
  decodeSensorPresence,
} from './armingBlockers';
import type {DiagnosticsBlockers, DiagnosticsSensors} from './setupDiagnostics';

/** A REPORTED blocker verdict built from a real mask, exactly the way
 * deriveSetupDiagnostics builds one. */
const reported = (mask: number): DiagnosticsBlockers =>
  ({kind: 'REPORTED', bits: decodeArmingBlockers(mask)}) as const;
const NONE: DiagnosticsBlockers = {kind: 'NONE_IN_THIS_READING'};
const UNCONFIRMED: DiagnosticsBlockers = {kind: 'UNCONFIRMED'};
const MALFORMED: DiagnosticsBlockers = {kind: 'MALFORMED'};

/* Arithmetic throughout - disjoint bits mean a SUM is the mask, so no
 * bitwise operator is needed to compose one (armingBlockers.ts states the
 * same rule for the same signed-32-bit reason). */
const bit = (index: number) => Math.pow(2, index);
const RX_FAILSAFE = bit(ARMING_DISABLE_FLAG_TOKENS.indexOf('RX_FAILSAFE'));
const FAILSAFE = bit(ARMING_DISABLE_FLAG_TOKENS.indexOf('FAILSAFE'));
const BOXFAILSAFE = bit(ARMING_DISABLE_FLAG_TOKENS.indexOf('BOXFAILSAFE'));
const THROTTLE = bit(ARMING_DISABLE_FLAG_TOKENS.indexOf('THROTTLE'));
const ANGLE = bit(ARMING_DISABLE_FLAG_TOKENS.indexOf('ANGLE'));
/** Bit 30 has no token at the pinned authority (COUNT = 29). */
const UNKNOWN_BIT = bit(30);

describe('deriveSetupArmingReadiness', () => {
  it('ARMED wins over every blocker verdict, including absent evidence', () => {
    for (const blockers of [NONE, UNCONFIRMED, MALFORMED, reported(THROTTLE)]) {
      expect(deriveSetupArmingReadiness('ARMED', blockers)).toEqual({
        status: 'ARMED',
      });
    }
  });

  it('an ARMED aircraft is never presented as READY', () => {
    expect(deriveSetupArmingReadiness('ARMED', NONE).status).not.toBe('READY');
  });

  it('DISARMED + a fresh reading with no blocker bit set = READY', () => {
    expect(deriveSetupArmingReadiness('DISARMED', NONE)).toEqual({
      status: 'READY',
    });
  });

  it('DISARMED + one blocker = BLOCKED, carrying that blocker', () => {
    const result = deriveSetupArmingReadiness('DISARMED', reported(THROTTLE));
    expect(result.status).toBe('BLOCKED');
    expect(result.status === 'BLOCKED' && result.reasons.map(r => r.code)).toEqual([
      'THROTTLE',
    ]);
  });

  it('DISARMED + multiple blockers preserves every one of them', () => {
    const result = deriveSetupArmingReadiness(
      'DISARMED',
      reported(THROTTLE + ANGLE + RX_FAILSAFE),
    );
    expect(result.status).toBe('BLOCKED');
    expect(
      result.status === 'BLOCKED' && result.reasons.map(r => r.code).sort(),
    ).toEqual(['ANGLE', 'RX_FAILSAFE', 'THROTTLE']);
  });

  it('an RXLOSS blocker is BLOCKED and ranks as a critical danger', () => {
    const result = deriveSetupArmingReadiness('DISARMED', reported(RX_FAILSAFE));
    expect(result.status).toBe('BLOCKED');
    expect(result.status === 'BLOCKED' && result.reasons[0].severity).toBe(
      'CRITICAL_DANGER',
    );
  });

  it('a FAILSAFE/BOXFAILSAFE blocker is BLOCKED and critical', () => {
    for (const mask of [FAILSAFE, BOXFAILSAFE]) {
      const result = deriveSetupArmingReadiness('DISARMED', reported(mask));
      expect(result.status).toBe('BLOCKED');
      expect(result.status === 'BLOCKED' && result.reasons[0].severity).toBe(
        'CRITICAL_DANGER',
      );
    }
  });

  it('an UNKNOWN firmware bit can never produce READY', () => {
    const result = deriveSetupArmingReadiness('DISARMED', reported(UNKNOWN_BIT));
    expect(result.status).toBe('BLOCKED');
    expect(result.status === 'BLOCKED' && result.reasons[0].code).toBe('BIT_30');
    // Never softened below "you cannot arm".
    expect(result.status === 'BLOCKED' && result.reasons[0].severity).toBe(
      'ARMING_BLOCKER',
    );
  });

  it('an UNKNOWN armed state is UNKNOWN whatever the blockers say', () => {
    for (const blockers of [NONE, UNCONFIRMED, MALFORMED, reported(THROTTLE)]) {
      expect(deriveSetupArmingReadiness('UNKNOWN', blockers)).toEqual({
        status: 'UNKNOWN',
        cause: 'ARMED_UNPROVEN',
      });
    }
  });

  it('DISARMED + unconfirmed blockers is UNKNOWN, never READY', () => {
    expect(deriveSetupArmingReadiness('DISARMED', UNCONFIRMED)).toEqual({
      status: 'UNKNOWN',
      cause: 'BLOCKERS_UNCONFIRMED',
    });
  });

  it('DISARMED + a malformed readiness tail is UNKNOWN, and says so distinctly', () => {
    expect(deriveSetupArmingReadiness('DISARMED', MALFORMED)).toEqual({
      status: 'UNKNOWN',
      cause: 'BLOCKERS_MALFORMED',
    });
  });

  it('a stale "no blockers" reading is never reused to claim READY', () => {
    // deriveSetupDiagnostics only emits NONE_IN_THIS_READING for a FRESH
    // frame; anything stale arrives here as UNCONFIRMED.
    expect(deriveSetupArmingReadiness('DISARMED', UNCONFIRMED).status).toBe(
      'UNKNOWN',
    );
  });
});

describe('describeArmingBlockers', () => {
  it('emits an i18n key, never Arabic - src/core carries no operator copy', () => {
    const [reason] = describeArmingBlockers(decodeArmingBlockers(THROTTLE));
    expect(reason.messageKey).toBe('diagnostics.blockerDescriptions.THROTTLE');
    expect(reason).not.toHaveProperty('message');
  });

  it('preserves an unnameable bit numerically and in hex', () => {
    const [reason] = describeArmingBlockers(decodeArmingBlockers(UNKNOWN_BIT));
    expect(reason.code).toBe('BIT_30');
    expect(reason.messageKey).toBe('diagnostics.blockersUnknownBit');
    expect(reason.messageParams).toEqual({bit: 30, hex: '0x40000000'});
  });

  it('gives every canonical token a severity', () => {
    const all = decodeArmingBlockers(Math.pow(2, 29) - 1);
    expect(all).toHaveLength(ARMING_DISABLE_FLAG_TOKENS.length);
    for (const reason of describeArmingBlockers(all)) {
      expect(['CRITICAL_DANGER', 'ARMING_BLOCKER', 'WARNING', 'INFO']).toContain(
        reason.severity,
      );
    }
  });

  it('drops no bit', () => {
    const mask = THROTTLE + ANGLE + UNKNOWN_BIT;
    expect(describeArmingBlockers(decodeArmingBlockers(mask))).toHaveLength(3);
  });
});

describe('deriveSetupSafetyFlags', () => {
  it('RXLOSS / FAILSAFE / BOXFAILSAFE stay three separate facts', () => {
    expect(deriveSetupSafetyFlags(reported(RX_FAILSAFE))).toEqual({
      rxLoss: 'ACTIVE',
      failsafe: 'INACTIVE',
      boxFailsafe: 'INACTIVE',
    });
    expect(deriveSetupSafetyFlags(reported(FAILSAFE))).toEqual({
      rxLoss: 'INACTIVE',
      failsafe: 'ACTIVE',
      boxFailsafe: 'INACTIVE',
    });
    expect(deriveSetupSafetyFlags(reported(BOXFAILSAFE))).toEqual({
      rxLoss: 'INACTIVE',
      failsafe: 'INACTIVE',
      boxFailsafe: 'ACTIVE',
    });
  });

  it('all three can be active at once', () => {
    expect(
      deriveSetupSafetyFlags(reported(RX_FAILSAFE + FAILSAFE + BOXFAILSAFE)),
    ).toEqual({rxLoss: 'ACTIVE', failsafe: 'ACTIVE', boxFailsafe: 'ACTIVE'});
  });

  it('an unrelated blocker does not falsely raise any of them', () => {
    expect(deriveSetupSafetyFlags(reported(THROTTLE))).toEqual({
      rxLoss: 'INACTIVE',
      failsafe: 'INACTIVE',
      boxFailsafe: 'INACTIVE',
    });
  });

  it('a fresh empty reading proves all three are currently absent', () => {
    expect(deriveSetupSafetyFlags(NONE)).toEqual({
      rxLoss: 'INACTIVE',
      failsafe: 'INACTIVE',
      boxFailsafe: 'INACTIVE',
    });
  });

  it('stale or malformed evidence is UNKNOWN - not an all-clear, and not a lingering warning', () => {
    for (const blockers of [UNCONFIRMED, MALFORMED]) {
      expect(deriveSetupSafetyFlags(blockers)).toEqual({
        rxLoss: 'UNKNOWN',
        failsafe: 'UNKNOWN',
        boxFailsafe: 'UNKNOWN',
      });
    }
  });
});

describe('deriveSetupRebootRequired', () => {
  it('a fresh true is ACTIVE', () => {
    expect(deriveSetupRebootRequired(true, 'FRESH', false)).toBe('ACTIVE');
  });

  it('a fresh false is INACTIVE', () => {
    expect(deriveSetupRebootRequired(false, 'FRESH', false)).toBe('INACTIVE');
  });

  it('a stale reading is UNKNOWN - the warning may not keep glowing', () => {
    expect(deriveSetupRebootRequired(true, 'STALE', false)).toBe('UNKNOWN');
  });

  it('every non-fresh lifecycle state is UNKNOWN', () => {
    for (const state of [
      'DISCONNECTED',
      'UNSUPPORTED',
      'UNAVAILABLE',
      'WAITING',
      'ERROR',
      'STALE',
    ]) {
      expect(deriveSetupRebootRequired(true, state, false)).toBe('UNKNOWN');
    }
  });

  it('an absent readiness tail is UNKNOWN, never guessed', () => {
    expect(deriveSetupRebootRequired(undefined, 'FRESH', false)).toBe('UNKNOWN');
  });

  it('a malformed tail is UNKNOWN even when the field decoded', () => {
    expect(deriveSetupRebootRequired(true, 'FRESH', true)).toBe('UNKNOWN');
  });
});

describe('deriveSetupSensorSummary', () => {
  const maskFor = (...tokens: string[]) =>
    tokens.reduce((mask, token) => {
      const index = ['ACC', 'BARO', 'MAG', 'GPS', 'RANGEFINDER', 'GYRO', 'OPTICALFLOW'].indexOf(
        token,
      );
      return mask + bit(index);
    }, 0);
  const summaryFor = (mask: number) =>
    deriveSetupSensorSummary({
      kind: 'REPORTED',
      bits: decodeSensorPresence(mask),
    } as DiagnosticsSensors);
  const stateOf = (mask: number, token: string) =>
    summaryFor(mask).entries.find(entry => entry.token === token)?.state;

  it.each(['GYRO', 'ACC', 'BARO', 'MAG', 'GPS', 'RANGEFINDER', 'OPTICALFLOW'])(
    '%s detected',
    token => {
      expect(stateOf(maskFor(token), token)).toBe('DETECTED');
    },
  );

  it('an absent bit is NOT_DETECTED - never "unhealthy"', () => {
    expect(stateOf(maskFor('ACC'), 'GYRO')).toBe('NOT_DETECTED');
  });

  it('no reading at all makes every sensor UNKNOWN', () => {
    const summary = deriveSetupSensorSummary({kind: 'UNCONFIRMED'});
    expect(summary.unconfirmed).toBe(true);
    expect(summary.entries.every(entry => entry.state === 'UNKNOWN')).toBe(true);
  });

  it('always names every canonical sensor, so a missing one is visible', () => {
    expect(summaryFor(0).entries.map(entry => entry.token)).toEqual([
      ...SETUP_SENSOR_TOKENS,
    ]);
    expect(summaryFor(0).entries.every(e => e.state === 'NOT_DETECTED')).toBe(true);
  });

  it('preserves a future sensor bit the app cannot name', () => {
    const summary = summaryFor(bit(9));
    expect(summary.unknownBits).toHaveLength(1);
    expect(summary.unknownBits[0].hex).toBe('0x200');
  });

  it('the presentation order covers exactly the decoder tokens', () => {
    expect(SETUP_SENSOR_TOKENS_MATCH_DECODER).toBe(true);
  });

  it('exposes no health vocabulary anywhere', () => {
    const serialized = JSON.stringify(summaryFor(maskFor('GYRO', 'ACC')));
    expect(serialized).not.toMatch(/HEALTH/i);
    expect(serialized).not.toMatch(/UNHEALTHY/i);
  });
});

describe('deriveSetupWarnings', () => {
  const base: SetupWarningInput = {
    connected: true,
    recovering: false,
    armed: 'DISARMED',
    readinessStatus: 'READY',
    flags: {rxLoss: 'INACTIVE', failsafe: 'INACTIVE', boxFailsafe: 'INACTIVE'},
    rebootRequired: 'INACTIVE',
    receiverSignalUnavailable: false,
    batteryState: 'OK',
  };
  const ids = (input: Partial<SetupWarningInput>) =>
    deriveSetupWarnings({...base, ...input}).map(w => w.id);

  it('a healthy connected aircraft produces no warnings at all', () => {
    expect(deriveSetupWarnings(base)).toEqual([]);
  });

  it('disconnected reports exactly one warning and claims nothing else', () => {
    expect(
      ids({
        connected: false,
        armed: 'ARMED',
        flags: {rxLoss: 'ACTIVE', failsafe: 'ACTIVE', boxFailsafe: 'ACTIVE'},
        rebootRequired: 'ACTIVE',
      }),
    ).toEqual(['FC_DISCONNECTED']);
  });

  it('ARMED is a critical warning', () => {
    const [warning] = deriveSetupWarnings({...base, armed: 'ARMED'});
    expect(warning.id).toBe('ARMED');
    expect(warning.severity).toBe('CRITICAL');
  });

  it('surfaces RXLOSS, FAILSAFE and BOXFAILSAFE separately', () => {
    expect(
      ids({flags: {rxLoss: 'ACTIVE', failsafe: 'ACTIVE', boxFailsafe: 'ACTIVE'}}),
    ).toEqual(['RX_LOSS', 'FAILSAFE', 'BOX_FAILSAFE']);
  });

  it('does not raise a failsafe warning from an UNKNOWN flag', () => {
    expect(
      ids({flags: {rxLoss: 'UNKNOWN', failsafe: 'UNKNOWN', boxFailsafe: 'UNKNOWN'}}),
    ).toEqual([]);
  });

  it('reboot-required only when the flag is ACTIVE', () => {
    expect(ids({rebootRequired: 'ACTIVE'})).toEqual(['REBOOT_REQUIRED']);
    expect(ids({rebootRequired: 'UNKNOWN'})).toEqual([]);
    expect(ids({rebootRequired: 'INACTIVE'})).toEqual([]);
  });

  it('routes each warning to the screen that owns the remedy', () => {
    const byId = new Map(
      deriveSetupWarnings({
        ...base,
        flags: {rxLoss: 'ACTIVE', failsafe: 'ACTIVE', boxFailsafe: 'INACTIVE'},
        batteryState: 'CRITICAL',
        receiverSignalUnavailable: true,
      }).map(w => [w.id, w.owner]),
    );
    expect(byId.get('RX_LOSS')).toBe('RECEIVER');
    expect(byId.get('FAILSAFE')).toBe('FAILSAFE');
    expect(byId.get('BATTERY_CRITICAL')).toBe('POWER');
    expect(byId.get('RECEIVER_SIGNAL_UNAVAILABLE')).toBe('RECEIVER');
  });

  it('battery warning and critical are distinct and mutually exclusive', () => {
    expect(ids({batteryState: 'WARNING'})).toEqual(['BATTERY_WARNING']);
    expect(ids({batteryState: 'CRITICAL'})).toEqual(['BATTERY_CRITICAL']);
    expect(ids({batteryState: undefined})).toEqual([]);
    expect(ids({batteryState: 'NOT_PRESENT'})).toEqual([]);
  });

  it('every warning carries an i18n key, never Arabic', () => {
    for (const warning of deriveSetupWarnings({
      ...base,
      armed: 'ARMED',
      rebootRequired: 'ACTIVE',
    })) {
      expect(warning.messageKey).toBe(`setupWarnings.${warning.id}`);
      expect(warning.messageKey).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('invents no readiness score and no health verdict', () => {
    const serialized = JSON.stringify(
      deriveSetupWarnings({...base, armed: 'ARMED'}),
    );
    expect(serialized).not.toMatch(/percent|score|healthy/i);
  });
});
