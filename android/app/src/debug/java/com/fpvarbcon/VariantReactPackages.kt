package com.fpvarbcon

import com.facebook.react.ReactPackage
import com.fpvarbcon.debug.UsbAppLogCapturePackage

/**
 * Pass 7.7 - the DEBUG half of the variant-safe registration seam.
 *
 * MainApplication (main source set) calls [variantReactPackages] without
 * ever importing anything under com.fpvarbcon.debug, so that package
 * exists only in the debug variant's compilation and can never reach the
 * release DEX. The debug build keeps the full hardware diagnostic
 * capability it had before this change.
 *
 * The seam is deliberately in package `com.fpvarbcon`, NOT
 * `com.fpvarbcon.debug`: the release APK must contain no
 * `Lcom/fpvarbcon/debug/` reference at all, including the seam itself.
 */
internal fun variantReactPackages(): List<ReactPackage> = listOf(UsbAppLogCapturePackage())
