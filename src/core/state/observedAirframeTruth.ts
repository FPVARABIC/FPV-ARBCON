/**
 * THE ONE ANSWER TO "WHICH AIRCRAFT IS THIS?", SHARED BY EVERY SCREEN.
 *
 * =====================================================================
 * THE DEFECT THIS EXISTS TO END
 * =====================================================================
 *
 * Motors reads MSP_MIXER_CONFIG and MSP_MOTOR_CONFIG, derives a topology,
 * and draws the aircraft the flight controller actually reported. Setup
 * drew a hard-coded four-arm X quad - `MOTOR_LAYOUT` in
 * droneSceneGeometry.ts was a literal array of four angles - so a board
 * flying a Y6, a tricopter or a flying wing was shown to the operator as
 * a quadcopter on the screen they open FIRST.
 *
 * Two screens describing the same aircraft differently is not a cosmetic
 * problem. The Setup model is the orientation reference an operator uses
 * to decide which way the board is mounted; a wrong airframe there is a
 * wrong answer to a physical question.
 *
 * =====================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * =====================================================================
 *
 * IT IS a publish/subscribe record of the LAST VERIFIED READ: the raw
 * mixer mode and the runtime motor count, exactly as they came back from
 * the board, plus the session they were read on. Whoever reads the
 * configuration publishes here; whoever draws an aircraft subscribes.
 *
 * IT IS NOT a second source of truth. It stores no derived geometry, no
 * layout, no arm angles and no opinion about what a mixer mode means -
 * `authoredAirframeLayout()` and `deriveMotorTopologyTruth()` remain the
 * only places that interpret these numbers. Storing a derived layout here
 * would be exactly the second conflicting source §10 forbids.
 *
 * IT IS NOT A DRAFT. Only values READ BACK FROM THE BOARD may be
 * published. A mixer the operator has selected but not yet saved is a
 * draft, it lives in the editing component, and Setup must keep showing
 * the aircraft that is actually configured until an activation is
 * verified. `publish()` is therefore named for observation, and every
 * call site passes values that came off the wire.
 *
 * =====================================================================
 * WHY A MODULE SINGLETON
 * =====================================================================
 *
 * The same reason fcRebootRecovery is one: the fact is a property of the
 * connected board, not of any component's lifetime. Motors unmounts when
 * the operator switches tabs; the aircraft does not change shape when
 * they do. The class is exported for tests, which build their own
 * instance rather than leaking state between cases.
 */

export interface ObservedAirframe {
  /** MSP_MIXER_CONFIG offset 0, raw - never a name, never an enum this
   *  module invented. */
  readonly mixerModeRaw: number;
  /**
   * MSP_MOTOR_CONFIG's motorCount, the runtime authority.
   *
   * `undefined` means the board did not report one. That is a real state
   * - a count is not guessed from the mixer, here or anywhere else - and
   * a consumer that cannot draw without it must say so rather than
   * substitute four.
   */
  readonly motorCount: number | undefined;
  /** The session these values were read on. A consumer can tell a stale
   *  record from a current one without this module guessing for it. */
  readonly sessionId: string;
}

type Listener = (observed: ObservedAirframe | undefined) => void;

export class ObservedAirframeTruthStore {
  private observed: ObservedAirframe | undefined;
  private readonly listeners = new Set<Listener>();

  /** The last verified read, or undefined when nothing has been read on
   *  any live session. */
  get(): ObservedAirframe | undefined {
    return this.observed;
  }

  /**
   * Records what the board reported.
   *
   * IDENTICAL VALUES DO NOT NOTIFY. Motors reloads its configuration on
   * every session change and after every save, and a subscriber that
   * re-rendered a 3D scene on each of those would be paying for a change
   * that did not happen.
   */
  publish(observed: ObservedAirframe): void {
    const previous = this.observed;
    if (
      previous !== undefined &&
      previous.mixerModeRaw === observed.mixerModeRaw &&
      previous.motorCount === observed.motorCount &&
      previous.sessionId === observed.sessionId
    ) {
      return;
    }
    this.observed = Object.freeze({...observed});
    this.notify();
  }

  /**
   * Forgets what was observed.
   *
   * Called when a session ends. A DISCONNECTED BOARD HAS NO AIRFRAME:
   * keeping the last one would make Setup draw the previous aircraft over
   * a dead link, which is the stale-truth defect in a different costume.
   */
  clear(): void {
    if (this.observed === undefined) return;
    this.observed = undefined;
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener(this.observed);
    }
  }
}

/** The application's one record. See the note on why this is a module
 *  singleton rather than component state. */
export const observedAirframeTruth = new ObservedAirframeTruthStore();
