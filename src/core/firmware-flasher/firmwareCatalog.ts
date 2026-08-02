import type {BetaflightTarget} from './buildApi';
import {normalizeConfigurationLines} from './customDefaults';

export type FirmwareReleaseChannel = 'stable' | 'candidate' | 'development';

export type FirmwareRelease = {
  readonly release: string;
  readonly label: string;
  readonly channel: FirmwareReleaseChannel;
};

export type FirmwareBuildOption = {
  readonly name: string;
  readonly value: string;
  readonly default: boolean;
  readonly includesTelemetry: boolean;
  readonly group?: string;
};

export type FirmwareBuildOptions = {
  readonly radioProtocols: readonly FirmwareBuildOption[];
  readonly telemetryProtocols: readonly FirmwareBuildOption[];
  readonly osdProtocols: readonly FirmwareBuildOption[];
  readonly motorProtocols: readonly FirmwareBuildOption[];
  readonly generalOptions: readonly FirmwareBuildOption[];
};

export type FirmwareTargetDetail = {
  readonly target: string;
  readonly release: string;
  readonly releaseType: string;
  readonly cloudBuild: boolean;
  readonly file?: string;
  readonly url?: string;
  readonly configuration?: readonly string[];
  readonly date?: string;
  readonly releaseUrl?: string;
  readonly manufacturer?: string;
  readonly mcu?: string;
};

export type FirmwareCommit = {
  readonly sha: string;
  readonly message: string;
};

export type FirmwareBuildSelection = {
  readonly coreBuild: boolean;
  readonly radioProtocol?: string;
  readonly telemetryProtocol?: string;
  readonly osdProtocol?: string;
  readonly motorProtocol?: string;
  readonly generalOptions?: readonly string[];
  readonly customDefines?: readonly string[];
  readonly commit?: string;
};

export type FirmwareBuildRequest = {
  readonly target: string;
  readonly release: string;
  readonly options: readonly string[];
  readonly commit?: string;
};

export type FirmwareBuildResponse = {
  readonly file: string;
  readonly url: string;
  readonly key?: string;
};

export type FirmwareBuildStatus = {
  readonly status: 'queued' | 'processing' | 'success' | 'failed';
  readonly timeOutSeconds?: number;
  readonly configuration?: readonly string[];
  readonly message?: string;
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} غير صالح.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} غير موجود أو غير صالح.`);
  }
  return value.trim();
}

function releaseChannel(value: unknown): FirmwareReleaseChannel {
  switch (String(value).toLowerCase()) {
    case 'stable':
      return 'stable';
    case 'releasecandidate':
    case 'release_candidate':
    case 'candidate':
      return 'candidate';
    case 'unstable':
    case 'development':
      return 'development';
    default:
      throw new Error(`نوع إصدار Firmware غير معروف: ${String(value)}.`);
  }
}

function versionParts(version: string): readonly number[] {
  const parts = version.match(/\d+/g)?.map(Number) ?? [];
  return parts.slice(0, 6);
}

function compareVersionsDescending(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

export function parseTargetReleases(input: unknown): readonly FirmwareRelease[] {
  const releases = record(input, 'استجابة إصدارات Target').releases;
  if (!Array.isArray(releases)) {
    throw new Error('قائمة إصدارات Target غير صالحة.');
  }
  return releases.map((item, index) => {
    const candidate = record(item, `الإصدار رقم ${index + 1}`);
    const release = nonEmptyString(candidate.release, 'رقم الإصدار');
    return {
      release,
      label: typeof candidate.label === 'string' && candidate.label.trim().length > 0
        ? candidate.label.trim()
        : release,
      channel: releaseChannel(candidate.type),
    };
  }).sort((left, right) => compareVersionsDescending(left.release, right.release));
}

function parseOptionArray(value: unknown, context: string): readonly FirmwareBuildOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const option = record(item, `${context} رقم ${index + 1}`);
    const optionValue = nonEmptyString(option.value, `قيمة ${context}`);
    const group = typeof option.group === 'string' && option.group.trim().length > 0
      ? option.group.trim()
      : undefined;
    const nameSource = group === 'OSD' && typeof option.groupedName === 'string'
      ? option.groupedName
      : option.name;
    return {
      name: typeof nameSource === 'string' && nameSource.trim().length > 0
        ? nameSource.trim()
        : optionValue,
      value: optionValue,
      default: option.default === true,
      includesTelemetry: option.includesTelemetry === true,
      ...(group === undefined ? {} : {group}),
    };
  });
}

export function parseBuildOptions(input: unknown): FirmwareBuildOptions {
  const data = record(input, 'خيارات بناء Firmware');
  const general = parseOptionArray(data.generalOptions, 'الخيار العام');
  return {
    radioProtocols: parseOptionArray(data.radioProtocols, 'بروتوكول الراديو'),
    telemetryProtocols: parseOptionArray(data.telemetryProtocols, 'بروتوكول Telemetry'),
    osdProtocols: general.filter(option => option.group === 'OSD'),
    motorProtocols: parseOptionArray(data.motorProtocols, 'بروتوكول المحركات'),
    generalOptions: general.filter(option => option.group === undefined),
  };
}

export function parseTargetDetail(
  input: unknown,
  expectedTarget: string,
  expectedRelease: string,
): FirmwareTargetDetail {
  const data = record(input, 'تفاصيل Target');
  const target = typeof data.target === 'string' ? data.target.trim() : expectedTarget.trim();
  const release = typeof data.release === 'string' ? data.release.trim() : expectedRelease.trim();
  if (target.toUpperCase() !== expectedTarget.trim().toUpperCase()) {
    throw new Error(`الخادم أعاد Target مختلفاً (${target}).`);
  }
  if (release !== expectedRelease.trim()) {
    throw new Error(`الخادم أعاد إصداراً مختلفاً (${release}).`);
  }
  const configuration = normalizeConfigurationLines(data.configuration);
  return {
    target,
    release,
    releaseType: typeof data.releaseType === 'string' ? data.releaseType : '',
    cloudBuild: data.cloudBuild === true,
    ...(typeof data.file === 'string' && data.file.length > 0 ? {file: data.file} : {}),
    ...(typeof data.url === 'string' && data.url.length > 0 ? {url: data.url} : {}),
    ...(configuration === undefined ? {} : {configuration}),
    ...(typeof data.date === 'string' && data.date.length > 0 ? {date: data.date} : {}),
    ...(typeof data.releaseUrl === 'string' && data.releaseUrl.length > 0 ? {releaseUrl: data.releaseUrl} : {}),
    ...(typeof data.manufacturer === 'string' && data.manufacturer.length > 0 ? {manufacturer: data.manufacturer} : {}),
    ...(typeof data.mcu === 'string' && data.mcu.length > 0 ? {mcu: data.mcu} : {}),
  };
}

export function parseCommits(input: unknown): readonly FirmwareCommit[] {
  if (!Array.isArray(input)) throw new Error('قائمة Commits غير صالحة.');
  return input.slice(0, 500).map((item, index) => {
    const commit = record(item, `Commit رقم ${index + 1}`);
    return {
      sha: nonEmptyString(commit.sha, 'Commit SHA'),
      message: nonEmptyString(commit.message, 'رسالة Commit').split('\n')[0],
    };
  });
}

function optionalOption(value: string | undefined): string[] {
  const normalized = value?.trim();
  return normalized ? [normalized] : [];
}

const CUSTOM_DEFINE_PATTERN = /^[A-Z][A-Z0-9_]*(?:=[A-Za-z0-9_.+\-/]+)?$/;

export function normalizeCustomDefines(values: readonly string[] = []): readonly string[] {
  if (values.length > 64) throw new Error('عدد Custom Defines يتجاوز الحد الآمن (64).');
  return values.map(value => value.trim()).filter(value => value.length > 0).map(value => {
    if (value.length > 96 || !CUSTOM_DEFINE_PATTERN.test(value)) {
      throw new Error(`Custom Define غير صالح: ${value}.`);
    }
    return value;
  });
}

export function createBuildRequest(
  detail: FirmwareTargetDetail,
  selection: FirmwareBuildSelection,
): FirmwareBuildRequest {
  if (!detail.cloudBuild || selection.coreBuild) {
    return {target: detail.target, release: detail.release, options: ['CORE_BUILD']};
  }
  const options = [
    'CLOUD_BUILD',
    ...optionalOption(selection.radioProtocol),
    ...optionalOption(selection.telemetryProtocol),
    ...optionalOption(selection.osdProtocol),
    ...optionalOption(selection.motorProtocol),
    ...(selection.generalOptions ?? []).map(value => value.trim()).filter(Boolean),
    ...normalizeCustomDefines(selection.customDefines),
  ];
  const unique = Array.from(new Set(options));
  const commit = selection.commit?.trim();
  return {
    target: detail.target,
    release: detail.release,
    options: unique,
    ...(detail.releaseType.toLowerCase() === 'unstable' && commit ? {commit} : {}),
  };
}

export function parseBuildResponse(input: unknown): FirmwareBuildResponse {
  const data = record(input, 'استجابة طلب البناء');
  return {
    file: nonEmptyString(data.file, 'اسم ملف Firmware'),
    url: nonEmptyString(data.url, 'عنوان ملف Firmware'),
    ...(typeof data.key === 'string' && data.key.trim().length > 0 ? {key: data.key.trim()} : {}),
  };
}

export function parseBuildStatus(input: unknown): FirmwareBuildStatus {
  const data = record(input, 'حالة بناء Firmware');
  const rawStatus = nonEmptyString(data.status, 'حالة البناء').toLowerCase();
  const status: FirmwareBuildStatus['status'] = rawStatus === 'success'
    ? 'success'
    : rawStatus === 'queued' && data.timeOut === undefined
      ? 'queued'
      : rawStatus === 'processing' || (rawStatus === 'queued' && data.timeOut !== undefined)
        ? 'processing'
        : 'failed';
  const timeout = Number(data.timeOut);
  const configuration = normalizeConfigurationLines(data.configuration);
  return {
    status,
    ...(Number.isFinite(timeout) && timeout > 0
      ? {timeOutSeconds: Math.max(10, Math.min(600, timeout))}
      : {}),
    ...(configuration === undefined ? {} : {configuration}),
    ...(typeof data.message === 'string' && data.message.trim().length > 0 ? {message: data.message.trim()} : {}),
  };
}

const GROUP_ORDER: Readonly<Record<string, number>> = {supported: 0, unsupported: 1, legacy: 2};

export function filterAndSortTargets(
  targets: readonly BetaflightTarget[],
  query: string,
): readonly BetaflightTarget[] {
  const normalized = query.trim().toLowerCase();
  return targets.filter(target => {
    if (!normalized) return true;
    return [target.target, target.manufacturer, target.mcu]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(normalized));
  }).sort((left, right) => {
    const group = (GROUP_ORDER[left.group ?? 'unsupported'] ?? 99) -
      (GROUP_ORDER[right.group ?? 'unsupported'] ?? 99);
    return group !== 0 ? group : left.target.localeCompare(right.target);
  });
}
