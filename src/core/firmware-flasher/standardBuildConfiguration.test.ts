/**
 * THE STANDARD BUILD CONFIGURATION CONTRACT.
 *
 * The product requirement behind these tests: a normal Betaflight user
 * must be able to build the same meaningful firmware configuration in the
 * standard Arabic flow that they would build in Betaflight Configurator -
 * radio, telemetry, OSD, motor, other options and custom defines - with
 * the official defaults already chosen, and with EVERY visible choice
 * landing in the official build request. Nothing may be decorative and
 * nothing may be invented: the options rendered are exactly the options
 * GET /api/options/{release} returned for the selected release.
 */

import {createBuildRequest} from './firmwareCatalog';
import type {
  FirmwareBuildOptions,
  FirmwareRelease,
  FirmwareTargetDetail,
} from './firmwareCatalog';
import {
  TELEMETRY_INCLUDED_IN_RADIO,
  applyRadioTelemetryRule,
  availableChannels,
  defaultReleaseForChannel,
  defaultStandardChoices,
  hasConfigurableBuild,
  releasesForChannel,
  standardBuildCategories,
  toBuildSelection,
} from './standardBuildConfiguration';
import type {StandardBuildChoices} from './standardBuildConfiguration';

/**
 * Shaped exactly like a real /api/options/{release} document: `[None]`
 * carries the empty value, OSD options arrive inside generalOptions with
 * group 'OSD' and a groupedName, and a telemetry-carrying radio protocol
 * is flagged with includesTelemetry.
 */
const OPTIONS: FirmwareBuildOptions = {
  radioProtocols: [
    {name: 'CRSF', value: 'RX_CRSF', default: true, includesTelemetry: true},
    {name: 'SBUS', value: 'RX_SBUS', default: false, includesTelemetry: false},
    {name: 'IBUS', value: 'RX_IBUS', default: false, includesTelemetry: false},
  ],
  telemetryProtocols: [
    {name: '[None]', value: '', default: true, includesTelemetry: false},
    {name: 'SmartPort', value: 'TELEMETRY_SMARTPORT', default: false, includesTelemetry: false},
  ],
  osdProtocols: [
    {name: 'MSP DisplayPort', value: 'OSD_HD', default: true, includesTelemetry: false, group: 'OSD'},
    {name: 'Analogue', value: 'OSD_SD_MAX7456', default: false, includesTelemetry: false, group: 'OSD'},
  ],
  motorProtocols: [
    {name: 'DShot', value: 'USE_DSHOT', default: true, includesTelemetry: false},
    {name: 'Multishot', value: 'USE_MULTISHOT', default: false, includesTelemetry: false},
  ],
  generalOptions: [
    {name: 'GPS', value: 'USE_GPS', default: false, includesTelemetry: false},
    {name: 'LED Strip', value: 'USE_LED_STRIP', default: true, includesTelemetry: false},
    {name: 'Camera control', value: 'USE_CAMERA_CONTROL', default: false, includesTelemetry: false},
  ],
};

const EMPTY_OPTIONS: FirmwareBuildOptions = {
  radioProtocols: [],
  telemetryProtocols: [],
  osdProtocols: [],
  motorProtocols: [],
  generalOptions: [],
};

function detail(over: Partial<FirmwareTargetDetail> = {}): FirmwareTargetDetail {
  return {
    target: 'KAKUTEH7',
    release: '4.6.0',
    releaseType: 'Stable',
    cloudBuild: true,
    ...over,
  };
}

describe('the release decides what is offered - never this code', () => {
  it('renders only the categories the selected release actually returned', () => {
    expect(standardBuildCategories(OPTIONS).map(category => category.key)).toEqual([
      'radio',
      'telemetry',
      'osd',
      'motor',
      'general',
    ]);
    // A release that exposes nothing renders nothing - no empty selectors.
    expect(standardBuildCategories(EMPTY_OPTIONS)).toEqual([]);
  });

  it('omits an individual category the release does not expose', () => {
    const withoutOsd = {...OPTIONS, osdProtocols: []};
    expect(standardBuildCategories(withoutOsd).map(category => category.key)).toEqual([
      'radio',
      'telemetry',
      'motor',
      'general',
    ]);
  });

  it('marks the general options as multi-select and the protocols as single-select', () => {
    const kinds = Object.fromEntries(
      standardBuildCategories(OPTIONS).map(category => [category.key, category.kind]),
    );
    expect(kinds).toEqual({
      radio: 'single',
      telemetry: 'single',
      osd: 'single',
      motor: 'single',
      general: 'multi',
    });
  });

  it('offers configuration only when the target is a cloud build with options', () => {
    expect(hasConfigurableBuild(detail(), OPTIONS)).toBe(true);
    expect(hasConfigurableBuild(detail({cloudBuild: false}), OPTIONS)).toBe(false);
    expect(hasConfigurableBuild(detail(), EMPTY_OPTIONS)).toBe(false);
  });
});

describe('official defaults are pre-selected', () => {
  it('chooses exactly what the API marked default', () => {
    const choices = defaultStandardChoices(detail(), OPTIONS);
    expect(choices.coreBuild).toBe(false);
    expect(choices.radioProtocol).toBe('RX_CRSF');
    expect(choices.osdProtocol).toBe('OSD_HD');
    expect(choices.motorProtocol).toBe('USE_DSHOT');
    expect(choices.generalOptions).toEqual(['USE_LED_STRIP']);
    expect(choices.customDefines).toBe('');
  });

  it('a default radio protocol that carries telemetry pins the telemetry choice', () => {
    // CRSF carries telemetry, so telemetry is not a separate build option.
    expect(defaultStandardChoices(detail(), OPTIONS).telemetryProtocol).toBe(
      TELEMETRY_INCLUDED_IN_RADIO,
    );
  });

  it('falls back to a plain core build only when there is nothing to configure', () => {
    expect(defaultStandardChoices(detail(), EMPTY_OPTIONS).coreBuild).toBe(true);
    expect(defaultStandardChoices(detail({cloudBuild: false}), OPTIONS).coreBuild).toBe(true);
  });
});

describe('the radio/telemetry rule matches the classic screen and the reference', () => {
  it('switching to a radio protocol WITHOUT telemetry releases the telemetry choice', () => {
    const pinned = defaultStandardChoices(detail(), OPTIONS);
    const switched = applyRadioTelemetryRule({...pinned, radioProtocol: 'RX_SBUS'}, OPTIONS);
    expect(switched.telemetryProtocol).toBe('');
  });

  it('switching back to a telemetry-carrying radio protocol pins it again', () => {
    const loose: StandardBuildChoices = {
      ...defaultStandardChoices(detail(), OPTIONS),
      radioProtocol: 'RX_CRSF',
      telemetryProtocol: 'TELEMETRY_SMARTPORT',
    };
    expect(applyRadioTelemetryRule(loose, OPTIONS).telemetryProtocol).toBe(
      TELEMETRY_INCLUDED_IN_RADIO,
    );
  });

  it('leaves an already-consistent selection untouched (no render loops)', () => {
    const consistent = applyRadioTelemetryRule(
      {...defaultStandardChoices(detail(), OPTIONS), radioProtocol: 'RX_SBUS', telemetryProtocol: 'TELEMETRY_SMARTPORT'},
      OPTIONS,
    );
    expect(applyRadioTelemetryRule(consistent, OPTIONS)).toBe(consistent);
  });
});

describe('every visible choice reaches the official build request', () => {
  it('maps the default configuration into CLOUD_BUILD with the official values', () => {
    const request = createBuildRequest(
      detail(),
      toBuildSelection(defaultStandardChoices(detail(), OPTIONS)),
    );
    expect(request.target).toBe('KAKUTEH7');
    expect(request.release).toBe('4.6.0');
    expect(request.options).toEqual([
      'CLOUD_BUILD',
      'RX_CRSF',
      'OSD_HD',
      'USE_DSHOT',
      'USE_LED_STRIP',
    ]);
    // The telemetry sentinel is a UI state, never a build option.
    expect(request.options).not.toContain(TELEMETRY_INCLUDED_IN_RADIO);
  });

  it('a changed protocol changes the exact request payload', () => {
    const changed: StandardBuildChoices = {
      coreBuild: false,
      radioProtocol: 'RX_SBUS',
      telemetryProtocol: 'TELEMETRY_SMARTPORT',
      osdProtocol: 'OSD_SD_MAX7456',
      motorProtocol: 'USE_MULTISHOT',
      generalOptions: ['USE_GPS', 'USE_CAMERA_CONTROL'],
      customDefines: '',
    };
    expect(createBuildRequest(detail(), toBuildSelection(changed)).options).toEqual([
      'CLOUD_BUILD',
      'RX_SBUS',
      'TELEMETRY_SMARTPORT',
      'OSD_SD_MAX7456',
      'USE_MULTISHOT',
      'USE_GPS',
      'USE_CAMERA_CONTROL',
    ]);
  });

  it('NO visible selection is silently ignored - each one moves the payload', () => {
    const base = defaultStandardChoices(detail(), OPTIONS);
    const baseline = createBuildRequest(detail(), toBuildSelection(base)).options;
    const mutations: readonly [string, StandardBuildChoices][] = [
      ['radio', {...base, radioProtocol: 'RX_IBUS'}],
      ['telemetry', {...base, radioProtocol: 'RX_SBUS', telemetryProtocol: 'TELEMETRY_SMARTPORT'}],
      ['osd', {...base, osdProtocol: 'OSD_SD_MAX7456'}],
      ['motor', {...base, motorProtocol: 'USE_MULTISHOT'}],
      ['general', {...base, generalOptions: ['USE_GPS']}],
      ['customDefines', {...base, customDefines: 'USE_SOMETHING_EXTRA'}],
    ];
    for (const [label, choices] of mutations) {
      const options = createBuildRequest(detail(), toBuildSelection(choices)).options;
      expect(options).not.toEqual(baseline);
      expect(label).toBeTruthy();
    }
  });

  it('custom defines survive into the request, and invalid ones are refused loudly', () => {
    const withDefines: StandardBuildChoices = {
      ...defaultStandardChoices(detail(), OPTIONS),
      customDefines: '  USE_CUSTOM_A   USE_CUSTOM_B=3  ',
    };
    const options = createBuildRequest(detail(), toBuildSelection(withDefines)).options;
    expect(options).toContain('USE_CUSTOM_A');
    expect(options).toContain('USE_CUSTOM_B=3');

    const invalid: StandardBuildChoices = {
      ...defaultStandardChoices(detail(), OPTIONS),
      customDefines: 'not a define',
    };
    expect(() => createBuildRequest(detail(), toBuildSelection(invalid))).toThrow();
  });

  it('a core build sends CORE_BUILD and no configuration at all', () => {
    const core: StandardBuildChoices = {
      ...defaultStandardChoices(detail(), OPTIONS),
      coreBuild: true,
    };
    expect(createBuildRequest(detail(), toBuildSelection(core)).options).toEqual(['CORE_BUILD']);
  });

  it('a commit travels only on the development channel, as the API requires', () => {
    const choices = defaultStandardChoices(detail(), OPTIONS);
    const stable = createBuildRequest(detail(), toBuildSelection(choices, 'abc123'));
    expect(stable.commit).toBeUndefined();
    const dev = createBuildRequest(
      detail({releaseType: 'Unstable'}),
      toBuildSelection(choices, 'abc123'),
    );
    expect(dev.commit).toBe('abc123');
  });
});

describe('release channels: stable by default, others reachable, never silent', () => {
  const releases: readonly FirmwareRelease[] = [
    {release: '4.6.0', label: '2026-06-01', channel: 'stable'},
    {release: '4.5.1', label: '2026-01-01', channel: 'stable'},
    {release: '4.7.0-RC1', label: '2026-07-01', channel: 'candidate'},
    {release: '4.8.0-dev', label: '2026-08-01', channel: 'development'},
  ];

  it('lists only the channels this target publishes, stable first', () => {
    expect(availableChannels(releases)).toEqual(['stable', 'candidate', 'development']);
    expect(availableChannels(releases.filter(r => r.channel !== 'candidate'))).toEqual([
      'stable',
      'development',
    ]);
  });

  it('picks the newest release inside the requested channel only', () => {
    expect(defaultReleaseForChannel(releases, 'stable')).toBe('4.6.0');
    expect(defaultReleaseForChannel(releases, 'candidate')).toBe('4.7.0-RC1');
    expect(defaultReleaseForChannel(releases, 'development')).toBe('4.8.0-dev');
  });

  it('NEVER substitutes another channel when the requested one is empty', () => {
    const noStable = releases.filter(release => release.channel !== 'stable');
    expect(defaultReleaseForChannel(noStable, 'stable')).toBe('');
    expect(availableChannels(noStable)).not.toContain('stable');
    // The caller is expected to say so rather than quietly flash an RC.
    expect(releasesForChannel(noStable, 'stable')).toEqual([]);
  });
});
