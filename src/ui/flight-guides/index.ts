/**
 * The flight-style guide's public surface.
 *
 * Screens import from here rather than reaching into the generated
 * modules or across into docs/, so the generator can change its output
 * shape without every screen following it.
 */

export {FLIGHT_STYLES, GUIDE_CORNERS, findCorner} from './guideContent';
export type {
  FlightStyleId,
  GuideCorner,
  GuideDecision,
  GuideDecisionKind,
  GuideStep,
} from './guideContent';
export {GUIDE_STEP_IMAGES} from './guideImages';
export {FLIGHT_STYLE_HERO_IMAGES} from './heroImages';
export {FLIGHT_STYLE_HERO_FIT, HERO_FITTED_BACKGROUND} from './heroFit';
export type {HeroFit} from './heroFit';
export {GuideHeader} from './GuideHeader';
export {GuideText} from './GuideText';
export {StyleCover} from './StyleCover';
