package com.fpvarbcon

import android.content.Context
import com.facebook.react.modules.i18nmanager.I18nUtil

/**
 * THE RIGHT-TO-LEFT DECISION, TAKEN BEFORE ANYTHING CAN READ IT.
 *
 * App.tsx already asks for it:
 *
 *     if (!I18nManager.isRTL) {
 *       I18nManager.allowRTL(true);
 *       I18nManager.forceRTL(true);
 *     }
 *
 * On Android that request cannot affect the launch it is made on, for two
 * independent reasons, both read off the shipped React Native sources:
 *
 *  1. I18nManagerModule.forceRTL only writes a SharedPreference
 *     (I18nUtil.kt: `setPref(context, KEY_FOR_PREFS_FORCERTL, forceRTL)`).
 *     It re-lays out nothing.
 *
 *  2. Nothing re-reads it afterwards. FabricUIManager.startSurface passes
 *     `I18nUtil.getInstance().isRTL(context)` into the surface constraints
 *     when the surface STARTS, and Libraries/ReactNative/I18nManager.js
 *     captures `isRTL` once, at module load, into a module-level constant:
 *
 *         const i18nConstants = getI18nManagerConstants();
 *         ...
 *         isRTL: i18nConstants.isRTL
 *
 *     Both of those happen before App.tsx's own module body runs.
 *
 * So on a FRESH INSTALL - where RCTI18nUtil_forceRTL is unset and
 * I18nUtil.isRTL is therefore false - the first launch of an Arabic-first
 * configurator laid out left-to-right, and every `I18nManager.isRTL` read
 * in shared code (the icon layer's layoutDirection.ts among them) answered
 * false for that entire session. The second launch, reading the preference
 * the first one had written, was correct. The bug was invisible to Jest,
 * which has no Android preferences and no surface.
 *
 * Setting the same preferences here, from Application.onCreate and before
 * loadReactNative, is what makes the existing request take effect on the
 * launch that makes it. This decides nothing new: forcing RTL regardless
 * of the device locale is what App.tsx already asked for, unconditionally.
 */
fun applyArabicLayoutDirection(context: Context) {
  I18nUtil.instance.allowRTL(context, true)
  I18nUtil.instance.forceRTL(context, true)
}

/**
 * React Native's own preference file and keys, named here so the
 * instrumentation test can build a fresh-install fixture instead of
 * assuming one. Kept beside the writer so the two cannot drift.
 */
const val RN_RTL_PREFERENCES = "com.facebook.react.modules.i18nmanager.I18nUtil"
const val RN_RTL_KEY_FORCE = "RCTI18nUtil_forceRTL"
const val RN_RTL_KEY_ALLOW = "RCTI18nUtil_allowRTL"
