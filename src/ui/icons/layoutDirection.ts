import {I18nManager} from 'react-native';

/**
 * Is the layout laid out right-to-left RIGHT NOW?
 *
 * ANDROID/NATIVE ANSWER. App.tsx calls I18nManager.forceRTL(true) before
 * the first render, and React Native's I18nManager is a real native
 * module, so this flag is the truth the layout engine itself uses.
 *
 * There is a `.web.ts` sibling because the browser cannot answer this the
 * same way — see that file. The split is by FILE EXTENSION, never by a
 * `Platform.OS` branch, matching how this repository separates every
 * other platform seam.
 */
export function isRtlLayout(): boolean {
  return I18nManager.isRTL;
}
