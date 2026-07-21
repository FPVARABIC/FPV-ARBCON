package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers UsbSerialReadRegistry's token/ownership/retirement semantics
 * directly on the JVM - deliberately generic over a plain sessionId String,
 * never a real UsbSerialSession or Android type. Proves the "at most one
 * active receive loop per session, an old attempt can never disturb a newer
 * one, and a rapid stop-then-restart cannot create two workers that could
 * both call read() at once" contract (PASS5.2-AUDIT-F1) that
 * UsbSerialTransportModule's startReading()/stopReading()/close/detach/
 * invalidate paths all rely on.
 */
class UsbSerialReadRegistryTest {

  @Test
  fun `starting an unclaimed session succeeds with a fresh token and handle`() {
    val registry = UsbSerialReadRegistry()

    val attempt = registry.start("session-1")

    assertTrue(attempt is UsbSerialReadRegistry.StartAttempt.Started)
  }

  @Test
  fun `starting an already-active session reports AlreadyActive, not Retiring`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    assertEquals(UsbSerialReadRegistry.StartAttempt.AlreadyActive, registry.start("session-1"))
  }

  @Test
  fun `different sessions can be started independently with distinct tokens`() {
    val registry = UsbSerialReadRegistry()

    val attemptA = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    val attemptB = registry.start("session-2") as UsbSerialReadRegistry.StartAttempt.Started

    assertNotEquals(attemptA.token, attemptB.token)
  }

  @Test
  fun `the current token for a session is current`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started

    assertTrue(registry.isCurrent("session-1", attempt.token))
  }

  @Test
  fun `a token is not current for a session that was never started`() {
    val registry = UsbSerialReadRegistry()

    assertFalse(registry.isCurrent("session-1", ReceiveToken(0)))
  }

  @Test
  fun `retire makes the token stop being current immediately`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started

    assertTrue(registry.retire("session-1"))

    assertFalse(registry.isCurrent("session-1", attempt.token))
  }

  @Test
  fun `retiring an unknown session is a harmless no-op`() {
    val registry = UsbSerialReadRegistry()

    assertFalse(registry.retire("session-1"))
  }

  @Test
  fun `retiring the same session twice in a row is idempotent`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    assertTrue(registry.retire("session-1"))
    assertFalse(registry.retire("session-1"))
  }

  @Test
  fun `a session that has been retired but not yet confirmed reports Retiring, not AlreadyActive or Started`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    registry.retire("session-1")

    val restart = registry.start("session-1")

    assertTrue(restart is UsbSerialReadRegistry.StartAttempt.Retiring)
    assertSame(attempt.handle, (restart as UsbSerialReadRegistry.StartAttempt.Retiring).handle)
  }

  @Test
  fun `confirmRetired frees the session for a fresh Started attempt`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    registry.retire("session-1")

    registry.confirmRetired("session-1", attempt.handle)

    val restart = registry.start("session-1")
    assertTrue(restart is UsbSerialReadRegistry.StartAttempt.Started)
    assertNotEquals(attempt.token, (restart as UsbSerialReadRegistry.StartAttempt.Started).token)
  }

  // PASS5.7-AUDIT: proves the registry-cleanup half of the fix for a
  // confirmed gap - if startReceiveWorker() throws before the real worker
  // thread's own body (and therefore its own finally block) ever runs,
  // nothing else would ever call confirmRetired() for that Started attempt.
  // attemptStartReading()'s own catch block now calls confirmRetired()
  // directly, itself, in exactly this situation - a still-active entry that
  // was never explicitly retire()'d first (unlike every other
  // confirmRetired() test above, which all go through a normal retire() ->
  // confirmRetired() worker-exit sequence). This test proves that direct
  // call correctly releases the entry regardless, so a session is never
  // left permanently reporting AlreadyActive/Retiring after a failed start.
  @Test
  fun `confirmRetired releases a Started entry whose worker never actually ran, freeing the session for a fresh start`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started

    // Deliberately no registry.retire("session-1") call here - the entry is
    // still active=true, exactly as it would be if startReceiveWorker()
    // threw immediately after readRegistry.start() succeeded.
    registry.confirmRetired("session-1", attempt.handle)

    assertTrue(
      "a fresh startReading() attempt for the same session must succeed, not report AlreadyActive/Retiring forever",
      registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started,
    )
  }

  @Test
  fun `confirmRetired unblocks the handle even if it never removed anything`() {
    val registry = UsbSerialReadRegistry()
    val staleHandle = ReadWorkerHandle()

    // No entry exists for "session-1" at all - simulates a defensive call
    // this registry's own design says can never actually happen (see
    // confirmRetired's class-level note), but markDone() must still run.
    registry.confirmRetired("session-1", staleHandle)

    assertTrue(staleHandle.awaitDone(0))
  }

  @Test
  fun `confirmRetired with a handle that no longer matches the registered entry does not remove it`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")
    val foreignHandle = ReadWorkerHandle()

    // Ownership-gating defense-in-depth: a handle that is not the one
    // currently registered for this sessionId must never clear real state,
    // even though [start]'s own guarantee means this can't happen in
    // practice (a newer entry can only exist once the older one already
    // removed itself).
    registry.confirmRetired("session-1", foreignHandle)

    assertEquals(UsbSerialReadRegistry.StartAttempt.AlreadyActive, registry.start("session-1"))
    assertTrue("the foreign handle passed in must still be released", foreignHandle.awaitDone(0))
  }

  @Test
  fun `removeSession clears the active token so the session can be started again`() {
    val registry = UsbSerialReadRegistry()
    val attempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started

    registry.removeSession("session-1")

    assertFalse(registry.isCurrent("session-1", attempt.token))
    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
  }

  @Test
  fun `removeSession unconditionally clears a session that is only retiring, not yet confirmed`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")
    registry.retire("session-1")

    // Used by closeSession()/detach - the session (and its port) is going
    // away entirely, so there is no future startReading() for this exact
    // sessionId that would ever need to wait on the removed handle.
    val removed = registry.removeSession("session-1")

    assertNotEquals(null, removed)
    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
  }

  @Test
  fun `removeSession on a session with no active receive loop is a harmless no-op`() {
    val registry = UsbSerialReadRegistry()

    assertNull(registry.removeSession("session-1"))
    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
  }

  @Test
  fun `calling removeSession twice in a row is safe`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    registry.removeSession("session-1")
    registry.removeSession("session-1")

    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
  }

  @Test
  fun `removeSession for one session does not affect another session's active token`() {
    val registry = UsbSerialReadRegistry()
    val attemptA = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    registry.start("session-2")

    registry.removeSession("session-2")

    assertTrue(registry.isCurrent("session-1", attemptA.token))
    assertEquals(UsbSerialReadRegistry.StartAttempt.AlreadyActive, registry.start("session-1"))
  }

  @Test
  fun `retire for one session does not affect another session's active token`() {
    val registry = UsbSerialReadRegistry()
    val attemptA = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    registry.start("session-2")

    registry.retire("session-2")

    assertTrue(registry.isCurrent("session-1", attemptA.token))
  }

  @Test
  fun `a stale token is not current once a newer attempt has started for the same session`() {
    val registry = UsbSerialReadRegistry()
    val staleAttempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    registry.retire("session-1")
    registry.confirmRetired("session-1", staleAttempt.handle)
    val currentAttempt = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started

    assertFalse(registry.isCurrent("session-1", staleAttempt.token))
    assertTrue(registry.isCurrent("session-1", currentAttempt.token))
  }

  @Test
  fun `removeAll invalidates every outstanding token and returns the sessions that were active`() {
    val registry = UsbSerialReadRegistry()
    val attemptA = registry.start("session-1") as UsbSerialReadRegistry.StartAttempt.Started
    val attemptB = registry.start("session-2") as UsbSerialReadRegistry.StartAttempt.Started

    val drained = registry.removeAll()

    assertEquals(setOf("session-1", "session-2"), drained.toSet())
    assertFalse(registry.isCurrent("session-1", attemptA.token))
    assertFalse(registry.isCurrent("session-2", attemptB.token))
    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
    assertTrue(registry.start("session-2") is UsbSerialReadRegistry.StartAttempt.Started)
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

  // "Old worker exit cannot remove newer state": since [confirmRetired] is
  // ownership-gated by handle identity (see the dedicated test above), and
  // [start] can never hand out a fresh Started attempt while an older entry
  // for the same sessionId still exists, a "newer" entry can only ever exist
  // once the older one has already removed itself. This test proves that
  // precondition directly.
  @Test
  fun `a new start can only succeed after the previous entry for that session is gone`() {
    val registry = UsbSerialReadRegistry()
    registry.start("session-1")

    assertEquals(UsbSerialReadRegistry.StartAttempt.AlreadyActive, registry.start("session-1"))

    registry.removeSession("session-1")

    assertTrue(registry.start("session-1") is UsbSerialReadRegistry.StartAttempt.Started)
  }
}
