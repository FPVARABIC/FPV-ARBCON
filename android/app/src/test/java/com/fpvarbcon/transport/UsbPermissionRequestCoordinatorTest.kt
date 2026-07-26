package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pass 7.7 - JVM unit coverage for the extracted permission decision core.
 * Plain JUnit, no Android and no new dependency (same style as this
 * project's existing UsbBoundedAttemptTest / UsbPromiseSettleOnceTest).
 */
class UsbPermissionRequestCoordinatorTest {

  private val deviceA = UsbDeviceIdentity(deviceId = 1001, vendorId = 0x0483, productId = 0x5740)
  private val deviceB = UsbDeviceIdentity(deviceId = 1002, vendorId = 0x10c4, productId = 0xea60)

  private fun coordinator() = UsbPermissionRequestCoordinator("com.fpvarbcon.transport.USB_PERMISSION")

  @Test
  fun `each request gets a unique package-scoped action`() {
    val c = coordinator()
    val first = c.register(deviceA) { _, _ -> }!!
    val second = c.register(deviceB) { _, _ -> }!!
    assertTrue(first != second)
    assertTrue(c.actionFor(first).startsWith("com.fpvarbcon.transport.USB_PERMISSION."))
    assertTrue(c.actionFor(first) != c.actionFor(second))
  }

  @Test
  fun `granted result settles exactly the matching request`() {
    val c = coordinator()
    var callbacks = 0
    val id = c.register(deviceA) { _, _ -> callbacks += 1 }!!
    val matched = c.matchResult(c.actionFor(id), id, deviceA)
    assertNotNull(matched)
    matched!!.onResult(true, null)
    assertEquals(1, callbacks)
    assertEquals(0, c.pendingCount())
  }

  @Test
  fun `two concurrent device requests cannot consume each other's result`() {
    val c = coordinator()
    var aResults = 0
    var bResults = 0
    val idA = c.register(deviceA) { _, _ -> aResults += 1 }!!
    val idB = c.register(deviceB) { _, _ -> bResults += 1 }!!

    // Device B's broadcast carrying request A's id: rejected (wrong device).
    assertNull(c.matchResult(c.actionFor(idA), idA, deviceB))
    // Device A's identity on request B's action/id: rejected too.
    assertNull(c.matchResult(c.actionFor(idB), idB, deviceA))
    assertEquals(2, c.pendingCount())

    c.matchResult(c.actionFor(idA), idA, deviceA)!!.onResult(true, null)
    c.matchResult(c.actionFor(idB), idB, deviceB)!!.onResult(false, null)
    assertEquals(1, aResults)
    assertEquals(1, bResults)
  }

  @Test
  fun `missing device extra is rejected`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNull(c.matchResult(c.actionFor(id), id, null))
    assertEquals(1, c.pendingCount())
  }

  @Test
  fun `spoofed or wrong action is rejected`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNull(c.matchResult("com.evil.OTHER_ACTION", id, deviceA))
    assertNull(c.matchResult(null, id, deviceA))
    // Right prefix, wrong id -> action mismatch for this request.
    assertNull(c.matchResult(c.actionFor(id + 99), id, deviceA))
    assertEquals(1, c.pendingCount())
  }

  @Test
  fun `duplicate broadcast for the same request settles only once`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNotNull(c.matchResult(c.actionFor(id), id, deviceA))
    assertNull(c.matchResult(c.actionFor(id), id, deviceA))
    assertEquals(0, c.pendingCount())
  }

  @Test
  fun `timeout settles once and a late grant afterwards cannot match`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNotNull(c.settle(id, UsbPermissionRequestCoordinator.SettleReason.TIMEOUT))
    assertEquals(UsbPermissionRequestCoordinator.SettleReason.TIMEOUT, c.lastSettleReason)
    // The real device answer arrives afterwards: must NOT open USB.
    assertNull(c.matchResult(c.actionFor(id), id, deviceA))
    assertNull(c.settle(id, UsbPermissionRequestCoordinator.SettleReason.TIMEOUT))
  }

  @Test
  fun `request failure settles once`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNotNull(c.settle(id, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE))
    assertNull(c.matchResult(c.actionFor(id), id, deviceA))
  }

  @Test
  fun `cancelAll drains every pending request, blocks new ones and blocks late grants`() {
    val c = coordinator()
    val idA = c.register(deviceA) { _, _ -> }!!
    c.register(deviceB) { _, _ -> }!!
    val drained = c.cancelAll()

    assertEquals(2, drained.size)
    assertEquals(0, c.pendingCount())
    assertTrue(c.isCancelled())
    assertNull(c.register(deviceA) { _, _ -> })
    assertNull(c.matchResult(c.actionFor(idA), idA, deviceA))
  }

  @Test
  fun `invalidation while waiting settles the pending request exactly once`() {
    val c = coordinator()
    val id = c.register(deviceA) { _, _ -> }!!
    assertNotNull(c.settle(id, UsbPermissionRequestCoordinator.SettleReason.INVALIDATED))
    assertEquals(0, c.pendingCount())
    assertNull(c.settle(id, UsbPermissionRequestCoordinator.SettleReason.INVALIDATED))
  }

  @Test
  fun `no pending state remains after teardown`() {
    val c = coordinator()
    c.register(deviceA) { _, _ -> }
    c.register(deviceB) { _, _ -> }
    c.cancelAll()
    assertEquals(0, c.pendingCount())
    assertFalse(c.register(deviceA) { _, _ -> } != null)
  }
}
