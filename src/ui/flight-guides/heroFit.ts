/**
 * HOW EACH COVER PHOTOGRAPH MEETS ITS FRAME - decided by measuring the
 * photographs, not by picking one rule and hoping.
 *
 * The frame is 16:9 for every card, because a directory of five aircraft
 * has to read as one shelf. The photographs are not 16:9, and they are
 * not even the same shape as each other, so the question "crop or fit?"
 * has a different answer per image. It was answered by measuring the
 * tight bounding box of the SUBJECT in each file (the non-background
 * pixels) and checking whether a centred 16:9 crop would cut into it:
 *
 *   cinematic    1536x864   ratio 1.778   crop loses 0%    subject intact
 *   freestyle    1536x1026  ratio 1.497   crop loses 16%   CUTS the subject
 *   tiny-whoop   1536x1134  ratio 1.354   crop loses 24%   CUTS the subject
 *   racing       1536x1536  ratio 1.000   crop loses 44%   CUTS the subject
 *   long-range   1536x1536  ratio 1.000   crop loses 44%   CUTS the subject
 *
 * So the cinematic frame is filled and the other four are fitted.
 *
 * WHY THAT IS THE RIGHT SPLIT AND NOT A COMPROMISE. The cinematic image
 * is a photograph of a scene - sky, field, a tree - and it is already
 * exactly 16:9, so `cover` fills the band edge to edge with nothing lost
 * and no letterbox. The other four are cut-out product shots on flat
 * white: cropping them to 16:9 would slice propeller tips off the racing
 * and long-range builds (44% of the height gone) and clip the whoop's
 * lower duct. Fitting them loses nothing, and the empty sides are
 * invisible because the frame behind them is the same white the
 * photographs already sit on.
 *
 * Losing the tip of a propeller from the picture of an aircraft whose
 * guide is about propeller settings is not a cosmetic loss.
 *
 * IF A PHOTOGRAPH IS REPLACED, RE-MEASURE. The numbers above belong to
 * these exact files; a new crop of the same aircraft can flip the answer.
 *
 * This file is deliberately platform-neutral - no `require`, no asset
 * import - so the Metro and browser halves of heroImages read the same
 * decision instead of each carrying their own copy of it.
 */

import type {FlightStyleId} from './guideContent';

/** `cover` fills the frame and may crop; `contain` fits and never crops. */
export type HeroFit = 'cover' | 'contain';

export const FLIGHT_STYLE_HERO_FIT: Readonly<
  Partial<Record<FlightStyleId, HeroFit>>
> = {
  cinematic: 'cover',
  freestyle: 'contain',
  racing: 'contain',
  'tiny-whoop': 'contain',
  'long-range': 'contain',
};

/** Fitted photographs sit on the white they were shot on, so the space
 *  beside them reads as part of the picture rather than as a gap. */
export const HERO_FITTED_BACKGROUND = '#FFFFFF';
