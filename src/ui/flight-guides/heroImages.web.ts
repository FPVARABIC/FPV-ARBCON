/**
 * THE COVER PHOTO OF EACH FLIGHT STYLE - browser resolution.
 *
 * Vite resolves this file instead of heroImages.ts and serves each
 * photograph as an ordinary hashed static asset: the exact committed
 * bytes, cache-busted by content hash, decoded by the browser.
 *
 * The reasoning - what these pictures are for, why each one lives inside
 * its own corner rather than in a shared gallery, and why a missing cover
 * is a designed state rather than a broken frame - is written once, in
 * heroImages.ts. Read it there.
 *
 * TO REGISTER ONE: drop the file at
 * docs/flight-guides/<style>/hero/hero.<ext>, then add its import and its
 * line below AND in heroImages.ts, so both platforms show the same photo.
 */

import type {ImageSourcePropType} from 'react-native';

import type {FlightStyleId} from './guideContent';

export const FLIGHT_STYLE_HERO_IMAGES: Partial<
  Record<FlightStyleId, ImageSourcePropType>
> = {
  // import cinematicHero from '../../../docs/flight-guides/cinematic/hero/hero.jpg';
  // 'cinematic': {uri: cinematicHero},
};
