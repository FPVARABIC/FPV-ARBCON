/**
 * WHAT WAS BEING WRITTEN WHEN THE ANSWER STOPPED COMING BACK.
 *
 * THE DEFECT THIS CLOSES. Five screens rendered their internal write-group
 * identifier straight into Arabic copy at the single worst moment - an
 * UNCONFIRMED save, the one outcome where the operator MUST understand
 * what happened before touching anything else. A real board produced:
 *
 *     نتيجة الكتابة غير مؤكدة عند RXFAIL_CONFIG
 *     نتيجة BATTERY_CONFIG غير مؤكدة
 *     نتيجة كتابة POWER_LEVEL غير مؤكدة
 *
 * That is our source code quoted at a pilot. It tells them nothing about
 * which setting is now in doubt, and the whole point of reporting
 * UNCONFIRMED rather than swallowing it is that the operator can act on
 * it. FailsafeScreen's own header already described exactly this bug for
 * validation codes and fixed it there; the save path kept doing it.
 *
 * ONE VOCABULARY, NOT FIVE. A shared map instead of five inline ternaries
 * so the words a pilot reads for "the failsafe settings" are the same
 * wherever they appear, and so a new write group is a compile error here
 * rather than a raw token on screen.
 *
 * EEPROM IS THE INTERESTING CASE. It is not a settings group at all - it
 * is the persist step - and an unconfirmed EEPROM write means something
 * different from an unconfirmed settings write: the values may have
 * reached the board and simply not been committed. The copy says so.
 */

/** Every write group any settings screen can report, plus the persist step. */
export type WriteStageName =
  // Failsafe
  | 'FAILSAFE_CONFIG'
  | 'RXFAIL_CONFIG'
  | 'GPS_RESCUE'
  // Power
  | 'BATTERY_CONFIG'
  | 'VOLTAGE_METER_CONFIG'
  | 'CURRENT_METER_CONFIG'
  // OSD
  | 'GENERAL'
  | 'ELEMENT'
  | 'STATISTIC'
  | 'TIMER'
  // VTX
  | 'CONFIG'
  | 'BAND'
  | 'POWER_LEVEL'
  // PID
  | 'PID'
  | 'PID_ADVANCED'
  | 'RC_TUNING'
  | 'FILTER_CONFIG'
  | 'SIMPLIFIED'
  | 'COPY_PROFILE'
  | 'SELECT_PROFILE'
  | 'RESET_PID_PROFILE'
  | 'PROFILE_NAME'
  // The persist step every screen shares.
  | 'EEPROM';

/**
 * The operator-facing name of each stage.
 *
 * Phrased as "what setting", not "which command", because that is the
 * question the pilot is actually asking when a save comes back unsure.
 */
const STAGE_TEXT: Readonly<Record<WriteStageName, string>> = {
  FAILSAFE_CONFIG: "Failsafe-instellingen",
  RXFAIL_CONFIG: "Kanaalwaarden bij signaalverlies",
  GPS_RESCUE: "GPS Rescue-instellingen",

  BATTERY_CONFIG: "Accugrenzen",
  VOLTAGE_METER_CONFIG: "Spanningsmeter kalibreren",
  CURRENT_METER_CONFIG: "Stroommeter kalibreren",

  GENERAL: "Algemene OSD-instellingen",
  ELEMENT: "Positie van een OSD-element",
  STATISTIC: "Statistieken na de vlucht",
  TIMER: "OSD-timers",

  CONFIG: "Videozenderinstellingen",
  BAND: "Frequentiebandtabel",
  POWER_LEVEL: "Vermogensniveaus",

  PID: "PID-waarden",
  PID_ADVANCED: "Geavanceerde PID-instellingen",
  RC_TUNING: "Rates en gascurve",
  FILTER_CONFIG: "Filters",
  SIMPLIFIED: "Schuifregelaars voor eenvoudige afstelling",
  COPY_PROFILE: "Afstelprofiel kopiëren",
  SELECT_PROFILE: "Actief profiel wisselen",
  RESET_PID_PROFILE: "PID-profiel naar fabriekswaarden terugzetten",
  PROFILE_NAME: "Profielnaam",

  EEPROM: "Instellingen opslaan in de vluchtcontroller",
};

/**
 * A complete Arabic sentence for an unconfirmed write.
 *
 * `index` is the zero-based row a screen was writing when it applies -
 * an RXFAIL channel, an OSD element, a VTX band - and is rendered
 * one-based because that is how every one of those screens numbers them
 * for the operator.
 */
/**
 * THE TWO SENTENCES FOR "RAM MOVED AND FLASH DID NOT".
 *
 * U-R1. A configuration save is a sequence of writes followed by a
 * persistence step, and the sequence can stop between them - because the
 * flight controller restarted, because the session changed, or because a
 * frame was refused outright. When that happens AFTER at least one write
 * was acknowledged, the aircraft's RAM has already moved.
 *
 * Neither of these may be called «فشل الحفظ»: that says nothing
 * happened, and something did. Neither may be called «تم الحفظ» either.
 * The truth has to name RAM against permanent storage, because that is
 * the difference the operator will meet at the next power cycle.
 *
 * `everythingApplied` separates the two: all the requested changes are
 * live and only persistence was missed, versus only SOME of them are
 * live - a mixture of old and new that no operator asked for and the
 * more alarming of the two.
 */
export function partialApplyMessage(everythingApplied: boolean): string {
  return everythingApplied
    ? "Alle wijzigingen kwamen in het werkgeheugen van de controller, maar de permanente opslag was niet gedaan; Het zal verloren gaan bij herstart. Sla niet opnieuw op; Maak de verbinding weer en lees eerst de instellingen."
    : "Een deel van de wijzigingen is toegepast in het werkgeheugen van de controller, maar is niet permanent opgeslagen. De controller werkt nu met een mix van oud en nieuw tot het opnieuw opstarten. Sla niet opnieuw op; Maak de verbinding weer en lees eerst de instellingen.";
}

export function unconfirmedWriteMessage(stage: WriteStageName, index?: number): string {
  const what = STAGE_TEXT[stage];
  const row = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? ` nummer ${index + 1}` : '';
  if (stage === 'EEPROM') {
    // Not a settings group: the values may have arrived and simply not
    // been committed, which is a different thing to tell the operator.
    return "De instellingen kunnen de controller hebben bereikt, maar permanent opslaan is niet bevestigd. Sla niet opnieuw op; verbind opnieuw en lees eerst de instellingen uit.";
  }
  return `Schrijven van ${what}${row} is niet bevestigd. Sla niet opnieuw op; verbind opnieuw en lees eerst de instellingen uit.`;
}
