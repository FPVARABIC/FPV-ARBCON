import {
  createBuildRequest,
  filterAndSortTargets,
  parseBuildOptions,
  parseBuildStatus,
  parseCommits,
  parseTargetDetail,
  parseTargetReleases,
} from './firmwareCatalog';

describe('firmware catalog normalization', () => {
  it('groups searchable targets and sorts releases newest first', () => {
    expect(filterAndSortTargets([
      {target: 'OLD_F3', group: 'legacy', manufacturer: 'Old'},
      {target: 'SPEEDYF405', group: 'supported', manufacturer: 'SpeedyBee', mcu: 'STM32F405'},
      {target: 'COMMUNITYF7', group: 'unsupported', manufacturer: 'Community'},
    ], 'f4').map(target => target.target)).toEqual(['SPEEDYF405']);

    expect(parseTargetReleases({releases: [
      {release: '4.5.2', label: 'Stable', type: 'Stable'},
      {release: '4.6.0-RC1', label: 'RC', type: 'ReleaseCandidate'},
      {release: '4.7.0-dev', label: 'Dev', type: 'Unstable'},
    ]}).map(release => [release.release, release.channel])).toEqual([
      ['4.7.0-dev', 'development'],
      ['4.6.0-RC1', 'candidate'],
      ['4.5.2', 'stable'],
    ]);
  });

  it('normalizes all protocol families including OSD extracted from general options', () => {
    const options = parseBuildOptions({
      radioProtocols: [{name: 'CRSF', value: 'RX_CRSF', default: true, includesTelemetry: true}],
      telemetryProtocols: [
        {name: '[None]', value: ''},
        {name: 'SmartPort', value: 'TELEMETRY_SMARTPORT'},
      ],
      motorProtocols: [{name: 'DShot', value: 'DSHOT'}],
      generalOptions: [
        {name: 'GPS', value: 'GPS'},
        {name: 'OSD', groupedName: 'MSP DisplayPort', value: 'OSD_HD', group: 'OSD'},
      ],
    });
    expect(options.radioProtocols[0]).toMatchObject({value: 'RX_CRSF', includesTelemetry: true});
    expect(options.telemetryProtocols[0]).toMatchObject({name: '[None]', value: ''});
    expect(options.osdProtocols.map(option => option.value)).toEqual(['OSD_HD']);
    expect(options.generalOptions.map(option => option.value)).toEqual(['GPS']);
  });

  it('builds a deduplicated cloud request and accepts expert data only when safe', () => {
    const detail = parseTargetDetail({
      target: 'S405',
      release: '4.7.0-dev',
      releaseType: 'Unstable',
      cloudBuild: true,
    }, 'S405', '4.7.0-dev');
    expect(createBuildRequest(detail, {
      coreBuild: false,
      radioProtocol: 'RX_CRSF',
      telemetryProtocol: 'RX_CRSF',
      osdProtocol: 'OSD_HD',
      generalOptions: ['GPS'],
      customDefines: ['USE_BARO=BMP280'],
      commit: 'abc123',
    })).toEqual({
      target: 'S405',
      release: '4.7.0-dev',
      options: ['CLOUD_BUILD', 'RX_CRSF', 'OSD_HD', 'GPS', 'USE_BARO=BMP280'],
      commit: 'abc123',
    });
    expect(() => createBuildRequest(detail, {
      coreBuild: false,
      customDefines: ['bad define;rm'],
    })).toThrow(/غير صالح/);
  });

  it('keeps the official unified configuration as validated lines', () => {
    expect(parseTargetDetail({
      target: 'S405',
      release: '4.6.0',
      releaseType: 'Stable',
      cloudBuild: false,
      configuration: ['# target defaults', 'set foo = 1'],
    }, 'S405', '4.6.0').configuration).toEqual(['# target defaults', 'set foo = 1']);
    expect(() => parseBuildStatus({status: 'success', configuration: {unsafe: true}})).toThrow(/إعدادات Target/);
  });

  it('maps timeout-bearing queued statuses to processing and bounds timeout', () => {
    expect(parseBuildStatus({status: 'queued', timeOut: 9999})).toMatchObject({
      status: 'processing',
      timeOutSeconds: 600,
    });
    expect(parseBuildStatus({status: 'success', timeOut: 30})).toMatchObject({status: 'success'});
  });

  it('bounds and normalizes development commits', () => {
    expect(parseCommits([{sha: 'abc123', message: 'Fix target\nmore'}])).toEqual([
      {sha: 'abc123', message: 'Fix target'},
    ]);
  });
});
