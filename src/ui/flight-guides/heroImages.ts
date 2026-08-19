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
 * A MISSING COVER IS A FIRST-CLASS STATE. The map is partial on purpose.
 * A corner with no photograph yet renders its designed fallback panel
 * (see FlightStyleGuideScreen) rather than a broken frame or a stretched
 * placeholder, so the index is usable before every photograph has landed
 * and no card ever shows another style's picture as a stand-in.
 *
 * TO REGISTER ONE: drop the file in the path above and add its line
 * below. Nothing else changes.
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
  // 'cinematic':  require('../../../docs/flight-guides/cinematic/hero/hero.jpg'),
  // 'freestyle':  require('../../../docs/flight-guides/freestyle/hero/hero.jpg'),
  // 'racing':     require('../../../docs/flight-guides/racing/hero/hero.jpg'),
  // 'tiny-whoop': require('../../../docs/flight-guides/tiny-whoop/hero/hero.jpg'),
  // 'long-range': require('../../../docs/flight-guides/long-range/hero/hero.jpg'),
};
