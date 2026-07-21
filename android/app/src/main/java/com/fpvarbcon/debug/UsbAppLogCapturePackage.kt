package com.fpvarbcon.debug

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.3) - registers [UsbAppLogCaptureModule]
 * as a plain (non-TurboModule) NativeModule via the standard, always-
 * supported `ReactPackage.createNativeModules()` path - deliberately not a
 * `BaseReactPackage`/Codegen TurboModule spec like UsbSerialTransportPackage,
 * since this is throwaway debug scaffolding, not a real transport contract.
 * Remove this file, UsbAppLogCaptureModule.kt, and this package's one
 * registration line in MainApplication.kt together, alongside
 * UsbSerialDebugPanel.tsx, once no longer needed.
 */
internal class UsbAppLogCapturePackage : ReactPackage {

  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(UsbAppLogCaptureModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
