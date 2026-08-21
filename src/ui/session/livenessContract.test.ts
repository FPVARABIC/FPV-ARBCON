/**
 * NO USER-VISIBLE OPERATION MAY WAIT FOREVER.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 *
 * A CLI save left the application on a blocking overlay that never
 * ended, and it did so because a deadline was recorded and nothing was
 * scheduled to check it. That was not a typo - it was a MISSING
 * CONTRACT. Nowhere did the codebase say "a busy state must have a way
 * out", so a busy state without one looked like every other one.
 *
 * This file is that contract, written down and enforced:
 *
 *   1. THE TABLE. Every user-visible busy state, and the specific thing
 *      that guarantees it ends. Each row is checked against the source,
 *      so a bound that gets deleted or renamed fails here.
 *
 *   2. THE GUARD. Any production module that declares a busy phase must
 *      appear in the table. Adding a new one without saying what bounds
 *      it fails this test - which is the point, because that is exactly
 *      how the CLI hang got in.
 *
 * =====================================================================
 * THE TWO KINDS OF BOUND, and both are real
 * =====================================================================
 *
 * DEADLINE      the operation carries its own timer and gives up.
 * OWNERSHIP     the operation awaits something that is ITSELF bounded,
 *               so it cannot outlive it. Every MSP request settles or
 *               rejects within MSP_RESPONSE_TIMEOUT_MILLIS, so a screen
 *               awaiting one inherits that bound rather than needing a
 *               second, redundant timer of its own.
 *
 * An OWNERSHIP row must name the bounded thing it depends on, and that
 * dependency is checked too - a chain is only as good as its last link.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');

const read = (file: string): string =>
  fs.readFileSync(path.join(ROOT, file), 'utf8');

type Bound =
  /** Carries its own timer. `constant` must exist in `file`. */
  | {readonly kind: 'DEADLINE'; readonly constant: string; readonly file: string}
  /** Inherits a bound from something it awaits. */
  | {
      readonly kind: 'OWNERSHIP';
      readonly dependsOn: string;
      readonly dependsOnFile: string;
      readonly why: string;
    };

type ContractRow = {
  /** What the operator sees happening. */
  readonly operation: string;
  /** The production module that owns the busy state. */
  readonly file: string;
  /** What puts it in the busy state. */
  readonly entersBusy: string;
  /** What ends it successfully. */
  readonly success: string;
  /** What ends it unsuccessfully. */
  readonly failure: string;
  readonly bound: Bound;
  /** How the operator gets out without waiting, or why there is no such
   *  path. Never left blank. */
  readonly cancel: string;
};

/**
 * The MSP client is the root of most of these chains: every request it
 * accepts is armed with a timer and settles either way. If that ever
 * stops being true, most of the OWNERSHIP rows below become false at
 * once - which is why it is asserted first and separately.
 */
const MSP_CLIENT = 'src/core/protocol/mspClient.ts';

const CONTRACT: readonly ContractRow[] = [
  {
    operation: 'Any MSP read or write (the root of most other rows)',
    file: MSP_CLIENT,
    entersBusy: 'request() queues a frame and arms its timer',
    success: 'the matching response frame settles the request',
    failure: 'MSP_TIMEOUT, or a transport/session error code',
    bound: {
      kind: 'DEADLINE',
      constant: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      file: MSP_CLIENT,
    },
    cancel:
      'closing the session rejects the active and queued requests ' +
      '(MSP_SESSION_CLOSED)',
  },
  {
    operation: 'CLI: entering the terminal and every command',
    file: 'src/platforms/react-native/protocol/RawCliSessionController.ts',
    entersBusy: "setPhase('ENTERING' | 'SENDING')",
    success: 'the prompt settles and the phase returns to ACTIVE',
    failure: 'the idle timer fires and the exchange rejects',
    bound: {
      kind: 'DEADLINE',
      constant: 'CLI_IDLE_TIMEOUT_MS',
      file: 'src/platforms/react-native/protocol/RawCliSessionController.ts',
    },
    cancel: 'exitWithoutSave() releases the resources and returns to IDLE',
  },
  {
    operation: 'CLI save -> flight controller reboot -> reconnect',
    file: 'src/platforms/react-native/protocol/fcRebootRecovery.ts',
    entersBusy: 'expectReboot() from RawCliSessionController.saveAndClose',
    success: 'noteRecovered() once the reopened session is IDENTIFIED',
    failure: 'the armed timer fires TIMED_OUT, or noteReopenFailed()',
    bound: {
      kind: 'DEADLINE',
      constant: 'FC_REBOOT_RECOVERY_TIMEOUT_MS',
      file: 'src/platforms/react-native/protocol/fcRebootRecovery.ts',
    },
    cancel:
      'none by design while it runs - the overlay is deliberately ' +
      'blocking - but it ends itself and leaves a retry on Home',
  },
  {
    operation: 'Home: connecting to a flight controller',
    file: 'src/ui/session/useDirectConnect.ts',
    entersBusy: "begin() -> CHOOSING | OPENING | IDENTIFYING",
    success: 'identification SUCCEEDED opens the workspace',
    failure:
      'a dismissed chooser returns to IDLE; a transport error or a ' +
      'failed identification shows FAILED with an Arabic sentence',
    bound: {
      kind: 'DEADLINE',
      constant: 'IDENTIFY_DEADLINE_MS',
      file: 'src/ui/session/useDirectConnect.ts',
    },
    cancel: 'dismiss() returns to IDLE at any point',
  },
  {
    operation: 'Reboot reconnect: re-enumerating and reopening the board',
    file: 'src/ui/session/useRebootReconnect.ts',
    entersBusy: 'the lifecycle entering WAITING_FOR_LINK starts the poll',
    success: 'the board is reopened and identified',
    failure: 'the lifecycle deadline fires, or the reopen throws',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'FC_REBOOT_RECOVERY_TIMEOUT_MS',
      dependsOnFile: 'src/platforms/react-native/protocol/fcRebootRecovery.ts',
      why:
        'the poll is not the bound - the lifecycle it serves owns a timer, ' +
        'and the poll stops the moment that timer produces a verdict',
    },
    cancel: 'unmounting stops the poll; the lifecycle still ends on its own',
  },
  {
    operation: 'CLI backup / restore (diff all and friends)',
    file: 'src/platforms/react-native/protocol/CliBackupService.ts',
    entersBusy: 'a capture begins and waits for the terminating prompt',
    success: 'the prompt arrives and the capture is returned',
    failure: 'its own deadline elapses and the capture is refused',
    bound: {
      kind: 'DEADLINE',
      constant: 'deadline',
      file: 'src/platforms/react-native/protocol/CliBackupService.ts',
    },
    cancel: 'leaving CLI releases the session and ends the capture',
  },
  {
    operation: 'Firmware: bootloader / DFU transitions',
    file: 'src/platforms/react-native/protocol/FirmwareBootloaderController.ts',
    entersBusy: 'a transition begins and waits for the device to reappear',
    success: 'the expected device is enumerated',
    failure: 'the deadline elapses and the transition is reported failed',
    bound: {
      kind: 'DEADLINE',
      constant: 'deadline',
      file: 'src/platforms/react-native/protocol/FirmwareBootloaderController.ts',
    },
    cancel: 'the flasher screen surfaces a terminal result either way',
  },
  {
    operation: 'Firmware: the flash phase machine the screen renders',
    file: 'src/core/firmware-flasher/flashPhaseModel.ts',
    entersBusy: 'a flash begins and the model reports progress phases',
    success: 'the model reaches a terminal success phase',
    failure: 'the model reaches a terminal failure phase',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'deadline',
      dependsOnFile:
        'src/platforms/react-native/protocol/FirmwareBootloaderController.ts',
      why:
        'the model is a PURE reducer over events - it waits for nothing ' +
        'itself; every event that drives it comes from a bounded ' +
        'transition or a bounded read',
    },
    cancel: 'a flash is not resumable; the screen shows a terminal result',
  },
  {
    operation: 'Telemetry: a scheduled poll operation',
    file: 'src/core/protocol/telemetry/operationTypes.ts',
    entersBusy: 'the scheduler marks a poll in flight',
    success: 'the response settles the poll',
    failure: 'MSP_TIMEOUT settles it as a failure and counts against the link',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      dependsOnFile: MSP_CLIENT,
      why: 'a poll IS an MSP request; it cannot outlive the request deadline',
    },
    cancel: 'the scheduler is stopped when its session ends',
  },
  {
    operation: 'Motors: opening and closing the test session',
    file: 'src/core/state/motorTestController.ts',
    entersBusy: "phase 'ACTIVATING' / 'CLOSING'",
    success: 'the lease is acquired or released and the phase settles',
    failure: 'the underlying MSP request rejects and the phase settles',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      dependsOnFile: MSP_CLIENT,
      why:
        'every step of the lifecycle awaits a lease request, and a lease ' +
        'request is an MSP request',
    },
    cancel: 'closing the session is always available and is itself bounded',
  },
  {
    operation: 'Motors: how that session is presented',
    file: 'src/core/state/motorSessionPresentation.ts',
    entersBusy: 'it derives a busy label from the controller phase',
    success: 'the controller phase changes',
    failure: 'the controller phase changes',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      dependsOnFile: MSP_CLIENT,
      why:
        'a pure projection of motorTestController phase - it introduces no ' +
        'wait of its own and cannot outlast what it describes',
    },
    cancel: 'inherited from the controller',
  },
  {
    operation: 'Setup: saving board alignment',
    file: 'src/ui/components/setup/BoardAlignmentCard.tsx',
    entersBusy: "setPhase({kind: 'SAVING'})",
    success: 'the awaited engine.save() outcome sets a terminal phase',
    failure: 'the same awaited outcome, reporting the failure',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      dependsOnFile: MSP_CLIENT,
      why:
        'engine.save() resolves off MSP requests, each bounded - the phase ' +
        'is set from an awaited result, never from a callback that may ' +
        'not arrive',
    },
    cancel: 'none while a write is in flight, by design; it ends either way',
  },
  {
    operation: 'Setup: the connection indicator',
    file: 'src/ui/components/setup/connectionIndicator.ts',
    entersBusy: 'it reports the coordinator ownership/identification states',
    success: 'the coordinator reports a settled state',
    failure: 'the coordinator reports a settled state',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'MSP_RESPONSE_TIMEOUT_MILLIS',
      dependsOnFile: MSP_CLIENT,
      why:
        'a pure read of coordinator state - it waits for nothing and ' +
        'renders whatever the bounded machinery underneath reports',
    },
    cancel: 'inherited from the session it describes',
  },
  {
    operation: 'Home: the connection phase type itself',
    file: 'src/ui/session/connectFlow.ts',
    entersBusy: 'useDirectConnect sets CHOOSING / OPENING / IDENTIFYING',
    success: 'CONNECTED (the wall opens the workspace)',
    failure: 'FAILED with an Arabic sentence, or IDLE for a cancelled chooser',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'IDENTIFY_DEADLINE_MS',
      dependsOnFile: 'src/ui/session/useDirectConnect.ts',
      why:
        'the type is pure data; the hook that owns it carries the deadline',
    },
    cancel: 'dismiss()',
  },
  {
    operation: 'Firmware: serial (STM32) flashing',
    file: 'src/platforms/react-native/protocol/Stm32SerialFlasher.ts',
    entersBusy: 'each read of the device is awaited',
    success: 'the expected bytes arrive',
    failure: 'the per-read timeout elapses',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'readExactly',
      dependsOnFile: 'src/platforms/react-native/protocol/ReactNativeSerialPort.ts',
      why:
        'every read carries an explicit timeout argument and the port ' +
        'computes a deadline from it - there is no unbounded read',
    },
    cancel: 'the flasher reports a terminal outcome; a flash is not resumable',
  },
  {
    operation:
      'Every configuration screen load and save (the shared choke point)',
    file: 'src/core/protocol/telemetry/MspOperationCoordinator.ts',
    entersBusy:
      "execute() pauses telemetry and waits for the scheduler to go idle",
    success: 'the scheduler settles and the operation is dispatched',
    failure:
      'the wait-for-idle deadline fires and the call returns SESSION_ENDED ' +
      'without dispatching anything',
    bound: {
      kind: 'DEADLINE',
      constant: 'WAIT_FOR_IDLE_TIMEOUT_MILLIS',
      file: 'src/core/protocol/telemetry/MspOperationCoordinator.ts',
    },
    cancel:
      'none while an exclusive write is in flight, by design - but the ' +
      'refusal to START one is itself the escape, and it releases the ' +
      'pause lease on the way out',
  },
  {
    operation: 'Web Serial: handing bytes to the browser driver',
    file:
      'src/platforms/react-native/transport/native/NativeUsbSerialTransport.web.ts',
    entersBusy: 'write() awaits each chunk the writer accepts',
    success: 'the writer resolves and the next chunk goes out',
    failure:
      'the per-chunk deadline fires, the writer is dropped so a late ' +
      'chunk cannot splice into the next frame, and WRITE_FAILED is thrown',
    bound: {
      kind: 'DEADLINE',
      constant: 'WEB_SERIAL_WRITE_TIMEOUT_MILLIS',
      file:
        'src/platforms/react-native/transport/native/NativeUsbSerialTransport.web.ts',
    },
    cancel:
      'closing the port errors the stream; Android has always had this ' +
      'bound natively (TX_WRITE_TIMEOUT_MILLIS)',
  },
  {
    operation: 'Motors: ending the test session from the sticky button',
    file: 'src/ui/screens/MotorsScreen.tsx',
    entersBusy: 'setEndingSession(true) around endMotorTestSessionSafely()',
    success: 'a CLOSED snapshot with a complete teardown resolves it',
    failure:
      'the teardown bound fires and it REJECTS, so the screen shows its ' +
      'existing close-failed banner instead of a spinner',
    bound: {
      kind: 'DEADLINE',
      constant: 'MOTOR_TEST_TEARDOWN_BOUND_MILLIS',
      file: 'src/ui/screens/MotorsScreen.tsx',
    },
    cancel:
      'none - a teardown must not be abandoned halfway; command authority ' +
      'is withdrawn before it starts and expiry fails closed, never ' +
      'claiming a motor stopped',
  },
  {
    operation: 'Firmware: talking to the cloud build server',
    file: 'src/core/firmware-flasher/buildApi.ts',
    entersBusy:
      'request() awaits headers, then the caller reads the body through ' +
      'readTextBounded / readBytesBounded',
    success: 'headers arrive AND the body is fully read under its size cap',
    failure:
      'either clock fires - headers, or a gap between body chunks - the ' +
      'request is aborted, and an Arabic message names which',
    bound: {
      kind: 'DEADLINE',
      constant: 'BUILD_API_RESPONSE_TIMEOUT_MILLIS',
      file: 'src/core/firmware-flasher/buildApi.ts',
    },
    cancel:
      "the flasher's own AbortController is linked into every request and " +
      'stays linked until the BODY read is over, so the Cancel button ' +
      'ends the wait at any point',
  },
  {
    operation: 'Any response body this application downloads',
    file: 'src/core/async/boundedBody.ts',
    entersBusy: 'a body read begins after the headers have arrived',
    success: 'the stream reaches done under the size cap',
    failure:
      'STALLED when a gap between chunks exceeds the bound, TOO_LARGE ' +
      'when the cap is crossed mid-stream, FAILED on a rejected read - ' +
      'and never a throw, so no caller can leave a branch unhandled',
    bound: {
      kind: 'DEADLINE',
      constant: 'MIN_BODY_THROUGHPUT_BYTES_PER_SECOND',
      file: 'src/core/async/boundedBody.ts',
    },
    cancel:
      "the caller's abort() is invoked on every non-success outcome, so " +
      'the transfer is torn down rather than abandoned and late bytes ' +
      'cannot reach an operation that already reported failure',
  },
  {
    operation: 'Presets: downloading the preset index and files',
    file: 'src/platforms/react-native/protocol/FirmwarePresetRepository.ts',
    entersBusy:
      'loadText() awaits headers, then reads the body through ' +
      'readTextBounded',
    success: 'headers arrive AND the text is fully read under its size cap',
    failure:
      'either clock fires - headers, or a gap between body chunks - the ' +
      'request is aborted and it throws an Arabic sentence',
    bound: {
      kind: 'DEADLINE',
      constant: 'PRESET_RESPONSE_TIMEOUT_MILLIS',
      file: 'src/platforms/react-native/protocol/FirmwarePresetRepository.ts',
    },
    cancel:
      'none mid-download; the screen reaches a terminal error and offers ' +
      'a retry',
  },
  {
    operation: 'Firmware: the save-to-file dialog',
    file: 'src/ui/screens/FirmwareFlasherScreen.tsx',
    entersBusy: "setOperation('saving' | 'backing-up')",
    success: 'the operator picks a location and the file is written',
    failure: 'the platform rejects, or the operator cancels',
    bound: {
      kind: 'OWNERSHIP',
      dependsOn: 'abortable',
      dependsOnFile: 'src/core/async/deadline.ts',
      why:
        'a file dialog is paced by a PERSON, so a deadline here would be ' +
        'the defect - the exit is cancel, and the wait is raced against ' +
        "the operation's AbortSignal so cancel actually ends it",
    },
    cancel:
      "the Cancel button - 'saving' is in canCancel precisely because " +
      'isBusy also blocks navigation off this screen',
  },
];

/**
 * Screens whose busy phase is bounded by the controller call they await.
 * Listed explicitly rather than matched by pattern: each one is a
 * DECISION that the screen has no timer of its own because it does not
 * need one, and a new screen must make that decision deliberately.
 */
const SCREEN_PHASE_FILES: readonly string[] = [
  'src/ui/screens/ModesScreen.tsx',
  'src/ui/screens/OsdScreen.tsx',
  'src/ui/screens/PortsScreen.tsx',
  'src/ui/screens/FailsafeScreen.tsx',
  'src/ui/screens/ConfigurationsScreen.tsx',
  'src/ui/screens/PowerBatteryScreen.tsx',
  'src/ui/screens/GpsScreen.tsx',
  'src/ui/screens/PidTuningScreen.tsx',
  'src/ui/screens/ReceiverScreen.tsx',
  'src/ui/screens/VideoTransmitterScreen.tsx',
  'src/ui/screens/MotorOutputMappingSection.tsx',
  'src/ui/screens/MotorOutputReorderPanel.tsx',
];

describe('the liveness contract is real, not aspirational', () => {
  it('every MSP request carries the deadline the other rows depend on', () => {
    const source = read(MSP_CLIENT);
    expect(source).toContain('export const MSP_RESPONSE_TIMEOUT_MILLIS');
    // A constant nobody arms is not a deadline - the timer must exist.
    expect(source).toMatch(/setTimeout\(/);
    expect(source).toMatch(/MSP_TIMEOUT/);
  });

  it.each(CONTRACT.map(row => [row.operation, row] as const))(
    '%s has a bound that exists in the source',
    (_operation, row) => {
      const source = read(row.file);
      expect(source.length).toBeGreaterThan(0);
      if (row.bound.kind === 'DEADLINE') {
        expect(read(row.bound.file)).toContain(row.bound.constant);
      } else {
        expect(read(row.bound.dependsOnFile)).toContain(row.bound.dependsOn);
      }
    },
  );

  it('every row says how the operator gets out, or why they cannot', () => {
    for (const row of CONTRACT) {
      expect(`${row.operation}: ${row.cancel}`).not.toBe(`${row.operation}: `);
      expect(row.success.length).toBeGreaterThan(0);
      expect(row.failure.length).toBeGreaterThan(0);
    }
  });

  /**
   * THE REBOOT LIFECYCLE'S DEADLINE MUST BE ARMED, not merely recorded.
   *
   * This is the specific shape of the defect that caused the hang: a
   * deadline field, an `expired()` helper, and nothing scheduled. The
   * assertion is on the mechanism, because the phase machine looked
   * perfectly correct without it.
   */
  it('the reboot lifecycle schedules its own deadline', () => {
    const source = read(
      'src/platforms/react-native/protocol/fcRebootRecovery.ts',
    );
    expect(source).toContain('scheduler.setTimeout');
    expect(source).toContain('scheduler.clearTimeout');
    // And it is re-synced from the one place every phase change goes
    // through, so no transition can forget it.
    expect(source).toMatch(/private set\([\s\S]*?this\.syncTimer\(\)/);
  });
});

/**
 * THE GUARD.
 *
 * Every production module that declares a busy phase must be accounted
 * for above. This is what makes the contract enforceable rather than a
 * document that goes stale: a new screen with a LOADING state fails here
 * until somebody says what ends it.
 */
describe('no busy state exists outside the contract', () => {
  const BUSY_MEMBER =
    /'(LOADING|SAVING|CONNECTING|RECONNECTING|IDENTIFYING|FLASHING|RESTORING|BACKING_UP|PREPARING|ENTERING|SENDING|CLOSING|ACTIVATING|WAITING_FOR_LINK|RUNNING)'/;

  function productionFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__testUtils__') {
            continue;
          }
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
          continue;
        }
        files.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    return files;
  }

  it('finds no declared busy phase that the contract does not cover', () => {
    const covered = new Set<string>([
      ...CONTRACT.map(row => row.file),
      ...CONTRACT.flatMap(row =>
        row.bound.kind === 'DEADLINE'
          ? [row.bound.file]
          : [row.bound.dependsOnFile],
      ),
      ...SCREEN_PHASE_FILES,
      /* Phase machines that are NOT user-visible waits, each named
         rather than pattern-excluded:
           the coordinator's own session bookkeeping, whose every wait is
           an MSP request; the app-state owner, which is driven by the OS
           foreground/background event and never waits for hardware; the
           telemetry scheduler, whose polls are MSP requests; the CLI
           phase enum re-exported through the protocol barrel. */
      'src/platforms/react-native/protocol/MspSessionCoordinator.ts',
      'src/platforms/react-native/protocol/setupAppStateTelemetryOwner.ts',
      'src/core/protocol/telemetry/MspTelemetryScheduler.ts',
      'src/platforms/react-native/protocol/index.ts',
      'src/core/protocol/index.ts',
      'src/core/index.ts',
    ]);

    const uncovered: string[] = [];
    for (const file of productionFiles()) {
      if (covered.has(file)) continue;
      const source = fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // A busy MEMBER inside a declared union - not a mention in prose,
      // and not a string used as a value somewhere unrelated.
      const declaresPhase =
        /type\s+\w*(Phase|Status|State)\w*\s*=\s*[\s\S]{0,400}?;/.test(source);
      if (!declaresPhase) continue;
      const declaration = source.match(
        /type\s+\w*(?:Phase|Status|State)\w*\s*=\s*[\s\S]{0,400}?;/g,
      );
      if (declaration === null) continue;
      if (!declaration.some(entry => BUSY_MEMBER.test(entry))) continue;
      uncovered.push(file);
    }

    expect(uncovered).toEqual([]);
  });

  it('lists no file in the contract that has since been deleted', () => {
    for (const file of [...CONTRACT.map(row => row.file), ...SCREEN_PHASE_FILES]) {
      expect(`${file}: ${fs.existsSync(path.join(ROOT, file))}`).toBe(
        `${file}: true`,
      );
    }
  });
});

/**
 * THE SECOND GUARD: A BUSY STATE MUST ALSO SURVIVE A REJECTION.
 *
 * A bound answers "what if the answer never comes". It does NOT answer
 * "what if the call throws instead of returning an outcome" - and that
 * was the larger of the two families found in this audit. Every screen
 * below awaits a controller that returns a discriminated outcome, so a
 * REJECTION was the case nobody wrote code for: `setPhase('SAVING')` had
 * already run, the throw skipped every line that would have cleared it,
 * and the sticky bar spun forever.
 *
 * The check is deliberately syntactic and deliberately narrow. It does
 * not try to prove a whole file correct; it looks for the two exact
 * shapes that produced the defect - an `await` on a controller with no
 * enclosing `try`, and a `.then(` chain with no `.catch(` - so a NEW
 * screen written in the old style fails here instead of shipping.
 */
describe('no screen can be left busy by a rejected controller call', () => {
  const CONTROLLER_AWAIT = /await\s+(\w*[Cc]ontroller|engine)\s*\.\s*\w+\(/g;
  const CONTROLLER_THEN = /\b(\w*[Cc]ontroller|engine)\s*\.\s*\w+\(/g;

  function stripped(file: string): string {
    return read(file)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * Character offsets that sit inside a `try { ... }` block.
   *
   * A brace-depth scan rather than a parser: when a `{` is opened by a
   * `try`, its depth is remembered, and every offset until the matching
   * `}` counts as guarded. Enough to tell the guarded form this codebase
   * uses from the unguarded one that shipped the defect.
   */
  function tryRanges(source: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const open: Array<{index: number; isTry: boolean}> = [];
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === '{') {
        const before = source.slice(Math.max(0, i - 8), i);
        open.push({index: i, isTry: /\btry\s*$/.test(before)});
      } else if (source[i] === '}') {
        const frame = open.pop();
        if (frame?.isTry === true) ranges.push([frame.index, i]);
      }
    }
    return ranges;
  }

  const inside = (ranges: Array<[number, number]>, at: number): boolean =>
    ranges.some(([from, to]) => at > from && at < to);

  /** Absolute index just past the `)` that closes the call opened at
   *  `openParen`, or -1 if the source is unbalanced. */
  function afterCall(source: string, openParen: number): number {
    let depth = 0;
    for (let i = openParen; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  const nextLink = (source: string, at: number) =>
    /^\s*\.\s*(then|catch|finally)\s*\(/.exec(source.slice(at, at + 64));

  /** `.then(...)` and then, eventually, `.catch(`. Walks each link on
   *  absolute indices so an argument containing the word "catch" cannot
   *  pass for one. */
  function thenChainIsCaught(source: string, openParen: number): boolean {
    let cursor = afterCall(source, openParen);
    for (let link = 0; link < 8 && cursor > 0; link += 1) {
      const next = nextLink(source, cursor);
      if (next === null) return false;
      if (next[1] === 'catch') return true;
      cursor = afterCall(source, cursor + next[0].length - 1);
    }
    return false;
  }

  it.each(SCREEN_PHASE_FILES.map(file => [file] as const))(
    '%s catches a rejected controller call instead of staying busy',
    file => {
      const source = stripped(file);
      const guarded = tryRanges(source);

      const bareAwaits = [...source.matchAll(CONTROLLER_AWAIT)]
        .filter(match => !inside(guarded, match.index))
        .filter(match => !thenChainIsCaught(source, match.index + match[0].length - 1))
        .map(match => match[0]);
      expect(`${file} awaits outside try`).toBe(
        `${file} awaits outside try${bareAwaits.length > 0 ? `: ${bareAwaits.join(' | ')}` : ''}`,
      );

      const uncaughtThens = [...source.matchAll(CONTROLLER_THEN)]
        .filter(match => {
          const callIndex = match.index + match[0].length - 1;
          const end = afterCall(source, callIndex);
          return end > 0 && /^\s*\.\s*then\s*\(/.test(source.slice(end, end + 32));
        })
        .filter(match => {
          const callIndex = match.index + match[0].length - 1;
          return !thenChainIsCaught(source, callIndex);
        })
        .map(match => match[0]);
      expect(`${file} uncaught .then chains`).toBe(
        `${file} uncaught .then chains${uncaughtThens.length > 0 ? `: ${uncaughtThens.join(' | ')}` : ''}`,
      );
    },
  );

  /**
   * A guard that cannot fail is decoration. This feeds it the two exact
   * source shapes that shipped the defect and requires it to object to
   * both, and the fixed shapes and requires it to accept them.
   */
  it('objects to the shapes that caused the defect, and accepts the fixes', () => {
    const brokenAwait = "setPhase('SAVING');\nconst outcome = await controller.save(k, a, b);\n";
    const brokenAwaitMatch = [...brokenAwait.matchAll(CONTROLLER_AWAIT)][0];
    expect(brokenAwaitMatch).toBeDefined();
    expect(inside(tryRanges(brokenAwait), brokenAwaitMatch.index)).toBe(false);

    const fixedAwait =
      "setPhase('SAVING');\nlet outcome;\ntry { outcome = await controller.save(k, a, b); } catch (e) { outcome = {kind:'FAILED'}; }\n";
    const fixedAwaitMatch = [...fixedAwait.matchAll(CONTROLLER_AWAIT)][0];
    expect(inside(tryRanges(fixedAwait), fixedAwaitMatch.index)).toBe(true);

    const brokenThen = "controller.load(key).then(outcome => { setPhase('READY'); });";
    const brokenThenMatch = [...brokenThen.matchAll(CONTROLLER_THEN)][0];
    expect(
      thenChainIsCaught(brokenThen, brokenThenMatch.index + brokenThenMatch[0].length - 1),
    ).toBe(false);

    const fixedThen =
      "controller.load(key).then(outcome => { setPhase('READY'); }).catch(() => { setPhase('ERROR'); });";
    const fixedThenMatch = [...fixedThen.matchAll(CONTROLLER_THEN)][0];
    expect(
      thenChainIsCaught(fixedThen, fixedThenMatch.index + fixedThenMatch[0].length - 1),
    ).toBe(true);
  });
});
