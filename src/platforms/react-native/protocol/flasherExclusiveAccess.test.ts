/**
 * THE FLASHER COULD NOT OPEN A PORT THIS APPLICATION WAS HOLDING.
 *
 * =====================================================================
 * THE REPORTED SYMPTOM, AND WHY RETRYING NEVER HELPED
 * =====================================================================
 *
 * "Sometimes the flasher cannot connect or cannot identify the board."
 * The sequence that produces it is the ordinary one:
 *
 *     Home -> connect -> Setup          a verified MSP session holds the port
 *     back to Home                      the session is deliberately KEPT alive
 *                                       (App.tsx: re-entering ADOPTS it rather
 *                                        than opening a second port)
 *     open Firmware Flasher
 *     press detect                      openDevice -> DEVICE_ALREADY_IN_USE
 *
 * A serial port admits one owner, so both transports refuse the second
 * open - correctly. The defect was that the owner was US, and the screen
 * told the operator to re-plug the cable. Re-plugging cannot release a
 * handle held inside this same process, so every retry failed the same
 * way, forever.
 *
 * These tests drive the REAL FirmwareBootloaderController against a fake
 * transport that enforces the same one-owner rule the real ones do, and
 * a REAL MspSessionCoordinator holding a real prior session.
 */

jest.mock('../transport/native/NativeUsbSerialTransport');

import {FirmwareBootloaderController, FirmwareDetectionError} from './FirmwareBootloaderController';
import {releaseApplicationOwnedSessions} from './exclusiveDeviceAccess';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import type {UsbSerialTransportClient} from '../transport';
import * as fs from 'fs';
import * as path from 'path';

/* ------------------------------------------------------------------ *
 * A transport that enforces the real one-owner rule
 * ------------------------------------------------------------------ */

class BusyPortError extends Error {
  readonly code = 'DEVICE_ALREADY_IN_USE';
  constructor() {
    super('This port already has an open session.');
  }
}

function makeTransport(options: {readonly refuseClose?: boolean} = {}) {
  /** deviceId -> open sessionId, exactly as a real port registry works. */
  const openByDevice = new Map<number, string>();
  let nextSession = 1;
  const listeners = new Set<(event: {sessionId: string; dataBase64: string}) => void>();

  const client = {
    listDevices: jest.fn(async () => [
      {
        deviceId: 7,
        vendorId: 0x0483,
        productId: 0x5740,
        driverType: 'cdc',
        portCount: 1,
      },
    ]),
    listDfuDevices: jest.fn(async () => []),
    openDevice: jest.fn(async (deviceId: number, _portIndex?: number, _config?: unknown) => {
      if (openByDevice.has(deviceId)) throw new BusyPortError();
      const sessionId = `port-session-${nextSession++}`;
      openByDevice.set(deviceId, sessionId);
      return sessionId;
    }),
    closeSession: jest.fn(async (sessionId: string) => {
      if (options.refuseClose === true) throw new Error('close rejected');
      for (const [deviceId, id] of openByDevice) {
        if (id === sessionId) openByDevice.delete(deviceId);
      }
    }),
    stopReading: jest.fn(async () => undefined),
    startReading: jest.fn(async () => undefined),
    writeBytes: jest.fn(async () => undefined),
    onDataReceived: jest.fn((cb: (event: {sessionId: string; dataBase64: string}) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    onSessionDetached: jest.fn(() => () => undefined),
    onDeviceDetached: jest.fn(() => () => undefined),
    onError: jest.fn(() => () => undefined),
    requestDevicePermission: jest.fn(async () => null),
  };

  return {
    client: client as unknown as UsbSerialTransportClient,
    raw: client,
    isPortOpen: (deviceId: number) => openByDevice.has(deviceId),
    openCount: () => openByDevice.size,
  };
}

/* ------------------------------------------------------------------ *
 * The prior session: opened through the very API the workspace uses
 * ------------------------------------------------------------------ */

async function openPriorWorkspaceSession(
  transport: ReturnType<typeof makeTransport>,
  coordinator: MspSessionCoordinator,
): Promise<string> {
  const sessionId = await transport.raw.openDevice(7, 0, {
    baudRate: 115200,
    dataBits: 8,
    stopBits: '1',
    parity: 'none',
    flowControl: 'off',
  } as never);
  coordinator.openSession(transport.client, sessionId);
  return sessionId;
}

describe('the flasher takes exclusive access instead of failing on our own session', () => {
  it('a live workspace session really does block a second open - the defect exists', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    await openPriorWorkspaceSession(transport, coordinator);

    /* Proving the premise before proving the fix: without releasing, the
       transport refuses, exactly as Web Serial and the Android module
       both do. */
    await expect(
      transport.raw.openDevice(7, 0, {} as never),
    ).rejects.toMatchObject({code: 'DEVICE_ALREADY_IN_USE'});
  });

  it('releases every session this application owns, transport first, then ownership', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    const sessionId = await openPriorWorkspaceSession(transport, coordinator);
    expect(coordinator.listSessionIds()).toEqual([sessionId]);

    const outcome = await releaseApplicationOwnedSessions(transport.client, coordinator);

    expect(outcome.released).toEqual([sessionId]);
    expect(outcome.closeFailures).toEqual([]);
    // The port is genuinely free, not merely disowned.
    expect(transport.isPortOpen(7)).toBe(false);
    expect(coordinator.listSessionIds()).toEqual([]);
    // The proven order: stop the read loop, close the port, then disown.
    expect(transport.raw.stopReading).toHaveBeenCalledWith(sessionId);
    expect(transport.raw.closeSession).toHaveBeenCalledWith(sessionId);
  });

  it('is safe and empty when nothing is open', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    const outcome = await releaseApplicationOwnedSessions(transport.client, coordinator);
    expect(outcome).toEqual({released: [], closeFailures: []});
    expect(transport.raw.closeSession).not.toHaveBeenCalled();
  });

  /**
   * AN UNCONFIRMED CLOSE STILL DISOWNS. An ownership record pointing at a
   * transport in an unknown state is worse than none: every screen
   * reading ownership would keep treating a dead link as live. The
   * unconfirmed close is REPORTED so the caller can say something true
   * about it, rather than swallowed.
   */
  it('disowns even when the transport close rejects, and reports it', async () => {
    const transport = makeTransport({refuseClose: true});
    const coordinator = new MspSessionCoordinator();
    const sessionId = await openPriorWorkspaceSession(transport, coordinator);

    const outcome = await releaseApplicationOwnedSessions(transport.client, coordinator);

    expect(outcome.released).toEqual([sessionId]);
    expect(outcome.closeFailures).toEqual([sessionId]);
    expect(coordinator.listSessionIds()).toEqual([]);
  });
});

describe('detectFlightController no longer fails on a port this application holds', () => {
  /**
   * THE REGRESSION THIS ROUND EXISTS FOR. detect() is driven with a live
   * workspace session in place. Before the fix it rejected at openDevice
   * with DEVICE_ALREADY_IN_USE; now it gets past the open and fails - if
   * at all - for a REAL reason further down the sequence.
   */
  it('gets past the open with a workspace session live, and frees the port to do it', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    const priorSession = await openPriorWorkspaceSession(transport, coordinator);
    const controller = new FirmwareBootloaderController(transport.client, coordinator);

    /* The fake board answers nothing, so identification cannot succeed -
       which is fine and is the point: the assertion is about WHERE it
       fails. A DEVICE_ALREADY_IN_USE here would mean the defect is back. */
    const failure = await controller
      .detectFlightController()
      .then(() => undefined, (error: unknown) => error);

    expect((failure as {code?: string} | undefined)?.code).not.toBe(
      'DEVICE_ALREADY_IN_USE',
    );
    // It opened: the prior session was released and a new one was minted.
    expect(transport.raw.openDevice).toHaveBeenCalled();
    expect(transport.raw.closeSession).toHaveBeenCalledWith(priorSession);
  }, 20_000);

  /**
   * STILL BUSY AFTER WE LET GO IS A DIFFERENT FACT, and it gets a
   * different sentence. Another browser tab, or another application,
   * holds the port - and "re-plug the cable" would be the wrong advice
   * for the second time.
   */
  it('names an EXTERNAL holder instead of blaming the cable', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    // Held by something this application does not own: the port registry
    // knows it, the coordinator does not.
    await transport.raw.openDevice(7, 0, {} as never);
    expect(coordinator.listSessionIds()).toEqual([]);

    const controller = new FirmwareBootloaderController(transport.client, coordinator);
    const failure = await controller
      .detectFlightController()
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(FirmwareDetectionError);
    const text = (failure as Error).message;
    expect(text).toContain('تطبيق أو تبويب آخر');
    // The cable advice must NOT be what an operator reads here.
    expect(text).not.toContain('أعد توصيل الكابل');
    expect((failure as FirmwareDetectionError).stage).toBe('TRANSPORT_OPEN_FAILED');
  });

  /**
   * AND WHEN OUR OWN CLOSE COULD NOT BE CONFIRMED, the sentence says so
   * rather than accusing another application - because in that case
   * re-plugging genuinely IS the recovery.
   */
  it('says so when our own close was unconfirmed and the port stayed busy', async () => {
    const transport = makeTransport({refuseClose: true});
    const coordinator = new MspSessionCoordinator();
    await openPriorWorkspaceSession(transport, coordinator);

    const controller = new FirmwareBootloaderController(transport.client, coordinator);
    const failure = await controller
      .detectFlightController()
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(FirmwareDetectionError);
    expect((failure as Error).message).toContain('تعذّر تأكيد إغلاق جلسة الاتصال السابقة');
  });

  /**
   * NO STALE VERDICT. openSession() returns the EXISTING MspClient when
   * the coordinator already knows an id and never starts identification
   * for it - so a leftover record under a reused id would make
   * waitForIdentity read a verdict about a dead session: an instant
   * stale failure, or an IDLE that runs the full timeout and reports
   * "the board did not answer" about a board nobody asked.
   */
  it('leaves no ownership record behind that a reused session id could inherit', async () => {
    const transport = makeTransport();
    const coordinator = new MspSessionCoordinator();
    await openPriorWorkspaceSession(transport, coordinator);
    const controller = new FirmwareBootloaderController(transport.client, coordinator);

    await controller.detectFlightController().catch(() => undefined);

    /* Whatever the outcome, detect must not leave the map holding the
       session it opened: its own failure path deactivates, and the
       release cleared everything before it. */
    expect(coordinator.listSessionIds()).toEqual([]);
  }, 20_000);
});


/* ================================================================== *
 * TAKING THE PORT MUST NOT EJECT THE OPERATOR FROM THE FLASHER
 * ================================================================== */

/**
 * THE HAZARD THIS FIX COULD HAVE INTRODUCED.
 *
 * useSessionLossRedirect watches the tracked session and RESETS THE
 * STACK TO HOME when its MSP ownership goes INACTIVE - the safety rule
 * that stops any screen holding a dead session. Releasing the workspace
 * session from inside the flasher makes ownership go INACTIVE by
 * design, so if the flasher were reachable while a session was still
 * tracked, pressing detect would throw the operator back to Home
 * mid-detection, with a "connection lost" notice for a connection
 * nobody lost.
 *
 * It cannot happen, and these two facts are why - asserted rather than
 * assumed, because either one changing silently would re-open it:
 *
 *   1. the ONLY navigation into the flasher is from Home, and
 *   2. the redirect only ever starts tracking on the 'Setup' route, and
 *      clears the tracked id on 'Start'.
 *
 * So an operator reaching the flasher has necessarily passed through
 * Home, which cleared the tracked id before they arrived.
 */
describe('releasing the workspace session cannot bounce the operator out of the flasher', () => {
  const SRC = path.join(__dirname, '..', '..', '..');
  const read = (...parts: string[]) =>
    fs.readFileSync(path.join(SRC, ...parts), 'utf8');

  it('is reachable from Home and from nowhere else', () => {
    const entries: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (/navigate\(\s*['"`]FirmwareFlasher['"`]/.test(source)) {
          entries.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(entries).toEqual(['ui/screens/StartScreen.tsx']);
  });

  it('only starts tracking a session on the Setup route, and clears it on Home', () => {
    const redirect = read('navigation', 'useSessionLossRedirect.ts');
    expect(redirect).toMatch(/currentRoute\?\.name === 'Setup'/);
    expect(redirect).toMatch(/currentRoute\?\.name === 'Start'[\s\S]{0,120}setTrackedSessionId\(null\)/);
    // And nothing tracks on the flasher route itself.
    expect(redirect).not.toContain("'FirmwareFlasher'");
  });
});
