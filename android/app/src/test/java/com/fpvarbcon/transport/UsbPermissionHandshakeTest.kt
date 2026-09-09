package com.fpvarbcon.transport

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * EXACTLY ONE CALLBACK PER PERMISSION REQUEST, ON EVERY PATH.
 *
 * UsbPermissionRequester states that contract in its own body - "EVERY
 * EXIT FROM HERE CALLS BACK" - and the caller depends on it:
 * UsbSerialTransportModule.awaitPermissionResult parks a worker on a latch
 * that only a callback releases. A request that settles twice opens USB
 * after the caller gave up; a request that never settles burns the whole
 * connect budget and then reports "Permission result never arrived",
 * which is a timeout standing in for an error that was already known.
 *
 * The class itself cannot be instantiated off-device - Context,
 * UsbManager, PendingIntent and UsbDevice are framework types, and
 * UsbDevice has no constructor an emulator test could call either - so
 * what is tested here is everything in that class that is a decision
 * rather than a framework call:
 *
 *   - withPermissionHandshake, the production seam that decides what
 *     happens when a step of the handover to Android throws, and
 *   - UsbPermissionRequestCoordinator driven through the same sequences
 *     the receiver drives it through, so the settle-once claim is checked
 *     against the real implementation and not a description of it.
 *
 * WHAT THIS DOES NOT PROVE: that Android delivers the broadcast, that the
 * PendingIntent flags are right, or anything at all about a real device.
 * The FLAG_MUTABLE/setPackage combination is a real-hardware finding
 * recorded in UsbPermissionRequester and is not re-checked here.
 * NOT VERIFIED ON REAL HARDWARE.
 */
class UsbPermissionHandshakeTest {

  private val device = UsbDeviceIdentity(deviceId = 1001, vendorId = 0x0483, productId = 0xDF11)
  private val otherDevice = UsbDeviceIdentity(deviceId = 2002, vendorId = 0x0483, productId = 0x5740)

  private fun coordinator() = UsbPermissionRequestCoordinator("com.fpvarbcon.transport.USB_PERMISSION")

  /** Counts callbacks and remembers what they said. */
  private class Settlements {
    val count = AtomicInteger(0)
    var granted: Boolean? = null
    var message: String? = null

    val callback: (Boolean, String?) -> Unit = { grantedResult, failureMessage ->
      count.incrementAndGet()
      granted = grantedResult
      message = failureMessage
    }
  }

  // ---------------------------------------------------------------------
  // withPermissionHandshake - the seam itself
  // ---------------------------------------------------------------------

  /**
   * A handshake that completes must NOT call back. The request is meant to
   * stay pending at that point; the broadcast is what settles it. A seam
   * that reported success as a failure would settle every request twice.
   */
  @Test
  fun `a handshake that completes settles nothing`() {
    val failures = AtomicInteger(0)
    var ran = false
    withPermissionHandshake(onFailure = { failures.incrementAndGet() }) { ran = true }
    assertTrue("the handshake body never ran", ran)
    assertEquals(0, failures.get())
  }

  /**
   * The regression this seam was introduced for. Before it, only
   * UsbManager.requestPermission was inside a try: a throw from
   * Context.registerReceiver or PendingIntent.getBroadcast left the method
   * with the request still pending and nothing able to settle it.
   *
   * Each step is failed on its own so a repair that covers one of them and
   * not the others cannot pass.
   */
  @Test
  fun `a throw from any step of the handshake settles exactly once`() {
    val steps = listOf(
      "registerReceiver" to IllegalStateException("Too many receivers, total of 1000"),
      "PendingIntent#getBroadcast" to SecurityException("no permission to send this intent"),
      "UsbManager#requestPermission" to IllegalArgumentException("device not attached"),
    )
    for ((step, thrown) in steps) {
      val failures = AtomicInteger(0)
      var seen: Exception? = null
      withPermissionHandshake(
        onFailure = { error ->
          failures.incrementAndGet()
          seen = error
        },
      ) { throw thrown }
      assertEquals("$step: onFailure ran ${failures.get()} times", 1, failures.get())
      assertEquals("$step: a different exception was delivered", thrown, seen)
    }
  }

  /**
   * The failure must carry the real message. Reporting a generic string
   * would leave the operator with a connect failure whose actual cause -
   * "Too many receivers", say - was thrown away, which is the same
   * information loss the timeout used to cause.
   */
  @Test
  fun `the thrown message survives to the callback`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!

    withPermissionHandshake(
      onFailure = { error ->
        coordinator
          .settle(requestId, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE)
          ?.onResult(false, error.message ?: "Failed to request USB permission.")
      },
    ) { throw IllegalStateException("Too many receivers, total of 1000") }

    assertEquals(1, settlements.count.get())
    assertEquals(false, settlements.granted)
    assertEquals("Too many receivers, total of 1000", settlements.message)
    assertEquals("the request is still pending after its failure", 0, coordinator.pendingCount())
  }

  /**
   * An exception with no message must still produce a usable one rather
   * than a null the caller would have to interpret.
   */
  @Test
  fun `a message-less exception still yields a failure string`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!

    withPermissionHandshake(
      onFailure = { error ->
        coordinator
          .settle(requestId, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE)
          ?.onResult(false, error.message ?: "Failed to request USB permission.")
      },
    ) { throw RuntimeException() }

    assertEquals(1, settlements.count.get())
    assertEquals("Failed to request USB permission.", settlements.message)
  }

  // ---------------------------------------------------------------------
  // The four paths named in the audit brief, driven through the real
  // coordinator the way UsbPermissionRequester's receiver drives it.
  // ---------------------------------------------------------------------

  /**
   * Replays what the BroadcastReceiver does: match the action, the request
   * id and the device, and settle only on a match. Returns the number of
   * callbacks this delivery produced.
   */
  private fun deliverBroadcast(
    coordinator: UsbPermissionRequestCoordinator,
    requestId: Long,
    action: String?,
    reportedDevice: UsbDeviceIdentity?,
    permissionGranted: Boolean,
  ): Int {
    val matched = coordinator.matchResult(action, requestId, reportedDevice) ?: return 0
    matched.onResult(permissionGranted && !coordinator.isCancelled(), null)
    return 1
  }

  /** DENIAL: the user pressed Deny. One callback, granted = false. */
  @Test
  fun `a denial settles exactly once and reports not granted`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!

    val delivered = deliverBroadcast(
      coordinator,
      requestId,
      coordinator.actionFor(requestId),
      device,
      permissionGranted = false,
    )

    assertEquals(1, delivered)
    assertEquals(1, settlements.count.get())
    assertEquals(false, settlements.granted)
    assertNull("a denial is not an infrastructure failure and carries no message", settlements.message)
    assertEquals(0, coordinator.pendingCount())
  }

  /**
   * WRONG DEVICE: a broadcast naming a different device settles nothing,
   * and the real request is still waiting afterwards. Two boards plugged
   * in at once is the ordinary way to reach this.
   */
  @Test
  fun `a broadcast for another device settles nothing and leaves the request waiting`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!

    assertEquals(
      0,
      deliverBroadcast(
        coordinator,
        requestId,
        coordinator.actionFor(requestId),
        otherDevice,
        permissionGranted = true,
      ),
    )
    assertEquals(0, settlements.count.get())
    assertEquals("the real request was consumed by a foreign broadcast", 1, coordinator.pendingCount())

    // And the right one still works afterwards.
    deliverBroadcast(coordinator, requestId, coordinator.actionFor(requestId), device, true)
    assertEquals(1, settlements.count.get())
    assertEquals(true, settlements.granted)
  }

  /**
   * A broadcast with no device extra at all - the shape a stale or
   * malformed delivery takes - is likewise not a result.
   */
  @Test
  fun `a broadcast with no device extra settles nothing`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!

    assertEquals(
      0,
      deliverBroadcast(coordinator, requestId, coordinator.actionFor(requestId), null, true),
    )
    assertEquals(0, settlements.count.get())
    assertEquals(1, coordinator.pendingCount())
  }

  /** DUPLICATE RESPONSE: the same broadcast twice must settle once. */
  @Test
  fun `a duplicate broadcast settles exactly once`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!
    val action = coordinator.actionFor(requestId)

    assertEquals(1, deliverBroadcast(coordinator, requestId, action, device, true))
    assertEquals(0, deliverBroadcast(coordinator, requestId, action, device, true))
    assertEquals(0, deliverBroadcast(coordinator, requestId, action, device, false))

    assertEquals(1, settlements.count.get())
    assertEquals(true, settlements.granted)
  }

  /**
   * DESTROYED ACTIVITY: the module is invalidated while the dialog is
   * still on screen. cancelAll drains the request so the caller is
   * released, and a grant arriving afterwards - the user tapping Allow on
   * a dialog belonging to a screen that is gone - must not settle
   * anything a second time and must not read as granted.
   */
  @Test
  fun `invalidation settles once and a late grant afterwards cannot settle again`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!
    val action = coordinator.actionFor(requestId)

    val drained = coordinator.cancelAll()
    assertEquals(1, drained.size)
    drained.forEach { it.onResult(false, "USB permission request was cancelled (module invalidated).") }

    assertEquals(1, settlements.count.get())
    assertEquals(false, settlements.granted)

    assertEquals(0, deliverBroadcast(coordinator, requestId, action, device, permissionGranted = true))
    assertEquals("a late grant settled an invalidated request", 1, settlements.count.get())
    assertEquals(false, settlements.granted)
  }

  /**
   * After invalidation a new request cannot start. UsbPermissionRequester
   * answers that case itself rather than returning silently - the null
   * from register() is what its CANCELLED_MESSAGE path keys off - so the
   * caller still gets exactly one callback.
   */
  @Test
  fun `a request made after invalidation is refused rather than left pending`() {
    val coordinator = coordinator()
    coordinator.cancelAll()

    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)
    assertNull("register must refuse after cancelAll", requestId)

    // What the production code does with that null.
    settlements.callback(false, "USB permission request was cancelled (module invalidated).")
    assertEquals(1, settlements.count.get())
    assertEquals(0, coordinator.pendingCount())
  }

  /**
   * The failure the seam covers, followed by the broadcast that would have
   * arrived anyway. One callback in total, not two: the handshake failure
   * already consumed the request.
   */
  @Test
  fun `a handshake failure followed by a late broadcast still settles only once`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!
    val action = coordinator.actionFor(requestId)

    withPermissionHandshake(
      onFailure = { error ->
        coordinator
          .settle(requestId, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE)
          ?.onResult(false, error.message ?: "Failed to request USB permission.")
      },
    ) { throw IllegalStateException("Too many receivers, total of 1000") }

    assertEquals(1, settlements.count.get())
    assertEquals(0, deliverBroadcast(coordinator, requestId, action, device, permissionGranted = true))
    assertEquals("a late broadcast settled an already-failed request", 1, settlements.count.get())
    assertEquals(false, settlements.granted)
  }

  /**
   * Two devices at once: each request must be settled by its own
   * broadcast, and neither may consume the other's. The per-request action
   * string is what makes that true, so it is asserted directly.
   */
  @Test
  fun `two concurrent requests settle independently, once each`() {
    val coordinator = coordinator()
    val first = Settlements()
    val second = Settlements()
    val firstId = coordinator.register(device, first.callback)!!
    val secondId = coordinator.register(otherDevice, second.callback)!!

    assertTrue(
      "two requests share an action string, so one broadcast could settle either",
      coordinator.actionFor(firstId) != coordinator.actionFor(secondId),
    )

    // The second device's broadcast, delivered against the first request.
    assertEquals(0, deliverBroadcast(coordinator, firstId, coordinator.actionFor(secondId), otherDevice, true))
    assertEquals(0, first.count.get())
    assertEquals(0, second.count.get())

    assertEquals(1, deliverBroadcast(coordinator, firstId, coordinator.actionFor(firstId), device, true))
    assertEquals(1, deliverBroadcast(coordinator, secondId, coordinator.actionFor(secondId), otherDevice, false))

    assertEquals(1, first.count.get())
    assertEquals(true, first.granted)
    assertEquals(1, second.count.get())
    assertEquals(false, second.granted)
    assertEquals(0, coordinator.pendingCount())
  }
}
