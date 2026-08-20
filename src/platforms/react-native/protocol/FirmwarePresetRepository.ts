import {
  commandsForPreset,
  createMspOperationCoordinator,
  expandFirmwarePresetIncludes,
  parseFirmwarePresetDocument,
  parseFirmwarePresetIndex,
  sha256Hex,
  type FirmwarePresetDocument,
  type FirmwarePresetIndex,
  type FirmwarePresetSummary,
  type MspExclusiveOperation,
} from '../../../core';
import { MSP_FC_VERSION } from '../../../core/protocol/msp/commands/mspCommands';
import { withDeadline } from '../../../core/async/deadline';
import {
  decodeFcVersion,
  type MspFcVersion,
} from '../../../core/protocol/msp/decoding/decodeFcVersion';
import {
  mspSessionCoordinator,
  type MspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

export const OFFICIAL_PRESETS_BASE_URL =
  'https://presets.betaflight.com/firmware-presets/';
const MAX_INDEX_CHARACTERS = 2 * 1024 * 1024;
const MAX_FILE_CHARACTERS = 1024 * 1024;

type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};
type Fetcher = (
  url: string,
  init?: { cache?: 'no-cache'; signal?: AbortSignal },
) => Promise<FetchResponse>;

/**
 * How long the preset host gets to send response headers before the
 * Presets screen is told the truth instead of spinning. Same reasoning
 * and the same figure as buildApi's own bound: a public HTTPS service on
 * a slow mobile link, not the MSP wire.
 */
const PRESET_RESPONSE_TIMEOUT_MILLIS = 30_000;

export interface LoadedFirmwarePreset {
  readonly summary: FirmwarePresetSummary;
  readonly document: FirmwarePresetDocument;
  readonly expandedLines: readonly string[];
  readonly completeWarning: string;
}

export interface FirmwarePresetRepositoryOptions {
  readonly fetcher?: Fetcher;
  readonly coordinator?: Pick<
    MspSessionCoordinator,
    | 'getSessionKey'
    | 'getActiveMspClient'
    | 'getTelemetryScheduler'
    | 'getMspRecoveryState'
  >;
  readonly baseUrl?: string;
}

export class FirmwarePresetRepository {
  private readonly fetcher: Fetcher;
  private readonly coordinator: NonNullable<
    FirmwarePresetRepositoryOptions['coordinator']
  >;
  private readonly baseUrl: string;

  constructor(options: FirmwarePresetRepositoryOptions = {}) {
    this.fetcher =
      options.fetcher ??
      ((url, init) => fetch(url, init) as Promise<FetchResponse>);
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.baseUrl = options.baseUrl ?? OFFICIAL_PRESETS_BASE_URL;
  }

  async loadIndex(): Promise<FirmwarePresetIndex> {
    const text = await this.loadText('index.json', MAX_INDEX_CHARACTERS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('تعذر قراءة فهرس Presets الرسمي.');
    }
    return parseFirmwarePresetIndex(parsed);
  }

  async loadPreset(
    summary: FirmwarePresetSummary,
  ): Promise<LoadedFirmwarePreset> {
    const mainText = await this.loadText(summary.fullPath, MAX_FILE_CHARACTERS);
    if (sha256Hex(mainText) !== summary.hash) {
      throw new Error(
        'بصمة ملف Preset لا تطابق الفهرس الرسمي؛ لن تُعرض أوامر غير موثقة.',
      );
    }
    const document = parseFirmwarePresetDocument(mainText);
    const expandedLines = await expandFirmwarePresetIncludes(
      document.lines,
      path => this.loadText(path, MAX_FILE_CHARACTERS),
    );
    const warningPaths = [
      ...document.includeWarnings,
      ...document.includeDisclaimers,
    ];
    const warningTexts = await Promise.all(
      warningPaths.map(path => this.loadText(path, MAX_FILE_CHARACTERS)),
    );
    const completeWarning = [
      document.warning,
      document.disclaimer,
      ...warningTexts,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n\n');
    return Object.freeze({ summary, document, expandedLines, completeWarning });
  }

  commands(
    preset: LoadedFirmwarePreset,
    selectedOptions: ReadonlySet<string>,
  ): readonly string[] {
    return commandsForPreset(preset.expandedLines, selectedOptions);
  }

  async loadFirmwareVersion(
    sessionKey: SetupUiSessionKey,
  ): Promise<MspFcVersion> {
    const client = this.coordinator.getActiveMspClient(sessionKey.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(
      sessionKey.sessionId,
    );
    if (!client || !scheduler)
      throw new Error('جلسة MSP غير جاهزة لقراءة إصدار Firmware.');
    const operations = createMspOperationCoordinator(
      client,
      scheduler,
      {
        captureCurrent: () =>
          this.coordinator.getSessionKey(sessionKey.sessionId),
      },
      {
        getContext: () => ({
          clientState:
            this.coordinator.getMspRecoveryState(sessionKey.sessionId) ??
            'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
    const operation: MspExclusiveOperation<MspFcVersion> = {
      id: 'presets-read-firmware-version',
      sessionEffect: 'KEEP_SESSION',
      validate: context =>
        context.clientState === 'READY'
          ? { allowed: true }
          : {
              allowed: false,
              error: new Error('MSP ليس جاهزًا لقراءة الإصدار.'),
            },
      execute: async requester => {
        const frame = await requester.request(
          MSP_FC_VERSION,
          new Uint8Array(0),
          { wireFormat: 'v1' },
        );
        return decodeFcVersion(frame.payload);
      },
    };
    const result = await operations.execute(operation);
    if (result.status !== 'SUCCEEDED')
      throw new Error('تعذر تثبيت إصدار Firmware قبل تصفية Presets.');
    return result.result;
  }

  /**
   * BOUNDED. The Presets screen shows a loading state while this runs and
   * has no other way out of it: an un-timed `fetch` to a host that
   * accepts the connection and then goes quiet leaves that state
   * permanent. Aborting on expiry rather than only abandoning the
   * Promise means the half-open request is actually torn down.
   *
   * As in buildApi, this bounds the response HEADERS, not the body: a
   * slow download of a legitimately large preset file is not a defect.
   */
  private async loadText(path: string, limit: number): Promise<string> {
    const aborter = new AbortController();
    const outcome = await withDeadline(
      this.fetcher(`${this.baseUrl}${path}`, {
        cache: 'no-cache',
        signal: aborter.signal,
      }),
      PRESET_RESPONSE_TIMEOUT_MILLIS,
    );
    if (outcome.status === 'TIMED_OUT') {
      aborter.abort();
      throw new Error(`لم يستجب مصدر Presets عند تنزيل ${path}.`);
    }
    if (outcome.status === 'REJECTED') throw outcome.reason;
    const response = outcome.value;
    if (!response.ok)
      throw new Error(`فشل تنزيل ${path} (HTTP ${response.status}).`);
    const text = await response.text();
    if (text.length > limit)
      throw new Error(`الملف ${path} أكبر من الحد الآمن.`);
    return text;
  }
}

export const firmwarePresetRepository = new FirmwarePresetRepository();
