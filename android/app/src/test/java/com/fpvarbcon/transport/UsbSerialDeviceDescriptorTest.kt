package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Covers only the pure descriptor model and the sort-by-deviceId ordering
 * used by UsbSerialDeviceEnumerator. Does not exercise real UsbManager/
 * UsbSerialProber behavior - that requires instrumentation or a real device
 * (see Pass 3 report, section on genuine unresolved issues).
 */
class UsbSerialDeviceDescriptorTest {

  private fun descriptor(deviceId: Int, driverType: String = UsbSerialDriverType.UNSUPPORTED, portsAvailable: Int = 0) =
    UsbSerialDeviceDescriptor(
      deviceId = deviceId,
      vendorId = 0,
      productId = 0,
      productName = null,
      manufacturerName = null,
      driverType = driverType,
      portCount = UsbSerialDriverType.portCountFor(driverType, portsAvailable),
    )

  @Test
  fun `sorting by deviceId is deterministic ascending`() {
    val unordered = listOf(descriptor(30), descriptor(10), descriptor(20))

    val sorted = unordered.sortedBy { it.deviceId }

    assertEquals(listOf(10, 20, 30), sorted.map { it.deviceId })
  }

  @Test
  fun `an UNSUPPORTED descriptor always has zero portCount, even if ports were available`() {
    val descriptor = descriptor(1, driverType = UsbSerialDriverType.UNSUPPORTED, portsAvailable = 5)

    assertEquals(UsbSerialDriverType.UNSUPPORTED, descriptor.driverType)
    assertEquals(0, descriptor.portCount)
  }

  @Test
  fun `a supported descriptor keeps its real portCount`() {
    val descriptor = descriptor(1, driverType = UsbSerialDriverType.CDC_ACM, portsAvailable = 2)

    assertEquals(2, descriptor.portCount)
  }

  @Test
  fun `absent optional names stay null rather than a placeholder`() {
    val descriptor = descriptor(1)

    assertNull(descriptor.productName)
    assertNull(descriptor.manufacturerName)
  }
}
