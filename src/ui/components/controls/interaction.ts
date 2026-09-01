import type {PressableStateCallbackType} from 'react-native';

/**
 * The cross-platform interaction state for the shared controls.
 *
 * React Native's Pressable style callback types only `pressed`, but
 * react-native-web genuinely delivers `hovered` and `focused` in the same
 * object — a hover treatment is required web polish and invisible/harmless
 * on Android. This helper is the ONE place that widening is done, so no
 * control ever writes `as any` at a call site.
 */
export interface InteractionState {
  pressed: boolean;
  hovered: boolean;
  focused: boolean;
}

export function readInteraction(
  state: PressableStateCallbackType,
): InteractionState {
  const web = state as PressableStateCallbackType & {
    hovered?: boolean;
    focused?: boolean;
  };
  return {
    pressed: state.pressed,
    hovered: web.hovered === true,
    focused: web.focused === true,
  };
}

/** The floor for a comfortable touch target, shared by every control.
 * Previously declared independently (and identically) by five files. */
export const MIN_TOUCH_TARGET = 44;
