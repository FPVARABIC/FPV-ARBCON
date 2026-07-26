package com.fpvarbcon

import com.facebook.react.ReactPackage

/**
 * Pass 7.7 - the RELEASE half of the variant-safe registration seam: a
 * no-op with the exact same signature as the debug one, so both variants
 * compile against the identical MainApplication call site while the
 * release build registers no diagnostic package at all.
 *
 * This file imports nothing from com.fpvarbcon.debug and does not live in
 * that package, so a release DEX built from it contains no
 * `Lcom/fpvarbcon/debug/`, no UsbAppLogCapturePackage, no
 * UsbAppLogCaptureModule and no UsbBoundedProcessReader.
 */
internal fun variantReactPackages(): List<ReactPackage> = emptyList()
