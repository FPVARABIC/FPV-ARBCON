/**
 * THE OSD ELEMENT NAMES, PINNED AS COPY.
 *
 * A geometry gate cannot tell a fixed layout from shortened text. Both
 * make "does this label fit?" answer yes, and only one of them is a fix.
 * `scripts/verify-osd-labels.mjs` measures rendered width, so it goes
 * green either way - which was demonstrated: replacing «عصي التحكم
 * اليسرى» with a shorter «عصي يسرى» made every responsive assertion pass
 * while the operator lost the word that says WHICH sticks.
 *
 * So the names are pinned here, separately from the geometry. The point
 * is not that these strings may never change - a translation can improve
 * - but that shrinking one can never be an accident, and can never be
 * the silent means by which a layout defect is "fixed".
 *
 * Every name below was truncated at 1366 before the element chip's flex
 * basis was corrected, plus the longest name the table ships. They are
 * exactly the strings a layout shortcut would attack.
 */
import {OSD_ELEMENT_NAMES_AR, osdElementName} from './osdConfigurationModel';

/** The names the responsive defect actually ellipsized, by firmware index. */
const TRUNCATED_BEFORE_THE_FIX: ReadonlyArray<readonly [number, string]> = [
  [12, "Verbruikte capaciteit"],
  [22, "Gemiddelde celspanning"],
  [28, "Accuverbruik"],
  [43, "Motordiagnose"],
  [48, "Linker sticks"],
  [49, "Rechter sticks"],
  [52, "Naam rateprofiel"],
  [62, "Verbruikte wattuur"],
  [71, "Verbindingskwaliteit systeem"],
  [78, "Vorige rondetijd"],
];

/** The longest name in the table - the one the chip basis is sized for. */
const LONGEST = [86, "Eigen seriële tekst"] as const;

describe('OSD element names are copy, not layout padding', () => {
  it.each(TRUNCATED_BEFORE_THE_FIX)(
    'element %i still reads its full name',
    (index, expected) => {
      expect(osdElementName(index)).toBe(expected);
    },
  );

  it('keeps the longest name the element chip is sized to hold', () => {
    expect(osdElementName(LONGEST[0])).toBe(LONGEST[1]);
  });

  /* Not a style rule - a floor. Every name above is at least 14
     characters, and the chip basis was derived from the widest of them.
     Trimming any of them below that would quietly reduce what the chip
     has to hold, which is the layout shortcut this file exists to make
     visible. */
  it('none of the affected names has been abbreviated', () => {
    const shortened = TRUNCATED_BEFORE_THE_FIX.filter(
      ([index]) => osdElementName(index) !== TRUNCATED_BEFORE_THE_FIX.find(([id]) => id === index)?.[1] || /…|\.\.\./.test(osdElementName(index)),
    ).map(([index]) => `${index}="${osdElementName(index)}"`);
    expect(shortened).toEqual([]);
  });

  it('still names every element the firmware can report', () => {
    expect(OSD_ELEMENT_NAMES_AR).toHaveLength(88);
    expect(OSD_ELEMENT_NAMES_AR.every(name => name.trim().length > 0)).toBe(true);
  });
});
