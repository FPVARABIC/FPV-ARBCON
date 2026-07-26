package com.fpvarbcon

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
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
    loadReactNative(this)
  }
}
