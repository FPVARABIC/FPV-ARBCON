package com.fpvarbcon.transport

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

  // -------------------------------------------------------------------
  // The remaining fault points from the UI-X3B brief.
  // -------------------------------------------------------------------

  /**
   * DETACH BEFORE THE RESULT. The operator pulls the cable while the
   * system dialog is on screen. Nothing will ever broadcast a result for
   * that request, so the caller has to be released by the detach path or
   * it waits for the whole connect budget and then reports a timeout for
   * something that was already known.
   */
  @Test
  fun `a detach before the result settles the request once, as not granted`() {
    val coordinator = coordinator()
    val settlements = Settlements()
    val requestId = coordinator.register(device, settlements.callback)!!
    val action = coordinator.actionFor(requestId)

    val abandoned = coordinator.settle(requestId, UsbPermissionRequestCoordinator.SettleReason.CANCELLED)
    assertNotNull("the detach path found nothing to settle", abandoned)
    abandoned!!.onResult(false, "USB permission request was cancelled before a result arrived.")

    assertEquals(1, settlements.count.get())
    assertEquals(false, settlements.granted)
    assertEquals(0, coordinator.pendingCount())

    // And the grant that arrives after the cable is already out cannot
    // reopen it.
    assertEquals(0, deliverBroadcast(coordinator, requestId, action, device, permissionGranted = true))
    assertEquals(1, settlements.count.get())
  }

  /**
   * A STALE RESULT FROM A PREVIOUS REQUEST. Attempt 1 is abandoned, the
   * operator retries, and attempt 1's broadcast then arrives. It must not
   * settle attempt 2 - the two are different questions about the same
   * device, and answering the second with the first's answer is exactly
   * the "already granted" confusion the per-request action string exists
   * to prevent.
   */
  @Test
  fun `a stale broadcast from an abandoned request cannot settle its successor`() {
    val coordinator = coordinator()
    val first = Settlements()
    val firstId = coordinator.register(device, first.callback)!!
    val firstAction = coordinator.actionFor(firstId)

    coordinator.settle(firstId, UsbPermissionRequestCoordinator.SettleReason.TIMEOUT)
      ?.onResult(false, "Timed out waiting for the USB permission result.")
    assertEquals(1, first.count.get())

    // The retry, for the very same device.
    val second = Settlements()
    val secondId = coordinator.register(device, second.callback)!!
    assertTrue("a retry reused the abandoned request's id", secondId != firstId)
    assertTrue(
      "a retry reused the abandoned request's action string",
      coordinator.actionFor(secondId) != firstAction,
    )

    // Attempt 1's broadcast, arriving late, aimed at attempt 2's id.
    assertEquals(0, deliverBroadcast(coordinator, secondId, firstAction, device, permissionGranted = true))
    assertEquals("a stale broadcast settled the retry", 0, second.count.get())
    assertEquals(1, coordinator.pendingCount())

    // Attempt 2's own broadcast still works.
    assertEquals(1, deliverBroadcast(coordinator, secondId, coordinator.actionFor(secondId), device, true))
    assertEquals(1, second.count.get())
    assertEquals(true, second.granted)
  }

  /**
   * A DENIAL MUST NOT POISON THE MODULE. Refusing once is an ordinary
   * answer, not a terminal state: the operator can tap Allow next time,
   * and a requester that quietly stopped asking would look like broken
   * hardware.
   */
  @Test
  fun `a denial does not prevent a later legitimate request from succeeding`() {
    val coordinator = coordinator()

    val denied = Settlements()
    val deniedId = coordinator.register(device, denied.callback)!!
    deliverBroadcast(coordinator, deniedId, coordinator.actionFor(deniedId), device, permissionGranted = false)
    assertEquals(1, denied.count.get())
    assertEquals(false, denied.granted)

    assertTrue("a denial cancelled the coordinator", !coordinator.isCancelled())

    val retry = Settlements()
    val retryId = coordinator.register(device, retry.callback)
    assertNotNull("a denial stopped the coordinator accepting a new request", retryId)
    assertEquals(1, deliverBroadcast(coordinator, retryId!!, coordinator.actionFor(retryId), device, true))
    assertEquals(1, retry.count.get())
    assertEquals(true, retry.granted)
  }

  // -------------------------------------------------------------------
  // Receiver cleanup: exactly once, and tolerant of a platform refusal.
  // -------------------------------------------------------------------

  /**
   * The ownership rule, stated as a race. Three callers try to clean up
   * the same receiver; the map hands it to one of them and the platform
   * is asked exactly once.
   */
  @Test
  fun `receiver cleanup runs exactly once however many callers try`() {
    val slot = java.util.concurrent.atomic.AtomicReference<String?>("receiver")
    val unregistered = AtomicInteger(0)
    val owners = AtomicInteger(0)

    repeat(3) {
      val owned = unregisterReceiverOnce(
        take = { slot.getAndSet(null) },
        unregister = { unregistered.incrementAndGet() },
      )
      if (owned) owners.incrementAndGet()
    }

    assertEquals("more than one caller believed it owned the cleanup", 1, owners.get())
    assertEquals("the platform was asked to unregister more than once", 1, unregistered.get())
  }

  /**
   * UNREGISTER FAILURE. Android throws IllegalArgumentException from
   * unregisterReceiver when the receiver is already gone, which is the
   * normal shape of a torn-down Context rather than an error. It must not
   * escape into a caller who is only trying to settle a promise, and the
   * receiver must still count as cleaned up - it was removed from the map
   * before the platform was asked.
   */
  @Test
  fun `a platform refusal to unregister is absorbed and still counts as cleanup`() {
    val slot = java.util.concurrent.atomic.AtomicReference<String?>("receiver")
    val owned = unregisterReceiverOnce(
      take = { slot.getAndSet(null) },
      unregister = { throw IllegalArgumentException("Receiver not registered") },
    )
    assertTrue("a throwing unregister was not treated as cleanup", owned)
    assertNull("the receiver was left in the map after a failed unregister", slot.get())

    // And a second attempt still finds nothing, so the failure did not
    // reopen the ownership question.
    assertTrue(
      !unregisterReceiverOnce(take = { slot.getAndSet(null) }, unregister = { }),
    )
  }

  @Test
  fun `cleanup for a request that was never registered is a no-op, not a failure`() {
    val unregistered = AtomicInteger(0)
    assertTrue(
      !unregisterReceiverOnce<String>(take = { null }, unregister = { unregistered.incrementAndGet() }),
    )
    assertEquals(0, unregistered.get())
  }

  // -------------------------------------------------------------------
  // Two fault points from the brief that turn out to be claims about the
  // SHAPE of this file rather than about a runtime path. They are pinned
  // here so that the day either stops being true, something says so.
  // -------------------------------------------------------------------

  private val requesterSource: String by lazy {
    var directory: java.io.File? =
      java.io.File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (root in listOf(directory, java.io.File(directory, "android/app"))) {
        val candidate = java.io.File(
          root,
          "src/main/java/com/fpvarbcon/transport/UsbPermissionRequester.kt",
        )
        if (candidate.isFile) return@lazy candidate.readText()
      }
      directory = directory.parentFile
    }
    throw AssertionError("could not locate UsbPermissionRequester.kt")
  }

  /**
   * "NO ACTIVITY" IS NOT A FAILURE MODE ON THIS PATH, and that is worth
   * proving rather than asserting in prose.
   *
   * UsbManager.requestPermission takes a PendingIntent, not an Activity,
   * so a USB permission request does not care whether one is in the
   * foreground. The NO_ACTIVITY code this project does emit belongs to the
   * file-operation paths in UsbSerialTransportModule
   * (ACTION_OPEN_DOCUMENT / ACTION_CREATE_DOCUMENT need a real Activity to
   * start), and those already reject with it and already have an Arabic
   * entry.
   *
   * If an Activity dependency is ever introduced here, this fails - and it
   * should, because that would add a failure mode with no handling and no
   * message.
   */
  @Test
  fun `the permission path has no Activity dependency to lose`() {
    val mentions = Regex("""\bActivity\b""").findAll(requesterSource).count()
    assertEquals(
      "UsbPermissionRequester now references an Activity. USB permission is granted through a " +
        "PendingIntent and has never needed one, so this is a new failure mode: it needs its own " +
        "rejection path and its own Arabic message before this assertion is relaxed.",
      0,
      mentions,
    )
  }

  /**
   * Every operator-visible outcome this class produces must be a real
   * sentence, and the two cancellation paths must be indistinguishable -
   * a caller cannot act differently on "refused before the coordinator saw
   * it" versus "drained by cancelAll", and offering two wordings would
   * only invite someone to try.
   *
   * The CODE-to-Arabic half of the brief's requirement is enforced
   * repository-wide by nativeErrorCatalogueContract.test.ts, which reads
   * every UsbTransportException and promise.reject code out of the shipped
   * Kotlin and requires each to resolve to something other than
   * errors.UNKNOWN. This is the half that test cannot see: these strings
   * are failureMessage values, not codes.
   */
  @Test
  fun `every operator-visible message is a real sentence and the cancellations agree`() {
    val messages = Regex("""onResult\(false, "([^"]+)"""")
      .findAll(requesterSource)
      .map { it.groupValues[1] }
      .toList()
    val constant = Regex("""CANCELLED_MESSAGE = "([^"]+)"""")
      .find(requesterSource)?.groupValues?.get(1)

    assertNotNull("CANCELLED_MESSAGE has gone", constant)
    assertTrue("no operator-visible messages found at all", messages.isNotEmpty())
    for (message in messages + listOfNotNull(constant)) {
      assertTrue("an empty operator message: '$message'", message.trim().length > 10)
      assertTrue("a message with no sentence end: '$message'", message.trim().endsWith("."))
    }
    assertTrue(
      "the module-invalidated wording drifted from CANCELLED_MESSAGE, so a caller could tell " +
        "the two cancellation paths apart",
      messages.any { it == constant },
    )
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
