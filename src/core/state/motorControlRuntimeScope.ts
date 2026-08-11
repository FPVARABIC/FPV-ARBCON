/**
 * P2-i / P2-N - WHICH RESOLVED DOMAINS THE PROFESSIONAL RUNTIME PATH MAY
 * COMMAND.
 *
 * A pure, total classifier over a P1 `MotorTestValueDomain`. It imports
 * only the domain type; it has no I/O, no transport, no timers and no
 * state, and it commands nothing.
 *
 * THE RULE IT ENFORCES. P1 can DESCRIBE more configurations than P2 should
 * COMMAND. Being able to represent a domain is not a licence to drive it -
 * the question this module answers is separate and stricter: for this
 * exact configuration, does the pinned firmware give us everything the
 * runtime needs to command a motor and to stop it again?
 *
 * ANALOG 3D IS THE CASE THIS EXISTS FOR. `flight3DConfig()->limit3d_low`
 * and `limit3d_high` are the endpoints the firmware actually drives on the
 * analog 3D path (motor.c `analogInitEndpoints`), and MSP_MOTOR_3D_CONFIG
 * (124) does not carry them - it carries deadband3d_low, deadband3d_high
 * and neutral3d, six bytes, nothing more. So the active endpoints cannot
 * be reconstructed from MSP at API 1.47.
 *
 * THAT IS NOT EXTRA SAFETY FRICTION. It is missing protocol information.
 * The product refuses the configuration rather than guessing a range, and
 * the refusal names what is missing so a later API version, or a CLI read,
 * can lift it. Guessing would mean commanding a reversible aircraft
 * against an invented forward/reverse split.
 *
 * NO PHYSICAL CLAIMS. Eligibility means the protocol facts are complete.
 * It is never a statement that commanding is safe, that a motor will turn,
 * or that anything will stop. Physical behaviour remains REQUIRES HARDWARE
 * TEST.
 */

import type {MotorTestValueDomain} from '../firmware-adapters/betaflightMotorDomainV147';

/** Why the professional runtime path refuses a resolved domain. */
export type MotorControlScopeRefusal =
  /** Analog + FEATURE_3D: limit3d_low / limit3d_high are not on the wire
   * at API 1.47, so the active regions are unknown. */
  | 'ANALOG_3D_ACTIVE_ENDPOINTS_UNKNOWN'
  /** The domain resolver could not name a firmware family for the
   * configured protocol - MOTOR_PROTOCOL_DISABLED, or an unrecognised
   * raw. There is no external-value conversion to command through. */
  | 'PROTOCOL_FAMILY_UNKNOWN'
  /** 3D is enabled but the domain carries no neutral, so stop has no
   * value. Defensive: the resolver already refuses to produce this. */
  | 'THREE_D_NEUTRAL_UNRESOLVED'
  /** A 3D domain whose forward/reverse split the pinned conversion does
   * not prove. Analog 3D is the known instance; the check is written
   * against the missing PROOF rather than against the family, so a future
   * family with the same gap is refused by the same rule. */
  | 'THREE_D_ACTIVE_REGIONS_UNPROVEN';

export type MotorControlRuntimeScope =
  | {
      readonly eligible: true;
      /** Carried through so a caller never has to re-derive it, and so a
       * UI can show the provenance of the bounds it is offering. */
      readonly domain: MotorTestValueDomain;
    }
  | {
      readonly eligible: false;
      readonly refusal: MotorControlScopeRefusal;
      /** The domain's own record of what MSP could not tell us, verbatim.
       * Empty for refusals that are not about missing information. */
      readonly notKnowableFromMsp: readonly string[];
    };

/**
 * Classifies a resolved domain for the professional runtime path.
 *
 * ELIGIBLE TODAY:
 *   - DIGITAL non-3D. dshot.c constrains the external value and makes
 *     PWM_RANGE_MIN exactly stop; everything the runtime needs is proven.
 *   - DIGITAL 3D. The neutral is the protocol constant PWM_RANGE_MIDDLE
 *     and the forward/reverse split is the firmware's own branch, so the
 *     midpoint semantics are exact rather than assumed.
 *   - ANALOG non-3D, on the bounded CONFIGURATION_POLICY domain
 *     mincommand..maxthrottle. The stop value is firmware-proven
 *     (`*disarm = motorConfig->mincommand`); the bounds are the product's
 *     control policy and the domain says so.
 *
 * REFUSED TODAY:
 *   - ANALOG 3D, for the reason in this module's header.
 *   - Any domain whose protocol family is UNKNOWN.
 */
export function classifyMotorControlRuntimeScope(
  domain: MotorTestValueDomain,
): MotorControlRuntimeScope {
  if (domain.protocolFamily === 'UNKNOWN') {
    return Object.freeze({
      eligible: false as const,
      refusal: 'PROTOCOL_FAMILY_UNKNOWN' as const,
      notKnowableFromMsp: domain.notKnowableFromMsp,
    });
  }

  if (domain.feature3dEnabled) {
    if (domain.neutral === undefined) {
      return Object.freeze({
        eligible: false as const,
        refusal: 'THREE_D_NEUTRAL_UNRESOLVED' as const,
        notKnowableFromMsp: domain.notKnowableFromMsp,
      });
    }
    // Written against the missing PROOF, not against the family name: a
    // 3D domain whose regions the pinned conversion does not establish is
    // refused whatever family it belongs to.
    if (
      domain.provenReverseRegion === undefined ||
      domain.provenForwardRegion === undefined
    ) {
      return Object.freeze({
        eligible: false as const,
        refusal:
          domain.protocolFamily === 'PWM'
            ? ('ANALOG_3D_ACTIVE_ENDPOINTS_UNKNOWN' as const)
            : ('THREE_D_ACTIVE_REGIONS_UNPROVEN' as const),
        notKnowableFromMsp: domain.notKnowableFromMsp,
      });
    }
  }

  return Object.freeze({eligible: true as const, domain});
}
