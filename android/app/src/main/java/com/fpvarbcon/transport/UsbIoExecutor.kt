package com.fpvarbcon.transport

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Runs blocking USB I/O work off the calling thread - specifically, off
 * BroadcastReceiver.onReceive / the Android main thread, where either an
 * open/configure attempt (after a permission dialog resolves) or a detach
 * event's session cleanup would otherwise block real system-broadcast
 * delivery or the UI - on one dedicated, owned background thread.
 *
 * A single-thread executor (not a general/multi-threaded pool) is used
 * deliberately: it guarantees that USB open work and USB close work,
 * submitted from any combination of consecutive connect/detach events, can
 * never run concurrently or interleave against each other's native USB
 * resources, without needing any additional locking here. The same executor
 * instance is used for both open-shaped and close-shaped work - there is no
 * separate "open executor" and "close executor". Only one thread is ever
 * created for this executor's entire lifetime - not a new Thread per task.
 *
 * This class is responsible only for executing submitted USB I/O tasks. It
 * is not a session manager, not a registry, not a Promise owner, and not a
 * transport abstraction - those responsibilities stay with
 * UsbSerialTransportModule, UsbSerialSession, and UsbSerialSessionRegistry
 * respectively.
 *
 * [submit] never throws. It returns true if the task was accepted (it will
 * run, in submission order, before this executor's queue drains at
 * [shutdown]) and false if this executor has already been shut down (e.g. a
 * detach broadcast or a delayed permission callback racing module
 * invalidation - see UsbSerialTransportModule.invalidate()) - there is no
 * live host left to report a failure to either way, but the caller can use
 * this return value to decide whether it still owns cleanup responsibility
 * for whatever the task would have done (see the Pass 5.1 corrective
 * report, PASS5.1-AUDIT-2: a caller that needs a guarantee that submitted
 * close work is never silently lost must ensure - by its own coordination,
 * not by this class - that it never calls [submit] after this executor
 * could already have been shut down; UsbSerialTransportModule does this by
 * making "claim the work" and "submit it here" one atomic step under its
 * lifecycleLock, the same lock invalidate() holds while deciding to shut
 * this executor down). [shutdown] is idempotent and orderly - it lets any
 * already-queued task run to completion before the executor actually stops
 * (see java.util.concurrent.ExecutorService#shutdown), it never discards
 * queued work the way shutdownNow() would, and it never blocks the calling
 * thread waiting for that work to finish.
 *
 * Deliberately generic over a plain closure (not coupled to
 * UsbSerialSession or to any open/configure type) so the scheduling and
 * rejection behavior itself is fully unit-testable on the JVM without any
 * Android runtime - see UsbIoExecutorTest.kt.
 */
internal class UsbIoExecutor {

  private val executor: ExecutorService =
    Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "UsbIoExecutor").apply { isDaemon = true } }

  /** Returns true if [task] was accepted, false if this executor was already shut down. */
  fun submit(task: () -> Unit): Boolean {
    return try {
      executor.execute {
        try {
          task()
        } catch (_: Exception) {
          // Best-effort - matches every existing native cleanup call site's
          // own failure handling; there is no live host to report this to
          // either way, and one task throwing must not stop this executor
          // from processing whatever is submitted next.
        }
      }
      true
    } catch (_: RejectedExecutionException) {
      // Already shut down - nothing meaningful left to do.
      false
    }
  }

  fun shutdown() {
    executor.shutdown()
  }
}
