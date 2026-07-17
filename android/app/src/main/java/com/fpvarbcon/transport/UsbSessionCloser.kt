package com.fpvarbcon.transport

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Runs USB session close() work off the calling thread - specifically, off
 * BroadcastReceiver.onReceive / the Android main thread, where a detach
 * event's cleanup would otherwise block real system-broadcast delivery - on
 * one dedicated, owned background thread. A single-thread executor (not a
 * general/multi-threaded pool) is used deliberately: it guarantees close
 * work submitted from consecutive detach events can never run concurrently
 * or interleave against each other's native USB resources, without needing
 * any additional locking here. Only one thread is ever created for this
 * closer's entire lifetime - not a new Thread per detach.
 *
 * [submit] never throws. If this closer has already been shut down (e.g. a
 * detach broadcast racing module invalidation - see
 * UsbSerialTransportModule.invalidate()), the submission is silently
 * absorbed as a no-op: the physical device is gone either way, so there is
 * nothing meaningful left to close, and no live host to report a failure
 * to. [shutdown] is idempotent.
 *
 * Deliberately generic over a plain close action (not coupled to
 * UsbSerialSession) so the scheduling/rejection behavior itself is fully
 * unit-testable on the JVM without any Android runtime - see
 * UsbSessionCloserTest.kt.
 */
internal class UsbSessionCloser {

  private val executor: ExecutorService =
    Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "UsbSessionCloser").apply { isDaemon = true } }

  fun submit(closeAction: () -> Unit) {
    try {
      executor.execute {
        try {
          closeAction()
        } catch (_: Exception) {
          // Best-effort - matches the caller's own existing close() failure
          // handling; there is no live host to report this to either way.
        }
      }
    } catch (_: RejectedExecutionException) {
      // Already shut down - nothing meaningful left to do.
    }
  }

  fun shutdown() {
    executor.shutdown()
  }
}
