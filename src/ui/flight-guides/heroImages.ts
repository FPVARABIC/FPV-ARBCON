/**
 * THE COVER PHOTO OF EACH FLIGHT STYLE - Metro/Jest resolution.
 *
 * WHAT THESE ARE. Not screenshots and not decoration: one photograph per
 * style, chosen to show the READER what kind of aircraft this corner is
 * written for, before they read a single number. A 65 mm ducted whoop and
 * a 7-inch long-range build are different machines, and the guide's
 * numbers are different because of that - the picture is the fastest way
 * to say so.
 *
 * WHERE THE FILES LIVE. Inside the corner that owns them:
 *
 *     docs/flight-guides/<style>/hero/hero.<ext>
 *
 * Same rule as that corner's step captures and its review sheet. There is
 * deliberately no shared cover folder: a style's cover belongs to the
 * style, and a gallery of all five would be exactly the pooled surface
 * this package refuses to build.
 *
 * SUPPLIED BY THE OWNER, NEVER REDRAWN. These are the operator's own
 * photographs, committed byte-for-byte and rendered from those bytes -
 * the same discipline src/ui/brand/brandLogoSource.ts states for the
 * logo. Nothing here traces, regenerates or "recreates" an image.
 *
 * A MISSING COVER IS A FIRST-CLASS STATE. The map stays partial by type
 * on purpose. A corner with no photograph renders its designed fallback
 * panel rather than a broken frame or a stretched placeholder, so the
 * index is usable before every photograph has landed and no card ever
 * shows another style's picture as a stand-in.
 *
 * HOW EACH ONE MEETS ITS FRAME - fill or fit - is measured per image and
 * recorded in heroFit.ts, not decided here.
 *
 * THE LONG-RANGE FILE ARRIVED NAMED .webp AND IS JPEG. Checked with
 * `file` before it was committed: the bytes are a JFIF JPEG. It is
 * stored as .jpg, because Vite serves by extension (a JPEG labelled
 * image/webp is a decode waiting to fail) and Metro registers the asset
 * type from it too. The bytes are untouched - only the name now tells
 * the truth about them.
 *
 * TO REGISTER ONE: drop the file in the path above and add its line
 * below, and its fit in heroFit.ts.
 *
 * tsconfig.web.json excludes this file: require() is a Metro construct
 * the DOM-typed project has no types for, and heroImages.web.ts is what
 * Vite resolves instead.
 */

import type {ImageSourcePropType} from 'react-native';

import type {FlightStyleId} from './guideContent';

export const FLIGHT_STYLE_HERO_IMAGES: Partial<
  Record<FlightStyleId, ImageSourcePropType>
> = {
  cinematic: require('../../../docs/flight-guides/cinematic/hero/hero.jpg') as ImageSourcePropType,
  freestyle: require('../../../docs/flight-guides/freestyle/hero/hero.jpg') as ImageSourcePropType,
  racing: require('../../../docs/flight-guides/racing/hero/hero.jpg') as ImageSourcePropType,
  'tiny-whoop': require('../../../docs/flight-guides/tiny-whoop/hero/hero.jpg') as ImageSourcePropType,
  'long-range': require('../../../docs/flight-guides/long-range/hero/hero.jpg') as ImageSourcePropType,
};
