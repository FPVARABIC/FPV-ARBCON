package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Real permission wait + coordinator; Android broadcast delivery is not simulated here. */
class UsbPermissionWaitTest {
  private val coordinator = UsbPermissionRequestCoordinator("test.permission")
  private val device = UsbDeviceIdentity(1, 0x0483, 0x5740)
  private val receivers = mutableSetOf<Long>()
  private val abandoned = mutableListOf<Pair<Long, UsbPermissionRequestCoordinator.SettleReason>>()
  private var callbacks = 0
  private var lastRequestId: Long? = null

  private fun register(onResult: (Boolean, String?) -> Unit): Long {
    val id = coordinator.register(device) { granted, message ->
      callbacks++
      onResult(granted, message)
    }!!
    receivers.add(id)
    lastRequestId = id
    return id
  }

  private fun abandon(id: Long, reason: UsbPermissionRequestCoordinator.SettleReason) {
    abandoned.add(id to reason)
    val request = coordinator.settle(id, reason)
    receivers.remove(id)
    request?.onResult(false, "Permission request cancelled.")
  }

  private fun deliver(id: Long, granted: Boolean, message: String? = null) {
    val request = coordinator.matchResult(coordinator.actionFor(id), id, device) ?: return
    receivers.remove(id)
    request.onResult(granted, message)
  }

  @Test
  fun `cached permission completes synchronously without a request to abandon`() {
    val result = awaitUsbPermissionResult(
      0,
      requestPermission = { callback -> callback(true, null); null },
      abandonRequest = ::abandon,
    )
    assertTrue(result.granted)
    assertNull(result.failureMessage)
    assertTrue(abandoned.isEmpty())
  }

  @Test
  fun `denial and infrastructure failure preserve the delivered outcome`() {
    for (message in listOf(null, "Failed to register the receiver.")) {
      val result = awaitUsbPermissionResult(
        0,
        requestPermission = { callback ->
          val id = register(callback)
          deliver(id, false, message)
          id
        },
        abandonRequest = ::abandon,
      )
      assertFalse(result.granted)
      assertEquals(message, result.failureMessage)
      assertEquals(0, coordinator.pendingCount())
    }
    assertTrue(abandoned.isEmpty())
  }

  @Test
  fun `asynchronous grant wakes the worker and retains the normal success path`() {
    val registered = CountDownLatch(1)
    val result = AtomicReference<PermissionOutcome>()
    val worker = Thread {
      result.set(awaitUsbPermissionResult(
        5_000,
        requestPermission = { callback -> register(callback).also { registered.countDown() } },
        abandonRequest = ::abandon,
      ))
    }
    worker.start()
    try {
      assertTrue(registered.await(2, TimeUnit.SECONDS))
      deliver(lastRequestId!!, true)
      worker.join(2_000)
      assertFalse("worker did not settle after permission was granted", worker.isAlive)
      assertEquals(PermissionOutcome(true, null), result.get())
      assertEquals(1, callbacks)
      assertTrue(abandoned.isEmpty())
    } finally {
      worker.interrupt()
      worker.join(2_000)
    }
  }

  @Test
  fun `expiry removes only its own request and receiver and rejects late grants`() {
    val other = register { _, _ -> }
    val result = awaitUsbPermissionResult(0, ::register, ::abandon)
    val expired = lastRequestId!!

    assertFalse(result.granted)
    assertEquals("Timed out waiting for the USB permission result.", result.failureMessage)
    assertEquals(listOf(expired to UsbPermissionRequestCoordinator.SettleReason.TIMEOUT), abandoned)
    assertEquals(setOf(other), receivers)
    assertEquals(1, coordinator.pendingCount())
    assertEquals(1, callbacks)
    deliver(expired, true)
    assertEquals("a late grant settled an expired request again", 1, callbacks)
    deliver(other, true)
    assertEquals(2, callbacks)
    assertEquals(0, coordinator.pendingCount())
  }

  @Test
  fun `repeated unanswered attempts leave no pending requests or receivers`() {
    repeat(250) {
      val result = awaitUsbPermissionResult(0, ::register, ::abandon)
      assertFalse(result.granted)
      assertEquals(0, coordinator.pendingCount())
      assertTrue(receivers.isEmpty())
    }
    assertEquals(250, callbacks)
    assertEquals(250, abandoned.size)
  }

  @Test
  fun `interruption abandons the request before propagating to the caller`() {
    val registered = CountDownLatch(1)
    val failure = AtomicReference<Throwable>()
    val worker = Thread {
      try {
        awaitUsbPermissionResult(
          60_000,
          requestPermission = { callback -> register(callback).also { registered.countDown() } },
          abandonRequest = ::abandon,
        )
      } catch (error: Throwable) {
        failure.set(error)
      }
    }
    worker.start()
    try {
      assertTrue(registered.await(2, TimeUnit.SECONDS))
      worker.interrupt()
      worker.join(2_000)
      assertFalse(worker.isAlive)
      assertTrue(failure.get() is InterruptedException)
      assertEquals(0, coordinator.pendingCount())
      assertTrue(receivers.isEmpty())
      assertEquals(UsbPermissionRequestCoordinator.SettleReason.CANCELLED, abandoned.single().second)
      deliver(lastRequestId!!, true)
      assertEquals(1, callbacks)
    } finally {
      worker.interrupt()
      worker.join(2_000)
    }
  }

  @Test
  fun `a broadcast racing cleanup cannot turn an expired wait into success`() {
    val result = awaitUsbPermissionResult(
      0,
      ::register,
      abandonRequest = { id, reason ->
        deliver(id, true)
        abandon(id, reason)
      },
    )
    assertFalse(result.granted)
    assertEquals(1, callbacks)
    assertEquals(0, coordinator.pendingCount())
    assertTrue(receivers.isEmpty())
  }

  @Test(expected = IllegalArgumentException::class)
  fun `negative timeout is rejected before starting a request`() {
    awaitUsbPermissionResult(-1, { error("request must not start") }, ::abandon)
  }
}
