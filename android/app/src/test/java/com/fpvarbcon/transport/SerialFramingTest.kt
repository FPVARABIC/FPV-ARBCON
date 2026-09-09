package com.fpvarbcon.transport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * FRAGMENTED AND COALESCED INPUT, AND THE REUSED BUFFER UNDER BOTH.
 *
 * A serial link has no message boundaries. One MSP frame can arrive as
 * four reads and four frames can arrive as one, and which of those happens
 * is decided by the driver, the host controller and the board's timing -
 * never by this application. SerialReadLoopTest already proves what one
 * chunk contains; these cases are about the sequence of chunks, which is
 * where a framing assumption would show.
 *
 * The loop allocates ONE buffer and hands the same array to every chunk
 * callback with a length. That is correct only because the callback is
 * finished with it before the next read begins - the module's own callback
 * Base64-encodes the first [length] bytes synchronously on this thread
 * before returning. If that ever became asynchronous, a later read would
 * overwrite bytes an earlier chunk had not yet encoded, and the operator
 * would see corrupted telemetry with no error anywhere. That ordering is
 * asserted here rather than left as a comment.
 *
 * Everything runs against a real UsbSerialReadRegistry and a fake
 * SerialReadSource. No USB device, driver or board is involved.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
class SerialFramingTest {

  private fun UsbSerialReadRegistry.startToken(sessionId: String): ReceiveToken =
    (start(sessionId) as UsbSerialReadRegistry.StartAttempt.Started).token

  /**
   * Drives a loop over a scripted list of reads. Each entry is the bytes
   * that read should produce; an empty entry is a read timeout with no
   * data. The loop stops once the script is exhausted.
   */
  private fun runScript(
    sessionId: String = "s1",
    reads: List<ByteArray>,
    onEvent: (String) -> Unit = {},
    onChunk: (ByteArray, Int) -> Unit,
  ) {
    val registry = UsbSerialReadRegistry()
    val token = registry.startToken(sessionId)
    var index = 0
    SerialReadLoop(
      sessionId = sessionId,
      token = token,
      source = SerialReadSource { buffer, _ ->
        if (index >= reads.size) {
          registry.removeSession(sessionId)
          return@SerialReadSource 0
        }
        val chunk = reads[index]
        index += 1
        onEvent("read#$index")
        chunk.copyInto(buffer)
        chunk.size
      },
      registry = registry,
      readTimeoutMillis = 10,
      onChunk = { buffer, length ->
        onEvent("chunk#$length")
        onChunk(buffer, length)
      },
      onTerminalError = { fail("unexpected terminal error: $it") },
    ).run()
  }

  // ===================================================================

  @Test
  fun `a message split across several reads is delivered in order with no byte lost or repeated`() {
    val whole = ByteArray(37) { (it + 1).toByte() }
    val fragments = listOf(
      whole.copyOfRange(0, 5),
      whole.copyOfRange(5, 6),
      whole.copyOfRange(6, 20),
      whole.copyOfRange(20, 37),
    )
    val received = mutableListOf<ByteArray>()

    runScript(reads = fragments) { buffer, length -> received += buffer.copyOfRange(0, length) }

    assertEquals("one chunk per read was expected", fragments.size, received.size)
    for (index in fragments.indices) {
      assertArrayEquals("fragment $index was altered", fragments[index], received[index])
    }
    assertArrayEquals(
      "reassembling the chunks does not give back the message that was sent",
      whole,
      received.reduce { left, right -> left + right },
    )
  }

  @Test
  fun `several messages coalesced into one read are delivered as one chunk, in order`() {
    val first = byteArrayOf(0x24, 0x4D, 0x3E, 0x00, 0x01)
    val second = byteArrayOf(0x24, 0x4D, 0x3E, 0x02, 0x03, 0x04)
    val coalesced = first + second
    val received = mutableListOf<ByteArray>()

    runScript(reads = listOf(coalesced)) { buffer, length -> received += buffer.copyOfRange(0, length) }

    assertEquals("coalesced input must not be split by this layer", 1, received.size)
    assertArrayEquals(
      "the coalesced chunk is not the two messages back to back",
      coalesced,
      received.single(),
    )
  }

  @Test
  fun `only the bytes this read produced are handed over - the previous read's tail is not`() {
    val long = ByteArray(64) { 0x7F }
    val short = byteArrayOf(1, 2, 3)
    val received = mutableListOf<ByteArray>()

    runScript(reads = listOf(long, short)) { buffer, length -> received += buffer.copyOfRange(0, length) }

    assertEquals(2, received.size)
    assertEquals("the second chunk claimed more bytes than the read produced", 3, received[1].size)
    assertArrayEquals(
      "the short read carried bytes left over from the long one",
      short,
      received[1],
    )
  }

  /**
   * THE INVARIANT THAT MAKES THE SHARED BUFFER SAFE. Reads and chunk
   * deliveries must strictly alternate: no second read may begin while a
   * chunk from the first is still being consumed.
   */
  @Test
  fun `each chunk is fully consumed before the next read begins`() {
    val events = mutableListOf<String>()
    val reads = listOf(byteArrayOf(1, 2), byteArrayOf(3), byteArrayOf(4, 5, 6))

    runScript(reads = reads, onEvent = { events += it }) { _, _ -> }

    assertEquals(
      listOf("read#1", "chunk#2", "read#2", "chunk#1", "read#3", "chunk#3"),
      events,
    )
  }

  @Test
  fun `a read timeout between two messages does not break the sequence or emit an empty chunk`() {
    val received = mutableListOf<ByteArray>()
    val events = mutableListOf<String>()

    runScript(
      reads = listOf(byteArrayOf(1, 2), ByteArray(0), byteArrayOf(3, 4)),
      onEvent = { events += it },
    ) { buffer, length -> received += buffer.copyOfRange(0, length) }

    assertEquals("an empty read produced a chunk", 2, received.size)
    assertArrayEquals(byteArrayOf(1, 2), received[0])
    assertArrayEquals(byteArrayOf(3, 4), received[1])
    assertTrue("a zero-length chunk was emitted", events.none { it == "chunk#0" })
  }

  @Test
  fun `a read that exactly fills the buffer is delivered whole`() {
    val full = ByteArray(4096) { (it and 0x7f).toByte() }
    val received = mutableListOf<ByteArray>()

    runScript(reads = listOf(full)) { buffer, length -> received += buffer.copyOfRange(0, length) }

    assertEquals(1, received.size)
    assertEquals("the default buffer size is no longer 4096 - this case is now vacuous", 4096, received[0].size)
    assertArrayEquals(full, received[0])
  }

  @Test
  fun `two sessions reading at the same time never receive each other's bytes`() {
    val firstBytes = byteArrayOf(0x11, 0x11, 0x11)
    val secondBytes = byteArrayOf(0x22, 0x22)
    val first = mutableListOf<ByteArray>()
    val second = mutableListOf<ByteArray>()

    runScript(sessionId = "a", reads = listOf(firstBytes, firstBytes)) { buffer, length ->
      first += buffer.copyOfRange(0, length)
    }
    runScript(sessionId = "b", reads = listOf(secondBytes)) { buffer, length ->
      second += buffer.copyOfRange(0, length)
    }

    assertEquals(2, first.size)
    assertEquals(1, second.size)
    assertTrue("session a received session b's bytes", first.all { it.contentEquals(firstBytes) })
    assertArrayEquals(secondBytes, second.single())
  }

  /**
   * The script driver is a real subject: if it stopped producing reads, the
   * cases above would pass with no chunks at all. This proves it produces
   * what it was given.
   */
  @Test
  fun `the script driver delivers exactly the reads it was given`() {
    val events = mutableListOf<String>()
    runScript(reads = listOf(byteArrayOf(9), byteArrayOf(8), byteArrayOf(7)), onEvent = { events += it }) { _, _ -> }
    assertEquals(3, events.count { it.startsWith("read#") })
    assertEquals(3, events.count { it.startsWith("chunk#") })
  }
}
