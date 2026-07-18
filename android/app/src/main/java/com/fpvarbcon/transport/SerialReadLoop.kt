package com.fpvarbcon.transport

/**
 * Abstracts one blocking, timeout-bounded read call so [SerialReadLoop] can
 * be unit-tested on the JVM without any real UsbSerialPort/UsbDeviceConnection.
 * Contract matches usb-serial-for-android's own
 * UsbSerialPort.read(ByteArray, Int) exactly: reads up to [buffer]'s size
 * bytes, waiting at most [timeoutMillis] (never 0/infinite - see
 * [SerialReadLoop]'s own note), and returns the number of bytes actually
 * read - 0 if the timeout elapsed with nothing available. Throws on a real
 * I/O failure (including a closed port).
 */
internal fun interface SerialReadSource {
  fun read(buffer: ByteArray, timeoutMillis: Int): Int
}

/**
 * The one receive loop body for a single startReading() attempt, identified
 * by [sessionId] and [token]. Deliberately plain Kotlin - no Android types,
 * no Thread creation, no event-emission mechanics - so its exact behavior
 * (what it reads, when it emits, when it stops, when it reports an error)
 * is fully provable on the JVM with a fake [SerialReadSource] and a real
 * [UsbSerialReadRegistry]; see SerialReadLoopTest.kt. The thread that
 * actually calls [run] - and the real UsbSerialPort-backed [SerialReadSource]
 * - are UsbSerialTransportModule's concern, not this class's.
 *
 * Uses a finite, non-zero read timeout deliberately: a real
 * UsbSerialPort.read() call with timeout=0 blocks indefinitely with no way
 * to notice a stop request short of closing the port out from under it. A
 * bounded timeout means [run] wakes up on its own at least once per
 * [readTimeoutMillis] even with no data arriving, re-checks
 * [UsbSerialReadRegistry.isCurrent], and returns promptly once this
 * session's token is no longer current - without busy-spinning, since each
 * unproductive iteration still spends up to [readTimeoutMillis] blocked
 * inside the (real) read call itself, not looping tightly.
 *
 * Cancellation is purely cooperative and non-blocking on the caller's side:
 * whoever calls stopReading()/closeSession()/handles a detach/invalidates
 * only ever needs to remove this session's token from [registry] - see that
 * method's own note - and never needs to interrupt or join this loop's
 * thread. [run] notices the token is gone (at the top of the loop, and
 * again immediately after every read attempt, success or failure) and
 * returns on its own, within one [readTimeoutMillis] window at most.
 *
 * Token validity is re-checked after every read and immediately before
 * every emission/error report specifically so a read that was in flight
 * across a stop/close/detach/invalidate can never result in a stale chunk
 * or a stale error being reported - not because the underlying read call
 * itself is cleanly interruptible (it may not be), but because nothing here
 * ever acts on a read's result without first confirming the token that
 * requested it is still the one currently allowed to.
 */
internal class SerialReadLoop(
  private val sessionId: String,
  private val token: ReceiveToken,
  private val source: SerialReadSource,
  private val registry: UsbSerialReadRegistry,
  private val readTimeoutMillis: Int,
  private val bufferSize: Int = DEFAULT_BUFFER_SIZE,
  private val onChunk: (buffer: ByteArray, length: Int) -> Unit,
  private val onTerminalError: (error: Exception) -> Unit,
) {

  fun run() {
    val buffer = ByteArray(bufferSize)
    while (registry.isCurrent(sessionId, token)) {
      val bytesRead =
        try {
          source.read(buffer, readTimeoutMillis)
        } catch (error: Exception) {
          // A read failure that arrives after this token was already
          // invalidated (e.g. the port was closed as part of an intentional
          // stop/close/detach/invalidate) is expected, not an error - only
          // report it if this attempt is still the one in charge.
          if (registry.isCurrent(sessionId, token)) {
            onTerminalError(error)
          }
          return
        }

      // Re-check after the read returns (success or a timeout with 0
      // bytes) - a stop/close/detach/invalidate may have happened while
      // this call was blocked.
      if (!registry.isCurrent(sessionId, token)) {
        return
      }

      if (bytesRead > 0) {
        onChunk(buffer, bytesRead)
      }
      // bytesRead == 0 is a normal read-timeout with no data - loop again
      // without emitting anything, per usb-serial-for-android's own
      // documented read() contract.
    }
  }

  private companion object {
    const val DEFAULT_BUFFER_SIZE = 4096
  }
}
