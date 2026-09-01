/**
 * THE MOTOR-DIRECTION WORKFLOW'S PER-MOTOR SESSION STATUS - M-F3 §18.
 *
 * WHAT THIS IS. A record of what THE OPERATOR DID AND ANSWERED in this
 * session's guided direction check, one status per motor:
 *
 *   UNCHECKED          لم يُفحص - no answer recorded this session.
 *   CONFIRMED_CORRECT  الاتجاه صحيح - the operator watched the motor and
 *                      answered that it turns the right way.
 *   NEEDS_REVERSE      يحتاج للعكس - the operator answered that it turns
 *                      the wrong way; nothing has been sent yet.
 *   REVERSED_RECHECK   تم عكسه ويحتاج إعادة فحص - a reverse command was
 *                      ACKNOWLEDGED by the flight controller after that
 *                      answer. Acknowledged is not verified: the motor
 *                      must be spun and watched again.
 *   CONFIRMED_FINAL    تم التأكيد - after a reversal, the operator
 *                      watched again and confirmed the direction.
 *
 * WHAT THIS IS NOT. Not a readback and not a physical measurement: the
 * audited MSP surface at API 1.47 has no command that reports an ESC's
 * spin direction (M-F3 §14/§56 trace), so the ONLY sources here are the
 * operator's own answers and the FC's acknowledgements of what was
 * asked. §17: an acknowledgement alone can never produce a "correct" or
 * "confirmed" status - only REVERSED_RECHECK, which by name demands
 * another look. §18 permits exactly this: workflow/session state,
 * because that is all the source allows.
 *
 * The transition function is pure and total so its truth table can be
 * pinned test-by-test and mutated against.
 */

export type MotorDirectionWorkflowStatus =
  | 'UNCHECKED'
  | 'CONFIRMED_CORRECT'
  | 'NEEDS_REVERSE'
  | 'REVERSED_RECHECK'
  | 'CONFIRMED_FINAL';

export type MotorDirectionWorkflowEvent =
  /** The operator answered «نعم» - the motor turns as shown/known. */
  | { readonly kind: 'ANSWER_CORRECT' }
  /** The operator answered «لا» - the motor turns the wrong way. */
  | { readonly kind: 'ANSWER_WRONG' }
  /** The flight controller ACKNOWLEDGED a spin-direction command for
   * this motor. Reception, not application - see the header. */
  | { readonly kind: 'REVERSE_ACKNOWLEDGED' };

/**
 * One step of the workflow. Hand-written case by case - no arithmetic
 * over the union - so every row is individually assertable:
 *
 *   ANSWER_CORRECT       from REVERSED_RECHECK -> CONFIRMED_FINAL
 *                        (the recheck after a reversal is the stronger
 *                        claim, and keeps the reversal in its history);
 *                        from anywhere else    -> CONFIRMED_CORRECT.
 *   ANSWER_WRONG         from anywhere -> NEEDS_REVERSE. A wrong answer
 *                        overrides every earlier confirmation - the
 *                        operator just watched it turn the wrong way.
 *   REVERSE_ACKNOWLEDGED from anywhere -> REVERSED_RECHECK. Whatever was
 *                        believed before, the stored setting has been
 *                        asked to change, so nothing is confirmed until
 *                        the next look. Never CONFIRMED_* (§17).
 */
export function nextMotorDirectionWorkflowStatus(
  current: MotorDirectionWorkflowStatus,
  event: MotorDirectionWorkflowEvent,
): MotorDirectionWorkflowStatus {
  switch (event.kind) {
    case 'ANSWER_CORRECT':
      return current === 'REVERSED_RECHECK'
        ? 'CONFIRMED_FINAL'
        : 'CONFIRMED_CORRECT';
    case 'ANSWER_WRONG':
      return 'NEEDS_REVERSE';
    case 'REVERSE_ACKNOWLEDGED':
      return 'REVERSED_RECHECK';
  }
}

/** The i18n key suffix for a status - one place, so the chips, the
 *  spoken labels and the tests cannot drift apart. */
export function motorDirectionWorkflowStatusKey(
  status: MotorDirectionWorkflowStatus,
): string {
  switch (status) {
    case 'UNCHECKED':
      return 'directionStatusUnchecked';
    case 'CONFIRMED_CORRECT':
      return 'directionStatusCorrect';
    case 'NEEDS_REVERSE':
      return 'directionStatusNeedsReverse';
    case 'REVERSED_RECHECK':
      return 'directionStatusReversedRecheck';
    case 'CONFIRMED_FINAL':
      return 'directionStatusConfirmed';
  }
}
