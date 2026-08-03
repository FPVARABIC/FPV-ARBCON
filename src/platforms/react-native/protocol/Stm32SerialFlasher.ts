import type {IntelHexImage} from '../../../core/firmware-flasher';

const ACK = 0x79;
const NACK = 0x1f;
const FLASH_START = 0x08000000;

const COMMAND = {
  get: 0x00,
  getId: 0x02,
  read: 0x11,
  go: 0x21,
  write: 0x31,
  erase: 0x43,
  extendedErase: 0x44,
} as const;

type ChipProfile = {readonly flashBytes: number; readonly pageBytes: number; readonly label: string};
const CHIP_PROFILES: Readonly<Record<number, ChipProfile>> = {
  0x410: {flashBytes: 128 * 1024, pageBytes: 1024, label: 'STM32F1 Medium Density'},
  0x414: {flashBytes: 256 * 1024, pageBytes: 2048, label: 'STM32F1 High Density'},
  0x422: {flashBytes: 256 * 1024, pageBytes: 2048, label: 'STM32F3'},
};

export type Stm32FlashProgress = {
  readonly phase: 'connecting' | 'erasing' | 'writing' | 'verifying' | 'rebooting' | 'complete';
  readonly percent: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
};

export interface Stm32SerialChannel {
  connect(baud: number, options?: Partial<SerialOptions>): Promise<void>;
  disconnect(): Promise<void>;
  writeRaw(data: Uint8Array): Promise<void>;
  readExactly(length: number, timeout: number): Promise<Uint8Array>;
  flushInput(): void;
}

export class Stm32BootloaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Stm32BootloaderError';
  }
}

export function assertRequiredStm32Commands(commands: ReadonlySet<number>): void {
  for (const required of [COMMAND.write, COMMAND.read, COMMAND.go]) {
    if (!commands.has(required)) {
      throw new Stm32BootloaderError(
        `STM32 bootloader لا يدعم الأمر الآمن المطلوب 0x${required.toString(16)}؛ لن يبدأ المسح.`,
      );
    }
  }
  if (!commands.has(COMMAND.erase) && !commands.has(COMMAND.extendedErase)) {
    throw new Stm32BootloaderError('STM32 bootloader لا يعلن أي أمر مسح مدعوم.');
  }
}

export class Stm32SerialFlasher {
  constructor(
    private readonly channel: Stm32SerialChannel,
    private readonly signal?: AbortSignal,
    private readonly onProgress: (progress: Stm32FlashProgress) => void = () => undefined,
  ) {}

  async flash(image: IntelHexImage, options: {baudRate: number; fullErase: boolean}): Promise<void> {
    this.report('connecting', 0, 0, image.totalBytes);
    await this.channel.connect(options.baudRate, {dataBits: 8, stopBits: 1, parity: 'even', flowControl: 'none'});
    try {
      this.channel.flushInput();
      await this.synchronize();
      const commands = await this.getCommands();
      // Critical ordering: verify/read/go support before any destructive erase command.
      assertRequiredStm32Commands(commands);
      const chipId = await this.getChipId();
      const profile = CHIP_PROFILES[chipId];
      if (profile === undefined) {
        throw new Stm32BootloaderError(`STM32 chip ID 0x${chipId.toString(16)} غير مدعوم بأمان.`);
      }
      this.validateImage(image, profile);
      await this.erase(image, profile, commands.has(COMMAND.extendedErase), options.fullErase);
      await this.writeAndVerify(image);
      this.report('rebooting', 99, image.totalBytes, image.totalBytes);
      await this.command(COMMAND.go);
      // STM32 ROM GO is intentionally sent to the flash vector-table base,
      // as Betaflight Configurator does. Intel HEX type-05 can describe the
      // reset-handler PC, which is not a substitute for the vector table.
      await this.sendAddress(FLASH_START);
      this.report('complete', 100, image.totalBytes, image.totalBytes);
    } finally {
      await this.channel.disconnect().catch(() => undefined);
    }
  }

  private async synchronize(): Promise<void> {
    this.checkCancelled();
    await this.channel.writeRaw(Uint8Array.of(0x7f));
    let response = (await this.channel.readExactly(1, 3000))[0];
    // Some FC serial bridges echo the autobaud byte; consume exactly that echo once.
    if (response === 0x7f) response = (await this.channel.readExactly(1, 3000))[0];
    this.expectAck(response, 'المزامنة');
  }

  private async getCommands(): Promise<ReadonlySet<number>> {
    await this.command(COMMAND.get);
    const countMinusOne = (await this.channel.readExactly(1, 3000))[0];
    const body = await this.channel.readExactly(countMinusOne + 1, 3000);
    await this.readAck('قراءة قدرات bootloader');
    // First byte is the bootloader version; the rest are supported commands.
    return new Set(Array.from(body.slice(1)));
  }

  private async getChipId(): Promise<number> {
    await this.command(COMMAND.getId);
    const countMinusOne = (await this.channel.readExactly(1, 3000))[0];
    const id = await this.channel.readExactly(countMinusOne + 1, 3000);
    await this.readAck('قراءة chip ID');
    if (id.length < 2) throw new Stm32BootloaderError('استجابة STM32 chip ID قصيرة.');
    return (id[id.length - 2] << 8) | id[id.length - 1];
  }

  private validateImage(image: IntelHexImage, profile: ChipProfile): void {
    const end = FLASH_START + profile.flashBytes;
    if (image.totalBytes >= profile.flashBytes) {
      throw new Stm32BootloaderError(`حجم Firmware لا يلائم ${profile.label}.`);
    }
    for (const segment of image.segments) {
      if (segment.address < FLASH_START || segment.address + segment.data.length > end) {
        throw new Stm32BootloaderError('عنوان HEX خارج Flash المعلن لهذا STM32.');
      }
    }
  }

  private async erase(
    image: IntelHexImage,
    profile: ChipProfile,
    extended: boolean,
    fullErase: boolean,
  ): Promise<void> {
    this.report('erasing', 2, 0, image.totalBytes);
    const pageCount = Math.ceil((image.highestAddressExclusive - FLASH_START) / profile.pageBytes);
    if (extended) {
      await this.command(COMMAND.extendedErase);
      if (fullErase) {
        await this.sendAndAck(Uint8Array.of(0xff, 0xff, 0x00), 'المسح الكامل', 30_000);
      } else {
        const bytes: number[] = [(pageCount - 1) >> 8, (pageCount - 1) & 0xff];
        let checksum = bytes[0] ^ bytes[1];
        for (let page = 0; page < pageCount; page += 1) {
          bytes.push(page >> 8, page & 0xff);
          checksum ^= page >> 8;
          checksum ^= page & 0xff;
        }
        bytes.push(checksum);
        await this.sendAndAck(Uint8Array.from(bytes), 'المسح الانتقائي الممتد', 30_000);
      }
    } else {
      if (pageCount > 256) throw new Stm32BootloaderError('عدد الصفحات يتطلب Extended Erase غير المتوفر.');
      await this.command(COMMAND.erase);
      if (fullErase) {
        await this.sendAndAck(Uint8Array.of(0xff, 0x00), 'المسح الكامل', 30_000);
      } else {
        const bytes: number[] = [pageCount - 1];
        let checksum = pageCount - 1;
        for (let page = 0; page < pageCount; page += 1) {
          bytes.push(page);
          checksum ^= page;
        }
        bytes.push(checksum);
        await this.sendAndAck(Uint8Array.from(bytes), 'المسح الانتقائي', 30_000);
      }
    }
    this.report('erasing', 15, 0, image.totalBytes);
  }

  private async writeAndVerify(image: IntelHexImage): Promise<void> {
    let written = 0;
    for (const segment of image.segments) {
      for (let offset = 0; offset < segment.data.length; offset += 256) {
        this.checkCancelled();
        const chunk = segment.data.slice(offset, offset + 256);
        await this.command(COMMAND.write);
        await this.sendAddress(segment.address + offset);
        let checksum = chunk.length - 1;
        const packet = new Uint8Array(chunk.length + 2);
        packet[0] = chunk.length - 1;
        packet.set(chunk, 1);
        for (const byte of chunk) checksum ^= byte;
        packet[packet.length - 1] = checksum;
        await this.sendAndAck(packet, 'كتابة Flash');
        written += chunk.length;
        this.report('writing', 15 + Math.round(written * 50 / image.totalBytes), written, image.totalBytes);
      }
    }

    let verified = 0;
    for (const segment of image.segments) {
      for (let offset = 0; offset < segment.data.length; offset += 256) {
        this.checkCancelled();
        const expected = segment.data.slice(offset, offset + 256);
        await this.command(COMMAND.read);
        await this.sendAddress(segment.address + offset);
        const count = expected.length - 1;
        await this.sendAndAck(Uint8Array.of(count, (~count) & 0xff), 'تهيئة read-back');
        const actual = await this.channel.readExactly(expected.length, 5000);
        for (let index = 0; index < expected.length; index += 1) {
          if (actual[index] !== expected[index]) {
            throw new Stm32BootloaderError(
              `فشل read-back verify عند 0x${(segment.address + offset + index).toString(16)}.`,
            );
          }
        }
        verified += expected.length;
        this.report('verifying', 65 + Math.round(verified * 34 / image.totalBytes), verified, image.totalBytes);
      }
    }
  }

  private async command(value: number): Promise<void> {
    await this.sendAndAck(Uint8Array.of(value, value ^ 0xff), `الأمر 0x${value.toString(16)}`);
  }

  private async sendAddress(address: number): Promise<void> {
    const packet = Uint8Array.of(address >>> 24, address >>> 16, address >>> 8, address);
    await this.sendAndAck(Uint8Array.of(...packet, packet[0] ^ packet[1] ^ packet[2] ^ packet[3]), 'العنوان');
  }

  private async sendAndAck(data: Uint8Array, context: string, timeout = 5000): Promise<void> {
    this.checkCancelled();
    await this.channel.writeRaw(data);
    await this.readAck(context, timeout);
  }

  private async readAck(context: string, timeout = 5000): Promise<void> {
    const response = (await this.channel.readExactly(1, timeout))[0];
    this.expectAck(response, context);
  }

  private expectAck(response: number, context: string): void {
    if (response === ACK) return;
    if (response === NACK) throw new Stm32BootloaderError(`STM32 أرسل NACK أثناء ${context}.`);
    throw new Stm32BootloaderError(`استجابة STM32 غير متوقعة 0x${response.toString(16)} أثناء ${context}.`);
  }

  private report(
    phase: Stm32FlashProgress['phase'],
    percent: number,
    processedBytes: number,
    totalBytes: number,
  ): void {
    this.onProgress({phase, percent: Math.max(0, Math.min(100, percent)), processedBytes, totalBytes});
  }

  private checkCancelled(): void {
    if (this.signal?.aborted) throw new Stm32BootloaderError('أُلغيَ تفليش STM32.');
  }
}
