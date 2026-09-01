/**
 * HOW GOOD IS THIS GPS FIX, RIGHT NOW - in words a pilot can act on.
 *
 * THE PROBLEM. The GPS screen showed a bare metric labelled "PDOP" with
 * a two-decimal number and nothing else. A long-range pilot deciding
 * whether to trust GPS Rescue cannot do anything with that: the acronym
 * is not explained, the unit is dimensionless, and - the part that
 * actually traps people - LOWER IS BETTER, which is the opposite of
 * every other number on that screen.
 *
 * WHAT THIS IS NOT. It is not a new measurement. The value is the one
 * the board already sends and this app already decodes; only its
 * interpretation is added.
 *
 * =====================================================================
 * WHY IT IS PDOP AND NOT HDOP, which matters for the label
 * =====================================================================
 *
 * The trailing u16 of MSP_RAW_GPS is `gpsSol.dop.pdop` (msp.c), and the
 * firmware's own MSP_SET_RAW_GPS handler carries the note that settles
 * it: `// hdop in 4.4 and earlier, pdop in 4.5 and above`. This app's
 * floor is API 1.47 - Betaflight 4.6 and later - so on every board it
 * accepts, the field is POSITIONAL dilution of precision, never
 * horizontal. betaflight-configurator names it `positionalDop` for the
 * same reason. Calling it HDOP would be a wrong label on a real number.
 *
 * =====================================================================
 * THE BANDS ARE BETAFLIGHT'S OWN
 * =====================================================================
 *
 * Copied from betaflight-configurator's getPositionalDopQuality()
 * (src/components/tabs/GpsTab.vue), which renders them as a five-star
 * scale: < 1, < 2, < 5, < 10, < 20, and everything above. Using the same
 * cut points means an operator comparing this app against the official
 * configurator sees the same verdict rather than two apps disagreeing
 * about the same satellites.
 */

/** Betaflight's cut points, lowest DOP first. Lower is better. */
export const GPS_PDOP_BANDS: readonly number[] = Object.freeze([1, 2, 5, 10, 20]);

export type GpsPositionQuality =
  | 'IDEAL'
  | 'EXCELLENT'
  | 'GOOD'
  | 'MODERATE'
  | 'FAIR'
  | 'POOR'
  /** No value arrived, so no verdict is offered - never a guess. */
  | 'UNKNOWN';

/**
 * Classifies a PDOP reading in hundredths, exactly as the board sends it.
 *
 * `undefined` in, UNKNOWN out. A board that did not send the field, or a
 * reading this app could not decode, must not be reported as any
 * quality at all - "no data" and "poor" are different facts and only one
 * of them is a reason not to fly.
 */
export function classifyGpsPositionQuality(
  pdopHundredths: number | undefined,
): GpsPositionQuality {
  if (pdopHundredths === undefined || !Number.isFinite(pdopHundredths) || pdopHundredths < 0) {
    return 'UNKNOWN';
  }
  const pdop = pdopHundredths / 100;
  if (pdop < GPS_PDOP_BANDS[0]) return 'IDEAL';
  if (pdop < GPS_PDOP_BANDS[1]) return 'EXCELLENT';
  if (pdop < GPS_PDOP_BANDS[2]) return 'GOOD';
  if (pdop < GPS_PDOP_BANDS[3]) return 'MODERATE';
  if (pdop < GPS_PDOP_BANDS[4]) return 'FAIR';
  return 'POOR';
}

/**
 * Whether this reading is good enough that a rescue is worth trusting.
 *
 * Deliberately CONSERVATIVE and deliberately coarse: it collapses
 * Betaflight's six bands into the one question a pilot is actually
 * asking before they fly out of sight. UNKNOWN is not "yes" - a fix
 * whose quality never arrived is not a fix whose quality is fine.
 */
export function isGpsPositionTrustworthyForRescue(quality: GpsPositionQuality): boolean {
  return quality === 'IDEAL' || quality === 'EXCELLENT' || quality === 'GOOD';
}
