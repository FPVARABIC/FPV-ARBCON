package com.fpvarbcon.transport

/**
 * The minimal surface [closeSessionRejectingPendingWrites] needs from a
 * session - just enough to stop its write queue and drain whatever is
 * still queued (never one already in progress - see
 * [UsbSerialWriteQueue.stopAndDrainPending]'s own note). [UsbSerialSession]
 * implements this trivially, since it already exposes exactly this method
 * for its own defensive close()-path use.
 *
 * This interface exists purely so the ordering contract below is directly
 * unit-testable against a fake, without needing a real [UsbSerialSession] -
 * which requires a real UsbDeviceConnection/UsbSerialPort and cannot be
 * meaningfully constructed on the JVM without Robolectric or Mockito
 * (neither of which this project uses - see
 * UsbSerialSessionIoLockTest.kt's own class-level note for the identical
 * constraint applied to ioLock's tests).
 */
internal interface WriteQueueOwner {
  fun stopAndDrainPendingWrites(): List<UsbSerialWriteRequest>
}

/**
 * The write-queue-then-close sequencing contract every session-ending
 * lifecycle path in UsbSerialTransportModule now shares identically
 * (PASS5.3-STEP1-CORRECTION4): closeSession(), handleDeviceDetached(), and
 * invalidate() all call this exact function rather than duplicating this
 * ordering inline three times - one of which, handleDeviceDetached(),
 * previously got the order backwards (submitting the session's close to
 * ioExecutor before stopping its write queue, unlike the other two).
 *
 * Always stops [session]'s write queue and hands whatever it returns to
 * [rejectPendingWrites] BEFORE [performClose] runs - never after, never
 * interleaved - so a queued (not yet started) write can never be rejected
 * only after its session's close has already been invoked or submitted.
 *
 * A write already genuinely in progress when this runs is untouched by
 * this function entirely: it is never part of what
 * [WriteQueueOwner.stopAndDrainPendingWrites] returns (see that method's
 * own contract, proven in UsbSerialWriteQueueTest.kt), so it can never be
 * "double-handled" here - it resolves independently, later, through its
 * own onComplete, exactly once, regardless of when [performClose] runs
 * relative to it. See UsbSerialSessionLifecycleTest.kt, which proves both
 * properties directly against this function - and therefore against all
 * three real call sites, since they all delegate to it identically.
 */
internal fun closeSessionRejectingPendingWrites(
  session: WriteQueueOwner,
  rejectPendingWrites: (List<UsbSerialWriteRequest>) -> Unit,
  performClose: () -> Unit,
) {
  rejectPendingWrites(session.stopAndDrainPendingWrites())
  performClose()
}
