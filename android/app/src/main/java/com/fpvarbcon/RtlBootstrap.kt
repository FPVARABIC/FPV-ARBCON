package com.fpvarbcon

import android.content.Context
import com.facebook.react.modules.i18nmanager.I18nUtil

/** Dutch layout is decided before React Native creates its first surface. */
fun applyDutchLayoutDirection(context: Context) {
  I18nUtil.instance.allowRTL(context, false)
  I18nUtil.instance.forceRTL(context, false)
}

const val RN_RTL_PREFERENCES = "com.facebook.react.modules.i18nmanager.I18nUtil"
const val RN_RTL_KEY_FORCE = "RCTI18nUtil_forceRTL"
const val RN_RTL_KEY_ALLOW = "RCTI18nUtil_allowRTL"
