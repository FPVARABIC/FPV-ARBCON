package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * REPEATED RECONNECTS, AND WHAT MUST NOT ACCUMULATE ACROSS THEM.
 *
 * An operator on a bench plugs the board in, connects, flashes, unplugs and
 * does it again - dozens of times in a session. Every existing registry
 * test proves one cycle, or two. A residue that only appears on the
 * fortieth - a token that stays current, a reservation that is never
 * released, a device that becomes permanently unreservable - would pass all
 * of them and still strand the operator with "device in use" and no way
 * back except killing the app.
 *
 * These cases run the cycle many times and assert the state AFTER, not just
 * the absence of an exception. The count is deliberately far above any
 * plausible off-by-one: an accumulation bug of one unit per cycle is
 * unmissable at this length.
 *
 * Also here: the zero-length write, which is the degenerate end of the
 * write path. It has to settle, exactly once, one way or the other - a
 * request that never settles leaves a JS Promise pending forever, which is
 * the one outcome no caller can recover from.
 *
 * NOT VERIFIED ON REAL HARDWARE: registries and queues only, no USB device.
 */
class SerialReconnectCycleTest {

  private companion object {
    /** Far more cycles than any off-by-one, few enough to stay instant. */
    const val CYCLES = 200
  }

  // ===================================================================
  // Reserving the same device again and again
  // ===================================================================

  @Test
  fun `two hundred reserve and release cycles leave the device reservable`() {
    val registry = UsbSerialSessionRegistry()
    val tokens = mutableListOf<ReservationToken>()

    repeat(CYCLES) { cycle ->
      val token = registry.reserveDevice(4)
      assertNotNull("cycle $cycle could not reserve a device nothing else holds", token)
      tokens += token!!
      assertTrue("cycle $cycle could not release its own reservation", registry.releaseReservation(4, token))
    }

    assertFalse("something was still held after $CYCLES clean cycles", registry.hasActiveSessionOrReservation())
    assertNotNull("the device became unreservable after $CYCLES cycles", registry.reserveDevice(4))
  }

  @Test
  fun `every reservation token from an earlier cycle is dead in a later one`() {
    val registry = UsbSerialSessionRegistry()
    val tokens = mutableListOf<ReservationToken>()

    repeat(CYCLES) {
      val token = registry.reserveDevice(4)!!
      tokens += token
      registry.releaseReservation(4, token)
    }

    assertEquals("tokens were reused rather than being fresh each cycle", CYCLES, tokens.toSet().size)

    // A live reservation must survive every stale token being replayed at it.
    val live = registry.reserveDevice(4)!!
    for (stale in tokens) {
      assertFalse(
        "a stale token from an earlier cycle released the live reservation",
        registry.releaseReservation(4, stale),
      )
    }
    assertTrue("the live reservation was lost to a stale token", registry.releaseReservation(4, live))
  }

  @Test
  fun `cycles on many devices at once never leak a reservation`() {
    val registry = UsbSerialSessionRegistry()
    val deviceIds = (1..8).toList()

    repeat(CYCLES / 8) {
      val held = deviceIds.associateWith { registry.reserveDevice(it)!! }
      for ((deviceId, token) in held) {
        assertTrue(registry.releaseReservation(deviceId, token))
      }
    }

    assertFalse(registry.hasActiveSessionOrReservation())
    for (deviceId in deviceIds) {
      assertNotNull("device $deviceId became unreservable", registry.reserveDevice(deviceId))
    }
  }

  // ===================================================================
  // Starting and stopping the receive loop again and again
  // ===================================================================

  @Test
  fun `two hundred start, retire and confirm cycles leave the session startable`() {
    val registry = UsbSerialReadRegistry()
    val tokens = mutableListOf<ReceiveToken>()

    repeat(CYCLES) { cycle ->
      val started = registry.start("s1")
      assertTrue(
        "cycle $cycle could not start a session nothing else is reading: $started",
        started is UsbSerialReadRegistry.StartAttempt.Started,
      )
      started as UsbSerialReadRegistry.StartAttempt.Started
      tokens += started.token
      assertTrue("cycle $cycle read a token that should be current", registry.isCurrent("s1", started.token))
      registry.retire("s1")
      assertFalse("a retired token stayed current in cycle $cycle", registry.isCurrent("s1", started.token))
      registry.confirmRetired("s1", started.handle)
    }

    assertEquals("tokens were reused rather than being fresh each cycle", CYCLES, tokens.toSet().size)
    assertTrue(
      "the session could not be started again after $CYCLES cycles",
      registry.start("s1") is UsbSerialReadRegistry.StartAttempt.Started,
    )
  }

  @Test
  fun `no token from any earlier cycle is current once a later one has started`() {
    val registry = UsbSerialReadRegistry()
    val tokens = mutableListOf<ReceiveToken>()

    repeat(CYCLES) {
      val started = registry.start("s1") as UsbSerialReadRegistry.StartAttempt.Started
      tokens += started.token
      registry.retire("s1")
      registry.confirmRetired("s1", started.handle)
    }

    val current = registry.start("s1") as UsbSerialReadRegistry.StartAttempt.Started
    for ((index, stale) in tokens.withIndex()) {
      assertFalse("the token from cycle $index is still current", registry.isCurrent("s1", stale))
    }
    assertTrue("the newest token is not current", registry.isCurrent("s1", current.token))
  }

  @Test
  fun `cycles interleaved across many sessions never leave a token current`() {
    val registry = UsbSerialReadRegistry()
    val sessions = (1..8).map { "s$it" }

    repeat(CYCLES / 8) {
      val started = sessions.associateWith {
        registry.start(it) as UsbSerialReadRegistry.StartAttempt.Started
      }
      for ((sessionId, attempt) in started) {
        registry.retire(sessionId)
        registry.confirmRetired(sessionId, attempt.handle)
        assertFalse(registry.isCurrent(sessionId, attempt.token))
      }
    }

    assertTrue("removeAll found sessions still registered after every cycle confirmed", registry.removeAll().isEmpty())
    for (sessionId in sessions) {
      assertTrue(
        "$sessionId could not be started again",
        registry.start(sessionId) is UsbSerialReadRegistry.StartAttempt.Started,
      )
    }
  }

  // ===================================================================
  // The degenerate write
  // ===================================================================

  @Test
  fun `a zero-length write settles exactly once rather than hanging`() {
    val settled = CountDownLatch(1)
    val outcome = AtomicReference<Result<Int>>()
    var settleCount = 0
    var sinkCalls = 0

    val queue = UsbSerialWriteQueue(
      sessionId = "s1",
      sink = SerialWriteSink { buffer, _ ->
        sinkCalls += 1
        buffer.size
      },
    )
    try {
      val accepted = queue.enqueue(
        UsbSerialWriteRequest(ByteArray(0), 100) { result ->
          settleCount += 1
          outcome.set(result)
          settled.countDown()
        },
      )
      assertEquals(UsbSerialWriteQueue.EnqueueResult.Accepted, accepted)
      assertTrue("a zero-length write never settled - the caller waits forever", settled.await(5, TimeUnit.SECONDS))
      assertTrue("a zero-length write was reported as a partial write", outcome.get().isSuccess)
      assertEquals(0, outcome.get().getOrNull())
      assertEquals("the completion ran more than once", 1, settleCount)
      assertEquals("the sink was not asked to perform the write", 1, sinkCalls)
    } finally {
      queue.stopAndDrainPending()
    }
  }

  @Test
  fun `two hundred writes in a row all settle, once each, in order`() {
    val settled = CountDownLatch(CYCLES)
    val order = mutableListOf<Int>()
    val failures = mutableListOf<Throwable>()

    val queue = UsbSerialWriteQueue(
      sessionId = "s1",
      capacity = CYCLES + 1,
      sink = SerialWriteSink { buffer, _ -> buffer.size },
    )
    try {
      repeat(CYCLES) { index ->
        queue.enqueue(
          UsbSerialWriteRequest(ByteArray(index + 1), 100) { result ->
            synchronized(order) {
              order += index
              result.onFailure { failures += it }
            }
            settled.countDown()
          },
        )
      }
      assertTrue("not every write settled within the bound", settled.await(20, TimeUnit.SECONDS))
      assertEquals("a write settled more than once, or one was lost", CYCLES, order.size)
      assertEquals("writes did not settle in enqueue order", (0 until CYCLES).toList(), order)
      assertTrue("a write failed against a sink that accepts everything: $failures", failures.isEmpty())
    } finally {
      assertTrue("requests were still queued after everything settled", queue.stopAndDrainPending().isEmpty())
    }
  }

  /**
   * The control for the cycle counts above: a registry that DID leak would
   * be caught. Holding a reservation without releasing it must make the
   * next cycle fail, which is exactly what the loops assert against.
   */
  @Test
  fun `an unreleased reservation does block the next cycle - the loops are not vacuous`() {
    val registry = UsbSerialSessionRegistry()
    assertNotNull(registry.reserveDevice(4))
    assertNull("a device already reserved was reserved again", registry.reserveDevice(4))
  }
}
