import {parseIntelHex} from '../../../core/firmware-flasher/intelHex';
import {insertCustomDefaults} from '../../../core/firmware-flasher/customDefaults';
import {
  FIXED_APPLICATION_BASE_ADDRESS,
  runImagePreflight,
} from '../../../core/firmware-flasher/imagePreflight';
import type {AcceptedImageSnapshot} from '../../../core/firmware-flasher/imagePreflight';
import {ReactNativeSerialPort} from './ReactNativeSerialPort';
import {Stm32BootloaderError, Stm32SerialFlasher} from './Stm32SerialFlasher';
import {createStm32Device, hexRecord, makeHexImage} from './__testUtils__/stm32Bootloader';
import type {Stm32DeviceConfig, Stm32Transcript} from './__testUtils__/stm32Bootloader';

/**
 * The screen's own composition order, condensed: compose the final image,
 * run the AUTHORITATIVE preflight on it, and only then let the flasher near
 * a transport. A rejection here happens with no port open, which is what
 * makes it impossible for an image-local fault to be discovered after the
 * board has already been erased.
 */
async function flashWithPreflight(
  hex: string,
  device: Stm32DeviceConfig = {},
): Promise<{
  transcript: Stm32Transcript;
  snapshot?: AcceptedImageSnapshot;
  error?: Error;
  rejections?: readonly {code: string; detail: string}[];
}> {
  const {client, transcript} = createStm32Device(device);
  const preflight = runImagePreflight(parseIntelHex(hex));
  if (!preflight.accepted) {
    return {transcript, rejections: preflight.rejections};
  }
  const port = new ReactNativeSerialPort(client, 7, 0);
  const flasher = new Stm32SerialFlasher(port);
  try {
    await flasher.flash(preflight.snapshot, {baudRate: 256000, fullErase: false});
    return {transcript, snapshot: preflight.snapshot};
  } catch (error) {
    return {transcript, snapshot: preflight.snapshot, error: error as Error};
  }
}

describe('image preflight rejects unencodable write plans BEFORE any erase', () => {
  it.each([1, 2, 3, 5, 253, 255, 257])(
    'a %i-byte image is refused and the device never sees an erase command',
    async length => {
      const outcome = await flashWithPreflight(makeHexImage(length));
      expect(outcome.rejections).toBeDefined();
      expect(outcome.rejections?.map(rejection => rejection.code)).toContain(
        'FLASH_PLAN_UNENCODABLE_BLOCK',
      );
      /* The proof that matters: nothing reached the wire at all. */
      expect(outcome.transcript.eraseCommandSent).toBe(false);
      expect(outcome.transcript.eraseAcknowledged).toBe(false);
      expect(outcome.transcript.commands).toEqual([]);
    },
  );

  it('refuses a MULTI-SEGMENT image whose second segment is unencodable', () => {
    const hex = [
      hexRecord(0x04, 0, [0x08, 0x00]),
      hexRecord(0x00, 0x0000, [1, 2, 3, 4]),
      hexRecord(0x00, 0x0100, [9, 9, 9]),
      hexRecord(0x01, 0, []),
    ].join('\n');
    const preflight = runImagePreflight(parseIntelHex(hex));
    expect(preflight.accepted).toBe(false);
    if (preflight.accepted) throw new Error('unreachable');
    expect(preflight.rejections.map(rejection => rejection.code)).toContain(
      'FLASH_PLAN_UNENCODABLE_BLOCK',
    );
  });

  it.each([4, 8, 256, 260])('accepts an aligned %i-byte image', length => {
    const preflight = runImagePreflight(parseIntelHex(makeHexImage(length)));
    expect(preflight.accepted).toBe(true);
    if (!preflight.accepted) throw new Error('unreachable');
    expect(preflight.snapshot.totalBytes).toBe(length);
    expect(preflight.snapshot.blocks.every(block => block.bytes.length % 4 === 0)).toBe(true);
    expect(preflight.snapshot.blocks.every(block => block.bytes.length <= 256)).toBe(true);
  });

  it('refuses an image that does not cover the fixed GO address', () => {
    const preflight = runImagePreflight(parseIntelHex(makeHexImage(64, 0x4000)));
    expect(preflight.accepted).toBe(false);
    if (preflight.accepted) throw new Error('unreachable');
    expect(preflight.rejections.map(rejection => rejection.code)).toContain(
      'FLASH_PLAN_GO_NOT_COVERED',
    );
  });

  it('refuses an image with a hole exactly at the GO address', () => {
    const hex = [
      hexRecord(0x04, 0, [0x08, 0x00]),
      hexRecord(0x00, 0x0010, [1, 2, 3, 4]),
      hexRecord(0x01, 0, []),
    ].join('\n');
    const preflight = runImagePreflight(parseIntelHex(hex));
    expect(preflight.accepted).toBe(false);
    if (preflight.accepted) throw new Error('unreachable');
    expect(preflight.rejections.map(rejection => rejection.code)).toContain(
      'FLASH_PLAN_GO_NOT_COVERED',
    );
  });
});

describe('the accepted plan is what goes on the wire', () => {
  it('write addresses, lengths, payload bytes and order match the plan exactly', async () => {
    const outcome = await flashWithPreflight(makeHexImage(768));
    expect(outcome.error).toBeUndefined();
    const snapshot = outcome.snapshot;
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) throw new Error('unreachable');

    const accepted = outcome.transcript.writes.filter(write => write.accepted);
    expect(accepted).toHaveLength(snapshot.blocks.length);
    accepted.forEach((write, index) => {
      const block = snapshot.blocks[index];
      expect(write.address).toBe(block.range.start);
      expect(write.bytes).toHaveLength(block.bytes.length);
      expect(write.bytes).toEqual(Array.from(block.bytes));
    });
    /* GO is the plan's address, proven covered - not a module constant. */
    expect(outcome.transcript.goAddress).toBe(FIXED_APPLICATION_BASE_ADDRESS);
    expect(snapshot.goCoverage.covered).toBe(true);
  });

  it('mutating the SOURCE image after the plan is built cannot change the wire', async () => {
    /* 64 bytes, not 256: a 256-byte block of this generator is a
      * permutation of every byte value, so no fill value would be free and
      * the test could not distinguish planned bytes from mutated ones. */
    const image = parseIntelHex(makeHexImage(64));
    const preflight = runImagePreflight(image);
    expect(preflight.accepted).toBe(true);
    if (!preflight.accepted) throw new Error('unreachable');
    const planned = Array.from(preflight.snapshot.blocks[0].bytes);

    /* A fill byte PROVEN absent from the planned bytes, so its appearance on
     * the wire could only come from the mutation. Picking a fixed constant
     * would be a coin flip: 0xA5 occurs naturally in this image. */
    const fill = [...Array(256).keys()].find(candidate => !planned.includes(candidate));
    expect(planned).toHaveLength(64);
    expect(fill).toBeDefined();
    if (fill === undefined) throw new Error('unreachable');

    /* Every source array is overwritten AFTER acceptance. A plan holding
     * subarray views rather than copies would transmit these bytes. */
    for (const segment of image.segments) segment.data.fill(fill);
    expect(Array.from(image.segments[0].data.slice(0, 4))).toEqual([fill, fill, fill, fill]);

    const {client, transcript} = createStm32Device();
    const port = new ReactNativeSerialPort(client, 7, 0);
    await new Stm32SerialFlasher(port).flash(preflight.snapshot, {
      baudRate: 256000,
      fullErase: false,
    });

    const accepted = transcript.writes.filter(write => write.accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].bytes).toEqual(planned);
    expect(accepted[0].bytes.some(byte => byte === fill)).toBe(false);
  });
});

describe('the authoritative preflight sees the image AFTER custom defaults', () => {
  /** 0x08002800 must hold the two little-endian region pointers. */
  function firmwareDeclaringCustomDefaults(regionBytes: number): string {
    const start = 0x08003000;
    const end = start + regionBytes;
    const pointer = [
      // eslint-disable-next-line no-bitwise -- little-endian pointer pair.
      ...[start, end].flatMap(value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]),
    ];
    return [
      hexRecord(0x04, 0, [0x08, 0x00]),
      hexRecord(0x00, 0x0000, [1, 2, 3, 4]),
      hexRecord(0x00, 0x2800, pointer),
      hexRecord(0x01, 0, []),
    ].join('\n');
  }

  it('accepts the base image but refuses it once an unaligned config tail is inserted', () => {
    const base = parseIntelHex(firmwareDeclaringCustomDefaults(4096));
    expect(runImagePreflight(base).accepted).toBe(true);

    /* The inserted region is a text blob whose length is not a multiple of
     * four, so the FINAL image is unwritable even though the file the
     * operator picked was fine. A preflight that ran at file-load time
     * would have missed this entirely. */
    const composed = insertCustomDefaults(base, ['set foo = 1']);
    const tail = composed.segments[composed.segments.length - 1];
    expect(tail.data.length % 4).not.toBe(0);

    const preflight = runImagePreflight(composed);
    expect(preflight.accepted).toBe(false);
    if (preflight.accepted) throw new Error('unreachable');
    expect(preflight.rejections.map(rejection => rejection.code)).toContain(
      'FLASH_PLAN_UNENCODABLE_BLOCK',
    );
    expect(preflight.rejections.some(rejection => rejection.detail.includes(String(tail.data.length)))).toBe(
      true,
    );
  });
});

describe('strict Get-ID shape', () => {
  /**
   * A SELF-CONSISTENT device: its declared N matches the body it sends, so
   * the stream stays in sync and the only question is whether the product
   * accepts a shape AN3155 does not document. It used to accept any reply
   * of two bytes or more and take the LAST TWO - so an N=2 device was read
   * as some other chip, and then erased.
   */
  it.each([0, 2, 3])('refuses a self-consistent N=%i reply before any erase', async countMinusOne => {
    const outcome = await flashWithPreflight(makeHexImage(4), {chipIdCountMinusOne: countMinusOne});
    expect(outcome.error).toBeInstanceOf(Stm32BootloaderError);
    expect((outcome.error as Stm32BootloaderError).code).toBe('STM32_GET_ID_SHAPE_INVALID');
    expect((outcome.error as Stm32BootloaderError).destructiveState).toBe('PRE_DESTRUCTIVE');
    expect(outcome.transcript.eraseCommandSent).toBe(false);
    expect(outcome.transcript.eraseAcknowledged).toBe(false);
  });

  it('accepts exactly N=1 with two product-id bytes', async () => {
    const outcome = await flashWithPreflight(makeHexImage(4), {chipIdCountMinusOne: 1});
    expect(outcome.error).toBeUndefined();
    expect(outcome.transcript.getIdReply).toEqual({countMinusOne: 1, bodyLength: 2});
    expect(outcome.transcript.eraseAcknowledged).toBe(true);
  });

  /**
   * A device whose declared N disagrees with the body it actually sends
   * desynchronises the stream. The engine cannot name that precisely - but
   * the safety property still has to hold: it must never reach an erase.
   */
  it.each([
    [1, 3],
    [1, 1],
    [2, 4],
  ])('never erases when a device declares N=%i but sends %i body bytes', async (countMinusOne, bodyLength) => {
    const outcome = await flashWithPreflight(makeHexImage(4), {
      chipIdCountMinusOne: countMinusOne,
      chipIdBodyLength: bodyLength,
    });
    expect(outcome.error).toBeDefined();
    expect(outcome.transcript.eraseCommandSent).toBe(false);
    expect(outcome.transcript.eraseAcknowledged).toBe(false);
  });
});
