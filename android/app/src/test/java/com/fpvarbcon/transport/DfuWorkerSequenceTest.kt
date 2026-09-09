package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE READ-UNPROTECT AND EXIT SEQUENCES, DRIVEN BY A SCRIPTED DEVICE.
 *
 * Both of these talk to a board that is about to erase itself, and both
 * had rules that could only be read, never executed: a read-unprotect that
 * must see DNLOAD_BUSY before it believes an erase started, an erase
 * window that must be waited out in full, an exit whose failed
 * manifestation is the NORMAL successful outcome when the board resets.
 *
 * Nothing here touches USB. The device is a table of answers, so every
 * shape a real STM32 ROM can present - a stall, a vanishing device, a
 * short status frame, a refusal - is produced deliberately rather than
 * waited for. No hardware, by instruction.
 *
 * The erase guard is asserted as a duration that was REQUESTED, not one
 * that was endured: DfuControlChannel.sleep is injected, so a change that
 * quietly shortened the twenty-second guard fails here in milliseconds. A
 * test that really slept could not tell the difference without taking
 * twenty seconds to do it.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
class DfuWorkerSequenceTest {

  private companion object {
    const val REQUEST_TYPE_OUT = 0x21
    const val REQUEST_TYPE_IN = 0xa1
    const val DNLOAD = 1
    const val GETSTATUS = 3
    const val STATE_IDLE = 2
    const val STATE_DNLOAD_BUSY = 4
    const val STATE_MANIFEST_WAIT_RESET = 8
    const val STATE_ERROR = 10
    const val READ_UNPROTECT: Byte = 0x92.toByte()
    const val INTERFACE_ID = 0
  }

  /** One control transfer, as the sequence issued it. */
  private data class Exchange(
    val requestType: Int,
    val request: Int,
    val value: Int,
    val index: Int,
    val payload: List<Int>,
    val length: Int,
  )

  /**
   * A DFU board made of answers.
   *
   * [statusFrames] is consumed in order, so a board can report BUSY and
   * then IDLE the way a real one does. A null entry is a stall - the
   * transfer returns -1 and the caller sees no status at all.
   */
  private class ScriptedDfuDevice(
    val downloadResults: MutableList<Int> = mutableListOf(),
    val statusFrames: MutableList<ByteArray?> = mutableListOf(),
    var attached: Boolean = true,
    /** Flipped to false once the board has been told to erase. */
    var detachAfterUnprotect: Boolean = false,
  ) : DfuControlChannel {
    val exchanges = mutableListOf<Exchange>()
    val sleeps = mutableListOf<Long>()
    var attachedQueries = 0

    override fun controlTransfer(
      requestType: Int,
      request: Int,
      value: Int,
      index: Int,
      buffer: ByteArray?,
      length: Int,
      timeoutMs: Int,
    ): Int {
      exchanges += Exchange(
        requestType = requestType,
        request = request,
        value = value,
        index = index,
        payload = buffer?.take(length)?.map { it.toInt() and 0xff } ?: emptyList(),
        length = length,
      )
      if (requestType == REQUEST_TYPE_IN && request == GETSTATUS) {
        // An exhausted script and an explicit null entry both mean "the
        // board stalled": the transfer fails and the caller sees no status.
        val frame: ByteArray = when {
          statusFrames.isEmpty() -> return -1
          else -> statusFrames.removeAt(0) ?: return -1
        }
        val destination = buffer ?: return -1
        frame.copyInto(destination)
        return frame.size
      }
      if (detachAfterUnprotect && buffer?.firstOrNull() == READ_UNPROTECT) attached = false
      return if (downloadResults.isEmpty()) length else downloadResults.removeAt(0)
    }

    override fun isSameDeviceAttached(): Boolean {
      attachedQueries += 1
      return attached
    }

    override fun sleep(millis: Long) {
      sleeps += millis
    }
  }

  private fun status(state: Int, pollDelayMs: Int = 0, statusByte: Int = 0): ByteArray = byteArrayOf(
    statusByte.toByte(),
    (pollDelayMs and 0xff).toByte(),
    ((pollDelayMs shr 8) and 0xff).toByte(),
    ((pollDelayMs shr 16) and 0xff).toByte(),
    state.toByte(),
    0,
  )

  private fun failing(block: () -> Unit): UsbTransportException {
    try {
      block()
    } catch (error: UsbTransportException) {
      return error
    }
    throw AssertionError("expected a UsbTransportException and the sequence completed instead")
  }

  // ===================================================================
  // READ-UNPROTECT
  // ===================================================================

  /** The board accepts, reports busy, waits, then resets. */
  @Test
  fun `read-unprotect succeeds when the board erases and then resets`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY, pollDelayMs = 100), null),
    )
    runDfuUnprotect(board, INTERFACE_ID)

    val command = board.exchanges.first()
    assertEquals("read-unprotect was not sent as a DNLOAD", DNLOAD, command.request)
    assertEquals(REQUEST_TYPE_OUT, command.requestType)
    assertEquals(
      "the command byte was not DfuSe read-unprotect (0x92)",
      listOf(0x92),
      command.payload,
    )
  }

  /**
   * THE ERASE GUARD. The board's own delay is honoured AND a fixed safety
   * guard is added on top. Cutting either short leaves the host talking to
   * a board that is still erasing its own flash.
   */
  @Test
  fun `the erase window is the board's reported delay plus the full safety guard`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY, pollDelayMs = 1_234), null),
    )
    runDfuUnprotect(board, INTERFACE_ID)

    assertEquals("the sequence slept a different number of times", 1, board.sleeps.size)
    assertEquals(
      "the erase window was not reportedDelay + ERASE_SAFETY_DELAY_MS",
      1_234L + ERASE_SAFETY_DELAY_MS,
      board.sleeps.single(),
    )
  }

  /**
   * A board is free to report a delay that would park the worker for an
   * unreasonable time. The cap is what stops a malformed answer becoming a
   * hang - and it is a CAP, so the safety guard is still added.
   */
  @Test
  fun `an absurd reported delay is capped but the safety guard still applies`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY, pollDelayMs = 0xFFFFFF), null),
    )
    runDfuUnprotect(board, INTERFACE_ID)
    assertEquals(
      MAX_REPORTED_ERASE_DELAY_MS.toLong() + ERASE_SAFETY_DELAY_MS,
      board.sleeps.single(),
    )
  }

  /**
   * DNLOAD_BUSY IS THE PROOF THE ERASE STARTED. Any other state is the
   * board refusing, and the refusal must carry what the board actually
   * said rather than a generic sentence.
   */
  @Test
  fun `a board that does not report busy is a refusal, reported with its own bytes`() {
    for (state in listOf(STATE_IDLE, STATE_ERROR, STATE_MANIFEST_WAIT_RESET)) {
      val board = ScriptedDfuDevice(
        statusFrames = mutableListOf(status(state, statusByte = 0x0f)),
      )
      val error = failing { runDfuUnprotect(board, INTERFACE_ID) }
      assertEquals("DFU_UNPROTECT_FAILED", error.code)
      assertTrue(
        "the refusal does not name the state the board reported: ${error.message}",
        error.message!!.contains("state $state"),
      )
      assertTrue(
        "the refusal does not name the status byte: ${error.message}",
        error.message!!.contains("status 15"),
      )
      assertEquals("a refused unprotect still waited out an erase window", 0, board.sleeps.size)
    }
  }

  /**
   * SILENCE MEANS SUCCESS ONLY IF THE BOARD HAS GONE. A stall from a board
   * that is still attached is a board that did not start erasing.
   */
  @Test
  fun `a stall with the device gone is success, and a stall with it present is not`() {
    val vanished = ScriptedDfuDevice(statusFrames = mutableListOf(null), attached = false)
    runDfuUnprotect(vanished, INTERFACE_ID)
    assertTrue("the identity of the device was never checked", vanished.attachedQueries > 0)

    val present = ScriptedDfuDevice(statusFrames = mutableListOf(null), attached = true)
    val error = failing { runDfuUnprotect(present, INTERFACE_ID) }
    assertEquals("DFU_UNPROTECT_FAILED", error.code)
    assertTrue(error.message!!.contains("did not enter the read-unprotect erase state"))
  }

  @Test
  fun `a command the board does not accept stops before any erase window`() {
    val board = ScriptedDfuDevice(downloadResults = mutableListOf(0))
    val error = failing { runDfuUnprotect(board, INTERFACE_ID) }
    assertEquals("DFU_UNPROTECT_FAILED", error.code)
    assertTrue(error.message!!.contains("was not accepted"))
    assertEquals("a rejected command still waited", 0, board.sleeps.size)
    assertEquals("a rejected command still asked for status", 1, board.exchanges.size)
  }

  /**
   * The board erased, waited, and then neither reset nor returned to idle.
   * That is a real failure and must not be reported as success just
   * because the erase window elapsed.
   */
  @Test
  fun `a board still in a working state after the erase window is a failure`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(STATE_ERROR)),
    )
    val error = failing { runDfuUnprotect(board, INTERFACE_ID) }
    assertEquals("DFU_UNPROTECT_FAILED", error.code)
    assertTrue(error.message!!.contains("did not reset"))
  }

  @Test
  fun `idle and manifest-wait-reset after the erase window are both success`() {
    for (state in listOf(STATE_IDLE, STATE_MANIFEST_WAIT_RESET)) {
      val board = ScriptedDfuDevice(
        statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(state)),
      )
      runDfuUnprotect(board, INTERFACE_ID)
    }
  }

  /**
   * DETACH AND RE-ENUMERATION IDENTITY. The channel is asked whether THE
   * SAME device is attached, and a board that disappeared mid-sequence is
   * a completed unprotect. A worker that asked "is any DFU device here"
   * would accept a different board that had just been plugged in.
   */
  @Test
  fun `a board that vanishes during the sequence is a completed unprotect`() {
    // The board erases, then resets away, and the reset is slow enough
    // that its LAST status frame still reports a working state. Without
    // the identity check that would be read as "erased but never reset"
    // and reported as a failure for a board that had in fact finished and
    // gone. With it, the vanished device wins.
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(STATE_ERROR)),
      detachAfterUnprotect = true,
    )
    runDfuUnprotect(board, INTERFACE_ID)
    assertTrue("the sequence never asked whether the board was still there", board.attachedQueries > 0)

    // The control: the same script with the board still present IS a
    // failure, so the case above passes because of the identity check and
    // not because the state was tolerated.
    val present = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(STATE_ERROR)),
      attached = true,
    )
    val error = failing { runDfuUnprotect(present, INTERFACE_ID) }
    assertEquals("DFU_UNPROTECT_FAILED", error.code)
  }

  /**
   * A stall AFTER a confirmed erase window needs no identity check and
   * deliberately does not make one: DNLOAD_BUSY has already proved the
   * erase started, and STM32 ROM resetting is the expected end. Recorded
   * as a test because the asymmetry with the pre-erase stall above is
   * easy to mistake for an oversight.
   */
  @Test
  fun `a stall after the erase window is success without needing an identity check`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), null),
      attached = true,
    )
    runDfuUnprotect(board, INTERFACE_ID)
    assertEquals(
      "a post-erase stall consulted the device list; the pre-erase stall is the case that needs it",
      0,
      board.attachedQueries,
    )
  }

  // ===================================================================
  // EXIT
  // ===================================================================

  @Test
  fun `exit selects the application base address before manifesting`() {
    val board = ScriptedDfuDevice(statusFrames = mutableListOf(status(STATE_IDLE)))
    runDfuExit(board, INTERFACE_ID)

    val first = board.exchanges.first()
    assertEquals(REQUEST_TYPE_OUT, first.requestType)
    assertEquals(DNLOAD, first.request)
    assertEquals(
      "exit did not select 0x08000000 as a DfuSe set-address command",
      listOf(0x21, 0x00, 0x00, 0x00, 0x08),
      first.payload,
    )

    val manifest = board.exchanges.last()
    assertEquals("the manifest request was not a zero-length DNLOAD", 0, manifest.length)
    assertEquals(DNLOAD, manifest.request)
  }

  @Test
  fun `exit stops if the address is not accepted`() {
    val board = ScriptedDfuDevice(downloadResults = mutableListOf(2))
    val error = failing { runDfuExit(board, INTERFACE_ID) }
    assertEquals("DFU_EXIT_FAILED", error.code)
    assertTrue(error.message!!.contains("select the application address"))
    assertEquals("exit continued past a refused address", 1, board.exchanges.size)
  }

  /**
   * THE NORMAL SUCCESSFUL EXIT LOOKS LIKE A FAILED TRANSFER. The board
   * resets, so the manifest request cannot be answered. Reporting that as
   * an error would report a failure for exactly the thing being asked for.
   */
  @Test
  fun `a failed manifestation is success when the board has reset away`() {
    val board = ScriptedDfuDevice(
      downloadResults = mutableListOf(5, -1),
      statusFrames = mutableListOf(status(STATE_IDLE)),
      attached = false,
    )
    runDfuExit(board, INTERFACE_ID)
    assertTrue("exit never checked whether the board had gone", board.attachedQueries > 0)
  }

  @Test
  fun `a failed manifestation is a failure when the board is still attached`() {
    val board = ScriptedDfuDevice(
      downloadResults = mutableListOf(5, -1),
      statusFrames = mutableListOf(status(STATE_IDLE)),
      attached = true,
    )
    val error = failing { runDfuExit(board, INTERFACE_ID) }
    assertEquals("DFU_EXIT_FAILED", error.code)
    assertTrue(error.message!!.contains("without a reset"))
  }

  @Test
  fun `exit honours a reported poll delay, capped`() {
    val brief = ScriptedDfuDevice(statusFrames = mutableListOf(status(STATE_IDLE, pollDelayMs = 42)))
    runDfuExit(brief, INTERFACE_ID)
    assertEquals(listOf(42L), brief.sleeps)

    val absurd = ScriptedDfuDevice(statusFrames = mutableListOf(status(STATE_IDLE, pollDelayMs = 0xFFFFFF)))
    runDfuExit(absurd, INTERFACE_ID)
    assertEquals(
      "an absurd poll delay was not capped, so a malformed answer could park the worker",
      listOf(MAX_EXIT_POLL_DELAY_MS.toLong()),
      absurd.sleeps,
    )
  }

  @Test
  fun `exit treats a zero delay and a short status frame alike - no sleep, still manifests`() {
    val zero = ScriptedDfuDevice(statusFrames = mutableListOf(status(STATE_IDLE, pollDelayMs = 0)))
    runDfuExit(zero, INTERFACE_ID)
    assertEquals(0, zero.sleeps.size)

    val short = ScriptedDfuDevice(statusFrames = mutableListOf(null))
    runDfuExit(short, INTERFACE_ID)
    assertEquals("a short status frame caused a sleep", 0, short.sleeps.size)
    assertEquals(
      "a short status frame stopped the sequence from manifesting",
      0,
      short.exchanges.last().length,
    )
  }

  /**
   * Every exchange must be aimed at the interface the caller named. An
   * off-by-one here would talk to a different memory region's alternate
   * setting on a multi-interface board.
   */
  @Test
  fun `every exchange in both sequences is addressed to the caller's interface`() {
    val unprotect = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(STATE_IDLE)),
    )
    runDfuUnprotect(unprotect, 3)
    assertTrue("no exchanges were recorded", unprotect.exchanges.isNotEmpty())
    for (exchange in unprotect.exchanges) assertEquals(3, exchange.index)

    val exit = ScriptedDfuDevice(statusFrames = mutableListOf(status(STATE_IDLE)))
    runDfuExit(exit, 5)
    assertTrue(exit.exchanges.isNotEmpty())
    for (exchange in exit.exchanges) assertEquals(5, exchange.index)
  }

  /**
   * The adapters that bind these sequences to Android must still open,
   * claim, release and close in the right order, and must release even
   * when the sequence throws - a cleanup that is skipped on the error path
   * leaks the interface for the life of the process.
   *
   * The adapters themselves hold UsbManager/UsbDevice/UsbDeviceConnection
   * and cannot be instantiated here, so this is a source contract over the
   * shipped files rather than an execution of them. It is recorded as such
   * rather than dressed up as a run.
   */
  @Test
  fun `both workers release the interface in a finally and close the connection`() {
    for (name in listOf("DfuUnprotectWorker", "DfuExitWorker")) {
      val source = readTransportSource("$name.kt")
      assertTrue(
        "$name no longer claims the interface before delegating",
        source.contains("claimInterface(usbInterface, true)"),
      )
      assertTrue(
        "$name does not release the interface in a finally block, so a throwing sequence " +
          "would leak it",
        Regex("""finally\s*\{[^}]*releaseInterface""", RegexOption.DOT_MATCHES_ALL)
          .containsMatchIn(source),
      )
      assertTrue(
        "$name does not close the connection in a finally block",
        Regex("""finally\s*\{\s*connection\.close\(\)""").containsMatchIn(source),
      )
      assertTrue(
        "$name no longer delegates to its extracted sequence, so none of the assertions " +
          "above describe what ships",
        source.contains("runDfu"),
      )
    }
  }

  private fun readTransportSource(fileName: String): String {
    var directory: java.io.File? = java.io.File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (root in listOf(directory, java.io.File(directory, "android/app"))) {
        val candidate = java.io.File(root, "src/main/java/com/fpvarbcon/transport/$fileName")
        if (candidate.isFile) return candidate.readText()
      }
      directory = directory.parentFile
    }
    throw AssertionError("could not locate $fileName")
  }

  @Test
  fun `the scripted device is a real subject - it records what it was asked`() {
    val board = ScriptedDfuDevice(
      statusFrames = mutableListOf(status(STATE_DNLOAD_BUSY), status(STATE_IDLE)),
    )
    runDfuUnprotect(board, INTERFACE_ID)
    assertNotNull(board.exchanges.firstOrNull())
    assertTrue(
      "the sequence issued fewer exchanges than a read-unprotect requires",
      board.exchanges.size >= 3,
    )
  }
}
