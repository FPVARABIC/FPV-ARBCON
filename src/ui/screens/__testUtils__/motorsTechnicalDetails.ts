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

function pressByTestId(tree: ReactTestRenderer, testID: string): void {
  const toggle = tree.root
    .findAllByProps({testID})
    .find(node => typeof node.props?.onPress === 'function');
  if (toggle === undefined) {
    throw new Error(`no pressable "${testID}" on the Motors screen`);
  }
  act(() => {
    toggle.props.onPress();
  });
}

export function openMotorsTechnicalDetails(tree: ReactTestRenderer): void {
  pressByTestId(tree, MOTORS_TECHNICAL_DETAILS_TOGGLE);
}

/**
 * M-F2 §19/§24: the direction and reorder workflows are PRIMARY now -
 * one labelled button each, beside the airframe, not inside the
 * technical-details disclosure. Suites that exercise them open them the
 * way an operator does. The helpers fail loudly if the entry ever
 * disappears, which is exactly the §54 visibility contract.
 */
export const MOTORS_DIRECTION_TOOL_TOGGLE = 'motors-open-direction';
export const MOTORS_REORDER_TOOL_TOGGLE = 'motors-open-reorder';

export function openMotorsDirectionTool(tree: ReactTestRenderer): void {
  pressByTestId(tree, MOTORS_DIRECTION_TOOL_TOGGLE);
}

export function openMotorsReorderTool(tree: ReactTestRenderer): void {
  pressByTestId(tree, MOTORS_REORDER_TOOL_TOGGLE);
}
