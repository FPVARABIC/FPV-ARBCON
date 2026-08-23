/**
 * OPEN THE MOTORS SCREEN'S TECHNICAL DETAILS SECTION.
 *
 * M-E §44 moved the verification wizard, the direction-authoring
 * workflow, the output-order transaction and the internal readiness
 * diagnostics out of the first viewport and under one disclosure. They
 * were not deleted, weakened or gated - they stopped standing between the
 * operator and the motors, which is a different thing.
 *
 * The suites that exercise those workflows therefore open the section the
 * way an operator would: one press. Every assertion in them is unchanged,
 * and a suite that uses this helper is stating, in one line, that what it
 * tests now lives behind a disclosure.
 *
 * It is deliberately NOT tolerant of the toggle being absent. If the
 * disclosure ever disappears, a caller should fail loudly rather than
 * quietly assert against a screen that no longer has the section at all.
 */
import {act, type ReactTestRenderer} from 'react-test-renderer';

export const MOTORS_TECHNICAL_DETAILS_TOGGLE = 'motors-advanced-verification-toggle';

export function openMotorsTechnicalDetails(tree: ReactTestRenderer): void {
  const toggle = tree.root
    .findAllByProps({testID: MOTORS_TECHNICAL_DETAILS_TOGGLE})
    .find(node => typeof node.props?.onPress === 'function');
  if (toggle === undefined) {
    throw new Error(
      `no pressable "${MOTORS_TECHNICAL_DETAILS_TOGGLE}" on the Motors screen`,
    );
  }
  act(() => {
    toggle.props.onPress();
  });
}
