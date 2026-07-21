package com.fpvarbcon

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.fpvarbcon.debug.UsbAppLogCapturePackage
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
          // TEMPORARY DEBUG SCAFFOLDING (Pass 5.3) - see UsbAppLogCaptureModule.kt's
          // own class-level note. Remove this line alongside that file.
          add(UsbAppLogCapturePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
