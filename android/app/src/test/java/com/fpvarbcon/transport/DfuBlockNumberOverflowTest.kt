package com.fpvarbcon.transport

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A DFU BLOCK NUMBER THAT WRAPS BECOMES A COMMAND.
 *
 * DfuFlashWorker's write loop numbers its data blocks from 2 and
 * increments once per transfer, then passes that number to
 * UsbDeviceConnection.controlTransfer as `value` - the USB wValue field,
 * sixteen bits wide. Nothing on that path rejects a larger number; the
 * upper bits are dropped.
 *
 * DfuSe reserves the low numbers for commands, and wValue 0 is a command
 * block whose first payload byte selects the command: 0x21 set address,
 * 0x41 erase, 0x92 read unprotect. A wrapped block is therefore not a
 * write to the wrong address - it is an arbitrary byte of the firmware
 * image being read as an instruction, on a device whose flash has already
 * been erased.
 *
 * Measured against this application's own limits rather than assumed.
 * MAX_FIRMWARE_FILE_BYTES is 16 MiB, MIN_DFU_TRANSFER_SIZE is 64:
 *
 *     transferSize   blocks for 16 MiB   last wValue   wraps
 *               64            262,144              1   yes
 *              128            131,072              1   yes
 *              256             65,536              1   yes
 *              512             32,768         32,769   no
 *             2048              8,192          8,193   no
 *
 * A genuine STM32 DfuSe bootloader reports 2048, which is why this has
 * never been reached in practice. findDfuTransferSize accepts anything
 * from 64 up, so the exposure is a device that declares a small
 * wTransferSize.
 *
 * NOT VERIFIED ON REAL HARDWARE: no device was made to declare a small
 * transfer size. What is proved here is that the refusal happens, and
 * that it happens before anything is erased.
 */
class DfuBlockNumberOverflowTest {

  private val maxFirmwareBytes = 16 * 1024 * 1024
  private val minTransferSize = 64

  @Test
  fun `a real STM32 bootloader at 2048 bytes is never refused`() {
    assertNull(
      "the ordinary case was refused - this would block every real flash",
      dfuBlockNumberOverflow(maxFirmwareBytes, 2048, 0x08000000L),
    )
    assertNull(dfuBlockNumberOverflow(1024 * 1024, 2048, 0x08000000L))
    assertNull(dfuBlockNumberOverflow(2 * 1024 * 1024, 2048, 0x08000000L))
  }

  /** The reproduction: the accepted minimum transfer size and a full-size image. */
  @Test
  fun `the smallest accepted transfer size with a full-size image is refused`() {
    val reason = dfuBlockNumberOverflow(maxFirmwareBytes, minTransferSize, 0x08000000L)
    assertNotNull("a 16 MiB image over 64-byte blocks was allowed to start erasing", reason)
    assertTrue("the reason does not give the block count: $reason", reason!!.contains("262144 blocks"))
    assertTrue("the reason does not name the 16-bit limit: $reason", reason.contains("65535"))
    assertTrue(
      "the reason does not say what a wrapped block becomes: $reason",
      reason.contains("DfuSe command"),
    )
    assertTrue("the reason does not say it is refusing: $reason", reason.contains("Refusing to erase or write"))
  }

  @Test
  fun `every transfer size that would wrap a full-size image is refused`() {
    for (transferSize in listOf(64, 128, 256)) {
      assertNotNull(
        "transferSize=$transferSize would wrap on a 16 MiB image and was allowed",
        dfuBlockNumberOverflow(maxFirmwareBytes, transferSize, 0x08000000L),
      )
    }
    for (transferSize in listOf(512, 1024, 2048, 4096, 8192, 16384)) {
      assertNull(
        "transferSize=$transferSize cannot wrap on a 16 MiB image and must not be refused",
        dfuBlockNumberOverflow(maxFirmwareBytes, transferSize, 0x08000000L),
      )
    }
  }

  /**
   * The boundary, exactly. Blocks are numbered from
   * DFU_FIRST_DATA_BLOCK, so the largest segment that fits is
   * (0xFFFF - 2 + 1) blocks - one byte more must be refused.
   */
  @Test
  fun `the boundary is exact in both directions`() {
    val transferSize = minTransferSize
    val largestSafeBlocks = USB_MAX_WVALUE - DFU_FIRST_DATA_BLOCK + 1
    val largestSafeBytes = largestSafeBlocks * transferSize

    assertEquals("the arithmetic under test drifted from the loop's numbering", 65534, largestSafeBlocks)
    assertNull(
      "the largest segment that fits was refused",
      dfuBlockNumberOverflow(largestSafeBytes, transferSize, 0x08000000L),
    )
    assertNotNull(
      "one byte past the limit was allowed, and that byte needs one more block",
      dfuBlockNumberOverflow(largestSafeBytes + 1, transferSize, 0x08000000L),
    )
  }

  /** A partial final block still counts as a block. */
  @Test
  fun `a segment that does not divide evenly still counts its last partial block`() {
    val transferSize = 64
    val exact = 65534 * transferSize
    assertNull(dfuBlockNumberOverflow(exact, transferSize, 0L))
    // One byte over needs a 65535th block, whose number is 65536.
    assertNotNull(dfuBlockNumberOverflow(exact + 1, transferSize, 0L))
  }

  @Test
  fun `an empty segment is not refused`() {
    assertNull(dfuBlockNumberOverflow(0, 64, 0x08000000L))
  }

  /**
   * A transfer size of zero would divide by zero if it reached the
   * arithmetic. findDfuTransferSize will not return it today, but this
   * function is a guard and a guard that crashes is not one.
   */
  @Test
  fun `a nonsensical transfer size is refused rather than divided by`() {
    val reason = dfuBlockNumberOverflow(1024, 0, 0x08000000L)
    assertNotNull(reason)
    assertTrue(reason!!.contains("cannot carry a firmware block"))
    assertNotNull(dfuBlockNumberOverflow(1024, -1, 0x08000000L))
  }

  /** The address appears, so the operator can tell which segment was refused. */
  @Test
  fun `the refusal names the segment address`() {
    val reason = dfuBlockNumberOverflow(maxFirmwareBytes, 64, 0x08000000L)
    assertTrue("the segment address is missing from: $reason", reason!!.contains("0x8000000"))
  }

  // -------------------------------------------------------------------
  // Where the check runs matters as much as what it decides. A guard
  // placed after the erase loop would report the same refusal to a board
  // whose flash was already blank.
  // -------------------------------------------------------------------

  private val workerSource: String by lazy {
    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (root in listOf(directory, File(directory, "android/app"))) {
        val candidate = File(root, "src/main/java/com/fpvarbcon/transport/DfuFlashWorker.kt")
        if (candidate.isFile) return@lazy candidate.readText()
      }
      directory = directory.parentFile
    }
    throw AssertionError("could not locate DfuFlashWorker.kt from ${System.getProperty("user.dir")}")
  }

  @Test
  fun `the check runs before the first erase command`() {
    val callSite = workerSource.indexOf("dfuBlockNumberOverflow(segment.data.size")
    assertTrue("DfuFlashWorker never calls dfuBlockNumberOverflow", callSite >= 0)

    val firstErase = workerSource.indexOf("byteArrayOf(DFUSE_ERASE")
    assertTrue("the erase command is gone from DfuFlashWorker", firstErase >= 0)

    assertTrue(
      "dfuBlockNumberOverflow is consulted at offset $callSite, AFTER the erase at $firstErase - " +
        "the refusal would then reach a board whose flash had already been wiped",
      callSite < firstErase,
    )
  }

  @Test
  fun `a refusal aborts instead of being logged`() {
    val call = workerSource.substringAfter("dfuBlockNumberOverflow(segment.data.size")
      .substringBefore("}\n")
    assertTrue(
      "the overflow result does not raise DFU_BLOCK_NUMBER_OVERFLOW: $call",
      call.contains("DFU_BLOCK_NUMBER_OVERFLOW") && call.contains("throw"),
    )
  }
}
