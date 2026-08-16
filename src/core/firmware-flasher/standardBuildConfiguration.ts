/**
 * THE STANDARD SCREEN'S BUILD CONFIGURATION - pure, and driven ONLY by
 * what the official Betaflight Build API actually returned.
 *
 * WHY THIS EXISTS. The first simplification pass reduced the standard
 * flow to Target -> version -> download -> flash and silently applied the
 * API's default build options. That is simpler, but it removed real
 * Betaflight capability: an operator could no longer choose the radio,
 * telemetry, OSD or motor protocol, could not see the release's other
 * options, and could not add a custom define without dropping into the
 * full legacy screen. This module restores that capability as DATA, so
 * the screen renders whatever the selected release offers and nothing
 * else.
 *
 * THE HARD RULE. Nothing here invents an option, a value, a default or a
 * category. Every list comes from parseBuildOptions(), which comes from
 * GET /api/options/{release}. A feature that a given release does not
 * expose is simply absent - never fabricated, never hardcoded from
 * memory of some other release. That is why there is no "position hold"
 * (or any other feature) named anywhere in this file: if a release
 * offers it as a build option it arrives inside `generalOptions` with the
 * exact value the API expects, and if it does not, it must not appear.
 */

import type {
  FirmwareBuildOption,
  FirmwareBuildOptions,
  FirmwareBuildSelection,
  FirmwareRelease,
  FirmwareReleaseChannel,
  FirmwareTargetDetail,
} from './firmwareCatalog';

/**
 * The value the official API uses for "telemetry is already carried by
 * the selected radio protocol". Betaflight Configurator disables the
 * telemetry selector in that state; the classic screen does the same, and this
 * keeps both screens on one rule.
 */
export const TELEMETRY_INCLUDED_IN_RADIO = '-1';

/** Every choice the standard screen can make about a cloud build. */
export interface StandardBuildChoices {
  /** true = official CORE_BUILD, false = configurable CLOUD_BUILD. */
  readonly coreBuild: boolean;
  readonly radioProtocol: string;
  readonly telemetryProtocol: string;
  readonly osdProtocol: string;
  readonly motorProtocol: string;
  readonly generalOptions: readonly string[];
  /** Raw operator text; whitespace separated, validated on submit. */
  readonly customDefines: string;
}

/** One rendered group. `kind` decides single-select vs multi-select. */
export interface StandardBuildCategory {
  readonly key: 'radio' | 'telemetry' | 'osd' | 'motor' | 'general';
  readonly kind: 'single' | 'multi';
  readonly options: readonly FirmwareBuildOption[];
}

function defaultValueOf(options: readonly FirmwareBuildOption[]): string {
  return options.find(option => option.default)?.value ?? '';
}

/** Whether this target/release combination offers ANY cloud option. */
export function hasConfigurableBuild(
  detail: FirmwareTargetDetail,
  options: FirmwareBuildOptions,
): boolean {
  if (!detail.cloudBuild) {
    return false;
  }
  return [
    options.radioProtocols,
    options.telemetryProtocols,
    options.osdProtocols,
    options.motorProtocols,
    options.generalOptions,
  ].some(items => items.length > 0);
}

/**
 * The official defaults, exactly as the API marked them. A beginner can
 * flash straight from here without touching anything; an intermediate
 * operator changes what they care about and leaves the rest.
 */
export function defaultStandardChoices(
  detail: FirmwareTargetDetail,
  options: FirmwareBuildOptions,
): StandardBuildChoices {
  const radioProtocol = defaultValueOf(options.radioProtocols);
  const radio = options.radioProtocols.find(option => option.value === radioProtocol);
  return {
    // Core build is the honest default only when there is nothing to
    // configure; otherwise the operator gets the configurable path.
    coreBuild: !hasConfigurableBuild(detail, options),
    radioProtocol,
    telemetryProtocol:
      radio?.includesTelemetry === true
        ? TELEMETRY_INCLUDED_IN_RADIO
        : defaultValueOf(options.telemetryProtocols),
    osdProtocol: defaultValueOf(options.osdProtocols),
    motorProtocol: defaultValueOf(options.motorProtocols),
    generalOptions: options.generalOptions
      .filter(option => option.default)
      .map(option => option.value),
    customDefines: '',
  };
}

/**
 * Keeps the telemetry choice consistent with the radio choice, the same
 * way the classic screen and Betaflight Configurator do: a radio protocol
 * that carries telemetry pins the telemetry selector to the API's sentinel,
 * and choosing a radio protocol that does not carry telemetry releases it
 * back to the release's own default.
 */
export function applyRadioTelemetryRule(
  choices: StandardBuildChoices,
  options: FirmwareBuildOptions,
): StandardBuildChoices {
  const radio = options.radioProtocols.find(
    option => option.value === choices.radioProtocol,
  );
  if (radio?.includesTelemetry === true) {
    return choices.telemetryProtocol === TELEMETRY_INCLUDED_IN_RADIO
      ? choices
      : {...choices, telemetryProtocol: TELEMETRY_INCLUDED_IN_RADIO};
  }
  if (choices.telemetryProtocol === TELEMETRY_INCLUDED_IN_RADIO) {
    return {...choices, telemetryProtocol: defaultValueOf(options.telemetryProtocols)};
  }
  return choices;
}

/**
 * The categories to RENDER, in the order the operator reads them. A
 * category the selected release does not offer is omitted entirely -
 * an empty selector is worse than no selector.
 */
export function standardBuildCategories(
  options: FirmwareBuildOptions,
): readonly StandardBuildCategory[] {
  const all: readonly StandardBuildCategory[] = [
    {key: 'radio', kind: 'single', options: options.radioProtocols},
    {key: 'telemetry', kind: 'single', options: options.telemetryProtocols},
    {key: 'osd', kind: 'single', options: options.osdProtocols},
    {key: 'motor', kind: 'single', options: options.motorProtocols},
    {key: 'general', kind: 'multi', options: options.generalOptions},
  ];
  return all.filter(category => category.options.length > 0);
}

/**
 * Maps the operator's visible choices onto the official request input.
 * Every visible control lands here - there is no decorative option, and
 * nothing selected is silently dropped. `commit` is passed through for
 * the development channel only (createBuildRequest enforces that).
 */
export function toBuildSelection(
  choices: StandardBuildChoices,
  commit?: string,
): FirmwareBuildSelection {
  if (choices.coreBuild) {
    return {coreBuild: true};
  }
  return {
    coreBuild: false,
    radioProtocol: choices.radioProtocol,
    // The sentinel means "the radio protocol already carries telemetry",
    // so it must NOT travel as a build option of its own.
    telemetryProtocol:
      choices.telemetryProtocol === TELEMETRY_INCLUDED_IN_RADIO
        ? ''
        : choices.telemetryProtocol,
    osdProtocol: choices.osdProtocol,
    motorProtocol: choices.motorProtocol,
    generalOptions: choices.generalOptions,
    customDefines: choices.customDefines.split(/\s+/),
    ...(commit !== undefined && commit.trim().length > 0 ? {commit: commit.trim()} : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Release channels
 * ------------------------------------------------------------------ */

/** Stable first; the other channels stay reachable but secondary. */
export const STANDARD_CHANNEL_ORDER: readonly FirmwareReleaseChannel[] = [
  'stable',
  'candidate',
  'development',
];

/** Only the channels this target actually publishes, in reading order. */
export function availableChannels(
  releases: readonly FirmwareRelease[],
): readonly FirmwareReleaseChannel[] {
  return STANDARD_CHANNEL_ORDER.filter(channel =>
    releases.some(release => release.channel === channel),
  );
}

export function releasesForChannel(
  releases: readonly FirmwareRelease[],
  channel: FirmwareReleaseChannel,
): readonly FirmwareRelease[] {
  return releases.filter(release => release.channel === channel);
}

/**
 * The newest release WITHIN the requested channel, or '' when that
 * channel is empty. Never falls through to another channel: silently
 * handing an operator a release candidate when they asked for stable is
 * exactly the kind of substitution this product refuses to make.
 * (parseTargetReleases already sorts newest-first.)
 */
export function defaultReleaseForChannel(
  releases: readonly FirmwareRelease[],
  channel: FirmwareReleaseChannel,
): string {
  return releasesForChannel(releases, channel)[0]?.release ?? '';
}
