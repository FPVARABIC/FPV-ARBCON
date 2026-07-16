package com.fpvarbcon.transport

/**
 * Plain, project-owned snapshot of the three fields used to confirm a
 * physical USB device is still the same one after the (asynchronous)
 * permission dialog. Not persisted and not a long-term identity - deviceId
 * alone is not guaranteed stable across detach/reattach or reboot, which is
 * exactly why vendorId/productId are checked alongside it here.
 */
internal data class UsbDeviceIdentity(
  val deviceId: Int,
  val vendorId: Int,
  val productId: Int,
)
