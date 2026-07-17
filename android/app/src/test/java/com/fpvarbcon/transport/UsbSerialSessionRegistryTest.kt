package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers the reservation/token semantics that back the "one active session
 * per physical device" policy. insert()/remove()/removeByDeviceId() with a
 * real UsbSerialSession need a UsbDeviceConnection/UsbSerialPort (real
 * Android framework types with no application-constructible instance - see
 * Pass 4 report, section on genuine unresolved issues) and are not
 * exercised here beyond their no-session/empty-registry cases.
 *
 * Pass 5.1 corrective note (PASS5.1-AUDIT-1): reservations are now owned by
 * a [ReservationToken], not a bare deviceId - reserveDevice() returns the
 * token, and releaseReservation()/insert() only act when the exact token
 * they were given still owns the reservation. The tests below directly
 * prove the "Attempt A / Attempt B" scenario from the corrective report for
 * every reservation-only operation (release, re-reserve, repeated release).
 * insert()'s own stale-vs-matching-token behavior shares the identical
 * token-comparison logic already proven by releaseReservation()'s tests
 * below, but the method itself still requires a real UsbSerialSession to
 * call end-to-end, and remains untestable in this plain-JUnit sandbox for
 * the same reason insert() always has been (see the class-level note
 * above and the Pass 5.1 corrective report's honest "remaining risks"
 * section) - it is not silently skipped, it is a known, unchanged,
 * pre-existing gap in what this sandbox can exercise.
 */
class UsbSerialSessionRegistryTest {

  @Test
  fun `reserving an unclaimed device returns a token`() {
    val registry = UsbSerialSessionRegistry()

    assertNotEquals(null, registry.reserveDevice(1))
  }

  @Test
  fun `reserving an already-reserved device fails`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    assertNull(registry.reserveDevice(1))
  }

  @Test
  fun `separate reservations for different devices receive distinct tokens`() {
    val registry = UsbSerialSessionRegistry()

    val tokenForDevice1 = registry.reserveDevice(1)
    val tokenForDevice2 = registry.reserveDevice(2)

    assertNotEquals(null, tokenForDevice1)
    assertNotEquals(null, tokenForDevice2)
    assertNotEquals(tokenForDevice1, tokenForDevice2)
  }

  @Test
  fun `two successive reservations for the same deviceId receive distinct tokens`() {
    val registry = UsbSerialSessionRegistry()
    val tokenA = registry.reserveDevice(1)!!
    registry.releaseReservation(1, tokenA)

    val tokenB = registry.reserveDevice(1)!!

    assertNotEquals(tokenA, tokenB)
  }

  @Test
  fun `releasing a reservation with its own token allows it to be claimed again`() {
    val registry = UsbSerialSessionRegistry()
    val token = registry.reserveDevice(1)!!

    assertTrue(registry.releaseReservation(1, token))
    assertNotEquals(null, registry.reserveDevice(1))
  }

  @Test
  fun `releasing a reservation that was never held is a harmless no-op`() {
    val registry = UsbSerialSessionRegistry()

    assertFalse(registry.releaseReservation(42, ReservationToken(0)))
    assertNotEquals(null, registry.reserveDevice(42))
  }

  @Test
  fun `a stale token cannot release a newer reservation for the same deviceId`() {
    val registry = UsbSerialSessionRegistry()
    val staleToken = registry.reserveDevice(1)!!
    registry.invalidateReservationForDevice(1)
    val currentToken = registry.reserveDevice(1)!!

    val releasedByStaleToken = registry.releaseReservation(1, staleToken)

    assertFalse(releasedByStaleToken)
    // The current (Attempt B-equivalent) reservation must still be exactly
    // what it was - still held, and releasable only by its own token.
    assertNull(registry.reserveDevice(1))
    assertTrue(registry.releaseReservation(1, currentToken))
  }

  // removeAll() (the module/host invalidation drain). Only reservations are
  // exercised here - draining an active *session* needs a real
  // UsbSerialSession (UsbDeviceConnection/UsbSerialPort, real Android types)
  // and is not exercised without Gradle/device support (see Pass 4 report).

  @Test
  fun `removeAll invalidates every outstanding token so every device can be reserved again`() {
    val registry = UsbSerialSessionRegistry()
    val token1 = registry.reserveDevice(1)!!
    val token2 = registry.reserveDevice(2)!!

    val drained = registry.removeAll()

    assertEquals(0, drained.size)
    assertNotEquals(null, registry.reserveDevice(1))
    assertNotEquals(null, registry.reserveDevice(2))
    // The tokens removeAll() invalidated must no longer be able to release
    // the brand-new reservations it made room for.
    assertFalse(registry.releaseReservation(1, token1))
    assertFalse(registry.releaseReservation(2, token2))
  }

  @Test
  fun `removeAll on an empty registry returns an empty list and leaves it reservable`() {
    val registry = UsbSerialSessionRegistry()

    val drained = registry.removeAll()

    assertEquals(0, drained.size)
    assertNotEquals(null, registry.reserveDevice(1))
  }

  @Test
  fun `calling removeAll twice in a row is safe - the second call finds nothing left to drain`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    val first = registry.removeAll()
    val second = registry.removeAll()

    assertEquals(0, first.size)
    assertEquals(0, second.size)
    assertNotEquals(null, registry.reserveDevice(1))
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
    assertNull(registry.reserveDevice(1))
  }

  // Pass 5.1: invalidateReservationForDevice() (the detach path) and its
  // interaction with token-owned reservations. handleDeviceDetached() calls
  // invalidateReservationForDevice(deviceId) unconditionally (it does not
  // hold - and must not need - the detached attempt's own token), then
  // removeByDeviceId(). These tests cover that method's own semantics
  // directly; the BroadcastReceiver-driven call site itself cannot be
  // exercised without Android framework infrastructure (see
  // UsbHotplugMonitor's own class-level note).

  @Test
  fun `invalidateReservationForDevice clears a pending reservation so it can be reserved again immediately`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    registry.invalidateReservationForDevice(1)

    assertNotEquals(null, registry.reserveDevice(1))
  }

  @Test
  fun `invalidateReservationForDevice for one device does not affect another device's reservation`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)
    registry.reserveDevice(2)

    registry.invalidateReservationForDevice(1)

    assertNotEquals(null, registry.reserveDevice(1))
    assertNull(registry.reserveDevice(2))
  }

  @Test
  fun `repeated invalidateReservationForDevice calls remain harmless and do not throw`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(1)

    registry.invalidateReservationForDevice(1)
    registry.invalidateReservationForDevice(1)
    registry.invalidateReservationForDevice(1)

    assertNotEquals(null, registry.reserveDevice(1))
  }

  @Test
  fun `invalidateReservationForDevice on a device that was never reserved does not corrupt another device's reservation`() {
    val registry = UsbSerialSessionRegistry()
    registry.reserveDevice(2)

    registry.invalidateReservationForDevice(1)

    assertNull(registry.reserveDevice(2))
  }

  // Pass 5.1 corrective report, "Attempt A / Attempt B" scenario
  // (PASS5.1-AUDIT-1's fix, reservation half): Attempt A reserves a
  // deviceId; the device detaches while A is still waiting on permission
  // (invalidateReservationForDevice); the device reconnects and Attempt B
  // reserves the same deviceId; A's delayed permission callback finally
  // runs and calls releaseReservation using A's own (now stale) token. B's
  // reservation must survive untouched.

  @Test
  fun `Attempt A detach then Attempt B reserve then Attempt A's delayed release leaves Attempt B intact`() {
    val registry = UsbSerialSessionRegistry()
    val tokenA = registry.reserveDevice(1)!!

    // Device detaches while A's permission dialog is still pending.
    registry.invalidateReservationForDevice(1)

    // Device reconnects with the same deviceId; Attempt B reserves it.
    val tokenB = registry.reserveDevice(1)!!

    // Attempt A's delayed/stale permission callback finally runs and tries
    // to release using its own (now-stale) token.
    val releasedByA = registry.releaseReservation(1, tokenA)

    assertFalse(releasedByA)
    // Attempt B's reservation must still be exactly what it was - only
    // releasable by its own token, and a third attempt still cannot
    // reserve this deviceId while B holds it.
    assertNull(registry.reserveDevice(1))
    assertTrue(registry.releaseReservation(1, tokenB))
  }
}
