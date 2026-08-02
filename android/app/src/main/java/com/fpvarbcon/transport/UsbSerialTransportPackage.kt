package com.fpvarbcon.transport

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers UsbSerialTransportModule. This is a first-party in-app native
 * module (not an npm package), so it is not discovered by autolinking and
 * must be added to the package list manually in MainApplication.kt.
 */
class UsbSerialTransportPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NativeUsbSerialTransportSpec.NAME) {
      UsbSerialTransportModule(reactContext)
    } else {
      null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeUsbSerialTransportSpec.NAME to
        ReactModuleInfo(
          NativeUsbSerialTransportSpec.NAME,
          UsbSerialTransportModule::class.java.name,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // isCxxModule
          true, // isTurboModule
        )
    )
  }
}
