package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers only the reservation semantics that back the "one active session
 * per physical device" policy. insert()/remove() with a real UsbSerialSession
 * need a UsbDeviceConnection/UsbSerialPort (real Android types) and are not
 * exercised here - see Pass 4 report, section on genuine unresolved issues.
 */
class UsbSerialSessionRegistryTest {

  @Test
  fun `reserving an unclaimed device succeeds`() {
    val registry = UsbSerialSessionRegistry()

    assertTrue(registry.reserveDevice(1))
  }

  @Test
  fun `reserving an already-reserved device fails`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    assertFalse(registry.reserveDevice(1))
  }

  @Test
  fun `different devices can be reserved independently`() {
    val registry = UsbSerialSessionRegistry()

    assertTrue(registry.reserveDevice(1))
    assertTrue(registry.reserveDevice(2))
  }

  @Test
  fun `releasing a reservation allows it to be claimed again`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    registry.releaseReservation(1)

    assertTrue(registry.reserveDevice(1))
  }

  @Test
  fun `releasing a reservation that was never held is a harmless no-op`() {
    val registry = UsbSerialSessionRegistry()

    registry.releaseReservation(42)

    assertTrue(registry.reserveDevice(42))
  }

  // removeAll() (the module/host invalidation drain). Only reservations are
  // exercised here - draining an active *session* needs a real
  // UsbSerialSession (UsbDeviceConnection/UsbSerialPort, real Android types)
  // and is not exercised without Gradle/device support (see Pass 4 report).

  @Test
  fun `removeAll clears pending reservations so the device can be reserved again`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)
    registry.reserveDevice(2)

    val drained = registry.removeAll()

    assertEquals(0, drained.size)
    assertTrue(registry.reserveDevice(1))
    assertTrue(registry.reserveDevice(2))
  }

  @Test
  fun `removeAll on an empty registry returns an empty list and leaves it reservable`() {
    val registry = UsbSerialSessionRegistry()

    val drained = registry.removeAll()

    assertEquals(0, drained.size)
    assertTrue(registry.reserveDevice(1))
  }

  @Test
  fun `calling removeAll twice in a row is safe - the second call finds nothing left to drain`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    val first = registry.removeAll()
    val second = registry.removeAll()

    assertEquals(0, first.size)
    assertEquals(0, second.size)
    assertTrue(registry.reserveDevice(1))
  }

  // removeByDeviceId() (the hot-plug detach invalidation path, Pass 4.7).
  // Only the no-session cases are exercised here for the same reason
  // insert()/remove() above are not: a real UsbSerialSession needs a
  // UsbDeviceConnection/UsbSerialPort (real Android types) unavailable
  // without Gradle/device support.

  @Test
  fun `removeByDeviceId on an empty registry returns null and is a harmless no-op`() {
    val registry = UsbSerialSessionRegistry()

    assertNull(registry.removeByDeviceId(1))
  }

  @Test
  fun `removeByDeviceId does not disturb an unrelated device's reservation`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    assertNull(registry.removeByDeviceId(2))
    assertFalse(registry.reserveDevice(1))
  }

  // Pass 5.1: releasing a pending reservation on detach (the
  // "device detached while its own connect attempt is still waiting on the
  // permission dialog" window). handleDeviceDetached() now calls
  // releaseReservation(deviceId) unconditionally alongside removeByDeviceId()
  // - these tests cover releaseReservation()'s own semantics for that usage
  // directly; the BroadcastReceiver-driven call site itself cannot be
  // exercised without Android framework infrastructure (see
  // UsbHotplugMonitor's own class-level note).

  @Test
  fun `a pending reservation released as detach handling would can be reserved again immediately`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    registry.releaseReservation(1)

    assertTrue(registry.reserveDevice(1))
  }

  @Test
  fun `releasing one device's pending reservation does not affect another device's reservation`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)
    registry.reserveDevice(2)

    registry.releaseReservation(1)

    assertTrue(registry.reserveDevice(1))
    assertFalse(registry.reserveDevice(2))
  }

  @Test
  fun `repeated release for the same device remains harmless and does not throw`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    registry.releaseReservation(1)
    registry.releaseReservation(1)
    registry.releaseReservation(1)

    assertTrue(registry.reserveDevice(1))
  }

  @Test
  fun `releasing a reservation that was never held does not corrupt an existing reservation for another device`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(2)

    registry.releaseReservation(1)

    assertFalse(registry.reserveDevice(2))
  }
}
