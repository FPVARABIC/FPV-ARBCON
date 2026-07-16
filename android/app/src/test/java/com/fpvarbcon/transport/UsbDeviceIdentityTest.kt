package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class UsbDeviceIdentityTest {

  @Test
  fun `identical deviceId, vendorId, and productId match`() {
    val original = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 3)
    val refetched = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 3)

    assertEquals(original, refetched)
  }

  @Test
  fun `a different deviceId is a mismatch`() {
    val original = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 3)
    val refetched = UsbDeviceIdentity(deviceId = 99, vendorId = 2, productId = 3)

    assertNotEquals(original, refetched)
  }

  @Test
  fun `a different vendorId is a mismatch even if deviceId matches`() {
    val original = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 3)
    val refetched = UsbDeviceIdentity(deviceId = 1, vendorId = 99, productId = 3)

    assertNotEquals(original, refetched)
  }

  @Test
  fun `a different productId is a mismatch even if deviceId and vendorId match`() {
    val original = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 3)
    val refetched = UsbDeviceIdentity(deviceId = 1, vendorId = 2, productId = 99)

    assertNotEquals(original, refetched)
  }
}
