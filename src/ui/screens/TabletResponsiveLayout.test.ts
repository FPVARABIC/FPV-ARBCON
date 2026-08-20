import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  CONTENT_MAX_WIDTH,
  WORKSPACE_MAX_WIDTH,
  contentEnvelope,
  resolveLayoutTier,
} from '../theme/layout';

/**
 * Screens that are still a single reading column at every width. They
 * keep the static 1180px cap deliberately: widening a column of prose to
 * a metre of screen would trade one bad layout for another.
 */
const READING_COLUMN_SCREENS = [
  'FirmwareFlasherScreen.tsx',
] as const;

/**
 * Screens that call the envelope helper DIRECTLY (not through the
 * useContentEnvelope hook) because they already know, from their own
 * layout state, whether they have split into columns.
 *
 * StartScreen moved here when its dead `maxWidth: 1180` literal was
 * deleted. That literal had stopped being the truth some time ago: the
 * screen passes `contentEnvelope(tier, desktop)` inline, and an inline
 * style wins over the StyleSheet entry, so at desktop tiers the real cap
 * was already WORKSPACE_MAX_WIDTH. The old assertion therefore pinned a
 * string that no longer described the rendered layout. What is pinned now
 * is the actual contract: consult the shared helper, and own no private
 * cap of any kind.
 */
const ENVELOPE_HELPER_SCREENS = ['StartScreen.tsx'] as const;

/**
 * Post-connection screens that genuinely arrange content side by side at
 * desktop widths, and therefore take the wider workspace envelope AT
 * RENDER TIME rather than from a StyleSheet literal.
 *
 * REPLACES the previous assertion that every screen contained the literal
 * `maxWidth: 1180`. That pin was correct while the only question was
 * "phone or tablet"; a real operator then reported the post-connection
 * screens as "a mobile phone interface inside a desktop monitor", because
 * a StyleSheet literal cannot depend on the viewport. What is pinned now
 * is stronger: these screens must consult the SHARED envelope helper, and
 * must not reintroduce a private narrower literal.
 */
const WORKSPACE_SCREENS = [
  'SetupScreen.tsx',
  'MotorsScreen.tsx',
  'PortsScreen.tsx',
  'GpsScreen.tsx',
  'ConfigurationsScreen.tsx',
] as const;

function sourceOf(filename: string): string {
  return readFileSync(join(__dirname, filename), 'utf8');
}

describe('responsive shell', () => {
  it.each(READING_COLUMN_SCREENS)(
    '%s stays a reading column at the shared 1180px cap',
    filename => {
      const source = sourceOf(filename);
      expect(source).toContain('maxWidth: 1180');
      expect(source).not.toContain('maxWidth: 760');
    },
  );

  it.each(ENVELOPE_HELPER_SCREENS)(
    '%s asks the shared envelope helper and owns no private cap',
    filename => {
      const source = sourceOf(filename);
      expect(source).toContain('contentEnvelope(');
      expect(source).not.toContain('maxWidth: 1180');
      expect(source).not.toContain('maxWidth: 760');
    },
  );

  it.each(WORKSPACE_SCREENS)(
    '%s takes its content width from the shared envelope helper, not a private literal',
    filename => {
      const source = sourceOf(filename);
      expect(source).toContain('useContentEnvelope');
      expect(source).toContain('maxWidth: contentMaxWidth');
      // No screen may invent a narrower private cap.
      expect(source).not.toContain('maxWidth: 760');
    },
  );

  it('the envelope helper widens ONLY for a screen that has actually split into columns', () => {
    // 1440, not 1920: a 1920 window is now its own tier with its own
    // (wider) envelope, which desktopLayout.test.ts covers. The rule
    // asserted HERE is the one that has not changed - splitting is what
    // earns the wider envelope, at every desktop tier.
    const desktop = resolveLayoutTier(1440, 1);
    expect(contentEnvelope(desktop, true)).toBe(WORKSPACE_MAX_WIDTH);
    expect(contentEnvelope(desktop, false)).toBe(CONTENT_MAX_WIDTH);
    const ultra = resolveLayoutTier(1920, 1);
    expect(contentEnvelope(ultra, false)).toBe(CONTENT_MAX_WIDTH);
    // Below the desktop tier nothing widens, so Android is untouched.
    const tablet = resolveLayoutTier(800, 1);
    expect(contentEnvelope(tablet, true)).toBe(CONTENT_MAX_WIDTH);
  });

  it('a desktop window genuinely uses more of its width than the old fixed cap', () => {
    const desktop = resolveLayoutTier(1920, 1);
    expect(contentEnvelope(desktop, true)).toBeGreaterThan(1180);
  });

  it('keeps the bottom navigation aligned with the same tablet envelope', () => {
    const source = readFileSync(
      join(__dirname, '../components/navigation/BottomTabBar.tsx'),
      'utf8',
    );
    expect(source).toContain('maxWidth: 1180');
  });

  it('desktop gets a side rail instead of the phone bottom bar, and exactly one of the two', () => {
    const shell = readFileSync(join(__dirname, 'MainTabsScreen.tsx'), 'utf8');
    expect(shell).toContain('SideNavigationRail');
    expect(shell).toContain('isDesktopTier');
    // The panels themselves must still be kept mounted and hidden - the
    // invariant the motor-stop bridge depends on.
    expect(shell).toContain("hidden: { display: 'none' }");
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
