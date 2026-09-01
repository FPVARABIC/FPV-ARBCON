package com.fpvarbcon

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.fpvarbcon.transport.UsbSerialTransportPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(UsbSerialTransportPackage())
          // Pass 7.7: the variant-safe seam. Debug supplies the app-log
          // capture package; release supplies an empty list, so nothing
          // under com.fpvarbcon.debug is referenced from the main source
          // set and none of it can reach the release DEX.
          addAll(variantReactPackages())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // The Arabic UI typeface. Registering the res/font XML family under
    // the name "Cairo" is what makes { fontFamily: 'Cairo', fontWeight }
    // in shared JS styles resolve to the real weight-mapped faces (see
    // res/font/cairo.xml); without this, Android would look for a
    // "Cairo.ttf" asset, miss, and silently fall back to the system font.
    // Registered before loadReactNative so no first-frame text can render
    // ahead of the family being known.
    ReactFontManager.getInstance().addCustomFont(this, "Cairo", R.font.cairo)
    loadReactNative(this)
  }
}
