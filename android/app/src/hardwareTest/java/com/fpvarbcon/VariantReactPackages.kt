package com.fpvarbcon

import com.facebook.react.ReactPackage

/**
 * The HARDWARE TEST half of the Pass 7.7 variant-safe registration seam.
 *
 * `MainApplication` calls `variantReactPackages()` unconditionally, and
 * that function is supplied per build type: the debug source set returns
 * the app-log capture package, the release source set returns nothing.
 * Adding the `hardwareTest` build type created a third variant with no
 * implementation, so `:app:compileHardwareTestKotlin` failed with
 * "Unresolved reference 'variantReactPackages'" (Android Validation run
 * 30469539536).
 *
 * WHY THIS RETURNS EMPTY, EXACTLY LIKE RELEASE - AND NOT LIKE DEBUG.
 * The Hardware Test variant differs from Production in precisely two
 * ways: it carries the motor-test engine, and it says so in its
 * application id and visible label. It is NOT a debug build and must not
 * quietly acquire debug capabilities. Registering
 * `UsbAppLogCapturePackage` here would pull `com.fpvarbcon.debug` into a
 * non-debug DEX and reintroduce exactly the diagnostic surface Pass 7.7
 * removed - which the production bundle scanner's forbidden-token list
 * (UsbAppLogCapture, UsbAppLogCaptureModule, UsbBoundedProcessReader,
 * captureAppLog) exists to keep out of shipped builds.
 *
 * This file imports nothing from `com.fpvarbcon.debug` and does not live
 * in that package, so a Hardware Test DEX built from it contains no
 * `Lcom/fpvarbcon/debug/` reference at all.
 */
internal fun variantReactPackages(): List<ReactPackage> = emptyList()
