package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers UsbSerialReadRegistry's token/ownership semantics directly on the
 * JVM - deliberately generic over a plain sessionId String, never a real
 * UsbSerialSession or Android type. Proves the "at most one active receive
 * loop per session, and an old attempt can never disturb a newer one"
 * contract that UsbSerialTransportModule's startReading()/stopReading()/
 * close/detach/invalidate paths all rely on.
 */
class UsbSerialReadRegistryTest {

  @Test
  fun `starting an unclaimed session returns a token`() {
    val registry = UsbSerialReadRegistry()

    assertNotEquals(null, registry.start("session-1"))
  }

  @Test
  fun `starting an already-active session fails`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    assertNull(registry.start("session-1"))
  }

  @Test
  fun `different sessions can be started independently`() {
    val registry = UsbSerialReadRegistry()

    val tokenA = registry.start("session-1")
    val tokenB = registry.start("session-2")

    assertNotEquals(null, tokenA)
    assertNotEquals(null, tokenB)
    assertNotEquals(tokenA, tokenB)
  }

  @Test
  fun `two successive starts for the same session receive distinct tokens`() {
    val registry = UsbSerialReadRegistry()
    val tokenA = registry.start("session-1")!!
    registry.removeSession("session-1")

    val tokenB = registry.start("session-1")!!

    assertNotEquals(tokenA, tokenB)
  }

  @Test
  fun `the current token for a session is current`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("session-1")!!

    assertTrue(registry.isCurrent("session-1", token))
  }

  @Test
  fun `a token is not current for a session that was never started`() {
    val registry = UsbSerialReadRegistry()

    assertFalse(registry.isCurrent("session-1", ReceiveToken(0)))
  }

  @Test
  fun `removeSession clears the active token so the session can be started again`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("session-1")!!

    registry.removeSession("session-1")

    assertFalse(registry.isCurrent("session-1", token))
    assertNotEquals(null, registry.start("session-1"))
  }

  @Test
  fun `removeSession on a session with no active receive loop is a harmless no-op`() {
    val registry = UsbSerialReadRegistry()

    assertNull(registry.removeSession("session-1"))
    assertNotEquals(null, registry.start("session-1"))
  }

  @Test
  fun `calling removeSession twice in a row is safe`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    registry.removeSession("session-1")
    registry.removeSession("session-1")

    assertNotEquals(null, registry.start("session-1"))
  }

  @Test
  fun `removeSession for one session does not affect another session's active token`() {
    val registry = UsbSerialReadRegistry()
    val tokenA = registry.start("session-1")!!
    registry.start("session-2")

    registry.removeSession("session-2")

    assertTrue(registry.isCurrent("session-1", tokenA))
    assertNull(registry.start("session-1"))
  }

  @Test
  fun `a stale token is not current once a newer attempt has started for the same session`() {
    val registry = UsbSerialReadRegistry()
    val staleToken = registry.start("session-1")!!
    registry.removeSession("session-1")
    val currentToken = registry.start("session-1")!!

    assertFalse(registry.isCurrent("session-1", staleToken))
    assertTrue(registry.isCurrent("session-1", currentToken))
  }

  @Test
  fun `removeAll invalidates every outstanding token and returns the sessions that were active`() {
    val registry = UsbSerialReadRegistry()
    val tokenA = registry.start("session-1")!!
    val tokenB = registry.start("session-2")!!

    val drained = registry.removeAll()

    assertEquals(setOf("session-1", "session-2"), drained.toSet())
    assertFalse(registry.isCurrent("session-1", tokenA))
    assertFalse(registry.isCurrent("session-2", tokenB))
    assertNotEquals(null, registry.start("session-1"))
    assertNotEquals(null, registry.start("session-2"))
  }

  @Test
  fun `removeAll on an empty registry returns an empty list`() {
    val registry = UsbSerialReadRegistry()

    assertEquals(0, registry.removeAll().size)
  }

  @Test
  fun `calling removeAll twice in a row is safe`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    val first = registry.removeAll()
    val second = registry.removeAll()

    assertEquals(1, first.size)
    assertEquals(0, second.size)
  }

  // "Old worker exit cannot remove newer state": since a receive worker
  // never mutates this registry itself (see the class-level note), this is
  // true by construction - there is no removal call path driven by a
  // worker's own completion at all. This test instead proves the
  // *precondition* that guarantees it: start() can never succeed while an
  // older token for the same session is still registered, so a "newer"
  // token can only ever exist once the older one is already gone.
  @Test
  fun `a new start can only succeed after the previous active token for that session is gone`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    assertNull(registry.start("session-1"))

    registry.removeSession("session-1")

    assertNotEquals(null, registry.start("session-1"))
  }
}
