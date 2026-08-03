import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN_FILES = [
  'UsbConnectionScreen.tsx',
  'SetupScreen.tsx',
  'MotorsScreen.tsx',
  'PortsScreen.tsx',
  'GpsScreen.tsx',
  'FirmwareFlasherScreen.tsx',
  'StartScreen.tsx',
] as const;

describe('tablet responsive shell', () => {
  it.each(SCREEN_FILES)('%s uses the full tablet content envelope', filename => {
    const source = readFileSync(join(__dirname, filename), 'utf8');
    expect(source).toContain('maxWidth: 1180');
    expect(source).not.toContain('maxWidth: 760');
  });

  it('keeps the bottom navigation aligned with the same tablet envelope', () => {
    const source = readFileSync(
      join(__dirname, '../components/navigation/BottomTabBar.tsx'),
      'utf8',
    );
    expect(source).toContain('maxWidth: 1180');
  });

  it('does not lock Android to portrait or landscape', () => {
    const manifest = readFileSync(
      join(__dirname, '../../../android/app/src/main/AndroidManifest.xml'),
      'utf8',
    );
    expect(manifest).not.toContain('screenOrientation');
    expect(manifest).toContain('orientation|screenLayout|screenSize');
  });
});
