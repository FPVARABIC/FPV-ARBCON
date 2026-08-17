/**
 * THE ONE WAY THE OFFICIAL LOGO RENDERS.
 *
 * The committed asset is a 1024x1536 WebP whose visible emblem sits inside
 * large transparent margins. Measured in Chromium by scanning the decoded
 * alpha channel (alpha > 8): the opaque content occupies x 244..835 and
 * y 329..1089 - a 592x761 box, roughly 24%/18% side margins and 21%/29%
 * top/bottom. Rendered "contain" at header height, more than half the
 * granted space would be transparent padding and the emblem would shrink
 * to about half size.
 *
 * So this component sizes a clipping window to the MEASURED CONTENT BOX
 * and positions the full, untouched image inside it at the matching
 * negative offsets. Presentation-layer cropping only: the asset bytes are
 * exactly the operator's file, the emblem keeps its true aspect ratio
 * (592:761), and nothing is redrawn or re-encoded.
 *
 * Accessibility: exactly one instance per surface is the brand mark and
 * carries the label; pass decorative when another element on the same
 * surface already announces the identity, so screen readers never hear
 * the brand twice.
 */

import React from 'react';
import {Image, StyleSheet, View} from 'react-native';

import {BRAND_LOGO_SOURCE} from './brandLogoSource';

/** Full asset canvas, from the file's own VP8X header. */
const ASSET_WIDTH = 1024;
const ASSET_HEIGHT = 1536;
/** Measured opaque-content bounding box (see the header comment). */
const CONTENT_LEFT = 244;
const CONTENT_TOP = 329;
export const BRAND_LOGO_CONTENT_WIDTH = 592;
export const BRAND_LOGO_CONTENT_HEIGHT = 761;
/** Width / height of the visible emblem - what layouts should reserve. */
export const BRAND_LOGO_ASPECT =
  BRAND_LOGO_CONTENT_WIDTH / BRAND_LOGO_CONTENT_HEIGHT;

/** The product's Arabic brand name, as written inside the logo itself. */
export const BRAND_LOGO_LABEL = 'FPV بالعربي';

/**
 * The product name that sits beside the emblem, and the ONLY spelling of
 * it in the interface.
 *
 * It lives here rather than in each surface because the identity used to
 * be written twice - the web top strip showed the emblem alone, the Start
 * screen showed "FPV-ARBCON" - so the product introduced itself by its
 * repository slug on one surface and not at all on the other. One
 * constant means the browser chrome and the Android Start screen cannot
 * drift apart again.
 *
 * NOT translated. It is a proper noun, and the Arabic name is already
 * inside the emblem next to it (BRAND_LOGO_LABEL).
 */
export const BRAND_PRODUCT_NAME = 'FPV Arabic Configurator';

/** The Arabic line under the product name. */
export const BRAND_PRODUCT_TAGLINE = 'مركز تحكم الطيران العربي';

export interface BrandLogoProps {
  /** Height of the VISIBLE emblem in dp; width follows its true aspect. */
  readonly height: number;
  /**
   * True when another element on the same surface already announces the
   * brand - the image is then hidden from assistive technology instead
   * of repeating it.
   */
  readonly decorative?: boolean;
  readonly testID?: string;
}

export default function BrandLogo({
  height,
  decorative = false,
  testID = 'brand-logo',
}: BrandLogoProps): React.JSX.Element {
  const scale = height / BRAND_LOGO_CONTENT_HEIGHT;
  const width = height * BRAND_LOGO_ASPECT;
  return (
    <View
      testID={testID}
      style={[styles.window, {width, height}]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : BRAND_LOGO_LABEL}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
    >
      <Image
        testID={`${testID}-image`}
        source={BRAND_LOGO_SOURCE}
        accessible={false}
        style={[
          styles.image,
          {
            left: -CONTENT_LEFT * scale,
            top: -CONTENT_TOP * scale,
            width: ASSET_WIDTH * scale,
            height: ASSET_HEIGHT * scale,
          },
        ]}
        resizeMode="stretch"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  window: {
    overflow: 'hidden',
    /* The window is sized to the emblem itself; it must never stretch or
       shrink with the row around it, or the crop offsets stop lining up. */
    flexGrow: 0,
    flexShrink: 0,
  },
  /* Static half of the crop positioning; the measured offsets and the
     scaled canvas size are computed per instance and merged inline. */
  image: {
    position: 'absolute',
  },
});
