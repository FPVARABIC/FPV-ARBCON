/**
 * WHAT THE OPERATOR IS TOLD WHEN A FLASH ENDS BADLY.
 *
 * Before this repair every STM32 serial failure rendered the same line -
 * "flash failed" plus the engine's own sentence - whether the board was
 * untouched or had just been erased and left blank. The board's state was
 * knowable; it simply never reached the screen.
 *
 * These tests mount the REAL screen over a virtual bootloader. Only two
 * seams are injected: file selection and the USB leaf. The screen, the
 * serial port, the flasher, the plan and the failure-state logic are all
 * the shipping code. The native module is a sentinel that throws on any
 * access, so no hardware path is reachable.
 *
 * TIMER MODE: real timers throughout.
 */
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`native leaf touched ("${String(property)}")`);
      },
    },
  ),
}));
jest.mock('../orientation3d', () => ({OrientationRenderer: () => null}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import i18n from '../../i18n';
import FirmwareFlasherScreen from './FirmwareFlasherScreen';
import {PROBLEM_FALLBACKS, operatorDetail} from './FirmwareFlasherSimpleScreen';
import {resolveFlashReason} from '../../core/firmware-flasher/flashErrorCodes';
import type {FlashTranslate} from '../../core/firmware-flasher/flashErrorCodes';
import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import {
  createStm32Device,
  makeHexImage,
} from '../../platforms/react-native/protocol/__testUtils__/stm32Bootloader';
import type {
  Stm32DeviceConfig,
  Stm32Transcript,
  Stm32WriteBarrier,
} from '../../platforms/react-native/protocol/__testUtils__/stm32Bootloader';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import {OperatorMessageError} from '../../core/firmware-flasher/operatorMessage';

type Renderer = ReactTestRenderer.ReactTestRenderer;

const IMAGE = makeHexImage(64);

/** The exact English sentence the MSP layer used to leak into the UI. */
const RAW_ENGLISH_MSP_TIMEOUT =
  'No matching MSP response arrived before the response timeout elapsed.';

function screenClient(
  hex: string,
  device: Stm32DeviceConfig,
): {client: UsbSerialTransportClient; transcript: Stm32Transcript} {
  const {client: serial, transcript} = createStm32Device(device);
  const bytes = Uint8Array.from([...hex].map(character => character.charCodeAt(0)));
  const client = {
    ...(serial as unknown as Record<string, unknown>),
    supportsDevicePicker: () => false,
    supportsDfuDevicePicker: () => false,
    listDevices: async () => [
      {
        deviceId: 7,
        vendorId: 0x0483,
        productId: 0x5740,
        productName: 'STM32 Virtual COM',
        manufacturerName: 'STMicroelectronics',
        driverType: 'CDC_ACM',
        portCount: 1,
      },
    ],
    listDfuDevices: async () => [],
    saveFirmwareFile: async () => true,
    pickFirmwareFile: async () => ({
      name: 'fixture.hex',
      sizeBytes: bytes.length,
      mimeType: 'application/octet-stream',
      dataBase64: bytesToBase64(bytes),
    }),
    cancelDfuFlash: async () => undefined,
    onDeviceAttached: () => () => undefined,
    onDeviceDetached: () => () => undefined,
    onDfuFlashProgress: () => () => undefined,
  } as unknown as UsbSerialTransportClient;
  return {client, transcript};
}

const offlineBuildApi = {loadTargets: async () => [], loadReleases: async () => []};

async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  });
}

/**
 * ORDERING WITHOUT A CLOCK.
 *
 * `settle(ms)` waits a duration. That is fine for "let the mount finish",
 * and wrong for "wait until the board has acknowledged the erase": the
 * second is a fact about the exchange, and asking the clock about it means
 * the test passes or fails according to how busy the machine is.
 *
 * COMPLETION WINS used to be written the second way, and it was
 * reproducible: idle it passed, and with twelve busy loops on four cores
 * it failed three times out of three with "flash failed" - because the
 * virtual board's 8 ms-per-write sleeps stretched until the flasher's own
 * ACK timeout fired. The attempt really did fail; the screen really was
 * right; the test was measuring the runner.
 *
 * These two helpers replace duration with condition. [flushUntil] yields
 * to the event loop and to React until a stated fact is true, bounded by a
 * count of TURNS rather than milliseconds - so a loaded machine takes
 * longer to arrive and arrives at the same answer. `setImmediate` is a
 * yield, not a sleep: it fires on the next loop iteration whatever the
 * load, and no timeout can be outrun by it.
 */
const TURN_BUDGET = 5_000;

async function flushUntil(predicate: () => boolean, expectation: string): Promise<void> {
  for (let turn = 0; turn < TURN_BUDGET; turn += 1) {
    if (predicate()) return;
    // The loop IS the wait: each turn yields once and re-asks.
    await act(async () => {
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    });
  }
  throw new Error(
    `flushUntil gave up after ${TURN_BUDGET} turns waiting for: ${expectation}. ` +
      'This is a real stall, not slowness - the budget counts event-loop turns, not time.',
  );
}

/**
 * A hold the test can place on the virtual board's next write, and lift
 * when it chooses. While held the flash attempt is genuinely mid-exchange:
 * the erase is already on the wire and answered, and the write that would
 * finish the image has not been consumed.
 *
 * This is the cancel window the old test bought with sleeps, expressed as
 * a fact instead of a duration.
 */
function createWriteHold(): {
  barrier: Stm32WriteBarrier;
  holdWhen: (condition: () => boolean) => void;
  isHolding: () => boolean;
  release: () => void;
  writesConsumed: () => number;
} {
  /**
   * THE DEVICE STOPS ITSELF. The test does not race it.
   *
   * An earlier attempt had the test arm the hold after observing the
   * erase acknowledgement, and it could not work: with the sleeps gone
   * the whole flash finishes between two of the test's own statements, so
   * there was nothing left to hold and flushUntil correctly reported a
   * stall. Handing the CONDITION to the barrier removes the race - the
   * board pauses at the first write after the condition is true, however
   * fast or slow everything around it runs.
   */
  let condition: () => boolean = () => false;
  let holding = false;
  let consumed = 0;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  let released = false;

  return {
    barrier: {
      async beforeWrite() {
        if (!released && condition()) {
          if (gate === undefined) {
            gate = new Promise<void>(resolve => {
              open = resolve;
            });
          }
          holding = true;
          await gate;
          holding = false;
        }
        consumed += 1;
      },
    },
    holdWhen(next: () => boolean) {
      condition = next;
    },
    isHolding: () => holding,
    writesConsumed: () => consumed,
    release() {
      released = true;
      open?.();
      open = undefined;
      gate = undefined;
    },
  };
}

function hostsWithTestId(renderer: Renderer, testID: string): ReactTestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node => node.props?.testID === testID && typeof node.type === 'string',
    {deep: true},
  );
}

function textOf(node: ReactTestRenderer.ReactTestInstance): string {
  const flatten = (value: unknown): string => {
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'object' && 'props' in (value as {props?: unknown})) {
      return flatten((value as {props: {children?: unknown}}).props.children);
    }
    return String(value);
  };
  return flatten(node.props.children).trim();
}

function readTestId(renderer: Renderer, testID: string): string | undefined {
  const found = hostsWithTestId(renderer, testID);
  return found.length === 0 ? undefined : textOf(found[found.length - 1]);
}

function allText(renderer: Renderer): string[] {
  return renderer.root.findAllByType(Text).map(textOf).filter(line => line.length > 0);
}

function press(renderer: Renderer, testID: string): boolean {
  const found = renderer.root.findAll(
    node => node.props?.testID === testID && typeof node.props?.onPress === 'function',
    {deep: true},
  );
  if (found.length === 0) return false;
  act(() => {
    found[0].props.onPress();
  });
  return true;
}

function pressLabel(renderer: Renderer, label: string): boolean {
  const found = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function' &&
      node.props?.disabled !== true,
    {deep: true},
  );
  if (found.length === 0) return false;
  act(() => {
    found[0].props.onPress();
  });
  return true;
}

/**
 * Drives the real screen, by press only, to the manual-bootloader route -
 * i.e. ready to start a flash. Deliberately NOT named `arm`: in this
 * project that word means arming motors, and nothing here goes near it.
 */
async function mountReadyToFlash(client: UsbSerialTransportClient): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <FirmwareFlasherScreen client={client} buildApi={offlineBuildApi as never} />,
    );
  });
  await settle();
  expect(press(renderer, 'firmware-source-local')).toBe(true);
  await settle();
  expect(press(renderer, 'pick-local-firmware')).toBe(true);
  await settle(120);
  expect(press(renderer, 'hex-method-serial')).toBe(true);
  await settle();
  expect(press(renderer, 'toggle-advanced-flash-options')).toBe(true);
  await settle();
  expect(pressLabel(renderer, "Zonder herstartprocedure")).toBe(true);
  await settle();
  expect(press(renderer, 'confirm-props-removed')).toBe(true);
  expect(press(renderer, 'confirm-usb-power-only')).toBe(true);
  await settle();
  expect(pressLabel(renderer, "Ik heb de Target en bootloader handmatig gecontroleerd.")).toBe(true);
  await settle();
  return renderer;
}

async function runToTerminal(
  device: Stm32DeviceConfig,
  hex = IMAGE,
): Promise<{renderer: Renderer; transcript: Stm32Transcript}> {
  const {client, transcript} = screenClient(hex, device);
  const renderer = await mountReadyToFlash(client);
  expect(press(renderer, 'start-safe-flash')).toBe(true);
  await settle(500);
  return {renderer, transcript};
}

async function unmount(renderer: Renderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

describe('post-erase disclosure', () => {
  it('a PRE-erase refusal says what went wrong and adds NO erase advisory', async () => {
    const {renderer, transcript} = await runToTerminal({chipIdCountMinusOne: 2});
    expect(transcript.eraseCommandSent).toBe(false);
    expect(readTestId(renderer, 'flash-result-title')).toBe("✕ Flashen mislukt");
    expect(readTestId(renderer, 'flash-result-reason')).toBe(
      i18n.t('firmwareFlasher.reason.STM32_GET_ID_SHAPE_INVALID'),
    );
    expect(hostsWithTestId(renderer, 'flash-result-recovery')).toHaveLength(0);
    await unmount(renderer);
  });

  it('a CONFIRMED post-erase failure keeps the reason AND adds the erased advisory', async () => {
    const {renderer, transcript} = await runToTerminal({faultAt: 'WRITE_DATA'});
    expect(transcript.eraseAcknowledged).toBe(true);
    /* The cause is still visible - the advisory is additional, not a
     * replacement reason code. */
    expect(readTestId(renderer, 'flash-result-reason')).toBe(
      i18n.t('firmwareFlasher.reason.STM32_NACK'),
    );
    expect(readTestId(renderer, 'flash-result-recovery')).toBe(
      i18n.t('firmwareFlasher.recovery.ERASE_CONFIRMED'),
    );
    await unmount(renderer);
  });

  it('an UNCERTAIN erase outcome says so, and does not claim the board is safe', async () => {
    const {renderer, transcript} = await runToTerminal({faultAt: 'ERASE_PAYLOAD_NACK'});
    expect(transcript.erasePayloadBytes).not.toBeNull();
    expect(transcript.eraseAcknowledged).toBe(false);
    expect(readTestId(renderer, 'flash-result-recovery')).toBe(
      i18n.t('firmwareFlasher.recovery.ERASE_UNCERTAIN'),
    );
    expect(readTestId(renderer, 'flash-result-recovery')).not.toBe(
      i18n.t('firmwareFlasher.recovery.ERASE_CONFIRMED'),
    );
    await unmount(renderer);
  });

  it('an erase COMMAND refusal is not destructive and carries no advisory', async () => {
    const {renderer, transcript} = await runToTerminal({faultAt: 'ERASE_COMMAND'});
    expect(transcript.eraseCommandSent).toBe(true);
    expect(transcript.erasePayloadBytes).toBeNull();
    expect(hostsWithTestId(renderer, 'flash-result-recovery')).toHaveLength(0);
    await unmount(renderer);
  });

  it('a completed flash still succeeds, with the same ERASE/WRITE/GO transcript', async () => {
    const {renderer, transcript} = await runToTerminal({});
    expect(readTestId(renderer, 'flash-result-title')).toBe(
      "✓ Firmware geschreven en geverifieerd",
    );
    expect(transcript.events).toEqual(
      expect.arrayContaining(['SYNC', 'GET', 'GET_ID', 'ERASE_CMD', 'ERASE_DONE', 'GO_ADDR']),
    );
    expect(transcript.goAddress).toBe(0x08000000);
    expect(hostsWithTestId(renderer, 'flash-result-recovery')).toHaveLength(0);
    await unmount(renderer);
  });
});

describe('cancellation at the destructive boundary', () => {
  it('cancelling BEFORE any erase aborts immediately, with no confirmation', async () => {
    const {client, transcript} = screenClient(IMAGE, {faultAt: 'ERASE_PAYLOAD_SILENT'});
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    /* No settle: the attempt has not reached the wire yet. */
    expect(press(renderer, 'cancel-firmware-operation')).toBe(true);
    await settle(200);
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(0);
    expect(transcript.eraseAcknowledged).toBe(false);
    await unmount(renderer);
  });

  it('cancelling AFTER the erase request went out demands an explicit confirmation', async () => {
    const {client, transcript} = screenClient(IMAGE, {faultAt: 'ERASE_PAYLOAD_SILENT'});
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await settle(120);
    expect(transcript.erasePayloadBytes).not.toBeNull();

    expect(press(renderer, 'cancel-firmware-operation')).toBe(true);
    await settle();
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(1);
    expect(readTestId(renderer, 'cancel-flash-confirm-body')).toBe(
      i18n.t('firmwareFlasher.cancelConfirm.body'),
    );

    expect(press(renderer, 'cancel-flash-confirm-accept')).toBe(true);
    await settle(300);
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(0);
    /* The advisory comes from the FINAL outcome, not from the state
     * captured when the ticket was issued. */
    expect(readTestId(renderer, 'flash-result-recovery')).toBe(
      i18n.t('firmwareFlasher.recovery.ERASE_UNCERTAIN'),
    );
    await unmount(renderer);
  }, 60_000);

  it('dismissing the confirmation lets the attempt continue to its own end', async () => {
    const {client, transcript} = screenClient(IMAGE, {faultAt: 'WRITE_DATA', writeDelayMs: 6});
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await settle(60);
    if (hostsWithTestId(renderer, 'cancel-firmware-operation').length > 0) {
      press(renderer, 'cancel-firmware-operation');
    }
    await settle();
    if (hostsWithTestId(renderer, 'cancel-flash-confirm').length > 0) {
      expect(press(renderer, 'cancel-flash-dismiss')).toBe(true);
    }
    await settle(600);
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(0);
    /* The board really was erased, and the screen says so. */
    expect(transcript.eraseAcknowledged).toBe(true);
    expect(readTestId(renderer, 'flash-result-recovery')).toBe(
      i18n.t('firmwareFlasher.recovery.ERASE_CONFIRMED'),
    );
    await unmount(renderer);
  }, 60_000);

  /**
   * The four moments this case is about, each reached as a FACT rather
   * than after a duration:
   *
   *   1. erase request emitted            transcript.eraseCommandSent
   *   2. erase acknowledgement received   transcript.eraseAcknowledged
   *   4. cancellation question delivered  the dialog is on screen, while
   *                                       the board is held mid-write
   *   3. completion committed             the hold is lifted and the
   *                                       attempt settles
   *
   * Numbered as the brief numbers them; 4 deliberately happens before 3,
   * because the whole claim is that a completion arriving WHILE the
   * question is up wins over the question.
   *
   * The two closing assertions are unchanged from the wall-clock version.
   * Everything above them is new and strictly stronger: the old test only
   * hoped the dialog had been open at the right moment, and this one
   * requires it.
   */
  it('COMPLETION WINS: a flash that finishes while the dialog is open keeps its success', async () => {
    const hold = createWriteHold();
    const {client, transcript} = screenClient(IMAGE, {writeBarrier: hold.barrier});
    // The board stops itself at the first write after it has acknowledged
    // the erase, so moments 1 and 2 are behind us whenever the hold engages.
    hold.holdWhen(() => transcript.eraseAcknowledged);
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);

    // Hold the exchange open. The attempt is now genuinely in flight and
    // cannot finish until this test lets it.
    await flushUntil(() => hold.isHolding(), 'the board to be held mid-write');

    // 1 and 2, now facts rather than hopes. Nothing below is a claim about
    // a board that was never asked to erase.
    expect(transcript.eraseCommandSent).toBe(true);
    expect(transcript.eraseAcknowledged).toBe(true);
    const writesBeforeTheQuestion = hold.writesConsumed();

    // 4. The question is asked while the attempt is still running.
    expect(press(renderer, 'cancel-firmware-operation')).toBe(true);
    await flushUntil(
      () => hostsWithTestId(renderer, 'cancel-flash-confirm').length === 1,
      'the cancel confirmation to appear',
    );
    expect(hold.isHolding()).toBe(true);
    expect(readTestId(renderer, 'flash-result-title')).toBeUndefined();

    // 3. Completion is committed while that question is still on screen.
    hold.release();
    await flushUntil(
      () => readTestId(renderer, 'flash-result-title') !== undefined,
      'the attempt to settle',
    );
    expect(hold.writesConsumed()).toBeGreaterThan(writesBeforeTheQuestion);

    /* The attempt settled while the question was on screen: the dialog is
     * gone and the real outcome stands. */
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(0);
    expect(readTestId(renderer, 'flash-result-title')).toBe(
      "✓ Firmware geschreven en geverifieerd",
    );
    await unmount(renderer);
  }, 60_000);

  it('unmounting while the confirmation is open updates no state afterwards', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const {client} = screenClient(IMAGE, {faultAt: 'ERASE_PAYLOAD_SILENT'});
      const renderer = await mountReadyToFlash(client);
      expect(press(renderer, 'start-safe-flash')).toBe(true);
      await settle(120);
      press(renderer, 'cancel-firmware-operation');
      await settle();
      await unmount(renderer);
      await settle(200);
      expect(
        errors.filter(line => /not wrapped in act|unmounted component/.test(line)),
      ).toEqual([]);
    } finally {
      console.error = original;
    }
  }, 60_000);
});

/**
 * THE CONFIRMATION DIALOG'S SAFE DEFAULT.
 *
 * Focus, Escape and Enter are DOM behaviours and are measured in Chromium
 * by the touch-target gate's `flasher-cancel` scene - react-test-renderer
 * has no document to focus. What this renderer can prove is the part that
 * decides safety rather than ergonomics: which way the dialog falls when
 * it is closed without an answer, and that the destructive control is
 * never the one a stray keypress would reach first.
 */
describe('the destructive confirmation falls the safe way', () => {
  it('Android Back / onRequestClose takes the DISMISS path, never the destructive one', async () => {
    const {client, transcript} = screenClient(IMAGE, {faultAt: 'ERASE_PAYLOAD_SILENT'});
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await settle(120);
    expect(transcript.erasePayloadBytes).not.toBeNull();
    expect(press(renderer, 'cancel-firmware-operation')).toBe(true);
    await settle();
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(1);

    const modals = renderer.root.findAll(
      node => typeof node.props?.onRequestClose === 'function' && node.props?.transparent === true,
      {deep: true},
    );
    expect(modals.length).toBeGreaterThan(0);
    /* The close request is wired to the same handler as «متابعة التفليش». */
    const dismiss = renderer.root.findAll(
      node => node.props?.testID === 'cancel-flash-dismiss' && typeof node.props?.onPress === 'function',
      {deep: true},
    );
    expect(dismiss.length).toBeGreaterThan(0);
    expect(modals[modals.length - 1].props.onRequestClose).toBe(dismiss[0].props.onPress);

    /* And it is NOT the destructive action. */
    const confirm = renderer.root.findAll(
      node => node.props?.testID === 'cancel-flash-confirm-accept' && typeof node.props?.onPress === 'function',
      {deep: true},
    );
    expect(confirm.length).toBeGreaterThan(0);
    expect(modals[modals.length - 1].props.onRequestClose).not.toBe(confirm[0].props.onPress);

    /* Answering nothing leaves the board's outcome unknown, which is the
     * state this dialog exists to disclose. */
    expect(press(renderer, 'cancel-flash-dismiss')).toBe(true);
    await settle();
    expect(hostsWithTestId(renderer, 'cancel-flash-confirm')).toHaveLength(0);
    await unmount(renderer);
  }, 60_000);

  it('only the SAFE action is given a focus handle; the destructive one is not', async () => {
    const {client, transcript} = screenClient(IMAGE, {faultAt: 'ERASE_PAYLOAD_SILENT'});
    const renderer = await mountReadyToFlash(client);
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await settle(120);
    expect(transcript.erasePayloadBytes).not.toBeNull();
    expect(press(renderer, 'cancel-firmware-operation')).toBe(true);
    await settle();

    const withRef = (testID: string): boolean =>
      renderer.root.findAll(
        node => node.props?.testID === testID && node.props?.buttonRef !== undefined,
        {deep: true},
      ).length > 0;
    expect(withRef('cancel-flash-dismiss')).toBe(true);
    expect(withRef('cancel-flash-confirm-accept')).toBe(false);

    expect(press(renderer, 'cancel-flash-dismiss')).toBe(true);
    await settle();
    await unmount(renderer);
  }, 60_000);
});

describe('localized failure text', () => {
  it('renders the Arabic sentence for a KNOWN code and never the raw English one', async () => {
    const {renderer} = await runToTerminal({faultAt: 'ERASE_COMMAND'});
    const reason = readTestId(renderer, 'flash-result-reason');
    expect(reason).toBe(i18n.t('firmwareFlasher.reason.STM32_NACK'));
    expect(reason).not.toBe(RAW_ENGLISH_MSP_TIMEOUT);
    /* Latin technical tokens such as STM32, MSP, USB and Firmware are
     * legitimate; only the raw engine sentence is forbidden. */
    expect(allText(renderer)).not.toContain(RAW_ENGLISH_MSP_TIMEOUT);
    await unmount(renderer);
  });

  it('resolves the shared errors.<code> namespace, and errors.UNKNOWN for anything else', () => {
    /* The MSP layer's codes already had Arabic; the flasher simply never
     * looked there. These are the exact catalogue strings. */
    expect(i18n.t('errors.MSP_TIMEOUT')).toBe(
      "Het wachten op een reactie van de vliegbesturing is voorbij.",
    );
    expect(i18n.t('errors.UNKNOWN')).toBe("Er is een onverwachte fout tijdens de oproep.");
    expect(i18n.t('errors.MSP_TIMEOUT')).not.toBe(RAW_ENGLISH_MSP_TIMEOUT);
  });

  /**
   * THE CHAIN ITSELF, step by step. Asserting the catalogue strings exist
   * is not the same as asserting the resolver reaches them: a resolver that
   * only ever consulted its own namespace would satisfy every assertion
   * above and still leave every MSP code untranslated on this screen.
   */
  it('the resolver walks flasher key -> shared errors.<code> -> UNKNOWN', () => {
    const t: FlashTranslate = (key, options) => i18n.t(key, options);

    /* Step 1 - a flasher-specific sentence wins outright. */
    expect(resolveFlashReason(t, 'STM32_NACK')).toBe(
      i18n.t('firmwareFlasher.reason.STM32_NACK'),
    );

    /* Step 2 - MSP_TIMEOUT deliberately has NO flasher-specific key, so
     * this passes only if the shared namespace is really consulted. */
    expect(i18n.t('firmwareFlasher.reason.MSP_TIMEOUT', {defaultValue: ''})).toBe('');
    expect(resolveFlashReason(t, 'MSP_TIMEOUT')).toBe(i18n.t('errors.MSP_TIMEOUT'));

    /* Step 3 - neither namespace answers: a LOCALIZED unknown, never the
     * raw exception text, and never an empty string. */
    expect(resolveFlashReason(t, 'NOT_A_REAL_CODE')).toBe(i18n.t('errors.UNKNOWN'));
    expect(resolveFlashReason(t, undefined)).toBe(i18n.t('errors.UNKNOWN'));
    expect(resolveFlashReason(t, '')).toBe(i18n.t('errors.UNKNOWN'));
  });

  /**
   * THE OTHER FLASHER SURFACE. `operatorDetail` is what the simple screen
   * puts under a problem heading, and the flasher-engine codes are new to
   * it: before this repair the STM32 engine and the raw serial port raised
   * uncoded errors, so an English fragment fell through to a generic
   * category sentence and the operator was told nothing specific.
   */
  it('the SIMPLE screen resolves the same flasher codes, in the same order', () => {
    /* 1. flasher-specific key wins. */
    expect(operatorDetail({code: 'STM32_GET_ID_SHAPE_INVALID'}, 'SERIAL')).toBe(
      i18n.t('firmwareFlasher.reason.STM32_GET_ID_SHAPE_INVALID'),
    );
    expect(operatorDetail({code: 'FLASH_PLAN_UNENCODABLE_BLOCK'}, 'PREPARE')).toBe(
      i18n.t('firmwareFlasher.reason.FLASH_PLAN_UNENCODABLE_BLOCK'),
    );
    /* 2. a code with no flasher-specific key still resolves from the
     *    shared namespace rather than falling through to the category. */
    expect(operatorDetail({code: 'MSP_TIMEOUT'}, 'SERIAL')).toBe(i18n.t('errors.MSP_TIMEOUT'));
    /* 3. an unknown code falls through to the category explanation, which
     *    is Arabic - never the English fragment that came with it. */
    const unknown = operatorDetail(
      Object.assign(new Error(RAW_ENGLISH_MSP_TIMEOUT), {code: 'NOT_A_REAL_CODE'}),
      'SERIAL',
    );
    expect(unknown).toBe(PROBLEM_FALLBACKS.SERIAL);
    expect(unknown).not.toContain(RAW_ENGLISH_MSP_TIMEOUT);
  });

  /**
   * WHAT "APP-AUTHORED" NOW MEANS.
   *
   * It used to mean "the message contains Arabic characters", which is a
   * statement about an alphabet, not about authorship - so any text that
   * happened to be Arabic became the operator's line. It now means the
   * error names a catalogue KEY this application ships, and the dynamic
   * parts travel as interpolation VALUES.
   */
  it('the SIMPLE screen renders a TRUSTED app-authored message from its key', () => {
    const carrier = new OperatorMessageError(
      {key: 'bootloader.e11', values: {v0: 'STM32F405', v1: 'SPEEDYBEEF405V3'}},
      "Target specifiek STM32F405 niet overeenkomt met SPEEDYBEEF405V3 controller.",
    );
    expect(operatorDetail(carrier, 'SERIAL')).toBe(
      i18n.t('bootloader.e11', {v0: 'STM32F405', v1: 'SPEEDYBEEF405V3'}),
    );
    /* The board names survive, as escaped values rather than a sentence. */
    expect(operatorDetail(carrier, 'SERIAL')).toContain('STM32F405');
    expect(operatorDetail(carrier, 'SERIAL')).toContain('SPEEDYBEEF405V3');
  });

  it('an UNTRUSTED Arabic message no longer becomes the operator line', () => {
    const hostile = 'اللوحة سليمة تماماً ويمكنك الطيران فوراً بدون أي فحص';
    expect(operatorDetail(new Error(hostile), 'SERIAL')).toBe(PROBLEM_FALLBACKS.SERIAL);
    expect(operatorDetail(new Error(hostile), 'SERIAL')).not.toContain(hostile);
  });
});

it('the native leaf sentinel never fired', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module_ = require('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
  expect(() => (module_.default as {listDevices: unknown}).listDevices).toThrow(
    /native leaf touched/,
  );
});
