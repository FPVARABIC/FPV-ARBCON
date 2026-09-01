/**
 * WHAT THE APP KNOWS ABOUT A REBOOT IT ASKED FOR.
 *
 * =====================================================================
 * THE DEFECT THESE TESTS KEEP CLOSED
 * =====================================================================
 *
 * A Ports or GPS save persists to EEPROM and then asks the flight
 * controller to restart. That last frame can go unanswered - a timeout,
 * a link that vanishes - and the outcome then carries
 * `rebootAcknowledged: false`.
 *
 * Both screens rendered «إعادة تشغيل المتحكم متوقعة» anyway, because
 * their outcome mapping switched on `outcome.kind` alone. The evidence
 * was sitting on the outcome and the presentation ignored it. Measured
 * before the fix, through the real controller and the real screen:
 *
 *     Ports  SAVED_VERIFIED  rebootAcknowledged=false
 *            «تم حفظ إعدادات المنافذ والتحقق من قراءتها.
 *              إعادة تشغيل المتحكم متوقعة.»
 *
 * =====================================================================
 * THE THREE FACTS THAT MUST STAY SEPARATE
 * =====================================================================
 *
 *   PERSISTENCE       the EEPROM write was acknowledged
 *   READBACK          the stored values were re-read and matched
 *   REBOOT ACK        the restart command was acknowledged
 *
 * They fail independently, so `kind` alone cannot express them. A
 * SAVED_VERIFIED with no reboot acknowledgement and a SAVED_VERIFIED
 * with one are two different things to tell an operator, and a
 * SAVED_UNVERIFIED whose reboot also went unacknowledged carries BOTH
 * uncertainties - neither of which may hide the other.
 *
 * =====================================================================
 * WHAT "NO ACKNOWLEDGEMENT" DOES NOT MEAN
 * =====================================================================
 *
 * It is not proof the reboot failed. A link that disappears is exactly
 * what a board rebooting looks like. So the copy says CONFIRMED versus
 * NOT CONFIRMED, never HAPPENED versus FAILED - and it never retracts
 * the persistence claim, which the EEPROM acknowledgement already
 * established and which a missing reboot ACK says nothing about.
 *
 * Every case here drives the real controller against a virtual board,
 * checks the request trace, and then renders the real screen and reads
 * the words. A test that only checked the outcome card existed would
 * pass against any sentence at all.
 *
 * Nothing here is evidence about real hardware.
 */

const mockRelease = jest.fn();

jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  return {
    ...actual,
    acquireGpsDetailTelemetry: () => mockRelease,
    useMspOwnershipState: () => 'ACTIVE',
    useMspRecoveryState: () => 'READY',
    useMspIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
        apiVersion: {
          mspProtocolVersion: 0,
          apiVersionMajor: 1,
          apiVersionMinor: 47,
        },
        board: {},
      },
    }),
    useTelemetryValue: () => ({ status: 'UNAVAILABLE' }),
  };
});
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, Text } from 'react-native';

import '../../i18n';
import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_GPS_CONFIG,
  MSP_REBOOT,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_GPS_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';
import { createGpsConfigurationDraft } from '../../core';
import {
  SERIAL_ROLE_DEFINITIONS,
  deriveSerialPortsFeatureMask,
  hasSerialRole,
  serialRoleIsAvailable,
  setSerialRole,
  type SerialPortsSnapshot,
} from '../../core/state/serialPortsModel';
import { PortsConfigurationController } from '../../platforms/react-native/protocol/PortsConfigurationController';
import { GpsConfigurationController } from '../../platforms/react-native/protocol/GpsConfigurationController';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import { VirtualFlightController } from '../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import { VirtualSession } from '../../platforms/react-native/protocol/__testUtils__/virtualSession';

import PortsScreen from './PortsScreen';
import GpsScreen from './GpsScreen';

/* ------------------------------------------------------------------ *
 * THE WORDS THAT CARRY EACH FACT
 * ------------------------------------------------------------------ */

/** The save reached permanent storage. */
const PERSISTED = 'الذاكرة الدائمة';
/** The restart command came back acknowledged. */
const REBOOT_ACKNOWLEDGED = 'أقرّ المتحكم أمر إعادة التشغيل';
/** The restart command did not come back. */
const REBOOT_UNCONFIRMED = 'لم يصل تأكيد لأمر إعادة التشغيل';
/** The stored values could not be re-read and compared. */
const READBACK_UNVERIFIED = 'تعذّرت القراءة الراجعة';
/** The sentence this whole phase exists to remove. */
const REBOOT_CLAIMED = 'إعادة تشغيل المتحكم متوقعة';

const spec = (key: string) => {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) {
    throw new Error(`no spec ${key}`);
  }
  return found;
};

/** Every word the rendered subtree contains, flattened. */
function words(node: ReactTestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(text =>
      Array.isArray(text.props.children)
        ? text.props.children.join('')
        : String(text.props.children),
    )
    .join(' ');
}

/**
 * Fault the nth occurrence of `command` counted FROM NOW, so a test can
 * target the read-back that happens after the EEPROM write rather than
 * the identical read in the preflight.
 */
function faultFromHere(
  board: VirtualFlightController,
  command: number,
  fault: 'TIMEOUT' | 'REMOTE_ERROR',
  nth: number,
): { fired: () => boolean } {
  const already = board.requests.filter(r => r.command === command).length;
  const target = already + nth;
  board.injectFault({ command, fault: { kind: fault }, occurrence: target });
  return {
    fired: () =>
      board.requests.filter(r => r.command === command).length >= target,
  };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
  }
};

/* ------------------------------------------------------------------ *
 * PORTS
 * ------------------------------------------------------------------ */

/**
 * An edit that really moves both Ports write groups, chosen from the
 * roles this firmware declares - the screen refuses the rest, and an
 * edit it refuses would never reach a save at all.
 */
function portsEdit(snapshot: SerialPortsSnapshot) {
  for (const port of snapshot.ports) {
    if (port.identifier === 20) {
      continue;
    }
    for (const definition of SERIAL_ROLE_DEFINITIONS) {
      if (
        hasSerialRole(port, definition.key) ||
        !serialRoleIsAvailable(snapshot, definition.key)
      ) {
        continue;
      }
      const next = setSerialRole(
        snapshot.ports,
        port.identifier,
        definition.key,
        true,
      );
      if (
        deriveSerialPortsFeatureMask(snapshot.featureMaskRaw, next) !==
        snapshot.featureMaskRaw
      ) {
        return { next, identifier: port.identifier, role: definition.key };
      }
    }
  }
  throw new Error('fixture offers no Ports edit that moves both groups');
}

/**
 * Runs the REAL Ports save against a virtual board, then renders the
 * REAL screen with the outcome that save produced.
 *
 * `reboot` and `breakReadback` shape the board, not the outcome - the
 * evidence has to come from the protocol, not from a fixture.
 */
async function portsRun(
  tag: string,
  options: { reboot: 'ACK' | 'TIMEOUT'; breakReadback?: boolean },
) {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec('LONG_RANGE')),
  });
  const session = new VirtualSession({
    sessionId: `reboot-ports-${tag}`,
    board,
    apiMinor: 47,
  });
  const controller = new PortsConfigurationController(session.options);
  const loaded = await controller.load(session.key);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`ports load ${loaded.kind}`);
  }
  const { next, identifier, role } = portsEdit(loaded.snapshot);

  /* The read-back is the SECOND serial-config read of the transaction:
     the first is the stale-base check before any write. */
  const readbackFault = options.breakReadback
    ? faultFromHere(board, MSP2_COMMON_SERIAL_CONFIG, 'TIMEOUT', 2)
    : undefined;
  const rebootFault =
    options.reboot === 'TIMEOUT'
      ? faultFromHere(board, MSP_REBOOT, 'TIMEOUT', 1)
      : undefined;

  const from = board.requests.length;
  const outcome = await controller.save(session.key, loaded.snapshot, next);
  const sent = board.requests.slice(from).map(request => request.command);

  /* Injected faults must PROVE they fired, or the row below is a clean
     pass that measured nothing. */
  if (readbackFault !== undefined) {
    expect(readbackFault.fired()).toBe(true);
  }
  if (rebootFault !== undefined) {
    expect(rebootFault.fired()).toBe(true);
  }

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <PortsScreen
        sessionKey={session.key}
        controller={
          {
            load: async () => ({
              kind: 'LOADED' as const,
              snapshot: loaded.snapshot,
            }),
            save: async () => outcome,
          } as never
        }
      />,
    );
    await Promise.resolve();
  });
  await flush();

  const press = async (testID: string) => {
    const node = renderer.root.findAllByProps({ testID })[0];
    if (node === undefined) {
      throw new Error(`no node ${testID}`);
    }
    await ReactTestRenderer.act(async () => {
      node.props.onPress();
      await Promise.resolve();
    });
  };
  await press(`ports-card-toggle-${identifier}`);
  await press(`ports-${identifier}-role-${role}`);
  await press('ports-save');
  await flush();

  const card = renderer.root.findAllByProps({ testID: 'ports-save-outcome' })[0];
  if (card === undefined) {
    throw new Error('the Ports save rendered no outcome at all');
  }
  const text = words(card);
  /* §9: the recovery action an operator can reach from this state is
     the screen's own re-read, and it must still be there. */
  const hasRecovery =
    renderer.root.findAllByProps({ testID: 'ports-reload' }).length > 0;
  renderer.unmount();

  return { outcome, sent, text, hasRecovery };
}

/* ------------------------------------------------------------------ *
 * GPS
 * ------------------------------------------------------------------ */

async function gpsRun(
  tag: string,
  options: { reboot: 'ACK' | 'TIMEOUT'; breakReadback?: boolean },
) {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec('LONG_RANGE')),
  });
  const session = new VirtualSession({
    sessionId: `reboot-gps-${tag}`,
    board,
    apiMinor: 47,
  });
  const controller = new GpsConfigurationController(session.options);
  const loaded = await controller.load(session.key);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`gps load ${loaded.kind}`);
  }
  const base = createGpsConfigurationDraft(loaded.snapshot);
  const draft = { ...base, provider: base.provider === 1 ? 0 : 1 };

  const readbackFault = options.breakReadback
    ? faultFromHere(board, MSP_GPS_CONFIG, 'TIMEOUT', 2)
    : undefined;
  const rebootFault =
    options.reboot === 'TIMEOUT'
      ? faultFromHere(board, MSP_REBOOT, 'TIMEOUT', 1)
      : undefined;

  const from = board.requests.length;
  const outcome = await controller.save(session.key, loaded.snapshot, draft);
  const sent = board.requests.slice(from).map(request => request.command);

  if (readbackFault !== undefined) {
    expect(readbackFault.fired()).toBe(true);
  }
  if (rebootFault !== undefined) {
    expect(rebootFault.fired()).toBe(true);
  }

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <GpsScreen
        sessionKey={session.key}
        active
        onOpenPorts={() => undefined}
        controller={
          {
            load: async () => ({
              kind: 'LOADED' as const,
              snapshot: loaded.snapshot,
            }),
            save: async () => outcome,
          } as never
        }
      />,
    );
    await Promise.resolve();
  });
  await flush();

  const provider = renderer.root.findAllByProps({
    testID: base.provider === 0 ? 'gps-provider-ublox' : 'gps-provider-nmea',
  })[0];
  await ReactTestRenderer.act(async () => {
    provider.props.onPress();
    await Promise.resolve();
  });

  /* GPS routes its save through a confirmation dialog, so pressing the
     button only opens one. Take the branch the operator takes. */
  const alertSpy = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => {
      (buttons ?? [])
        .find(button => button.style !== 'cancel')
        ?.onPress?.(undefined as never);
    });
  const save = renderer.root.findAllByProps({ testID: 'gps-save' })[0];
  await ReactTestRenderer.act(async () => {
    save.props.onPress();
    await Promise.resolve();
  });
  alertSpy.mockRestore();
  await flush();

  const card = renderer.root.findAllByProps({ testID: 'gps-save-outcome' })[0];
  if (card === undefined) {
    throw new Error('the GPS save rendered no outcome at all');
  }
  const text = words(card);
  const hasRecovery =
    renderer.root.findAllByProps({ testID: 'gps-reload' }).length > 0;
  renderer.unmount();

  return { outcome, sent, text, hasRecovery };
}

/* ================================================================== *
 * THE PROTOCOL FACTS EVERY CASE SHARES
 * ================================================================== */

function assertProtocol(
  sent: readonly number[],
  setCommands: readonly number[],
) {
  /* At least one settings write was made, and exactly one commit. */
  expect(
    sent.filter(command => setCommands.includes(command)).length,
  ).toBeGreaterThan(0);
  expect(sent.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);

  /* THE REBOOT IS ATTEMPTED AT MOST ONCE - whatever happened to it.
     "Improving reliability" by sending a second one would restart an
     aircraft twice on one operator action. */
  expect(sent.filter(command => command === MSP_REBOOT)).toHaveLength(1);

  /* PERSISTENCE PRECEDES THE REBOOT. A reboot failure can never come
     first in the successful save path. */
  expect(sent.indexOf(MSP_EEPROM_WRITE)).toBeGreaterThanOrEqual(0);
  expect(sent.indexOf(MSP_REBOOT)).toBeGreaterThan(
    sent.indexOf(MSP_EEPROM_WRITE),
  );
}

const PORTS_SETS = [MSP2_COMMON_SET_SERIAL_CONFIG, MSP_SET_FEATURE_CONFIG];
const GPS_SETS = [MSP_SET_GPS_CONFIG];

describe('Ports: persistence, readback and reboot acknowledgement are three facts', () => {
  it('A. verified save, reboot acknowledged: says so, and claims no completed restart', async () => {
    const { outcome, sent, text } = await portsRun('a', { reboot: 'ACK' });
    assertProtocol(sent, PORTS_SETS);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(true);

    expect(text).toContain(PERSISTED);
    expect(text).toContain(REBOOT_ACKNOWLEDGED);
    expect(text).not.toContain(REBOOT_UNCONFIRMED);
  });

  it('B. verified save, reboot NOT acknowledged: still persisted, restart not claimed', async () => {
    const { outcome, sent, text, hasRecovery } = await portsRun('b', {
      reboot: 'TIMEOUT',
    });
    assertProtocol(sent, PORTS_SETS);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(false);

    /* The defect: this used to render the same sentence as A. */
    expect(text).not.toContain(REBOOT_CLAIMED);
    expect(text).toContain(REBOOT_UNCONFIRMED);
    expect(text).not.toContain(REBOOT_ACKNOWLEDGED);

    /* A missing reboot ACK never retracts a persisted save. */
    expect(text).toContain(PERSISTED);
    expect(text).not.toContain('فشل');
    /* Nor does it assert the reboot failed, or a specific link event
       the app never observed. */
    expect(text).not.toContain('انقطع');

    expect(hasRecovery).toBe(true);
  });

  it('C. readback unverified, reboot acknowledged: one uncertainty, not two', async () => {
    const { outcome, sent, text } = await portsRun('c', {
      reboot: 'ACK',
      breakReadback: true,
    });
    assertProtocol(sent, PORTS_SETS);
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
    if (outcome.kind !== 'SAVED_UNVERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(true);

    expect(text).toContain(PERSISTED);
    expect(text).toContain(READBACK_UNVERIFIED);
    expect(text).toContain(REBOOT_ACKNOWLEDGED);
    /* Readback uncertainty must not be reported as reboot uncertainty. */
    expect(text).not.toContain(REBOOT_UNCONFIRMED);
  });

  it('D. readback unverified AND reboot NOT acknowledged: both are named', async () => {
    const { outcome, sent, text } = await portsRun('d', {
      reboot: 'TIMEOUT',
      breakReadback: true,
    });
    assertProtocol(sent, PORTS_SETS);
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
    if (outcome.kind !== 'SAVED_UNVERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(false);

    /* THE SHARPEST CASE AGAINST A ONE-DIMENSIONAL MAPPING: one
       uncertainty must not hide the other. */
    expect(text).toContain(READBACK_UNVERIFIED);
    expect(text).toContain(REBOOT_UNCONFIRMED);
    expect(text).toContain(PERSISTED);
    expect(text).not.toContain(REBOOT_CLAIMED);
  });

  /* Sequentially, not in parallel: react-test-renderer's `act` is
     global, so four concurrent renders interleave and unmount each
     other - which fails in a way that looks like a product defect. */
  it('the four states are four different sentences', async () => {
    const a = await portsRun('m1', { reboot: 'ACK' });
    const b = await portsRun('m2', { reboot: 'TIMEOUT' });
    const c = await portsRun('m3', { reboot: 'ACK', breakReadback: true });
    const d = await portsRun('m4', { reboot: 'TIMEOUT', breakReadback: true });
    expect(new Set([a.text, b.text, c.text, d.text]).size).toBe(4);
  });
});

describe('GPS: persistence, readback and reboot acknowledgement are three facts', () => {
  it('A. verified save, reboot acknowledged', async () => {
    const { outcome, sent, text } = await gpsRun('a', { reboot: 'ACK' });
    assertProtocol(sent, GPS_SETS);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(true);
    expect(text).toContain(PERSISTED);
    expect(text).toContain(REBOOT_ACKNOWLEDGED);
    expect(text).not.toContain(REBOOT_UNCONFIRMED);
  });

  it('B. verified save, reboot NOT acknowledged: still persisted, restart not claimed', async () => {
    const { outcome, sent, text, hasRecovery } = await gpsRun('b', {
      reboot: 'TIMEOUT',
    });
    assertProtocol(sent, GPS_SETS);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
    if (outcome.kind !== 'SAVED_VERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(false);

    expect(text).not.toContain(REBOOT_CLAIMED);
    expect(text).toContain(REBOOT_UNCONFIRMED);
    expect(text).toContain(PERSISTED);
    expect(text).not.toContain('فشل');
    expect(hasRecovery).toBe(true);
  });

  it('C. readback unverified, reboot acknowledged', async () => {
    const { outcome, sent, text } = await gpsRun('c', {
      reboot: 'ACK',
      breakReadback: true,
    });
    assertProtocol(sent, GPS_SETS);
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
    if (outcome.kind !== 'SAVED_UNVERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(true);
    expect(text).toContain(PERSISTED);
    expect(text).toContain(READBACK_UNVERIFIED);
    expect(text).toContain(REBOOT_ACKNOWLEDGED);
    expect(text).not.toContain(REBOOT_UNCONFIRMED);
  });

  it('D. readback unverified AND reboot NOT acknowledged: both are named', async () => {
    const { outcome, sent, text } = await gpsRun('d', {
      reboot: 'TIMEOUT',
      breakReadback: true,
    });
    assertProtocol(sent, GPS_SETS);
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
    if (outcome.kind !== 'SAVED_UNVERIFIED') throw new Error('unreachable');
    expect(outcome.rebootAcknowledged).toBe(false);
    expect(text).toContain(READBACK_UNVERIFIED);
    expect(text).toContain(REBOOT_UNCONFIRMED);
    expect(text).toContain(PERSISTED);
    expect(text).not.toContain(REBOOT_CLAIMED);
  });

  it('the four states are four different sentences', async () => {
    const a = await gpsRun('n1', { reboot: 'ACK' });
    const b = await gpsRun('n2', { reboot: 'TIMEOUT' });
    const c = await gpsRun('n3', { reboot: 'ACK', breakReadback: true });
    const d = await gpsRun('n4', { reboot: 'TIMEOUT', breakReadback: true });
    expect(new Set([a.text, b.text, c.text, d.text]).size).toBe(4);
  });
});

/* ================================================================== *
 * NO OUTCOME CARRYING THE EVIDENCE MAY IGNORE IT AGAIN
 * ================================================================== */

describe('every screen consuming a reboot-carrying save outcome reads the evidence', () => {
  /**
   * WHY A SOURCE SCAN.
   *
   * The bug was not a missing branch the compiler could see - the
   * mapping type-checked perfectly while quietly discarding a field.
   * Four controllers put `rebootAcknowledged` on their save outcomes;
   * this requires every UI file consuming one of those outcomes to
   * mention it, so a NEW screen cannot repeat the omission and a
   * refactor cannot silently drop it.
   */
  const { readFileSync, readdirSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  const PROTOCOL = join(__dirname, '..', '..', 'platforms', 'react-native', 'protocol');
  const UI = join(__dirname, '..');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(full);
      }
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  /** Outcome unions whose variants carry a reboot acknowledgement. */
  const rebootUnions = readdirSync(PROTOCOL)
    .filter(name => name.endsWith('Controller.ts'))
    .flatMap(name => {
      const source = readFileSync(join(PROTOCOL, name), 'utf8');
      if (!source.includes('readonly rebootAcknowledged: boolean')) {
        return [];
      }
      return Array.from(
        source.matchAll(/export type (\w*SaveOutcome)\s*=/g),
      ).map(match => match[1]);
    });

  it('finds the outcome unions that carry a reboot acknowledgement', () => {
    /* Without this the per-file assertions below would all pass
       vacuously - the shape of failure a scan-based test must rule out
       before it is allowed to prove anything. */
    expect(rebootUnions.length).toBeGreaterThan(0);
  });

  it.each(
    walk(UI)
      .filter(file => !/\.test\.tsx?$/.test(file))
      .map(file => [file, readFileSync(file, 'utf8')] as const)
      .filter(([, source]) => rebootUnions.some(union => source.includes(union)))
      .map(([file, source]) => [file.slice(file.indexOf('src/')), source]),
  )('%s reads rebootAcknowledged', (_file, source) => {
    expect(source as string).toContain('rebootAcknowledged');
  });
});
