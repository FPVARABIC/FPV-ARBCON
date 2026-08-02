import {ESPLoader} from 'esptool-js';
import type {Transport} from 'esptool-js';

import {md5Hex} from '../../../core/firmware-flasher';
import type {ReactNativeSerialPort} from './ReactNativeSerialPort';

export type EspFlashProgress = {
  readonly phase: 'connecting' | 'writing' | 'rebooting' | 'complete';
  readonly percent: number;
  readonly writtenBytes: number;
  readonly totalBytes: number;
  readonly chip?: string;
};

export class EspFirmwareFlasher {
  constructor(
    private readonly transport: ReactNativeSerialPort,
    private readonly signal?: AbortSignal,
    private readonly onProgress: (progress: EspFlashProgress) => void = () => undefined,
    private readonly onLog: (line: string) => void = () => undefined,
  ) {}

  async flash(
    firmware: Uint8Array,
    options: {flashBaudRate?: number; eraseAll?: boolean} = {},
  ): Promise<string> {
    if (firmware.length === 0) throw new Error('صورة ESP BIN فارغة.');
    this.checkCancelled();
    const flashBaudRate = options.flashBaudRate ?? 460800;
    this.onProgress({phase: 'connecting', percent: 0, writtenBytes: 0, totalBytes: firmware.length});
    const terminal = {
      clean: () => undefined,
      write: (data: string) => this.onLog(data.trim()),
      writeLine: (data: string) => this.onLog(data.trim()),
    };
    const loader = new ESPLoader({
      transport: this.transport as unknown as Transport,
      baudrate: flashBaudRate,
      serialOptions: {dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'},
      terminal,
    });
    try {
      const chip = await loader.main();
      this.checkCancelled();
      this.onProgress({
        phase: 'writing',
        percent: 5,
        writtenBytes: 0,
        totalBytes: firmware.length,
        chip,
      });
      await loader.writeFlash({
        fileArray: [{data: firmware, address: 0}],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: options.eraseAll ?? false,
        compress: true,
        calculateMD5Hash: md5Hex,
        reportProgress: (_fileIndex, written, total) => {
          this.checkCancelled();
          this.onProgress({
            phase: 'writing',
            percent: total > 0 ? 5 + Math.round(written * 90 / total) : 5,
            writtenBytes: written,
            totalBytes: total,
            chip,
          });
        },
      });
      this.checkCancelled();
      this.onProgress({
        phase: 'rebooting',
        percent: 98,
        writtenBytes: firmware.length,
        totalBytes: firmware.length,
        chip,
      });
      await loader.after('hard_reset');
      this.onProgress({
        phase: 'complete',
        percent: 100,
        writtenBytes: firmware.length,
        totalBytes: firmware.length,
        chip,
      });
      return chip;
    } finally {
      await this.transport.disconnect().catch(() => undefined);
    }
  }

  private checkCancelled(): void {
    if (this.signal?.aborted) throw new Error('أُلغيَ تفليش ESP.');
  }
}
